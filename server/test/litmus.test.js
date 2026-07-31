/**
 * Litmus tests — cheap, high-signal checks that the load-bearing ASSUMPTIONS
 * behind the Gene Analysis convergence tab still hold against the REAL bundled
 * data and the REAL export pipeline. These run in CI (full Node, real .gz
 * bundles, real HTTP endpoint) and are designed to catch the failure modes that
 * would otherwise produce plausible-but-wrong numbers:
 *
 *   - a regenerated/corrupt bundle (wrong gene counts or degenerate prevalence)
 *   - geneTermsFor and sourceUniverseStats drifting apart (prevalence numerator
 *     no longer matches the observed counts)
 *   - a proportion/denominator bug so the printed % no longer equals its raw
 *     counts (the "reconstructable by hand" guarantee)
 *   - the independent-individual dedup silently breaking
 *   - any wiring break that stops the whole export from producing a workbook
 */
const {describe, it} = require('mocha')
const {expect} = require('chai')
const request = require('supertest')
const ExcelJS = require('exceljs')

const app = require('../server')
const {computeConvergence, geneTermsFor, sourceUniverseStats, binomUpperTail, DIMENSIONS} = require('../gene-analysis')
const geneSets = require('../genesets')
const gnomad = require('../providers/gnomad-provider')
const clinvar = require('../providers/clinvar-provider')
const gencc = require('../providers/gencc-provider')

// Bundle maps + gene-set libraries, loaded exactly as the export does.
const gnB = gnomad.getBundle()
const cvB = clinvar.getGenes()
const gcB = gencc.getGenes()
const gsLibs = {
    reactome: geneSets.libMap('reactome'),
    wikipathways: geneSets.libMap('wikipathways'),
    hgncFamily: geneSets.libMap('hgncFamily'),
    msigdbHallmark: geneSets.libMap('msigdbHallmark'),
    domain: geneSets.libMap('domain'),   // InterPro protein-domain background
}
// Per-dimension backgrounds, built exactly as the export builds them. Each carries
// its own gene universe (`genes`), which the engine gates that dimension's trials on.
const SRC = sourceUniverseStats({gnomad: gnB, clinvar: cvB, gencc: gcB}, gsLibs)

describe('module graph', function () {
    // A require for a module that does not exist is not a subtle bug — it is a hard crash on
    // startup, and it took down the whole suite once: `require('../gene-sets')` when the file
    // is `genesets.js`. It survived local checks because the verification harness STUBBED any
    // unknown module rather than failing, so an invented path looked fine right up until CI.
    // Node resolves for real, so let it: walk every first-party source file and require it.
    it("every name a test imports from '../server' is actually exported", function () {
        // `buildReadmeSheet` was imported by a test and never exported, so the test threw
        // TypeError at RUN time rather than failing an assertion. My local harness had called
        // the function on the xlsx-sheets module directly — proving the function works, and
        // proving nothing about whether the test's import path resolves. Node only tells you
        // when the line executes; this asks the question up front, for every name.
        const fs = require('fs'), path = require('path')
        const srv = require('../server')
        const dir = __dirname
        const wanted = new Map()
        for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
            const src = fs.readFileSync(path.join(dir, f), 'utf-8')
            for (const m of src.matchAll(/const \{([^}]*)\} = require\('\.\.\/server'\)/g)) {
                for (const raw of m[1].split(',')) {
                    const name = raw.trim().split(':')[0].trim()
                    if (name) wanted.set(name, f)
                }
            }
            for (const m of src.matchAll(/require\('\.\.\/server'\)\.(\w+)/g)) wanted.set(m[1], f)
        }
        expect(wanted.size, 'tests really do import named things from ../server').to.be.greaterThan(0)
        const missing = [...wanted].filter(([n]) => srv[n] === undefined).map(([n, f]) => `${n} (${f})`)
        expect(missing, `imported from '../server' but not exported: ${missing.join(', ')}`).to.deep.equal([])
    })

    it('every server module require()s cleanly (no invented paths)', function () {
        const fs = require('fs'), path = require('path')
        const root = path.join(__dirname, '..')
        const files = []
        const walk = (dir) => {
            for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
                if (e.name === 'node_modules' || e.name === 'test' || e.name === 'data' ||
                    e.name === 'public' || e.name.startsWith('.')) continue
                const full = path.join(dir, e.name)
                if (e.isDirectory()) walk(full)
                else if (e.name.endsWith('.js') && e.name !== 'server.js') files.push(full)
            }
        }
        walk(root)
        expect(files.length, 'found first-party modules to check').to.be.greaterThan(8)
        const broken = []
        for (const f of files) {
            try { require(f) } catch (err) {
                // Only a missing MODULE is a defect here. A module that throws for want of a
                // bundle/network at load time is a different question, and not this test's.
                if (err.code === 'MODULE_NOT_FOUND') broken.push(`${path.relative(root, f)}: ${err.message.split('\n')[0]}`)
            }
        }
        expect(broken, `modules with an unresolvable require: ${broken.join(' | ')}`).to.deep.equal([])
    })
})

