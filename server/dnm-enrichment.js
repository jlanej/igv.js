/**
 * De novo mutation-rate enrichment ("Test B") — a self-contained, extensible
 * genetic-model framework. Kept ENTIRELY separate from gene-analysis.js (Test A,
 * the origin-agnostic distributional/clustering test) so that engine stays pristine.
 *
 * The de novo model asks: did we observe MORE de novo variants in a gene / category
 * than the germline mutation rate predicts for a cohort of N trios?
 *
 *   λ(gene, class) = 2 · N · p(gene, class) · ê,  observed k ~ Poisson(λ),
 *   P = P(X ≥ k) = 1 − Σ_{i=0}^{k−1} e^−λ λ^i / i!
 *
 * The constant 2 = the two parental transmissions at risk per proband (denovolyzeR:
 * expected = 2·nsamples·p).
 *
 * THE RATE p. Per-gene, per-class, PER-TRANSMISSION de novo probabilities from the
 * Samocha 2014 trinucleotide model, bundled from the DeNovoWEST release
 * (data/annotations/dnm_rates.json.gz). Classes: pSyn, pMis, and pNonSplice =
 * p_all − p_syn − p_mis, i.e. nonsense + essential-splice SNVs.
 *   - NOT the table's own p_lof, which INCLUDES frameshift: pairing it with our
 *     SNV-only observed count would inflate λ's LoF term by ~1.8x.
 *   - NOT gnomAD's lof.mu / mis.mu / syn.mu, which λ was previously built from. Those
 *     are a MUTABILITY COVARIATE, not a rate: gnomAD fits `expected = mu·slope +
 *     intercept` and refits the slope, so mu is identified only up to a proportionality
 *     constant. Summing it predicts 0.276 coding de novo per trio against a published
 *     ~1.0–1.3, and its class balance is separately wrong (lof.mu/syn.mu = 0.319 vs
 *     ~0.168). This bundle sums to 1.074 per trio at a ratio of 0.161 — the numbers
 *     that make the test meaningful rather than an inflated-discovery machine.
 *
 * THE CALIBRATION ê. Absolute rate scale is not settled across published tables (~16%),
 * and a real cohort's de novo ASCERTAINMENT is never 100%: λ = 2·N·p assumes every de
 * novo was called. So the scale is FITTED to this cohort from its own synonymous class,
 * which is (approximately) selection-neutral:
 *
 *   ê = observed_syn / (2 · N · Σ_g p_syn(g))     over the same gene set k is counted on
 *
 * and every discovery class uses λ = 2·N·p·ê. ê IS the headline QC number: ê≈1 means
 * this cohort's de novo yield matches the model; ê≈0.5 means about half the de novo
 * variants were called (or the rate table runs ~2x high for this data), and the
 * discovery λ is scaled to match rather than being asserted.
 *
 * CONSEQUENCE, ALSO ITS COST: the synonymous ratio is no longer an independent guard.
 * Once λ carries ê, observed_syn / expected_syn ≡ 1 BY CONSTRUCTION — it is tautological
 * and cannot detect a broken rate table. The check that survives is ê's own magnitude,
 * and the scale-free conditional binomial (which needs neither N nor ê).
 *
 * ê ASSUMES detection efficiency is CLASS-INDEPENDENT. Synonymous sites are CpG-rich and
 * coverage tracks GC, so a second-order class bias survives — far smaller than the scale
 * gap it removes, but real, and stated rather than hidden.
 *
 * References: Samocha et al. Nat Genet 2014;46:944 (framework + rate model);
 * Kaplanis & Samocha et al. Nature 2020;586:757 + HurlesGroupSanger/DeNovoWEST, MIT
 * (the bundled per-gene table); Ware et al. Curr Protoc Hum Genet 2015 (denovolyzeR);
 * Benjamini & Hochberg JRSS-B 1995;57:289 (FDR).
 *
 * Scientific guards (all reported in the Methods output):
 *  - SNV-only observed counts (the rates are SNV-only; HIGH/MOD indels have no term);
 *  - autosomal-only (2·N assumes two autosomal copies; X/Y needs proband sex);
 *  - inheritance gate = `de_novo` only (suppressed entirely when unknown);
 *  - consequence classes from VEP Consequence when present, IMPACT only as a fallback;
 *  - ê reported loudly, with its tautology and its class-independence assumption stated;
 *  - N from the Sample-QC trio count when available (else provisional).
 *
 * Pure / deterministic (no I/O), so unit-testable in isolation.
 */

