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

// Reference cell for term-keeping and all summary/enrichment stats: IGV PASS,
// any impact. The stats are pass-only by design; the grid still shows the
// all-curation rows as a quality-diagnostic (a category with many `all` but few
// `pass` variants started with a lot of poor-quality calls — suspicious).
const REF_CELL = 'pass|ALL'

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
// An OPTIONAL gene-level over-representation test (hypergeometric / one-tailed
// Fisher) backing the descriptive proportions. It runs against EACH DIMENSION's
// OWN gene universe — the genes that source actually classifies (see
// sourceUniverseStats) — and computeConvergence gates that dimension's trials to
// the same set, so the chance rate and the draws describe one gene set. It is the
// category's prevalence in that universe, NOT the cohort's variant-bearing genes.
// Still a gene-level ORA: it is a DISTRIBUTIONAL null, asking
// whether variants cluster in a category more than gene counts predict. It is
// not a mutation-rate model and does not pretend to be one — genes differ in
// length and mutability, so a category of long genes attracts more variants
// under this null than under a rate-aware one. That complementary test is a
// separate question (see dnm-enrichment.js), not a better version of this one.
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
 * Upper-tail binomial P(X >= k), X ~ Binomial(n, p). The DNM-level null: each
 * of n IGV-pass DNMs independently lands in a category gene with prob p (the
 * category's genome prevalence). Returns null for a degenerate n.
 */
function binomUpperTail(k, n, p) {
    if (!(n > 0) || p == null) return null
    if (p <= 0) return k <= 0 ? 1 : 0
    if (p >= 1) return k <= n ? 1 : 0
    if (k <= 0) return 1
    if (k > n) return 0
    const lp = Math.log(p), lq = Math.log(1 - p)
    let sum = 0
    for (let i = k; i <= n; i++) sum += Math.exp(logChoose(n, i) + i * lp + (n - i) * lq)
    return Math.min(1, Math.max(0, sum))
}

/**
 * Upper-tail Poisson-binomial P(X >= k), X = Σ Bernoulli(p_i). The CONSERVATIVE
 * SAMPLE-level null: proband i (with d_i pass DNMs) has ≥1 category DNM by
 * chance with prob p_i = 1-(1-prevalence)^{d_i} — so a hypermutated proband
 * (large d_i) is expected to hit and its single observed hit is not surprising.
 * Exact via a DP truncated at k (we only need P(X<k)). Returns null if no probs.
 */
function poissonBinomUpperTail(k, probs) {
    if (!probs || !probs.length) return null
    if (k <= 0) return 1
    const n = probs.length
    if (k > n) return 0
    const dist = new Array(k).fill(0)   // dist[j] = P(X=j), j = 0..k-1 (mass at j>=k is the tail)
    dist[0] = 1
    for (let i = 0; i < n; i++) {
        const p = probs[i]
        if (!(p > 0)) continue
        for (let j = k - 1; j >= 1; j--) dist[j] = dist[j] * (1 - p) + dist[j - 1] * p
        dist[0] = dist[0] * (1 - p)
    }
    let below = 0
    for (let j = 0; j < k; j++) below += dist[j]
    return Math.min(1, Math.max(0, 1 - below))
}

/**
 * Benjamini-Hochberg FDR. Takes an array of p-values (nulls allowed and left
 * as null), returns an aligned array of q-values controlling the FDR across
 * all non-null tests (the whole family).
 */
function benjaminiHochberg(pvals, mTotal) {
    const idx = []
    for (let i = 0; i < pvals.length; i++) if (pvals[i] != null && isFinite(pvals[i])) idx.push(i)
    const n = idx.length
    const q = pvals.map(() => null)
    if (!n) return q
    // mTotal lets a caller declare a family LARGER than the p-values passed in — for a
    // scan where the untested remainder are all exact p=1 (e.g. an exome-wide per-gene
    // scan: genes with no observed de novo have P(X≥0)=1). Padding the array with those
    // 1s would give an identical result (they sort last, each takes q=1, so `prev`
    // enters the observed ranks at 1); passing m avoids materialising ~17k rows.
    const m = (mTotal != null && mTotal > n) ? mTotal : n
    idx.sort((a, b) => pvals[a] - pvals[b])
    let prev = 1
    for (let rank = n; rank >= 1; rank--) {
        const i = idx[rank - 1]
        const val = Math.min(prev, pvals[i] * m / rank)
        q[i] = val
        prev = val
    }
    return q
}

/**
 * Per-dimension background: for each dimension d, the gene universe U_d that its
 * source actually knows about, how many of those genes carry each term, and the
 * gene set itself. {size:|U_d|, counts:{term:|K∩U_d|}, genes:Set<UPPER>}.
 *
 * EACH DIMENSION HAS ITS OWN UNIVERSE, AND THE TRIALS MUST BE GATED TO MATCH.
 * The null says "if this variant had landed in a random gene, how often would it
 * be in this category?" — and 'random gene' can only mean a gene the source could
 * have classified. gnomAD scores constraint for 17,479 genes; a gene it never
 * scored is UNMEASURED, not unconstrained. GenCC asserts on 6,099; MSigDB Hallmark
 * annotates 4,384. So computeConvergence gates each dimension's trials (its
 * binomial n, and each proband's burden dᵢ) on THIS `genes` set — that identity
 * between p's denominator and the trials is the whole point, and it is why the set
 * is returned rather than just its size.
 *
 * THE BUG THIS REPLACES: p was already per-source, but the trials stayed
 * genome-wide, so a term's share of ITS LIBRARY was tested against draws from the
 * whole genome. The damage is exact and one-directional — every dimension's
 * expected count was inflated by 1/(its coverage of the gene pool the variants
 * actually land in), because draws it could never classify were still counted as
 * trials. Simulated on the shipped bundles (N=220, genes drawn uniformly from the
 * 32,668 genes any source knows; observed/expected, 1.00 = correct):
 *
 *   dimension        U_d as % of pool   observed/expected (old)
 *   MSigDB Hallmark        13.4%              0.133
 *   WikiPathways           27.5%              0.268
 *   Reactome               35.8%              0.353
 *   HGNC families          47.7%              0.477
 *   InterPro domain        58.6%              0.590
 *
 * — the reading equals the coverage, which is the signature. So the old test was
 * never anti-conservative, it was progressively VACUOUS: on Hallmark a genuine 3x
 * enrichment would read 3 x 0.133 = 0.40x, i.e. apparent DEPLETION. Gating the
 * trials restores 0.98-1.00 across every dimension. The exact factor is cohort-
 * dependent (it follows from where that cohort's variants land), which is why each
 * section now publishes its own gated n beside the cohort-wide totals.
 *
 * WHY NOT ONE SHARED GENOME BACKGROUND: it would need a genome-wide gene list, and
 * the only protein-coding list we bundle is gnomAD's, which is AUTOSOME-ONLY —
 * gnomAD v4.1 publishes no chrX constraint at all. Gating every dimension on it
 * would drop every X-linked variant (DMD, MECP2, FMR1, DDX3X) from these tabs,
 * though ClinVar/GenCC/InterPro/Reactome all annotate them. Per-dimension
 * universes keep X wherever a library knows it, and treat "unmeasured" as
 * unmeasured instead of silently recoding it as "not a member".
 *
 * THE COST, which the sheet must state: each dimension answers a CONDITIONAL
 * question ("among genes GenCC has an assertion for, do mine converge on AD?"),
 * so folds are comparable WITHIN a dimension, not across dimensions.
 *
 * Terms are derived by calling geneTermsFor — the SAME function that derives the
 * per-gene terms for observed variants — so numerator and denominator cannot drift
 * apart. A dimension with no source is absent: no background ⇒ no test ⇒ excluded
 * from the BH family entirely.
 *
 * GENE WEIGHTS (optional, DIAGNOSTIC ONLY). The null above counts GENES: it asks whether
 * the hit genes concentrate in a category more than a random set of genes would. That is the
 * standard over-representation question and it is deliberate — the mutation-RATE question is
 * Test B's job, and there is no reason for both tests to answer the same thing.
 *
 * But a count null has a known property that the sheet must not hide: variants arrive in
 * proportion to a gene's mutational TARGET, not one-per-gene, so a category of large genes
 * collects more variants by chance than its gene share implies. Passing `geneWeights` lets
 * this function MEASURE that per category and report it, WITHOUT touching any p-value:
 *
 *     lengthBaseline = (Σw over K ÷ Σw over U) ÷ (|K| ÷ |U|)
 *
 * i.e. the fold a category would show under a rate-aware null with zero biology. Measured on
 * the shipped bundles: GenCC Autosomal recessive 1.01, Unknown 0.96 (clean); ClinVar P/LP
 * 1.27; pLI≥0.9 1.41; LOEUF<0.6 1.48 — because LOEUF cannot be estimated confidently on a
 * short gene, so the constrained set is 1.68× larger per gene on average. A reader seeing
 * "fold 3.0× · baseline 1.48×" knows ~2× is real; without it they would read 3.0× as 3.0×.
 *
 * @param {{gnomad?:Map, clinvar?:Map, gencc?:Map}} bundles  records keyed UPPER
 * @param {Object<string,Map>} [geneSetLibs]  {dimId: Map<UPPER,[terms]>}
 * @param {Map<string,number>} [geneWeights]  gene -> mutational target. DIAGNOSTIC ONLY:
 *        it never enters prevalence, p, q or the ranking. Omit it and the column is absent.
 * @returns {Object<string,{size:number, counts:Object, genes:Set<string>, wCounts?:Object, wSize?:number}>}
 */
function sourceUniverseStats(bundles, geneSetLibs, geneWeights) {
    const out = {}
    const b = bundles || {}
    const W = (geneWeights && geneWeights.size) ? geneWeights : null
    const providerFor = (g) => ({
        gnomad: b.gnomad ? b.gnomad.get(g) : null,
        clinvar: b.clinvar ? b.clinvar.get(g) : null,
        gencc: b.gencc ? b.gencc.get(g) : null
    })
    // One walk per dimension over ITS OWN source gene list. geneTermsFor returns
    // every dimension's terms for a gene; we take only this dimension's, so the
    // membership rule is defined exactly once, in one function.
    const walk = (dimId, geneKeys) => {
        const genes = new Set(), counts = {}
        // Weight sums ride along in the SAME pass, over the SAME genes, so the baseline
        // describes exactly the universe the count null uses — not a different gene set.
        const wCounts = W ? {} : null
        let wSize = 0
        for (const g of geneKeys) {
            genes.add(g)
            const w = W ? (W.get(g) || 0) : 0
            wSize += w
            const terms = geneTermsFor(g, providerFor(g), null, geneSetLibs)[dimId] || []
            for (const t of terms) {
                counts[t] = (counts[t] || 0) + 1
                if (W) wCounts[t] = (wCounts[t] || 0) + w
            }
        }
        if (genes.size) {
            out[dimId] = {size: genes.size, counts, genes}
            if (W && wSize > 0) { out[dimId].wCounts = wCounts; out[dimId].wSize = wSize }
        }
    }
    if (b.gnomad && b.gnomad.size) walk('constraint', b.gnomad.keys())
    if (b.clinvar && b.clinvar.size) walk('clinvar', b.clinvar.keys())
    if (b.gencc && b.gencc.size) walk('gencc', b.gencc.keys())
    if (geneSetLibs) {
        for (const dimId of Object.keys(geneSetLibs)) {
            const lib = geneSetLibs[dimId]
            if (lib && lib.size) walk(dimId, lib.keys())
        }
    }
    return out
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

    // Background = each dimension's OWN gene universe U_d, with its gene set, NOT the
    // cohort. srcU[dimId] = {size:|U_d|, counts:{term:|K∩U_d|}, genes:Set}.
    const srcU = opts.sourceUniverse || {}
    const totalProbands = opts.totalProbands || 0   // ALL cohort probands (grid % base)

    // acc[dimId][term][cellKey] = {individuals:Set, genes:Set, variants:count}
    const acc = {}
    for (const d of dims) acc[d.id] = {}
    const cellGenes = {}, cellInds = {}, cellVars = {}
    for (const c of cells) { cellGenes[c.key] = new Set(); cellInds[c.key] = new Set(); cellVars[c.key] = 0 }
    const passTierKeys = cells.filter(c => c.statusKey === 'pass').map(c => c.tierKey)

    // PER-DIMENSION trial state. A dimension's null draws from ITS OWN universe U_d,
    // so its binomial n and its per-proband burden dᵢ must count ONLY variants whose
    // gene is in U_d — the same set p's denominator is. A variant in a gene U_d never
    // heard of is not a draw from that dimension's null: counting it inflates n (and
    // dᵢ) against a p it could never have hit, which is exactly the bug being fixed.
    // A dimension with NO background (srcU[d] absent) is not tested at all, so it
    // needs no trial state — its universe is null and it is gated out downstream.
    const dimBurden = {}, dimNDnms = {}, dimOutside = {}
    for (const d of dims) {
        dimBurden[d.id] = {}; dimNDnms[d.id] = {}
        for (const tk of passTierKeys) { dimBurden[d.id][tk] = new Map(); dimNDnms[d.id][tk] = 0 }
        dimOutside[d.id] = {variants: 0, genes: new Set()}
    }
    // A background WITHOUT a `genes` set leaves that dimension's trials ungated. That
    // is only correct when every observed gene is in the universe by construction —
    // true for synthetic fixtures ("pretend the universe has 100 genes"), never for
    // real data. sourceUniverseStats always supplies `genes`, and a litmus test pins
    // that the export's own path does; anything hand-rolling a background must too.
    const universeOf = (dimId) => (srcU[dimId] && srcU[dimId].genes) || null

    // Cohort-wide (UNGATED) burden — descriptive only. It is the base for the grid's
    // "% of cohort probands" and the tab summary, never for a p-value: every test
    // uses its own dimension's gated burden above.
    const passBurdenByTier = {}
    for (const tk of passTierKeys) passBurdenByTier[tk] = new Map()

    for (const v of variants) {
        const gene = geneCol ? v[geneCol] : null
        if (!gene) continue
        const upper = String(gene).toUpperCase()
        const terms = geneTerms.get(upper)
        if (!terms) continue
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
            cellVars[c.key]++                        // total DNMs in this stratum
            if (c.statusKey === 'pass') {
                const bm = passBurdenByTier[c.tierKey]
                bm.set(individual, (bm.get(individual) || 0) + 1)
            }
            for (const d of dims) {
                const U = universeOf(d.id)
                if (U && !U.has(upper)) {            // not a draw from THIS dimension's null
                    if (c.key === REF_CELL) { dimOutside[d.id].variants++; dimOutside[d.id].genes.add(upper) }
                    continue
                }
                if (c.statusKey === 'pass') {        // this dimension's trials, at this tier
                    const bm = dimBurden[d.id][c.tierKey]
                    bm.set(individual, (bm.get(individual) || 0) + 1)
                    dimNDnms[d.id][c.tierKey]++
                }
                const tlist = terms[d.id] || []
                for (const term of tlist) {
                    const bucket = acc[d.id][term] || (acc[d.id][term] = {})
                    const cd = bucket[c.key] || (bucket[c.key] = {individuals: new Set(), genes: new Set(), variants: 0})
                    cd.individuals.add(individual)   // <-- dedup by individual
                    cd.genes.add(upper)
                    cd.variants++                    // DNMs hitting a category gene in this stratum
                }
            }
        }
    }

    // Cohort-wide denominators — descriptive (banners, the grid's "%"), not test inputs.
    const nPassProbands = passBurdenByTier['ALL'].size   // probands with ≥1 pass DNM
    const nPassDnms = cellVars[REF_CELL]                 // total pass DNMs (= pass|ALL)
    const burdenByTier = {}, nDnmsByTier = {}, nProbandsByTier = {}, burdenHistByTier = {}
    for (const tk of passTierKeys) {
        burdenByTier[tk] = [...passBurdenByTier[tk].values()]
        nDnmsByTier[tk] = cellVars['pass|' + tk]         // cohort pass DNMs at this tier
        nProbandsByTier[tk] = passBurdenByTier[tk].size  // cohort at-risk probands at this tier
        // Burden HISTOGRAM {d: # probands with exactly d pass DNMs at this tier}.
        // Each proband's null hit-probability pᵢ = 1-(1-prev)^dᵢ depends ONLY on dᵢ, so
        // this histogram + a category's prevalence fully determine that category's
        // Poisson-binomial — i.e. it is the complete, compact input needed to reproduce
        // every sample-test p-value externally (Excel has no Poisson-binomial function).
        const h = {}
        for (const d of burdenByTier[tk]) h[d] = (h[d] || 0) + 1
        burdenHistByTier[tk] = h
    }

    const sections = dims.map(d => {
        // allGroups = the BH FAMILY: every category with ≥1 observed gene, tested at every
        // pass tier. The display filters (minCount below, top-N in the sheet) are applied
        // AFTER the correction and cannot change any q — see the BH note below.
        const allGroups = []
        const u = srcU[d.id] || null                   // {size, counts, genes} or null (no source)
        // THIS dimension's trials: burden arrays / DNM totals counted only over genes
        // in U_d. These, not the cohort-wide ones, are every test input below — and
        // they are published per dimension so each p-value stays reproducible.
        const dTrialBurden = {}, dTrialN = {}, dTrialProbands = {}, dTrialHist = {}
        for (const tk of passTierKeys) {
            dTrialBurden[tk] = [...dimBurden[d.id][tk].values()]
            dTrialN[tk] = dimNDnms[d.id][tk]
            dTrialProbands[tk] = dimBurden[d.id][tk].size
            const h = {}
            for (const dd of dTrialBurden[tk]) h[dd] = (h[dd] || 0) + 1
            dTrialHist[tk] = h
        }
        for (const term of Object.keys(acc[d.id])) {
            const bucket = acc[d.id][term]
            const ref = bucket[REF_CELL] || {individuals: new Set(), genes: new Set(), variants: 0}
            const refIndividuals = ref.individuals.size   // pass|ALL probands (for keeping/sort/# genes)
            const refGenes = ref.genes.size
            const refVariants = ref.variants
            const cellCounts = {}
            for (const c of cells) {
                const cd = bucket[c.key]
                cellCounts[c.key] = cd ? {individuals: cd.individuals.size, genes: cd.genes.size, variants: cd.variants}
                    : {individuals: 0, genes: 0, variants: 0}
            }
            // Background: the category's share of THIS dimension's universe U_d —
            // |K∩U_d| / |U_d| — the same set dTrialBurden/dTrialN below are gated on.
            let prevalence = null, catSize = null
            if (u && u.counts[term] != null && u.size > 0) {
                catSize = u.counts[term]
                prevalence = catSize / u.size
            }
            // lengthBaseline: the fold this category would show under a RATE-AWARE null with
            // zero biology — i.e. how much of any observed fold is just gene size. Purely a
            // DIAGNOSTIC: it is reported and never used, so the test stays count-based by
            // design (see sourceUniverseStats). ~1.0 means the category is length-neutral.
            let lengthBaseline = null
            if (u && u.wCounts && u.wSize > 0 && prevalence > 0) {
                const wShare = (u.wCounts[term] || 0) / u.wSize
                if (wShare > 0) lengthBaseline = wShare / prevalence
            }
            // Enrichment PER PASS TIER, attached to each pass cell. SAMPLE =
            // Poisson-binomial with that tier's per-proband burden; DNM = binomial
            // over that tier's pass DNMs. Both are THIS DIMENSION's gated trials, so
            // the trials and the prevalence describe the same gene set.
            for (const tk of passTierKeys) {
                if (prevalence == null) continue
                const cc = cellCounts['pass|' + tk]
                // EVERY examined cell is a hypothesis — including a 0-count one, whose
                // exact upper-tail p is 1 (P(X≥0)=1; not a phantom or a placeholder).
                // It can never be rejected, but it MUST count toward the family size m.
                // Gating on an observed hit (or dropping low-count categories) would let
                // the DATA choose the family, which breaks BH: under a global null over
                // many sparse categories, the handful that happen to be hit would each be
                // corrected as if they were the only tests performed, and FDR would run
                // far above nominal. Correct for every question asked, not every hit got.
                // Call the tails UNGATED: each already returns 1 for k=0 and null for a
                // degenerate tier (no pass DNMs / no at-risk probands cohort-wide), which
                // correctly keeps a vacuous tier out of the family instead of padding it
                // with one phantom p=1 per category.
                cc.pDnm = binomUpperTail(cc.variants, dTrialN[tk], prevalence)
                if (sampleCol) {
                    cc.pSample = poissonBinomUpperTail(cc.individuals, dTrialBurden[tk].map(dd => 1 - Math.pow(1 - prevalence, dd)))
                }
                // Mean of this tier's Poisson-binomial null: Σᵢ pᵢ = Σᵢ [1-(1-prev)^dᵢ],
                // i.e. the expected # probands hitting the category by chance. Reported
                // per tier so every tier's test is reproducible from printed inputs
                // (it is defined regardless of the observed count, so no >0 gate).
                if (sampleCol && prevalence > 0) {
                    cc.expSample = dTrialBurden[tk].reduce((s, dd) => s + (1 - Math.pow(1 - prevalence, dd)), 0)
                }
                // Binomial mean for the DNM test at this tier (n·p) — same rationale.
                if (prevalence > 0) cc.expDnm = dTrialN[tk] * prevalence
            }
            // Headline folds at pass|ALL = OBSERVED ÷ EXPECTED-UNDER-THE-NULL.
            const refCC = cellCounts[REF_CELL]
            // SAMPLE fold: divide by the Poisson-binomial mean Σpᵢ — the same expectation the
            // sample p-value uses. It must NOT be (k/totalProbands)/prevalence: that divides a
            // PER-PROBAND hit rate by a PER-DRAW prevalence, so under the null its expectation is
            // the cohort's mean variant burden (E[k] ≈ p·D ⇒ E[fold] ≈ D/totalProbands), not 1.
            // Simulated on a real bundle with ZERO enrichment, that form medians 2.9× at burden 3
            // and 8.2× at burden 10 — firing the ≥5× bold-green cue on pure noise while the
            // p-value on the same row correctly reads null. Dividing by expSample re-uses the
            // burden correction the Poisson-binomial exists to apply, medians 1.0 under the null,
            // and stays reproducible: expSample is published as a live SUMPRODUCT over the
            // burden histogram on the derivation sheet.
            const expAll = refCC.expSample
            const foldSampleAll = (sampleCol && expAll > 0) ? refCC.individuals / expAll : null
            // DNM fold: k / (n·p) — observed ÷ expected, centred at 1. n is THIS
            // dimension's gated pass-DNM total, not the cohort's: dividing by the
            // cohort total while p is a share of U_d is the very mismatch being fixed.
            const foldDnmAll = (refCC.expDnm > 0) ? refCC.variants / refCC.expDnm : null
            // (The pass|ALL sample expectation lives on cells['pass|ALL'].expSample, set
            // per tier above — no separate ALL-only copy to drift out of sync.)
            allGroups.push({term, refIndividuals, refGenes, refVariants, catSize, prevalence,
                lengthBaseline,
                cells: cellCounts, genes: [...ref.genes].sort(), foldSampleAll, foldDnmAll})
        }
        // --- Benjamini-Hochberg FDR, PER DIMENSION -------------------------------
        // Two independent families (sample, DNM). Each spans this dimension's A-PRIORI
        // grid: EVERY category in the source library × every tier where the test is
        // defined — NOT merely the categories a cohort variant happened to touch.
        //
        // This is the crux. `acc` only ever holds categories some observed variant hits,
        // so correcting across those alone would let the DATA pick the family — the exact
        // error the k>0 cell gate made, one level up. It bites hardest on the sparse
        // libraries we bundle (Reactome/WikiPathways/HGNC/MitoPathways): most categories
        // go unhit, so the hit set is a small random subset and every q comes out too
        // small (simulated on the real libraries: ~15% true FDR at a nominal 5% for HGNC
        // families). An unhit category has k=0 at every tier, hence the exact p=1 — which
        // is precisely benjaminiHochberg's mTotal precondition, so we DECLARE the family
        // size rather than materialise thousands of phantom p=1 rows.
        //
        // The family is fixed BEFORE any display filter: the minCount keep-rule and the
        // sheet's top-N cap are applied afterwards and cannot shrink m.
        //
        // Validity: BH controls FDR under independence and under positive regression
        // dependence (Benjamini & Yekutieli, Ann. Stat. 2001) — the nested cumulative
        // tiers and the overlapping gene sets within a dimension are positively
        // dependent, which is the PRDS case, not the adversarial one. Discreteness (most
        // cells are exactly p=1) makes it conservative; that is the price of validity.
        const sTests = [], dTests = []
        for (const g of allGroups) for (const tk of passTierKeys) { const cc = g.cells['pass|' + tk]; sTests.push(cc); dTests.push(cc) }
        // A tier only contributes hypotheses when its test is defined cohort-wide (the
        // tails return null for a degenerate tier), so count the live tiers per track.
        const nLibTerms = u ? Object.keys(u.counts).length : 0
        // A tier contributes hypotheses only where THIS dimension's test is defined —
        // its own gated trials, not the cohort's. A tier whose gated pool is empty (no
        // pass variant landed in U_d) is vacuous and must stay OUT of m rather than pad
        // it with phantom p=1 rows and make every real q needlessly conservative.
        const dnmTiers = passTierKeys.filter(tk => dTrialN[tk] > 0).length
        const smpTiers = sampleCol ? passTierKeys.filter(tk => dTrialBurden[tk].length > 0).length : 0
        const mSample = Math.max(nLibTerms * smpTiers, sTests.filter(c => c.pSample != null).length)
        const mDnm = Math.max(nLibTerms * dnmTiers, dTests.filter(c => c.pDnm != null).length)
        benjaminiHochberg(sTests.map(c => c.pSample), mSample).forEach((q, i) => { sTests[i].qSample = q })
        benjaminiHochberg(dTests.map(c => c.pDnm), mDnm).forEach((q, i) => { dTests[i].qDnm = q })

        // DISPLAY filter — applied AFTER the correction, so every q above is unchanged by
        // it. Keep categories shared by ≥ minCount probands OR genes; the rest were still
        // tested and still counted toward m, they are just not worth a row.
        const groups = allGroups.filter(g => g.refIndividuals >= minCount || g.refGenes >= minCount)
        // Rank by pass|ALL recurrence, then genes, then pass|ALL sample p, then name.
        const psp = g => (g.cells[REF_CELL].pSample == null ? 1 : g.cells[REF_CELL].pSample)
        groups.sort((a, b) => b.refIndividuals - a.refIndividuals || b.refGenes - a.refGenes
            || (psp(a) - psp(b)) || a.term.localeCompare(b.term))
        // Each section publishes ITS OWN test inputs. The burden histogram is now a
        // per-dimension quantity (pᵢ = 1−(1−p)^dᵢ uses this dimension's gated dᵢ), so
        // the derivation sheet needs one per dimension to keep the sample p-values
        // reproducible outside Excel. nOutside* disclose what U_d could not draw.
        return {id: d.id, label: d.label, groups, sourceSize: u ? u.size : null,
            mSample, mDnm, nCategories: allGroups.length,
            available: !!u,
            nDnmsByTier: dTrialN, nProbandsByTier: dTrialProbands, burdenHistByTier: dTrialHist,
            nOutsideUniverse: u ? dimOutside[d.id].variants : 0,
            nOutsideGenes: u ? dimOutside[d.id].genes.size : 0,
            outsideGenesSample: u ? [...dimOutside[d.id].genes].sort().slice(0, 20) : []}
    })

    const cellSummary = cells.map(c => ({
        key: c.key, label: c.label, statusKey: c.statusKey, tierKey: c.tierKey,
        genes: cellGenes[c.key].size, individuals: cellInds[c.key].size, variants: cellVars[c.key]
    }))

    // Denominators for the proportions: grid % uses cohort probands; the pass
    // summary uses pass probands / pass DNMs. Per-tier n's (nDnmsByTier = binomial n
    // for the DNM test; nProbandsByTier = at-risk n for the sample test) are exported
    // so the sheet can show the exact test inputs / a reproducible Excel formula.
    // burdenHistByTier completes that: it is the sample test's remaining hidden input,
    // so publishing it makes every reported sample p-value externally reproducible.
    // NOTE the split: the top-level nDnmsByTier / nProbandsByTier / burdenHistByTier
    // are COHORT-WIDE and descriptive (banners, the grid's "%"). They are NOT the test
    // inputs — each section carries its own gated copies, because each dimension draws
    // from its own universe. Reading a p-value against these would misreproduce it.
    return {cells: cellSummary, sections, hasSamples: !!sampleCol,
        totalProbands, nPassProbands, nPassDnms, nDnmsByTier, nProbandsByTier, burdenHistByTier}
}

/**
 * Derive the per-gene term lists (all dimensions) from the assembled annotations.
 * This is the SINGLE definition of "which terms does a gene carry": the observed
 * variants' genes come through here, and so does every gene of every dimension's
 * background universe (sourceUniverseStats calls this function once per gene of
 * each source's own gene list). The numerator and the denominator of every
 * prevalence therefore agree by construction, rather than by two implementations
 * being kept in step by hand.
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
    computeConvergence, geneTermsFor, sourceUniverseStats,
    hypergeomUpperTail, binomUpperTail, poissonBinomUpperTail, benjaminiHochberg,
    DIMENSIONS, IMPACT_TIERS, STATUS_FILTERS, REF_CELL
}