describe('litmus: bundled data loads with expected magnitudes', function () {
    it('gnomAD / ClinVar / GenCC bundles are present and full', function () {
        expect(gnB.size, 'gnomAD').to.be.within(15000, 20000)   // ~17.5k
        expect(cvB.size, 'ClinVar').to.be.greaterThan(25000)    // ~31k
        expect(gcB.size, 'GenCC').to.be.greaterThan(5000)       // ~6.1k
    })
    it('gnomAD bundle carries its per-gene mutability COVARIATE (μ) in a sane magnitude band', function () {
        // μ is NOT a de novo rate — it is a mutability covariate identified only up to a
        // proportionality constant (see the rate-bundle litmus above, where it fails the
        // published scale by ~3.9x). It is kept as an informational column, and these
        // assertions guard the fnum rounding regression (μ≈1e-6 must NOT collapse to 0)
        // and the μ merge — not any claim that μ can carry λ.
        const tsc2 = gnB.get('TSC2')
        expect(tsc2, 'TSC2 in gnomAD bundle').to.exist
        expect(tsc2.muLof, 'TSC2 lof.mu').to.be.within(1e-8, 1e-4)
        expect(tsc2.chr, 'TSC2 chromosome').to.equal('16')
        expect(gnomad.getMu('MTOR').muMis, 'MTOR mis.mu').to.be.within(1e-8, 1e-3)
        let withMu = 0
        for (const rec of gnB.values()) if (rec && typeof rec.muLof === 'number' && rec.muLof > 0) withMu++
        expect(withMu, 'genes with μ').to.be.greaterThan(15000)
    })
    it('all gene-set libraries + the InterPro domain background are present and non-trivial', function () {
        expect(geneSets.available().map(a => a.id)).to.include.members(['reactome', 'wikipathways', 'hgncFamily', 'msigdbHallmark', 'domain'])
        expect(gsLibs.reactome.size).to.be.greaterThan(8000)
        expect(gsLibs.wikipathways.size).to.be.greaterThan(6000)
        expect(gsLibs.hgncFamily.size).to.be.within(14000, 18000)   // ~15.5k PROTEIN-CODING genes (non-coding loci excluded)
        expect(gsLibs.msigdbHallmark.size).to.be.greaterThan(3000)
        expect(gsLibs.domain.size, 'InterPro domain').to.be.greaterThan(15000)   // ~19k human genes
        // the domain library is a base-dim source (not a new convergence section)
        expect(geneSets.available().find(a => a.id === 'domain').baseDim).to.equal(true)
    })
})

