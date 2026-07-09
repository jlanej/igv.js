/**
 * ClinVar Gene-Level Provider
 *
 * Surfaces per-gene ClinVar aggregate counts (Pathogenic / Likely-pathogenic
 * allele count and a Has-P/LP flag) from a bundled, slimmed snapshot of NCBI's
 * `gene_specific_summary.txt`.
 *
 * Data licence: ClinVar is US-government public domain; NCBI imposes no
 * distribution restrictions on the aggregate counts, so they are safe to embed
 * in exported reports (attribution requested). The bundled file is built by
 * `scripts/build-annotation-data.js`.
 *
 * The provider is offline (no network at export time): it loads the gzipped
 * JSON once into memory and does O(1) symbol lookups. A missing data file
 * degrades to blank cells rather than an error.
 */

'use strict'

const fs = require('fs')
const zlib = require('zlib')
const path = require('path')
const log = require('../logger')

const DATA_FILE = path.join(__dirname, '..', 'data', 'annotations', 'clinvar_gene_summary.json.gz')

let genes = null          // Map<UPPER_SYMBOL, {plp, vus, conflicts, total}>
let loadAttempted = false

function load() {
    if (loadAttempted) return
    loadAttempted = true
    try {
        if (!fs.existsSync(DATA_FILE)) {
            log.warn(`ClinVar data file not found (skipping ClinVar annotations): ${DATA_FILE}`)
            genes = new Map()
            return
        }
        const raw = zlib.gunzipSync(fs.readFileSync(DATA_FILE)).toString('utf-8')
        const payload = JSON.parse(raw)
        genes = new Map(Object.entries(payload.genes || {}))
    } catch (err) {
        log.warn(`Failed to load ClinVar data: ${err.message}`)
        genes = new Map()
    }
}

function providerCfg(cfg) {
    return (cfg && cfg.geneAnnotations && cfg.geneAnnotations.clinvar) || {}
}

function isEnabled(cfg) {
    const ga = cfg && cfg.geneAnnotations
    const c = ga && ga.clinvar
    return !!(ga && ga.enabled && c && c.enabled)
}

async function fetchBatch(geneList /*, cfg */) {
    load()
    const out = new Map()
    for (const g of geneList) {
        const up = String(g).toUpperCase()
        out.set(up, genes.get(up) || null)   // null = gene not present in ClinVar summary
    }
    return out
}

function columns(cfg) {
    const c = providerCfg(cfg)
    const cols = []
    if (c.plp !== false) cols.push({header: 'ClinVar P/LP', key: 'clinvarPlp', width: 12})
    if (c.hasPlp !== false) cols.push({header: 'Has P/LP', key: 'clinvarHasPlp', width: 10})
    if (c.vus) cols.push({header: 'ClinVar VUS', key: 'clinvarVus', width: 12})
    if (c.conflicts) cols.push({header: 'ClinVar Conflicts', key: 'clinvarConflicts', width: 16})
    return cols
}

function toRow(obj, cfg) {
    const c = providerCfg(cfg)
    const has = obj && !obj.error
    const cells = {}
    if (c.plp !== false) cells.clinvarPlp = has ? obj.plp : ''
    if (c.hasPlp !== false) cells.clinvarHasPlp = has ? (obj.plp > 0 ? 'Yes' : 'No') : ''
    if (c.vus) cells.clinvarVus = has ? obj.vus : ''
    if (c.conflicts) cells.clinvarConflicts = has ? obj.conflicts : ''
    return cells
}

/** Force a reload on next use (testing helper). */
function reset() { genes = null; loadAttempted = false }

module.exports = {
    id: 'clinvar',
    attribution: 'NCBI ClinVar gene summary (P/LP counts), public domain — https://www.ncbi.nlm.nih.gov/clinvar',
    isEnabled, fetchBatch, columns, toRow, load, reset, DATA_FILE
}
