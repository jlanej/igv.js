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
    if (values.length === 0) return {mean: 0, median: 0}
    const sum = values.reduce((a, b) => a + b, 0)
    const mean = Math.round((sum / values.length) * 100) / 100
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    const median = sorted.length % 2 === 0
        ? Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100
        : sorted[mid]
    return {mean, median}
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
app.use(express.json())
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

    res.json({
        total: filtered.length,
        page,
        per_page: perPage,
        pages: Math.ceil(filtered.length / perPage),
        data: annotated
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

    // Group variants by sample
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
        return {sample_id: sampleId, total: sampleVariants.length, counts}
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
        const {variantIds, screenshots} = req.body || {}

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
        const MAX_SHEET_NAME = 31  // Excel worksheet name limit

        // Data rows
        filtered.forEach((v, rowIdx) => {
            const row = {}
            for (const col of uniqueCols) {
                row[col] = v[col] ?? ''
            }

            // Create screenshot sheet name (max 31 chars for Excel)
            if (hasScreenshots && screenshots[String(v.id)]) {
                const maxBase = MAX_SHEET_NAME - 4  // room for '_NN' suffix
                const label = `${v.chrom}_${v.pos}`.replace(/[:\\/?*\[\]]/g, '_').substring(0, maxBase)
                let sheetName = label
                // Ensure unique name
                let suffix = 2
                while (sheetNames.has(sheetName)) {
                    sheetName = `${label.substring(0, maxBase - String(suffix).length - 1)}_${suffix}`
                    suffix++
                }
                sheetNames.set(sheetName, v.id)
                row['Screenshot'] = sheetName  // placeholder, will add hyperlink below
            } else if (hasScreenshots) {
                row['Screenshot'] = ''
            }

            const dataRow = ws.addRow(row)
            const excelRowNum = rowIdx + 2  // 1-based, row 1 is header

            // Style data cells
            dataRow.eachCell((cell, colNumber) => {
                cell.border = borderThin
                cell.alignment = {vertical: 'middle', wrapText: mainCols[colNumber - 1] === 'curation_note'}

                // Alternate row shading
                if (rowIdx % 2 === 1) {
                    cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFF8F9FA'}}
                }
            })

            // Color the curation status cell
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

        // --- Screenshot worksheets ------------------------------------------
        if (hasScreenshots) {
            for (const [sheetName, vid] of sheetNames) {
                const v = filtered.find(x => x.id === vid)
                const imgData = screenshots[String(vid)]
                if (!v || !imgData) continue

                const sws = workbook.addWorksheet(sheetName)

                // Header row with variant info
                sws.getCell('A1').value = 'Variant:'
                sws.getCell('A1').font = {bold: true, size: 12}
                sws.getCell('B1').value = `${v.chrom}:${v.pos} ${v.ref}→${v.alt}`
                sws.getCell('B1').font = {size: 12}

                if (v.gene) {
                    sws.getCell('A2').value = 'Gene:'
                    sws.getCell('A2').font = {bold: true}
                    sws.getCell('B2').value = v.gene
                }

                sws.getCell('A3').value = 'Status:'
                sws.getCell('A3').font = {bold: true}
                sws.getCell('B3').value = v.curation_status || 'pending'
                const sColor = statusColors[v.curation_status] || statusColors.pending
                sws.getCell('B3').font = {bold: true, color: {argb: sColor}}

                if (v.curation_note) {
                    sws.getCell('A4').value = 'Note:'
                    sws.getCell('A4').font = {bold: true}
                    sws.getCell('B4').value = v.curation_note
                }

                // Back-link to the Variants sheet
                sws.getCell('D1').value = {text: '← Back to Variants', hyperlink: '#Variants!A1'}
                sws.getCell('D1').font = {color: {argb: 'FF2980B9'}, underline: true}

                // Set column widths
                sws.getColumn(1).width = 12
                sws.getColumn(2).width = 30
                sws.getColumn(3).width = 5
                sws.getColumn(4).width = 22

                // Embed the screenshot image
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
                        base64: base64,
                        extension: extension
                    })

                    // Place image starting at row 6 to leave room for header info
                    sws.addImage(imageId, {
                        tl: {col: 0, row: 5},
                        ext: {width: 900, height: 400}
                    })
                } catch (imgErr) {
                    sws.getCell('A6').value = '(Screenshot could not be embedded)'
                    sws.getCell('A6').font = {italic: true, color: {argb: 'FF999999'}}
                }
            }
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
            const ssws = workbook.addWorksheet('Sample Summary', {views: [{state: 'frozen', ySplit: 1}]})
            // Build columns: Sample, Total, then impact_group × threshold combos
            const ssCols = [{header: 'Sample', key: 'sample', width: 16}, {header: 'Total', key: 'total', width: 10}]
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
            let ssIdx = 0
            for (const [sid, sampleVariants] of Object.entries(sampleMap)) {
                const rowData = {sample: sid, total: sampleVariants.length}
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
                const row = ssws.addRow(rowData)
                row.eachCell(cell => {
                    cell.border = borderThin
                    if (ssIdx % 2 === 1) cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFF8F9FA'}}
                })
                ssIdx++
            }
            ssws.autoFilter = {from: 'A1', to: {row: 1, column: ssCols.length}}
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
