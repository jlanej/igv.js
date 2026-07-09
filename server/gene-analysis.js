/**
 * Gene Analysis — convergence of singleton genes on shared attributes.
 *
 * Inverts the per-gene annotations: for each grouping dimension, maps
 * `term -> {individuals, genes}` over the variants in each stratification cell,
 * and keeps terms that recur.
 *
 * INDEPENDENT SIGNALS: the headline metric is the number of DISTINCT
 * INDIVIDUALS (probands/samples), NOT the number of variants. One individual
 * with several de novo hits in genes that share a term counts as 1 — so a
 * single hypermutated proband cannot masquerade as convergence. Distinct genes
 * are reported alongside (locus heterogeneity), so single-proband cohorts still
 * see gene-level convergence.
 *
 * Pure / deterministic (no I/O) so it is unit-testable in isolation.
 */

'use strict'

// Cumulative impact tiers (matches SAMPLE_SUMMARY_IMPACT_GROUPS in server.js).
const IMPACT_TIERS = [
    {key: 'HIGH', label: 'HIGH', impacts: ['HIGH']},
    {key: 'HIGH_MOD', label: 'HIGH+MOD', impacts: ['HIGH', 'MODERATE']},
    {key: 'HIGH_MOD_LOW', label: 'HIGH+MOD+LOW', impacts: ['HIGH', 'MODERATE', 'LOW']},
    // ALL: no impact restriction — includes MODIFIER, blank, and any other
    // impact value, so convergence is not limited to the HIGH/MOD/LOW set.
    {key: 'ALL', label: 'ALL', impacts: null}
]

// Curation strata.
const STATUS_FILTERS = [
    {key: 'pass', label: 'pass', match: (s) => s === 'pass'},
    {key: 'all', label: 'all', match: () => true}
]

// Grouping dimensions (v0). Each gene contributes a list of term strings per
// dimension in the `geneTerms` map supplied by the caller.
const DIMENSIONS = [
    {id: 'constraint', label: 'Constraint tail (gnomAD)'},
    {id: 'clinvar', label: 'ClinVar gene history'},
    {id: 'domain', label: 'Protein domain (InterPro)'},
    {id: 'gencc', label: 'Mode of inheritance (GenCC)'}
]

// Broadest cell (superset of all others) — used to decide which terms to show.
const REF_CELL = 'all|ALL'

function buildCells() {
    const cells = []
    for (const st of STATUS_FILTERS) {
        for (const tier of IMPACT_TIERS) {
            cells.push({key: `${st.key}|${tier.key}`, label: `${st.label}·${tier.label}`,
                statusKey: st.key, tierKey: tier.key, st, tier})
        }
    }
    return cells
}

// -------------------------------------------------------------------------
// Enrichment statistics — "is this convergence more than chance?"
//
// A gene-level over-representation test (hypergeometric / one-tailed Fisher)
// against the COHORT'S OWN eligible-gene universe (every gene carrying a
// callable variant in the loaded data), NOT the genome. Using the cohort as
// the background is what makes this defensible for de novo data: de novo
// discovery is biased toward long, mutable genes, and the cohort's
// variant-bearing genes carry that same bias, so it largely cancels. Still a
// gene-level ORA — it is NOT a de-novo mutation-rate model (that needs a
// multi-proband cohort + denovolyzeR); label it as such wherever shown.
//
// All pure, deterministic, dependency-free (log-gamma so large N is stable).
// -------------------------------------------------------------------------

// Lanczos approximation of ln Γ(x).
const LGAMMA_C = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
]
function lgamma(x) {
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x)
    x -= 1
    let a = LGAMMA_C[0]
    const t = x + 7.5
    for (let i = 1; i < 9; i++) a += LGAMMA_C[i] / (x + i)
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}
function logChoose(n, k) {
    if (k < 0 || k > n || n < 0) return -Infinity
    return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1)
}

/**
 * Upper-tail hypergeometric probability P(X >= k), where X is the number of
 * "successes" (term-members) among n draws (selected genes) from a population
 * of N (universe genes) containing K successes (universe genes in the term).
 * Returns a probability in [0,1]; 1 for k<=0, computed exactly by summation.
 */
function hypergeomUpperTail(k, N, K, n) {
    if (!(N > 0) || !(n > 0) || !(K > 0)) return null
    if (k <= 0) return 1
    if (n > N) n = N
    if (K > N) K = N
    const hi = Math.min(K, n)
    if (k > hi) return 0
    const logDenom = logChoose(N, n)
    let p = 0
    for (let i = k; i <= hi; i++) {
        p += Math.exp(logChoose(K, i) + logChoose(N - K, n - i) - logDenom)
    }
    return Math.min(1, Math.max(0, p))
}