'use strict'

// Shared utilities from Test A (the dependency is one-way — Test A never imports us, so its
// engine stays pristine). geneTermsFor is imported deliberately: category membership must
// have ONE definition, or a category's observed k and its λ silently describe different
// gene sets.
const {benjaminiHochberg, geneTermsFor} = require('./gene-analysis')

// ---- pure stats (self-contained; own lgamma so the module stands alone) ----
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

/**
 * Upper-tail Poisson P(X ≥ k), X ~ Poisson(λ). The de novo null: the number of de
 * novo variants of a class in a gene/category is Poisson with mean λ = 2·N·μ.
 * Exact and cheap (de novo k and λ are small). Returns null for a null/negative λ.
 */
function poissonUpperTail(k, lambda) {
    if (lambda == null || !(lambda >= 0)) return null
    if (k <= 0) return 1
    if (lambda === 0) return 0                       // k ≥ 1 but zero expectation
    const logL = Math.log(lambda)
    if (k > lambda) {
        // Significant regime: sum the TAIL directly (terms fall once i>λ) so a tiny p
        // keeps full precision instead of being floored by 1 − (head sum ≈ 1).
        let sum = 0, term = 0, i = k
        do { term = Math.exp(i * logL - lambda - lgamma(i + 1)); sum += term; i++ }
        while (term > sum * 1e-16 && i < k + 100000)
        return Math.min(1, Math.max(0, sum))
    }
    let below = 0                                    // Σ_{i=0}^{k-1} e^−λ λ^i / i!  (log-space via lgamma)
    for (let i = 0; i < k; i++) below += Math.exp(i * logL - lambda - lgamma(i + 1))
    return Math.min(1, Math.max(0, 1 - below))
}

// ---- consequence / class model ----
// The three modelable classes, named for what they ACTUALLY are. 'nonSplice' is
// nonsense + essential-splice SNVs — deliberately NOT called "LoF", because the rate
// it pairs with (pNonSplice) excludes frameshift, and calling it LoF is exactly the
// trap the table's own p_lof column sets.
const RATE_FIELD = {nonSplice: 'pNonSplice', mis: 'pMis', syn: 'pSyn'}

// PREFERRED classifier: the molecular consequence (VEP `Consequence`). VEP emits an
// &-separated list ordered most-severe-first; we take the most severe TERM WE MODEL.
// Anything else (UTR, intron, regulatory, inframe indel, frameshift) has no SNV rate
// term and is excluded — counted, never silently dropped.
const CONSEQUENCE_CLASS = {
    stop_gained: 'nonSplice',
    splice_donor_variant: 'nonSplice',
    splice_acceptor_variant: 'nonSplice',
    missense_variant: 'mis',
    synonymous_variant: 'syn',
    // Explicitly NOT modelled, and explicitly listed so the exclusion is a decision:
    // start_lost / stop_lost / stop_retained have no separate term in the rate model,
    // and every other splice_* term (region, polypyrimidine tract, 5th base) is an
    // INTRONIC modifier, not an essential splice-site SNV.
}
// FALLBACK classifier, used only when there is no Consequence column: VEP IMPACT
// severity. This is an approximation and a KNOWN source of error — VEP LOW is NOT
// synonymous. Measured on a real cohort, 34% of LOW rows were splice_region /
// splice_polypyrimidine_tract / splice_donor_5th_base / intronic, none of which are
// synonymous. That matters more than it looks: the synonymous class is the CALIBRATOR,
// so contaminating it inflates ê and rescales every discovery λ.
const IMPACT_CLASS = {HIGH: 'nonSplice', MODERATE: 'mis', LOW: 'syn'}

