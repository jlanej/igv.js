/**
 * Gene-set libraries for the Gene Analysis convergence tab.
 *
 * Each bundled library maps `gene (UPPER symbol) -> [set names]` (Reactome and
 * WikiPathways pathways, HGNC gene families, MSigDB Hallmark processes). They
 * are grouping dimensions for convergence — NOT per-gene Gene-Summary columns
 * (a gene belongs to many pathways), so this is a plain loader rather than an
 * annotation-registry provider.
 *
 * Fully offline (gzipped JSON snapshots under data/genesets/, built by
 * scripts/build-annotation-data.js) with clean licences, so exports work with
 * no network and stay byte-reproducible. A missing file degrades to "library
 * unavailable" — the dimension is simply skipped.
 */

'use strict'

const fs = require('fs')
const zlib = require('zlib')
const path = require('path')
const log = require('./logger')

const DATA_DIR = path.join(__dirname, 'data', 'genesets')

// dimId (== bundle meta.id, == export-config geneAnalysis toggle key) -> file.
// Order here is the display order of the convergence sections.
const MANIFEST = [
    {id: 'reactome',       file: 'reactome.json.gz',        fallbackLabel: 'Pathway (Reactome)'},
    {id: 'wikipathways',   file: 'wikipathways.json.gz',    fallbackLabel: 'Pathway (WikiPathways)'},
    {id: 'hgncFamily',     file: 'hgnc_family.json.gz',     fallbackLabel: 'Gene family (HGNC)'},
    {id: 'msigdbHallmark', file: 'msigdb_hallmark.json.gz', fallbackLabel: 'Hallmark process (MSigDB)'},
]

// id -> {meta, genes: Map<UPPER_SYMBOL,[terms]>} | null (load failed / missing)
const cache = new Map()

function loadLibrary(id) {
    if (cache.has(id)) return cache.get(id)
    const entry = MANIFEST.find(m => m.id === id)
    if (!entry) { cache.set(id, null); return null }
    const file = path.join(DATA_DIR, entry.file)
    let lib = null
    try {
        if (!fs.existsSync(file)) {
            log.warn(`Gene-set library not found (skipping "${id}" convergence dimension): ${file}`)
        } else {
            const parsed = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf-8'))
            lib = {meta: parsed.meta || {id}, genes: new Map(Object.entries(parsed.genes || {}))}
        }
    } catch (err) {
        log.warn(`Failed to load gene-set library "${id}": ${err.message}`)
    }
    cache.set(id, lib)
    return lib
}

/** Manifest entries whose bundle file is present, in display order. */
function available() {
    const out = []
    for (const m of MANIFEST) {
        const lib = loadLibrary(m.id)
        if (lib) out.push({id: m.id, label: (lib.meta && lib.meta.label) || m.fallbackLabel, meta: lib.meta})
    }
    return out
}

/** Map<UPPER_SYMBOL,[terms]> for one library, or an empty Map if unavailable. */
function libMap(id) {
    const lib = loadLibrary(id)
    return lib ? lib.genes : new Map()
}

/** meta block (source/version/license/url) for the Read Me + attribution. */
function meta(id) {
    const lib = loadLibrary(id)
    return lib ? lib.meta : null
}

/** One-line attribution strings for every available library. */
function attributions(ids) {
    const wanted = ids ? new Set(ids) : null
    return available()
        .filter(a => !wanted || wanted.has(a.id))
        .map(a => {
            const m = a.meta || {}
            const lic = m.license ? ` (${m.license})` : ''
            const ver = m.version ? `, ${m.version}` : ''
            return `${a.label}: ${m.source || a.id}${ver}${lic} — ${m.url || ''}`.trim()
        })
}

/** Force reload on next use (testing helper). */
function reset() { cache.clear() }

module.exports = {available, libMap, meta, attributions, loadLibrary, reset, MANIFEST, DATA_DIR}
