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
const GENOME = getArg('genome', 'hg38')

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
let variants = []
let headerColumns = []

function loadVariants() {
    if (!fs.existsSync(VARIANTS_FILE)) {
        console.error(`Variants file not found: ${VARIANTS_FILE}`)
        console.error('Please provide a TSV file with --variants <path>')
        console.error('See server/README.md and server/example_data/ for format details.')
        process.exit(1)
    }

    const raw = fs.readFileSync(VARIANTS_FILE, 'utf-8')
    const lines = raw.trim().split('\n')
    if (lines.length < 2) {
        console.error('Variants file must have a header line and at least one data line.')
        process.exit(1)
    }

    headerColumns = lines[0].split('\t').map(c => c.trim())
    const required = ['chrom', 'pos', 'ref', 'alt']
    for (const r of required) {
        if (!headerColumns.includes(r)) {
            console.error(`Variants TSV missing required column: ${r}`)
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
        return obj
    })

    // Load persisted curation data
    if (fs.existsSync(CURATION_FILE)) {
        try {
            const curationData = JSON.parse(fs.readFileSync(CURATION_FILE, 'utf-8'))
            for (const [idStr, curation] of Object.entries(curationData)) {
                const id = parseInt(idStr, 10)
                const v = variants.find(x => x.id === id)
                if (v) {
                    v.curation_status = curation.status || 'pending'
                    v.curation_note = curation.note || ''
                }
            }
        } catch (e) {
            console.warn('Warning: could not parse curation file:', e.message)
        }
    }

    // Ensure defaults
    variants.forEach(v => {
        if (!v.curation_status) v.curation_status = 'pending'
        if (!v.curation_note) v.curation_note = ''
    })

    console.log(`Loaded ${variants.length} variants from ${VARIANTS_FILE}`)
}

function saveCuration() {
    const data = {}
    variants.forEach(v => {
        if (v.curation_status !== 'pending' || v.curation_note) {
            data[v.id] = {status: v.curation_status, note: v.curation_note}
        }
    })
    fs.writeFileSync(CURATION_FILE, JSON.stringify(data, null, 2), 'utf-8')
}

// ---------------------------------------------------------------------------
// Filtering helper
// ---------------------------------------------------------------------------
function applyFilters(query) {
    let filtered = [...variants]

    for (const [key, val] of Object.entries(query)) {
        if (key === 'page' || key === 'per_page' || key === 'sort' || key === 'order') continue
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
            // Exact or multi-value match (comma-separated)
            const values = val.split(',').map(s => s.trim().toLowerCase())
            filtered = filtered.filter(v => {
                const cell = String(v[key] || '').toLowerCase()
                return values.some(match => cell === match || cell.includes(match))
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
    res.json({
        genome: GENOME,
        columns: headerColumns,
        totalVariants: variants.length,
        dataDir: '/data'
    })
})

// List / filter variants
app.get('/api/variants', (req, res) => {
    const filtered = applyFilters(req.query)
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const perPage = Math.min(200, Math.max(1, parseInt(req.query.per_page, 10) || 50))
    const start = (page - 1) * perPage
    const paged = filtered.slice(start, start + perPage)

    res.json({
        total: filtered.length,
        page,
        per_page: perPage,
        pages: Math.ceil(filtered.length / perPage),
        data: paged
    })
})

// Get single variant
app.get('/api/variants/:id', (req, res) => {
    const id = parseInt(req.params.id, 10)
    const v = variants.find(x => x.id === id)
    if (!v) return res.status(404).json({error: 'Variant not found'})
    res.json(v)
})

// Batch curation (must be before :id route)
app.put('/api/variants/batch/curate', (req, res) => {
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
    const skipCols = new Set(['id', 'pos', 'ref', 'alt', 'curation_note'])
    for (const col of headerColumns) {
        if (skipCols.has(col)) continue
        const unique = [...new Set(variants.map(v => String(v[col] || '')))]
            .filter(Boolean)
            .sort()
        if (unique.length <= 100) {
            filters[col] = unique
        }
    }
    // Add curation status
    filters['curation_status'] = ['pending', 'pass', 'fail', 'uncertain']
    res.json(filters)
})

// Gene-level summary (post-filtering)
app.get('/api/summary', (req, res) => {
    const filtered = applyFilters(req.query)
    const geneCol = headerColumns.includes('gene') ? 'gene' : null
    if (!geneCol) {
        return res.json({summary: [], message: 'No gene column found in data'})
    }

    const geneMap = {}
    for (const v of filtered) {
        const gene = v[geneCol]
        if (!gene) continue
        if (!geneMap[gene]) {
            geneMap[gene] = {gene, total: 0, pass: 0, fail: 0, uncertain: 0, pending: 0, variants: []}
        }
        geneMap[gene].total++
        geneMap[gene][v.curation_status || 'pending']++
        geneMap[gene].variants.push({
            id: v.id, chrom: v.chrom, pos: v.pos, ref: v.ref, alt: v.alt,
            impact: v.impact || '', curation_status: v.curation_status
        })
    }

    const summary = Object.values(geneMap)
        .sort((a, b) => b.total - a.total)

    res.json({
        total_genes: summary.length,
        total_variants: filtered.length,
        summary
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

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
loadVariants()

app.listen(PORT, '127.0.0.1', () => {
    console.log(`\n╔══════════════════════════════════════════════════════╗`)
    console.log(`║        IGV Variant Review Server                     ║`)
    console.log(`╠══════════════════════════════════════════════════════╣`)
    console.log(`║  URL:        http://127.0.0.1:${PORT}                    ║`)
    console.log(`║  Variants:   ${variants.length} loaded${' '.repeat(Math.max(0, 33 - String(variants.length).length - 7))}║`)
    console.log(`║  Genome:     ${GENOME}${' '.repeat(Math.max(0, 40 - GENOME.length))}║`)
    console.log(`║  Data dir:   ${DATA_DIR.substring(0, 38)}${DATA_DIR.length > 38 ? '…' : ' '.repeat(Math.max(0, 40 - DATA_DIR.length))}║`)
    console.log(`╚══════════════════════════════════════════════════════╝\n`)
})