/**
 * Classify one variant into a rate class, preferring molecular consequence.
 * @returns {{cls:string|null, via:'consequence'|'impact'|null, term:string|null}}
 */
function classifyConsequence(consequence, impact) {
    const raw = String(consequence || '').trim()
    if (raw) {
        // VEP orders the &-separated list most-severe-first; honour that order and take
        // the first term we model, so `splice_donor_variant&intron_variant` is a splice
        // SNV, not an intron variant.
        for (const t of raw.split('&')) {
            const term = t.trim().toLowerCase()
            if (CONSEQUENCE_CLASS[term]) return {cls: CONSEQUENCE_CLASS[term], via: 'consequence', term}
        }
        return {cls: null, via: 'consequence', term: raw.split('&')[0].trim().toLowerCase()}
    }
    const cls = IMPACT_CLASS[String(impact || '').toUpperCase()]
    return {cls: cls || null, via: cls ? 'impact' : null, term: null}
}

// Cumulative PROTEIN-ALTERING discovery tiers. Synonymous is deliberately NOT a
// discovery tier — it is the CALIBRATOR (it fits ê), so testing it would be circular:
// its own ratio is 1 by construction. It never enters a category's k / λ / ranking / ✓.
const CODING_TIERS = [
    {key: 'HIGH', label: 'nonsense+splice', classes: ['nonSplice']},
    {key: 'HIGH_MOD', label: 'nonsense+splice+missense', classes: ['nonSplice', 'mis']}
]
// Per-gene tracks (Stage 2). Separate DISCOVERY families (BH per track across genes).
// Synonymous is shown for transparency but carries no discovery q — it is the calibrator.
const PER_GENE_TRACKS = [
    {key: 'lof', label: 'nonsense+splice (SNV)', classes: ['nonSplice'], discovery: true},
    {key: 'mis', label: 'missense', classes: ['mis'], discovery: true},
    {key: 'protein_altering', label: 'protein-altering', classes: ['nonSplice', 'mis'], discovery: true},
    {key: 'syn', label: 'synonymous (calibrator)', classes: ['syn'], discovery: false}
]

// ---- extensible genetic-model registry ----
// Each descriptor: {id, label, nullType, gate(v, cols) -> bool}. computeModelEnrichment
// dispatches on nullType. Only 'poisson-rate' (de novo) is implemented; the others are
// registered stubs documenting the extension surface (X-linked de novo needs a sex/copy
// adjusted λ; recessive/dominant inherited need a FREQUENCY null from gnomAD allele
// frequencies — a different nullType and a data addition).
const DE_NOVO = {
    id: 'de_novo', label: 'De novo (germline mutation-rate)', nullType: 'poisson-rate',
    gate: (v, cols) => !!cols.inheritanceCol && v[cols.inheritanceCol] === 'de_novo'
}
const X_LINKED_DENOVO = {id: 'x_linked_denovo', label: 'X-linked de novo', nullType: 'poisson-rate-x',
    gate: (v, cols) => !!cols.inheritanceCol && v[cols.inheritanceCol] === 'de_novo', stub: true,
    needs: 'per-proband sex + haploid/copy-aware λ'}
const RECESSIVE_HOM = {id: 'recessive_hom', label: 'Recessive (homozygous inherited)', nullType: 'frequency',
    gate: (v, cols) => !!cols.inheritanceCol && v[cols.inheritanceCol] === 'inherited', stub: true,
    needs: 'gnomAD allele frequencies (population homozygote expectation)'}
const DOMINANT_INHERITED = {id: 'dominant_inherited', label: 'Dominant inherited', nullType: 'frequency',
    gate: (v, cols) => !!cols.inheritanceCol && v[cols.inheritanceCol] === 'inherited', stub: true,
    needs: 'gnomAD allele frequencies (population carrier expectation)'}
