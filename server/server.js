#!/usr/bin/env node

/**
 * IGV Variant Review Server
 *
 * HPC-deployable service for reviewing de novo variants in trios.
 * Provides dynamic filtering, IGV-based alignment review, manual curation,
 * and post-filtering gene-level summarization.
 *
 * Usage:
 *   node server.js --variants variants.tsv --data-dir /path/to/bam_cram_files [--port 3000]
 */

const express = require('express')
const fs = require('fs')
const path = require('path')
const ExcelJS = require('exceljs')
const archiver = require('archiver')
const log = require('./logger')
const {generateLollipopSvg} = require('./lollipop')
const {fetchProteinDomains} = require('./pfam')
const {fetchGeneAnnotationsBatch} = require('./gene-annotations')
const annotationRegistry = require('./annotation-registry')
const {computeConvergence, geneTermsFor, sourceUniverseStats, binomUpperTail, DIMENSIONS} = require('./gene-analysis')
const {computeModelEnrichment, categoryRateSums, DE_NOVO} = require('./dnm-enrichment')
const dnmRates = require('./dnm-rates')
const geneSets = require('./genesets')
const mitocarta = require('./mitocarta')
const gnomadProvider = require('./providers/gnomad-provider')
const clinvarProvider = require('./providers/clinvar-provider')
const genccProvider = require('./providers/gencc-provider')
const {DEFAULT_EXPORT_CONFIG, mergeWithDefaults, filterColumns} = require('./export-config')
const speciesMetrics = require('./species-metrics')

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
function getArg(name, defaultValue) {
    const idx = args.indexOf(`--${name}`)
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultValue
}

/**
 * Collect all occurrences of a repeated CLI argument into an array.
 * E.g. --bed-tracks "label:/path" --bed-tracks "label2:/path2"
 */
function getArgAll(name) {
    const flag = `--${name}`
    const results = []
    for (let i = 0; i < args.length; i++) {
        if (args[i] === flag && i + 1 < args.length) {
            results.push(args[i + 1])
            i++ // skip value
        }
    }
    return results
}

const PORT = parseInt(getArg('port', '3000'), 10)
const VARIANTS_FILE = getArg('variants', path.join(__dirname, 'example_data', 'variants.tsv'))
const DATA_DIR = getArg('data-dir', getArg('data_dir', path.join(__dirname, 'example_data')))
const CURATION_FILE = getArg('curation-file', VARIANTS_FILE.replace(/\.tsv$/, '.curation.json'))
const FILTERS_FILE = getArg('filters-file', VARIANTS_FILE.replace(/\.tsv$/, '.filters.json'))
const EXPORT_CONFIG_FILE = getArg('export-config-file', VARIANTS_FILE.replace(/\.tsv$/, '.export-config.json'))
const SAMPLE_QC_FILE = getArg('sample-qc', null)
const VCF_FILE = getArg('vcf', null)
const VCF_SAMPLES = getArg('vcf-samples', null)  // e.g. "proband:NA12878,mother:NA12891,father:NA12892"
const GENOME = getArg('genome', 'hg38')
const HOST = getArg('host', '127.0.0.1')
// CRAM MD5 reference checks are disabled by default to avoid spurious
// failures caused by concurrent reference-sequence cache races in igv.js
// (see Known Issues in README).  Pass --check-md5 to re-enable.
const ENABLE_CRAM_MD5_CHECK = args.includes('--check-md5')

// ---------------------------------------------------------------------------
// BED track configuration
// ---------------------------------------------------------------------------
// Parse --bed-tracks arguments.  Each value is "label:path" or just "path"
// (in which case a label is auto-generated from the filename).
// Multiple --bed-tracks flags are supported.
const BED_TRACK_CONFIGS = []
for (const raw of getArgAll('bed-tracks')) {
    // Support comma-separated entries within a single flag value
    for (const entry of raw.split(',')) {
        const trimmed = entry.trim()
        if (!trimmed) continue
        const colonIdx = trimmed.indexOf(':')
        let label, filePath
        // Detect label:path format.  Skip if the colon belongs to a
        // Windows drive letter (index 1, e.g. C:\…) or a URL scheme
        // (http:// or https://).
        const isUrl = /^https?:\/\//i.test(trimmed)
        const isWindowsDrive = colonIdx === 1 && /^[a-zA-Z]$/.test(trimmed[0])
        if (colonIdx > 0 && !isUrl && !isWindowsDrive) {
            label = trimmed.slice(0, colonIdx).trim()
            filePath = trimmed.slice(colonIdx + 1).trim()
        } else {
            // Auto-generate label from filename, stripping .bed.gz / .bed extensions
            const basename = path.basename(trimmed)
            label = basename.replace(/\.(bed\.gz|bed)$/i, '')
            filePath = trimmed
        }
        BED_TRACK_CONFIGS.push({name: label, path: filePath})
    }
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
let variants = []
let headerColumns = []

// Shared sample-summary configuration
const SAMPLE_SUMMARY_THRESHOLDS = [
    {label: 'freq = 0', value: 0, type: 'eq'},
    {label: 'all', value: null, type: 'all'}
]
const SAMPLE_SUMMARY_IMPACT_GROUPS = [
    {label: 'HIGH', impacts: ['HIGH']},
    {label: 'HIGH||MODERATE', impacts: ['HIGH', 'MODERATE']},
    {label: 'HIGH||MODERATE||LOW', impacts: ['HIGH', 'MODERATE', 'LOW']}
]

// QC metric thresholds – keyed by metric column name.  Each entry defines
// ordered tiers evaluated top-to-bottom; the first matching tier wins.
// Tiers use `max` (exclusive upper bound) or `min` (inclusive lower bound).
const QC_METRIC_THRESHOLDS = {
    freemix: [
        {label: 'pass',    max: 0.01,  description: 'Clean (≤1%)'},
        {label: 'warn',    max: 0.03,  description: 'Caution (1–3%) – apply stricter filters'},
        {label: 'fail',    max: 0.05,  description: 'Fail (3–5%) – exclude from DNM detection'},
        {label: 'critical', min: 0.05, description: 'Hard fail (≥5%) – results unreliable'}
    ]
}

let sampleQcData = []      // raw rows from the QC TSV
let sampleQcColumns = []   // header columns of the QC TSV
let sampleQcTrios = []     // aggregated trio-level QC records

/**
 * Generate a stable key for a variant based on genomic coordinates and
 * optional sample/trio identifier.  This key survives row reordering and
 * addition/removal of variants in the TSV.
 */
function variantKey(v) {
    let key = `${v.chrom}:${v.pos}:${v.ref}:${v.alt}`
    if (v.trio_id) key += `:${v.trio_id}`
    else if (v.sample_id) key += `:${v.sample_id}`
    return key
}

/**
 * Compute mean and median for an array of numbers.
 */
function computeStats(values) {
    if (values.length === 0) return {mean: 0, median: 0, sd: 0}
    const sum = values.reduce((a, b) => a + b, 0)
    const mean = Math.round((sum / values.length) * 100) / 100
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    const median = sorted.length % 2 === 0
        ? Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100
        : sorted[mid]
    const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length
    const sd = Math.round(Math.sqrt(variance) * 100) / 100
    return {mean, median, sd}
}

function loadVariants() {
    if (!fs.existsSync(VARIANTS_FILE)) {
        log.error(`Variants file not found: ${VARIANTS_FILE}`)
        log.error('Please provide a TSV file with --variants <path>')
        log.error('See server/README.md and server/example_data/ for format details.')
        process.exit(1)
    }

    const raw = fs.readFileSync(VARIANTS_FILE, 'utf-8')
    const lines = raw.trim().split('\n')
    if (lines.length < 2) {
        log.error('Variants file must have a header line and at least one data line.')
        process.exit(1)
    }

    headerColumns = lines[0].split('\t').map(c => c.trim())
    const required = ['chrom', 'pos', 'ref', 'alt']
    for (const r of required) {
        if (!headerColumns.includes(r)) {
            log.error(`Variants TSV missing required column: ${r}`)
            process.exit(1)
        }
    }

    variants = lines.slice(1).map((line, idx) => {
        const cols = line.split('\t')
        const obj = {id: idx}
        headerColumns.forEach((h, i) => {
            let val = (cols[i] || '').trim()
            // Attempt numeric coercion for known numeric fields
            if (['pos', 'quality'].includes(h) || h.startsWith('freq')) {
                const num = Number(val)
                if (!isNaN(num) && val !== '') val = num
            }
            obj[h] = val
        })
        // Assign a stable key for curation persistence
        obj._key = variantKey(obj)
        return obj
    })

    // Load persisted curation data
    if (fs.existsSync(CURATION_FILE)) {
        try {
            const curationData = JSON.parse(fs.readFileSync(CURATION_FILE, 'utf-8'))

            // Build a lookup by stable key for fast matching
            const keyMap = new Map(variants.map(v => [v._key, v]))

            let migratedOldFormat = false
            for (const [idStr, curation] of Object.entries(curationData)) {
                // Try stable key first
                const byKey = keyMap.get(idStr)
                if (byKey) {
                    byKey.curation_status = curation.status || 'pending'
                    byKey.curation_note = curation.note || ''
                } else {
                    // Fall back to legacy numeric-index format
                    const id = parseInt(idStr, 10)
                    if (!isNaN(id)) {
                        const v = variants.find(x => x.id === id)
                        if (v) {
                            v.curation_status = curation.status || 'pending'
                            v.curation_note = curation.note || ''
                            migratedOldFormat = true
                        }
                    }
                }
            }

            // Re-save with stable keys if we migrated from old format
            if (migratedOldFormat) {
                log.info('Migrating curation file to stable key format...')
            }
        } catch (e) {
            log.warn('Could not parse curation file:', e.message)
        }
    }

    // Ensure defaults
    variants.forEach(v => {
        if (!v.curation_status) v.curation_status = 'pending'
        if (!v.curation_note) v.curation_note = ''
    })

    // Perform migration save after defaults are applied
    if (fs.existsSync(CURATION_FILE)) {
        try {
            const curationData = JSON.parse(fs.readFileSync(CURATION_FILE, 'utf-8'))
            const hasLegacyKeys = Object.keys(curationData).some(k => /^\d+$/.test(k))
            if (hasLegacyKeys) saveCuration()
        } catch (_) { /* already warned above */ }
    }

    log.info(`Loaded ${variants.length} variants from ${VARIANTS_FILE}`)
}

function saveCuration() {
    const data = {}
    variants.forEach(v => {
        if (v.curation_status !== 'pending' || v.curation_note) {
            data[v._key] = {status: v.curation_status, note: v.curation_note}
        }
    })
    fs.writeFileSync(CURATION_FILE, JSON.stringify(data, null, 2), 'utf-8')
}

// ---------------------------------------------------------------------------
// Sample QC loading & aggregation
// ---------------------------------------------------------------------------

/**
 * Classify a numeric QC value against the ordered threshold tiers for a
 * given metric.  Returns the tier label ('pass', 'warn', 'fail', 'critical')
 * or 'unknown' when the metric has no configured thresholds.
 */
function classifyQcValue(metric, value) {
    const tiers = QC_METRIC_THRESHOLDS[metric]
    if (!tiers) return 'unknown'
    const num = Number(value)
    if (isNaN(num)) return 'unknown'
    for (const tier of tiers) {
        if (tier.max !== undefined && num < tier.max) return tier.label
        if (tier.min !== undefined && num >= tier.min) return tier.label
    }
    return 'unknown'
}

/**
 * Load and aggregate sample QC data from a TSV file.
 *
 * Expected columns: trio_id, role, sample_id, plus one or more numeric
 * QC metric columns (e.g. freemix, mean_coverage).  The `role` column
 * should contain values like 'proband', 'mother', 'father'.
 *
 * Aggregation groups rows by trio_id and pivots per-role metrics into a
 * single record per trio with worst-case status across members.
 */
function loadSampleQc(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
        if (filePath) log.warn(`Sample QC file not found: ${filePath}`)
        return
    }

    const raw = fs.readFileSync(filePath, 'utf-8')
    const lines = raw.trim().split('\n')
    if (lines.length < 2) {
        log.warn('Sample QC file must have a header line and at least one data line.')
        return
    }

    sampleQcColumns = lines[0].split('\t').map(c => c.trim())
    const required = ['trio_id', 'role', 'sample_id']
    for (const r of required) {
        if (!sampleQcColumns.includes(r)) {
            log.error(`Sample QC TSV missing required column: ${r}`)
            return
        }
    }

    // Identify QC metric columns (everything that is not a required column)
    const metricCols = sampleQcColumns.filter(c => !required.includes(c))

    sampleQcData = lines.slice(1).map(line => {
        const cols = line.split('\t')
        const obj = {}
        sampleQcColumns.forEach((h, i) => {
            let val = (cols[i] || '').trim()
            if (metricCols.includes(h)) {
                const num = Number(val)
                if (!isNaN(num) && val !== '') val = num
            }
            obj[h] = val
        })
        return obj
    })

    // Aggregate by trio_id
    const trioMap = {}
    for (const row of sampleQcData) {
        const tid = row.trio_id
        if (!tid) continue
        if (!trioMap[tid]) trioMap[tid] = {trio_id: tid, members: {}, metrics: {}}
        const role = (row.role || '').toLowerCase()
        trioMap[tid].members[role] = {sample_id: row.sample_id}
        for (const m of metricCols) {
            if (!trioMap[tid].metrics[m]) trioMap[tid].metrics[m] = {}
            trioMap[tid].metrics[m][role] = row[m]
        }
    }

    // Compute worst-case status per metric across the trio
    sampleQcTrios = Object.values(trioMap).map(trio => {
        const statuses = {}
        const worstOverall = {label: 'pass', rank: 0}
        const statusRank = {pass: 0, warn: 1, fail: 2, critical: 3, unknown: -1}

        for (const m of metricCols) {
            const vals = trio.metrics[m] || {}
            let worstLabel = 'pass'
            let worstRank = 0
            for (const [role, val] of Object.entries(vals)) {
                const label = classifyQcValue(m, val)
                const rank = statusRank[label] !== undefined ? statusRank[label] : -1
                if (rank > worstRank) {
                    worstRank = rank
                    worstLabel = label
                }
            }
            statuses[m] = worstLabel
            if ((statusRank[worstLabel] || 0) > worstOverall.rank) {
                worstOverall.label = worstLabel
                worstOverall.rank = statusRank[worstLabel] || 0
            }
        }
        return {...trio, statuses, qc_status: worstOverall.label}
    })

    log.info(`Loaded ${sampleQcData.length} QC records (${sampleQcTrios.length} trios) from ${filePath}`)
}

// ---------------------------------------------------------------------------
// Filtering helper
// ---------------------------------------------------------------------------

/**
 * Build a lookup from trio_id → aggregated QC record for fast variant
 * annotation.  Returns an empty map when no QC data is loaded.
 */
function getTrioQcMap() {
    if (sampleQcTrios.length === 0) return new Map()
    return new Map(sampleQcTrios.map(t => [t.trio_id, t]))
}

/**
 * Evaluate a single functional filter condition against a variant.
 *
 * Supported operators:
 *   Categorical : "in"  – cell value matches one of `values` (case-insensitive)
 *                "eq"  – cell equals `value` (case-insensitive)
 *                "neq" – cell does not equal `value` (case-insensitive)
 *                "contains" – cell contains `value` as a substring (case-insensitive)
 *   Numeric     : ">"  ">="  "<"  "<=" – numeric comparison against `value`
 *
 * @param {Object} variant - A single variant row object
 * @param {{col:string, op:string, value?:string|number, values?:string[]}} cond
 * @returns {boolean}
 */
function evaluateCondition(variant, cond) {
    const {col, op, value, values} = cond
    const cell = variant[col]

    switch (op) {
        case 'in': {
            const cellStr = String(cell ?? '').toLowerCase()
            return Array.isArray(values) && values.some(v => cellStr === String(v).toLowerCase())
        }
        case 'eq': {
            return String(cell ?? '').toLowerCase() === String(value ?? '').toLowerCase()
        }
        case 'neq': {
            return String(cell ?? '').toLowerCase() !== String(value ?? '').toLowerCase()
        }
        case 'contains': {
            return String(cell ?? '').toLowerCase().includes(String(value ?? '').toLowerCase())
        }
        case '>': {
            const n = Number(cell)
            return !isNaN(n) && n > Number(value)
        }
        case '>=': {
            const n = Number(cell)
            return !isNaN(n) && n >= Number(value)
        }
        case '<': {
            const n = Number(cell)
            return !isNaN(n) && n < Number(value)
        }
        case '<=': {
            const n = Number(cell)
            return !isNaN(n) && n <= Number(value)
        }
        default:
            return false
    }
}

/**
 * Return true if the variant satisfies at least one condition in the list
 * (OR semantics across the conditions array).
 *
 * @param {Object} variant
 * @param {Array} conditions - Array of condition objects (see evaluateCondition)
 * @returns {boolean}
 */
function matchesFunctionalFilter(variant, conditions) {
    return conditions.some(cond => evaluateCondition(variant, cond))
}

/**
 * Format a single functional filter condition as a human-readable phrase.
 * @param {{col:string, op:string, value?:*, values?:string[]}} cond
 * @returns {string}
 */
function formatCondition(cond) {
    const col = cond.col || '?'
    const op = cond.op || '?'
    if (op === 'in') {
        const vals = Array.isArray(cond.values) ? cond.values.join(', ') : String(cond.value ?? '')
        return `${col} in [${vals}]`
    }
    if (op === 'eq') return `${col} = ${cond.value ?? ''}`
    if (op === 'neq') return `${col} ≠ ${cond.value ?? ''}`
    if (op === 'contains') return `${col} contains "${cond.value ?? ''}"`
    return `${col} ${op} ${cond.value ?? ''}`
}

/**
 * Convert a functional_filter JSON string into a human-readable description.
 * Each condition becomes a phrase; conditions are joined with " OR ".
 *
 * @param {string} jsonStr - JSON-encoded array of condition objects
 * @returns {string} Human-readable filter description, or the raw string on parse failure
 */
function functionalFilterToHuman(jsonStr) {
    let conditions
    try {
        conditions = JSON.parse(jsonStr)
    } catch (_) {
        return String(jsonStr)
    }
    if (!Array.isArray(conditions) || conditions.length === 0) return '(empty)'
    return conditions.map(formatCondition).join(' OR ')
}


function applyFilters(query) {
    let filtered = [...variants]

    // Free-text search across all columns
    if (query.search) {
        const term = query.search.trim().toLowerCase()
        if (term) {
            filtered = filtered.filter(v =>
                headerColumns.some(col => String(v[col] || '').toLowerCase().includes(term))
            )
        }
    }

    // Functional filter: JSON-encoded array of OR conditions, each condition
    // may test any column with any supported operator.
    if (query.functional_filter) {
        try {
            const conditions = JSON.parse(query.functional_filter)
            if (Array.isArray(conditions) && conditions.length > 0) {
                filtered = filtered.filter(v => matchesFunctionalFilter(v, conditions))
            }
        } catch (_) {
            // Malformed JSON – silently ignore so other filters still apply
        }
    }

    for (const [key, val] of Object.entries(query)) {
        if (key === 'page' || key === 'per_page' || key === 'sort' || key === 'order' ||
            key === 'search' || key === 'functional_filter') continue
        if (!val) continue

        // Range filters: field_min / field_max
        const minMatch = key.match(/^(.+)_min$/)
        const maxMatch = key.match(/^(.+)_max$/)

        if (minMatch) {
            const field = minMatch[1]
            const threshold = Number(val)
            if (!isNaN(threshold)) {
                filtered = filtered.filter(v => {
                    const n = Number(v[field])
                    return !isNaN(n) && n >= threshold
                })
            }
        } else if (maxMatch) {
            const field = maxMatch[1]
            const threshold = Number(val)
            if (!isNaN(threshold)) {
                filtered = filtered.filter(v => {
                    const n = Number(v[field])
                    return !isNaN(n) && n <= threshold
                })
            }
        } else {
            // Exact multi-value match (comma-separated)
            const values = val.split(',').map(s => s.trim().toLowerCase())
            filtered = filtered.filter(v => {
                const cell = String(v[key] || '').toLowerCase()
                return values.some(match => cell === match)
            })
        }
    }

    // Sorting
    if (query.sort && headerColumns.includes(query.sort)) {
        const field = query.sort
        const dir = query.order === 'desc' ? -1 : 1
        filtered.sort((a, b) => {
            const va = a[field], vb = b[field]
            if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir
            return String(va).localeCompare(String(vb)) * dir
        })
    }

    return filtered
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express()
app.use(express.json({limit: '200mb'}))
app.use(log.requestLogger)

// Serve static UI files
app.use(express.static(path.join(__dirname, 'public')))

// Serve igv.js dist from parent repo
app.use('/igv-dist', express.static(path.join(__dirname, '..', 'dist')))

// Serve genomic data files (BAM, CRAM, VCF, etc.) with Range request support
app.use('/data', express.static(DATA_DIR, {
    setHeaders: (res) => {
        res.set('Accept-Ranges', 'bytes')
        res.set('Access-Control-Allow-Origin', '*')
        res.set('Access-Control-Allow-Headers', 'Range')
        res.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length')
    }
}))

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

// Configuration endpoint
app.get('/api/config', (_req, res) => {
    const cfg = {
        genome: GENOME,
        columns: headerColumns,
        totalVariants: variants.length,
        dataDir: '/data',
        hasSampleQc: sampleQcTrios.length > 0,
        qcMetricThresholds: QC_METRIC_THRESHOLDS,
        checkSequenceMD5: ENABLE_CRAM_MD5_CHECK
    }

    // VCF track configuration
    if (VCF_FILE) {
        const vcfUrl = VCF_FILE.startsWith('http') ? VCF_FILE : `/data/${VCF_FILE}`
        cfg.vcfTrack = {url: vcfUrl}

        // Parse sample roles: "proband:NA12878,mother:NA12891,father:NA12892"
        if (VCF_SAMPLES) {
            const samples = {}
            VCF_SAMPLES.split(',').forEach(pair => {
                const [role, name] = pair.split(':').map(s => s.trim())
                if (role && name) samples[role] = name
            })
            cfg.vcfTrack.samples = samples
        }
    }

    // BED track configuration (from --bed-tracks CLI args)
    if (BED_TRACK_CONFIGS.length > 0) {
        cfg.bedTracks = BED_TRACK_CONFIGS.map(t => {
            const fp = t.path
            const url = fp.startsWith('http') ? fp : `/data/${fp}`
            const track = {name: t.name, url}
            // Auto-detect tabix index
            const idxPath = fp + '.tbi'
            const idxFull = fp.startsWith('http') ? null : path.join(DATA_DIR, idxPath)
            if (idxFull && fs.existsSync(idxFull)) {
                track.indexURL = `/data/${idxPath}`
            } else if (fp.startsWith('http')) {
                track.indexURL = url + '.tbi'
            }
            return track
        })
    }

    // Detect per-variant BED track columns in the TSV
    const bedColumnSuffixes = ['_kraken2_spans_bed', '_kraken2_expanded_bed', '_kraken2_reads_bed']
    const detectedBedColumns = headerColumns.filter(c =>
        bedColumnSuffixes.some(s => c.endsWith(s)) || c === 'kraken2_spans_bed' || c === 'kraken2_expanded_bed' || c === 'kraken2_reads_bed'
    )
    if (detectedBedColumns.length > 0) {
        cfg.bedColumns = detectedBedColumns
    }

    res.json(cfg)
})

// List / filter variants
app.get('/api/variants', (req, res) => {
    const filtered = applyFilters(req.query)
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const perPage = Math.min(200, Math.max(1, parseInt(req.query.per_page, 10) || 50))
    const start = (page - 1) * perPage
    const paged = filtered.slice(start, start + perPage)

    // Annotate with QC warnings when QC data is available
    const trioQc = getTrioQcMap()
    const linkCol = ['trio_id', 'sample_id'].find(c => headerColumns.includes(c))
    const annotated = paged.map(v => {
        if (trioQc.size === 0 || !linkCol) return v
        const qc = trioQc.get(v[linkCol])
        if (!qc) return v
        return {...v, _qc_status: qc.qc_status, _qc_statuses: qc.statuses}
    })

    // Curation counts across ALL variants (not just filtered/paged)
    let pass = 0, fail = 0, uncertain = 0, pending = 0
    variants.forEach(v => {
        if (v.curation_status === 'pass') pass++
        else if (v.curation_status === 'fail') fail++
        else if (v.curation_status === 'uncertain') uncertain++
        else pending++
    })

    // Unique non-empty notes across ALL variants
    const allNotes = [...new Set(variants.map(v => v.curation_note).filter(n => n))]
    allNotes.sort((a, b) => a.localeCompare(b))

    res.json({
        total: filtered.length,
        page,
        per_page: perPage,
        pages: Math.ceil(filtered.length / perPage),
        data: annotated,
        curation_counts: {pass, fail, uncertain, pending},
        all_notes: allNotes
    })
})

// Get single variant
app.get('/api/variants/:id', (req, res) => {
    const id = parseInt(req.params.id, 10)
    const v = variants.find(x => x.id === id)
    if (!v) return res.status(404).json({error: 'Variant not found'})
    res.json(v)
})

// Batch curation
app.put('/api/curate/batch', (req, res) => {
    const {ids, status, note} = req.body
    if (!Array.isArray(ids)) return res.status(400).json({error: 'ids must be an array'})
    const allowedStatuses = ['pending', 'pass', 'fail', 'uncertain']
    if (status && !allowedStatuses.includes(status)) {
        return res.status(400).json({error: `Invalid status. Use: ${allowedStatuses.join(', ')}`})
    }

    const updated = []
    for (const id of ids) {
        const v = variants.find(x => x.id === id)
        if (v) {
            if (status) v.curation_status = status
            if (note !== undefined) v.curation_note = String(note)
            updated.push(v)
        }
    }

    saveCuration()
    res.json({updated: updated.length, data: updated})
})

// Gene-level curation – flag all variants in a given gene
app.put('/api/curate/gene', (req, res) => {
    const {gene, status, note} = req.body
    if (!gene) return res.status(400).json({error: 'gene is required'})
    const geneCol = headerColumns.includes('gene') ? 'gene' : null
    if (!geneCol) return res.status(400).json({error: 'No gene column found in data'})
    const allowedStatuses = ['pending', 'pass', 'fail', 'uncertain']
    if (status && !allowedStatuses.includes(status)) {
        return res.status(400).json({error: `Invalid status. Use: ${allowedStatuses.join(', ')}`})
    }
    const geneVariants = variants.filter(v => v[geneCol] === gene)
    if (geneVariants.length === 0) {
        return res.status(404).json({error: `No variants found for gene: ${gene}`})
    }
    for (const v of geneVariants) {
        if (status) v.curation_status = status
        if (note !== undefined) v.curation_note = String(note)
    }
    saveCuration()
    res.json({updated: geneVariants.length, gene, data: geneVariants})
})

// Sample-level curation – flag all variants for a given sample/trio
app.put('/api/curate/sample', (req, res) => {
    const {sample, status, note} = req.body
    if (!sample) return res.status(400).json({error: 'sample is required'})
    const sampleCol = ['sample_id', 'trio_id'].find(c => headerColumns.includes(c)) || null
    const allowedStatuses = ['pending', 'pass', 'fail', 'uncertain']
    if (status && !allowedStatuses.includes(status)) {
        return res.status(400).json({error: `Invalid status. Use: ${allowedStatuses.join(', ')}`})
    }
    // When no sample column exists, sample summary groups everything as 'all'
    const sampleVariants = sampleCol
        ? variants.filter(v => (v[sampleCol] || 'unknown') === sample)
        : (sample === 'all' ? [...variants] : [])
    if (sampleVariants.length === 0) {
        return res.status(404).json({error: `No variants found for sample: ${sample}`})
    }
    for (const v of sampleVariants) {
        if (status) v.curation_status = status
        if (note !== undefined) v.curation_note = String(note)
    }
    saveCuration()
    res.json({updated: sampleVariants.length, sample, data: sampleVariants})
})

// Update curation status (single variant)
app.put('/api/variants/:id/curate', (req, res) => {
    const id = parseInt(req.params.id, 10)
    const v = variants.find(x => x.id === id)
    if (!v) return res.status(404).json({error: 'Variant not found'})

    const allowedStatuses = ['pending', 'pass', 'fail', 'uncertain']
    if (req.body.status && !allowedStatuses.includes(req.body.status)) {
        return res.status(400).json({error: `Invalid status. Use: ${allowedStatuses.join(', ')}`})
    }

    if (req.body.status) v.curation_status = req.body.status
    if (req.body.note !== undefined) v.curation_note = String(req.body.note)

    saveCuration()
    res.json(v)
})

// Filter metadata (unique values per column for filter dropdowns)
app.get('/api/filters', (_req, res) => {
    const filters = {}
    const numericColumns = []
    const skipCols = new Set(['id', 'pos', 'ref', 'alt', 'curation_note'])
    for (const col of headerColumns) {
        if (skipCols.has(col)) continue

        // Detect whether the column is predominantly numeric
        const nonEmpty = variants.filter(v => v[col] !== '' && v[col] !== undefined && v[col] !== null)
        const numericCount = nonEmpty.filter(v => !isNaN(Number(v[col]))).length
        const NUMERIC_COLUMN_THRESHOLD = 0.5
        if (nonEmpty.length > 0 && numericCount / nonEmpty.length > NUMERIC_COLUMN_THRESHOLD) {
            numericColumns.push(col)
            continue
        }

        const unique = [...new Set(variants.map(v => String(v[col] || '')))]
            .filter(Boolean)
            .sort()
        if (unique.length <= 100) {
            filters[col] = unique
        }
    }
    // Add curation status
    filters['curation_status'] = ['pending', 'pass', 'fail', 'uncertain']
    res.json({categorical: filters, numeric: numericColumns})
})

// Sample QC endpoint – returns trio-aggregated QC data with per-metric
// status classifications and worst-case trio status.
app.get('/api/sample-qc', (_req, res) => {
    if (sampleQcTrios.length === 0) {
        return res.json({
            loaded: false,
            message: 'No sample QC data loaded. Use --sample-qc <path> to load a QC file.',
            trios: [],
            metric_columns: [],
            thresholds: QC_METRIC_THRESHOLDS
        })
    }

    const metricCols = sampleQcColumns.filter(c => !['trio_id', 'role', 'sample_id'].includes(c))
    res.json({
        loaded: true,
        total_trios: sampleQcTrios.length,
        total_samples: sampleQcData.length,
        metric_columns: metricCols,
        thresholds: QC_METRIC_THRESHOLDS,
        trios: sampleQcTrios
    })
})

// ---------------------------------------------------------------------------
// Species metrics (Kraken2 BED track analysis)
// ---------------------------------------------------------------------------

/**
 * Resolve BED file paths from CLI --bed-tracks and per-variant TSV columns.
 * Returns absolute paths for files that exist on disk (for server-side parsing).
 */
function resolveBedFilePaths(variant) {
    const files = []

    // Global BED tracks from CLI
    for (const t of BED_TRACK_CONFIGS) {
        const fp = t.path.startsWith('/') ? t.path : path.join(DATA_DIR, t.path)
        if (fs.existsSync(fp)) files.push(fp)
    }

    // Per-variant BED file columns
    if (variant) {
        const bedCols = headerColumns.filter(c =>
            c.endsWith('_kraken2_spans_bed') || c.endsWith('_kraken2_expanded_bed') ||
            c.endsWith('_kraken2_reads_bed') || c === 'kraken2_spans_bed' ||
            c === 'kraken2_expanded_bed' || c === 'kraken2_reads_bed'
        )
        for (const col of bedCols) {
            const val = variant[col]
            if (!val) continue
            const fp = val.startsWith('/') ? val : path.join(DATA_DIR, val)
            if (fs.existsSync(fp)) files.push(fp)
        }
    }

    return files
}

/**
 * Per-variant species/contamination metrics for the export (mirrors the
 * /api/species-metrics per-variant logic). Returns the metrics object, or null
 * when no BED tracks are configured or the variant has no informative reads.
 */
function getVariantSpeciesMetrics(variant) {
    const bedFiles = resolveBedFilePaths(variant)
    if (bedFiles.length === 0) return null
    const pos0 = parseInt(variant.pos, 10) - 1  // VCF 1-based → BED 0-based
    let metrics = speciesMetrics.getVariantMetrics(`${variant.chrom}:${pos0}:${variant.ref}:${variant.alt}`, bedFiles)
    if (metrics.totalReads === 0) {
        const m1 = speciesMetrics.getVariantMetrics(`${variant.chrom}:${variant.pos}:${variant.ref}:${variant.alt}`, bedFiles)
        if (m1.totalReads > 0) metrics = m1
    }
    return metrics.totalReads > 0 ? metrics : null
}

app.get('/api/species-metrics', (req, res) => {
    const variantId = req.query.variant_id
    const variantKey = req.query.variant_key

    // Per-variant metrics
    if (variantId !== undefined || variantKey) {
        let variant = null
        if (variantId !== undefined) {
            const id = parseInt(variantId, 10)
            variant = variants.find(v => v.id === id)
        }
        if (!variant && variantKey) {
            variant = variants.find(v => v._key === variantKey)
        }
        if (!variant) {
            return res.status(404).json({error: 'Variant not found'})
        }

        const bedFiles = resolveBedFilePaths(variant)
        if (bedFiles.length === 0) {
            return res.json({
                loaded: false,
                message: 'No BED track files available. Use --bed-tracks to load species-annotated BED files.',
                metrics: null
            })
        }

        // Construct the variant key in 0-based format (BED uses 0-based coordinates)
        const pos0 = parseInt(variant.pos, 10) - 1  // VCF 1-based → BED 0-based
        const bedVariantKey = `${variant.chrom}:${pos0}:${variant.ref}:${variant.alt}`
        const metrics = speciesMetrics.getVariantMetrics(bedVariantKey, bedFiles)

        // Also try 1-based key in case BED uses 1-based variant keys
        if (metrics.totalReads === 0) {
            const bedVariantKey1 = `${variant.chrom}:${variant.pos}:${variant.ref}:${variant.alt}`
            const metrics1 = speciesMetrics.getVariantMetrics(bedVariantKey1, bedFiles)
            if (metrics1.totalReads > 0) {
                return res.json({loaded: true, variant_key: bedVariantKey1, metrics: metrics1})
            }
        }

        return res.json({loaded: true, variant_key: bedVariantKey, metrics})
    }

    // Global summary across all BED files
    const bedFiles = resolveBedFilePaths(null)
    if (bedFiles.length === 0) {
        return res.json({
            loaded: false,
            message: 'No BED track files available. Use --bed-tracks to load species-annotated BED files.',
            summary: null
        })
    }

    const summary = speciesMetrics.getGlobalSummary(bedFiles)
    res.json({loaded: true, file_count: bedFiles.length, summary})
})

// Saved filter configuration
app.get('/api/filter-config', (_req, res) => {
    if (fs.existsSync(FILTERS_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(FILTERS_FILE, 'utf-8'))
            return res.json(data)
        } catch (e) {
            log.warn('Could not parse filters file:', e.message)
        }
    }
    res.json({})
})

