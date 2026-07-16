/**
 * Per-gene de novo mutation RATES for the mutation-rate test (Test B).
 *
 * A plain offline loader for data/annotations/dnm_rates.json.gz — per-gene,
 * per-class, PER-TRANSMISSION de novo probabilities from the Samocha 2014
 * trinucleotide model, bundled from the DeNovoWEST release (MIT). Not an
 * annotation-registry provider: these are model inputs for one test, never
 * per-gene Gene-Summary columns.
 *
 *   {pSyn, pMis, pNonSplice, chr, hgnc}   keyed by UPPER gene symbol
 *
 * pNonSplice = p_all − p_syn − p_mis: nonsense + essential-splice SNVs. It is
 * deliberately NOT the source table's p_lof, which includes frameshift and
 * therefore cannot be paired with an SNV-only observed count.
 *
 * WHY A SEPARATE BUNDLE FROM gnomAD. λ used to be built from gnomAD's
 * lof.mu/mis.mu/syn.mu. Those are a MUTABILITY COVARIATE, not a rate — gnomAD
 * fits `expected = mu·slope + intercept` and refits the slope, so mu is
 * identified only up to a proportionality constant. Summed, it predicts 0.276
 * coding de novo per trio against a published ~1.0–1.3, and its class balance
 * is separately wrong (lof.mu/syn.mu = 0.319 vs ~0.168). This table sums to
 * 1.074 per trio at a ratio of 0.161. The gnomAD columns remain in the export
 * as a mutability covariate — they are simply not a de novo rate.
 *
 * Build: `node scripts/build-annotation-data.js dnmRates`.
 * A missing/corrupt file degrades to "rates unavailable" ⇒ Test B is skipped,
 * never silently computed against a partial table.
 *
 * Citation: Kaplanis & Samocha et al., Nature 2020;586:757 (DeNovoWEST);
 * Samocha et al., Nat Genet 2014;46:944 (the rate model). Licence: MIT.
 */

'use strict'

const fs = require('fs')
const zlib = require('zlib')
const path = require('path')
const log = require('./logger')

const FILE = path.join(__dirname, 'data', 'annotations', 'dnm_rates.json.gz')

let cache = null          // Map<UPPER, rec> once loaded
let meta = null
let loaded = false

/**
 * Load (once) and return the rate map. Empty Map when the bundle is absent —
 * callers must treat an empty map as "Test B unavailable", not "no rates ⇒ 0".
 * @returns {Map<string,{pSyn:number,pMis:number,pNonSplice:number,chr:string,hgnc:string|null}>}
 */
function getRates() {
    if (loaded) return cache
    loaded = true
    cache = new Map()
    try {
        const parsed = JSON.parse(zlib.gunzipSync(fs.readFileSync(FILE)).toString('utf-8'))
        meta = parsed.meta || null
        for (const [gene, rec] of Object.entries(parsed.genes || {})) {
            if (rec) cache.set(gene.toUpperCase(), rec)
        }
    } catch (err) {
        // Absent bundle is a normal degradation (a fresh checkout before the build,
        // or a trimmed image). Anything else is worth a line in the log.
        if (err.code !== 'ENOENT') log.warn('dnm-rates: bundle unreadable —', err.message)
        cache = new Map()
    }
    return cache
}

/** Provenance for the Methods block (source, model, citation, licence). */
function getMeta() { getRates(); return meta }

/** True when a usable rate table is present. */
function available() { return getRates().size > 0 }

/** Test hook — drop the cache so a rebuilt bundle is re-read. */
function reset() { cache = null; meta = null; loaded = false }

module.exports = {getRates, getMeta, available, reset, FILE}