const MODELS = {de_novo: DE_NOVO, x_linked_denovo: X_LINKED_DENOVO, recessive_hom: RECESSIVE_HOM, dominant_inherited: DOMINANT_INHERITED}

// Minimum observed synonymous de novo count before ê is fitted at all. ê's relative
// standard error is ~1/√(obs_syn), so 10 gives ~32% — imprecise, but far better than the
// alternative, which is ASSERTING a scale. Below it, ê is not fitted and the test is
// marked uncalibrated so the tab can withhold its ✓ marks: the failure mode being blocked
// is obs_syn = 0 ⇒ ê = 0 ⇒ λ = 0 ⇒ p = 0 for every k ≥ 1, i.e. the entire exome
// "significant". Note ê's noise is NOT propagated into p (the Poisson treats λ as known),
// which makes the calibrated p mildly anti-conservative; the scale-free conditional
// binomial is the companion that integrates that noise out instead of ignoring it.
const MIN_SYN_FOR_EHAT = 10

// Autosomes 1..22 (chr already normalised to bare '1'…'22','X','Y' in the bundle).
function isAutosome(chr) { return /^(?:[1-9]|1\d|2[0-2])$/.test(String(chr || '')) }
function isSnv(ref, alt) {
    return typeof ref === 'string' && typeof alt === 'string' &&
        ref.length === 1 && alt.length === 1 && /^[ACGT]$/i.test(ref) && /^[ACGT]$/i.test(alt)
}

/**
 * Category rate-sums: for each dimension × term, Σ of {nonSplice,mis,syn} per-transmission
 * rates over the genes in that source's universe that are AUTOSOMAL and have a rate — the
 * category's mutational target, i.e. the denominator half of λ. Plus `total`, the same sums
 * exome-wide, which is what ê is fitted against.
 *
 * Category membership comes from geneTermsFor — the SAME function Test A's numerator and
 * background both route through — so the observed k (which reaches us via geneTerms) and
 * this Σp cannot describe different gene sets. Re-implementing the membership rules here
 * (as this function used to) is precisely the drift hazard that makes a category's k and
 * its λ silently stop matching.
 *
 * AUTOSOMAL-ONLY is load-bearing, not a detail: λ = 2·N·p counts two parental
 * transmissions, which assumes two copies. chrX needs per-proband sex and a copy-aware λ,
 * so X genes are excluded here even though the rate table has 819 of them.
 *
 * @param {Map<string,{pSyn,pMis,pNonSplice,chr}>} rates  per-gene de novo rates, keyed UPPER
 * @param {{gnomad?:Map, clinvar?:Map, gencc?:Map}} bundles  for the per-dimension universes
 * @param {Object<string,Map>} [geneSetLibs]  {dimId: Map<UPPER,[terms]>}
 * @returns {{byDim:Object, total:{nonSplice,mis,syn}, nGenes:number}}
 */
