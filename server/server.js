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
// Sheet rendering lives in ./export — pure (workbook, data, styles) functions with no
// request or module state. server.js decides WHAT to build; those decide how it LOOKS.
const {buildReadmeSheet, buildGaDerivationSheet, buildGeneAnalysisTab,
    buildDnmRateCategoryTab, buildDnmRatePerGeneTab,
    GA_SAMPLE_TRACK, GA_DNM_TRACK} = require('./export/xlsx-sheets')
const {buildExportHtml} = require('./export/html-export')
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
                    // Gene weights = each gene's coding de novo mutational target, from the
                    // SAME rate table Test B uses. DIAGNOSTIC ONLY — Test A's null stays a
                    // gene-count null; this is passed so the sheet can SHOW how much of a
                    // category's fold is just gene size rather than leave a reader to assume
                    // none of it is. Absent bundle ⇒ no weights ⇒ the column reads "—".
                    const rateW = new Map()
                    for (const [g, r] of dnmRates.getRates()) {
                        const w = (r.pNonSplice || 0) + (r.pMis || 0) + (r.pSyn || 0)
                        if (w > 0) rateW.set(g, w)
                    }
                    sourceUniverse = sourceUniverseStats({gnomad: gnB, clinvar: clinvarProvider.getGenes(), gencc: genccProvider.getGenes()}, gsLibs, rateW)
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
                        // Which of the two bundled rate tables drives the TEST. Both are the same
                        // Samocha-2014 model on different transcripts and agree to 0.6% per gene,
                        // so this is a provenance choice, not a statistical one: 'denovowest' is
                        // the published table and is regenerable with one fetch; 'mane' has current
                        // symbols and covers MYC (which DeNovoWEST leaves rate-less) but needs an
                        // offline rebuild. The other table is reported alongside as a cross-check.
                        const primaryTable = (exportCfg.geneAnalysis && exportCfg.geneAnalysis.ratePrimary) || dnmRates.DEFAULT_TABLE
                        const rates = dnmRates.getRates(primaryTable)
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
                            // The 4th arg decides whether the frameshift TARGET is summed, and it must
                            // match what computeModelEnrichment can COUNT — hence the same
                            // `consequenceCol` expression feeds both. VEP IMPACT cannot separate
                            // frameshift from nonsense, so without a Consequence column the LoF tier
                            // is SNV-only on BOTH sides. computeModelEnrichment throws if these
                            // disagree, and the surrounding try/catch drops the tab: a missing tab
                            // beats one whose LoF λ is 1.85x too large.
                            const rateBundles = {gnomad: gnB, clinvar: clinvarProvider.getGenes(), gencc: genccProvider.getGenes()}
                            const categoryMu = categoryRateSums(rates, rateBundles, gsLibs, !!consequenceCol)
                            // THE CROSS-CHECK TABLE. Two independently-built tables of the SAME
                            // Samocha-2014 model on DIFFERENT transcripts (DeNovoWEST's published
                            // 2014-era set vs denovonear on MANE Select v1.5/GRCh38). They agree to
                            // 0.6% per gene, and printing both λ lets a reader CHECK that the rate
                            // source is not carrying a finding instead of taking our word. It yields
                            // a second λ only — no second p, no second BH family. Absent bundle ⇒
                            // null ⇒ the columns simply do not appear.
                            const altId = dnmRates.availableTables().find(t => t !== primaryTable) || null
                            const altRates = altId ? dnmRates.getRates(altId) : null
                            const altCategoryMu = (altRates && altRates.size)
                                ? categoryRateSums(altRates, rateBundles, gsLibs, !!consequenceCol) : null
                            const dnm = computeModelEnrichment(filtered, {
                                model: DE_NOVO, geneCol, impactCol: gaImpactCol, consequenceCol, statusCol: 'curation_status',
                                sampleCol: xlsSampleCol, chromCol: 'chrom', refCol: 'ref', altCol: 'alt', inheritanceCol,
                                geneTerms, dimensions, muByGene: rates, categoryMu,
                                rateTable: dnmRates.describe(primaryTable),
                                altMuByGene: altRates, altCategoryMu, altTable: altId ? dnmRates.describe(altId) : null,
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