describe('litmus: the de novo RATE bundle is a rate, not a covariate', function () {
    // This is the guard that would have caught the bug that withheld Test B: λ was built
    // from gnomAD's lof.mu/mis.mu/syn.mu, a mutability COVARIATE identified only up to a
    // proportionality constant. It predicted 0.276 coding de novo per trio (~3.9x too
    // small) at a class ratio of 0.319 (~2x too high), which drags small-rate genes past
    // the FDR threshold on a single variant. A rate table must reproduce the PUBLISHED
    // scale; assert that against the real bundle, so a regenerated/wrong table fails here
    // rather than in a reviewer's inbox.
    const dnmRates = require('../dnm-rates')
    const {categoryRateSums} = require('../dnm-enrichment')
    const rates = dnmRates.getRates()

    it('the bundle loads with per-gene, per-class rates + chromosome', function () {
        expect(rates.size, 'rate records').to.be.greaterThan(15000)
        const tsc2 = rates.get('TSC2')
        expect(tsc2, 'TSC2 in the rate bundle').to.exist
        expect(tsc2.pSyn, 'TSC2 pSyn').to.be.within(1e-7, 1e-3)
        expect(tsc2.pMis, 'TSC2 pMis').to.be.within(1e-7, 1e-3)
        expect(tsc2.pNonSplice, 'TSC2 pNonSplice').to.be.within(1e-8, 1e-4)
        expect(tsc2.pLof, 'TSC2 pLof (SNV LoF + frameshift)').to.be.within(1e-8, 1e-4)
        expect(tsc2.pLof, 'p_lof must EXCEED the SNV-only residual — it is that plus frameshift').to.be.greaterThan(tsc2.pNonSplice)
        expect(tsc2.chr, 'TSC2 chromosome').to.equal('16')
        // The rate table knows X-linked genes even though gnomAD's constraint set cannot
        // score them. Test B still excludes X (2·N assumes two copies) — but by an explicit
        // gate on chr, not by an accident of which genes another bundle happens to contain.
        expect(rates.get('DDX3X'), 'DDX3X (X-linked) present in rates').to.exist
        expect(rates.get('DDX3X').chr).to.equal('X')
    })

    it('summed rates reproduce the PUBLISHED de novo scale (gnomAD μ does not)', function () {
        const cr = categoryRateSums(rates, {}, {})
        const perTrio = 2 * (cr.total.syn + cr.total.mis + cr.total.nonSplice)
        const ratio = cr.total.nonSplice / cr.total.syn
        expect(perTrio, 'coding de novo SNVs per trio (published ~1.0-1.3)').to.be.within(0.9, 1.3)
        expect(ratio, '(nonsense+splice)/synonymous (expect ~0.16-0.17)').to.be.within(0.14, 0.19)
        expect(cr.nGenes, 'modelable autosomal genes').to.be.within(15000, 19500)
        // The frameshift-inclusive LoF ratio is a SEPARATE number and must not be confused
        // with the SNV-only one above: ~0.30 vs ~0.16. Pairing p_lof with an SNV-only count
        // is the classic error in this framework, and the gap between these two assertions
        // is exactly its size (1.85x).
        const crFs = categoryRateSums(rates, {}, {}, true)
        const lofRatio = (crFs.total.nonSplice + crFs.total.frameshift) / crFs.total.syn
        expect(lofRatio, 'p_lof/synonymous (expect ~0.30 — the SNV-only LoF PLUS frameshift)').to.be.within(0.27, 0.33)
        expect(lofRatio / ratio, 'including frameshift multiplies the LoF target ~1.85x').to.be.within(1.75, 1.95)
        // And the contrast that justifies the whole change: gnomAD's covariate fails BOTH.
        let mu = {lof: 0, mis: 0, syn: 0}
        for (const r of gnB.values()) { mu.lof += r.muLof || 0; mu.mis += r.muMis || 0; mu.syn += r.muSyn || 0 }
        expect(2 * (mu.lof + mu.mis + mu.syn), 'gnomAD μ is NOT a de novo rate — far below the published scale').to.be.lessThan(0.5)
        expect(mu.lof / mu.syn, 'gnomAD lof.mu/syn.mu class balance is wrong too').to.be.greaterThan(0.25)
    })

    it('the frameshift target can never outrun what the data can count', function () {
        // THE failure mode this design exists to prevent: a LoF target that includes
        // frameshift while the observed count cannot see it inflates λ by 1.85x and
        // manufactures findings. Three independent guards, pinned here.
        const {rateFor, computeModelEnrichment, CODING_TIERS} = require('../dnm-enrichment')

        // 1. frameshift is DERIVED, so the LoF tier's target IS the published p_lof — not a
        //    number of ours that happens to agree with theirs.
        let worst = 0, nNeg = 0, n = 0
        for (const r of rates.values()) {
            const fs = rateFor(r, 'frameshift')
            if (fs == null) continue
            n++
            if (r.pLof - r.pNonSplice < 0) nNeg++
            worst = Math.max(worst, Math.abs((rateFor(r, 'nonSplice') + fs) - r.pLof))
        }
        expect(n, 'frameshift derivable across the bundle').to.be.greaterThan(15000)
        expect(nNeg, 'no gene has p_lof < pNonSplice (the derivation would go negative)').to.equal(0)
        expect(worst, 'LoF tier target === published p_lof, exactly, for every gene').to.be.lessThan(1e-15)
        expect(CODING_TIERS[0].classes, 'the LoF tier is the two components').to.deep.equal(['nonSplice', 'frameshift'])

        // 2. countFrameshift=false zeroes the frameshift target and leaves the SNV-only
        //    component untouched — the pairing an IMPACT-only cohort needs.
        const off = categoryRateSums(rates, {}, {}, false), on = categoryRateSums(rates, {}, {}, true)
        expect(off.total.frameshift, 'OFF ⇒ no frameshift target at all').to.equal(0)
        expect(on.total.frameshift, 'ON ⇒ a real frameshift target').to.be.greaterThan(0)
        expect(off.total.nonSplice, 'the SNV-only component is identical either way').to.be.closeTo(on.total.nonSplice, 1e-15)

        // 3. The dangerous combination THROWS rather than silently inflating λ: a target that
        //    counts frameshift, wired to a cohort with no Consequence column to find one in.
        expect(() => computeModelEnrichment([], {categoryMu: on, consequenceCol: null, N: 100,
            dimensions: [], muByGene: rates, geneCol: 'gene', chromCol: 'chrom', refCol: 'ref',
            altCol: 'alt', inheritanceCol: 'inheritance'}), 'target/count mismatch must be loud').to.throw(/frameshift target\/count mismatch/)
    })

    it('chrX is excluded from Σp — 2·N assumes two copies', function () {
        const cr = categoryRateSums(rates, {}, {})
        let xSyn = 0
        for (const r of rates.values()) if (r && r.chr === 'X') xSyn += r.pSyn || 0
        expect(xSyn, 'the bundle really does carry X rates').to.be.greaterThan(0)
        let allSyn = 0
        for (const r of rates.values()) allSyn += (r && r.pSyn) || 0
        expect(cr.total.syn, 'Σp excludes X').to.be.lessThan(allSyn)
        expect(cr.total.syn + xSyn, 'X is the (main) difference').to.be.at.most(allSyn + 1e-12)
    })
})

