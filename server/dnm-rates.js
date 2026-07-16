/**
 * Per-gene de novo mutation RATES for the mutation-rate test (Test B).
 *
 * A plain offline loader for the bundled per-gene, per-class, PER-TRANSMISSION de
 * novo probabilities from the Samocha 2014 trinucleotide model. Not an
 * annotation-registry provider: these are model inputs for one test, never
 * per-gene Gene-Summary columns.
 *
 *   {pSyn, pMis, pNonSplice, pLof, chr, hgnc?}   keyed by UPPER gene symbol
 *
 *   pNonSplice — nonsense + essential-splice SNVs ONLY.
 *   pLof       — the same PLUS frameshift. Frameshift is recovered as pLof − pNonSplice.
 * The two pair with DIFFERENT observed counts: pair pNonSplice with an SNV-only count,
 * pLof with a count that admits frameshift de novo indels. Mixing them moves λ by 1.85×.
 *
 * TWO TABLES SHIP, and both are served here. They are the SAME 2014 rate model on
 * DIFFERENT TRANSCRIPTS, and they agree to 0.6% per gene (median ratio 1.002, p10 0.994,
 * p90 1.006). That agreement is the point: Test B reports λ under both, so a reader can
 * SEE that the rate source is not what carries a finding rather than take our word for it.
 *
 *   'denovowest' (dnm_rates.json.gz)      — DeNovoWEST's published per-gene table (MIT).
 *      Published provenance; regenerable with one fetch (`node scripts/build-annotation-data.js
 *      dnmRates`). 20,453 genes, 819 on X. Cost: 2014-era transcripts, so joining to current
 *      symbols needs HGNC prev/alias resolution (868 rescued, 25 rejected by a chromosome
 *      guard, 98.55% join), and 67 genes carry p_all=NA and get no rate at all — MYC among them.
 *
 *   'mane' (dnm_rates.mane.json.gz)       — denovonear 0.13.0 (MIT) over MANE Select v1.5 /
 *      GRCh38. 19,228 genes, 834 on X, current symbols so the join is direct, and MYC has a
 *      rate. Cost: NOT regenerable from `npm` (needs python + denovonear + a MANE GTF + a
 *      GRCh38 FASTA offline — see scripts/build-dnm-rates-mane.py), so the built bundle is
 *      committed.
 *
 * Field parity between the two is deliberate and load-bearing: dnm-enrichment.js consumes
 * either with NO code change, so "report both" costs a second load, not a second engine.
 *
 * WHY NOT gnomAD. λ used to be built from gnomAD's lof.mu/mis.mu/syn.mu. Those are a
 * MUTABILITY COVARIATE, not a rate — gnomAD fits `expected = mu·slope + intercept` and refits
 * the slope. Summed they predict 0.276 coding de novo per trio against a published ~1.0–1.3,
 * and the class balance is separately wrong (lof.mu/syn.mu = 0.319 vs ~0.168). The rejection is
 * stronger than a scale miss: measured, gnomAD.mu ÷ Samocha.p is not even a CONSTANT across
 * genes (synonymous median 0.264, p10 0.137, p90 0.451 — a 3.3× spread), so NO rescaling could
 * rescue those columns. They remain in the export as a labelled mutability covariate.
 *
 * A missing/corrupt file degrades to "rates unavailable" ⇒ Test B is skipped for that table,
 * never silently computed against a partial one.
 *
 * Citations: Samocha et al., Nat Genet 2014;46:944 (the rate model); Kaplanis & Samocha et al.,
 * Nature 2020;586:757 + HurlesGroupSanger/DeNovoWEST (the published table, MIT);
 * denovonear — github.com/jeremymcrae/denovonear (MIT); MANE Select v1.5 — Morales et al.,
 * Nature 2022;604:310. All redistributable.
 */

'use strict'

const fs = require('fs')
const zlib = require('zlib')
const path = require('path')
const log = require('./logger')

const DIR = path.join(__dirname, 'data', 'annotations')

// The registry. `id` is what export-config's ratePrimary names and what the workbook prints.
const TABLES = {
    denovowest: {
        id: 'denovowest',
        label: 'DeNovoWEST (published table)',
        transcripts: 'DeNovoWEST release transcripts (2014-era); current symbols via HGNC prev/alias',
        file: path.join(DIR, 'dnm_rates.json.gz'),
        build: 'node scripts/build-annotation-data.js dnmRates'
    },
    mane: {
        id: 'mane',
        label: 'denovonear on MANE Select v1.5 / GRCh38',
        transcripts: 'MANE Select v1.5 / GRCh38 (current symbols, direct join)',
        file: path.join(DIR, 'dnm_rates.mane.json.gz'),
        build: 'python3 scripts/build-dnm-rates-mane.py <denovonear rates output>  (offline)'
    }
}
const DEFAULT_TABLE = 'denovowest'

const cache = {}          // id -> {rates: Map, meta: Object|null}

function load(id) {
    const t = TABLES[id]
    if (!t) throw new Error(`dnm-rates: unknown table '${id}' (have: ${Object.keys(TABLES).join(', ')})`)
    if (cache[id]) return cache[id]
    const entry = {rates: new Map(), meta: null}
    try {
        const parsed = JSON.parse(zlib.gunzipSync(fs.readFileSync(t.file)).toString('utf-8'))
        entry.meta = parsed.meta || null
        for (const [gene, rec] of Object.entries(parsed.genes || {})) {
            if (rec) entry.rates.set(gene.toUpperCase(), rec)
        }
    } catch (err) {
        // An absent bundle is a normal degradation (fresh checkout before the build, or a
        // trimmed image). Anything else is worth a line in the log.
        if (err.code !== 'ENOENT') log.warn(`dnm-rates: bundle unreadable (${id}) —`, err.message)
    }
    cache[id] = entry
    return entry
}

/**
 * Load (once) and return a rate map. Empty Map when that bundle is absent — callers must
 * treat an empty map as "this table unavailable", not "no rates ⇒ 0".
 * @param {string} [id='denovowest']
 * @returns {Map<string,{pSyn:number,pMis:number,pNonSplice:number,pLof:number,chr:string,hgnc?:string|null}>}
 */
function getRates(id = DEFAULT_TABLE) { return load(id).rates }

/** Provenance for the Methods block (source, model, citation, licence, gates). */
function getMeta(id = DEFAULT_TABLE) { return load(id).meta }

/** True when a usable rate table is present. */
function available(id = DEFAULT_TABLE) { return getRates(id).size > 0 }

/** Descriptor {id,label,transcripts,file,build} — what the workbook prints as provenance. */
function describe(id = DEFAULT_TABLE) { return TABLES[id] || null }

/** Table ids that actually have a readable bundle right now, in registry order. */
function availableTables() { return Object.keys(TABLES).filter(available) }

/** Test hook — drop the cache so a rebuilt bundle is re-read. */
function reset() { for (const k of Object.keys(cache)) delete cache[k] }

module.exports = {
    getRates, getMeta, available, describe, availableTables, reset,
    TABLES, DEFAULT_TABLE,
    // Back-compat: the DeNovoWEST path some call sites still reference by name.
    FILE: TABLES.denovowest.file
}