function categoryRateSums(rates, bundles, geneSetLibs) {
    const byDim = {}
    const total = {nonSplice: 0, mis: 0, syn: 0}
    let nGenes = 0
    if (!rates || !rates.size) return {byDim, total, nGenes}
    const b = bundles || {}
    const modelable = (rec) => !!rec && isAutosome(rec.chr) &&
        (rec.pNonSplice != null || rec.pMis != null || rec.pSyn != null)

    // Exome-wide target: every autosomal gene with a rate. This is ê's denominator, and it
    // must span the same gene set k is counted over — hence the identical `modelable` gate.
    for (const rec of rates.values()) {
        if (!modelable(rec)) continue
        nGenes++
        total.nonSplice += rec.pNonSplice || 0; total.mis += rec.pMis || 0; total.syn += rec.pSyn || 0
    }

    const providerFor = (g) => ({
        gnomad: b.gnomad ? b.gnomad.get(g) : null,
        clinvar: b.clinvar ? b.clinvar.get(g) : null,
        gencc: b.gencc ? b.gencc.get(g) : null
    })
    const walk = (dimId, geneKeys) => {
        const d = byDim[dimId] || (byDim[dimId] = {})
        for (const g of geneKeys) {
            const rec = rates.get(g)
            if (!modelable(rec)) continue
            for (const term of (geneTermsFor(g, providerFor(g), null, geneSetLibs)[dimId] || [])) {
                const t = d[term] || (d[term] = {nonSplice: 0, mis: 0, syn: 0})
                t.nonSplice += rec.pNonSplice || 0; t.mis += rec.pMis || 0; t.syn += rec.pSyn || 0
            }
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
    return {byDim, total, nGenes}
}

/**
 * @param {Array<Object>} variants  the export's selected variants
 * @param {Object} opts
 *   model, geneCol, impactCol, statusCol, sampleCol, chromCol, refCol, altCol, inheritanceCol,
 *   geneTerms (Map<UPPER,{dim:[terms]}>), dimensions ([{id,label}]),
 *   categoryMu ({byDim,total} from categoryMuSums), N, nReliable, minCount
 * @returns {{perCategory:{sections}, meta}}  (per-gene added in Stage 2)
 */
function computeModelEnrichment(variants, opts) {
    const {model = DE_NOVO, geneCol, impactCol, consequenceCol = null, statusCol = 'curation_status',
        sampleCol, chromCol, refCol, altCol, inheritanceCol,
        geneTerms, dimensions, muByGene, categoryMu, N, nReliable = false, minCount = 1} = opts
    const cols = {geneCol, impactCol, consequenceCol, sampleCol, chromCol, refCol, altCol, inheritanceCol}

    if (model.nullType !== 'poisson-rate') {
        // Extension point: X-linked / frequency-based models are registered but not computed.
        return {perCategory: {sections: []}, meta: {model: model.id, notImplemented: model.nullType, N}}
    }

    const geneRec = (gene) => (muByGene ? muByGene.get(gene) : null)

    // --- gate + classify (pass, de novo, SNV, autosomal, coding class, gene with μ FOR THIS CLASS) ---
    const used = []                 // {gene, cls, sample, terms}
    const probandSet = new Set()
    const meta = {model: model.id, N: N || 0, nReliable: !!nReliable,
        nPass: 0, nPassDeNovo: 0, exclIndel: 0, exclXY: 0, exclNonCoding: 0, exclNoMu: 0, exclNoClassMu: 0,
        nUsed: 0, byClass: {nonSplice: 0, mis: 0, syn: 0},
        classifiedVia: {consequence: 0, impact: 0}, unmodelledTerms: {}}
    const catMu = (categoryMu && categoryMu.byDim) || {}
    for (const v of variants) {
        if (v[statusCol] !== 'pass') continue
        meta.nPass++
        if (!model.gate(v, cols)) continue            // inheritance gate (de novo)
        meta.nPassDeNovo++
        if (!isSnv(v[refCol], v[altCol])) { meta.exclIndel++; continue }
        const chr = String(v[chromCol] || '').replace(/^chr/i, '').toUpperCase()
        if (!isAutosome(chr)) { meta.exclXY++; continue }
        // Molecular consequence first; IMPACT only when the data has no Consequence column.
        const {cls, via, term} = classifyConsequence(consequenceCol ? v[consequenceCol] : null, v[impactCol])
        if (!cls) {
            meta.exclNonCoding++
            // Record WHAT was excluded: "34% of LOW is not synonymous" is only knowable
            // because the terms are counted rather than lumped into one number.
            if (term) meta.unmodelledTerms[term] = (meta.unmodelledTerms[term] || 0) + 1
            continue
        }
        const gene = String(v[geneCol] || '').toUpperCase()
        const rec = gene ? geneRec(gene) : null
        if (!rec || !isAutosome(rec.chr)) { meta.exclNoMu++; continue }        // no rate for the gene / non-autosomal
        // Per-class rate REQUIRED: a variant whose gene has no rate for its OWN class has
        // no modelable target (it would be in k but contribute 0 to λ) — exclude it so the
        // numerator and the λ denominator stay consistent per class.
        if (rec[RATE_FIELD[cls]] == null) { meta.exclNoClassMu++; continue }
        const sample = sampleCol ? (v[sampleCol] || 'unknown') : 'all'
        used.push({gene, cls, sample, terms: geneTerms ? geneTerms.get(gene) : null})
        meta.nUsed++; meta.byClass[cls]++; probandSet.add(sample)
        if (via) meta.classifiedVia[via]++
    }
    meta.nDistinctProbands = probandSet.size

    // --- ê: the empirical calibration, fitted from this cohort's own synonymous class ---
    // ê = observed_syn / (2·N·Σ_g p_syn), summed over the SAME autosomal gene set k is
    // counted on. It absorbs, in one number, both the unsettled absolute rate scale
    // (~16% between published tables) and this cohort's de novo ASCERTAINMENT — λ = 2·N·p
    // otherwise assumes every de novo was called, which no real pipeline achieves.
    //
    // Synonymous is the right calibrator because it is ~selection-neutral, so its count
    // reflects mutation + detection and nothing else. The PRICE, stated here and in the
    // sheet: after this, observed_syn/expected_syn ≡ 1 by construction — the synonymous
    // ratio is TAUTOLOGICAL and is no longer a guard. ê's own magnitude is the guard.
    //
    // ASSUMPTION: detection efficiency is class-independent. Synonymous sites are CpG-rich
    // and coverage tracks GC, so a second-order class bias survives.
    const total = (categoryMu && categoryMu.total) || {nonSplice: 0, mis: 0, syn: 0}
    const expSynRaw = 2 * (N || 0) * (total.syn || 0)
    const eHat = (expSynRaw > 0 && meta.byClass.syn > 0) ? meta.byClass.syn / expSynRaw : null
    meta.eHat = eHat
    meta.calibration = {
        // Uncalibrated per-class observed vs 2·N·Σp — the RAW model, before ê. Reported so
        // a reader can see what ê is actually correcting, and by how much.
        syn: {obs: meta.byClass.syn, exp: expSynRaw, ratio: expSynRaw > 0 ? meta.byClass.syn / expSynRaw : null},
        mis: {obs: meta.byClass.mis, exp: 2 * (N || 0) * (total.mis || 0), ratio: (total.mis > 0 && N > 0) ? meta.byClass.mis / (2 * N * total.mis) : null},
        nonSplice: {obs: meta.byClass.nonSplice, exp: 2 * (N || 0) * (total.nonSplice || 0), ratio: (total.nonSplice > 0 && N > 0) ? meta.byClass.nonSplice / (2 * N * total.nonSplice) : null},
        eHat,
        // ê is a ratio of a Poisson count to a constant, so its relative SE is ~1/√k_syn.
        // Printed because a reader must be able to see how well-determined the scale is —
        // ê=0.55 on 72 synonymous variants (±12%) is a finding; on 4 it is noise.
        eHatRelSe: meta.byClass.syn > 0 ? 1 / Math.sqrt(meta.byClass.syn) : null,
        // Without enough synonymous variants there is nothing to fit ê from. Say so rather
        // than defaulting to 1: an unfitted λ silently reverts to "assume every de novo in
        // this cohort was called", which no pipeline achieves.
        eHatUsable: eHat != null && meta.byClass.syn >= MIN_SYN_FOR_EHAT,
        minSyn: MIN_SYN_FOR_EHAT
    }
    // The scale actually applied to every discovery λ. Falls back to 1 ONLY when ê cannot
    // be fitted, and that fallback is flagged so the tab can withhold its ✓ marks.
    const eApplied = meta.calibration.eHatUsable ? eHat : 1
    meta.eApplied = eApplied

    // --- per category × coding tier: k, λ = 2N·Σμ, p ---
    const sections = (dimensions || []).map(d => {
        const dimMu = catMu[d.id] || {}
        // observed k per term per class, from the used variants that carry the term
        const obs = {}   // term -> {nonSplice, mis, probands:Set, genes:Set}  (syn excluded — it is the calibrator)
        for (const u of used) {
            if (u.cls === 'syn') continue            // synonymous FITS ê; testing it would be circular (its ratio is 1 by construction)
            const tlist = (u.terms && u.terms[d.id]) || []
            for (const term of tlist) {
                const o = obs[term] || (obs[term] = {nonSplice: 0, mis: 0, probands: new Set(), genes: new Set()})
                o[u.cls]++; o.probands.add(u.sample); o.genes.add(u.gene)
            }
        }
        const TOP = CODING_TIERS[CODING_TIERS.length - 1].key
        const allGroups = []
        for (const term of Object.keys(obs)) {
            const o = obs[term]
            const muT = dimMu[term] || {nonSplice: 0, mis: 0, syn: 0}
            const cells = {}
            for (const tier of CODING_TIERS) {
                const k = tier.classes.reduce((s, c) => s + (o[c] || 0), 0)
                const sumMu = tier.classes.reduce((s, c) => s + (muT[c] || 0), 0)
                // λ = 2·N·Σp·ê — the fitted scale, not an asserted one. eApplied is 1 only
                // when ê could not be fitted, and that case is flagged so ✓ is withheld.
                const lambda = (N > 0 && sumMu > 0) ? 2 * N * sumMu * eApplied : null
                // EVERY modelable cell is a tested hypothesis. k=0 yields the exact
                // p = P(X≥0) = 1: it can never be rejected, but it must count toward m.
                // Gating on k>0 would let the observed data define the family and push the
                // real FDR far above nominal (see gene-analysis.js's BH note).
                const p = lambda != null ? poissonUpperTail(k, lambda) : null
                cells[tier.key] = {k, lambda, catMu: sumMu, eApplied, p, q: null}
            }
            allGroups.push({term, cells, kTop: cells[TOP].k, probands: o.probands.size,
                genes: [...o.genes].sort(), refK: cells[TOP].k})
        }
        // BH-FDR per dimension across the A-PRIORI (category × tier) grid: every category
        // in the library that has a modelable μ for that tier, NOT just the ones carrying
        // an observed de novo. `obs` only holds hit categories, so correcting across those
        // would let the data pick the family (the same error as gating on k>0 — see the BH
        // note in gene-analysis.js). An unhit category has k=0 ⇒ exact p=1, which is
        // benjaminiHochberg's mTotal precondition, so declare the size instead of
        // materialising the unhit rows. Fixed BEFORE the minCount display filter below.
        const tests = []
        for (const g of allGroups) for (const tier of CODING_TIERS) tests.push(g.cells[tier.key])
        // Per tier, a library category is testable iff λ = 2·N·Σμ > 0 for that tier.
        let mFam = 0
        if (N > 0) {
            for (const tier of CODING_TIERS) {
                for (const term of Object.keys(dimMu)) {
                    const sumMu = tier.classes.reduce((s, c) => s + ((dimMu[term] || {})[c] || 0), 0)
                    if (sumMu > 0) mFam++
                }
            }
        }
        const m = Math.max(mFam, tests.filter(c => c.p != null).length)
        benjaminiHochberg(tests.map(c => c.p), m).forEach((q, i) => { tests[i].q = q })
        // DISPLAY filter, applied after the correction (q's above are already final).
        const groups = allGroups.filter(g => g.kTop >= minCount)
        // rank by strongest (smallest) top-tier p, then k, then term
        const pTop = g => (g.cells[TOP].p == null ? 1 : g.cells[TOP].p)
        groups.sort((a, b) => pTop(a) - pTop(b) || b.kTop - a.kTop || a.term.localeCompare(b.term))
        return {id: d.id, label: d.label, groups, muSource: !!catMu[d.id], m, nCategories: allGroups.length}
    })

    // --- per-gene enrichment: gene × class, λ = 2·N·μ (Stage 2) ---
    const geneK = {}   // gene -> {lof, mis, syn}
    for (const u of used) { const g = geneK[u.gene] || (geneK[u.gene] = {nonSplice: 0, mis: 0, syn: 0}); g[u.cls]++ }
    const perGeneRows = []
    for (const gene of Object.keys(geneK)) {
        const rec = muByGene ? muByGene.get(gene) : null
        if (!rec) continue
        for (const tr of PER_GENE_TRACKS) {
            const k = tr.classes.reduce((s, c) => s + (geneK[gene][c] || 0), 0)
            if (k <= 0) continue                         // only OBSERVED (gene, track) rows
            const mu = tr.classes.reduce((s, c) => s + (rec[RATE_FIELD[c]] || 0), 0)
            // Same fitted scale as the category level — one ê for the whole test.
            const lambda = (N > 0 && mu > 0) ? 2 * N * mu * eApplied : null
            perGeneRows.push({gene, track: tr.key, trackLabel: tr.label, discovery: tr.discovery,
                k, mu, lambda, eApplied, p: (lambda != null && k > 0) ? poissonUpperTail(k, lambda) : null, q: null})
        }
    }
    // BH-FDR per discovery track (nonsense+splice / missense / protein-altering are SEPARATE
    // families across genes); synonymous is the calibrator — no discovery q.
    //
    // The family is EXOME-WIDE: every autosomal gene with a modelable μ for that track was
    // scanned, not just the genes that happened to carry a de novo. A gene with no
    // observed de novo has the exact p = P(X≥0) = 1 and can never be rejected, but it is
    // still one of the ~17k hypotheses the scan asked, so it must count toward m — this is
    // the standard de novo gene-discovery correction (cf. exome-wide thresholds in the DDD
    // / denovolyzeR literature). Correcting only across observed genes would let the data
    // pick the family and inflate the real FDR far above nominal. Only the observed rows
    // are materialised; the untested remainder enter via benjaminiHochberg's m argument
    // (provably identical to padding the vector with p=1).
    const familySizes = {}, observedRows = {}
    for (const tr of PER_GENE_TRACKS) {
        const fam = perGeneRows.filter(r => r.track === tr.key)
        let mExome = 0
        if (muByGene && N > 0) {
            for (const rec of muByGene.values()) {
                if (!isAutosome(rec && rec.chr)) continue
                const mu = tr.classes.reduce((s, c) => s + (rec[RATE_FIELD[c]] || 0), 0)
                if (mu > 0) mExome++                          // λ = 2·N·p·ê > 0 ⇒ testable
            }
        }
        const m = Math.max(mExome, fam.filter(r => r.p != null).length)
        if (tr.discovery) benjaminiHochberg(fam.map(r => r.p), m).forEach((q, i) => { fam[i].q = q })
        familySizes[tr.key] = m                                // the BH family m (genes scanned)
        observedRows[tr.key] = fam.filter(r => r.p != null).length
    }
    perGeneRows.sort((a, b) => (a.p == null ? 1 : a.p) - (b.p == null ? 1 : b.p) || b.k - a.k || a.gene.localeCompare(b.gene))

    return {perCategory: {sections, tiers: CODING_TIERS},
        perGene: {tracks: PER_GENE_TRACKS, rows: perGeneRows, familySizes, observedRows}, meta}
}

module.exports = {
    computeModelEnrichment, categoryRateSums, poissonUpperTail, classifyConsequence,
    MODELS, DE_NOVO, CONSEQUENCE_CLASS, IMPACT_CLASS, RATE_FIELD,
    CODING_TIERS, PER_GENE_TRACKS, isAutosome, isSnv, MIN_SYN_FOR_EHAT
}
