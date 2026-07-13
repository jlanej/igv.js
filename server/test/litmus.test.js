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
const {computeConvergence, geneTermsFor, sourceUniverseStats, DIMENSIONS} = require('../gene-analysis')
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
const SRC = sourceUniverseStats({gnomad: gnB, clinvar: cvB, gencc: gcB}, gsLibs)

describe('litmus: bundled data loads with expected magnitudes', function () {
    it('gnomAD / ClinVar / GenCC bundles are present and full', function () {
        expect(gnB.size, 'gnomAD').to.be.within(15000, 20000)   // ~17.5k
        expect(cvB.size, 'ClinVar').to.be.greaterThan(25000)    // ~31k
        expect(gcB.size, 'GenCC').to.be.greaterThan(5000)       // ~6.1k
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
            // Headline SAMPLE fold = (# pass·ALL samples ÷ the true cohort) ÷ prevalence
            if (g.foldSampleAll != null) expect(g.foldSampleAll).to.be.closeTo((g.refIndividuals / conv.totalProbands) / g.prevalence, 1e-9)
            // Headline DNM fold = (# pass·ALL DNMs ÷ pass DNMs) ÷ prevalence
            if (g.foldDnmAll != null) expect(g.foldDnmAll).to.be.closeTo((g.refVariants / conv.nPassDnms) / g.prevalence, 1e-9)
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
    it('emits Read Me + Gene Summary + the Gene Analysis (DNMs) matrix tab', async function () {
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
        // The DNM tab is always emitted; the samples tab only when a sample column exists.
        expect(names, names.join(',')).to.include.members(['Read Me', 'Gene Summary', 'Gene Analysis (DNMs)'])

        // The Gene Analysis matrix must carry the category × pass-tier headers.
        const ws = wb.getWorksheet('Gene Analysis (DNMs)')
        const seen = new Set()
        ws.eachRow(row => row.eachCell(cell => { if (typeof cell.value === 'string') seen.add(cell.value) }))
        for (const col of ['Category', 'pass·HIGH', 'pass·ALL', 'all·ALL', '# genes', 'cat size', '% all genes', 'Fold (pass·ALL)', 'ALL p/q', 'Genes']) {
            expect(seen.has(col), `Gene Analysis header "${col}"`).to.equal(true)
        }
    })
})