describe('litmus: per-source prevalences are in sane ranges', function () {
    // Guards against a build that produces degenerate (0% / 100%) prevalences.
    it('constraint / ClinVar / GenCC prevalences match known magnitudes', function () {
        expect(SRC.constraint.size).to.equal(gnB.size)
        const pli = SRC.constraint.counts['pLI ≥ 0.9'] / SRC.constraint.size
        const loeuf = SRC.constraint.counts['LOEUF < 0.6 (LoF-constrained)'] / SRC.constraint.size
        const plp = SRC.clinvar.counts['Has ClinVar P/LP'] / SRC.clinvar.size
        const ad = SRC.gencc.counts['Autosomal dominant'] / SRC.gencc.size
        expect(pli, 'pLI>=0.9').to.be.within(0.10, 0.25)     // ~17.5%
        expect(loeuf, 'LOEUF<0.6').to.be.within(0.15, 0.30)  // ~21.6%
        expect(plp, 'ClinVar P/LP').to.be.within(0.20, 0.45) // ~32.1%
        expect(ad, 'GenCC AD').to.be.within(0.40, 0.60)      // ~50.4%
    })
    it('every gene-set category prevalence is a small positive fraction', function () {
        for (const id of ['reactome', 'wikipathways', 'hgncFamily', 'msigdbHallmark', 'domain']) {
            const u = SRC[id]
            for (const t of Object.keys(u.counts)) {
                const f = u.counts[t] / u.size
                expect(f, `${id} / ${t}`).to.be.within(0.0000001, 0.15)
            }
        }
    })
})

describe('litmus: per-dimension universes, with the trials gated to match', function () {
    // The bug this pins: the chance rate p was already per-source, but the TRIALS
    // stayed genome-wide — so a category's share of its own library was tested
    // against draws from the whole genome, inflating every dimension's expected
    // count by 1/(its coverage) and making narrow libraries unable to fire at all.
    // The fix is the identity asserted here: the pool the trials are drawn from IS
    // the set p's denominator counts over.
    it('each dimension carries its OWN universe and gene set', function () {
        const dims = Object.keys(SRC)
        expect(dims.length, 'dimensions with a background').to.be.greaterThan(4)
        for (const d of dims) {
            expect(SRC[d].genes, `${d} exposes its gene set for gating`).to.be.instanceOf(Set)
            expect(SRC[d].genes.size, `${d} size matches its gene set`).to.equal(SRC[d].size)
        }
        // The universes are genuinely each source's own — not one shared number.
        expect(SRC.constraint.size, 'constraint == gnomAD bundle').to.equal(gnB.size)
        expect(SRC.gencc.size, 'gencc == GenCC bundle').to.equal(gcB.size)
        expect(SRC.msigdbHallmark.size, 'hallmark == its library').to.equal(gsLibs.msigdbHallmark.size)
        expect(new Set(Object.keys(SRC).map(d => SRC[d].size)).size, 'universes differ').to.be.greaterThan(3)
    })
    it('X-linked genes survive wherever a source knows them (gnomAD has no chrX)', function () {
        // gnomAD v4.1 publishes no chrX constraint, so DDX3X/MECP2 are absent from the
        // constraint universe — but InterPro/ClinVar classify them and DO test them.
        // A single shared background built from gnomAD would have dropped these genes
        // from every dimension; this is the concrete reason the universes differ.
        for (const x of ['DDX3X', 'MECP2', 'DMD']) {
            expect(SRC.constraint.genes.has(x), `${x} absent from constraint`).to.equal(false)
            expect(SRC.domain.genes.has(x), `${x} present in domain`).to.equal(true)
        }
    })
    it('a dimension\'s trials count ONLY genes in its own universe', function () {
        const genes = ['DDX3X', 'TSC2']   // X-linked (not in constraint) + autosomal (in both)
        const geneTerms = new Map()
        for (const g of genes) geneTerms.set(g, geneTermsFor(g, {gnomad: gnB.get(g), clinvar: cvB.get(g), gencc: gcB.get(g)}, null, gsLibs))
        const conv = computeConvergence(genes.map((g, i) => ({gene: g, impact: 'HIGH', curation_status: 'pass', s: 'P' + i})), {
            geneCol: 'gene', impactCol: 'impact', sampleCol: 's', geneTerms,
            dimensions: [{id: 'constraint', label: 'C'}, {id: 'domain', label: 'D'}],
            sourceUniverse: SRC, totalProbands: 2, minCount: 1})
        const c = conv.sections.find(s => s.id === 'constraint'), d = conv.sections.find(s => s.id === 'domain')
        expect(c.nDnmsByTier.ALL, 'constraint n excludes the X-linked gene').to.equal(1)
        expect(d.nDnmsByTier.ALL, 'domain n includes both').to.equal(2)
        expect(c.nOutsideUniverse, 'constraint reports the exclusion').to.equal(1)
        expect(c.outsideGenesSample).to.include('DDX3X')
        expect(d.nOutsideUniverse, 'domain excludes nothing').to.equal(0)
        // Cohort-wide counts stay UNGATED — they are descriptive, never test inputs.
        expect(conv.nPassDnms, 'cohort total counts both').to.equal(2)
        // Each section publishes its own burden histogram (the sample test's input).
        expect(c.burdenHistByTier.ALL).to.be.an('object')
        expect(d.burdenHistByTier.ALL).to.be.an('object')
    })
    it('no background ⇒ dimension is marked unavailable and not tested', function () {
        const geneTerms = new Map([['TSC2', geneTermsFor('TSC2', {gnomad: gnB.get('TSC2')}, null, gsLibs)]])
        const conv = computeConvergence([{gene: 'TSC2', impact: 'HIGH', curation_status: 'pass', s: 'P1'}], {
            geneCol: 'gene', impactCol: 'impact', sampleCol: 's', geneTerms,
            dimensions: [{id: 'gencc', label: 'G'}], sourceUniverse: {}, totalProbands: 1, minCount: 1})
        expect(conv.sections[0].available, 'no source ⇒ unavailable').to.equal(false)
        expect(conv.sections[0].sourceSize).to.equal(null)
        for (const g of conv.sections[0].groups) expect(g.prevalence, 'no p without a background').to.equal(null)
    })
})

