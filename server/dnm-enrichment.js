/**
 * De novo mutation-rate enrichment ("Test B") — a self-contained, extensible
 * genetic-model framework. Kept ENTIRELY separate from gene-analysis.js (Test A,
 * the origin-agnostic distributional/clustering test) so that engine stays pristine.
 *
 * The de novo model asks: did we observe MORE de novo variants in a gene / category
 * than the germline mutation rate predicts for a cohort of N trios?
 *
 *   λ(gene, class) = 2 · N · μ(gene, class),  observed k ~ Poisson(λ),
 *   p = P(X ≥ k) = 1 − Σ_{i=0}^{k−1} e^−λ λ^i / i!
 *
 * The constant 2 = the two parental transmissions at risk per proband (denovolyzeR:
 * expected = 2·nsamples·p). μ is gnomAD v4.1's per-gene, per-consequence, per-
 * transmission summed trinucleotide mutability (lof.mu / mis.mu / syn.mu) — NOT
 * gnomAD `exp` (a standing-variant count) and NOT LOEUF/pLI (selection metrics).
 *
 * References: Samocha et al. Nat Genet 2014;46:944 (framework + rate model);
 * Ware et al. Curr Protoc Hum Genet 2015 (denovolyzeR); Karczewski et al. Nature
 * 2020;581:434 / Chen et al. Nature 2024;625:92 (gnomAD rates); Benjamini &
 * Hochberg JRSS-B 1995;57:289 (FDR).
 *
 * Scientific guards (all reported in the Methods output):
 *  - SNV-only observed counts (μ is SNV-only; HIGH/MOD indels have no μ term);
 *  - autosomal-only (2·N assumes two autosomal copies; X/Y needs proband sex);
 *  - inheritance gate = `de_novo` only (suppressed entirely when unknown);
 *  - consequence mapping HIGH→lof, MODERATE→mis, LOW→syn (VEP severity ≈ class);
 *  - synonymous calibration control (observed_syn ÷ 2N·Σsyn.μ ≈ 1);
 *  - N from the Sample-QC trio count when available (else provisional).
 *
 * Pure / deterministic (no I/O), so unit-testable in isolation.
 */

'use strict'

const {benjaminiHochberg} = require('./gene-analysis')   // shared FDR utility (Test A does not import us)

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

