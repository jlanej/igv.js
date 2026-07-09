/**
 * GenCC Provider — gene-disease validity + Mode of Inheritance (MOI).
 *
 * MOI is the single highest-value attribute for de novo review: it says whether
 * a gene is monoallelic/autosomal-dominant (where one de novo hit can be
 * causal). GenCC harmonises ClinGen, DDG2P, PanelApp, Orphanet and others into
 * one table; we bundle a slimmed snapshot (highest validity classification per
 * gene + the union of established-evidence MOIs), built by
 * scripts/build-annotation-data.js.
 *
 * Offline (no network at export time) and CC0 — safe to embed. Missing data
 * degrades to blank cells.
 */

'use strict'

const fs = require('fs')
const zlib = require('zlib')
const path = require('path')
const log = require('../logger')

const DATA_FILE = path.join(__dirname, '..', 'data', 'annotations', 'gencc.json.gz')

let genes = null          // Map<UPPER_SYMBOL, {validity, moi:[]}>
let loadAttempted = false

function load() {
    if (loadAttempted) return
    loadAttempted = true
    try {
        if (!fs.existsSync(DATA_FILE)) {
            log.warn(`GenCC data file not found (skipping GenCC annotations): ${DATA_FILE}`)
            genes = new Map()
            return
        }
        const raw = zlib.gunzipSync(fs.readFileSync(DATA_FILE)).toString('utf-8')
        genes = new Map(Object.entries(JSON.parse(raw).genes || {}))
    } catch (err) {
        log.warn(`Failed to load GenCC data: ${err.message}`)
        genes = new Map()
    }
}

function providerCfg(cfg) {
    return (cfg && cfg.geneAnnotations && cfg.geneAnnotations.gencc) || {}
}

function isEnabled(cfg) {
    const ga = cfg && cfg.geneAnnotations
    const c = ga && ga.gencc
    return !!(ga && ga.enabled && c && c.enabled)
}

async function fetchBatch(geneList /*, cfg */) {
    load()
    const out = new Map()
    for (const g of geneList) {
        const up = String(g).toUpperCase()
        out.set(up, genes.get(up) || null)
    }
    return out
}

function columns(cfg) {
    const c = providerCfg(cfg)
    const cols = []
    if (c.moi !== false) cols.push({header: 'GenCC MOI', key: 'genccMoi', width: 22})
    if (c.validity !== false) cols.push({header: 'GenCC Validity', key: 'genccValidity', width: 14})
    return cols
}

function toRow(obj, cfg) {
    const c = providerCfg(cfg)
    const has = obj && !obj.error
    const cells = {}
    if (c.moi !== false) cells.genccMoi = has ? (obj.moi || []).join('; ') : ''
    if (c.validity !== false) cells.genccValidity = has ? (obj.validity || '') : ''
    return cells
}

/** The loaded GenCC gene Map (for background-frequency stats). */
function getGenes() { load(); return genes }

/** Force a reload on next use (testing helper). */
function reset() { genes = null; loadAttempted = false }

module.exports = {
    id: 'gencc',
    attribution: 'GenCC gene-disease validity + Mode of Inheritance (harmonised), CC0 — https://thegencc.org',
    isEnabled, fetchBatch, columns, toRow, load, reset, getGenes, DATA_FILE
}