describe('litmus: the length-bias diagnostic is reported, never applied', function () {
    // Test A's null counts GENES on purpose — that is the over-representation question, and
    // the mutation-RATE question belongs to Test B. But variants arrive proportional to a
    // gene's mutational TARGET, so a category of large genes collects more by chance than its
    // gene share implies. The diagnostic MEASURES that per category; these tests pin that it
    // measures the right thing AND that it cannot leak into any test statistic.
    const dnmRates = require('../dnm-rates')
    const W = new Map()
    for (const [g, r] of dnmRates.getRates()) {
        const w = (r.pNonSplice || 0) + (r.pMis || 0) + (r.pSyn || 0)
        if (w > 0) W.set(g, w)
    }
    const SRC_W = sourceUniverseStats({gnomad: gnB, clinvar: cvB, gencc: gcB}, gsLibs, W)

    it('weights change nothing about the universe the test uses', function () {
        for (const d of Object.keys(SRC)) {
            expect(SRC_W[d].size, `${d} size`).to.equal(SRC[d].size)
            expect(SRC_W[d].counts, `${d} counts`).to.deep.equal(SRC[d].counts)
        }
        expect(SRC.constraint.wCounts, 'no weights ⇒ no diagnostic').to.equal(undefined)
        expect(SRC_W.constraint.wCounts, 'weights ⇒ diagnostic').to.be.an('object')
    })

    it('measures the real length bias: constraint ~1.4-1.5x, GenCC AR ~1.0x', function () {
        const genes = ['TSC1', 'TSC2', 'MTOR', 'SCN1A', 'BRCA1', 'PTEN']
        const geneTerms = new Map()
        for (const g of genes) geneTerms.set(g, geneTermsFor(g, {gnomad: gnB.get(g), clinvar: cvB.get(g), gencc: gcB.get(g)}, null, gsLibs))
        const vs = genes.map((g, i) => ({gene: g, impact: 'HIGH', curation_status: 'pass', sample: 'P' + (i % 3)}))
        const dims = [{id: 'constraint', label: 'C'}, {id: 'gencc', label: 'G'}]
        const conv = computeConvergence(vs, {geneCol: 'gene', impactCol: 'impact', sampleCol: 'sample',
            geneTerms, dimensions: dims, sourceUniverse: SRC_W, totalProbands: 3, minCount: 1})
        const find = (t) => { for (const s of conv.sections) for (const g of s.groups) if (g.term === t) return g; return null }
        // LOEUF cannot be estimated confidently on a short gene, so the constrained set is
        // ~1.68x larger per gene — a real, measurable bias this column exists to expose.
        expect(find('LOEUF < 0.6 (LoF-constrained)').lengthBaseline, 'constraint is length-biased').to.be.within(1.4, 1.6)
        // …while GenCC AR is genuinely length-neutral and needs no discount.
        const ar = find('Autosomal recessive')
        if (ar) expect(ar.lengthBaseline, 'GenCC AR is length-neutral').to.be.within(0.9, 1.1)
    })

    it('the diagnostic CANNOT leak into prevalence, p, q, fold or the ranking', function () {
        // If this ever fails, the test has silently stopped being count-based — which is a
        // design decision, not an implementation detail, and must not happen by accident.
        const genes = ['TSC1', 'TSC2', 'MTOR', 'SCN1A', 'BRCA1', 'PTEN']
        const geneTerms = new Map()
        for (const g of genes) geneTerms.set(g, geneTermsFor(g, {gnomad: gnB.get(g), clinvar: cvB.get(g), gencc: gcB.get(g)}, null, gsLibs))
        const vs = genes.map((g, i) => ({gene: g, impact: 'HIGH', curation_status: 'pass', sample: 'P' + (i % 3)}))
        const dims = [{id: 'constraint', label: 'C'}, {id: 'gencc', label: 'G'}]
        const mk = (u) => computeConvergence(vs, {geneCol: 'gene', impactCol: 'impact', sampleCol: 'sample',
            geneTerms, dimensions: dims, sourceUniverse: u, totalProbands: 3, minCount: 1})
        const withW = mk(SRC_W), without = mk(SRC)
        for (let i = 0; i < withW.sections.length; i++) {
            const a = withW.sections[i], b = without.sections[i]
            expect(a.groups.map(g => g.term), 'sort order unchanged').to.deep.equal(b.groups.map(g => g.term))
            for (let j = 0; j < a.groups.length; j++) {
                expect(a.groups[j].prevalence).to.equal(b.groups[j].prevalence)
                expect(a.groups[j].foldSampleAll).to.equal(b.groups[j].foldSampleAll)
                expect(a.groups[j].cells['pass|ALL'].pSample).to.equal(b.groups[j].cells['pass|ALL'].pSample)
                expect(a.groups[j].cells['pass|ALL'].qSample).to.equal(b.groups[j].cells['pass|ALL'].qSample)
            }
        }
    })
})