// ---- consequence / tier model ----
// VEP severity → gnomAD μ class. MODIFIER/blank/other → null (no coding μ ⇒ out of scope).
const CONSEQUENCE_MAP = {HIGH: 'lof', MODERATE: 'mis', LOW: 'syn'}
const MU_FIELD = {lof: 'muLof', mis: 'muMis', syn: 'muSyn'}
// Cumulative PROTEIN-ALTERING discovery tiers. Synonymous (LOW) is deliberately NOT a
// discovery tier — it is only the genome-wide calibration control — so it never enters a
// category's k / λ / ranking / ✓.
const CODING_TIERS = [
    {key: 'HIGH', label: 'HIGH', classes: ['lof']},
    {key: 'HIGH_MOD', label: 'HIGH+MOD', classes: ['lof', 'mis']}
]
// Per-gene tracks (Stage 2). LoF / missense / protein-altering are separate DISCOVERY
// families (BH per track across genes); synonymous is a calibration track (no discovery q).
const PER_GENE_TRACKS = [
    {key: 'lof', label: 'LoF', classes: ['lof'], discovery: true},
    {key: 'mis', label: 'missense', classes: ['mis'], discovery: true},
    {key: 'protein_altering', label: 'protein-altering', classes: ['lof', 'mis'], discovery: true},
    {key: 'syn', label: 'synonymous (cal)', classes: ['syn'], discovery: false}
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

// Autosomes 1..22 (chr already normalised to bare '1'…'22','X','Y' in the bundle).
function isAutosome(chr) { return /^(?:[1-9]|1\d|2[0-2])$/.test(String(chr || '')) }
function isSnv(ref, alt) {
    return typeof ref === 'string' && typeof alt === 'string' &&
        ref.length === 1 && alt.length === 1 && /^[ACGT]$/i.test(ref) && /^[ACGT]$/i.test(alt)
}

/**
 * Category μ-sums: for each dimension × term, Σ of {lof,mis,syn} μ over the genes in
 * that source's universe that are AUTOSOMAL and have μ — the genome-wide mutational
 * target of the category (the denominator half of λ). Term derivation MUST mirror
 * gene-analysis.sourceUniverseStats so the numerator (observed k, via geneTerms) and
 * this denominator use the same category membership.
 * @param {{gnomad?:Map, clinvar?:Map, gencc?:Map}} bundles  gnomad Map carries μ + chr
 * @param {Object<string,Map>} [geneSetLibs]  {dimId: Map<UPPER,[terms]>}
 * @returns {{byDim:Object, total:{lof,mis,syn}}}
 */
function categoryMuSums(bundles, geneSetLibs) {
    const byDim = {}
    const total = {lof: 0, mis: 0, syn: 0}
    const gn = bundles && bundles.gnomad
    const muOf = (g) => gn ? gn.get(g) : null
    const add = (dim, term, rec) => {
        const d = byDim[dim] || (byDim[dim] = {})
        const t = d[term] || (d[term] = {lof: 0, mis: 0, syn: 0})
        t.lof += rec.muLof || 0; t.mis += rec.muMis || 0; t.syn += rec.muSyn || 0
    }
    const hasMu = (rec) => rec && (rec.muLof != null || rec.muMis != null || rec.muSyn != null) && isAutosome(rec.chr)

    if (gn) {
        for (const rec of gn.values()) {
            if (!hasMu(rec)) continue
            total.lof += rec.muLof || 0; total.mis += rec.muMis || 0; total.syn += rec.muSyn || 0
            // constraint dimension — same terms as sourceUniverseStats
            if (typeof rec.loeuf === 'number' && rec.loeuf < 0.6) add('constraint', 'LOEUF < 0.6 (LoF-constrained)', rec)
            if (typeof rec.pli === 'number' && rec.pli >= 0.9) add('constraint', 'pLI ≥ 0.9', rec)
        }
    }
    const cv = bundles && bundles.clinvar
    if (cv) for (const [g, rec] of cv) {
        if (!(rec && rec.plp > 0)) continue
        const mu = muOf(g); if (!hasMu(mu)) continue
        add('clinvar', 'Has ClinVar P/LP', mu)
    }
    const gc = bundles && bundles.gencc
    if (gc) for (const [g, rec] of gc) {
        if (!(rec && Array.isArray(rec.moi))) continue
        const mu = muOf(g); if (!hasMu(mu)) continue
        for (const m of rec.moi) add('gencc', m, mu)
    }
    if (geneSetLibs) for (const dimId of Object.keys(geneSetLibs)) {
        const lib = geneSetLibs[dimId]; if (!lib || !lib.size) continue
        for (const [g, terms] of lib) {
            const mu = muOf(g); if (!hasMu(mu)) continue
            for (const t of terms) add(dimId, t, mu)
        }
    }
    return {byDim, total}
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
    const {model = DE_NOVO, geneCol, impactCol, statusCol = 'curation_status',
        sampleCol, chromCol, refCol, altCol, inheritanceCol,
        geneTerms, dimensions, muByGene, categoryMu, N, nReliable = false, minCount = 1} = opts
    const cols = {geneCol, impactCol, sampleCol, chromCol, refCol, altCol, inheritanceCol}

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
        nUsed: 0, byClass: {lof: 0, mis: 0, syn: 0}}
    const catMu = (categoryMu && categoryMu.byDim) || {}
    for (const v of variants) {
        if (v[statusCol] !== 'pass') continue
        meta.nPass++
        if (!model.gate(v, cols)) continue            // inheritance gate (de novo)
        meta.nPassDeNovo++
        if (!isSnv(v[refCol], v[altCol])) { meta.exclIndel++; continue }
        const chr = String(v[chromCol] || '').replace(/^chr/i, '').toUpperCase()
        if (!isAutosome(chr)) { meta.exclXY++; continue }
        const impact = String(v[impactCol] || '').toUpperCase()
        const cls = CONSEQUENCE_MAP[impact]
        if (!cls) { meta.exclNonCoding++; continue }   // MODIFIER/blank/other → out of the coding μ model
        const gene = String(v[geneCol] || '').toUpperCase()
        const rec = gene ? geneRec(gene) : null
        if (!rec || !isAutosome(rec.chr)) { meta.exclNoMu++; continue }        // no gnomAD gene / non-autosomal
        // Per-class μ REQUIRED: a variant whose gene has null μ for its OWN consequence
        // class has no modelable target (it would be in k but contribute 0 to λ) — exclude
        // it so the numerator and λ denominator stay consistent per class.
        if (rec[MU_FIELD[cls]] == null) { meta.exclNoClassMu++; continue }
        const sample = sampleCol ? (v[sampleCol] || 'unknown') : 'all'
        used.push({gene, cls, sample, terms: geneTerms ? geneTerms.get(gene) : null})
        meta.nUsed++; meta.byClass[cls]++; probandSet.add(sample)
    }
    meta.nDistinctProbands = probandSet.size

    // --- synonymous calibration control: observed_syn ÷ 2N·Σsyn.μ (should be ≈ 1) ---
    const total = (categoryMu && categoryMu.total) || {lof: 0, mis: 0, syn: 0}
    const expClass = (c) => 2 * (N || 0) * (total[c] || 0)
    meta.calibration = {
        syn: {obs: meta.byClass.syn, exp: expClass('syn'), ratio: expClass('syn') > 0 ? meta.byClass.syn / expClass('syn') : null},
        mis: {obs: meta.byClass.mis, exp: expClass('mis'), ratio: expClass('mis') > 0 ? meta.byClass.mis / expClass('mis') : null},
        lof: {obs: meta.byClass.lof, exp: expClass('lof'), ratio: expClass('lof') > 0 ? meta.byClass.lof / expClass('lof') : null}
    }

    // --- per category × coding tier: k, λ = 2N·Σμ, p ---
    const sections = (dimensions || []).map(d => {
        const dimMu = catMu[d.id] || {}
        // observed k per term per class, from the used variants that carry the term
        const obs = {}   // term -> {lof, mis, probands:Set, genes:Set}  (syn excluded — calibration only)
        for (const u of used) {
            if (u.cls === 'syn') continue            // synonymous is the calibration control, never per-category discovery
            const tlist = (u.terms && u.terms[d.id]) || []
            for (const term of tlist) {
                const o = obs[term] || (obs[term] = {lof: 0, mis: 0, probands: new Set(), genes: new Set()})
                o[u.cls]++; o.probands.add(u.sample); o.genes.add(u.gene)
            }
        }
        const TOP = CODING_TIERS[CODING_TIERS.length - 1].key
        const groups = []
        for (const term of Object.keys(obs)) {
            const o = obs[term]
            const muT = dimMu[term] || {lof: 0, mis: 0, syn: 0}
            const cells = {}
            for (const tier of CODING_TIERS) {
                const k = tier.classes.reduce((s, c) => s + (o[c] || 0), 0)
                const sumMu = tier.classes.reduce((s, c) => s + (muT[c] || 0), 0)
                const lambda = (N > 0 && sumMu > 0) ? 2 * N * sumMu : null
                // p only for OBSERVED cells (k>0). A k=0 cell would give the trivial p=1;
                // leaving p=null keeps it out of the BH family (benjaminiHochberg skips
                // null) so m isn't inflated — matching Test A's guard.
                const p = (lambda != null && k > 0) ? poissonUpperTail(k, lambda) : null
                cells[tier.key] = {k, lambda, catMu: sumMu, p, q: null}
            }
            const kTop = cells[TOP].k
            if (kTop < minCount) continue                // categories with ≥minCount observed protein-altering de novos
            groups.push({term, cells, kTop, probands: o.probands.size, genes: [...o.genes].sort(), refK: kTop})
        }
        // BH-FDR per dimension across the OBSERVED (category × tier) cells (null p ⇒ excluded).
        const tests = []
        for (const g of groups) for (const tier of CODING_TIERS) tests.push(g.cells[tier.key])
        benjaminiHochberg(tests.map(c => c.p)).forEach((q, i) => { tests[i].q = q })
        // rank by strongest (smallest) top-tier p, then k, then term
        const pTop = g => (g.cells[TOP].p == null ? 1 : g.cells[TOP].p)
        groups.sort((a, b) => pTop(a) - pTop(b) || b.kTop - a.kTop || a.term.localeCompare(b.term))
        return {id: d.id, label: d.label, groups, muSource: !!catMu[d.id]}
    })

    // --- per-gene enrichment: gene × class, λ = 2·N·μ (Stage 2) ---
    const geneK = {}   // gene -> {lof, mis, syn}
    for (const u of used) { const g = geneK[u.gene] || (geneK[u.gene] = {lof: 0, mis: 0, syn: 0}); g[u.cls]++ }
    const perGeneRows = []
    for (const gene of Object.keys(geneK)) {
        const rec = muByGene ? muByGene.get(gene) : null
        if (!rec) continue
        for (const tr of PER_GENE_TRACKS) {
            const k = tr.classes.reduce((s, c) => s + (geneK[gene][c] || 0), 0)
            if (k <= 0) continue                         // only OBSERVED (gene, track) rows
            const mu = tr.classes.reduce((s, c) => s + (rec[MU_FIELD[c]] || 0), 0)
            const lambda = (N > 0 && mu > 0) ? 2 * N * mu : null
            perGeneRows.push({gene, track: tr.key, trackLabel: tr.label, discovery: tr.discovery,
                k, mu, lambda, p: (lambda != null && k > 0) ? poissonUpperTail(k, lambda) : null, q: null})
        }
    }
    // BH-FDR per discovery track (LoF / missense / protein-altering are SEPARATE families
    // across genes); synonymous is a calibration track — no discovery q.
    const familySizes = {}
    for (const tr of PER_GENE_TRACKS) {
        const fam = perGeneRows.filter(r => r.track === tr.key)
        if (tr.discovery) benjaminiHochberg(fam.map(r => r.p)).forEach((q, i) => { fam[i].q = q })
        familySizes[tr.key] = fam.filter(r => r.p != null).length   // = the BH family m (tested rows)
    }
    perGeneRows.sort((a, b) => (a.p == null ? 1 : a.p) - (b.p == null ? 1 : b.p) || b.k - a.k || a.gene.localeCompare(b.gene))

    return {perCategory: {sections, tiers: CODING_TIERS}, perGene: {tracks: PER_GENE_TRACKS, rows: perGeneRows, familySizes}, meta}
}

module.exports = {
    computeModelEnrichment, categoryMuSums, poissonUpperTail,
    MODELS, DE_NOVO, CONSEQUENCE_MAP, CODING_TIERS, PER_GENE_TRACKS, isAutosome, isSnv
}