/**
 * Benjamini-Hochberg FDR. Takes an array of p-values (nulls allowed and left
 * as null), returns an aligned array of q-values controlling the FDR across
 * all non-null tests (the whole family).
 */
function benjaminiHochberg(pvals) {
    const idx = []
    for (let i = 0; i < pvals.length; i++) if (pvals[i] != null && isFinite(pvals[i])) idx.push(i)
    const m = idx.length
    const q = pvals.map(() => null)
    if (!m) return q
    idx.sort((a, b) => pvals[a] - pvals[b])
    let prev = 1
    for (let rank = m; rank >= 1; rank--) {
        const i = idx[rank - 1]
        const val = Math.min(prev, pvals[i] * m / rank)
        q[i] = val
        prev = val
    }
    return q
}

/**
 * Count, over the cohort's eligible-gene universe, how many genes carry each
 * term per dimension — the K and N inputs to the enrichment test and the
 * denominator for the background-frequency column. Pure.
 * @param {Map<string,Object>} universeGeneTerms  gene(UPPER) -> {dimId:[terms]}
 * @returns {{counts:Object, size:number}}  counts[dimId][term] = #universe genes
 */
function universeTermCounts(universeGeneTerms) {
    const counts = {}
    let size = 0
    for (const terms of universeGeneTerms.values()) {
        size++
        for (const dimId of Object.keys(terms)) {
            const bucket = counts[dimId] || (counts[dimId] = {})
            for (const term of terms[dimId] || []) bucket[term] = (bucket[term] || 0) + 1
        }
    }
    return {counts, size}
}

/**
 * @param {Array<Object>} variants
 * @param {Object} opts
 * @param {string} opts.geneCol
 * @param {string|null} opts.impactCol
 * @param {string|null} opts.sampleCol   individual identifier column (sample_id/trio_id)
 * @param {Map<string,{constraint:string[],clinvar:string[],domain:string[]}>} opts.geneTerms  keyed by UPPERCASE gene
 * @param {number} [opts.minCount=2]      keep a term with >= this many distinct individuals OR genes
 * @returns {{cells:Array, sections:Array, hasSamples:boolean}}
 */
