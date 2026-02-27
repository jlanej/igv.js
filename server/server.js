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

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
function getArg(name, defaultValue) {
    const idx = args.indexOf(`--${name}`)
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultValue
}

const PORT = parseInt(getArg('port', '3000'), 10)
const VARIANTS_FILE = getArg('variants', path.join(__dirname, 'example_data', 'variants.tsv'))
const DATA_DIR = getArg('data-dir', getArg('data_dir', path.join(__dirname, 'example_data')))
const CURATION_FILE = getArg('curation-file', VARIANTS_FILE.replace(/\.tsv$/, '.curation.json'))
const FILTERS_FILE = getArg('filters-file', VARIANTS_FILE.replace(/\.tsv$/, '.filters.json'))
const SAMPLE_QC_FILE = getArg('sample-qc', null)
const VCF_FILE = getArg('vcf', null)
const VCF_SAMPLES = getArg('vcf-samples', null)  // e.g. "proband:NA12878,mother:NA12891,father:NA12892"
const GENOME = getArg('genome', 'hg38')
const HOST = getArg('host', '127.0.0.1')

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

    for (const [key, val] of Object.entries(query)) {
        if (key === 'page' || key === 'per_page' || key === 'sort' || key === 'order' || key === 'search') continue
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
app.use(express.json({limit: '50mb'}))
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
        qcMetricThresholds: QC_METRIC_THRESHOLDS
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

// Gene-level summary (post-filtering)
app.get('/api/summary', (req, res) => {
    const filtered = applyFilters(req.query)
    const geneCol = headerColumns.includes('gene') ? 'gene' : null
    if (!geneCol) {
        return res.json({summary: [], message: 'No gene column found in data'})
    }

    const sampleCol = ['sample_id', 'trio_id'].find(c => headerColumns.includes(c)) || null

    const geneMap = {}
    for (const v of filtered) {
        const gene = v[geneCol]
        if (!gene) continue
        if (!geneMap[gene]) {
            geneMap[gene] = {gene, total: 0, pass: 0, fail: 0, uncertain: 0, pending: 0, _samples: new Set(), variants: []}
        }
        geneMap[gene].total++
        geneMap[gene][v.curation_status || 'pending']++
        if (sampleCol && v[sampleCol]) geneMap[gene]._samples.add(v[sampleCol])
        geneMap[gene].variants.push({
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
// XLSX Export – publication-quality workbook with variant data and optional
// IGV screenshots on per-variant tabs, linked from the main sheet.
// -------------------------------------------------------------------------
app.use('/api/export/xlsx', express.json({limit: '50mb'}))

app.post('/api/export/xlsx', async (req, res) => {
    try {
        const {variantIds, screenshots, filters: clientFilters} = req.body || {}

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

        // --- Main "Variants" worksheet --------------------------------------
        const exportCols = [...headerColumns, 'curation_status', 'curation_note']
        const uniqueCols = [...new Set(exportCols)]

        // If screenshots are present, prepend a "Screenshot" link column
        const hasScreenshots = screenshots && typeof screenshots === 'object' && Object.keys(screenshots).length > 0
        const mainCols = hasScreenshots ? ['Screenshot', ...uniqueCols] : [...uniqueCols]

        const ws = workbook.addWorksheet('Variants', {
            views: [{state: 'frozen', ySplit: 1}]
        })

        // Column definitions
        ws.columns = mainCols.map(col => ({
            header: col.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            key: col,
            width: col === 'curation_note' ? 30 : col === 'Screenshot' ? 14 : Math.max(12, col.length + 4)
        }))

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
        })

        // Auto-filter on the main sheet
        if (filtered.length > 0) {
            ws.autoFilter = {from: 'A1', to: {row: 1, column: mainCols.length}}
        }

        // --- Gene Summary worksheet -----------------------------------------
        const geneCol = headerColumns.includes('gene') ? 'gene' : null
        const xlsSampleCol = ['sample_id', 'trio_id'].find(c => headerColumns.includes(c)) || null
        if (geneCol) {
            const geneMap = {}
            for (const v of filtered) {
                const gene = v[geneCol]
                if (!gene) continue
                if (!geneMap[gene]) geneMap[gene] = {gene, total: 0, samples: 0, pass: 0, fail: 0, uncertain: 0, pending: 0, _samples: new Set()}
                geneMap[gene].total++
                geneMap[gene][v.curation_status || 'pending']++
                if (xlsSampleCol && v[xlsSampleCol]) geneMap[gene]._samples.add(v[xlsSampleCol])
            }
            const geneSummary = Object.values(geneMap).map(g => {
                g.samples = g._samples.size
                delete g._samples
                return g
            }).sort((a, b) => b.total - a.total)
            if (geneSummary.length > 0) {
                const gws = workbook.addWorksheet('Gene Summary', {views: [{state: 'frozen', ySplit: 1}]})
                gws.columns = [
                    {header: 'Gene', key: 'gene', width: 16},
                    {header: 'Total', key: 'total', width: 10},
                    {header: 'Samples', key: 'samples', width: 10},
                    {header: 'Pass', key: 'pass', width: 10},
                    {header: 'Fail', key: 'fail', width: 10},
                    {header: 'Uncertain', key: 'uncertain', width: 12},
                    {header: 'Pending', key: 'pending', width: 10}
                ]
                const gsHeader = gws.getRow(1)
                gsHeader.eachCell(cell => {
                    cell.fill = headerFill; cell.font = headerFont; cell.border = borderThin
                    cell.alignment = {vertical: 'middle', horizontal: 'center'}
                })
                gsHeader.height = 24
                geneSummary.forEach((g, idx) => {
                    const row = gws.addRow(g)
                    row.eachCell(cell => {
                        cell.border = borderThin
                        if (idx % 2 === 1) cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFF8F9FA'}}
                    })
                })
                gws.autoFilter = {from: 'A1', to: {row: 1, column: 7}}
            }
        }

        // --- Sample Summary worksheet ---------------------------------------
        const impactCol = headerColumns.includes('impact') ? 'impact' : null
        const freqCol = headerColumns.find(c => c.startsWith('freq')) || null
        const sampleCol = ['sample_id', 'trio_id'].find(c => headerColumns.includes(c)) || null
        const ssThresholds = SAMPLE_SUMMARY_THRESHOLDS
        const ssImpactGroups = SAMPLE_SUMMARY_IMPACT_GROUPS
        {
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
        }

        // --- Sample QC worksheet --------------------------------------------
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

        // --- Applied Filters worksheet --------------------------------------
        if (clientFilters && typeof clientFilters === 'object' && Object.keys(clientFilters).length > 0) {
            const fws = workbook.addWorksheet('Applied Filters', {views: [{state: 'frozen', ySplit: 1}]})
            fws.columns = [
                {header: 'Filter', key: 'filter', width: 24},
                {header: 'Value', key: 'value', width: 40}
            ]
            const fHeader = fws.getRow(1)
            fHeader.eachCell(cell => {
                cell.fill = headerFill; cell.font = headerFont; cell.border = borderThin
                cell.alignment = {vertical: 'middle', horizontal: 'center'}
            })
            fHeader.height = 24
            let fIdx = 0
            for (const [key, value] of Object.entries(clientFilters)) {
                const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                const row = fws.addRow({filter: label, value: String(value)})
                row.eachCell(cell => {
                    cell.border = borderThin
                    if (fIdx % 2 === 1) cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFF8F9FA'}}
                })
                fIdx++
            }
        }

        // --- Screenshot worksheets (placed after all data tabs) --------------
        if (hasScreenshots) {
            const ssSampleCol = ['sample_id', 'trio_id'].find(c => headerColumns.includes(c)) || null
            for (const [sheetName, vid] of sheetNames) {
                const v = filtered.find(x => x.id === vid)
                const imgData = screenshots[String(vid)]
                if (!v || !imgData) continue

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

                // Back-link to the Variants sheet
                sws.getCell('D1').value = {text: '← Back to Variants', hyperlink: '#Variants!A1'}
                sws.getCell('D1').font = {color: {argb: 'FF2980B9'}, underline: true}

                // Set column widths
                sws.getColumn(1).width = 14
                sws.getColumn(2).width = 30
                sws.getColumn(3).width = 5
                sws.getColumn(4).width = 22

                // Embed the screenshot image
                const imgStartRow = infoRow + 2
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
                } catch (imgErr) {
                    sws.getCell(`A${imgStartRow}`).value = '(Screenshot could not be embedded)'
                    sws.getCell(`A${imgStartRow}`).font = {italic: true, color: {argb: 'FF999999'}}
                }
            }
        }

        // --- Send workbook as download --------------------------------------
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        res.setHeader('Content-Disposition', 'attachment; filename="variants_export.xlsx"')
        await workbook.xlsx.write(res)
        res.end()
    } catch (err) {
        log.error('XLSX export error:', err.message)
        res.status(500).json({error: 'Failed to generate XLSX export'})
    }
})

// HTML Export – interactive static HTML report with embedded screenshots
// -------------------------------------------------------------------------
app.use('/api/export/html', express.json({limit: '50mb'}))

app.post('/api/export/html', async (req, res) => {
    try {
        const {variantIds, screenshots, filters: clientFilters} = req.body || {}

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
        const uniqueCols = [...new Set(exportCols)]

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

        // Build filter summary
        const filterEntries = []
        if (clientFilters && typeof clientFilters === 'object') {
            for (const [key, value] of Object.entries(clientFilters)) {
                if (value !== '' && value !== null && value !== undefined) {
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

        // Generate the HTML
        const html = buildExportHtml(filtered, uniqueCols, screenshotFiles, geneSummary, filterEntries, stats, geneCol)

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
 */
function buildExportHtml(variants, columns, screenshotFiles, geneSummary, filterEntries, stats, geneCol) {
    const totalVariants = variants.length
    const hasScreenshots = Object.keys(screenshotFiles).length > 0
    const escHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

    // Build table rows JSON for client-side filtering
    const variantData = variants.map(v => {
        const row = {}
        for (const col of columns) {
            row[col] = v[col] ?? ''
        }
        row._id = v.id
        row._hasScreenshot = !!screenshotFiles[String(v.id)]
        row._screenshotFile = screenshotFiles[String(v.id)] || ''
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
    document.getElementById('modalImg').src = 'screenshots/' + v._screenshotFile;
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
      const div = document.createElement('div');
      div.className = 'gallery-item';
      div.innerHTML = '<img src="screenshots/' + esc(v._screenshotFile) + '" alt="Screenshot" loading="lazy">'
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
    })
}

module.exports = app