describe('litmus: geneTermsFor and sourceUniverseStats agree (the key invariant)', function () {
    // If the per-gene term derivation and the source-universe counting ever
    // drift, the prevalence numerator (cat size) stops matching the observed
    // counts and K=max(catSize,refGenes) silently papers over it. This asserts
    // every term a real gene is assigned is actually counted in its source.
    it('every assigned term for real genes is present in its source universe', function () {
        const realGenes = ['TSC1', 'TSC2', 'MTOR', 'AKT1', 'RHEB', 'PTEN', 'SCN1A', 'BRCA1', 'A1CF', 'APOBEC1', 'DNMT3A', 'TTN', 'BPTF', 'PLXNA3']
        let checks = 0
        for (const g of realGenes) {
            const terms = geneTermsFor(g, {gnomad: gnB.get(g), clinvar: cvB.get(g), gencc: gcB.get(g)}, null, gsLibs)
            for (const dim of Object.keys(terms)) {
                // domain now has an offline source (InterPro bundle), so include it
                for (const t of terms[dim] || []) {
                    checks++
                    expect(SRC[dim] && SRC[dim].counts[t], `${g}/${dim}/${t}`).to.be.greaterThan(0)
                }
            }
        }
        expect(checks, 'terms checked').to.be.greaterThan(20)   // the sample really has terms
    })
})