app.put('/api/filter-config', (req, res) => {
    const filters = req.body
    if (!filters || typeof filters !== 'object') {
        return res.status(400).json({error: 'Request body must be a JSON object'})
    }
    try {
        fs.writeFileSync(FILTERS_FILE, JSON.stringify(filters, null, 2), 'utf-8')
        log.info('Saved filter configuration')
        res.json({ok: true})
    } catch (e) {
        log.error('Failed to save filters:', e.message)
        res.status(500).json({error: 'Failed to save filter configuration'})
    }
})

// -------------------------------------------------------------------------
// Export configuration – persisted settings controlling XLSX/HTML export
// -------------------------------------------------------------------------
app.get('/api/export-config', (_req, res) => {
    if (fs.existsSync(EXPORT_CONFIG_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(EXPORT_CONFIG_FILE, 'utf-8'))
            const merged = mergeWithDefaults(data)
            merged.genomeBuild = GENOME  // Server genome build is authoritative
            return res.json(merged)
        } catch (e) {
            log.warn('Could not parse export config file:', e.message)
        }
    }
    res.json(mergeWithDefaults({genomeBuild: GENOME}))
})

app.put('/api/export-config', (req, res) => {
    const config = req.body
    if (!config || typeof config !== 'object') {
        return res.status(400).json({error: 'Request body must be a JSON object'})
    }
    try {
        const merged = mergeWithDefaults(config)
        fs.writeFileSync(EXPORT_CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8')
        log.info('Saved export configuration')
        res.json({ok: true})
    } catch (e) {
        log.error('Failed to save export config:', e.message)
        res.status(500).json({error: 'Failed to save export configuration'})
    }
})

// -------------------------------------------------------------------------
// Gene annotations – MyGene.info batch lookup
// -------------------------------------------------------------------------
app.get('/api/gene-annotations', async (req, res) => {
    const geneCol = headerColumns.includes('gene') ? 'gene' : null
    if (!geneCol) {
        return res.json({annotations: {}, errors: [], message: 'No gene column found'})
    }

    const filtered = applyFilters(req.query)
    const genes = [...new Set(filtered.map(v => v[geneCol]).filter(Boolean))]

    if (genes.length === 0) {
        return res.json({annotations: {}, errors: []})
    }

    const annotMap = await fetchGeneAnnotationsBatch(genes)
    const annotations = {}
    const errors = []
    for (const [gene, data] of annotMap) {
        if (data && data.error) {
            errors.push({gene, error: data.error})
        }
        annotations[gene] = data
    }

    res.json({annotations, errors, genomeBuild: GENOME})
})

// Gene-level summary (post-filtering)
app.get('/api/summary', (req, res) => {
    const filtered = applyFilters(req.query)
    const geneCol = headerColumns.includes('gene') ? 'gene' : null
    if (!geneCol) {
        return res.json({summary: [], message: 'No gene column found in data'})
    }

    const sampleCol = ['sample_id', 'trio_id'].find(c => headerColumns.includes(c)) || null
    const impactCol = headerColumns.includes('impact') ? 'impact' : null

    const geneMap = {}
    for (const v of filtered) {
        const gene = v[geneCol]
        if (!gene) continue
        if (!geneMap[gene]) {
            geneMap[gene] = {gene, total: 0, pass: 0, fail: 0, uncertain: 0, pending: 0,
                passHigh: 0, passMod: 0, passLow: 0, high: 0, mod: 0, low: 0,
                _samples: new Set(), variants: []}
        }
        const gm = geneMap[gene]
        gm.total++
        gm[v.curation_status || 'pending']++
        if (impactCol) {
            const imp = String(v[impactCol] || '').toUpperCase()
            const isPass = v.curation_status === 'pass'
            if (imp === 'HIGH') { gm.high++; if (isPass) gm.passHigh++ }
            else if (imp === 'MODERATE') { gm.mod++; if (isPass) gm.passMod++ }
            else if (imp === 'LOW') { gm.low++; if (isPass) gm.passLow++ }
        }
        if (sampleCol && v[sampleCol]) gm._samples.add(v[sampleCol])
        gm.variants.push({
            id: v.id, chrom: v.chrom, pos: v.pos, ref: v.ref, alt: v.alt,
            impact: v.impact || '', curation_status: v.curation_status
        })
    }

    const summary = Object.values(geneMap)
        .map(g => {
            const {_samples, ...rest} = g
            return {...rest, samples: _samples.size}
        })
        .sort((a, b) => b.total - a.total)

    res.json({
        total_genes: summary.length,
        total_variants: filtered.length,
        summary
    })
})

// Per-sample variant counts by impact level and frequency threshold
app.get('/api/sample-summary', (req, res) => {
    const filtered = applyFilters(req.query)
    const impactCol = headerColumns.includes('impact') ? 'impact' : null
    const freqCol = headerColumns.find(c => c.startsWith('freq')) || null
    const sampleCol = ['sample_id', 'trio_id'].find(c => headerColumns.includes(c)) || null

    const thresholds = SAMPLE_SUMMARY_THRESHOLDS
    const impactGroups = SAMPLE_SUMMARY_IMPACT_GROUPS

    // Group ALL variants by sample (unfiltered) for total_unfiltered counts
    const allSampleMap = {}
    for (const v of variants) {
        const sampleId = sampleCol ? (v[sampleCol] || 'unknown') : 'all'
        if (!allSampleMap[sampleId]) allSampleMap[sampleId] = 0
        allSampleMap[sampleId]++
    }

    // Group filtered variants by sample
    const sampleMap = {}
    for (const v of filtered) {
        const sampleId = sampleCol ? (v[sampleCol] || 'unknown') : 'all'
        if (!sampleMap[sampleId]) sampleMap[sampleId] = []
        sampleMap[sampleId].push(v)
    }

    const samples = Object.entries(sampleMap).map(([sampleId, sampleVariants]) => {
        const counts = {}
        for (const ig of impactGroups) {
            counts[ig.label] = {}
            const impactFiltered = impactCol
                ? sampleVariants.filter(v => ig.impacts.includes(String(v[impactCol] || '').toUpperCase()))
                : sampleVariants
            for (const t of thresholds) {
                if (!freqCol || t.type === 'all') {
                    counts[ig.label][t.label] = impactFiltered.length
                } else if (t.type === 'eq') {
                    counts[ig.label][t.label] = impactFiltered.filter(v => Number(v[freqCol]) === t.value).length
                } else {
                    counts[ig.label][t.label] = impactFiltered.filter(v => Number(v[freqCol]) < t.value).length
                }
            }
        }

        // Per-sample curation breakdown
        let pass = 0, fail = 0, uncertain = 0, pending = 0
        for (const v of sampleVariants) {
            if (v.curation_status === 'pass') pass++
            else if (v.curation_status === 'fail') fail++
            else if (v.curation_status === 'uncertain') uncertain++
            else pending++
        }

        return {
            sample_id: sampleId,
            total: sampleVariants.length,
            total_unfiltered: allSampleMap[sampleId] || 0,
            curation_counts: {pass, fail, uncertain, pending},
            counts
        }
    })

    // Compute cohort-level aggregate statistics (mean/median) per cell
    const cohort_summary = {}
    for (const ig of impactGroups) {
        cohort_summary[ig.label] = {}
        for (const t of thresholds) {
            const values = samples.map(s => (s.counts[ig.label] && s.counts[ig.label][t.label]) || 0)
            cohort_summary[ig.label][t.label] = computeStats(values)
        }
    }

    res.json({
        total_samples: samples.length,
        total_variants: filtered.length,
        thresholds: thresholds.map(t => t.label),
        impact_groups: impactGroups.map(ig => ig.label),
        samples,
        cohort_summary
    })
})

// Export filtered variants as TSV
app.get('/api/export', (req, res) => {
    const filtered = applyFilters(req.query)
    const exportCols = [...headerColumns, 'curation_status', 'curation_note']
    const uniqueCols = [...new Set(exportCols)]
    const header = uniqueCols.join('\t')
    const rows = filtered.map(v => uniqueCols.map(c => v[c] ?? '').join('\t'))
    const tsv = [header, ...rows].join('\n')

    res.setHeader('Content-Type', 'text/tab-separated-values')
    res.setHeader('Content-Disposition', 'attachment; filename="variants_export.tsv"')
    res.send(tsv)
})

// -------------------------------------------------------------------------
// Lollipop plot – per-gene variant position SVG with protein domain overlay
// -------------------------------------------------------------------------
app.get('/api/lollipop/:gene', async (req, res) => {
    const gene = req.params.gene
    const geneCol = headerColumns.includes('gene') ? 'gene' : null
    if (!geneCol) {
        return res.status(400).json({error: 'No gene column found in data'})
    }

    const filtered = applyFilters(req.query)
    const geneVariants = filtered.filter(v => v[geneCol] === gene)
    if (geneVariants.length === 0) {
        return res.status(404).json({error: `No variants found for gene ${gene}`})
    }

    const svgData = geneVariants.map(v => ({
        chrom: v.chrom, pos: v.pos, ref: v.ref, alt: v.alt,
        impact: v.impact || '', curation_status: v.curation_status || 'pending'
    }))

    // Fetch protein domain annotations from UniProt (non-blocking, graceful fallback)
    const svgOpts = {genomeBuild: GENOME}
    try {
        const domainData = await fetchProteinDomains(gene)
        if (domainData && domainData.domains && domainData.domains.length > 0) {
            svgOpts.domains = domainData.domains
            svgOpts.proteinLength = domainData.proteinLength
            svgOpts.accession = domainData.accession
        }
    } catch (err) {
        log.warn(`Failed to fetch protein domains for ${gene}: ${err.message}`)
    }

    const svg = generateLollipopSvg(gene, svgData, svgOpts)
    res.setHeader('Content-Type', 'image/svg+xml')
    res.send(svg)
})

/**
 * Build the "Read Me" worksheet: a guide to every tab plus a per-column data
 * dictionary (meaning, source, licence) for the Gene Summary annotations.
 * Placed as the first sheet so reviewers can orient before reading the data.
 * Wrapped by the caller in try/catch — must never break the export.
 */
function buildReadmeSheet(workbook, opts) {
    const {exportCfg, headerFill, headerFont, borderThin, genome, hasGene, hasImpact, hasSampleQc,
        hasScreenshots, hasLollipop} = opts
    const ga = exportCfg.geneAnnotations || {}
    const ws = workbook.addWorksheet('Read Me')
    ws.columns = [
        {header: 'Item', key: 'item', width: 26},
        {header: 'Description', key: 'desc', width: 66},
        {header: 'Source', key: 'src', width: 20},
        {header: 'Licence', key: 'lic', width: 18}
    ]
    const hdr = ws.getRow(1)
    hdr.eachCell(cell => {
        cell.fill = headerFill; cell.font = headerFont; cell.border = borderThin
        cell.alignment = {vertical: 'middle', horizontal: 'left'}
    })
    hdr.height = 22

    let idx = 0
    const row = (item, desc, src, lic) => {
        const r = ws.addRow({item, desc, src: src || '', lic: lic || ''})
        r.eachCell(cell => {
            cell.border = borderThin
            cell.alignment = {vertical: 'top', wrapText: true}
            if (idx % 2 === 1) cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFF8F9FA'}}
        })
        idx++
        return r
    }
    const section = (title) => {
        const r = ws.addRow({item: title, desc: '', src: '', lic: ''})
        r.getCell(1).font = {bold: true, color: {argb: 'FF2C3E50'}}
        for (let c = 1; c <= 4; c++) r.getCell(c).fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFD6EAF8'}}
        r.eachCell(cell => { cell.border = borderThin })
        idx++
    }

    row('IGV Variant Review — report guide', `Genome build: ${genome}. This workbook was generated from the review session; annotation columns are best-effort (see the Annotation Status tab for any fetch failures).`)

    // --- Worksheet overview ---
    section('Worksheets in this report')
    row('Read Me', 'This guide: worksheet overview, column dictionary, and data sources.')
    row('Variants', 'One row per exported variant. Rows are colour-coded by curation status (Pass/Fail/Uncertain/Pending). When --bed-tracks (kraken2 species BEDs) are configured, adds contamination columns: Contamination (assessment), Nonhuman %, Contam Reads, Nonhuman Reads, Top Taxa.')
    if (hasGene && exportCfg.sheets.geneSummary) row('Gene Summary', 'One row per gene: curation counts, impact-passing counts, and gene-level annotations. See the column dictionary below.')
    if (hasGene && exportCfg.sheets.geneAnalysis && exportCfg.geneAnalysis && exportCfg.geneAnalysis.enabled) row('Gene Analysis (derivation)', 'Reproducibility appendix for the samples tab: the per-tier proband DNM-burden histogram + denominators that, with a category\'s "% all genes", let you recompute every reported sample p-value exactly (Excel has no Poisson-binomial function). Only present when the data has a sample column.')
    if (hasGene && exportCfg.sheets.geneAnalysis && exportCfg.geneAnalysis && exportCfg.geneAnalysis.enabled) row('Gene Analysis (samples) / (DNMs)', 'Convergence, in two matching tabs: which shared attributes (gnomAD constraint, ClinVar history, protein domain, GenCC inheritance; Reactome & WikiPathways pathways, HGNC gene families, MSigDB Hallmark processes, MitoCarta mitochondrial sets) your genes stack up on. Both are IGV-pass; the "(samples)" tab counts distinct probands (conservative headline), the "(DNMs)" tab counts pass DNMs. Each is a category × cumulative-impact-tier matrix of "count (%)" (with a green ✓ for FDR q<0.05, and the exact p/q to the right) against the category\'s genome-wide prevalence ("% all genes"), plus a burden-corrected Fold (observed ÷ expected, so 1× = chance). An all·ALL column flags noisy (non-pass) pools. Every tier\'s full test inputs are printed to the right so each p-value is reproducible. See the dictionary below.')
    if (hasGene && exportCfg.sheets.geneAnalysis && exportCfg.geneAnalysis && exportCfg.geneAnalysis.enabled && exportCfg.geneAnalysis.dnmRateTest !== false) row('DNM Rate (gene-set)', 'De novo mutation-rate enrichment (Test B): whether a gene set carries more DE NOVO variants than the germline mutation rate predicts for N trios — Poisson λ = 2·N·Σp, with a live =1−POISSON(k−1,λ,TRUE) derivation. p = the per-gene per-transmission de novo rate (Samocha 2014 model, bundled from DeNovoWEST). No scale is fitted to the cohort; the per-class observed/expected ratios are reported as a model-fit diagnostic instead. De-novo-only; appears only when the data has an `inheritance` column and the rate bundle is present. Complements the origin-agnostic Gene Analysis tabs. See the Methods dictionary below.')
    if (hasGene && exportCfg.sheets.geneAnalysis && exportCfg.geneAnalysis && exportCfg.geneAnalysis.enabled && exportCfg.geneAnalysis.dnmRateTest !== false) row('DNM Rate (per-gene)', 'The same de novo mutation-rate test at GENE level: one row per (gene, track) with an observed de novo SNV, k vs Poisson λ = 2·N·p, live =1−POISSON(k−1,λ,TRUE). Nonsense+splice / missense / protein-altering are separate Benjamini-Hochberg discovery families; synonymous is the model-fit diagnostic (no discovery q). Power comes from recurrence (≥2 de novos/gene).')
    if (exportCfg.sheets.sampleSummary) row('Sample Summary', 'Per-sample variant counts by impact group and frequency threshold, with cohort mean/median.')
    if (hasSampleQc && exportCfg.sheets.sampleQc) row('Sample QC', 'Per-sample sequencing QC metrics with threshold-based pass/warn/fail assessment.')
    if (exportCfg.sheets.appliedFilters) row('Applied Filters', 'The filters and export settings used to produce this report (self-documenting).')
    if (exportCfg.sheets.annotationStatus) row('Annotation Status', 'Which external data sources were fetched, any failures, and data-source licences.')
    if (hasLollipop) row('LP <gene>', 'Lollipop plot(s): variant positions along the protein with domain overlays.')
    if (hasScreenshots) row('1, 2, 3, …', 'IGV screenshots captured for individual variants, linked from the Variants sheet.')

    // --- Gene Summary column dictionary ---
    if (hasGene && exportCfg.sheets.geneSummary) {
        section('Gene Summary — column dictionary')
        row('Gene', 'HGNC gene symbol.')
        row('Total', 'Total variants in this gene passing the applied filters.')
        row('Samples', 'Distinct samples/trios harbouring a variant in this gene.')
        row('Pass / Fail / Uncertain / Pending', 'Per-gene counts of variants by reviewer curation status.', 'Reviewer curation')
        if (hasImpact && exportCfg.impactCounts && exportCfg.impactCounts.passByImpact) {
            row('Pass HIGH / Pass MODERATE / Pass LOW / Pass ALL', 'Count of HIGH/MODERATE/LOW-impact variants in this gene that PASS review; Pass ALL = passing variants of ANY impact (incl. MODIFIER/blank), i.e. not limited to HIGH/MOD/LOW.', 'impact × curation')
        }
        if (hasImpact && exportCfg.impactCounts && exportCfg.impactCounts.totalByImpact) {
            row('HIGH / MODERATE / LOW', 'Count of HIGH/MODERATE/LOW-impact variants in this gene regardless of review status.', 'impact column')
        }
        if (ga.enabled) {
            if (ga.geneName) row('Gene Name', 'Full gene name.', 'MyGene.info', 'see below')
            if (ga.geneType) row('Gene Type', 'Gene biotype (e.g. protein-coding).', 'MyGene.info', 'see below')
            if (ga.omim) row('OMIM', 'OMIM MIM number (identifier only — link to omim.org/entry/<MIM>). OMIM disease titles are not embedded (licence).', 'OMIM via MyGene', 'ID/link only')
            if (ga.pathways) row('Pathways', 'KEGG pathway memberships.', 'MyGene.info', 'see below')
            if (ga.summary) row('Summary', 'NCBI gene function summary.', 'MyGene.info', 'see below')

            // Provider columns, described by key so the dictionary tracks what is emitted.
            const keyDesc = {
                gnomadLoeuf: ['gnomAD LoF observed/expected upper CI (LOEUF). Lower = more constrained; <0.35 flagged constrained.', 'gnomAD', 'CC0'],
                gnomadPli: ['Probability of loss-of-function intolerance (pLI). ≥0.9 = LoF-intolerant.', 'gnomAD', 'CC0'],
                gnomadConstrained: ['Derived flag: Yes if pLI≥0.9 or LOEUF<0.35.', 'gnomAD (derived)', 'CC0'],
                gnomadMisZ: ['Missense constraint Z-score. ≥3.09 = missense-constrained.', 'gnomAD', 'CC0'],
                clinvarP: ['Count of ClinVar variants classified Pathogenic for this gene (GRCh38).', 'ClinVar', 'public domain'],
                clinvarLp: ['Count of ClinVar variants classified Likely pathogenic for this gene (GRCh38).', 'ClinVar', 'public domain'],
                clinvarPlp: ['Combined count of Pathogenic + Likely-pathogenic (+ Pathogenic/Likely-pathogenic) variants.', 'ClinVar', 'public domain'],
                clinvarHasPlp: ['Yes if the gene has ≥1 Pathogenic or Likely-pathogenic variant in ClinVar.', 'ClinVar', 'public domain'],
                clinvarVus: ['Count of uncertain-significance variants in ClinVar.', 'ClinVar', 'public domain'],
                clinvarConflicts: ['Count of variants with conflicting classifications in ClinVar.', 'ClinVar', 'public domain'],
                genccMoi: ['Mode(s) of Inheritance (AD/AR/XL…) for the gene, from established-evidence GenCC submissions. AD/monoallelic ⇒ one de novo hit can be causal.', 'GenCC', 'CC0'],
                genccValidity: ['Highest gene-disease validity classification (Definitive→Refuted) across GenCC submitters.', 'GenCC', 'CC0']
            }
            for (const col of annotationRegistry.columns(exportCfg)) {
                if (keyDesc[col.key]) {
                    row(col.header, keyDesc[col.key][0], keyDesc[col.key][1], keyDesc[col.key][2])
                } else if (String(col.key).startsWith('list_')) {
                    row(col.header, 'Membership flag (Yes/No): is this gene present in the named user-supplied gene list?', 'user list', 'membership only')
                }
            }
            if (ga.mitocarta !== false && mitocarta.available().length) {
                row('Mitochondrial (MitoCarta)', 'Is the gene in the MitoCarta3.0 mitochondrial inventory? "Yes" with the sub-mitochondrial localization when known (e.g. "Yes — Matrix, MIM"), else blank. Downloaded from the Broad at runtime (not redistributed).', 'MitoCarta3.0 (Broad)', 'CC BY-NC')
            }
        }
    }

    // --- Gene Analysis dictionary ---
    if (hasGene && exportCfg.sheets.geneAnalysis && exportCfg.geneAnalysis && exportCfg.geneAnalysis.enabled) {
        section('Gene Analysis — how to read it')
        row('Two tabs', 'Convergence is split into TWO matching tabs by the unit of interest. "Gene Analysis (samples)" counts DISTINCT PASS PROBANDS — the conservative, robust headline (a hypermutated proband counts once and can\'t fake convergence). "Gene Analysis (DNMs)" counts PASS DNMs — the variant-level companion (a proband with several hits inflates it). Same categories, same background, same layout; only the counted unit and its test differ. The samples tab is omitted when the data has no sample column.', 'samples | DNMs')
        row('Purpose', 'For each grouping dimension, shows which shared attributes (categories) your genes converge on — the signal when de novo hits are singletons scattered across genes. Everything on both tabs is IGV-PASS only.')
        row('Pass-tier cells: count (%) ✓', 'The four "pass·…" columns are CUMULATIVE impact tiers (HIGH ⊆ HIGH+MOD ⊆ HIGH+MOD+LOW ⊆ ALL; ALL includes MODIFIER/blank). Each cell = the count of the tab\'s unit (probands or DNMs) in a category gene at that tier, and in parens their % of the base (the cohort probands on the samples tab, the total pass DNMs on the DNMs tab). A green "✓" marks a tier whose FDR q<0.05. Blank = 0. Reading across the tiers shows whether the convergence is concentrated in high-impact variants or only appears once low-impact hits are included.', 'impact tier × category')
        row('“…p/q” columns (right)', 'The exact statistics behind each tier\'s ✓, kept to the right so the cells stay scannable: "p / q" = the uncorrected p-value and the Benjamini-Hochberg FDR q for that tier (green when q<0.05; "—" for an empty tier or a dimension with no background). Samples tab p: Poisson-binomial — probability of ≥ this many pass probands hitting the category by chance, where each proband\'s expected hit-rate uses its OWN pass-DNM burden at that tier (a proband with many DNMs is expected to hit, so its single hit is not surprising). DNMs tab p: binomial — each pass DNM at that tier is an independent draw at the "% all genes" rate (not deduped by proband, so less robust). Each tab\'s q is BH-corrected PER DIMENSION across its (category × tier) tests.', 'Poisson-binomial / binomial + BH')
        row('Derivation columns (DNMs tab) — EVERY tier', 'Each row prints the complete test inputs for ALL FOUR tiers, so every p-value on the tab is reproducible from the tab itself. The DNM test is a BINOMIAL: X ~ Binomial(n, p). Per tier T: k = "k DNMs (T)" = that tier\'s category pass DNMs; n = "n pass DNMs (T)" = that tier\'s pass variants INSIDE THAT ROW\'S DIMENSION\'s gene universe (each tier is tested against its own gated total — NOT the ALL total, and NOT the cohort-wide total: a dimension can only draw from the genes its source classifies); p = "p (prev)" = the category\'s prevalence ("% all genes" as a fraction), shared by all tiers because it is a gene property. RATIONALE: under the null each of the n pass DNMs independently lands in a category gene with probability p, so we ask whether MORE landed there than chance. "Expected n·p (T)" is a live formula. The upper tail P(X≥k) is written in "P(X≥k) (T)" as the live Excel formula  =1−BINOMDIST(k−1, n, p, TRUE)  and reproduces that tier\'s "p/q" column EXACTLY.', 'X ~ Binomial(n, p); P(X≥k)=1−BINOMDIST(k−1,n,p,TRUE) per tier')
        row('Derivation columns (samples tab) — EVERY tier', 'Each row prints the complete inputs for ALL FOUR tiers. The SAMPLE test is a POISSON-BINOMIAL (a binomial whose trials have DIFFERENT success probabilities): X = Σᵢ Bernoulli(pᵢ) over the at-risk probands, where proband i carrying dᵢ pass DNMs at that tier hits a category gene by chance with pᵢ = 1−(1−p)^dᵢ. Per tier T: k = "k probands (T)" = probands observed hitting; n = "n at-risk (T)" = probands with ≥1 pass variant at that tier IN THAT ROW\'S DIMENSION\'s gene universe; "Expected Σpᵢ (T)" = Σ_d n_d·[1−(1−p)^d], shown as a LIVE SUMPRODUCT over the burden histogram on the "Gene Analysis (derivation)" sheet — i.e. the expectation is derived in-cell, not asserted. RATIONALE: this dedups per proband AND credits a high-burden proband with a higher chance, so a hypermutant cannot fake convergence. IMPORTANT: Excel has no Poisson-binomial function, so "P(X≥k) approx (T)" is a LIVE BINOMIAL APPROXIMATION  =1−BINOMDIST(k−1, n, Expected/n, TRUE). By Hoeffding (1956) it is conservative (≥ the exact value) for k ≥ Expected+1, where it can run ~10% high; in the narrow band Expected < k < Expected+1 (notably k=1 rows on rare categories) it can run slightly BELOW the exact value. It is NOT the reported number and is labelled "approx". The EXACT value is the tier\'s "p/q" column; reproduce it from the "Gene Analysis (derivation)" sheet, which publishes the per-tier proband burden histogram (the test\'s only other input) plus the exact algorithm.', 'X = ΣBernoulli(pᵢ); exact = Poisson-binomial (see derivation sheet)')
        row('Gene Analysis (derivation) sheet', 'The reproducibility appendix for the sample test. Because each proband\'s pᵢ = 1−(1−p)^dᵢ depends ONLY on its DNM burden dᵢ, the per-tier BURDEN HISTOGRAM (how many probands carry each dᵢ) plus a category\'s p fully determine that category\'s exact Poisson-binomial at every tier. The sheet prints ONE BLOCK PER DIMENSION — each dimension\'s trials are gated to its own source\'s gene universe, so its histogram and its denominators are its own, and reproducing a row means using the block whose heading matches that row\'s section. Each block gives the histogram, the per-tier denominators (at-risk probands / pass variants, both gated), a self-consistency cross-check, and the exact O(n·k) convolution algorithm (plus equivalent library references) so any reader can recompute every reported sample p-value outside Excel.', 'per-dimension histogram + p ⇒ exact p-value')
        row('all·ALL', 'QUALITY FLAG (all curation statuses, any impact): the tab\'s unit hitting the category regardless of IGV status. A large gap (all·ALL ≫ pass·ALL) means the category\'s pass signal was drawn from a pool with many poor-quality/non-pass calls — treat that row with suspicion.', 'curation quality check')
        row('cat size / % all genes', 'The BACKGROUND (chance rate). Each dimension is scored against ITS OWN gene universe — the genes its source actually classifies (gnomAD scores constraint for ~17.5k genes, GenCC asserts on ~6.1k, MSigDB Hallmark annotates ~4.4k; the exact size is in each section header). cat size = the genes in that universe carrying the category; % all genes = cat size ÷ that universe. CRUCIALLY the variants counted are gated to the SAME universe (see "What each dimension can see"), so the chance rate and the trials describe the same gene set — that identity is what makes the test valid, and it is what was broken before this build. Because the universes differ, "% all genes" and Fold are comparable WITHIN a dimension, NOT across dimensions. Shows "—" (and the section says NO BACKGROUND) when a dimension has no offline background and is therefore NOT TESTED: constraint on GRCh37 exports (the tail must not mix a v4.1 background with v2.1.1 per-gene calls), or the protein domain when the InterPro bundle is absent (MyGene fallback gives terms but no background).', 'per-dimension universe')
        row('What each dimension can see', 'A dimension\'s test counts only variants in genes its own source classifies; the rest are excluded from THAT dimension (they still count on every other dimension whose source classifies the gene, and on the Variants / Gene Summary tabs). The tabs print the per-dimension count and gene symbols whenever anything was dropped. WHY this is required rather than a convenience filter: the null asks "had this proband\'s variants landed in random genes THIS SOURCE COULD HAVE CLASSIFIED, how often would one be in this category?" — a gene the source never classified could not have hit any of its categories, so counting it as a draw would inflate the trials against a chance rate it cannot meet. It also keeps "unmeasured" distinct from "not a member": gnomAD never scoring a gene does not make that gene unconstrained. CONSEQUENCE: each dimension answers a CONDITIONAL question — GenCC\'s is "among genes with a gene-disease assertion, do mine converge on this inheritance mode?", not a statement about all genes.', 'trials gated to match')
        row('Universes differ by dimension', 'This is deliberate and it is why the numbers differ between sections. Notably the gnomAD constraint universe is AUTOSOME-ONLY — gnomAD v4.1 publishes no chrX constraint at all — so an X-linked gene (DMD, MECP2, FMR1, DDX3X) cannot appear in the constraint dimension, while ClinVar, GenCC, InterPro and Reactome all classify those genes and do test them. THE BUG THIS FIXED: before this build the chance rate was already per-source, but the trials stayed genome-wide, so a category\'s share of ITS LIBRARY was tested against draws from the whole genome. Every dimension\'s expected count was therefore inflated by 1 ÷ (its coverage of the genes the variants actually land in), because draws it could never classify were still counted as trials. Simulated on these bundles (N=220, genes drawn uniformly from the 32,668 any source knows; observed ÷ expected, where 1.00 is correct): MSigDB Hallmark 0.13 at 13.4% coverage, WikiPathways 0.27 at 27.5%, Reactome 0.35 at 35.8%, HGNC families 0.48 at 47.7%, InterPro domain 0.59 at 58.6% — the reading equals the coverage, which is the fingerprint. The error was never anti-conservative; it made narrow dimensions progressively VACUOUS. On Hallmark a genuine 3× enrichment would have read 3 × 0.133 = 0.40×, i.e. apparent DEPLETION. With the trials gated every dimension calibrates to 0.98–1.00. The exact factor is cohort-dependent, so each dimension\'s own gated n is printed on the derivation sheet next to the cohort-wide totals.', 'fixed: trials now match')
        row('Fold (pass·ALL)', 'The headline effect size at the pass·ALL tier: OBSERVED ÷ EXPECTED-UNDER-THE-NULL, so 1× means "exactly what chance predicts" on BOTH tabs. Samples tab: # pass·ALL probands ÷ "Expected Σpᵢ (ALL)" — the Poisson-binomial mean, i.e. the SAME expectation its p-value uses, which credits each proband with its own pass-variant burden. (It is deliberately NOT probands÷cohort ÷ "% all genes": that divides a per-proband rate by a per-draw prevalence, so under the null it would drift up with the cohort\'s mean variant burden — ~3× at 3 variants/proband, ~8× at 10 — and manufacture a large "fold" on rows whose p-value is null.) DNMs tab: # pass·ALL DNMs ÷ "Expected n·p (ALL)" (≡ the DNM rate ÷ "% all genes"). Bold-green when ≥5× AND backed by ≥2 units (a big fold on a single unit / tiny cohort is left un-bolded). Because the fold and the p-value now share one expectation, they can no longer disagree.')
        row('# genes / Genes', 'Distinct PASS genes in the category (pass·ALL), and their symbols (locus heterogeneity). A category is shown only if ≥2 pass samples OR ≥2 pass genes share it; a row is bold when ≥2 pass·ALL units share it. Note: a category kept via ≥2 GENES with only 1 proband can still earn a ✓ on the samples tab — that is within-proband gene convergence, not cross-sample recurrence.')
        row('Dimensions', 'All 8 offline for an hg38 export with the bundles present: gnomAD constraint tail (LOEUF<0.6 / pLI≥0.9), ClinVar P/LP history, GenCC Mode-of-Inheritance, protein domain (InterPro, human gene→domain bundled from Ensembl/InterPro — terms + background from the same source), Reactome & WikiPathways pathways, HGNC gene families (PROTEIN-CODING genes only — non-coding loci excluded so the background is the coding genome), MSigDB Hallmark processes. Plus up to 3 MitoCarta3.0 dimensions (mitochondrial localization, sub-mitochondrial localization, MitoPathways3.0) when the runtime download from the Broad has succeeded (CC BY-NC — not bundled; absent when egress is blocked). Each dimension is scored over ITS OWN source\'s genes and its trials are gated to the same set, so each answers a question conditional on that universe — read Fold within a dimension, not across. On GRCh37/hg19 the constraint TERMS come from the live gnomAD API and the constraint BACKGROUND is withheld (mixing a v4.1 background with v2.1.1 calls would be a build error, so the dimension shows counts but no p/q); if the InterPro bundle is absent the domain TERMS fall back to live MyGene, likewise with no background.', 'up to 11 dimensions')
        row('Reading pathways', 'Pathway dimensions overlap heavily (a gene sits in many pathways), so many near-identical rows can share the same genes — only the top 25 per dimension (by pass·ALL distinct-proband count, a single ranking shared by both tabs) are shown and the remainder is noted. Judge convergence by the gene list + the counts, not by the number of rows.')
        row('Method', 'Read the Fold (observed ÷ expected) TOGETHER with its tier\'s q — they share one expectation, so a large Fold on a null q now means "few units, wide uncertainty", not a contradiction. Do not read the raw count against "% all genes" by eye: on the samples tab that comparison ignores each proband\'s variant burden and drifts upward with it (the Poisson-binomial expectation in the Fold is what corrects for that). The SAMPLE tab\'s q is the conservative statistical backstop; the DNM tab\'s q is a less-robust companion. Enrichment is upper-tail only (depletion is not tested), and FDR is controlled WITHIN each dimension (don\'t pool ✓ across dimensions); the nested pass tiers make each tier\'s q conservative. This is a GENE-COUNT (distributional) null — it is origin-agnostic (de novo or inherited) and captures ALL variant types incl. indels.' + (exportCfg.geneAnalysis.dnmRateTest !== false
            ? ' The complementary mutation-rate null lives on the separate "DNM Rate (gene-set)" tab (Test B, de novo only).'
            : ' A complementary DE NOVO MUTATION-RATE null (Test B) exists in this tool but is WITHHELD from this workbook — see the "Mutation-rate test (withheld)" row below.'))
        if (exportCfg.geneAnalysis.dnmRateTest === false) {
            row('Mutation-rate test (withheld)', 'This workbook contains NO de novo mutation-rate test (Test B: k ~ Poisson(λ = 2·N·rate)). It is deliberately withheld, not merely unavailable: its λ was built from gnomAD\'s lof.mu/mis.mu/syn.mu, which are NOT per-transmission de novo rates — gnomAD fits "expected = mu·slope + intercept" and refits the slope, so mu is identified only up to a proportionality constant. Summing it predicts 0.276 coding de novo per trio against a published ~1.0–1.3 (λ ≈ 3.9× too small), and a deflated λ pushes small-rate genes past the FDR threshold on a SINGLE variant (~200 genes would earn q<0.05 off one de novo at N=220, vs 32 under correct rates). Its class balance is separately wrong (lof.mu/syn.mu = 0.319, against 0.168 from three independent implementations of the Samocha 2014 model) — an error no rescaling can repair. A corrected per-gene rate table (Samocha 2014 model via DeNovoWEST; Kaplanis & Samocha, Nature 2020;586:757) is prepared; the test returns once λ reads it and applies an empirical calibration. NOTHING on the Gene Analysis tabs depends on it: those are a gene-count null and are unaffected.',
                'Test B suppressed — no mutation-rate test in this workbook')
        }
        row('BH family (what q corrects for)', 'The Benjamini-Hochberg family is, per dimension, the A-PRIORI grid: EVERY category in the source library × all four cumulative pass tiers — the size m is printed in each section header. A category that no cohort gene belongs to, or a tier with no hit, was still scanned and carries its exact p = P(X≥0) = 1; it can never be rejected but it DOES count toward m. The display filters (the ≥2-samples-or-genes keep-rule, and the top-25-per-dimension cap) are applied AFTER the correction, so hiding a row never changes a q. This is load-bearing: letting the observed data pick the family — correcting only the cells or the categories that happened to be hit — makes q anti-conservative. Simulated real FDR at a nominal 5%: ~35% correcting over hit cells only, ~15% over hit categories only (HGNC families; ~6% Reactome), vs ~1-2% for the a-priori grid. It bites hardest on the sparse libraries (Reactome/WikiPathways/HGNC/MitoPathways), where most categories go unhit; dense dimensions (constraint, GenCC, Hallmark) were already close. Because most cells are exactly p=1 the procedure is CONSERVATIVE (~1-2% against a 5% nominal) — the price of validity under discreteness. VALIDITY: BH controls FDR under independence and under positive regression dependence (Benjamini & Yekutieli, Ann Statist 2001) — the nested tiers and the overlapping gene sets within a dimension are positively dependent, which is that case. For arbitrary dependence the stricter BY procedure would scale q by Σ(1/i).', 'BH over library-category × tier, per dimension; m in each section header')
    }

    // --- De Novo Mutation-Rate Enrichment (Test B) — publication-grade methods ---
    if (hasGene && exportCfg.sheets.geneAnalysis && exportCfg.geneAnalysis && exportCfg.geneAnalysis.enabled && exportCfg.geneAnalysis.dnmRateTest !== false) {
        section('DNM Rate (gene-set) — de novo mutation-rate enrichment (Test B)')
        row('Purpose & scope', 'A SECOND, complementary test (its own tab) asking whether more DE NOVO variants fall in a gene set than the germline mutation rate predicts for a cohort of N trios — the classic de novo enrichment framework. DE-NOVO-ONLY: suppressed unless the data has an `inheritance` column (only `de_novo` variants are counted) and gnomAD μ is available (GRCh38). The Gene Analysis samples/DNMs tabs (Test A) are the origin-agnostic clustering test and are unaffected; every variant type (incl. indels) remains represented there.')
        row('Model & formula', 'For a category × cumulative PROTEIN-ALTERING tier (nonsense+splice; nonsense+splice+missense), the observed count k of curation-pass de novo SNVs is modelled as Poisson with mean λ = 2·N·Σp, where N = trio count and Σp = the summed per-transmission de novo rate over the category\'s AUTOSOMAL genes with a rate (over exactly the genes counted in k). NO scale is fitted to the cohort: the rate table is used as published, which keeps λ a known constant and makes the test conservative — a cohort can MISS de novo variants but never invent them, so P(X≥k) is if anything too large. P = P(X ≥ k) = 1 − POISSON(k−1, λ, TRUE) (a live Excel formula). Constant 2 = the two parental transmissions at risk per proband. The per-class observed/expected ratios on the tab are the model-fit DIAGNOSTIC (the synonymous one is ~selection-neutral and should sit near 1); they are reported, never folded into λ. The BH family is the dimension\'s A-PRIORI grid — every library category with a modelable rate × every coding tier, NOT just the categories carrying an observed de novo (an unhit category has k=0, hence the exact p=1). m is printed in each section header.', 'X ~ Poisson(2·N·Σp); P(X≥k)=1−POISSON(k−1,λ,TRUE)')
        row('Rates (p)', 'Per-gene, per-class, PER-TRANSMISSION de novo probabilities from the Samocha 2014 trinucleotide model, bundled from the DeNovoWEST release (data/annotations/dnm_rates.json.gz). Classes: pSyn, pMis, and pNonSplice = p_all − p_syn − p_mis (nonsense + essential-splice SNVs). NOT the source table\'s p_lof, which includes frameshift and so cannot be paired with an SNV-only observed count. NOT gnomAD\'s lof.mu/mis.mu/syn.mu either: those are a MUTABILITY COVARIATE, identified only up to a proportionality constant (gnomAD fits expected = mu·slope + intercept and refits the slope), and summing them predicts 0.276 coding de novo per trio against a published ~1.0–1.3. This table sums to 1.074 per trio at (non+splice)/syn = 0.161, against ~0.16–0.17 from independent implementations. The gnomAD μ columns remain elsewhere in the export as a mutability covariate — they are simply not a rate.', 'DeNovoWEST (MIT); Samocha 2014', 'MIT')
        row('Consequence mapping', 'Classes come from the VEP molecular Consequence when the data has that column: stop_gained / splice_donor_variant / splice_acceptor_variant → nonsense+splice; missense_variant → missense; synonymous_variant → synonymous. VEP orders its &-separated list most-severe-first, and the most severe MODELLED term wins. Everything else (UTR, intron, regulatory, start/stop_lost, stop_retained, and every other splice_* term — region, polypyrimidine tract, 5th base — which are intronic modifiers, not essential-splice SNVs) has no rate term and is excluded; the excluded terms are counted and listed on the tab. WITHOUT a Consequence column the mapping falls back to IMPACT severity (HIGH→nonsense+splice, MODERATE→missense, LOW→synonymous), which is an APPROXIMATION and is flagged on the tab: VEP LOW is NOT synonymous — measured on a real cohort, 34% of LOW rows were splice-region/intronic. That matters because the synonymous class is the model-fit DIAGNOSTIC: contaminating it corrupts the one honest QC readout on the tab. Frameshift/inframe indels are excluded by the SNV-only rule regardless.', 'VEP Consequence (IMPACT fallback)')
        row('Inclusion / exclusion', 'Counted: curation-PASS + `inheritance==de_novo` + SNV (ref/alt length 1) + autosomal + HIGH/MOD/LOW + gene with gnomAD μ FOR THAT consequence class. Excluded (STILL analysed by Test A): indels (μ is SNV-only), chrX/Y (2·N assumes two autosomal copies; proband sex unknown), MODIFIER/non-coding (no coding μ), genes without μ, and genes lacking μ for the variant\'s own class (no modelable target → would inflate k without λ). Exact excluded counts print on the tab.')
        row('Cohort N', 'N = the Sample-QC trio count when a --sample-qc file is loaded (counts 0-DNM trios — the correct denominator). Without it, N falls back to distinct probands in the callset, which UNDERCOUNTS (omits 0-DNM trios) → λ too small → anti-conservative p; the tab then marks results PROVISIONAL and withholds the ✓.')
        row('Multiple testing & calibration', 'FDR q = Benjamini-Hochberg per dimension across the FULL a-priori (category × tier) grid — every library category with a modelable μ, including those with NO observed de novo (exact p=1). Correcting only across the categories that happened to be hit would let the data choose the family and push the true FDR far above nominal; the minCount display filter runs AFTER the correction, so hiding a row never changes a q. Family size m prints in each section header. ✓ = q<0.05 (withheld when N is provisional). A synonymous calibration control (observed vs 2·N·Σsyn.μ) is reported: ≈1 ⇒ complete ascertainment; a ratio a little above 1 is expected because LOW-impact over-counts true synonymous, and a provisional N inflates it further. Power comes largely from recurrence, so category singletons rarely survive FDR.')
        row('Two tabs', '"DNM Rate (gene-set)" tests gene-SET categories (the dimensions above). "DNM Rate (per-gene)" runs the same λ = 2·N·p Poisson at GENE level — one row per (gene, track) with an observed de novo SNV. There, nonsense+splice / missense / protein-altering are separate EXOME-WIDE discovery families (BH across all modelable genes, not just the observed ones) and synonymous is the calibrator, shown without a discovery q. Per-gene λ is tiny, so power comes from RECURRENCE (≥2 de novo in one gene).', 'gene-set + per-gene')
        row('References', 'Samocha et al. Nat Genet 2014;46:944 (framework + rate model); Ware et al. Curr Protoc Hum Genet 2015 (denovolyzeR); Karczewski et al. Nature 2020;581:434 & Chen et al. Nature 2024;625:92 (gnomAD rates); Benjamini & Hochberg JRSS-B 1995;57:289 (FDR).')
    }

    // --- Data sources & licensing ---
    section('Data sources & licensing')
    row('gnomAD', 'Gene constraint (pLI, LOEUF, missense Z), bundled offline from gnomAD v4 (GRCh38); live API fallback for GRCh37/hg19.', 'gnomad.broadinstitute.org', 'CC0 (attrib. requested)')
    row('ClinVar', 'Per-gene counts of Pathogenic and Likely-pathogenic variants (separately), plus VUS/conflicts, from the GRCh38 variant summary.', 'ncbi.nlm.nih.gov/clinvar', 'public domain')
    row('GenCC', 'Harmonised gene-disease validity + Mode of Inheritance (aggregates ClinGen, DDG2P, PanelApp, Orphanet). Bundled offline; highest validity + established-evidence MOIs per gene.', 'thegencc.org', 'CC0')
    // Bundled gene-set libraries (Gene Analysis convergence dimensions only).
    if (hasGene && exportCfg.sheets.geneAnalysis && exportCfg.geneAnalysis && exportCfg.geneAnalysis.enabled) {
        try {
            for (const lib of geneSets.available()) {
                const m = lib.meta || {}
                const ver = m.version ? ` (${m.version})` : ''
                row(lib.label, `${m.source || lib.id}${ver}. Gene Analysis convergence dimension (not a per-gene column). ${m.note || ''}`.trim(),
                    m.url || '', m.license || '')
            }
        } catch (_) { /* libraries optional */ }
    }
    // MitoCarta 3.0 — CC BY-NC, NOT redistributed: downloaded from the Broad at runtime
    // (download-if-missing). Powers 3 convergence dimensions AND the per-gene
    // "Mitochondrial (MitoCarta)" Gene Summary column. Absent when egress is blocked.
    try {
        for (const lib of mitocarta.available()) {
            const m = lib.meta || {}
            // Each MitoCarta dimension keeps its own universe, and the engine gates its
            // trials to match: localization asks "mito vs not" over the screened genome;
            // sub-loc/pathways ask a WITHIN-MITO question, so both their background and
            // their trials are the annotated mito genes. That is a different question,
            // not a weaker one — which is exactly why the universes must differ.
            const uni = lib.id === 'mitoLocalization'
                ? (m.geneCount ? ` Universe = the ${m.geneCount.toLocaleString()}-gene screened genome, so "% all genes" is a share of ALL screened genes (mito ≈ 6%) and only variants in a screened gene are counted.` : '')
                : (m.geneCount ? ` Universe = the ${m.geneCount.toLocaleString()} mito genes carrying this annotation, and the trials are gated to those genes too — so this asks a WITHIN-MITO question ("given a mitochondrial gene, is it of this class?"), conditional on being mitochondrial. It is NOT comparable to the localization dimension or to the genome-scale ones, and a ✓ here is a statement about specificity among mito genes, not about the genome.` : '')
            row(lib.label, `${m.source || lib.id}. Downloaded at runtime from the Broad (not redistributed — CC BY-NC). Convergence dimension${lib.id === 'mitoLocalization' ? ' + per-gene Gene Summary annotation' : ''}.${uni} ${m.citation || ''}`.trim(),
                m.url || '', m.license || '')
        }
    } catch (_) { /* MitoCarta optional (runtime download) */ }
    row('MyGene.info', 'Gene name, type, OMIM MIM number, KEGG pathways, function summary.', 'mygene.info', 'per source')
    row('Gene-list membership', 'Yes/No membership derived from user-supplied symbol lists. Used for licence-restricted sources (e.g. COSMIC): only membership is embedded, not the licensed content.', 'user-supplied', 'membership only')

    // --- Notes ---
    section('Notes')
    row('Impact counts', 'Only HIGH, MODERATE and LOW impacts are counted; MODIFIER and blank impacts are excluded.')
    row('Best-effort annotations', 'Live annotations (gnomAD, MyGene) may be blank if a fetch failed or timed out — the Annotation Status tab records failures. Bundled data (ClinVar, gene lists) are offline.')
    row('OMIM', 'Only the numeric MIM identifier is included; OMIM disease-title text is licence-restricted and is not embedded.')

    ws.autoFilter = {from: 'A1', to: {row: 1, column: 4}}
    ws.views = [{state: 'frozen', ySplit: 1}]
}

// The two Gene Analysis tabs — same category × pass-tier matrix, one per unit.
const GA_SAMPLE_TRACK = {sheetName: 'Gene Analysis (samples)', countKey: 'individuals', qKey: 'qSample', pKey: 'pSample',
    foldKey: 'foldSampleAll', unit: 'distinct PASS probands', unitShort: 'samples', testLabel: 'sample', conservative: true}
const GA_DNM_TRACK = {sheetName: 'Gene Analysis (DNMs)', countKey: 'variants', qKey: 'qDnm', pKey: 'pDnm',
    foldKey: 'foldDnmAll', unit: 'PASS DNMs', unitShort: 'DNMs', testLabel: 'DNM', conservative: false}

/**
 * "Gene Analysis (derivation)" — the reproducibility appendix for the SAMPLE test.
 *
 * The sample test is a Poisson-binomial: X = Σᵢ Bernoulli(pᵢ) over the at-risk probands,
 * where proband i with dᵢ pass DNMs hits a category gene by chance with pᵢ = 1−(1−p)^dᵢ.
 * Because pᵢ depends ONLY on dᵢ, the whole distribution is pinned down by the BURDEN
 * HISTOGRAM (how many probands carry each dᵢ) plus the category's prevalence p. Excel has
 * no Poisson-binomial function, so without this table the reported sample p/q could not be
 * reproduced by a reader at all. Publishing it makes every tier exactly reproducible, and
 * lets the samples tab derive "Expected Σpᵢ" live via SUMPRODUCT against these cells.
 *
 * @returns {{sheetName:string, byDim:Object<string,{firstRow:number, lastRow:number, dCol:number, tierCol:Object}>}|null}
 *          One ref block PER DIMENSION (keyed by dimension id) for the live formulas —
 *          each dimension's trials are gated to its own gene universe, so each has its
 *          own histogram. null when no dimension has any burden to report.
 */
function buildGaDerivationSheet(workbook, conv, styles, passCells) {
    const {headerFill, headerFont, borderThin} = styles
    // ONE BLOCK PER DIMENSION. Each dimension draws from its own gene universe U_d, so
    // its trials — and therefore its burden histogram — are its own. A single shared
    // histogram would reproduce nobody's p-value.
    const sections = (conv.sections || []).filter(s => s.available && s.burdenHistByTier)
    const anyBurden = sections.some(s => passCells.some(c => Object.keys(s.burdenHistByTier[c.tierKey] || {}).length))
    if (!anyBurden) return null                       // no pass variants anywhere — nothing to derive

    const ws = workbook.addWorksheet('Gene Analysis (derivation)')
    const nCols = 1 + passCells.length
    const tierShort = (c) => c.label.replace('pass·', '')
    let r = 0
    // Excel does NOT auto-fit merged wrapText rows, so an explicit height is required or
    // this sheet's prose (the reproduction recipe) renders clipped to a single line.
    const totalW = 44 + 20 * passCells.length          // must track the column widths set below
    const banner = (text, font) => {
        r++; const row = ws.addRow([text]); ws.mergeCells(r, 1, r, nCols)
        row.getCell(1).font = font; row.getCell(1).alignment = {wrapText: true, vertical: 'top'}
        const lines = Math.ceil(String(text).length / Math.max(20, totalW))
        row.height = Math.min(220, Math.max(font.size >= 14 ? 20 : 14, lines * (font.size >= 14 ? 19 : 13)))
    }
    banner('Gene Analysis (derivation) — reproducing the SAMPLE test p-values', {bold: true, size: 14, color: {argb: 'FF2C3E50'}})
    banner('The "Gene Analysis (samples)" p-values are a POISSON-BINOMIAL: X = Σᵢ Bernoulli(pᵢ) over the at-risk probands, where a proband carrying dᵢ IGV-pass variants hits a category gene by chance with pᵢ = 1−(1−p)^dᵢ  (p = that category\'s prevalence). Since pᵢ depends only on dᵢ, a per-tier proband BURDEN HISTOGRAM plus the per-tier denominators are the COMPLETE input: with a category\'s p they reproduce its exact p-value at every tier. Excel has no Poisson-binomial function, so the samples tab\'s "P(X≥k) approx" columns hold a binomial approximation; the EXACT values are the "p / q" columns, reproducible from this sheet.',
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    banner('ONE TABLE PER DIMENSION, and you must use the RIGHT one. Every dimension is scored against its OWN gene universe — the genes its source actually classifies (gnomAD scores constraint for ~17.5k genes; GenCC asserts on ~6.1k; MSigDB Hallmark annotates ~4.4k) — because the null asks "had this variant landed in a random gene THIS SOURCE COULD HAVE CLASSIFIED, how often would it be in this category?". So each dimension\'s trials (its dᵢ and its n) count only variants in that universe, and its burden histogram is its own. Reading a Reactome p-value against the GenCC table will not reproduce it. Find the block whose heading matches the dimension\'s section on the tab.',
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    banner('TO REPRODUCE a category\'s exact sample p-value at a tier: (1) take p from that category\'s "p (prev)" column on the samples tab — use THAT cell, not the "% all genes" column, which is a ROUNDED display string (0.014 prints as "1%"); equivalently p = "cat size" ÷ that dimension\'s section-header universe size, both printed exactly. (2) In THIS dimension\'s histogram block below, build the proband list — n_d copies of dᵢ = d for each row. (3) Map each to pᵢ = 1−(1−p)^dᵢ. (4) Compute P(X ≥ k) for the observed k (the tier\'s "k probands" column) under the Poisson-binomial. A standard exact method is the O(n·k) convolution: start dist=[1,0,…]; for each pᵢ update dist[j] = dist[j]·(1−pᵢ) + dist[j−1]·pᵢ for j = k−1…1 and dist[0] = dist[0]·(1−pᵢ); then P(X≥k) = 1 − Σ_{j<k} dist[j]. (Equivalently: R poisbinom::ppoisbinom, or Python scipy-based implementations.) "Expected Σpᵢ" = Σ_d n_d·[1−(1−p)^d] — the samples tab computes it live by SUMPRODUCT over this dimension\'s table.',
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    banner('NOTE on q: the "p / q" columns report Benjamini-Hochberg q per DIMENSION, over that dimension\'s (category × tier) tests. Reproducing a q needs the whole family, not just one row: the family size m is printed in each dimension\'s section header on the tabs. Only categories passing the ≥2-sample-or-gene keep-rule and with an observed count enter the family, and the tabs print only the top 25 categories per dimension — so if a dimension is capped, the p-values of the hidden rows are needed to re-derive q exactly. Every reported p-value, by contrast, is fully reproducible from this sheet.',
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    r++; ws.addRow([])

    const tierCol = {}
    passCells.forEach((c, i) => { tierCol[c.tierKey] = 2 + i })
    const byDim = {}

    // --- One block per dimension --------------------------------------------
    for (const sec of sections) {
        const hist = sec.burdenHistByTier || {}
        const nProbandsByTier = sec.nProbandsByTier || {}, nDnmsByTier = sec.nDnmsByTier || {}
        const ds = [...new Set(passCells.flatMap(c => Object.keys(hist[c.tierKey] || {}).map(Number)))].sort((a, b) => a - b)
        if (!ds.length) continue                      // no pass variant fell in this universe

        banner(`${sec.label} — trials drawn from this dimension's own universe of ${sec.sourceSize.toLocaleString()} genes`,
            {bold: true, size: 11, color: {argb: 'FF2C3E50'}})
        banner(`Counts below include ONLY variants in genes this source knows about${sec.nOutsideUniverse ? `; ${sec.nOutsideUniverse.toLocaleString()} pass variant${sec.nOutsideUniverse === 1 ? '' : 's'} in ${sec.nOutsideGenes.toLocaleString()} gene${sec.nOutsideGenes === 1 ? '' : 's'} fell outside it and are excluded from THIS dimension's test` : ''}. That is why the numbers differ between dimensions — each is the trial pool matching its own "% all genes".`,
            {italic: true, size: 9, color: {argb: 'FF6B7D8D'}})

        // Table 1: this dimension's per-tier denominators.
        r++; const t1 = ws.addRow(['Per-tier denominators', ...passCells.map(tierShort)])
        t1.eachCell(cell => { cell.fill = headerFill; cell.font = headerFont; cell.border = borderThin; cell.alignment = {horizontal: 'center', wrapText: true} })
        r++; const rowAt = ws.addRow(['n (at-risk probands, ≥1 pass variant in this universe)', ...passCells.map(c => nProbandsByTier[c.tierKey] || 0)])
        r++; const rowDn = ws.addRow(['n (pass variants in this universe)', ...passCells.map(c => nDnmsByTier[c.tierKey] || 0)])
        for (const row of [rowAt, rowDn]) row.eachCell(cell => { cell.border = borderThin; cell.alignment = {horizontal: 'center'} })
        rowAt.getCell(1).alignment = {horizontal: 'left'}; rowDn.getCell(1).alignment = {horizontal: 'left'}

        // Table 2: this dimension's burden histogram (the Poisson-binomial's full input).
        r++; const t2 = ws.addRow(['dᵢ = pass variants per proband', ...passCells.map(c => `# probands (${tierShort(c)})`)])
        t2.eachCell(cell => { cell.fill = headerFill; cell.font = headerFont; cell.border = borderThin; cell.alignment = {horizontal: 'center', wrapText: true} })
        t2.height = 26
        const firstRow = r + 1
        for (const d of ds) {
            r++
            const row = ws.addRow([d, ...passCells.map(c => (hist[c.tierKey] || {})[d] || 0)])
            row.eachCell(cell => { cell.border = borderThin; cell.alignment = {horizontal: 'center'} })
        }
        const lastRow = r
        // Cross-check row: the histogram must re-sum to the denominators above.
        r++
        const chk = ws.addRow(['Σ (cross-check: probands = n at-risk;  Σ dᵢ·n_d = n pass variants)',
            ...passCells.map((c, i) => {
                const col = colLetterOf(2 + i)
                return {formula: `SUM(${col}${firstRow}:${col}${lastRow})&" / "&SUMPRODUCT($A$${firstRow}:$A$${lastRow},${col}${firstRow}:${col}${lastRow})`,
                    result: `${nProbandsByTier[c.tierKey] || 0} / ${nDnmsByTier[c.tierKey] || 0}`}
            })])
        chk.eachCell(cell => { cell.border = borderThin; cell.font = {italic: true, size: 9, color: {argb: 'FF6B7D8D'}}; cell.alignment = {horizontal: 'center'} })
        chk.getCell(1).alignment = {horizontal: 'left'}
        r++; ws.addRow([])

        byDim[sec.id] = {firstRow, lastRow, dCol: 1, tierCol}
    }

    ws.getColumn(1).width = 48
    for (let i = 0; i < passCells.length; i++) ws.getColumn(2 + i).width = 20
    if (!Object.keys(byDim).length) return null
    return {sheetName: 'Gene Analysis (derivation)', byDim}
}

/** A1-style column letter (module-scope so the derivation sheet can use it too). */
function colLetterOf(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) } return s }

/**
 * Build one Gene Analysis tab: a category × pass-impact-tier matrix in ONE unit
 * (probands or DNMs). Each pass-tier cell = "count (FDR q)". `conv` is the output
 * of computeConvergence(); `track` is GA_SAMPLE_TRACK or GA_DNM_TRACK. Wrapped by
 * the caller in try/catch — must never break the export.
 * @param {Object|null} [derivRefs] ref block from buildGaDerivationSheet. Only meaningful
 *   for the conservative (samples) track; omitted for GA_DNM_TRACK and null when the
 *   derivation sheet could not be built — in which case "Expected Σpᵢ" degrades from a
 *   live SUMPRODUCT to the plain (asserted) number.
 */
function buildGeneAnalysisTab(workbook, conv, styles, track, derivRefs) {
    const {headerFill, headerFont, borderThin} = styles
    const ws = workbook.addWorksheet(track.sheetName)
    const passCells = conv.cells.filter(c => c.statusKey === 'pass')   // the 4 pass impact tiers, in order
    const totalProbands = conv.totalProbands || 0
    const probandsWithVariant = conv.probandsWithVariant || totalProbands
    const nPassDnms = conv.nPassDnms || 0
    // Columns: Category | 4 pass-tier "count (%) ✓" | all·ALL | # genes | cat size |
    // % all genes | Fold | 4 pass-tier "p / q" | derivation | Genes.
    // DERIVATION is per-tier so EVERY tier's p-value is reproducible from printed inputs
    // (not just pass·ALL): one shared "p (prev)" column, then 4 columns per tier
    // (k, n, Expected, P(X≥k)). Column count is deliberately traded for reproducibility.
    const base = 1 + passCells.length
    const ALLALL = base + 1, CG = base + 2, CAT = base + 3, PALL = base + 4, FOLD = base + 5
    const PQ0 = base + 6                          // first per-tier "p / q" column
    const DER0 = PQ0 + passCells.length          // derivation block: the shared "p (prev)"
    const DERW = 4                                // columns per tier: k, n, Expected, P(X≥k)
    const derCol = (tierIdx, j) => DER0 + 1 + tierIdx * DERW + j
    const nDeriv = 1 + passCells.length * DERW
    const GENES = DER0 + nDeriv
    const nCols = GENES

    // % base for the count cells: cohort probands (samples) or total pass DNMs (DNMs).
    const pctBase = track.conservative ? totalProbands : nPassDnms
    // (No cohort-wide per-tier n is bound here on purpose. Every test input is a
    // PER-DIMENSION quantity — sec.nDnmsByTier / sec.nProbandsByTier — because each
    // dimension's trials are gated to its own source's gene universe. conv.nDnmsByTier
    // is cohort-wide and descriptive; binding it here is what previously let the
    // banner print a denominator no row held and no p-value used.)

    // A1-style column reference (for the live Excel formulas below).
    const colLetter = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) } return s }
    // Derivation-cell number formats — conditional so a tiny value renders in scientific
    // notation instead of rounding to "0.0" (Excel: [<x]fmtA;fmtB → fmtA when value<x).
    const FMT_PVAL = '[<0.001]0.0E+00;0.000'     // P(X≥k): scientific when tiny, else 3 dp
    const FMT_PREV = '[<0.001]0.0E+00;0.0000'    // p (prevalence)
    const FMT_EXP = '[<0.05]0.0E+00;0.0'         // Expected count — never collapse to 0.0

    // "Expected Σpᵢ" derived LIVE from the published burden histogram:
    //   Σpᵢ = Σ_d n_d·[1−(1−p)^d]  ⇒  SUMPRODUCT(counts_d, 1-(1-p)^d)
    // so the cell shows its own derivation rather than an asserted number. Falls back to
    // the plain value when there is no derivation sheet to point at.
    // The block is chosen BY DIMENSION: each dimension's trials come from its own gene
    // universe, so pointing a row at another dimension's histogram would compute an
    // expectation that belongs to nobody. No block for this dimension ⇒ plain value.
    const sumProdExpected = (dimId, tierKey, pAddr, E) => {
        if (E == null) return '—'
        const ref = derivRefs && derivRefs.byDim && derivRefs.byDim[dimId]
        if (!ref || ref.tierCol[tierKey] == null) return E
        const q = `'${derivRefs.sheetName}'!`
        const dC = colLetter(ref.dCol), cC = colLetter(ref.tierCol[tierKey])
        const dR = `${q}$${dC}$${ref.firstRow}:$${dC}$${ref.lastRow}`
        const cR = `${q}$${cC}$${ref.firstRow}:$${cC}$${ref.lastRow}`
        return {formula: `SUMPRODUCT(${cR},1-(1-${pAddr})^${dR})`, result: E}
    }

    const fmtP = (p) => p == null ? '—' : (p < 0.001 ? p.toExponential(1) : p.toFixed(3))
    const pct = (x) => { if (x == null) return '—'; const v = x * 100; return `${v.toFixed(v < 0.1 ? 2 : (v < 1 ? 1 : 0))}%` }
    const fmtFold = (f) => f == null ? '—' : (f >= 10 ? `${Math.round(f)}×` : `${f.toFixed(1)}×`)
    const cnt = (cc) => (cc && cc[track.countKey]) || 0
    const isSig = (cc) => cc && cc[track.qKey] != null && cc[track.qKey] < 0.05
    // A pass-tier cell: "count (% of the base)" + a green ✓ when FDR q<0.05; blank for 0.
    const tierStr = (cc) => { const n = cnt(cc); if (!n) return ''; const p = pctBase > 0 ? pct(n / pctBase) : '—'; return isSig(cc) ? `${n} (${p}) ✓` : `${n} (${p})` }
    // The exact stats, off to the right: uncorrected p / FDR q for that tier.
    const pqStr = (cc) => { if (!cc) return '—'; const p = cc[track.pKey], q = cc[track.qKey]; return (p == null && q == null) ? '—' : `${fmtP(p)} / ${fmtP(q)}` }
    const MAX_GROUPS_PER_DIM = 25

    const mergeAcross = (rowIdx) => ws.mergeCells(rowIdx, 1, rowIdx, nCols)
    let r = 0
    const addBanner = (text, font) => { r++; const row = ws.addRow([text]); mergeAcross(r); row.getCell(1).font = font; row.getCell(1).alignment = {wrapText: true, vertical: 'top'}; return row }

    addBanner(`Gene Analysis — ${track.conservative ? 'SAMPLE' : 'DNM'} convergence (IGV-pass)`, {bold: true, size: 14, color: {argb: 'FF2C3E50'}})
    addBanner(`Rows = categories your genes converge on. The four pass columns are CUMULATIVE impact tiers (HIGH ⊆ HIGH+MOD ⊆ HIGH+MOD+LOW ⊆ ALL); each shows the # of ${track.unit} in a category gene and, in parens, their % of ${track.conservative ? `the ${totalProbands} cohort probands` : `the ${nPassDnms} pass DNMs`} (a share of the counted base — NOT the "% all genes" column, which is the genome background). A green "✓" marks a tier whose Benjamini-Hochberg FDR q<0.05 (its ${track.conservative ? 'conservative sample' : 'DNM'} test); the exact "p / q" per tier are in the columns to the right.${track.conservative ? '' : ' Each tier\'s p/q is computed against that tier\'s OWN pass-DNM total, not the ALL-tier total shown in the "(%)", so a non-ALL cell can be significant at a small displayed %.'} Only categories with ≥2 pass samples OR genes are listed.`,
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    addBanner(`"% all genes" = the category's share of ITS DIMENSION's gene universe (cat size ÷ the section-header universe size) — the chance rate. Each dimension is scored over the genes its own source classifies, and its trials count ONLY variants in those genes, so the chance rate and the trials describe the SAME gene set. The universes differ (gnomAD constraint ~17.5k and autosome-only; GenCC ~6.1k; Hallmark ~4.4k), so compare Fold WITHIN a dimension, not across dimensions. "Fold (pass·ALL)" = OBSERVED ÷ EXPECTED under the null — ${track.conservative ? `pass·ALL probands ÷ "Expected Σpᵢ (ALL)", the Poisson-binomial mean that already credits each proband with its OWN variant burden (cohort ${totalProbands} probands incl. 0-variant trios; ${probandsWithVariant} carry ≥1)` : `pass·ALL variants ÷ "Expected n·p (ALL)", where n is THIS dimension's GATED pass·ALL count — the row's own "n pass DNMs (ALL)" column, NOT the cohort's ${nPassDnms}, which counts variants in genes this dimension's source never classified`} — so 1× = exactly chance, and the Fold and the p/q on a row cannot disagree. "all·ALL" = ${track.unitShort} hitting the category at ANY curation status — a large gap vs pass·ALL flags a category drawn from a noisy (poor-quality) pool.`,
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    // Each dimension drops the variants its own source cannot classify. That is required
    // (they are not draws from that dimension's null) but it must never be silent — a
    // reader has to be able to tell whether a dimension saw their variant of interest.
    const dropped = (conv.sections || []).filter(s => s.available && s.nOutsideUniverse > 0)
    if (dropped.length) {
        addBanner(`GENES A DIMENSION CANNOT SEE: each dimension is scored only over the genes its own source classifies, and pass variants outside that set are excluded from THAT dimension's test (they still count on every other dimension whose source classifies the gene, and on the Variants / Gene Summary tabs). This is required rather than a convenience filter: a source that never classified a gene could not have placed it in any category, so counting it as a draw would inflate the trials against a chance rate it can never meet. Per dimension — ${dropped.map(s => `${s.label}: ${s.nOutsideUniverse.toLocaleString()} variant${s.nOutsideUniverse === 1 ? '' : 's'} in ${s.nOutsideGenes.toLocaleString()} gene${s.nOutsideGenes === 1 ? '' : 's'}${s.outsideGenesSample.length ? ` (${s.outsideGenesSample.slice(0, 8).join(', ')}${s.nOutsideGenes > 8 ? ', …' : ''})` : ''}`).join('  ·  ')}.`,
            {italic: true, size: 10, color: {argb: 'FFB9770E'}})
    }
    addBanner(`Green cues: a "✓" cell = FDR q<0.05 (its column has the p/q); a bold "Fold" = ≥5× AND backed by ≥2 ${track.unitShort} — a big Fold on a single ${track.unitShort} or a tiny cohort is deliberately left un-bolded, so read Fold with the cohort/count in mind. FDR is controlled WITHIN each dimension only — do not pool ✓ across dimensions.`,
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    addBanner(track.conservative
        ? 'The SAMPLE test is the conservative, robust read: its expected accounts for EACH proband\'s per-tier pass-DNM burden, so a single hypermutated proband can\'t fake convergence (it dedups to one sample AND is expected to hit). A category kept via ≥2 GENES can still show a ✓ on a count of 1 — that is ONE proband hitting ≥2 genes that share the term (within-proband gene convergence), not recurrence across samples; check the "# genes" column. A gene-count null only approximates the de-novo mutation-rate null, so treat marginal q gently. The companion "Gene Analysis (DNMs)" tab gives the variant-level view.'
        : 'The DNM test is a binomial over pass DNMs at each tier — LESS robust than the samples tab (a hypermutated proband inflates it; it is not deduped by proband). Enrichment is upper-tail only (depletion is not tested). Use "Gene Analysis (samples)" as the headline and this for the variant-level view.',
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    // Derivation columns (right of Genes' left neighbour): show the exact test inputs
    // for the pass·ALL tier + a LIVE Excel formula so the p-value is fully reproducible.
    // NOTE: n is a PER-DIMENSION quantity now (each dimension's trials are gated to its
    // own source's gene universe), so there is no single cohort n this banner could
    // honestly print. It used to print conv.nDnmsByTier / conv.nProbandsByTier — the
    // cohort-wide totals — which would now contradict the n on every row and, worse,
    // point a reader at the pre-fix denominator and hand them a vacuous p-value.
    addBanner(track.conservative
        ? 'Per-row DERIVATION — printed for EVERY tier (not just pass·ALL), so each tier\'s test is reproducible from this sheet. The SAMPLE test is a Poisson-binomial: each at-risk proband i with dᵢ pass variants hits a category gene by chance with pᵢ = 1−(1−p)^dᵢ (p = the shared "p (prev)" column = "% all genes" as a fraction). Per tier: "k probands" = probands observed hitting; "n at-risk" = probands with ≥1 pass variant at that tier IN THIS DIMENSION\'S GENE UNIVERSE; "Expected Σpᵢ" = Σ_d n_d·[1−(1−p)^d], shown as a LIVE SUMPRODUCT over that dimension\'s burden histogram on the "Gene Analysis (derivation)" sheet. n IS PER-DIMENSION — each dimension is scored only over the genes its own source classifies, so there is no single cohort n: use the row\'s own "n at-risk (T)" column and the derivation block matching that dimension. Excel has NO Poisson-binomial function, so "P(X≥k) approx" is a LIVE binomial approximation  =1−BINOMDIST(k−1, n, Expected/n, TRUE)  — by Hoeffding (1956) it is CONSERVATIVE (≥ the exact value) for k ≥ Expected+1; in the narrow band Expected < k < Expected+1 (notably k=1 rows on rare categories) it can run slightly BELOW the exact value. Either way it is NOT the reported number — it is labelled "approx". The EXACT Poisson-binomial is always the "p/q" column.'
        : 'Per-row DERIVATION — printed for EVERY tier (not just pass·ALL), so each tier\'s test is reproducible from this sheet. The DNM test is Binomial(n, p): each pass variant independently lands in a category gene with p = the shared "p (prev)" column ("% all genes" as a fraction). Per tier: "k DNMs" = that tier\'s category pass variants; "n pass DNMs" = that tier\'s pass variants INSIDE THIS DIMENSION\'S GENE UNIVERSE (tested against its own gated total — not the ALL-tier total, and not the cohort-wide total); "Expected n·p" = the chance mean (live). n IS PER-DIMENSION — each dimension is scored only over the genes its own source classifies, so there is no single cohort n: use the row\'s own "n pass DNMs (T)" column. "P(X≥k)" is a LIVE Excel formula  =1−BINOMDIST(k−1, n, p, TRUE)  that reproduces that tier\'s "p/q" p-value EXACTLY.',
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})

    // Headline: strongest pass·ALL convergence per dimension (in this unit).
    const headBits = []
    for (const sec of conv.sections) {
        if (!sec.groups.length) continue
        const n = cnt(sec.groups[0].cells['pass|ALL'])
        if (n >= 2) headBits.push(`${sec.label}: ${n} ${track.unitShort} share "${sec.groups[0].term}"`)
    }
    addBanner(headBits.length ? `Top pass convergence — ${headBits.join(';  ')}` : `No category has ≥2 pass ${track.unitShort} yet.`,
        {bold: true, size: 11, color: {argb: 'FF2C3E50'}})
    r++; ws.addRow([])   // spacer

    // Per-tier derivation headers. The tier suffix keeps every label UNIQUE — the sheet
    // is read by column NAME (by users and by our tests), so reusing "k (probands)"
    // across tiers would silently resolve to whichever tier came first.
    const derivHeaders = ['p (prev)']
    for (const c of passCells) {
        const t = c.label.replace('pass·', '')
        derivHeaders.push(
            track.conservative ? `k probands (${t})` : `k DNMs (${t})`,
            track.conservative ? `n at-risk (${t})` : `n pass DNMs (${t})`,
            track.conservative ? `Expected Σpᵢ (${t})` : `Expected n·p (${t})`,
            track.conservative ? `P(X≥k) approx (${t})` : `P(X≥k) (${t})`)
    }
    const headerLabels = ['Category', ...passCells.map(c => c.label), 'all·ALL', '# genes', 'cat size', '% all genes', 'Fold (pass·ALL)',
        ...passCells.map(c => `${c.label.replace('pass·', '')} p/q`), ...derivHeaders, 'Genes']
    r++
    const hdr = ws.addRow(headerLabels)
    hdr.eachCell(cell => { cell.fill = headerFill; cell.font = headerFont; cell.border = borderThin; cell.alignment = {vertical: 'middle', horizontal: 'center', wrapText: true} })
    hdr.height = 26
    const headerRowIdx = r
    ws.getColumn(1).width = 34
    for (let i = 0; i < passCells.length; i++) ws.getColumn(2 + i).width = 15
    ws.getColumn(ALLALL).width = 8; ws.getColumn(CG).width = 8; ws.getColumn(CAT).width = 8
    ws.getColumn(PALL).width = 11; ws.getColumn(FOLD).width = 12
    for (let i = 0; i < passCells.length; i++) ws.getColumn(PQ0 + i).width = 13
    for (let i = 0; i < nDeriv; i++) ws.getColumn(DER0 + i).width = 12
    ws.getColumn(GENES).width = 48

    let anyGroups = false
    for (const sec of conv.sections) {
        if (!sec.groups.length) continue
        anyGroups = true
        r++
        const hiddenCount = Math.max(0, sec.groups.length - MAX_GROUPS_PER_DIM)
        const shown = sec.groups.slice(0, MAX_GROUPS_PER_DIM)
        // THIS dimension's universe: the ÷ of "% all genes" AND the gate on its trials.
        // It differs between sections by design, so it is printed on every one.
        const srcNote = sec.sourceSize ? `  ·  universe = ${sec.sourceSize.toLocaleString()} genes (÷ for "% all genes"; trials gated to these genes)` : '  ·  NO BACKGROUND — not tested (no prevalence / p / q)'
        const capNote = hiddenCount ? `   (top ${shown.length} of ${sec.groups.length})` : ''
        // BH family size m for THIS dimension + track — q is a family-wide quantity, so
        // printing m is what lets a reader audit any q (see the derivation sheet's note).
        const m = track.conservative ? sec.mSample : sec.mDnm
        const mNote = m != null ? `  ·  BH family m=${m} (category × tier tests with a p-value)` : ''
        const secRow = ws.addRow([`${sec.label}${capNote}${srcNote}${mNote}`])
        mergeAcross(r)
        secRow.getCell(1).font = {bold: true, color: {argb: 'FF2C3E50'}}
        for (let c = 1; c <= nCols; c++) secRow.getCell(c).fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFD6EAF8'}}
        secRow.getCell(1).border = borderThin

        shown.forEach((g, idx) => {
            const rowNum = r + 1                                     // this row's 1-based index (for formula refs)
            const genesStr = g.genes.length > 16 ? g.genes.slice(0, 16).join(', ') + ` +${g.genes.length - 16}` : g.genes.join(', ')
            const rowVals = [g.term]
            for (const c of passCells) rowVals.push(tierStr(g.cells[c.key]))   // count (%) ✓
            rowVals.push(cnt(g.cells['all|ALL']) || '')              // all·ALL (quality flag)
            rowVals.push(g.refGenes)                                 // # genes (pass)
            rowVals.push(g.catSize != null ? g.catSize : '—')        // cat size
            rowVals.push(pct(g.prevalence))                          // % all genes
            rowVals.push(fmtFold(g[track.foldKey]))                  // Fold (pass·ALL)
            for (const c of passCells) rowVals.push(pqStr(g.cells[c.key]))   // p / q per tier (right)
            // Derivation, PER TIER: the exact inputs + LIVE Excel formulas, so every
            // tier's p-value is reproducible from what is printed — not just pass·ALL.
            if (g.prevalence == null) {
                for (let i = 0; i < nDeriv; i++) rowVals.push('—')
            } else {
                rowVals.push(g.prevalence)                          // shared p (prev)
                const pA = '$' + colLetter(DER0) + rowNum
                passCells.forEach((c, ti) => {
                    const cc = g.cells[c.key] || {}
                    const k = cnt(cc)
                    // n is THIS DIMENSION's gated trial count — the pool its p-value was
                    // actually computed against. The cohort-wide totals in the banner are
                    // larger; printing those here would make the row irreproducible.
                    const n = (track.conservative ? (sec.nProbandsByTier || {})[c.tierKey] : (sec.nDnmsByTier || {})[c.tierKey]) || 0
                    const kA = colLetter(derCol(ti, 0)) + rowNum, nA = colLetter(derCol(ti, 1)) + rowNum
                    const eA = colLetter(derCol(ti, 2)) + rowNum
                    rowVals.push(k, n)
                    if (track.conservative) {
                        // Expected Σpᵢ = Σ_d n_d·[1−(1−p)^d] — derived LIVE by SUMPRODUCT over
                        // this dimension's published burden histogram, not just asserted.
                        const E = cc.expSample
                        rowVals.push(sumProdExpected(sec.id, c.tierKey, pA, E))
                        // Excel has no Poisson-binomial ⇒ this is an explicit binomial
                        // APPROXIMATION (header says so). The exact value is the p/q column;
                        // reproduce it from the derivation sheet's histogram.
                        rowVals.push((n > 0 && E != null && k > 0)
                            ? {formula: `1-BINOMDIST(${kA}-1,${nA},${eA}/${nA},TRUE)`, result: binomUpperTail(k, n, E / n)}
                            : '—')
                    } else {
                        // result comes from the engine (cc.expDnm) so the sheet and the
                        // test share one source of truth; 0-prevalence rows fall back to 0.
                        rowVals.push({formula: `${nA}*${pA}`, result: cc.expDnm != null ? cc.expDnm : n * g.prevalence})
                        // Exact: reproduces this tier's "p/q" p-value to the last digit.
                        rowVals.push((k > 0 && n > 0)
                            ? {formula: `1-BINOMDIST(${kA}-1,${nA},${pA},TRUE)`, result: cc.pDnm}
                            : '—')
                    }
                })
            }
            rowVals.push(genesStr)
            r++
            const row = ws.addRow(rowVals)
            row.eachCell(cell => { cell.border = borderThin; if (idx % 2 === 1) cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFF8F9FA'}} })
            for (let i = 0; i < passCells.length; i++) row.getCell(2 + i).alignment = {horizontal: 'center'}
            for (const col of [ALLALL, CG, CAT, PALL, FOLD]) row.getCell(col).alignment = {horizontal: 'center'}
            for (let i = 0; i < passCells.length; i++) row.getCell(PQ0 + i).alignment = {horizontal: 'center'}
            for (let i = 0; i < nDeriv; i++) row.getCell(DER0 + i).alignment = {horizontal: 'center'}
            // Magnitude-preserving formats: switch to scientific for tiny values so a
            // small prevalence / expected count / p-value never collapses to "0.0".
            if (g.prevalence != null) {
                row.getCell(DER0).numFmt = FMT_PREV                                  // shared p (prev)
                passCells.forEach((c, ti) => {
                    row.getCell(derCol(ti, 2)).numFmt = FMT_EXP                      // Expected
                    row.getCell(derCol(ti, 3)).numFmt = FMT_PVAL                     // P(X≥k)
                })
            }
            passCells.forEach((c, i) => {
                if (!isSig(g.cells[c.key])) return
                row.getCell(2 + i).font = {bold: true, color: {argb: 'FF1E8449'}}      // green count cell
                row.getCell(PQ0 + i).font = {bold: true, color: {argb: 'FF1E8449'}}    // green p / q cell
            })
            // Bold-green Fold only when it's both large AND backed by ≥2 units — a
            // striking fold on a single unit / tiny cohort is left un-bolded.
            if (g[track.foldKey] != null && g[track.foldKey] >= 5 && cnt(g.cells['pass|ALL']) >= 2) row.getCell(FOLD).font = {bold: true, color: {argb: 'FF1E8449'}}
            if (cnt(g.cells['pass|ALL']) >= 2) row.getCell(1).font = {bold: true}
        })

        if (hiddenCount) {
            r++
            const noteRow = ws.addRow([`… ${hiddenCount} more categor${hiddenCount === 1 ? 'y' : 'ies'} not shown (overlapping categories with the same genes; ranked below the top ${MAX_GROUPS_PER_DIM}).`])
            mergeAcross(r)
            noteRow.getCell(1).font = {italic: true, size: 9, color: {argb: 'FF6B7D8D'}}
        }
    }

    if (!anyGroups) { r++; ws.addRow([`No convergence found — no category is shared by ≥2 IGV-pass ${track.unitShort} or genes in the current export.`]); mergeAcross(r) }

    ws.views = [{state: 'frozen', ySplit: headerRowIdx}]
}

/**
 * "DNM Rate (gene-set)" tab — the de novo mutation-rate enrichment (Test B).
 * Category × cumulative coding tier: observed k pass de novo SNVs vs a Poisson null
 * λ = 2·N·Σp, with a live =1-POISSON(k-1, λ, TRUE) derivation. Publication-grade:
 * the banner carries the full method, inputs, exclusions, and synonymous calibration.
 * `dnm` = computeModelEnrichment() output. Wrapped by the caller in try/catch.
 */
function buildDnmRateCategoryTab(workbook, dnm, styles) {
    const {headerFill, headerFont, borderThin} = styles
    const ws = workbook.addWorksheet('DNM Rate (gene-set)')
    const meta = dnm.meta, sections = dnm.perCategory.sections, tiers = dnm.perCategory.tiers
    const N = meta.N || 0, reliable = !!meta.nReliable
    const colLetter = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) } return s }
    const FMT_PVAL = '[<0.001]0.0E+00;0.000', FMT_MU = '0.00E+00', FMT_LAM = '[<0.05]0.0E+00;0.000'
    const fmtP = (p) => p == null ? '—' : (p < 0.001 ? p.toExponential(1) : p.toFixed(3))
    const fmtR = (x) => x == null ? '—' : x.toFixed(2)
    // ✓ = Poisson q<0.05, gated on a defensible N. λ = 2·N·Σp uses N directly (there is no
    // fitted scale for it to cancel against), so a provisional N really does shrink λ and
    // really does make the p anti-conservative — that gate is meaningful again.
    // The Poisson is CONSERVATIVE by construction here: a real cohort can only MISS de novo
    // variants, so E[k] = λ·f with f ≤ 1. Measured 0.81× of nominal at f=1 and lower as f
    // falls; curation skew cannot inflate it, because the synonymous count is not in λ.
    const poissonValid = reliable
    const isSig = (cc) => poissonValid && cc && cc.q != null && cc.q < 0.05
    const kStr = (cc) => { if (!cc || !cc.k) return ''; return isSig(cc) ? `${cc.k} ✓` : `${cc.k}` }
    const pqStr = (cc) => { if (!cc || cc.p == null) return '—'; return `${fmtP(cc.p)} / ${fmtP(cc.q)}` }
    // The scale-free companion, printed for every row but NEVER driving ✓. It answers a
    // different question — "is this category SKEWED toward damage relative to its own
    // synonymous variants?" — and it is the WEAKER of the two against the hazard that
    // actually threatens this data: because it compares damaging against synonymous, a
    // class-skewed curation pass rate moves θ and it over-rejects, while the Poisson merely
    // loses power. Its value is that it is immune to the rate table's absolute scale.
    const condStr = (cc) => { if (!cc || cc.pCond == null) return '—'; return `${fmtP(cc.pCond)} / ${fmtP(cc.qCond)}` }
    const MAX_GROUPS_PER_DIM = 25

    // Columns: Category | tier "k ✓" | # genes | # probands | tier "p/q" (Poisson) |
    //          tier "p/q" (scale-free) | k | k_syn | Σp | Σp_syn | θ | λ | P(X≥k) | Genes
    const T0 = 2, nT = tiers.length
    const CG = 1 + nT + 1, CP = CG + 1, PQ0 = CP + 1
    const CQ0 = PQ0 + nT                                   // scale-free p/q, one per tier
    const DK = CQ0 + nT, DKS = DK + 1, DMU = DKS + 1, DMUS = DMU + 1, DTH = DMUS + 1
    const DLAM = DTH + 1, DP = DLAM + 1, GENES = DP + 1
    const nCols = GENES
    const headTier = tiers[nT - 1]           // the broadest coding tier = the derivation worked example

    const mergeAcross = (r) => ws.mergeCells(r, 1, r, nCols)
    let r = 0
    const banner = (text, font) => { r++; const row = ws.addRow([text]); mergeAcross(r); row.getCell(1).font = font; row.getCell(1).alignment = {wrapText: true, vertical: 'top'}; return row }

    banner('Gene Analysis — DE NOVO MUTATION-RATE enrichment (Test B)', {bold: true, size: 14, color: {argb: 'FF2C3E50'}})
    banner(`This is the DE-NOVO-ONLY, mutation-rate test — distinct from the origin-agnostic "Gene Analysis (samples/DNMs)" tabs (Test A). Model: the # of de novo SNVs in a category is Poisson with mean λ = 2·N·Σp, N = ${N} trios (${reliable ? 'Sample-QC trio count, includes 0-DNM trios' : 'PROVISIONAL — no Sample-QC file, N is a lower bound'}), p = the per-gene per-transmission de novo rate (Samocha 2014 trinucleotide model, bundled from DeNovoWEST). NO scale is fitted to this cohort — see below for why, and for how to read the model-fit ratios. Classes: nonsense+essential-splice SNVs and missense; the two columns are CUMULATIVE PROTEIN-ALTERING tiers. Synonymous is the CALIBRATOR, never a discovery column. Each cell = # observed de novo SNVs; ✓ = Benjamini-Hochberg FDR q<0.05 (per dimension).`,
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    banner(`Derivation (worked for the ${headTier.label} tier): "k" = observed de novo SNVs; "Σp" = summed per-transmission rate over the category's autosomal genes (the same genes k is counted on); "λ = 2·N·Σp" = the chance expectation; "P(X≥k)" is a LIVE Excel formula  =1−POISSON(k−1, λ, TRUE)  that reproduces the "${headTier.label} p/q" value. p/q for every tier are in their own columns.`,
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    banner(`Observed: ${meta.nUsed} curation-pass de novo SNVs (${meta.byClass.nonSplice} nonsense+splice, ${meta.byClass.mis} missense, ${meta.byClass.syn} synonymous) across ${meta.nDistinctProbands} probands${meta.classifiedVia && meta.classifiedVia.impact > 0 ? `. CLASSIFIED BY IMPACT SEVERITY for ${meta.classifiedVia.impact} of them (no VEP Consequence column) — an approximation: VEP LOW is NOT synonymous, and the synonymous class is the model-fit diagnostic` : (meta.classifiedVia && meta.classifiedVia.consequence > 0 ? ', classified by VEP molecular consequence' : '')}. Excluded from Test B (still analysed by Test A): ${meta.exclIndel} indels, ${meta.exclXY} chrX/Y, ${meta.exclNonCoding} with no modelled consequence, ${meta.exclNoMu} genes with no rate (or non-autosomal), ${meta.exclNoClassMu} with no rate for the variant's own class. SNV-only and autosomal-only are REQUIRED: the rates are SNV-only, and 2·N counts two parental transmissions, which assumes two copies.`,
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    // The excluded consequences, named. This is not decoration: it is how a reader sees
    // WHAT the model declined to score — e.g. that splice_region/polypyrimidine calls are
    // not synonymous, which is exactly the contamination that would corrupt the model-fit
    // diagnostic if these were classified by IMPACT severity instead.
    const unmodelled = Object.entries(meta.unmodelledTerms || {}).sort((a, b) => b[1] - a[1])
    if (unmodelled.length) {
        banner(`Consequences seen but NOT modelled (no SNV rate term, so they enter neither k nor λ): ${unmodelled.slice(0, 12).map(([t, n]) => `${t} ×${n}`).join(', ')}${unmodelled.length > 12 ? `, … (+${unmodelled.length - 12} more terms)` : ''}. Note what is in this list: every splice_* term other than donor/acceptor (region, polypyrimidine tract, 5th base) is an INTRONIC modifier, not an essential-splice SNV, and none of them are synonymous — which is why classes are taken from the molecular consequence rather than from VEP's IMPACT severity.`,
            {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    }
    const cal = meta.calibration || {}
    banner(`MODEL FIT — the QC readout, and a REAL check (not a tautology). Observed vs expected under λ = 2·N·Σp, exome-wide, per class: synonymous ${cal.syn ? cal.syn.obs : 0} vs ${cal.syn && cal.syn.exp != null ? cal.syn.exp.toFixed(1) : '—'} = ${cal.syn ? fmtR(cal.syn.ratio) : '—'}${cal.synRelSe != null ? ` (±${(100 * cal.synRelSe).toFixed(0)}%)` : ''}  ·  missense ${cal.mis ? cal.mis.obs : 0} vs ${cal.mis && cal.mis.exp != null ? cal.mis.exp.toFixed(1) : '—'} = ${cal.mis ? fmtR(cal.mis.ratio) : '—'}  ·  nonsense+splice ${cal.nonSplice ? cal.nonSplice.obs : 0} vs ${cal.nonSplice && cal.nonSplice.exp != null ? cal.nonSplice.exp.toFixed(1) : '—'} = ${cal.nonSplice ? fmtR(cal.nonSplice.ratio) : '—'}. READ THE SYNONYMOUS ONE FIRST: it is ~selection-neutral, so it should sit near 1.0 and it measures how many de novo variants this cohort actually detects and curates. ≈1 ⇒ the rate model fits and the tests below have their full power. Well under 1 ⇒ you are seeing only that fraction of de novo variants, so every test below is CONSERVATIVE and correspondingly under-powered — not wrong, just quiet. Far ABOVE 1 ⇒ the rate model does not fit this data and nothing below should be trusted (this is the check that caught a 4.5× error in an earlier rate source).`,
        {bold: true, italic: true, size: 10, color: {argb: 'FF1F618D'}})
    banner(`NO SCALE IS FITTED to this cohort, deliberately. An empirical calibration (ê = observed_syn ÷ expected_syn, applied as λ = 2·N·Σp·ê) was built and REMOVED: measured, it made the test 1.4–3.0× too permissive on exactly the categories read first (its noise enters λ un-propagated, worse the larger the category), and it imported curation bias, since a reviewer who passes damaging variants more readily than synonymous ones shrinks every λ. Un-calibrated, λ can only be too LARGE — a cohort can miss de novo variants but cannot invent them — so the tests below are conservative under any ascertainment or curation regime. The price is power when the synonymous ratio is well below 1, and that is exactly what the ratio above tells you. Refs: Samocha 2014 Nat Genet 46:944 (model); Kaplanis & Samocha 2020 Nature 586:757 + DeNovoWEST, MIT (rates); Benjamini-Hochberg 1995; Benjamini-Yekutieli 2001 (FDR under the nested tiers' positive dependence).`,
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    banner(`CURATION — the assumption that matters most here, stated plainly. Every count above is a CURATION-PASS de novo variant. The tests ask whether damaging de novo exceed the mutation rate; they do NOT know why a variant was passed. If synonymous de novo are reviewed less often than damaging ones (this tool's own impact presets hide LOW from the common review filters, so the default workflow tends that way), the synonymous ratio above reads LOW while the damaging ratio does not — and the gap between the two class ratios is the honest measure of that skew. It does not invalidate the Poisson (λ never uses the synonymous count), but it does mean the synonymous ratio understates your true de novo detection.`,
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})

    if (!reliable) banner('⚠ PROVISIONAL N: no Sample-QC trio file, so N counts only probands carrying a variant and is a LOWER BOUND → λ is too small → the Poisson p/q are anti-conservative. They are printed but are NOT the basis of any ✓ here. The scale-free test does not use N at all (it cancels), so it is unaffected and carries the ✓ instead. Load a --sample-qc file to get a defensible N and the rate-based test back.',
        {bold: true, italic: true, size: 10, color: {argb: 'FFB03A2E'}})
    r++; ws.addRow([])

    const headers = ['Category', ...tiers.map(t => t.label), '# genes', '# probands',
        ...tiers.map(t => `${t.label} p/q`),
        ...tiers.map(t => `${t.label} p/q (scale-free)`),
        `k (${headTier.label})`, 'k syn', 'Σp', 'Σp syn', 'θ', 'λ = 2·N·Σp', 'P(X≥k)', 'Genes']
    r++
    const hdr = ws.addRow(headers)
    hdr.eachCell(c => { c.fill = headerFill; c.font = headerFont; c.border = borderThin; c.alignment = {vertical: 'middle', horizontal: 'center', wrapText: true} })
    hdr.height = 26
    const headerRowIdx = r
    ws.getColumn(1).width = 34
    for (let i = 0; i < nT; i++) ws.getColumn(T0 + i).width = 13
    ws.getColumn(CG).width = 8; ws.getColumn(CP).width = 10
    for (let i = 0; i < nT; i++) ws.getColumn(PQ0 + i).width = 14
    for (let i = 0; i < nT; i++) ws.getColumn(CQ0 + i).width = 16
    ws.getColumn(DK).width = 8; ws.getColumn(DKS).width = 8; ws.getColumn(DMU).width = 11
    ws.getColumn(DMUS).width = 11; ws.getColumn(DTH).width = 8
    ws.getColumn(DLAM).width = 11; ws.getColumn(DP).width = 11
    ws.getColumn(GENES).width = 48

    let any = false
    for (const sec of sections) {
        if (!sec.groups.length) continue
        any = true
        r++
        const hidden = Math.max(0, sec.groups.length - MAX_GROUPS_PER_DIM)
        const shown = sec.groups.slice(0, MAX_GROUPS_PER_DIM)
        const note = sec.muSource ? '' : '  ·  no de novo rate for this dimension\'s genes'
        // BH family m — every (category × tier) cell with a λ, including the no-hit cells
        // and the categories the minCount rule hides. q is family-wide; print m so it can
        // be audited from a single row.
        const mNote = sec.m != null ? `  ·  BH family m=${sec.m} (category × tier cells with a λ${sec.nCategories != null ? `, over ${sec.nCategories} categories tested` : ''})` : ''
        const secRow = ws.addRow([`${sec.label}${hidden ? `   (top ${shown.length} of ${sec.groups.length})` : ''}${note}${mNote}`])
        mergeAcross(r)
        secRow.getCell(1).font = {bold: true, color: {argb: 'FF2C3E50'}}
        for (let c = 1; c <= nCols; c++) secRow.getCell(c).fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFEBDEF0'}}

        shown.forEach((g, idx) => {
            const rowNum = r + 1
            const hc = g.cells[headTier.key]
            const genesStr = g.genes.length > 16 ? g.genes.slice(0, 16).join(', ') + ` +${g.genes.length - 16}` : g.genes.join(', ')
            const vals = [g.term]
            for (const t of tiers) vals.push(kStr(g.cells[t.key]))
            vals.push(g.genes.length, g.probands)
            for (const t of tiers) vals.push(pqStr(g.cells[t.key]))
            for (const t of tiers) vals.push(condStr(g.cells[t.key]))
            // derivation (headTier), with live Excel formulas
            const kA = colLetter(DK) + rowNum, muA = colLetter(DMU) + rowNum, lamA = colLetter(DLAM) + rowNum
            const muSA = colLetter(DMUS) + rowNum
            vals.push(hc.k, hc.kSyn, hc.catMu, hc.catMuSyn)
            // θ = Σp / (Σp + Σp_syn) — live, so a reader can see that 2·N is simply not in
            // it. That absence IS the scale-free property, not a claim about it.
            vals.push(hc.theta != null ? {formula: `${muA}/(${muA}+${muSA})`, result: hc.theta} : '—')
            // λ = 2·N·Σp exactly — no fitted scale, so the formula IS the model.
            vals.push(hc.lambda != null ? {formula: `2*${N}*${muA}`, result: hc.lambda} : '—')
            vals.push((hc.k > 0 && hc.lambda != null)
                ? {formula: `1-POISSON(${kA}-1,${lamA},TRUE)`, result: hc.p}
                : '—')
            vals.push(genesStr)
            r++
            const row = ws.addRow(vals)
            row.eachCell(c => { c.border = borderThin; if (idx % 2 === 1) c.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFF8F9FA'}} })
            for (let i = 0; i < nT; i++) row.getCell(T0 + i).alignment = {horizontal: 'center'}
            for (const c of [CG, CP, DK, DKS, DMU, DMUS, DTH, DLAM, DP]) row.getCell(c).alignment = {horizontal: 'center'}
            for (let i = 0; i < nT; i++) { row.getCell(PQ0 + i).alignment = {horizontal: 'center'}; row.getCell(CQ0 + i).alignment = {horizontal: 'center'} }
            row.getCell(DMU).numFmt = FMT_MU; row.getCell(DMUS).numFmt = FMT_MU
            row.getCell(DTH).numFmt = '0.0000'
            row.getCell(DLAM).numFmt = FMT_LAM; row.getCell(DP).numFmt = FMT_PVAL
            tiers.forEach((t, i) => { if (isSig(g.cells[t.key])) { row.getCell(T0 + i).font = {bold: true, color: {argb: 'FF6C3483'}}; row.getCell(PQ0 + i).font = {bold: true, color: {argb: 'FF6C3483'}} } })
            if (hc.k >= 2) row.getCell(1).font = {bold: true}
        })
        if (hidden) { r++; const nr = ws.addRow([`… ${hidden} more categor${hidden === 1 ? 'y' : 'ies'} not shown (ranked below the top ${MAX_GROUPS_PER_DIM} by p-value).`]); mergeAcross(r); nr.getCell(1).font = {italic: true, size: 9, color: {argb: 'FF6B7D8D'}} }
    }
    if (!any) { r++; ws.addRow(['No category has an observed de novo SNV with a gnomAD mutation rate in the current export.']); mergeAcross(r) }
    ws.views = [{state: 'frozen', ySplit: headerRowIdx}]
}

/**
 * "DNM Rate (per-gene)" tab — the de novo mutation-rate enrichment at GENE level.
 * One row per (gene, track) with an observed de novo SNV: k vs Poisson λ = 2·N·p,
 * live =1-POISSON(k-1, λ, TRUE). LoF / missense / protein-altering are separate BH
 * discovery families; synonymous is the calibration control (no discovery q). `dnm` =
 * computeModelEnrichment() output (needs dnm.perGene). Wrapped by the caller in try/catch.
 */
function buildDnmRatePerGeneTab(workbook, dnm, styles) {
    const {headerFill, headerFont, borderThin} = styles
    const ws = workbook.addWorksheet('DNM Rate (per-gene)')
    const meta = dnm.meta, pg = dnm.perGene, N = meta.N || 0, reliable = !!meta.nReliable
    const colLetter = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) } return s }
    const FMT_PVAL = '[<0.001]0.0E+00;0.000', FMT_MU = '0.00E+00', FMT_LAM = '[<0.05]0.0E+00;0.000'
    const isSig = (row) => reliable && row.discovery && row.q != null && row.q < 0.05   // ✓ withheld when provisional
    const MAX_PER_TRACK = 100

    const G = 1, K = 2, MU = 3, LAM = 4, P = 5, Q = 6, LOEUF = 7, PLI = 8, CONS = 9, nCols = 9
    const mergeAcross = (rr) => ws.mergeCells(rr, 1, rr, nCols)
    let r = 0
    const banner = (text, font) => { r++; const row = ws.addRow([text]); mergeAcross(r); row.getCell(1).font = font; row.getCell(1).alignment = {wrapText: true, vertical: 'top'}; return row }

    banner('Gene Analysis — DE NOVO MUTATION-RATE enrichment, PER GENE (Test B)', {bold: true, size: 14, color: {argb: 'FF2C3E50'}})
    banner(`Per-gene view of the same test as "DNM Rate (gene-set)". One row per (gene, track) with an observed curation-pass de novo SNV: k ~ Poisson(λ = 2·N·p), N = ${N} trios${reliable ? '' : ' (PROVISIONAL — no Sample-QC file)'}, p = the gene's per-transmission de novo rate for that track's classes (Samocha 2014 model, bundled from DeNovoWEST). No scale is fitted. The LOEUF / pLI columns are the SECOND axis: λ says how SURPRISING the count is (a big, mutable gene expects more by chance), constraint says whether a real variant there would MATTER. They answer different questions and are deliberately not merged — read them together. "P(X≥k)" is a LIVE Excel formula reproducing the q's p-value.`,
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    banner(`Per-gene λ is tiny, so a single de novo hit rarely survives FDR — power comes from RECURRENCE (≥2 de novos in one gene). The scan is EXOME-WIDE, so each discovery family m counts EVERY autosomal gene with a modelable μ for that track — not just the genes that happened to carry a de novo. A gene with no de novo has the exact p = P(X≥0) = 1 and can never be rejected, but it is still one of the hypotheses the scan asked; correcting only across observed genes would let the data pick the family and put the true FDR far above the nominal 5%. Only genes with k≥1 are listed below (the rest are all p=1). Discovery family m (autosomal genes scanned) — LoF ${pg.familySizes.lof || 0}, missense ${pg.familySizes.mis || 0}, protein-altering ${pg.familySizes.protein_altering || 0}; rows shown with an observed de novo — ${(pg.observedRows && pg.observedRows.lof) || 0} / ${(pg.observedRows && pg.observedRows.mis) || 0} / ${(pg.observedRows && pg.observedRows.protein_altering) || 0}.`,
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    // The scale-free test is deliberately NOT offered here. It is not an oversight and it
    // is not laziness: it is measurably vacuous at gene level, and shipping it would invite
    // a reader to trust a number that carries no information about the gene.
    banner(`WHY THERE IS NO "scale-free" COLUMN HERE (there is one on the gene-set tab): that test conditions on a row's OWN total T = k + k_syn, which needs the row to actually contain synonymous de novo variants. A gene does not. At N=${N} the AVERAGE gene expects ${meta.rateGenes > 0 ? (2 * N * meta.totalP.syn / meta.rateGenes).toFixed(4) : '≈0.004'} synonymous de novo variants (2·N·Σp_syn ÷ ${meta.rateGenes ? meta.rateGenes.toLocaleString() : '~18.5k'} genes) — well under a 1% chance of even one — so T = k almost always, and the test collapses to p = θ^k. That uses NOTHING about the gene's mutational target size: a huge gene and a tiny one, each with 2 nonsense de novo, would receive an IDENTICAL p-value. Gene size is precisely the information that makes a per-gene rate test meaningful, so the Poisson λ = 2·N·p·ê is the only test offered at this level. A gene set aggregates hundreds of genes, so its synonymous count is real and the scale-free test is informative there.`,
        {italic: true, size: 10, color: {argb: 'FF6B7D8D'}})
    if (!reliable) banner('⚠ PROVISIONAL N: no Sample-QC trio file → N is a lower bound → λ too small → anti-conservative p; ✓ withheld. (Unlike the gene-set tab, there is no scale-free fallback at gene level — see the note above.)', {bold: true, italic: true, size: 10, color: {argb: 'FFB03A2E'}})
    r++; ws.addRow([])

    const headers = ['Gene', 'k (de novo SNVs)', 'p (rate)', 'λ = 2·N·p', 'P(X≥k)', 'q', 'LOEUF', 'pLI', 'Constrained?']
    r++
    const hdr = ws.addRow(headers)
    hdr.eachCell(c => { c.fill = headerFill; c.font = headerFont; c.border = borderThin; c.alignment = {vertical: 'middle', horizontal: 'center', wrapText: true} })
    hdr.height = 26
    const headerRowIdx = r
    ws.getColumn(G).width = 20; ws.getColumn(K).width = 15; ws.getColumn(MU).width = 12
    ws.getColumn(LAM).width = 12; ws.getColumn(P).width = 12; ws.getColumn(Q).width = 12

    let any = false
    for (const tr of pg.tracks) {
        const rows = pg.rows.filter(x => x.track === tr.key)
        if (!rows.length) continue
        any = true
        r++
        const shown = rows.slice(0, MAX_PER_TRACK)
        // m is the EXOME-WIDE family actually corrected for (every autosomal gene with a
        // μ for this track) — not rows.length, which is only the genes with an observed
        // de novo. Printing rows.length here would contradict the q's in the sheet.
        const mFam = (pg.familySizes && pg.familySizes[tr.key]) || rows.length
        const note = tr.discovery
            ? `discovery family — Benjamini-Hochberg over ${mFam.toLocaleString()} autosomal gene${mFam === 1 ? '' : 's'} scanned (${rows.length} with an observed de novo; the rest are p=1)`
            : 'CALIBRATION control — no discovery q'
        const secRow = ws.addRow([`${tr.label}   ·   ${note}${rows.length > MAX_PER_TRACK ? `   (top ${MAX_PER_TRACK} of ${rows.length})` : ''}`])
        mergeAcross(r)
        secRow.getCell(1).font = {bold: true, color: {argb: 'FF2C3E50'}}
        for (let c = 1; c <= nCols; c++) secRow.getCell(c).fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFEBDEF0'}}

        shown.forEach((row, idx) => {
            const rowNum = r + 1
            const muA = colLetter(MU) + rowNum, kA = colLetter(K) + rowNum, lamA = colLetter(LAM) + rowNum
            // The SECOND axis, beside the rate. Surprise (λ, p) says a de novo here is
            // unexpected; constraint says a real one would MATTER. They are independent
            // questions and are deliberately NOT merged into one score — merging them
            // would hide which of the two is carrying a row.
            const con = row.constraint || {}
            const vals = [isSig(row) ? `${row.gene} ✓` : row.gene, row.k, row.mu,
                {formula: `2*${N}*${muA}`, result: row.lambda},
                (row.k > 0 && row.lambda != null) ? {formula: `1-POISSON(${kA}-1,${lamA},TRUE)`, result: row.p} : '—',
                tr.discovery ? (row.q == null ? '—' : row.q) : 'cal',
                con.loeuf != null ? con.loeuf : '—',
                con.pli != null ? con.pli : '—',
                con.loeuf == null && con.pli == null ? '—'
                    : ((con.loeuf != null && con.loeuf < 0.35) || (con.pli != null && con.pli >= 0.9) ? 'Yes' : 'No')]
            r++
            const xr = ws.addRow(vals)
            xr.eachCell(c => { c.border = borderThin; if (idx % 2 === 1) c.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFF8F9FA'}} })
            for (const c of [K, MU, LAM, P, Q, LOEUF, PLI, CONS]) xr.getCell(c).alignment = {horizontal: 'center'}
            if (typeof vals[LOEUF - 1] === 'number') xr.getCell(LOEUF).numFmt = '0.00'
            if (typeof vals[PLI - 1] === 'number') xr.getCell(PLI).numFmt = '0.00'
            xr.getCell(MU).numFmt = FMT_MU; xr.getCell(LAM).numFmt = FMT_LAM; xr.getCell(P).numFmt = FMT_PVAL
            if (tr.discovery && typeof vals[Q - 1] === 'number') xr.getCell(Q).numFmt = FMT_PVAL
            if (isSig(row)) { xr.getCell(G).font = {bold: true, color: {argb: 'FF6C3483'}}; xr.getCell(Q).font = {bold: true, color: {argb: 'FF6C3483'}} }
        })
    }
    if (!any) { r++; ws.addRow(['No gene has an observed de novo SNV with a per-gene de novo rate in the current export.']); mergeAcross(r) }
    ws.views = [{state: 'frozen', ySplit: headerRowIdx}]
}

// -------------------------------------------------------------------------
// XLSX Export – publication-quality workbook with variant data and optional
// IGV screenshots on per-variant tabs, linked from the main sheet.
// -------------------------------------------------------------------------
app.use('/api/export/xlsx', express.json({limit: '200mb'}))

app.post('/api/export/xlsx', async (req, res) => {
    try {
        const {variantIds, screenshots, lollipopPlots, filters: clientFilters, exportConfig: clientExportConfig} = req.body || {}
        const exportCfg = mergeWithDefaults(clientExportConfig || {genomeBuild: GENOME})
        const annotationErrors = []  // Track annotation fetch failures
        const exportErrors = []      // Track all non-fatal errors encountered during export
        const IMAGE_EMBED_RETRIES = 2  // Number of attempts for image embedding

        // Determine which variants to include
        let filtered
        if (Array.isArray(variantIds) && variantIds.length > 0) {
            filtered = variants.filter(v => variantIds.includes(v.id))
        } else {
            filtered = applyFilters(req.query)
        }

        if (filtered.length === 0) {
            return res.status(400).json({error: 'No variants to export'})
        }

        const workbook = new ExcelJS.Workbook()
        workbook.creator = 'IGV Variant Review'
        workbook.created = new Date()

        // --- Styles ---------------------------------------------------------
        const headerFill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FF2C3E50'}}
        const headerFont = {bold: true, color: {argb: 'FFFFFFFF'}, size: 11}
        const borderThin = {
            top: {style: 'thin', color: {argb: 'FFD5D8DC'}},
            bottom: {style: 'thin', color: {argb: 'FFD5D8DC'}},
            left: {style: 'thin', color: {argb: 'FFD5D8DC'}},
            right: {style: 'thin', color: {argb: 'FFD5D8DC'}}
        }
        const statusColors = {
            pass: 'FF27AE60',
            fail: 'FFE74C3C',
            uncertain: 'FFF39C12',
            pending: 'FF95A5A6'
        }
        const statusRowFills = {
            pass: {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFD5F5E3'}},
            fail: {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFFADBD8'}},
            uncertain: {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFFDEBD0'}},
            pending: null
        }

        // MitoCarta (CC BY-NC, runtime download) must be resolved BEFORE Read Me,
        // Gene Summary, and Gene Analysis so all three observe ONE consistent
        // availability snapshot. Otherwise a cold-cache first export (before the startup
        // prefetch completes) could ship the mito convergence dimensions while the Read Me
        // CC BY-NC attribution rows and the Gene Summary mito column are missing — an
        // attribution gap for a non-commercial source plus an inconsistent workbook.
        {
            const gaC = exportCfg.geneAnalysis || {}
            const wantMito = (exportCfg.geneAnnotations && exportCfg.geneAnnotations.mitocarta !== false) ||
                (gaC.enabled && ['mitoLocalization', 'mitoSubLocalization', 'mitoPathways'].some(k => gaC[k] !== false))
            if (headerColumns.includes('gene') && wantMito) {
                try { await mitocarta.ensureData() } catch (mErr) { log.warn('MitoCarta ensureData:', mErr.message) }
            }
        }

        // --- "Read Me" data-dictionary worksheet (first tab) ----------------
        if (exportCfg.sheets.dataDictionary !== false) {
            try {
                buildReadmeSheet(workbook, {
                    exportCfg, headerFill, headerFont, borderThin,
                    genome: exportCfg.genomeBuild || GENOME,
                    hasGene: headerColumns.includes('gene'),
                    hasImpact: headerColumns.includes('impact'),
                    hasSampleQc: Array.isArray(sampleQcData) && sampleQcData.length > 0,
                    hasScreenshots: screenshots && typeof screenshots === 'object' && Object.keys(screenshots).length > 0,
                    hasLollipop: lollipopPlots && typeof lollipopPlots === 'object' && Object.keys(lollipopPlots).length > 0
                })
            } catch (sectionErr) {
                log.warn('Read Me worksheet failed:', sectionErr.message)
                exportErrors.push({section: 'Read Me', error: sectionErr.message})
            }
        }

        // --- Main "Variants" worksheet --------------------------------------
        const exportCols = [...headerColumns, 'curation_status', 'curation_note']
        const uniqueCols = filterColumns([...new Set(exportCols)], exportCfg.variantColumns)

        // If screenshots are present, prepend a "Screenshot" link column
        const hasScreenshots = screenshots && typeof screenshots === 'object' && Object.keys(screenshots).length > 0
        const mainCols = hasScreenshots ? ['Screenshot', ...uniqueCols] : [...uniqueCols]

        // Pre-compute gene→lollipop sheet name map for hyperlinks
        const hasLollipopPlots = lollipopPlots && typeof lollipopPlots === 'object' && Object.keys(lollipopPlots).length > 0
        const geneCol = headerColumns.includes('gene') ? 'gene' : null
        const geneLpSheetNames = new Map()
        if (hasLollipopPlots && geneCol) {
            for (const gene of Object.keys(lollipopPlots)) {
                if (lollipopPlots[gene] && typeof lollipopPlots[gene] === 'string' && lollipopPlots[gene].length <= 10 * 1024 * 1024) {
                    geneLpSheetNames.set(gene, `LP ${gene}`.substring(0, 31))
                }
            }
        }

        // Per-variant species/contamination metrics (only when --bed-tracks are
        // configured and the variant has informative reads).
        const contamOn = !!(exportCfg.contamination && exportCfg.contamination.enabled)
        const speciesByVariant = new Map()
        let hasSpecies = false
        if (contamOn) {
            for (const v of filtered) {
                try {
                    const m = getVariantSpeciesMetrics(v)
                    if (m) { speciesByVariant.set(v.id, m); hasSpecies = true }
                } catch (_) { /* skip this variant's metrics */ }
            }
        }
        const CONTAM_COLS = [
            {header: 'Contamination', key: '_contamAssess', width: 13},
            {header: 'Nonhuman %', key: '_contamNonhuman', width: 12},
            {header: 'Contam Reads', key: '_contamTotalReads', width: 12},
            {header: 'Nonhuman Reads', key: '_contamNonhumanReads', width: 14},
            {header: 'Top Taxa', key: '_contamTopTaxa', width: 32}
        ]

        const ws = workbook.addWorksheet('Variants', {
            views: [{state: 'frozen', ySplit: 1}]
        })

        // Column definitions (+ contamination columns when species data exists)
        const dataColDefs = mainCols.map(col => ({
            header: col.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            key: col,
            width: col === 'curation_note' ? 30 : col === 'Screenshot' ? 14 : Math.max(12, col.length + 4)
        }))
        ws.columns = hasSpecies ? [...dataColDefs, ...CONTAM_COLS] : dataColDefs

        // Style the header row
        const headerRow = ws.getRow(1)
        headerRow.eachCell(cell => {
            cell.fill = headerFill
            cell.font = headerFont
            cell.border = borderThin
            cell.alignment = {vertical: 'middle', horizontal: 'center'}
        })
        headerRow.height = 24

        // Build safe sheet-name lookup for screenshot sheets
        const sheetNames = new Map()
        let screenshotIdx = 0

        // Data rows
        filtered.forEach((v, rowIdx) => {
            const row = {}
            for (const col of uniqueCols) {
                row[col] = v[col] ?? ''
            }

            // Create screenshot sheet name using short numeric index
            if (hasScreenshots && screenshots[String(v.id)]) {
                screenshotIdx++
                const sheetName = String(screenshotIdx)
                sheetNames.set(sheetName, v.id)
                row['Screenshot'] = sheetName
            } else if (hasScreenshots) {
                row['Screenshot'] = ''
            }

            // Contamination / species metrics columns
            if (hasSpecies) {
                const m = speciesByVariant.get(v.id)
                if (m) {
                    row._contamAssess = m.assessment ? m.assessment.label : ''
                    row._contamNonhuman = `${(m.nonhumanFraction * 100).toFixed(1)}%`
                    row._contamTotalReads = m.totalReads
                    row._contamNonhumanReads = m.nonhumanReads
                    row._contamTopTaxa = (m.topTaxa || []).slice(0, 3).map(t => `${t.name} (${t.count})`).join('; ')
                }
            }

            const dataRow = ws.addRow(row)
            const excelRowNum = rowIdx + 2  // 1-based, row 1 is header

            // Determine row fill based on curation status
            const rowFill = statusRowFills[v.curation_status] || null

            // Style data cells
            dataRow.eachCell((cell, colNumber) => {
                cell.border = borderThin
                cell.alignment = {vertical: 'middle', wrapText: mainCols[colNumber - 1] === 'curation_note'}

                // Color entire row by curation status; fall back to alternate shading
                if (rowFill) {
                    cell.fill = rowFill
                } else if (rowIdx % 2 === 1) {
                    cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFF8F9FA'}}
                }
            })

            // Bold the curation status cell text
            const statusColIdx = mainCols.indexOf('curation_status') + 1
            if (statusColIdx > 0) {
                const statusCell = dataRow.getCell(statusColIdx)
                const color = statusColors[v.curation_status] || statusColors.pending
                statusCell.font = {bold: true, color: {argb: color}}
            }

            // Add hyperlink from Screenshot column to the screenshot sheet
            if (hasScreenshots && screenshots[String(v.id)] && row['Screenshot']) {
                const linkCell = dataRow.getCell(1)  // Screenshot is first column
                linkCell.value = {
                    text: '📷 View',
                    hyperlink: `#'${row['Screenshot']}'!A1`
                }
                linkCell.font = {color: {argb: 'FF2980B9'}, underline: true}
            }

            // Add hyperlink from gene column to the lollipop plot sheet
            if (geneCol && v[geneCol] && geneLpSheetNames.has(v[geneCol])) {
                const geneColIdx = mainCols.indexOf(geneCol) + 1
                if (geneColIdx > 0) {
                    const geneCell = dataRow.getCell(geneColIdx)
                    const lpSheetName = geneLpSheetNames.get(v[geneCol])
                    geneCell.value = {
                        text: v[geneCol],
                        hyperlink: `#'${lpSheetName}'!A1`
                    }
                    geneCell.font = {color: {argb: 'FF2980B9'}, underline: true}
                }
            }
        })

        // Auto-filter on the main sheet
        if (filtered.length > 0) {
            ws.autoFilter = {from: 'A1', to: {row: 1, column: mainCols.length}}
        }

        // --- Gene annotations (fetched once, shared by Gene Summary + Gene Analysis) --
        const xlsSampleCol = ['sample_id', 'trio_id'].find(c => headerColumns.includes(c)) || null
        const gaCfg = exportCfg.geneAnalysis || {}
        const gaOn = !!(geneCol && exportCfg.sheets.geneAnalysis && gaCfg.enabled)
        let geneAnnotations = new Map()
        let providerByGene = new Map()   // gene -> {[providerId]: obj|null}
        if (geneCol && (exportCfg.sheets.geneSummary || gaOn) && exportCfg.geneAnnotations.enabled) {
            const geneNames = [...new Set(filtered.map(v => v[geneCol]).filter(Boolean))]
            if (geneNames.length > 0) {
                const ga = exportCfg.geneAnnotations
                // Hit MyGene if a MyGene column is requested, or Gene Analysis needs
                // domains AND the offline InterPro domain bundle is unavailable
                // (with the bundle, domains + their background come from it — no network).
                const interproAvailable = geneSets.available().some(l => l.id === 'domain')
                const wantMyGene = ga.geneName || ga.summary || ga.omim || ga.pathways || ga.geneType || (gaOn && gaCfg.domain && !interproAvailable)
                const tasks = []
                if (wantMyGene) {
                    tasks.push(fetchGeneAnnotationsBatch(geneNames)
                        .then(m => { geneAnnotations = m })
                        .catch(err => annotationErrors.push({source: 'MyGene.info', error: err.message})))
                }
                tasks.push(annotationRegistry.annotate(geneNames, exportCfg)
                    .then(prov => {
                        providerByGene = prov.byGene
                        for (const e of prov.errors) annotationErrors.push({source: e.source, gene: e.gene, error: e.error})
                    })
                    .catch(err => annotationErrors.push({source: 'annotations', error: err.message})))
                await Promise.all(tasks)
            }
        }

        // --- Gene Summary worksheet -----------------------------------------
        try {
        if (geneCol && exportCfg.sheets.geneSummary) {
            // Local impact-column lookup (the handler-level `impactCol` is
            // declared later, in the Sample Summary section).
            const gsImpactCol = headerColumns.includes('impact') ? 'impact' : null
            const geneMap = {}
            for (const v of filtered) {
                const gene = v[geneCol]
                if (!gene) continue
                if (!geneMap[gene]) geneMap[gene] = {gene, total: 0, samples: 0, pass: 0, fail: 0, uncertain: 0, pending: 0,
                    passHigh: 0, passMod: 0, passLow: 0, high: 0, mod: 0, low: 0, _samples: new Set()}
                const gm = geneMap[gene]
                gm.total++
                gm[v.curation_status || 'pending']++
                if (gsImpactCol) {
                    const imp = String(v[gsImpactCol] || '').toUpperCase()
                    const isPass = v.curation_status === 'pass'
                    // Only HIGH/MODERATE/LOW are tallied; MODIFIER/blank are excluded.
                    if (imp === 'HIGH') { gm.high++; if (isPass) gm.passHigh++ }
                    else if (imp === 'MODERATE') { gm.mod++; if (isPass) gm.passMod++ }
                    else if (imp === 'LOW') { gm.low++; if (isPass) gm.passLow++ }
                }
                if (xlsSampleCol && v[xlsSampleCol]) gm._samples.add(v[xlsSampleCol])
            }
            const geneSummary = Object.values(geneMap).map(g => {
                g.samples = g._samples.size
                delete g._samples
                // "ALL" impact counts: passing / total regardless of impact
                // (includes MODIFIER/blank), i.e. not limited to HIGH/MOD/LOW.
                g.passAll = g.pass
                g.impactAll = g.total
                return g
            }).sort((a, b) => b.total - a.total)

            if (geneSummary.length > 0) {
                const gws = workbook.addWorksheet('Gene Summary', {views: [{state: 'frozen', ySplit: 1}]})
                const gsCols = [
                    {header: 'Gene', key: 'gene', width: 16},
                    {header: 'Total', key: 'total', width: 10},
                    {header: 'Samples', key: 'samples', width: 10},
                    {header: 'Pass', key: 'pass', width: 10},
                    {header: 'Fail', key: 'fail', width: 10},
                    {header: 'Uncertain', key: 'uncertain', width: 12},
                    {header: 'Pending', key: 'pending', width: 10}
                ]

                // Impact counts passing review (HIGH/MODERATE/LOW + ALL), then optional totals
                if (exportCfg.impactCounts && exportCfg.impactCounts.passByImpact) {
                    gsCols.push({header: 'Pass HIGH', key: 'passHigh', width: 10})
                    gsCols.push({header: 'Pass MODERATE', key: 'passMod', width: 14})
                    gsCols.push({header: 'Pass LOW', key: 'passLow', width: 10})
                    gsCols.push({header: 'Pass ALL', key: 'passAll', width: 10})
                }
                if (exportCfg.impactCounts && exportCfg.impactCounts.totalByImpact) {
                    gsCols.push({header: 'HIGH', key: 'high', width: 8})
                    gsCols.push({header: 'MODERATE', key: 'mod', width: 10})
                    gsCols.push({header: 'LOW', key: 'low', width: 8})
                    gsCols.push({header: 'ALL', key: 'impactAll', width: 8})
                }

                // Add annotation columns based on config
                if (exportCfg.geneAnnotations.enabled) {
                    if (exportCfg.geneAnnotations.geneName) gsCols.push({header: 'Gene Name', key: 'geneName', width: 30})
                    if (exportCfg.geneAnnotations.geneType) gsCols.push({header: 'Gene Type', key: 'geneType', width: 14})
                    if (exportCfg.geneAnnotations.omim) gsCols.push({header: 'OMIM', key: 'omim', width: 12})
                    if (exportCfg.geneAnnotations.pathways) gsCols.push({header: 'Pathways', key: 'pathways', width: 30})
                    if (exportCfg.geneAnnotations.summary) gsCols.push({header: 'Summary', key: 'summary', width: 50})
                    // Registry provider columns (gnomAD, ClinVar, gene-list membership)
                    gsCols.push(...annotationRegistry.columns(exportCfg))
                    // MitoCarta mitochondrial annotation (present only when the runtime download has succeeded)
                    if (exportCfg.geneAnnotations.mitocarta !== false && mitocarta.available().length) gsCols.push({header: 'Mitochondrial (MitoCarta)', key: 'mitocarta', width: 26})
                }

                gws.columns = gsCols
                const gsHeader = gws.getRow(1)
                gsHeader.eachCell(cell => {
                    cell.fill = headerFill; cell.font = headerFont; cell.border = borderThin
                    cell.alignment = {vertical: 'middle', horizontal: 'center'}
                })
                gsHeader.height = 24
                geneSummary.forEach((g, idx) => {
                    // Enrich with annotations
                    const ann = geneAnnotations.get(g.gene)
                    if (ann && !ann.error) {
                        if (exportCfg.geneAnnotations.geneName) g.geneName = ann.name || ''
                        if (exportCfg.geneAnnotations.geneType) g.geneType = ann.geneType || ''
                        if (exportCfg.geneAnnotations.omim) g.omim = ann.mim || ''
                        if (exportCfg.geneAnnotations.pathways) g.pathways = (ann.pathways || []).map(p => p.name).join('; ')
                        if (exportCfg.geneAnnotations.summary) g.summary = ann.summary || ''
                    } else if (ann && ann.error) {
                        annotationErrors.push({source: 'MyGene.info', gene: g.gene, error: ann.error})
                    }
                    // Enrich with registry-provider cells (gnomAD/ClinVar/gene-lists)
                    if (exportCfg.geneAnnotations.enabled) {
                        Object.assign(g, annotationRegistry.applyCells(providerByGene.get(g.gene), exportCfg))
                        if (exportCfg.geneAnnotations.mitocarta !== false) {
                            const a = mitocarta.annotationFor(g.gene)
                            if (a) g.mitocarta = a.subLoc && a.subLoc.length ? `Yes — ${a.subLoc.join(', ')}` : 'Yes'
                        }
                    }
                    const row = gws.addRow(g)
                    row.eachCell(cell => {
                        cell.border = borderThin
                        if (idx % 2 === 1) cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFF8F9FA'}}
                    })
                })
                gws.autoFilter = {from: 'A1', to: {row: 1, column: gsCols.length}}
            }
        }
        } catch (sectionErr) {
            log.warn('Gene Summary worksheet failed:', sectionErr.message)
            exportErrors.push({section: 'Gene Summary', error: sectionErr.message})
        }

        // --- Gene Analysis (convergence) worksheet --------------------------
        if (gaOn) {
            try {
                const gaImpactCol = headerColumns.includes('impact') ? 'impact' : null

                // Bundled gene-set library dimensions (Reactome/WikiPathways
                // pathways, HGNC gene families, MSigDB Hallmark) — offline;
                // included when their bundle is present and not disabled by config.
                const gsLibs = {}, gsDims = []
                for (const lib of geneSets.available()) {
                    if (gaCfg[lib.id] === false) continue
                    gsLibs[lib.id] = geneSets.libMap(lib.id)
                    // baseDim libraries (InterPro domain) source an EXISTING base
                    // dimension — don't add them as a new convergence section.
                    if (!lib.baseDim) gsDims.push({id: lib.id, label: lib.label})
                }
                // MitoCarta 3.0 dimensions (localization / sub-localization / pathways).
                // Downloaded from the Broad at runtime (CC BY-NC, not bundled); available()
                // is empty until that succeeds, so this simply adds nothing when offline.
                // ensureData already ran (and cache-cleared) before Read Me/Gene Summary;
                // this await is a memoized no-op that just guards direct-call code paths.
                try { await mitocarta.ensureData() } catch (mErr) { log.warn('MitoCarta ensureData:', mErr.message) }
                for (const lib of mitocarta.available()) {
                    if (gaCfg[lib.id] === false) continue
                    gsLibs[lib.id] = mitocarta.libMap(lib.id)
                    gsDims.push({id: lib.id, label: lib.label})
                }
                // Active dimensions = enabled base dims + enabled gene-set dims.
                const dimensions = [...DIMENSIONS.filter(d => gaCfg[d.id] !== false), ...gsDims]

                // Per-gene term lists for the EXPORTED genes.
                const geneTerms = new Map()
                for (const gene of [...new Set(filtered.map(v => v[geneCol]).filter(Boolean))]) {
                    geneTerms.set(String(gene).toUpperCase(),
                        geneTermsFor(gene, providerByGene.get(gene), geneAnnotations.get(gene), gsLibs))
                }

                // Background = each source's OWN gene universe, and the engine gates each
                // dimension's TRIALS on that same universe (sourceUniverseStats returns the
                // gene set for exactly that purpose). A dimension can only classify the
                // genes its source knows about, so that set is both the prevalence
                // denominator and the pool the null draws from. NOT the cohort. Degrades
                // gracefully: no source ⇒ that dimension is simply not tested.
                let sourceUniverse = {}
                try {
                    // Constraint prevalence must use the SAME gnomAD build as the per-gene
                    // constraint terms. getBundle() is always v4.1/GRCh38; on a GRCh37
                    // export the per-gene terms come from the live v2.1.1 API, so the
                    // constraint background is skipped there (it degrades to counts-only,
                    // like domain without InterPro) rather than mixing builds.
                    const gnB = gnomadProvider.refGenome(exportCfg) === 'GRCh38' ? gnomadProvider.getBundle() : null
                    sourceUniverse = sourceUniverseStats({gnomad: gnB, clinvar: clinvarProvider.getGenes(), gencc: genccProvider.getGenes()}, gsLibs)
                } catch (uErr) { log.warn('Gene Analysis prevalence/background skipped:', uErr.message); sourceUniverse = {} }

                // Cohort proband base for the grid % AND % samples: the TRUE
                // cohort = every ATTEMPTED proband (one per trio), including those
                // with 0 de novo variants. Prefer the Sample QC trio count (which
                // lists every sequenced trio); take the max with the distinct
                // probands present in the variants so it's never an undercount.
                const probandsWithVariant = xlsSampleCol
                    ? new Set(variants.map(v => v[xlsSampleCol] || 'unknown')).size : 1
                const totalProbands = Math.max(probandsWithVariant, sampleQcTrios.length || 0) || 1

                const conv = computeConvergence(filtered, {
                    geneCol, impactCol: gaImpactCol, sampleCol: xlsSampleCol,
                    geneTerms, minCount: gaCfg.minCount || 2, dimensions,
                    sourceUniverse, totalProbands,
                })
                conv.probandsWithVariant = probandsWithVariant   // for the banner (transparency)
                // Two tabs: Samples (conservative headline, only with a sample
                // column) then DNMs (always). Each is one unit — no more mixing.
                const gaStyles = {headerFill, headerFont, borderThin}
                // The derivation sheet publishes the proband burden histogram — the
                // sample test's only otherwise-unreported input. Built FIRST so the
                // samples tab can point its live "Expected Σpᵢ" SUMPRODUCT at it.
                let derivRefs = null
                if (conv.hasSamples) {
                    try { derivRefs = buildGaDerivationSheet(workbook, conv, gaStyles, conv.cells.filter(c => c.statusKey === 'pass')) }
                    catch (dErr) { log.warn('Gene Analysis derivation sheet:', dErr.message) }
                    buildGeneAnalysisTab(workbook, conv, gaStyles, GA_SAMPLE_TRACK, derivRefs)
                }
                buildGeneAnalysisTab(workbook, conv, gaStyles, GA_DNM_TRACK)

                // --- Test B: de novo mutation-rate enrichment (separate, gated) ---
                // A DE-NOVO-ONLY test (λ = 2·N·Σp, Samocha-2014 rates). Suppressed when de novo
                // status is unknown (no `inheritance` column) or the rate bundle is absent.
                // Isolated try — never affects Test A.
                if (gaCfg.dnmRateTest !== false) {
                    try {
                        const inheritanceCol = headerColumns.includes('inheritance') ? 'inheritance' : null
                        // Molecular consequence is STRONGLY preferred over IMPACT severity:
                        // VEP LOW is not synonymous, and the synonymous class is the model-fit
                        // diagnostic — contaminating it corrupts the one honest QC readout.
                        const consequenceCol = ['Consequence', 'consequence', 'CONSEQUENCE'].find(c => headerColumns.includes(c)) || null
                        // The rate table is keyed by gene symbol and carries no coordinates, so
                        // it needs no GRCh38 gate — Test B runs on GRCh37 too. (If anything the
                        // rates are GRCh37-native: DeNovoWEST's table comes from the DDD study.)
                        const rates = dnmRates.getRates()
                        // The CONSTRAINT dimension is the one exception, and it is gated exactly
                        // as Test A gates it: getBundle() is v4.1/GRCh38, but on a GRCh37 export
                        // the per-gene constraint TERMS come from the live v2.1.1 API. Passing
                        // the v4.1 bundle here would count a gene as LOEUF-constrained in Σp per
                        // v4.1 while k counted it per v2.1.1 — numerator and denominator over
                        // different gene sets, the drift this design exists to prevent. Null ⇒
                        // the constraint dimension simply has no Σp on GRCh37 and is not tested;
                        // every other dimension still is.
                        const gnB = gnomadProvider.refGenome(exportCfg) === 'GRCh38' ? gnomadProvider.getBundle() : null
                        if (!inheritanceCol) {
                            exportErrors.push({section: 'DNM Rate Enrichment', error: 'skipped — no `inheritance` column, so de novo status is unknown (the mutation-rate model applies only to de novo variants)'})
                        } else if (!rates.size) {
                            exportErrors.push({section: 'DNM Rate Enrichment', error: 'skipped — per-gene de novo rates unavailable (data/annotations/dnm_rates.json.gz absent; build with `node scripts/build-annotation-data.js dnmRates`)'})
                        } else {
                            const nReliable = (sampleQcTrios.length || 0) > 0
                            const categoryMu = categoryRateSums(rates, {gnomad: gnB, clinvar: clinvarProvider.getGenes(), gencc: genccProvider.getGenes()}, gsLibs)
                            const dnm = computeModelEnrichment(filtered, {
                                model: DE_NOVO, geneCol, impactCol: gaImpactCol, consequenceCol, statusCol: 'curation_status',
                                sampleCol: xlsSampleCol, chromCol: 'chrom', refCol: 'ref', altCol: 'alt', inheritanceCol,
                                geneTerms, dimensions, muByGene: rates, categoryMu,
                                // totalProbands = max(distinct probands in callset, Sample-QC trio count)
                                // — never undercounts below observed probands even in the reliable path.
                                N: totalProbands, nReliable, minCount: 1,
                            })
                            buildDnmRateCategoryTab(workbook, dnm, gaStyles)
                            buildDnmRatePerGeneTab(workbook, dnm, gaStyles)
                        }
                    } catch (dnmErr) {
                        log.warn('DNM Rate Enrichment failed:', dnmErr.message)
                        exportErrors.push({section: 'DNM Rate Enrichment', error: dnmErr.message})
                    }
                }
            } catch (sectionErr) {
                log.warn('Gene Analysis worksheet failed:', sectionErr.message)
                exportErrors.push({section: 'Gene Analysis', error: sectionErr.message})
            }
        }

        // --- Sample Summary worksheet ---------------------------------------
        const impactCol = headerColumns.includes('impact') ? 'impact' : null
        const freqCol = headerColumns.find(c => c.startsWith('freq')) || null
        const sampleCol = ['sample_id', 'trio_id'].find(c => headerColumns.includes(c)) || null
        const ssThresholds = SAMPLE_SUMMARY_THRESHOLDS
        const ssImpactGroups = SAMPLE_SUMMARY_IMPACT_GROUPS
        try {
            const sampleMap = {}
            for (const v of filtered) {
                const sid = sampleCol ? (v[sampleCol] || 'unknown') : 'all'
                if (!sampleMap[sid]) sampleMap[sid] = []
                sampleMap[sid].push(v)
            }
            // Count all (unfiltered) variants per sample
            const allSampleCounts = {}
            for (const v of variants) {
                const sid = sampleCol ? (v[sampleCol] || 'unknown') : 'all'
                allSampleCounts[sid] = (allSampleCounts[sid] || 0) + 1
            }
            const ssws = workbook.addWorksheet('Sample Summary', {views: [{state: 'frozen', ySplit: 1}]})
            // Build columns: Sample, Unfiltered, Passing Filters, Curated, Pass, Fail, Uncertain, Pending, then impact_group × threshold combos
            const ssCols = [
                {header: 'Sample', key: 'sample', width: 16},
                {header: 'Unfiltered', key: 'total_unfiltered', width: 12},
                {header: 'Passing Filters', key: 'total', width: 16},
                {header: 'Curated', key: 'curated', width: 10},
                {header: 'Pass', key: 'cur_pass', width: 10},
                {header: 'Fail', key: 'cur_fail', width: 10},
                {header: 'Uncertain', key: 'cur_uncertain', width: 12},
                {header: 'Pending', key: 'cur_pending', width: 10}
            ]
            for (const ig of ssImpactGroups) {
                for (const t of ssThresholds) {
                    const key = `${ig.label}__${t.label}`
                    ssCols.push({header: `${ig.label} | ${t.label}`, key, width: 22})
                }
            }
            ssws.columns = ssCols
            const ssHeader = ssws.getRow(1)
            ssHeader.eachCell(cell => {
                cell.fill = headerFill; cell.font = headerFont; cell.border = borderThin
                cell.alignment = {vertical: 'middle', horizontal: 'center', wrapText: true}
            })
            ssHeader.height = 36

            // Collect per-sample row data for cohort stats
            const sampleRows = []
            let ssIdx = 0
            for (const [sid, sampleVariants] of Object.entries(sampleMap)) {
                // Curation breakdown
                let cPass = 0, cFail = 0, cUncertain = 0, cPending = 0
                for (const v of sampleVariants) {
                    if (v.curation_status === 'pass') cPass++
                    else if (v.curation_status === 'fail') cFail++
                    else if (v.curation_status === 'uncertain') cUncertain++
                    else cPending++
                }
                const rowData = {
                    sample: sid,
                    total_unfiltered: allSampleCounts[sid] || 0,
                    total: sampleVariants.length,
                    curated: cPass + cFail + cUncertain,
                    cur_pass: cPass,
                    cur_fail: cFail,
                    cur_uncertain: cUncertain,
                    cur_pending: cPending
                }
                for (const ig of ssImpactGroups) {
                    const impactFiltered = impactCol
                        ? sampleVariants.filter(v => ig.impacts.includes(String(v[impactCol] || '').toUpperCase()))
                        : sampleVariants
                    for (const t of ssThresholds) {
                        const key = `${ig.label}__${t.label}`
                        if (!freqCol || t.type === 'all') {
                            rowData[key] = impactFiltered.length
                        } else if (t.type === 'eq') {
                            rowData[key] = impactFiltered.filter(v => Number(v[freqCol]) === t.value).length
                        } else {
                            rowData[key] = impactFiltered.filter(v => Number(v[freqCol]) < t.value).length
                        }
                    }
                }
                sampleRows.push(rowData)
                const row = ssws.addRow(rowData)
                row.eachCell(cell => {
                    cell.border = borderThin
                    if (ssIdx % 2 === 1) cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFF8F9FA'}}
                })
                ssIdx++
            }
            ssws.autoFilter = {from: 'A1', to: {row: 1, column: ssCols.length}}

            // Cohort statistics rows (Mean / Median / Std Dev)
            if (sampleRows.length > 0) {
                // Blank separator row
                ssws.addRow({})

                const numericKeys = ssCols.slice(1).map(c => c.key)
                const statsFill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFEAF2F8'}}
                const statsFont = {bold: true, size: 11}

                for (const statLabel of ['Mean', 'Median', 'Std Dev']) {
                    const statRow = {sample: statLabel}
                    for (const key of numericKeys) {
                        const values = sampleRows.map(r => r[key] || 0)
                        const stats = computeStats(values)
                        if (statLabel === 'Mean') statRow[key] = stats.mean
                        else if (statLabel === 'Median') statRow[key] = stats.median
                        else statRow[key] = stats.sd
                    }
                    const row = ssws.addRow(statRow)
                    row.eachCell(cell => {
                        cell.border = borderThin
                        cell.fill = statsFill
                        cell.font = statsFont
                    })
                }
            }
        } catch (sectionErr) {
            log.warn('Sample Summary worksheet failed:', sectionErr.message)
            exportErrors.push({section: 'Sample Summary', error: sectionErr.message})
        }

        // --- Sample QC worksheet --------------------------------------------
        try {
        if (sampleQcTrios.length > 0) {
            const metricCols = sampleQcColumns.filter(c => !['trio_id', 'role', 'sample_id'].includes(c))
            const roles = ['proband', 'mother', 'father']
            const qcws = workbook.addWorksheet('Sample QC', {views: [{state: 'frozen', ySplit: 1}]})

            // Build columns: Trio ID, QC Status, then role × metric combos
            const qcColDefs = [
                {header: 'Trio ID', key: 'trio_id', width: 14},
                {header: 'QC Status', key: 'qc_status', width: 12}
            ]
            for (const role of roles) {
                qcColDefs.push({header: `${role} Sample`, key: `${role}_sample_id`, width: 16})
                for (const m of metricCols) {
                    qcColDefs.push({header: `${role} ${m}`, key: `${role}_${m}`, width: 14})
                }
            }
            qcws.columns = qcColDefs

            const qcHeader = qcws.getRow(1)
            qcHeader.eachCell(cell => {
                cell.fill = headerFill; cell.font = headerFont; cell.border = borderThin
                cell.alignment = {vertical: 'middle', horizontal: 'center', wrapText: true}
            })
            qcHeader.height = 30

            const qcStatusColors = {
                pass: 'FF27AE60', warn: 'FFF39C12', fail: 'FFE74C3C', critical: 'FFC0392B', unknown: 'FF95A5A6'
            }

            sampleQcTrios.forEach((trio, idx) => {
                const rowData = {trio_id: trio.trio_id, qc_status: trio.qc_status}
                for (const role of roles) {
                    rowData[`${role}_sample_id`] = (trio.members[role] && trio.members[role].sample_id) || ''
                    for (const m of metricCols) {
                        rowData[`${role}_${m}`] = (trio.metrics[m] && trio.metrics[m][role]) != null ? trio.metrics[m][role] : ''
                    }
                }
                const row = qcws.addRow(rowData)
                row.eachCell((cell, colNumber) => {
                    cell.border = borderThin
                    if (idx % 2 === 1) cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFF8F9FA'}}
                })
                // Color QC status cell
                const statusCell = row.getCell(2)
                const sColor = qcStatusColors[trio.qc_status] || qcStatusColors.unknown
                statusCell.font = {bold: true, color: {argb: sColor}}
            })
            qcws.autoFilter = {from: 'A1', to: {row: 1, column: qcColDefs.length}}
        }
        } catch (sectionErr) {
            log.warn('Sample QC worksheet failed:', sectionErr.message)
            exportErrors.push({section: 'Sample QC', error: sectionErr.message})
        }

        // --- Applied Filters worksheet --------------------------------------
        try {
        // Always create the Applied Filters sheet so the export is self-documenting
        const fws = workbook.addWorksheet('Applied Filters', {views: [{state: 'frozen', ySplit: 1}]})
        fws.columns = [
            {header: 'Filter', key: 'filter', width: 30},
            {header: 'Value', key: 'value', width: 60}
        ]
        const fHeader = fws.getRow(1)
        fHeader.eachCell(cell => {
            cell.fill = headerFill; cell.font = headerFont; cell.border = borderThin
            cell.alignment = {vertical: 'middle', horizontal: 'center'}
        })
        fHeader.height = 24

        // Helper: add a styled data row
        let fIdx = 0
        const addFilterRow = (label, value) => {
            const row = fws.addRow({filter: label, value: String(value)})
            row.eachCell(cell => {
                cell.border = borderThin
                if (fIdx % 2 === 1) cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFF8F9FA'}}
            })
            fIdx++
        }

        // -- Section heading helper
        const addSectionHeading = (title) => {
            const row = fws.addRow({filter: title, value: ''})
            row.getCell(1).font = {bold: true, color: {argb: 'FF2C3E50'}}
            row.getCell(1).fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFD6EAF8'}}
            row.getCell(2).fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFD6EAF8'}}
            row.eachCell(cell => { cell.border = borderThin })
            fIdx++
        }

        // --- Variant Filters ---
        addSectionHeading('Variant Filters')
        if (clientFilters && typeof clientFilters === 'object' && Object.keys(clientFilters).length > 0) {
            for (const [key, value] of Object.entries(clientFilters)) {
                if (value === '' || value === null || value === undefined) continue
                if (key === 'page' || key === 'per_page') continue

                if (key === 'functional_filter') {
                    // Expand each OR condition as its own row for readability
                    let conditions
                    try { conditions = JSON.parse(value) } catch (_) { conditions = null }
                    if (Array.isArray(conditions) && conditions.length > 0) {
                        addFilterRow('Functional Filter (OR)', '— see rows below —')
                        conditions.forEach((c, i) => {
                            addFilterRow(`  Condition ${i + 1}`, formatCondition(c))
                        })
                    } else {
                        addFilterRow('Functional Filter', functionalFilterToHuman(value))
                    }
                } else if (key === 'sort') {
                    // Sort label formatted nicely; order is rendered together below
                    const orderVal = clientFilters.order || 'asc'
                    addFilterRow('Sort', `${value} (${orderVal})`)
                } else if (key === 'order') {
                    // Skip – combined into sort row above
                } else {
                    const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                    addFilterRow(label, value)
                }
            }
        } else {
            addFilterRow('(no filters applied)', '')
        }

        // --- Export Settings ---
        addSectionHeading('Export Settings')
        addFilterRow('Genome Build', exportCfg.genomeBuild || GENOME)
        addFilterRow('IGV Screenshots', exportCfg.igvScreenshots ? 'ON' : 'OFF')
        addFilterRow('Lollipop Plots', exportCfg.lollipopPlots ? 'ON' : 'OFF')
        addFilterRow('Protein Domains', exportCfg.proteinDomains ? 'ON' : 'OFF')
        addFilterRow('Gene Annotations', exportCfg.geneAnnotations.enabled ? 'ON' : 'OFF')
        if (exportCfg.geneAnnotations.enabled) {
            const gaDetails = ['geneName', 'summary', 'omim', 'pathways', 'geneType']
                .filter(k => exportCfg.geneAnnotations[k])
                .join(', ')
            if (gaDetails) addFilterRow('  Annotation Fields', gaDetails)
        }

        // Variant column categories
        const colCats = exportCfg.variantColumns || {}
        const includedCats = Object.entries(colCats).filter(([, v]) => v !== false).map(([k]) => k)
        const excludedCats = Object.entries(colCats).filter(([, v]) => v === false).map(([k]) => k)
        addFilterRow('Variant Columns Included', includedCats.length > 0 ? includedCats.join(', ') : 'all')
        if (excludedCats.length > 0) addFilterRow('Variant Columns Excluded', excludedCats.join(', '))

        } catch (sectionErr) {
            log.warn('Applied Filters worksheet failed:', sectionErr.message)
            exportErrors.push({section: 'Applied Filters', error: sectionErr.message})
        }

        // --- Annotation Status worksheet ------------------------------------
        // Reports which external data fetches succeeded or failed, so the
        // user knows exactly what data may be missing from the export.
        if (exportCfg.sheets.annotationStatus) {
            const asws = workbook.addWorksheet('Annotation Status', {views: [{state: 'frozen', ySplit: 1}]})
            asws.columns = [
                {header: 'Source', key: 'source', width: 20},
                {header: 'Gene', key: 'gene', width: 16},
                {header: 'Status', key: 'status', width: 14},
                {header: 'Details', key: 'details', width: 50}
            ]
            const asHeader = asws.getRow(1)
            asHeader.eachCell(cell => {
                cell.fill = headerFill; cell.font = headerFont; cell.border = borderThin
                cell.alignment = {vertical: 'middle', horizontal: 'center'}
            })
            asHeader.height = 24

            // Metadata row: genome build
            const buildRow = asws.addRow({source: 'Genome Build', gene: '', status: 'Info', details: exportCfg.genomeBuild || GENOME})
            buildRow.eachCell(cell => { cell.border = borderThin })

            // Data-source / licence attribution rows for enabled annotations
            if (exportCfg.geneAnnotations.enabled) {
                const attributions = [{source: 'MyGene.info', details: 'Gene name/type/OMIM/pathways/summary — https://mygene.info'}]
                try { attributions.push(...annotationRegistry.attributions(exportCfg)) } catch (_) { /* ignore */ }
                // MitoCarta is a standalone module (not in the registry); surface its
                // CC BY-NC licence here — this tab is the Read Me's designated licence
                // surface and is built after the download, so attribution is reliable.
                try { attributions.push(...mitocarta.attributions().map(s => ({source: 'MitoCarta3.0', details: s}))) } catch (_) { /* ignore */ }
                for (const a of attributions) {
                    const r = asws.addRow({source: a.source, gene: '', status: 'Source', details: a.details})
                    r.eachCell(cell => { cell.border = borderThin })
                }
            }

            // Export config summary
            const cfgRow = asws.addRow({source: 'Export Config', gene: '', status: 'Info', details: `Screenshots: ${exportCfg.igvScreenshots ? 'ON' : 'OFF'}, Lollipop: ${exportCfg.lollipopPlots ? 'ON' : 'OFF'}, Annotations: ${exportCfg.geneAnnotations.enabled ? 'ON' : 'OFF'}`})
            cfgRow.eachCell(cell => { cell.border = borderThin })

            if (annotationErrors.length === 0) {
                const okRow = asws.addRow({source: 'All Sources', gene: '', status: 'OK', details: 'All annotation fetches completed successfully'})
                okRow.eachCell(cell => { cell.border = borderThin })
                okRow.getCell(3).font = {bold: true, color: {argb: 'FF27AE60'}}
            } else {
                // Deduplicate errors by source+gene
                const seen = new Set()
                let asIdx = 0
                for (const err of annotationErrors) {
                    const key = `${err.source}:${err.gene || ''}`
                    if (seen.has(key)) continue
                    seen.add(key)
                    const row = asws.addRow({source: err.source, gene: err.gene || '', status: 'FAILED', details: err.error})
                    row.eachCell(cell => {
                        cell.border = borderThin
                        if (asIdx % 2 === 1) cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFF8F9FA'}}
                    })
                    row.getCell(3).font = {bold: true, color: {argb: 'FFE74C3C'}}
                    asIdx++
                }
            }
        }

        // --- Gene Lollipop Plot worksheets ------------------------------------
        // Outer try/catch: protects workbook from total section failure
        // Inner try/catch per gene: isolates individual worksheet failures
        // Innermost retry loop: retries transient image decode/embed errors
        try {
        if (hasLollipopPlots && geneCol) {
            for (const [gene, imgData] of Object.entries(lollipopPlots)) {
                if (!imgData || typeof imgData !== 'string' || imgData.length > 10 * 1024 * 1024) continue
                const safeName = `LP ${gene}`.substring(0, 31)
                try {
                const lpws = workbook.addWorksheet(safeName)
                lpws.getCell('A1').value = `Lollipop Plot: ${gene}`
                lpws.getCell('A1').font = {bold: true, size: 14, color: {argb: 'FF2C3E50'}}
                lpws.getColumn(1).width = 20
                lpws.getColumn(2).width = 40

                // Count passing variants for this gene
                const geneVariants = filtered.filter(v => v[geneCol] === gene)
                const passingCount = geneVariants.filter(v => v.curation_status === 'pass').length
                lpws.getCell('A2').value = 'Variants:'
                lpws.getCell('A2').font = {bold: true}
                lpws.getCell('B2').value = `${geneVariants.length} total, ${passingCount} passing`

                // Back-link
                lpws.getCell('D1').value = {text: '← Back to Variants', hyperlink: '#Variants!A1'}
                lpws.getCell('D1').font = {color: {argb: 'FF2980B9'}, underline: true}
                lpws.getColumn(4).width = 22

                // Embed the lollipop plot image (with retry)
                let imgEmbedded = false
                for (let attempt = 0; attempt < IMAGE_EMBED_RETRIES && !imgEmbedded; attempt++) {
                    try {
                        let base64 = imgData
                        let extension = 'png'
                        if (base64.startsWith('data:image/jpeg;base64,')) {
                            base64 = base64.replace('data:image/jpeg;base64,', '')
                            extension = 'jpeg'
                        } else if (base64.startsWith('data:image/png;base64,')) {
                            base64 = base64.replace('data:image/png;base64,', '')
                        }

                        const imageId = workbook.addImage({
                            buffer: Buffer.from(base64, 'base64'),
                            extension: extension
                        })
                        lpws.addImage(imageId, {
                            tl: {col: 0, row: 3},
                            ext: {width: 900, height: 340}
                        })
                        imgEmbedded = true
                    } catch (imgErr) {
                        if (attempt === IMAGE_EMBED_RETRIES - 1) {
                            lpws.getCell('A4').value = '(Lollipop plot could not be embedded)'
                            lpws.getCell('A4').font = {italic: true, color: {argb: 'FF999999'}}
                            exportErrors.push({section: `Lollipop Plot: ${gene}`, error: `Image embed failed: ${imgErr.message}`})
                        }
                    }
                }
                } catch (lpErr) {
                    log.warn(`Lollipop worksheet failed for ${gene}:`, lpErr.message)
                    exportErrors.push({section: `Lollipop Plot: ${gene}`, error: lpErr.message})
                }
            }
        }
        } catch (sectionErr) {
            log.warn('Lollipop Plot worksheets failed:', sectionErr.message)
            exportErrors.push({section: 'Lollipop Plots', error: sectionErr.message})
        }

        // --- Screenshot worksheets (placed after all data tabs) --------------
        // Same layered error handling as lollipop plots (see comments above)
        try {
        if (hasScreenshots) {
            const ssSampleCol = ['sample_id', 'trio_id'].find(c => headerColumns.includes(c)) || null
            for (const [sheetName, vid] of sheetNames) {
                const v = filtered.find(x => x.id === vid)
                const imgData = screenshots[String(vid)]
                if (!v || !imgData) continue

                try {
                const sws = workbook.addWorksheet(sheetName)

                // Header rows with variant info
                let infoRow = 1
                sws.getCell(`A${infoRow}`).value = 'Variant:'
                sws.getCell(`A${infoRow}`).font = {bold: true, size: 12}
                sws.getCell(`B${infoRow}`).value = `${v.chrom}:${v.pos} ${v.ref}→${v.alt}`
                sws.getCell(`B${infoRow}`).font = {size: 12}

                if (v.gene) {
                    infoRow++
                    sws.getCell(`A${infoRow}`).value = 'Gene:'
                    sws.getCell(`A${infoRow}`).font = {bold: true}
                    sws.getCell(`B${infoRow}`).value = v.gene
                }

                if (ssSampleCol && v[ssSampleCol]) {
                    infoRow++
                    sws.getCell(`A${infoRow}`).value = ssSampleCol === 'trio_id' ? 'Trio:' : 'Sample:'
                    sws.getCell(`A${infoRow}`).font = {bold: true}
                    sws.getCell(`B${infoRow}`).value = v[ssSampleCol]
                }

                if (v.impact) {
                    infoRow++
                    sws.getCell(`A${infoRow}`).value = 'Impact:'
                    sws.getCell(`A${infoRow}`).font = {bold: true}
                    sws.getCell(`B${infoRow}`).value = v.impact
                }

                if (v.inheritance) {
                    infoRow++
                    sws.getCell(`A${infoRow}`).value = 'Inheritance:'
                    sws.getCell(`A${infoRow}`).font = {bold: true}
                    sws.getCell(`B${infoRow}`).value = v.inheritance
                }

                const ssFreqCol = headerColumns.find(c => c.startsWith('freq')) || null
                if (ssFreqCol && v[ssFreqCol] != null) {
                    infoRow++
                    sws.getCell(`A${infoRow}`).value = 'Frequency:'
                    sws.getCell(`A${infoRow}`).font = {bold: true}
                    sws.getCell(`B${infoRow}`).value = v[ssFreqCol]
                }

                if (v.quality != null) {
                    infoRow++
                    sws.getCell(`A${infoRow}`).value = 'Quality:'
                    sws.getCell(`A${infoRow}`).font = {bold: true}
                    sws.getCell(`B${infoRow}`).value = v.quality
                }

                // Trio allelic depths (AD)
                const adParts = []
                if (v.child_AD != null && v.child_AD !== '') adParts.push('C:' + String(v.child_AD))
                if (v.mother_AD != null && v.mother_AD !== '') adParts.push('M:' + String(v.mother_AD))
                if (v.father_AD != null && v.father_AD !== '') adParts.push('F:' + String(v.father_AD))
                if (adParts.length) {
                    infoRow++
                    sws.getCell(`A${infoRow}`).value = 'AD:'
                    sws.getCell(`A${infoRow}`).font = {bold: true}
                    sws.getCell(`B${infoRow}`).value = adParts.join('  ')
                }

                // Trio genotype quality (GQ)
                const gqParts = []
                if (v.child_GQ != null && v.child_GQ !== '') gqParts.push('C:' + String(v.child_GQ))
                if (v.mother_GQ != null && v.mother_GQ !== '') gqParts.push('M:' + String(v.mother_GQ))
                if (v.father_GQ != null && v.father_GQ !== '') gqParts.push('F:' + String(v.father_GQ))
                if (gqParts.length) {
                    infoRow++
                    sws.getCell(`A${infoRow}`).value = 'GQ:'
                    sws.getCell(`A${infoRow}`).font = {bold: true}
                    sws.getCell(`B${infoRow}`).value = gqParts.join('  ')
                }

                // Child DKA (if separate column exists)
                if (v.child_DKA != null && v.child_DKA !== '') {
                    infoRow++
                    sws.getCell(`A${infoRow}`).value = 'DKA:'
                    sws.getCell(`A${infoRow}`).font = {bold: true}
                    sws.getCell(`B${infoRow}`).value = v.child_DKA
                }

                // Child DKA/DKT
                if (v.child_DKA_DKT != null && v.child_DKA_DKT !== '') {
                    infoRow++
                    sws.getCell(`A${infoRow}`).value = 'DKA/DKT:'
                    sws.getCell(`A${infoRow}`).font = {bold: true}
                    sws.getCell(`B${infoRow}`).value = v.child_DKA_DKT
                }

                infoRow++
                sws.getCell(`A${infoRow}`).value = 'Status:'
                sws.getCell(`A${infoRow}`).font = {bold: true}
                sws.getCell(`B${infoRow}`).value = v.curation_status || 'pending'
                const sColor = statusColors[v.curation_status] || statusColors.pending
                sws.getCell(`B${infoRow}`).font = {bold: true, color: {argb: sColor}}

                if (v.curation_note) {
                    infoRow++
                    sws.getCell(`A${infoRow}`).value = 'Note:'
                    sws.getCell(`A${infoRow}`).font = {bold: true}
                    sws.getCell(`B${infoRow}`).value = v.curation_note
                }

                // Contamination / species panel (above the screenshot)
                if (contamOn) {
                    const m = speciesByVariant.get(vid)
                    if (m) {
                        const contamColors = {clean: 'FF27AE60', caution: 'FFF39C12', concern: 'FFE67E22', high: 'FFE74C3C'}
                        infoRow += 2   // spacer
                        sws.getCell(`A${infoRow}`).value = 'Contamination / species'
                        sws.getCell(`A${infoRow}`).font = {bold: true, size: 12, color: {argb: 'FF2C3E50'}}
                        const contamRow = (label, value, font) => {
                            infoRow++
                            sws.getCell(`A${infoRow}`).value = label
                            sws.getCell(`A${infoRow}`).font = {bold: true}
                            sws.getCell(`B${infoRow}`).value = value
                            if (font) sws.getCell(`B${infoRow}`).font = font
                        }
                        const label = m.assessment ? m.assessment.label : 'unknown'
                        contamRow('Assessment:', m.assessment ? `${m.assessment.label} — ${m.assessment.description}` : 'unknown',
                            {bold: true, color: {argb: contamColors[label] || 'FF7F8C8D'}})
                        contamRow('Nonhuman:', `${(m.nonhumanFraction * 100).toFixed(1)}%  (${m.nonhumanReads}/${m.totalReads} reads)`)
                        if (m.topTaxa && m.topTaxa.length) {
                            contamRow('Top taxa:', m.topTaxa.slice(0, 5).map(t => `${t.name} (${t.count})`).join('; '))
                        }
                        contamRow('Read sets:', `DKA ${m.readSetCounts.DKA}, DKU ${m.readSetCounts.DKU}`)
                        contamRow('Split / clip:', `${m.splitReadCount} split, ${m.clippingStats.highClipReads} high-clip`)
                    }
                }

                // Back-link to the Variants sheet
                sws.getCell('D1').value = {text: '← Back to Variants', hyperlink: '#Variants!A1'}
                sws.getCell('D1').font = {color: {argb: 'FF2980B9'}, underline: true}

                // Set column widths
                sws.getColumn(1).width = 14
                sws.getColumn(2).width = 30
                sws.getColumn(3).width = 5
                sws.getColumn(4).width = 22

                // Embed the screenshot image (with retry)
                const imgStartRow = infoRow + 2
                let imgEmbedded = false
                for (let attempt = 0; attempt < IMAGE_EMBED_RETRIES && !imgEmbedded; attempt++) {
                    try {
                        // imgData should be a base64 PNG/JPEG data URI or raw base64
                        let base64 = imgData
                        let extension = 'png'
                        if (base64.startsWith('data:image/jpeg;base64,')) {
                            base64 = base64.replace('data:image/jpeg;base64,', '')
                            extension = 'jpeg'
                        } else if (base64.startsWith('data:image/png;base64,')) {
                            base64 = base64.replace('data:image/png;base64,', '')
                        }

                        const imageId = workbook.addImage({
                            buffer: Buffer.from(base64, 'base64'),
                            extension: extension
                        })

                        sws.addImage(imageId, {
                            tl: {col: 0, row: imgStartRow - 1},
                            ext: {width: 1800, height: 800}
                        })
                        imgEmbedded = true
                    } catch (imgErr) {
                        if (attempt === IMAGE_EMBED_RETRIES - 1) {
                            sws.getCell(`A${imgStartRow}`).value = '(Screenshot could not be embedded)'
                            sws.getCell(`A${imgStartRow}`).font = {italic: true, color: {argb: 'FF999999'}}
                            exportErrors.push({section: `Screenshot: ${v.chrom}:${v.pos}`, error: `Image embed failed: ${imgErr.message}`})
                        }
                    }
                }
                } catch (ssErr) {
                    log.warn(`Screenshot worksheet failed for variant ${vid}:`, ssErr.message)
                    exportErrors.push({section: `Screenshot: variant ${vid}`, error: ssErr.message})
                }
                // Drop the decoded base64 now that it is embedded so V8 can GC it
                // during the (potentially long) per-variant embed loop, instead of
                // holding every screenshot's string until the handler returns.
                screenshots[String(vid)] = null
            }
        }
        } catch (sectionErr) {
            log.warn('Screenshot worksheets failed:', sectionErr.message)
            exportErrors.push({section: 'Screenshots', error: sectionErr.message})
        }

        // --- Export Errors worksheet -----------------------------------------
        // If any non-fatal errors occurred during export, embed them in a
        // dedicated tab so the user can see exactly what went wrong.
        if (exportErrors.length > 0) {
            try {
                const errWs = workbook.addWorksheet('Export Errors', {views: [{state: 'frozen', ySplit: 1}]})
                errWs.columns = [
                    {header: 'Section', key: 'section', width: 28},
                    {header: 'Error', key: 'error', width: 60},
                    {header: 'Timestamp', key: 'timestamp', width: 22}
                ]
                const errHeader = errWs.getRow(1)
                errHeader.eachCell(cell => {
                    cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFC0392B'}}
                    cell.font = {bold: true, color: {argb: 'FFFFFFFF'}, size: 11}
                    cell.border = borderThin
                    cell.alignment = {vertical: 'middle', horizontal: 'center'}
                })
                errHeader.height = 24

                const ts = new Date().toISOString()
                exportErrors.forEach((err, idx) => {
                    const row = errWs.addRow({section: err.section, error: err.error, timestamp: ts})
                    row.eachCell(cell => {
                        cell.border = borderThin
                        if (idx % 2 === 1) cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFF8F9FA'}}
                    })
                })

                log.warn(`XLSX export completed with ${exportErrors.length} non-fatal error(s)`)
            } catch (errSheetErr) {
                log.warn('Failed to create Export Errors worksheet:', errSheetErr.message)
            }
        }

        // --- Send workbook as download --------------------------------------
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        res.setHeader('Content-Disposition', 'attachment; filename="variants_export.xlsx"')
        // Store (no DEFLATE) at finalize: the embedded images (PNG/JPEG) are already
        // compressed, so re-deflating them at the default level is wasted CPU for ~0
        // size gain. Trade-off: sheet XML is no longer compressed, so image-free
        // exports get larger — switch to {zip: {compressionOptions: {level: 1}}} if
        // that matters. exceljs forwards options.zip to the underlying zip writer.
        await workbook.xlsx.write(res, {zip: {compression: 'STORE'}})
        res.end()
    } catch (err) {
        log.error('XLSX export error:', err.message, err.stack)
        if (!res.headersSent) {
            res.status(500).json({error: `XLSX export failed: ${err.message}`})
        }
    }
})

// HTML Export – interactive static HTML report with embedded screenshots
// -------------------------------------------------------------------------
app.use('/api/export/html', express.json({limit: '50mb'}))

app.post('/api/export/html', async (req, res) => {
    try {
        const {variantIds, screenshots, filters: clientFilters, exportConfig: clientExportConfig} = req.body || {}
        const exportCfg = mergeWithDefaults(clientExportConfig || {genomeBuild: GENOME})

        let filtered
        if (Array.isArray(variantIds) && variantIds.length > 0) {
            filtered = variants.filter(v => variantIds.includes(v.id))
        } else {
            filtered = applyFilters(req.query)
        }

        if (filtered.length === 0) {
            return res.status(400).json({error: 'No variants to export'})
        }

        const hasScreenshots = screenshots && typeof screenshots === 'object' && Object.keys(screenshots).length > 0
        const exportCols = [...headerColumns, 'curation_status', 'curation_note']
        const uniqueCols = filterColumns([...new Set(exportCols)], exportCfg.variantColumns)

        // Build screenshot file map
        const screenshotFiles = {}
        if (hasScreenshots) {
            for (const v of filtered) {
                const imgData = screenshots[String(v.id)]
                if (!imgData) continue
                const fname = `screenshot_${v.id}_${v.chrom}_${v.pos}.png`
                screenshotFiles[String(v.id)] = fname
            }
        }

        // Build gene summary
        const geneCol = headerColumns.includes('gene') ? 'gene' : null
        const geneSummary = []
        if (geneCol) {
            const geneMap = {}
            for (const v of filtered) {
                const gene = v[geneCol]
                if (!gene) continue
                if (!geneMap[gene]) geneMap[gene] = {gene, total: 0, pass: 0, fail: 0, uncertain: 0, pending: 0}
                geneMap[gene].total++
                geneMap[gene][v.curation_status || 'pending']++
            }
            geneSummary.push(...Object.values(geneMap).sort((a, b) => b.total - a.total))
        }

        // Build filter summary (human-readable for the HTML report header)
        const filterEntries = []
        if (clientFilters && typeof clientFilters === 'object') {
            for (const [key, value] of Object.entries(clientFilters)) {
                if (value === '' || value === null || value === undefined) continue
                if (key === 'page' || key === 'per_page' || key === 'order') continue

                if (key === 'functional_filter') {
                    filterEntries.push({
                        label: 'Functional Filter',
                        value: functionalFilterToHuman(value)
                    })
                } else if (key === 'sort') {
                    const orderVal = clientFilters.order || 'asc'
                    filterEntries.push({label: 'Sort', value: `${value} (${orderVal})`})
                } else {
                    filterEntries.push({
                        label: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
                        value: String(value)
                    })
                }
            }
        }

        // Build curation stats
        const stats = {pass: 0, fail: 0, uncertain: 0, pending: 0}
        for (const v of filtered) {
            stats[v.curation_status || 'pending']++
        }

        // Generate the HTML (pass raw screenshots for data URI embedding)
        const html = buildExportHtml(filtered, uniqueCols, screenshotFiles, screenshots || {}, geneSummary, filterEntries, stats, geneCol)

        // Create ZIP archive
        res.setHeader('Content-Type', 'application/zip')
        res.setHeader('Content-Disposition', 'attachment; filename="variants_export.zip"')

        const archive = archiver('zip', {zlib: {level: 6}})
        archive.on('error', err => {
            log.error('HTML export archive error:', err.message)
            if (!res.headersSent) res.status(500).json({error: 'Failed to generate HTML export'})
        })
        archive.pipe(res)

        // Add HTML file
        archive.append(html, {name: 'variants_report/index.html'})

        // Add screenshot images
        if (hasScreenshots) {
            for (const v of filtered) {
                const imgData = screenshots[String(v.id)]
                if (!imgData || !screenshotFiles[String(v.id)]) continue
                let base64 = imgData
                if (base64.startsWith('data:image/jpeg;base64,')) {
                    base64 = base64.replace('data:image/jpeg;base64,', '')
                } else if (base64.startsWith('data:image/png;base64,')) {
                    base64 = base64.replace('data:image/png;base64,', '')
                }
                archive.append(Buffer.from(base64, 'base64'), {
                    name: `variants_report/screenshots/${screenshotFiles[String(v.id)]}`
                })
            }
        }

        await archive.finalize()
    } catch (err) {
        log.error('HTML export error:', err.message)
        if (!res.headersSent) res.status(500).json({error: 'Failed to generate HTML export'})
    }
})

/**
 * Build a self-contained, interactive HTML report for variant export.
 * Screenshots are embedded as base64 data URIs so the HTML works without
 * extracting image files from the ZIP.
 */
function buildExportHtml(variants, columns, screenshotFiles, screenshots, geneSummary, filterEntries, stats, geneCol) {
    const totalVariants = variants.length
    const hasScreenshots = Object.keys(screenshotFiles).length > 0
    const escHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

    // Build table rows JSON for client-side filtering.
    // Embed screenshot data URIs directly so the HTML is self-contained.
    const variantData = variants.map(v => {
        const row = {}
        for (const col of columns) {
            row[col] = v[col] ?? ''
        }
        row._id = v.id
        row._hasScreenshot = !!screenshotFiles[String(v.id)]
        row._screenshotFile = screenshotFiles[String(v.id)] || ''
        // Embed the data URI for self-contained HTML; fall back to
        // relative path for the ZIP-extracted screenshots/ directory
        row._screenshotDataUri = screenshots[String(v.id)] || ''
        return row
    })

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Variant Review Report</title>
<style>
  :root {
    --primary: #2c3e50; --primary-light: #34495e; --accent: #3498db;
    --success: #27ae60; --danger: #e74c3c; --warning: #f39c12; --muted: #95a5a6;
    --bg: #f5f7fa; --card-bg: #ffffff; --border: #e1e8ed;
    --text: #2c3e50; --text-light: #7f8c8d;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
  .container { max-width: 1600px; margin: 0 auto; padding: 20px; }
  header { background: linear-gradient(135deg, var(--primary), var(--primary-light)); color: white; padding: 24px 32px; border-radius: 12px; margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; }
  header h1 { font-size: 1.5rem; font-weight: 600; }
  header .meta { font-size: 0.85rem; opacity: 0.85; }
  .stats-bar { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
  .stat-card { background: var(--card-bg); border-radius: 8px; padding: 14px 20px; flex: 1; min-width: 140px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); border-left: 4px solid var(--border); text-align: center; }
  .stat-card .stat-value { font-size: 1.8rem; font-weight: 700; }
  .stat-card .stat-label { font-size: 0.8rem; color: var(--text-light); text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-card.pass { border-left-color: var(--success); } .stat-card.pass .stat-value { color: var(--success); }
  .stat-card.fail { border-left-color: var(--danger); } .stat-card.fail .stat-value { color: var(--danger); }
  .stat-card.uncertain { border-left-color: var(--warning); } .stat-card.uncertain .stat-value { color: var(--warning); }
  .stat-card.pending { border-left-color: var(--muted); } .stat-card.pending .stat-value { color: var(--muted); }
  .stat-card.total { border-left-color: var(--accent); } .stat-card.total .stat-value { color: var(--accent); }

  .tabs { display: flex; gap: 4px; margin-bottom: 0; border-bottom: 2px solid var(--border); }
  .tab { padding: 10px 20px; cursor: pointer; background: transparent; border: none; font-size: 0.9rem; color: var(--text-light); border-bottom: 2px solid transparent; margin-bottom: -2px; transition: all 0.2s; }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
  .tab-content { display: none; } .tab-content.active { display: block; }

  .panel { background: var(--card-bg); border-radius: 0 0 12px 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); padding: 20px; margin-bottom: 24px; }
  .toolbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
  .search-box { padding: 8px 14px; border: 1px solid var(--border); border-radius: 6px; font-size: 0.9rem; width: 300px; outline: none; transition: border-color 0.2s; }
  .search-box:focus { border-color: var(--accent); }
  .filter-select { padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; font-size: 0.85rem; background: white; cursor: pointer; }
  .result-count { font-size: 0.85rem; color: var(--text-light); margin-left: auto; }

  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  thead th { background: var(--primary); color: white; padding: 10px 12px; text-align: left; font-weight: 600; cursor: pointer; user-select: none; white-space: nowrap; position: sticky; top: 0; z-index: 10; }
  thead th:hover { background: var(--primary-light); }
  thead th .sort-arrow { margin-left: 4px; opacity: 0.5; font-size: 0.7rem; }
  thead th.sorted .sort-arrow { opacity: 1; }
  tbody td { padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  tbody tr:hover { background: #eef2f7; }
  tbody tr.status-pass { background: #d5f5e3; } tbody tr.status-pass:hover { background: #c1f0d5; }
  tbody tr.status-fail { background: #fadbd8; } tbody tr.status-fail:hover { background: #f5c6c0; }
  tbody tr.status-uncertain { background: #fdebd0; } tbody tr.status-uncertain:hover { background: #fce0b4; }
  .table-wrapper { overflow-x: auto; max-height: 70vh; overflow-y: auto; }

  .status-badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
  .status-badge.pass { background: #d5f5e3; color: #1e8449; }
  .status-badge.fail { background: #fadbd8; color: #c0392b; }
  .status-badge.uncertain { background: #fdebd0; color: #d68910; }
  .status-badge.pending { background: #eaeded; color: #7f8c8d; }

  .screenshot-link { color: var(--accent); text-decoration: none; font-weight: 500; }
  .screenshot-link:hover { text-decoration: underline; }

  .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 1000; justify-content: center; align-items: center; }
  .modal-overlay.active { display: flex; }
  .modal { background: white; border-radius: 12px; max-width: 95vw; max-height: 95vh; overflow: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
  .modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: white; z-index: 1; }
  .modal-header h3 { font-size: 1rem; }
  .modal-close { background: none; border: none; font-size: 1.5rem; cursor: pointer; color: var(--text-light); padding: 4px 8px; border-radius: 4px; }
  .modal-close:hover { background: #f0f0f0; color: var(--text); }
  .modal-body { padding: 20px; }
  .modal-body img { max-width: 100%; height: auto; border-radius: 4px; }
  .modal-nav { display: flex; justify-content: space-between; padding: 12px 20px; border-top: 1px solid var(--border); }
  .modal-nav button { padding: 6px 16px; border: 1px solid var(--border); border-radius: 6px; background: white; cursor: pointer; font-size: 0.85rem; }
  .modal-nav button:hover { background: #f0f0f0; }
  .modal-nav button:disabled { opacity: 0.4; cursor: default; }
  .modal-info { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 0.85rem; margin-bottom: 12px; }
  .modal-info dt { font-weight: 600; color: var(--text-light); }
  .modal-info dd { color: var(--text); }

  .gene-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
  .gene-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
  .gene-card h4 { font-size: 1rem; margin-bottom: 8px; color: var(--primary); }
  .gene-card .gene-stats { display: flex; gap: 8px; flex-wrap: wrap; }
  .gene-card .gene-stat { font-size: 0.8rem; padding: 2px 8px; border-radius: 4px; }

  .filter-chips { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
  .filter-chip { background: #eaf2f8; color: var(--accent); padding: 4px 12px; border-radius: 16px; font-size: 0.8rem; }
  .filter-chip strong { margin-right: 4px; }

  .pagination { display: flex; gap: 4px; justify-content: center; align-items: center; margin-top: 16px; }
  .pagination button { padding: 6px 12px; border: 1px solid var(--border); border-radius: 4px; background: white; cursor: pointer; font-size: 0.85rem; }
  .pagination button:hover { background: #f0f0f0; }
  .pagination button.active { background: var(--accent); color: white; border-color: var(--accent); }
  .pagination button:disabled { opacity: 0.4; cursor: default; }
  .pagination .page-info { font-size: 0.85rem; color: var(--text-light); margin: 0 8px; }

  ${hasScreenshots ? `
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
  .gallery-item { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; cursor: pointer; transition: box-shadow 0.2s; }
  .gallery-item:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.12); }
  .gallery-item img { width: 100%; height: 200px; object-fit: cover; border-bottom: 1px solid var(--border); }
  .gallery-item .gallery-info { padding: 10px 12px; }
  .gallery-item .gallery-info h4 { font-size: 0.9rem; margin-bottom: 4px; }
  .gallery-item .gallery-info p { font-size: 0.8rem; color: var(--text-light); }
  ` : ''}

  @media (max-width: 768px) {
    .container { padding: 12px; }
    header { padding: 16px; }
    .stats-bar { flex-direction: column; }
    .toolbar { flex-direction: column; }
    .search-box { width: 100%; }
    table { font-size: 0.75rem; }
  }

  @media print {
    .toolbar, .tabs, .pagination, .modal-overlay { display: none !important; }
    .tab-content { display: block !important; page-break-inside: avoid; }
    header { background: var(--primary) !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <div>
      <h1>🧬 Variant Review Report</h1>
      <div class="meta">Generated ${new Date().toLocaleDateString('en-US', {year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'})} · ${totalVariants} variants</div>
    </div>
  </header>

  ${filterEntries.length > 0 ? `
  <div class="filter-chips">
    <strong style="font-size:0.85rem;color:var(--text-light);margin-right:4px;">Applied Filters:</strong>
    ${filterEntries.map(f => `<span class="filter-chip"><strong>${escHtml(f.label)}:</strong> ${escHtml(f.value)}</span>`).join('')}
  </div>
  ` : ''}

  <div class="stats-bar">
    <div class="stat-card total"><div class="stat-value">${totalVariants}</div><div class="stat-label">Total</div></div>
    <div class="stat-card pass"><div class="stat-value">${stats.pass}</div><div class="stat-label">Pass</div></div>
    <div class="stat-card fail"><div class="stat-value">${stats.fail}</div><div class="stat-label">Fail</div></div>
    <div class="stat-card uncertain"><div class="stat-value">${stats.uncertain}</div><div class="stat-label">Uncertain</div></div>
    <div class="stat-card pending"><div class="stat-value">${stats.pending}</div><div class="stat-label">Pending</div></div>
  </div>

  <div class="tabs">
    <button class="tab active" data-tab="variants">📋 Variants</button>
    ${hasScreenshots ? '<button class="tab" data-tab="gallery">🖼️ Screenshots</button>' : ''}
    ${geneSummary.length > 0 ? '<button class="tab" data-tab="genes">🧬 Gene Summary</button>' : ''}
  </div>

  <div class="panel">
    <!-- Variants Tab -->
    <div id="tab-variants" class="tab-content active">
      <div class="toolbar">
        <input type="text" class="search-box" id="searchBox" placeholder="Search variants…">
        <select class="filter-select" id="statusFilter">
          <option value="">All Statuses</option>
          <option value="pass">Pass</option>
          <option value="fail">Fail</option>
          <option value="uncertain">Uncertain</option>
          <option value="pending">Pending</option>
        </select>
        ${geneCol ? `<select class="filter-select" id="geneFilter"><option value="">All Genes</option></select>` : ''}
        <span class="result-count" id="resultCount"></span>
      </div>
      <div class="table-wrapper">
        <table id="variantTable">
          <thead><tr id="tableHead"></tr></thead>
          <tbody id="tableBody"></tbody>
        </table>
      </div>
      <div class="pagination" id="pagination"></div>
    </div>

    ${hasScreenshots ? `
    <!-- Gallery Tab -->
    <div id="tab-gallery" class="tab-content">
      <div class="toolbar">
        <input type="text" class="search-box" id="gallerySearch" placeholder="Search screenshots…">
        <span class="result-count" id="galleryCount"></span>
      </div>
      <div class="gallery" id="galleryGrid"></div>
    </div>
    ` : ''}

    ${geneSummary.length > 0 ? `
    <!-- Gene Summary Tab -->
    <div id="tab-genes" class="tab-content">
      <div class="gene-grid" id="geneGrid"></div>
    </div>
    ` : ''}
  </div>
</div>

<!-- Screenshot Modal -->
<div class="modal-overlay" id="screenshotModal">
  <div class="modal">
    <div class="modal-header">
      <h3 id="modalTitle">Screenshot</h3>
      <button class="modal-close" id="modalClose">×</button>
    </div>
    <div class="modal-body">
      <dl class="modal-info" id="modalInfo"></dl>
      <img id="modalImg" src="" alt="Screenshot">
    </div>
    <div class="modal-nav">
      <button id="modalPrev">← Previous</button>
      <button id="modalNext">Next →</button>
    </div>
  </div>
</div>

<script>
(function() {
  const VARIANTS = ${JSON.stringify(variantData)};
  const COLUMNS = ${JSON.stringify(columns)};
  const GENE_SUMMARY = ${JSON.stringify(geneSummary)};
  const HAS_SCREENSHOTS = ${hasScreenshots};
  const PAGE_SIZE = 50;
  let currentPage = 1;
  let sortCol = null;
  let sortAsc = true;
  let filteredVariants = [...VARIANTS];
  let currentModalIdx = -1;
  let screenshotVariants = [];

  // Escape HTML
  function esc(s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }

  // Format column name
  function fmtCol(c) { return c.replace(/_/g, ' ').replace(/\\b\\w/g, s => s.toUpperCase()); }

  // --- Tab switching ---
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
  });

  // --- Build table header ---
  const thead = document.getElementById('tableHead');
  if (HAS_SCREENSHOTS) {
    const th = document.createElement('th');
    th.textContent = '📷';
    th.style.width = '50px';
    thead.appendChild(th);
  }
  COLUMNS.forEach(col => {
    const th = document.createElement('th');
    th.innerHTML = esc(fmtCol(col)) + ' <span class="sort-arrow">⇅</span>';
    th.dataset.col = col;
    th.addEventListener('click', () => {
      if (sortCol === col) { sortAsc = !sortAsc; }
      else { sortCol = col; sortAsc = true; }
      currentPage = 1;
      renderTable();
    });
    thead.appendChild(th);
  });

  // --- Populate gene filter ---
  ${geneCol ? `
  const geneFilter = document.getElementById('geneFilter');
  const genes = [...new Set(VARIANTS.map(v => v.gene).filter(Boolean))].sort();
  genes.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g; opt.textContent = g;
    geneFilter.appendChild(opt);
  });
  geneFilter.addEventListener('change', () => { currentPage = 1; applyFilters(); });
  ` : ''}

  // --- Filtering ---
  function applyFilters() {
    const search = document.getElementById('searchBox').value.toLowerCase();
    const status = document.getElementById('statusFilter').value;
    ${geneCol ? "const gene = document.getElementById('geneFilter').value;" : "const gene = '';"}

    filteredVariants = VARIANTS.filter(v => {
      if (status && (v.curation_status || 'pending') !== status) return false;
      if (gene && v.gene !== gene) return false;
      if (search) {
        const match = COLUMNS.some(c => String(v[c] ?? '').toLowerCase().includes(search));
        if (!match) return false;
      }
      return true;
    });
    renderTable();
  }

  document.getElementById('searchBox').addEventListener('input', () => { currentPage = 1; applyFilters(); });
  document.getElementById('statusFilter').addEventListener('change', () => { currentPage = 1; applyFilters(); });

  // --- Sort & Render Table ---
  function renderTable() {
    let data = [...filteredVariants];
    if (sortCol) {
      data.sort((a, b) => {
        let va = a[sortCol] ?? '', vb = b[sortCol] ?? '';
        if (typeof va === 'number' && typeof vb === 'number') return sortAsc ? va - vb : vb - va;
        va = String(va).toLowerCase(); vb = String(vb).toLowerCase();
        return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      });
    }
    // Update sort arrows
    document.querySelectorAll('#tableHead th').forEach(th => {
      th.classList.toggle('sorted', th.dataset.col === sortCol);
      const arrow = th.querySelector('.sort-arrow');
      if (arrow) arrow.textContent = th.dataset.col === sortCol ? (sortAsc ? '↑' : '↓') : '⇅';
    });

    const totalPages = Math.max(1, Math.ceil(data.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * PAGE_SIZE;
    const pageData = data.slice(start, start + PAGE_SIZE);

    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = '';
    pageData.forEach((v, idx) => {
      const tr = document.createElement('tr');
      const status = v.curation_status || 'pending';
      tr.className = 'status-' + status;

      if (HAS_SCREENSHOTS) {
        const td = document.createElement('td');
        if (v._hasScreenshot) {
          const a = document.createElement('a');
          a.href = '#';
          a.className = 'screenshot-link';
          a.textContent = '📷';
          a.title = 'View screenshot';
          a.addEventListener('click', (e) => { e.preventDefault(); openModal(v._id); });
          td.appendChild(a);
        }
        tr.appendChild(td);
      }

      COLUMNS.forEach(col => {
        const td = document.createElement('td');
        if (col === 'curation_status') {
          const badge = document.createElement('span');
          badge.className = 'status-badge ' + status;
          badge.textContent = status;
          td.appendChild(badge);
        } else {
          td.textContent = v[col] ?? '';
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    document.getElementById('resultCount').textContent = data.length + ' of ' + VARIANTS.length + ' variants';
    renderPagination(totalPages);
  }

  function renderPagination(totalPages) {
    const div = document.getElementById('pagination');
    div.innerHTML = '';
    if (totalPages <= 1) return;
    const prev = document.createElement('button');
    prev.textContent = '← Prev';
    prev.disabled = currentPage <= 1;
    prev.addEventListener('click', () => { currentPage--; renderTable(); });
    div.appendChild(prev);

    const info = document.createElement('span');
    info.className = 'page-info';
    info.textContent = 'Page ' + currentPage + ' of ' + totalPages;
    div.appendChild(info);

    const next = document.createElement('button');
    next.textContent = 'Next →';
    next.disabled = currentPage >= totalPages;
    next.addEventListener('click', () => { currentPage++; renderTable(); });
    div.appendChild(next);
  }

  // --- Screenshot Modal ---
  function openModal(variantId) {
    screenshotVariants = filteredVariants.filter(v => v._hasScreenshot);
    currentModalIdx = screenshotVariants.findIndex(v => v._id === variantId);
    if (currentModalIdx < 0) return;
    showModalContent();
    document.getElementById('screenshotModal').classList.add('active');
  }

  function showModalContent() {
    const v = screenshotVariants[currentModalIdx];
    if (!v) return;
    document.getElementById('modalTitle').textContent = (v.chrom || '') + ':' + (v.pos || '') + ' ' + (v.ref || '') + '→' + (v.alt || '');
    document.getElementById('modalImg').src = v._screenshotDataUri || ('screenshots/' + v._screenshotFile);
    const info = document.getElementById('modalInfo');
    info.innerHTML = '';
    ['gene', 'impact', 'inheritance', 'curation_status', 'curation_note'].forEach(key => {
      if (v[key]) {
        const dt = document.createElement('dt'); dt.textContent = fmtCol(key);
        const dd = document.createElement('dd'); dd.textContent = v[key];
        info.appendChild(dt); info.appendChild(dd);
      }
    });
    document.getElementById('modalPrev').disabled = currentModalIdx <= 0;
    document.getElementById('modalNext').disabled = currentModalIdx >= screenshotVariants.length - 1;
  }

  document.getElementById('modalClose').addEventListener('click', () => {
    document.getElementById('screenshotModal').classList.remove('active');
  });
  document.getElementById('screenshotModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('active');
  });
  document.getElementById('modalPrev').addEventListener('click', () => {
    if (currentModalIdx > 0) { currentModalIdx--; showModalContent(); }
  });
  document.getElementById('modalNext').addEventListener('click', () => {
    if (currentModalIdx < screenshotVariants.length - 1) { currentModalIdx++; showModalContent(); }
  });
  document.addEventListener('keydown', (e) => {
    if (!document.getElementById('screenshotModal').classList.contains('active')) return;
    if (e.key === 'Escape') document.getElementById('screenshotModal').classList.remove('active');
    if (e.key === 'ArrowLeft') document.getElementById('modalPrev').click();
    if (e.key === 'ArrowRight') document.getElementById('modalNext').click();
  });

  ${hasScreenshots ? `
  // --- Screenshot Gallery ---
  function renderGallery() {
    const search = (document.getElementById('gallerySearch')?.value || '').toLowerCase();
    const items = VARIANTS.filter(v => v._hasScreenshot && (!search || COLUMNS.some(c => String(v[c] ?? '').toLowerCase().includes(search))));
    const grid = document.getElementById('galleryGrid');
    grid.innerHTML = '';
    items.forEach(v => {
      const imgSrc = v._screenshotDataUri || ('screenshots/' + v._screenshotFile);
      const div = document.createElement('div');
      div.className = 'gallery-item';
      div.innerHTML = '<img src="' + esc(imgSrc) + '" alt="Screenshot" loading="lazy">'
        + '<div class="gallery-info"><h4>' + esc(v.chrom) + ':' + esc(v.pos) + ' ' + esc(v.ref) + '→' + esc(v.alt) + '</h4>'
        + '<p>' + esc(v.gene || '') + (v.curation_status ? ' · <span class="status-badge ' + (v.curation_status || 'pending') + '">' + esc(v.curation_status || 'pending') + '</span>' : '') + '</p></div>';
      div.addEventListener('click', () => openModal(v._id));
      grid.appendChild(div);
    });
    document.getElementById('galleryCount').textContent = items.length + ' screenshots';
  }
  document.getElementById('gallerySearch')?.addEventListener('input', renderGallery);
  renderGallery();
  ` : ''}

  ${geneSummary.length > 0 ? `
  // --- Gene Summary ---
  (function() {
    const grid = document.getElementById('geneGrid');
    GENE_SUMMARY.forEach(g => {
      const div = document.createElement('div');
      div.className = 'gene-card';
      div.innerHTML = '<h4>' + esc(g.gene) + '</h4>'
        + '<div class="gene-stats">'
        + '<span class="gene-stat" style="background:#eaf2f8;color:var(--accent);">' + g.total + ' total</span>'
        + (g.pass ? '<span class="gene-stat" style="background:#d5f5e3;color:#1e8449;">' + g.pass + ' pass</span>' : '')
        + (g.fail ? '<span class="gene-stat" style="background:#fadbd8;color:#c0392b;">' + g.fail + ' fail</span>' : '')
        + (g.uncertain ? '<span class="gene-stat" style="background:#fdebd0;color:#d68910;">' + g.uncertain + ' uncertain</span>' : '')
        + (g.pending ? '<span class="gene-stat" style="background:#eaeded;color:#7f8c8d;">' + g.pending + ' pending</span>' : '')
        + '</div>';
      grid.appendChild(div);
    });
  })();
  ` : ''}

  // Initial render
  renderTable();
})();
</script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Start server (only when run directly, not when required for testing)
// ---------------------------------------------------------------------------
loadVariants()
loadSampleQc(SAMPLE_QC_FILE)

if (require.main === module) {
    app.listen(PORT, HOST, () => {
        log.info(`IGV Variant Review Server started`)
        log.info(`URL:        http://${HOST}:${PORT}`)
        log.info(`Variants:   ${variants.length} loaded`)
        log.info(`Genome:     ${GENOME}`)
        log.info(`Data dir:   ${DATA_DIR}`)
        if (sampleQcTrios.length > 0) {
            log.info(`Sample QC:  ${sampleQcTrios.length} trios loaded`)
        }
        if (ENABLE_CRAM_MD5_CHECK) {
            log.info(`CRAM MD5:   reference checks enabled (--check-md5)`)
        }
        if (BED_TRACK_CONFIGS.length > 0) {
            log.info(`BED tracks: ${BED_TRACK_CONFIGS.length} track(s) configured`)
            BED_TRACK_CONFIGS.forEach(t => log.info(`  - ${t.name}: ${t.path}`))
        }
        // Pre-fetch MitoCarta (CC BY-NC, from the Broad) so the first export isn't slow;
        // non-blocking and best-effort — offline deployments just skip the mito dimensions.
        mitocarta.ensureData().then(ok => { if (ok) log.info('MitoCarta:  dimensions ready') }).catch(() => {})
    })
}

module.exports = app
// Exposed for unit tests (the samples tab is otherwise only emitted when the
// loaded data has a sample column, which the test fixtures lack).
module.exports.buildGeneAnalysisTab = buildGeneAnalysisTab
module.exports.buildGaDerivationSheet = buildGaDerivationSheet
module.exports.GA_SAMPLE_TRACK = GA_SAMPLE_TRACK
module.exports.GA_DNM_TRACK = GA_DNM_TRACK
module.exports.buildDnmRateCategoryTab = buildDnmRateCategoryTab
module.exports.buildDnmRatePerGeneTab = buildDnmRatePerGeneTab
