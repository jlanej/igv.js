/**
 * gnomAD Constraint Provider
 *
 * Fetches gene-level loss-of-function / missense constraint from the public
 * gnomAD GraphQL API (https://gnomad.broadinstitute.org/api, no API key).
 * Multiple genes are batched into a single aliased GraphQL query.
 *
 * Data licence: gnomAD constraint metrics are released openly (CC0 / "free of
 * restrictions"; attribution requested) and are safe to embed in exported
 * reports. See https://gnomad.broadinstitute.org/policies.
 *
 * Genome build → dataset: hg38/GRCh38 ⇒ gnomAD v4 constraint; hg19/GRCh37 ⇒
 * v2.1.1 (LOEUF runs systematically lower on v2 — the column header records
 * which version was used).
 *
 * Graceful fallback: any network/parse failure yields blank cells plus an
 * error entry for the Annotation Status sheet; the export never hard-fails.
 */

'use strict'

const log = require('../logger')

const GNOMAD_API = 'https://gnomad.broadinstitute.org/api'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24 hours
const CHUNK_SIZE = 75                       // genes per aliased GraphQL request
const TIMEOUT_MS = 8000

// In-memory cache: `${build}:${SYMBOL}` → {data, fetchedAt}
const cache = new Map()

/** Map an export genome build to a gnomAD reference_genome enum. */
function refGenome(cfg) {
    const b = String((cfg && cfg.genomeBuild) || 'hg38').toLowerCase()
    if (b === 'hg19' || b === 'grch37' || b === 'hg37' || b === 'b37') return 'GRCh37'
    return 'GRCh38'
}

function providerCfg(cfg) {
    return (cfg && cfg.geneAnnotations && cfg.geneAnnotations.gnomadConstraint) || {}
}

function isEnabled(cfg) {
    const ga = cfg && cfg.geneAnnotations
    const c = ga && ga.gnomadConstraint
    return !!(ga && ga.enabled && c && c.enabled)
}

/**
 * Convert a raw gnomad_constraint object into our flat annotation.
 * Returns null when no constraint is available for the gene.
 */
function parseConstraint(gc) {
    if (!gc) return null
    const loeuf = typeof gc.oe_lof_upper === 'number' ? gc.oe_lof_upper : null
    const pli = typeof gc.pLI === 'number' ? gc.pLI : null
    const misZ = typeof gc.mis_z === 'number' ? gc.mis_z : null
    // "LoF-constrained" flag: conservative union of the two classic signals.
    // pLI >= 0.9 (LoF-intolerant) OR LOEUF < 0.35 (upper CI of observed/expected).
    const constrained = (pli != null && pli >= 0.9) || (loeuf != null && loeuf < 0.35)
    return {loeuf, pli, misZ, constrained}
}

/** Fetch one chunk of genes; returns Map<UPPER_SYMBOL, parsed|{error}>. */
async function fetchChunk(genes, build) {
    const out = new Map()
    const aliases = genes.map((g, i) =>
        `g${i}: gene(gene_symbol: ${JSON.stringify(g)}, reference_genome: ${build}) ` +
        `{ symbol gnomad_constraint { pLI oe_lof_upper mis_z } }`)
    const query = `{ ${aliases.join(' ')} }`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
        const resp = await fetch(GNOMAD_API, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'Accept': 'application/json'},
            body: JSON.stringify({query}),
            signal: controller.signal
        })
        clearTimeout(timer)
        if (!resp.ok) {
            for (const g of genes) out.set(String(g).toUpperCase(), {error: `gnomAD HTTP ${resp.status}`})
            return out
        }
        const body = await resp.json()
        const data = (body && body.data) || {}
        genes.forEach((g, i) => {
            const node = data[`g${i}`]
            out.set(String(g).toUpperCase(), node ? parseConstraint(node.gnomad_constraint) : null)
        })
        return out
    } catch (err) {
        clearTimeout(timer)
        const msg = err.name === 'AbortError' ? 'gnomAD request timed out' : `gnomAD error: ${err.message}`
        for (const g of genes) out.set(String(g).toUpperCase(), {error: msg})
        return out
    }
}

async function fetchBatch(genes, cfg) {
    const build = refGenome(cfg)
    const result = new Map()
    const toFetch = []

    for (const g of genes) {
        const up = String(g).toUpperCase()
        const cached = cache.get(`${build}:${up}`)
        if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
            result.set(up, cached.data)
        } else if (!toFetch.includes(g)) {
            toFetch.push(g)
        }
    }

    for (let i = 0; i < toFetch.length; i += CHUNK_SIZE) {
        const chunk = toFetch.slice(i, i + CHUNK_SIZE)
        const map = await fetchChunk(chunk, build)
        for (const g of chunk) {
            const up = String(g).toUpperCase()
            const data = map.get(up)
            result.set(up, data)
            // Cache successes and confirmed "no data" (null); never cache errors.
            if (!(data && data.error)) cache.set(`${build}:${up}`, {data: data || null, fetchedAt: Date.now()})
        }
    }
    return result
}

function columns(cfg) {
    const c = providerCfg(cfg)
    const ver = refGenome(cfg) === 'GRCh37' ? 'v2.1.1' : 'v4'
    const cols = []
    if (c.loeuf !== false) cols.push({header: `gnomAD LOEUF (${ver})`, key: 'gnomadLoeuf', width: 16})
    if (c.pli !== false) cols.push({header: 'gnomAD pLI', key: 'gnomadPli', width: 11})
    if (c.constrainedFlag !== false) cols.push({header: 'LoF-constrained', key: 'gnomadConstrained', width: 15})
    if (c.misZ) cols.push({header: 'gnomAD mis_z', key: 'gnomadMisZ', width: 12})
    return cols
}

function round(x, d) { const f = Math.pow(10, d); return Math.round(x * f) / f }

function toRow(obj, cfg) {
    const c = providerCfg(cfg)
    const has = obj && !obj.error
    const cells = {}
    if (c.loeuf !== false) cells.gnomadLoeuf = (has && obj.loeuf != null) ? round(obj.loeuf, 2) : ''
    if (c.pli !== false) cells.gnomadPli = (has && obj.pli != null) ? round(obj.pli, 2) : ''
    if (c.constrainedFlag !== false) cells.gnomadConstrained = has ? (obj.constrained ? 'Yes' : 'No') : ''
    if (c.misZ) cells.gnomadMisZ = (has && obj.misZ != null) ? round(obj.misZ, 2) : ''
    return cells
}

/** Clear the constraint cache (testing helper). */
function clearCache() { cache.clear() }

module.exports = {
    id: 'gnomad',
    attribution: 'gnomAD gene constraint (pLI/LOEUF), CC0 — https://gnomad.broadinstitute.org',
    isEnabled, fetchBatch, columns, toRow,
    parseConstraint, refGenome, clearCache
}
