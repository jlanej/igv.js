/**
 * gnomAD Constraint Provider
 *
 * Provides gene-level loss-of-function / missense constraint (LOEUF, pLI,
 * missense Z) for the Gene Summary tab.
 *
 * PRIMARY (offline): a bundled, slimmed snapshot of gnomAD v4.1 constraint
 * (MANE Select transcripts) at data/annotations/gnomad_constraint.json.gz,
 * built by scripts/build-annotation-data.js. This is used for GRCh38/hg38 and
 * needs no network at export time — mirroring the ClinVar provider.
 *
 * FALLBACK (live API): the public gnomAD GraphQL API is used only when the
 * bundled file is missing, or for GRCh37/hg19 (which the bundle does not
 * cover). The API rejects large aliased batches with HTTP 400, so queries are
 * chunked well under that limit.
 *
 * Data licence: gnomAD constraint is released openly (CC0 / "free of
 * restrictions"; attribution requested) — safe to embed in exported reports.
 *
 * Graceful fallback: any missing data / network failure yields blank cells
 * plus an Annotation Status entry; the export never hard-fails.
 */

'use strict'

const fs = require('fs')
const zlib = require('zlib')
const path = require('path')
const log = require('../logger')

const GNOMAD_API = 'https://gnomad.broadinstitute.org/api'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24 hours
// gnomAD's GraphQL endpoint rejects large aliased queries with HTTP 400 (query
// complexity limit ~25-30 genes). Stay well under it so live-fallback works.
const CHUNK_SIZE = 20                       // genes per aliased GraphQL request
const TIMEOUT_MS = 8000

const BUNDLE_FILE = path.join(__dirname, '..', 'data', 'annotations', 'gnomad_constraint.json.gz')

// Bundled (offline) constraint: Map<UPPER_SYMBOL, {loeuf, pli, misZ}>
let bundle = null
let bundleAvailable = false
let bundleLoadAttempted = false

// In-memory cache for the live fallback: `${build}:${SYMBOL}` → {data, fetchedAt}
const cache = new Map()

function loadBundle() {
    if (bundleLoadAttempted) return
    bundleLoadAttempted = true
    try {
        if (!fs.existsSync(BUNDLE_FILE)) {
            log.warn(`gnomAD bundle not found, will use live API fallback: ${BUNDLE_FILE}`)
            bundle = new Map()
            bundleAvailable = false
            return
        }
        const raw = zlib.gunzipSync(fs.readFileSync(BUNDLE_FILE)).toString('utf-8')
        const payload = JSON.parse(raw)
        bundle = new Map(Object.entries(payload.genes || {}))
        bundleAvailable = bundle.size > 0
    } catch (err) {
        log.warn(`Failed to load gnomAD bundle, will use live API fallback: ${err.message}`)
        bundle = new Map()
        bundleAvailable = false
    }
}

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

/** Convert a raw gnomad_constraint object (live API) into our flat annotation. */
function parseConstraint(gc) {
    if (!gc) return null
    const loeuf = typeof gc.oe_lof_upper === 'number' ? gc.oe_lof_upper : null
    const pli = typeof gc.pLI === 'number' ? gc.pLI : null
    const misZ = typeof gc.mis_z === 'number' ? gc.mis_z : null
    if (loeuf === null && pli === null && misZ === null) return null
    return {loeuf, pli, misZ}
}

/** LoF-constrained flag: pLI >= 0.9 OR LOEUF < 0.35 (single source of truth). */
function isConstrained(obj) {
    return (obj.pli != null && obj.pli >= 0.9) || (obj.loeuf != null && obj.loeuf < 0.35)
}

// -------------------------------------------------------------------------
// Live API fallback
// -------------------------------------------------------------------------
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

async function fetchBatchLive(genes, cfg) {
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
            if (!(data && data.error)) cache.set(`${build}:${up}`, {data: data || null, fetchedAt: Date.now()})
        }
    }
    return result
}

// -------------------------------------------------------------------------
// Public: bundled-first, live fallback
// -------------------------------------------------------------------------
async function fetchBatch(genes, cfg) {
    const build = refGenome(cfg)
    // Offline path: the bundle covers GRCh38 (gnomAD v4). Use it when present.
    if (build === 'GRCh38') {
        loadBundle()
        if (bundleAvailable) {
            const out = new Map()
            for (const g of genes) out.set(String(g).toUpperCase(), bundle.get(String(g).toUpperCase()) || null)
            return out
        }
    }
    // Fallback: live API (GRCh37 always; GRCh38 only if the bundle is missing).
    return fetchBatchLive(genes, cfg)
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
    if (c.constrainedFlag !== false) cells.gnomadConstrained = has ? (isConstrained(obj) ? 'Yes' : 'No') : ''
    if (c.misZ) cells.gnomadMisZ = (has && obj.misZ != null) ? round(obj.misZ, 2) : ''
    return cells
}

/** Clear caches / force reload (testing helper). */
function reset() { cache.clear(); bundle = null; bundleAvailable = false; bundleLoadAttempted = false }

module.exports = {
    id: 'gnomad',
    attribution: 'gnomAD v4 gene constraint (LOEUF/pLI), bundled offline, CC0 — https://gnomad.broadinstitute.org',
    isEnabled, fetchBatch, columns, toRow,
    parseConstraint, isConstrained, refGenome, reset, BUNDLE_FILE
}