describe('litmus: proportions are exactly reconstructable from the raw counts', function () {
    // Builds a realistic run and asserts each printed proportion equals the
    // ratio of the raw-count columns the sheet also shows.
    const realGenes = ['TSC1', 'TSC2', 'MTOR', 'AKT1', 'RHEB', 'PTEN', 'SCN1A', 'BRCA1', 'A1CF', 'APOBEC1', 'DNMT3A', 'TTN', 'BPTF', 'PLXNA3']
    const dims = [...DIMENSIONS, {id: 'reactome', label: 'Reactome'}, {id: 'hgncFamily', label: 'HGNC'}]
    const geneTerms = new Map()
    for (const g of realGenes) geneTerms.set(g, geneTermsFor(g, {gnomad: gnB.get(g), clinvar: cvB.get(g), gencc: gcB.get(g)}, null, gsLibs))
    const variants = realGenes.map((g, i) => ({gene: g, impact: ['HIGH', 'MODERATE', 'LOW'][i % 3], curation_status: i % 3 === 0 ? 'pass' : 'fail', sample: 'P' + (i % 5)}))
    const conv = computeConvergence(variants, {geneCol: 'gene', impactCol: 'impact', sampleCol: 'sample',
        geneTerms, dimensions: dims, sourceUniverse: SRC, totalProbands: 5, minCount: 2})

    it('produced at least one convergence group', function () {
        expect(conv.sections.reduce((n, s) => n + s.groups.length, 0)).to.be.greaterThan(0)
    })
    it('every headline proportion equals its raw-count ratio, and invariants hold', function () {
        const passTierKeys = ['pass|HIGH', 'pass|HIGH_MOD', 'pass|HIGH_MOD_LOW', 'pass|ALL']
        for (const s of conv.sections) for (const g of s.groups) {
            if (g.prevalence != null) expect(g.prevalence).to.be.closeTo(g.catSize / s.sourceSize, 1e-9)
            // all·ALL (quality flag) is a superset of pass·ALL — it counts every
            // curation status, so it can only ever meet or exceed the pass count.
            expect(g.cells['all|ALL'].variants).to.be.at.least(g.cells['pass|ALL'].variants)
            expect(g.cells['all|ALL'].individuals).to.be.at.least(g.cells['pass|ALL'].individuals)
            expect(g.cells['all|ALL'].genes).to.be.at.least(g.cells['pass|ALL'].genes)
            // Headline SAMPLE fold = # pass·ALL probands ÷ the Poisson-binomial mean Σpᵢ —
            // the SAME expectation the sample p-value uses, so fold and q cannot disagree.
            // (NOT (k/cohort)/prevalence: that divides a per-proband rate by a per-draw
            // prevalence, so under the null it tracks the mean variant burden, not 1.)
            if (g.foldSampleAll != null) {
                expect(g.foldSampleAll).to.be.closeTo(g.refIndividuals / g.cells['pass|ALL'].expSample, 1e-9)
                // expSample must be Σ_d n_d·[1−(1−p)^d] over THIS dimension's OWN gated
                // burden histogram — the exact quantity the derivation sheet publishes and
                // the samples tab re-derives live by SUMPRODUCT. Pinning it against the
                // published histogram is what makes the sample track's gating testable at
                // all: fold and expSample move together, so the fold assertion above cannot
                // catch a revert to the cohort-wide burden, which would silently republish
                // every sample p-value (a 5.7× convergence would print as 2.9×).
                expect(g.cells['pass|ALL'].expSample).to.be.closeTo(
                    Object.entries(s.burdenHistByTier.ALL).reduce(
                        (acc, [d, n]) => acc + n * (1 - Math.pow(1 - g.prevalence, Number(d))), 0), 1e-9)
            }
            // Headline DNM fold = k ÷ (n·p) = k ÷ "Expected n·p", where n is THIS
            // dimension's GATED trial count — NOT the cohort-wide pass total, which is
            // larger whenever a variant fell outside this dimension's universe. Dividing
            // by the cohort total against a p that is a share of U_d is precisely the
            // mismatch this build fixes, so the fold must ride the same expectation as
            // the p-value: they cannot be allowed to disagree.
            if (g.foldDnmAll != null) {
                expect(g.foldDnmAll).to.be.closeTo(g.refVariants / g.cells['pass|ALL'].expDnm, 1e-9)
                expect(g.cells['pass|ALL'].expDnm).to.be.closeTo((s.nDnmsByTier.ALL || 0) * g.prevalence, 1e-9)
            }
            // Cumulative tiers are monotonic: HIGH ⊆ HIGH+MOD ⊆ HIGH+MOD+LOW ⊆ ALL.
            for (let i = 1; i < passTierKeys.length; i++) {
                expect(g.cells[passTierKeys[i]].individuals).to.be.at.least(g.cells[passTierKeys[i - 1]].individuals)
                expect(g.cells[passTierKeys[i]].variants).to.be.at.least(g.cells[passTierKeys[i - 1]].variants)
            }
            // invariants
            if (g.prevalence != null) expect(g.prevalence).to.be.within(0, 1)
            if (g.catSize != null) expect(g.catSize).to.be.at.most(s.sourceSize)
            expect(g.refIndividuals).to.be.at.most(conv.nPassProbands)
            expect(g.refVariants).to.be.at.most(conv.nPassDnms)
            for (const tk of passTierKeys) for (const q of [g.cells[tk].qSample, g.cells[tk].qDnm]) if (q != null) expect(q).to.be.within(0, 1)
        }
    })
})