function computeConvergence(variants, opts) {
    const {geneCol, impactCol, sampleCol, geneTerms, minCount = 2} = opts
    const dims = opts.dimensions || DIMENSIONS
    const cells = buildCells()

    // Enrichment inputs (optional): the cohort eligible-gene universe.
    const uCounts = (opts.universeTermCounts && opts.universeTermCounts.counts) || {}
    const N = opts.universeTermCounts ? opts.universeTermCounts.size : 0   // universe gene count
    const n = opts.selectedSize || 0                                       // selected (export) gene count

    // acc[dimId][term][cellKey] = {individuals:Set, genes:Set}
    const acc = {}
    for (const d of dims) acc[d.id] = {}
    const cellGenes = {}, cellInds = {}
    for (const c of cells) { cellGenes[c.key] = new Set(); cellInds[c.key] = new Set() }

    for (const v of variants) {
        const gene = geneCol ? v[geneCol] : null
        if (!gene) continue
        const terms = geneTerms.get(String(gene).toUpperCase())
        if (!terms) continue
        const upper = String(gene).toUpperCase()
        const impact = impactCol ? String(v[impactCol] || '').toUpperCase() : ''
        const status = v.curation_status
        // The independent unit: the proband/sample. Falls back to a single
        // 'all' bucket when the data has no sample column.
        const individual = sampleCol ? (v[sampleCol] || 'unknown') : 'all'

        for (const c of cells) {
            if (!c.st.match(status)) continue
            // tier.impacts === null (ALL) means no impact restriction.
            if (impactCol && c.tier.impacts && !c.tier.impacts.includes(impact)) continue
            cellGenes[c.key].add(upper)
            cellInds[c.key].add(individual)
            for (const d of dims) {
                const tlist = terms[d.id] || []
                for (const term of tlist) {
                    const bucket = acc[d.id][term] || (acc[d.id][term] = {})
                    const cd = bucket[c.key] || (bucket[c.key] = {individuals: new Set(), genes: new Set()})
                    cd.individuals.add(individual)   // <-- dedup by individual
                    cd.genes.add(upper)
                }
            }
        }
    }

    const sections = dims.map(d => {
        const groups = []
        const dimU = uCounts[d.id] || null   // {term: #universe genes} or null (no universe data)
        for (const term of Object.keys(acc[d.id])) {
            const bucket = acc[d.id][term]
            const ref = bucket[REF_CELL] || {individuals: new Set(), genes: new Set()}
            const refIndividuals = ref.individuals.size
            const refGenes = ref.genes.size
            if (refIndividuals < minCount && refGenes < minCount) continue
            const cellCounts = {}
            for (const c of cells) {
                const cd = bucket[c.key]
                cellCounts[c.key] = cd ? {individuals: cd.individuals.size, genes: cd.genes.size}
                    : {individuals: 0, genes: 0}
            }
            // Enrichment vs the cohort universe (gene-level ORA). k = selected
            // genes in the term (ref cell), K = universe genes in the term,
            // n = selected genes, N = universe genes. bg = K/N (chance rate).
            let bg = null, enrichP = null
            if (dimU && dimU[term] != null && N > 0) {
                const K = Math.max(dimU[term], refGenes)   // export ⊆ universe → K≥k
                bg = dimU[term] / N
                enrichP = hypergeomUpperTail(refGenes, N, K, n)
            }
            groups.push({term, refIndividuals, refGenes, cells: cellCounts,
                genes: [...ref.genes].sort(), bgFreq: bg, enrichP, enrichQ: null})
        }
        // Rank by independent recurrence (individuals), then locus heterogeneity
        // (genes), then enrichment significance, then name.
        groups.sort((a, b) => b.refIndividuals - a.refIndividuals || b.refGenes - a.refGenes
            || ((a.enrichP == null ? 1 : a.enrichP) - (b.enrichP == null ? 1 : b.enrichP))
            || a.term.localeCompare(b.term))
        return {id: d.id, label: d.label, groups}
    })

    // Benjamini-Hochberg FDR across every enrichment test in the whole tab.
    const allGroups = []
    for (const s of sections) for (const g of s.groups) allGroups.push(g)
    const qvals = benjaminiHochberg(allGroups.map(g => g.enrichP))
    allGroups.forEach((g, i) => { g.enrichQ = qvals[i] })

    const cellSummary = cells.map(c => ({
        key: c.key, label: c.label, statusKey: c.statusKey, tierKey: c.tierKey,
        genes: cellGenes[c.key].size, individuals: cellInds[c.key].size
    }))

    return {cells: cellSummary, sections, hasSamples: !!sampleCol}
}

/**
 * Derive the per-gene term lists (all dimensions) from the assembled
 * annotations. Used for BOTH the export's genes and the cohort universe (with
 * providerObj built from bundle lookups and myGeneAnn=null for the universe),
 * so the two agree on how a gene maps to terms.
 * @param {string} gene
 * @param {Object} providerObj  {gnomad, clinvar, gencc} records for this gene
 * @param {Object|null} myGeneAnn  MyGene annotation (domains) — export genes only
 * @param {Object<string,Map>} [geneSetLibs]  {dimId: Map<UPPER_SYMBOL,[terms]>}
 */
function geneTermsFor(gene, providerObj, myGeneAnn, geneSetLibs) {
    const constraint = []
    const g = providerObj && providerObj.gnomad
    if (g && !g.error) {
        if (typeof g.loeuf === 'number' && g.loeuf < 0.6) constraint.push('LOEUF < 0.6 (LoF-constrained)')
        if (typeof g.pli === 'number' && g.pli >= 0.9) constraint.push('pLI ≥ 0.9')
    }
    const clinvar = []
    const c = providerObj && providerObj.clinvar
    if (c && !c.error && c.plp > 0) clinvar.push('Has ClinVar P/LP')
    const domain = (myGeneAnn && !myGeneAnn.error && Array.isArray(myGeneAnn.domains)) ? myGeneAnn.domains : []
    const gc = providerObj && providerObj.gencc
    const gencc = (gc && !gc.error && Array.isArray(gc.moi)) ? gc.moi.slice() : []
    const out = {constraint, clinvar, domain, gencc}
    if (geneSetLibs) {
        const upper = String(gene).toUpperCase()
        for (const dimId of Object.keys(geneSetLibs)) {
            const lib = geneSetLibs[dimId]
            const terms = lib && lib.get ? lib.get(upper) : null
            out[dimId] = terms ? terms.slice() : []
        }
    }
    return out
}

module.exports = {
    computeConvergence, geneTermsFor, universeTermCounts,
    hypergeomUpperTail, benjaminiHochberg,
    DIMENSIONS, IMPACT_TIERS, STATUS_FILTERS, REF_CELL
}
