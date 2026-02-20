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
const HOST = getArg('host', '127.0.0.1')

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
let variants = []
let headerColumns = []

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
                console.log('Migrating curation file to stable key format...')
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

    // Perform migration save after defaults are applied
    if (fs.existsSync(CURATION_FILE)) {
        try {
            const curationData = JSON.parse(fs.readFileSync(CURATION_FILE, 'utf-8'))
            const hasLegacyKeys = Object.keys(curationData).some(k => /^\d+$/.test(k))
            if (hasLegacyKeys) saveCuration()
        } catch (_) { /* already warned above */ }
    }

    console.log(`Loaded ${variants.length} variants from ${VARIANTS_FILE}`)
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
        if (nonEmpty.length > 0 && numericCount / nonEmpty.length > 0.5) {
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

        // --- Send workbook as download --------------------------------------
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        res.setHeader('Content-Disposition', 'attachment; filename="variants_export.xlsx"')
        await workbook.xlsx.write(res)
        res.end()
    } catch (err) {
        console.error('XLSX export error:', err)
        res.status(500).json({error: 'Failed to generate XLSX export'})
    }
})

// ---------------------------------------------------------------------------
// Start server (only when run directly, not when required for testing)
// ---------------------------------------------------------------------------
loadVariants()

if (require.main === module) {
    app.listen(PORT, HOST, () => {
        console.log(`\n  IGV Variant Review Server`)
        console.log(`  URL:        http://${HOST}:${PORT}`)
        console.log(`  Variants:   ${variants.length} loaded`)
        console.log(`  Genome:     ${GENOME}`)
        console.log(`  Data dir:   ${DATA_DIR}\n`)
    })
}

module.exports = app