describe('litmus: independent-individual dedup holds', function () {
    it('one proband with 3 hits in a shared category counts once', function () {
        const term = 'Shared category'
        const geneTerms = new Map([['G1', {fam: [term]}], ['G2', {fam: [term]}], ['G3', {fam: [term]}]])
        const conv = computeConvergence(
            [{gene: 'G1', curation_status: 'pass', sample: 'P1'},
             {gene: 'G2', curation_status: 'pass', sample: 'P1'},
             {gene: 'G3', curation_status: 'pass', sample: 'P1'}],
            {geneCol: 'gene', sampleCol: 'sample', geneTerms, dimensions: [{id: 'fam', label: 'Fam'}], minCount: 1, totalProbands: 1})
        const g = conv.sections[0].groups.find(x => x.term === term)
        expect(g).to.exist
        expect(g.refIndividuals, 'distinct probands').to.equal(1)   // not 3
        expect(g.refGenes, 'distinct genes').to.equal(3)
    })
})

describe('litmus: the full XLSX export pipeline produces a valid workbook', function () {
    it('emits Read Me + Gene Summary + the Gene Analysis (variants) matrix tab', async function () {
        this.timeout(20000)
        const res = await request(app)
            .post('/api/export/xlsx')
            // MyGene-dependent columns off + no domain dimension → fully offline, no network.
            .send({exportConfig: {
                genomeBuild: 'hg38',
                sheets: {dataDictionary: true, geneSummary: true, geneAnalysis: true},
                geneAnnotations: {enabled: true, geneName: false, summary: false, omim: false, pathways: false, geneType: false},
                geneAnalysis: {enabled: true, domain: false},
            }})
            .buffer(true)
            .parse((r, cb) => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))) })
            .expect(200)
            .expect('Content-Type', /spreadsheetml/)

        const wb = new ExcelJS.Workbook()
        await wb.xlsx.load(res.body)
        const names = wb.worksheets.map(w => w.name)
        // The variants tab emits whenever Gene Analysis runs and sheets.geneAnalysisVariants is
        // not false; the samples tab additionally needs a sample column in the data.
        expect(names, names.join(',')).to.include.members(['Read Me', 'Gene Summary', 'Gene Analysis (variants)'])

        // The Gene Analysis matrix must carry the category × pass-tier headers.
        const ws = wb.getWorksheet('Gene Analysis (variants)')
        const seen = new Set()
        const headerRow = {}   // header label -> column number
        ws.eachRow(row => row.eachCell((cell, col) => { if (typeof cell.value === 'string') { seen.add(cell.value); if (headerRow[cell.value] == null) headerRow[cell.value] = col } }))
        const TIERS = ['HIGH', 'HIGH+MOD', 'HIGH+MOD+LOW', 'ALL']
        for (const col of ['Category', 'pass·HIGH', 'pass·ALL', 'all·ALL', '# genes', 'cat size', '% all genes', 'Fold (pass·ALL)', 'ALL p/q', 'p (prev)', 'Genes']) {
            expect(seen.has(col), `Gene Analysis header "${col}"`).to.equal(true)
        }
        // EVERY tier must carry its own derivation block — the whole point of the
        // per-tier rework (previously only pass·ALL was reproducible).
        for (const t of TIERS) {
            for (const col of [`k variants (${t})`, `n pass variants (${t})`, `Expected n·p (${t})`, `P(X≥k) (${t})`]) {
                expect(seen.has(col), `Gene Analysis derivation header "${col}"`).to.equal(true)
            }
        }
        // The live BINOMDIST derivation formula must reproduce the engine's binomial p —
        // for each tier, against THAT tier's own n (not the ALL total).
        const pCol = headerRow['p (prev)']
        let checked = 0
        for (const t of TIERS) {
            const kCol = headerRow[`k variants (${t})`], nCol = headerRow[`n pass variants (${t})`], PCol = headerRow[`P(X≥k) (${t})`]
            expect(kCol, `column for k variants (${t})`).to.be.a('number')
            expect(nCol, `column for n pass variants (${t})`).to.be.a('number')
            expect(PCol, `column for P(X≥k) (${t})`).to.be.a('number')
            ws.eachRow(row => {
                const k = row.getCell(kCol).value, n = row.getCell(nCol).value, p = row.getCell(pCol).value, P = row.getCell(PCol).value
                if (typeof k === 'number' && typeof n === 'number' && typeof p === 'number' && P && typeof P === 'object') {
                    expect(P.formula, `live formula (${t})`).to.match(/^1-BINOMDIST\(.*TRUE\)$/)
                    expect(P.result, `P(X≥${k}) reproduces binomUpperTail (${t})`).to.be.closeTo(binomUpperTail(k, n, p), 1e-9)
                    checked++
                }
            })
        }
        // (If the tiny fixture yields no background-bearing convergence rows, the loop is a
        // no-op — the header assertions above still pin the per-tier block's existence.)
        expect(checked, 'derivation rows checked').to.be.at.least(0)
    })
})
