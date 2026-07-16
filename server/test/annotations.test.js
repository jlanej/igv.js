/**
 * Unit tests for the gene-annotation layer added for the Gene Summary export:
 *   - export-config deep-merge of nested provider/impact config
 *   - ClinVar bundled-file provider (offline, deterministic)
 *   - gnomAD provider pure logic (parseConstraint / refGenome / toRow)
 *   - gene-list membership provider (temp fixture)
 *   - annotation-registry orchestration
 *
 * All tests here are network-free and deterministic.
 */

const {describe, it, after} = require('mocha')
const {expect} = require('chai')
const fs = require('fs')
const path = require('path')

const {DEFAULT_EXPORT_CONFIG, mergeWithDefaults} = require('../export-config')
const clinvar = require('../providers/clinvar-provider')
const gnomad = require('../providers/gnomad-provider')
const gencc = require('../providers/gencc-provider')
const geneLists = require('../providers/genelist-provider')
const {computeConvergence, geneTermsFor, sourceUniverseStats, hypergeomUpperTail, binomUpperTail, poissonBinomUpperTail, benjaminiHochberg} = require('../gene-analysis')
const geneSets = require('../genesets')
const registry = require('../annotation-registry')

describe('export-config: nested deep-merge', function () {
    it('fills all new defaults on empty input', function () {
        const cfg = mergeWithDefaults({})
        expect(cfg.impactCounts).to.deep.equal({passByImpact: true, totalByImpact: false})
        expect(cfg.sheets.dataDictionary).to.equal(true)
        expect(cfg.geneAnnotations.gnomadConstraint.enabled).to.equal(true)
        expect(cfg.geneAnnotations.clinvar.enabled).to.equal(true)
        expect(cfg.geneAnnotations.geneLists.enabled).to.equal(true)
    })

    it('preserves sibling sub-flags when a nested partial is given', function () {
        const cfg = mergeWithDefaults({geneAnnotations: {gnomadConstraint: {loeuf: false}}})
        // The shallow-merge bug would have dropped `enabled` and `pli` here.
        expect(cfg.geneAnnotations.gnomadConstraint.loeuf).to.equal(false)
        expect(cfg.geneAnnotations.gnomadConstraint.enabled).to.equal(true)
        expect(cfg.geneAnnotations.gnomadConstraint.pli).to.equal(true)
    })

    it('deep-merges impactCounts partial', function () {
        const cfg = mergeWithDefaults({impactCounts: {totalByImpact: true}})
        expect(cfg.impactCounts.totalByImpact).to.equal(true)
        expect(cfg.impactCounts.passByImpact).to.equal(true)
    })

    it('does not mutate DEFAULT_EXPORT_CONFIG', function () {
        mergeWithDefaults({geneAnnotations: {gnomadConstraint: {loeuf: false}}, impactCounts: {passByImpact: false}})
        expect(DEFAULT_EXPORT_CONFIG.geneAnnotations.gnomadConstraint.loeuf).to.equal(true)
        expect(DEFAULT_EXPORT_CONFIG.impactCounts.passByImpact).to.equal(true)
    })
})

describe('ClinVar provider (bundled)', function () {
    const cfg = mergeWithDefaults({})

    before(function () { clinvar.reset() })

    it('returns separate P and LP counts for a known gene', async function () {
        const map = await clinvar.fetchBatch(['TSC1'])
        const rec = map.get('TSC1')
        expect(rec).to.be.an('object')
        expect(rec.p).to.be.a('number').that.is.greaterThan(0)   // TSC1 has Pathogenic
        expect(rec.lp).to.be.a('number').that.is.greaterThan(0)  // and Likely-pathogenic
        expect(rec.p).to.be.greaterThan(rec.lp)                  // more P than LP for TSC1
        expect(rec.plp).to.be.at.least(rec.p + rec.lp)           // combined = P + LP + mixed
    })

    it('is case-insensitive on symbol', async function () {
        const map = await clinvar.fetchBatch(['tsc1'])
        expect(map.get('TSC1').p).to.be.greaterThan(0)
    })

    it('returns null for genes absent from ClinVar', async function () {
        const map = await clinvar.fetchBatch(['NOT_A_REAL_GENE_XYZ'])
        expect(map.get('NOT_A_REAL_GENE_XYZ')).to.equal(null)
    })

    it('toRow maps separate P/LP counts and the Has-P/LP flag', function () {
        expect(clinvar.toRow({p: 602, lp: 99, plp: 750, vus: 2258, conflicts: 613, total: 5662}, cfg))
            .to.deep.equal({clinvarP: 602, clinvarLp: 99, clinvarHasPlp: 'Yes'})
        expect(clinvar.toRow({p: 0, lp: 0, plp: 0, vus: 5, conflicts: 0, total: 5}, cfg))
            .to.deep.equal({clinvarP: 0, clinvarLp: 0, clinvarHasPlp: 'No'})
        expect(clinvar.toRow(null, cfg)).to.deep.equal({clinvarP: '', clinvarLp: '', clinvarHasPlp: ''})
    })

    it('columns reflect config sub-flags', function () {
        const headers = clinvar.columns(cfg).map(c => c.header)
        expect(headers).to.include.members(['ClinVar P', 'ClinVar LP', 'Has P/LP'])
        expect(headers).to.not.include('ClinVar P/LP')  // combined off by default
        expect(headers).to.not.include('ClinVar VUS')   // vus default off
    })
})

describe('gnomAD provider (pure logic)', function () {
    const cfg = mergeWithDefaults({})

    it('parseConstraint maps the API fields', function () {
        expect(gnomad.parseConstraint({pLI: 1, oe_lof_upper: 0.234, mis_z: 3.64}))
            .to.deep.equal({loeuf: 0.234, pli: 1, misZ: 3.64})
    })

    it('flags constrained on pLI >= 0.9 or LOEUF < 0.35', function () {
        expect(gnomad.isConstrained({pli: 0.2, loeuf: 0.30})).to.equal(true)   // LOEUF < 0.35
        expect(gnomad.isConstrained({pli: 0.95, loeuf: 1.0})).to.equal(true)   // pLI >= 0.9
    })

    it('is not constrained for tolerant genes', function () {
        expect(gnomad.isConstrained({pli: 0.001, loeuf: 1.15})).to.equal(false)
    })

    it('returns null when no constraint object', function () {
        expect(gnomad.parseConstraint(null)).to.equal(null)
    })

    it('maps genome build to gnomAD reference genome', function () {
        expect(gnomad.refGenome({genomeBuild: 'hg38'})).to.equal('GRCh38')
        expect(gnomad.refGenome({genomeBuild: 'hg19'})).to.equal('GRCh37')
        expect(gnomad.refGenome({})).to.equal('GRCh38')
    })

    it('toRow rounds and renders the constrained flag', function () {
        expect(gnomad.toRow({loeuf: 0.23381, pli: 0.99999, misZ: 3.64, constrained: true}, cfg))
            .to.deep.equal({gnomadLoeuf: 0.23, gnomadPli: 1, gnomadConstrained: 'Yes'})
        expect(gnomad.toRow(null, cfg)).to.deep.equal({gnomadLoeuf: '', gnomadPli: '', gnomadConstrained: ''})
    })

    it('column header records the dataset version for the build', function () {
        expect(gnomad.columns(mergeWithDefaults({genomeBuild: 'hg38'}))[0].header).to.contain('v4')
        expect(gnomad.columns(mergeWithDefaults({genomeBuild: 'hg19'}))[0].header).to.contain('v2.1.1')
    })

    it('reads constraint from the bundled file offline (GRCh38, no network)', async function () {
        gnomad.reset()
        const map = await gnomad.fetchBatch(['TSC1', 'NOT_A_REAL_GENE_XYZ'], mergeWithDefaults({genomeBuild: 'hg38'}))
        const tsc1 = map.get('TSC1')
        expect(tsc1).to.be.an('object')
        expect(tsc1.loeuf).to.be.a('number')
        expect(tsc1.pli).to.be.a('number')
        expect(gnomad.toRow(tsc1, cfg).gnomadConstrained).to.equal('Yes')  // TSC1 pLI ~1.0
        expect(map.get('NOT_A_REAL_GENE_XYZ')).to.equal(null)
    })
})

describe('GenCC provider (bundled)', function () {
    const cfg = mergeWithDefaults({})
    before(function () { gencc.reset() })

    it('returns Mode of Inheritance + validity for a known gene', async function () {
        const map = await gencc.fetchBatch(['TSC1'])
        const rec = map.get('TSC1')
        expect(rec).to.be.an('object')
        expect(rec.moi).to.include('Autosomal dominant')   // AD ⇒ de novo can be causal
        expect(rec.validity).to.be.a('string').that.is.not.empty
    })

    it('returns null for genes absent from GenCC', async function () {
        const map = await gencc.fetchBatch(['NOT_A_REAL_GENE_XYZ'])
        expect(map.get('NOT_A_REAL_GENE_XYZ')).to.equal(null)
    })

    it('toRow / columns emit GenCC MOI + Validity', function () {
        expect(gencc.toRow({moi: ['Autosomal dominant', 'Autosomal recessive'], validity: 'Definitive'}, cfg))
            .to.deep.equal({genccMoi: 'Autosomal dominant; Autosomal recessive', genccValidity: 'Definitive'})
        expect(gencc.columns(cfg).map(c => c.header)).to.deep.equal(['GenCC MOI', 'GenCC Validity'])
    })

    it('is a convergence dimension: genes sharing a mode of inheritance stack up', function () {
        const gt = new Map([
            ['A', {constraint: [], clinvar: [], domain: [], gencc: ['Autosomal dominant']}],
            ['B', {constraint: [], clinvar: [], domain: [], gencc: ['Autosomal dominant']}]
        ])
        const conv = computeConvergence(
            [{gene: 'A', s: 'X', impact: 'HIGH', curation_status: 'pass'}, {gene: 'B', s: 'Y', impact: 'HIGH', curation_status: 'pass'}],
            {geneCol: 'gene', impactCol: 'impact', sampleCol: 's', geneTerms: gt})
        const g = conv.sections.find(s => s.id === 'gencc').groups.find(x => x.term === 'Autosomal dominant')
        expect(g.refIndividuals).to.equal(2)
        expect(g.refGenes).to.equal(2)
    })
})

describe('gene-list membership provider', function () {
    const testFile = path.join(geneLists.LIST_DIR, '__test_panel.txt')
    const cfg = mergeWithDefaults({})

    before(function () {
        fs.mkdirSync(geneLists.LIST_DIR, {recursive: true})
        fs.writeFileSync(testFile, '# name: Test Panel\nTSC1\nBRCA1\n')
        geneLists.reset()
    })

    after(function () {
        if (fs.existsSync(testFile)) fs.unlinkSync(testFile)
        geneLists.reset()
    })

    it('is enabled once a list is present', function () {
        expect(geneLists.isEnabled(cfg)).to.equal(true)
    })

    it('emits a membership column with the list label', function () {
        const headers = geneLists.columns(cfg).map(c => c.header)
        expect(headers).to.include('Test Panel')
    })

    it('reports Yes/No membership', async function () {
        const map = await geneLists.fetchBatch(['TSC1', 'GENE1'])
        const key = geneLists.slugKey('Test Panel')
        expect(geneLists.toRow(map.get('TSC1'), cfg)[key]).to.equal('Yes')
        expect(geneLists.toRow(map.get('GENE1'), cfg)[key]).to.equal('No')
    })

    it('is disabled again when no lists exist', function () {
        fs.unlinkSync(testFile)
        geneLists.reset()
        expect(geneLists.isEnabled(cfg)).to.equal(false)
    })
})

describe('annotation-registry', function () {
    before(function () { clinvar.reset(); geneLists.reset() })

    it('merges enabled providers into a per-gene object (offline: ClinVar only)', async function () {
        const cfg = mergeWithDefaults({geneAnnotations: {
            enabled: true, geneName: false, summary: false, omim: false, pathways: false, geneType: false,
            gnomadConstraint: {enabled: false}, clinvar: {enabled: true}, geneLists: {enabled: false}
        }})
        const {byGene, errors} = await registry.annotate(['TSC1', 'GENE1'], cfg)
        expect(errors).to.be.an('array').that.is.empty
        expect(byGene.get('TSC1').clinvar.p).to.be.a('number').that.is.greaterThan(0)
        expect(byGene.get('GENE1').clinvar).to.equal(null)
    })

    it('columns/applyCells reflect only enabled providers', function () {
        const cfg = mergeWithDefaults({geneAnnotations: {
            enabled: true, gnomadConstraint: {enabled: false}, clinvar: {enabled: true}, geneLists: {enabled: false}
        }})
        const headers = registry.columns(cfg).map(c => c.header)
        expect(headers).to.include('ClinVar P')
        expect(headers).to.include('ClinVar LP')
        expect(headers).to.not.include('gnomAD pLI')
        const cells = registry.applyCells({clinvar: {p: 602, lp: 99, plp: 750, total: 5662}}, cfg)
        expect(cells.clinvarP).to.equal(602)
        expect(cells.clinvarLp).to.equal(99)
        expect(cells.clinvarHasPlp).to.equal('Yes')
    })

    it('produces no columns when the master toggle is off', function () {
        const cfg = mergeWithDefaults({geneAnnotations: {enabled: false}})
        expect(registry.columns(cfg)).to.have.length(0)
    })
})

describe('gene-analysis convergence (independent signals)', function () {
    // Individual X: two de novo hits in two different genes (G1, G2), both
    // carrying domain D1, both HIGH/pass. Individual Y: one hit in G3 (D1),
    // MODERATE/pass. The point: X's two DNMs must count as ONE individual.
    const variants = [
        {gene: 'G1', s: 'X', impact: 'HIGH', curation_status: 'pass'},
        {gene: 'G2', s: 'X', impact: 'HIGH', curation_status: 'pass'},
        {gene: 'G3', s: 'Y', impact: 'MODERATE', curation_status: 'pass'}
    ]
    const geneTerms = new Map([
        ['G1', {constraint: ['LOEUF < 0.6 (LoF-constrained)'], clinvar: [], domain: ['D1']}],
        ['G2', {constraint: [], clinvar: [], domain: ['D1']}],
        ['G3', {constraint: ['LOEUF < 0.6 (LoF-constrained)'], clinvar: [], domain: ['D1']}]
    ])
    const opts = {geneCol: 'gene', impactCol: 'impact', sampleCol: 's', geneTerms}

    it('counts distinct individuals, not variants (one proband with 2 DNMs = 1)', function () {
        const conv = computeConvergence(variants, opts)
        const d1 = conv.sections.find(s => s.id === 'domain').groups.find(g => g.term === 'D1')
        expect(d1.refIndividuals).to.equal(2)   // X (once, not twice) + Y
        expect(d1.refGenes).to.equal(3)
        // .include = subset match (cells also carry a `variants` count)
        expect(d1.cells['pass|HIGH']).to.include({individuals: 1, genes: 2, variants: 2})       // X: G1+G2
        expect(d1.cells['pass|HIGH_MOD']).to.include({individuals: 2, genes: 3, variants: 3})   // X + Y
    })

    it('falls back to gene-level convergence for a single proband', function () {
        const single = variants.filter(v => v.s === 'X')  // one individual, two genes share D1
        const conv = computeConvergence(single, opts)
        const d1 = conv.sections.find(s => s.id === 'domain').groups.find(g => g.term === 'D1')
        expect(d1.refIndividuals).to.equal(1)
        expect(d1.refGenes).to.equal(2)   // kept via ≥2 genes
    })

    it('drops attributes shared by <2 individuals and <2 genes', function () {
        const conv = computeConvergence([{gene: 'G3', s: 'Z', impact: 'HIGH', curation_status: 'pass'}], opts)
        expect(conv.sections.find(s => s.id === 'domain').groups).to.have.length(0)
    })

    it('geneTermsFor derives dimension terms from provider + MyGene annotations', function () {
        const terms = geneTermsFor('TSC1', {gnomad: {loeuf: 0.23, pli: 1.0}, clinvar: {plp: 782}}, {domains: ['Hamartin']})
        expect(terms.constraint).to.include.members(['LOEUF < 0.6 (LoF-constrained)', 'pLI ≥ 0.9'])
        expect(terms.clinvar).to.deep.equal(['Has ClinVar P/LP'])
        expect(terms.domain).to.deep.equal(['Hamartin'])
    })

    it('the ALL impact tier includes MODIFIER/blank; HIGH+MOD+LOW excludes them', function () {
        const vs = [
            {gene: 'G1', s: 'X', impact: 'HIGH', curation_status: 'pass'},
            {gene: 'G2', s: 'Y', impact: 'MODIFIER', curation_status: 'pass'},
            {gene: 'G3', s: 'Z', impact: '', curation_status: 'pass'}
        ]
        const gt = new Map([
            ['G1', {constraint: [], clinvar: [], domain: ['D']}],
            ['G2', {constraint: [], clinvar: [], domain: ['D']}],
            ['G3', {constraint: [], clinvar: [], domain: ['D']}]
        ])
        const conv = computeConvergence(vs, {geneCol: 'gene', impactCol: 'impact', sampleCol: 's', geneTerms: gt})
        const d = conv.sections.find(s => s.id === 'domain').groups.find(g => g.term === 'D')
        expect(d.cells['pass|HIGH_MOD_LOW'].individuals).to.equal(1)   // HIGH only
        expect(d.cells['pass|ALL'].individuals).to.equal(3)           // + MODIFIER + blank
    })

    it('all·ALL (quality flag) counts every curation status; pass·ALL counts only pass', function () {
        // One pass + one fail hit in the same category → all·ALL strictly exceeds
        // pass·ALL, so a bug that made them equal (or dropped the fail) is caught.
        const conv = computeConvergence(
            [{gene: 'G1', s: 'P1', impact: 'HIGH', curation_status: 'pass'},
             {gene: 'G2', s: 'P2', impact: 'HIGH', curation_status: 'fail'}],
            {geneCol: 'gene', impactCol: 'impact', sampleCol: 's', minCount: 1,
                geneTerms: new Map([['G1', {fam: ['D']}], ['G2', {fam: ['D']}]]),
                dimensions: [{id: 'fam', label: 'Fam'}]})
        const g = conv.sections.find(s => s.id === 'fam').groups.find(x => x.term === 'D')
        expect(g.cells['pass|ALL'].variants).to.equal(1)      // only the pass hit
        expect(g.cells['pass|ALL'].individuals).to.equal(1)
        expect(g.cells['all|ALL'].variants).to.equal(2)       // pass + fail
        expect(g.cells['all|ALL'].individuals).to.equal(2)
        expect(g.cells['all|ALL'].variants).to.be.greaterThan(g.cells['pass|ALL'].variants)
    })

    it('hypergeomUpperTail returns exact upper-tail probabilities', function () {
        expect(hypergeomUpperTail(0, 10, 5, 5)).to.equal(1)                 // k<=0
        expect(hypergeomUpperTail(5, 10, 5, 5)).to.be.closeTo(1 / 252, 1e-9)
        expect(hypergeomUpperTail(3, 10, 5, 5)).to.be.closeTo(0.5, 1e-9)
        expect(hypergeomUpperTail(4, 10, 3, 3)).to.equal(0)                 // k>min(K,n)
        expect(hypergeomUpperTail(1, 0, 0, 0)).to.equal(null)              // degenerate
        expect(hypergeomUpperTail(3, 20000, 400, 50)).to.be.a('number').and.be.greaterThan(0)  // large-N stable
    })

    it('benjaminiHochberg controls the FDR and skips nulls', function () {
        expect(benjaminiHochberg([0.01, 0.02, 0.03, 0.04, 0.05]).every(q => Math.abs(q - 0.05) < 1e-12)).to.equal(true)
        const q = benjaminiHochberg([0.001, null, 0.5])
        expect(q[0]).to.be.closeTo(0.002, 1e-12)   // m=2 (nulls excluded)
        expect(q[1]).to.equal(null)
        expect(q[2]).to.be.closeTo(0.5, 1e-12)
    })

    it('binomUpperTail returns exact DNM-level upper-tail probabilities', function () {
        expect(binomUpperTail(0, 5, 0.3)).to.equal(1)                       // k<=0
        expect(binomUpperTail(5, 5, 0.3)).to.be.closeTo(Math.pow(0.3, 5), 1e-12)
        expect(binomUpperTail(6, 5, 0.3)).to.equal(0)                       // k>n
        expect(binomUpperTail(1, 3, 0.5)).to.be.closeTo(0.875, 1e-12)       // 1 - 0.5^3
        expect(binomUpperTail(2, 3, 0.5)).to.be.closeTo(0.5, 1e-12)
        expect(binomUpperTail(1, 0, 0.3)).to.equal(null)                    // degenerate n
    })

    it('poissonBinomUpperTail (conservative sample test) is exact', function () {
        expect(poissonBinomUpperTail(0, [0.5, 0.5])).to.equal(1)
        expect(poissonBinomUpperTail(1, [0.5, 0.5])).to.be.closeTo(0.75, 1e-12)
        expect(poissonBinomUpperTail(2, [0.5, 0.5])).to.be.closeTo(0.25, 1e-12)
        expect(poissonBinomUpperTail(3, [0.5, 0.5])).to.equal(0)            // k>n
        expect(poissonBinomUpperTail(1, [0.2, 0.3, 0.5])).to.be.closeTo(0.72, 1e-12)
        expect(poissonBinomUpperTail(2, [0.2, 0.3, 0.5])).to.be.closeTo(0.25, 1e-12)
        expect(poissonBinomUpperTail(3, [0.2, 0.3, 0.5])).to.be.closeTo(0.03, 1e-12)
        expect(poissonBinomUpperTail(1, [])).to.equal(null)
    })

    it('sourceUniverseStats gives each dimension its own universe + gene set', function () {
        // Each source knows a DIFFERENT set of genes, so each dimension divides by its
        // own: constraint by gnomAD's 3, gencc by GenCC's 2, fam by the library's 3.
        // The `genes` Set is what computeConvergence gates that dimension's trials on.
        const gnomad = new Map([['A', {pli: 0.95}], ['B', {pli: 0.1}], ['C', {loeuf: 0.3}]])
        const gencc = new Map([['A', {moi: ['Autosomal dominant']}], ['B', {moi: ['Autosomal recessive']}]])
        const fam = new Map([['A', ['T']], ['B', ['T']], ['C', []]])
        const su = sourceUniverseStats({gnomad, gencc}, {fam})
        expect(su.constraint.size).to.equal(3)
        expect(su.constraint.counts['pLI ≥ 0.9']).to.equal(1)                        // A
        expect(su.constraint.counts['LOEUF < 0.6 (LoF-constrained)']).to.equal(1)    // C
        expect(su.gencc.size, 'gencc divides by its own 2 genes').to.equal(2)
        expect(su.gencc.counts['Autosomal dominant']).to.equal(1)
        expect(su.fam.size, 'fam divides by its own 3 genes').to.equal(3)
        expect(su.fam.counts.T).to.equal(2)                                          // A,B
        // The gene set must be exposed — without it the engine cannot gate the trials
        // and the whole fix silently reverts to the mismatch it replaces.
        expect(su.constraint.genes).to.be.instanceOf(Set)
        expect([...su.constraint.genes].sort()).to.deep.equal(['A', 'B', 'C'])
        expect([...su.gencc.genes].sort()).to.deep.equal(['A', 'B'])
        for (const d of Object.keys(su)) expect(su[d].genes.size).to.equal(su[d].size)
    })

    it('a dimension with no source is absent — no background, no test', function () {
        // Not merely untested: it must not appear at all, so it can never enter a BH
        // family or print a p against a background it does not have.
        const su = sourceUniverseStats({}, {fam: new Map([['A', ['T']]])})
        expect(su.constraint).to.equal(undefined)
        expect(su.gencc).to.equal(undefined)
        expect(su.fam.size).to.equal(1)
        expect(Object.keys(sourceUniverseStats({}, {})), 'nothing at all').to.be.empty
    })

    it('per-source prevalence + per-pass-tier sample & DNM enrichment attach to cells', function () {
        // Source universe for dim "fam": 10 genes, term T carried by 3 (A,B,C).
        const famLib = new Map([['A', ['T']], ['B', ['T']], ['C', ['T']],
            ['D', []], ['E', []], ['F', []], ['G', []], ['H', []], ['I', []], ['J', []]])
        const srcU = sourceUniverseStats({}, {fam: famLib})
        expect(srcU.fam.counts.T).to.equal(3)
        expect(srcU.fam.size).to.equal(10)
        // Two pass probands (X, Y), each one pass HIGH DNM → all 4 pass tiers = 2.
        const conv = computeConvergence(
            [{gene: 'A', s: 'X', impact: 'HIGH', curation_status: 'pass'},
             {gene: 'B', s: 'Y', impact: 'HIGH', curation_status: 'pass'}],
            {geneCol: 'gene', impactCol: 'impact', sampleCol: 's', minCount: 2,
                geneTerms: new Map([['A', {fam: ['T']}], ['B', {fam: ['T']}]]),
                dimensions: [{id: 'fam', label: 'Family'}], sourceUniverse: srcU, totalProbands: 20})
        const grp = conv.sections.find(s => s.id === 'fam').groups.find(g => g.term === 'T')
        expect(grp.refIndividuals).to.equal(2)
        expect(grp.refVariants).to.equal(2)
        expect(grp.catSize).to.equal(3)
        expect(grp.prevalence).to.be.closeTo(0.3, 1e-9)
        // Enrichment lives on each PASS cell. burden [1,1] → probs [.3,.3] → PB(2)=.09; binom(2,2,.3)=.09.
        for (const ck of ['pass|HIGH', 'pass|ALL']) {
            expect(grp.cells[ck].pSample, ck).to.be.closeTo(0.3 * 0.3, 1e-9)
            expect(grp.cells[ck].pDnm, ck).to.be.closeTo(Math.pow(0.3, 2), 1e-9)
            expect(grp.cells[ck].qSample, ck).to.be.closeTo(0.3 * 0.3, 1e-9)   // 4 identical → q=p
            expect(grp.cells[ck].qDnm, ck).to.be.closeTo(Math.pow(0.3, 2), 1e-9)
        }
        // Headline folds at pass|ALL = OBSERVED ÷ EXPECTED-under-the-null, so 1× is chance.
        // Sample expected = the Poisson-binomial mean Σpᵢ: burden [1,1], p=0.3 ⇒ 0.6.
        expect(grp.cells['pass|ALL'].expSample).to.be.closeTo(0.6, 1e-9)
        expect(grp.foldSampleAll).to.be.closeTo(2 / 0.6, 1e-9)          // 3.33×
        expect(grp.foldDnmAll).to.be.closeTo((2 / 2) / 0.3, 1e-9)       // 3.33×
        // With a UNIFORM burden of 1 the two nulls coincide, so the tabs must agree. The old
        // (k/totalProbands)/prevalence form gave 0.33× here — reading DEPLETED on the same data
        // the DNMs tab called 3.33× enriched, and that this tab's own q calls significant.
        expect(grp.foldSampleAll).to.be.closeTo(grp.foldDnmAll, 1e-9)
    })

    it('a dimension with no source universe gets null prevalence/p on every cell', function () {
        const conv = computeConvergence(
            [{gene: 'A', s: 'X', impact: 'HIGH', curation_status: 'pass'},
             {gene: 'B', s: 'Y', impact: 'HIGH', curation_status: 'pass'}],
            {geneCol: 'gene', impactCol: 'impact', sampleCol: 's', minCount: 2,
                geneTerms: new Map([['A', {domain: ['Dom']}], ['B', {domain: ['Dom']}]]),
                dimensions: [{id: 'domain', label: 'Domain'}], sourceUniverse: {}, totalProbands: 5})
        const grp = conv.sections.find(s => s.id === 'domain').groups[0]
        expect(grp.prevalence).to.equal(null)
        expect(grp.foldSampleAll).to.equal(null)
        expect(grp.foldDnmAll).to.equal(null)
        for (const f of ['pSample', 'qSample', 'pDnm', 'qDnm']) expect(grp.cells['pass|ALL'][f], f).to.satisfy(v => v == null)
        expect(grp.cells['pass|ALL'].individuals).to.equal(2)   // counts still there
    })

    it('no sample column → SAMPLE cell p suppressed, DNM cell p survives', function () {
        const srcU = sourceUniverseStats({}, {fam: new Map([['A', ['T']], ['B', ['T']], ['C', ['T']], ['D', []]])})
        const conv = computeConvergence(
            [{gene: 'A', impact: 'HIGH', curation_status: 'pass'}, {gene: 'B', impact: 'HIGH', curation_status: 'pass'}],
            {geneCol: 'gene', impactCol: 'impact', sampleCol: null, minCount: 2,
                geneTerms: new Map([['A', {fam: ['T']}], ['B', {fam: ['T']}]]),
                dimensions: [{id: 'fam', label: 'Family'}], sourceUniverse: srcU, totalProbands: 1})
        const grp = conv.sections.find(s => s.id === 'fam').groups[0]
        expect(conv.hasSamples).to.equal(false)
        expect(grp.cells['pass|ALL'].pSample).to.satisfy(v => v == null)   // no proband base
        expect(grp.foldSampleAll).to.equal(null)
        expect(grp.cells['pass|ALL'].pDnm).to.not.equal(null)              // DNM survives
        expect(grp.prevalence).to.be.closeTo(3 / 4, 1e-9)
    })

    it('per-tier stats differ by tier, and BH covers the FULL category × tier family', function () {
        // Two categories with DISTINCT prevalences; T2 converges ONLY at HIGH+MOD
        // (0 pass DNMs at the HIGH tier). This pins three properties at once:
        //   (F4) per-tier differentiation: T1's pDnm at HIGH (0.1²) ≠ at ALL
        //        (binom(2,4,0.1)) because nDnmsByTier grows HIGH:2 → ALL:4.
        //   (F1) no data-dependent family: T2's 0-count pass|HIGH cell IS a tested
        //        hypothesis and gets its exact p = P(X≥0) = 1, counting toward m=8.
        //        Gating on an observed hit would let the data pick the family and
        //        push the real FDR far above nominal.
        //   (F3) BH scope: hand-BH over all 8 cells [0.01, 0.0523×3, 0.1808×3, 1], m=8.
        // Universe of 100 genes; T1 prevalence 10%, T2 prevalence 20%.
        const srcU = {fam: {size: 100, counts: {T1: 10, T2: 20}}}
        const conv = computeConvergence(
            [{gene: 'GA', impact: 'HIGH', curation_status: 'pass', s: 'P1'},
             {gene: 'GB', impact: 'HIGH', curation_status: 'pass', s: 'P2'},
             {gene: 'GC', impact: 'MODERATE', curation_status: 'pass', s: 'P3'},
             {gene: 'GD', impact: 'MODERATE', curation_status: 'pass', s: 'P4'}],
            {geneCol: 'gene', impactCol: 'impact', sampleCol: 's', minCount: 2,
                geneTerms: new Map([['GA', {fam: ['T1']}], ['GB', {fam: ['T1']}], ['GC', {fam: ['T2']}], ['GD', {fam: ['T2']}]]),
                dimensions: [{id: 'fam', label: 'Fam'}], sourceUniverse: srcU, totalProbands: 50})
        const sec = conv.sections.find(s => s.id === 'fam')
        const T1 = sec.groups.find(g => g.term === 'T1')
        const T2 = sec.groups.find(g => g.term === 'T2')
        // F4 — per-tier differentiation (would be equal if the code ignored the tier's DNM total)
        expect(T1.cells['pass|HIGH'].pDnm).to.be.closeTo(0.01, 1e-6)         // binom(2,2,0.1)=0.1²
        expect(T1.cells['pass|ALL'].pDnm).to.be.closeTo(0.0523, 1e-6)        // binom(2,4,0.1)
        expect(T1.cells['pass|HIGH'].pDnm).to.not.be.closeTo(T1.cells['pass|ALL'].pDnm, 1e-6)
        // F1 — the 0-count pass|HIGH cell of T2 is a TESTED hypothesis: exact p=P(X≥0)=1.
        expect(T2.cells['pass|HIGH'].variants).to.equal(0)
        expect(T2.cells['pass|HIGH'].pDnm, 'k=0 ⇒ exact p=1, in the family').to.equal(1)
        expect(T2.cells['pass|HIGH'].qDnm).to.equal(1)
        expect(T2.cells['pass|HIGH'].pSample).to.equal(1)
        expect(T2.cells['pass|HIGH_MOD'].pDnm).to.be.closeTo(0.1808, 1e-6)   // binom(2,4,0.2)
        // F3 — hand-BH over ALL 8 cells [0.01, 0.0523×3, 0.1808×3, 1], m=8 (2 cats × 4 tiers)
        expect(sec.mDnm, 'BH family spans every category × tier').to.equal(8)
        expect(sec.mSample).to.equal(8)
        expect(T1.cells['pass|HIGH'].qDnm).to.be.closeTo(0.08, 1e-5)         // 0.01·8/1
        expect(T1.cells['pass|ALL'].qDnm).to.be.closeTo(0.1046, 1e-5)        // 0.0523·8/4
        expect(T2.cells['pass|ALL'].qDnm).to.be.closeTo(0.206629, 1e-5)      // 0.1808·8/7
        // sample family is numerically identical here (every proband burden = 1)
        expect(T1.cells['pass|HIGH'].qSample).to.be.closeTo(0.08, 1e-5)
        expect(T1.cells['pass|ALL'].qSample).to.be.closeTo(0.1046, 1e-5)
        // headline folds = observed ÷ expected-under-the-null
        expect(T1.foldDnmAll).to.be.closeTo((2 / 4) / 0.1, 1e-9)             // 5×
        // sample: Σpᵢ over 4 probands at burden 1, p=0.1 ⇒ 0.4; 2/0.4 = 5×. (The old form gave
        // 0.4× — it scaled with the cohort size (50) instead of the at-risk expectation.)
        expect(T1.cells['pass|ALL'].expSample).to.be.closeTo(0.4, 1e-9)
        expect(T1.foldSampleAll).to.be.closeTo(2 / 0.4, 1e-9)                // 5×
        expect(T2.foldDnmAll).to.be.closeTo((2 / 4) / 0.2, 1e-9)             // 2.5×
    })

    it('the display filter does NOT shrink the BH family (q is corrected for every category tested)', function () {
        // T3 is a singleton (1 gene, 1 proband) so it is filtered OUT of the displayed
        // rows by minCount — but it WAS tested, so it must still count toward m. If the
        // keep-rule were allowed to define the family, the data would be choosing the
        // hypotheses and every surviving q would be too small.
        const srcU = {fam: {size: 100, counts: {T1: 10, T2: 20, T3: 5}}}
        const conv = computeConvergence(
            [{gene: 'GA', impact: 'HIGH', curation_status: 'pass', s: 'P1'},
             {gene: 'GB', impact: 'HIGH', curation_status: 'pass', s: 'P2'},
             {gene: 'GC', impact: 'MODERATE', curation_status: 'pass', s: 'P3'},
             {gene: 'GD', impact: 'MODERATE', curation_status: 'pass', s: 'P4'},
             {gene: 'GE', impact: 'HIGH', curation_status: 'pass', s: 'P5'}],   // singleton → T3
            {geneCol: 'gene', impactCol: 'impact', sampleCol: 's', minCount: 2,
                geneTerms: new Map([['GA', {fam: ['T1']}], ['GB', {fam: ['T1']}], ['GC', {fam: ['T2']}],
                    ['GD', {fam: ['T2']}], ['GE', {fam: ['T3']}]]),
                dimensions: [{id: 'fam', label: 'Fam'}], sourceUniverse: srcU, totalProbands: 50})
        const sec = conv.sections.find(s => s.id === 'fam')
        // T3 is NOT displayed …
        expect(sec.groups.map(g => g.term).sort()).to.deep.equal(['T1', 'T2'])
        // … but it IS in the family: 3 categories × 4 tiers = 12, not 8.
        expect(sec.mDnm, 'singleton still counted in m').to.equal(12)
        expect(sec.mSample).to.equal(12)
        expect(sec.nCategories, 'categories tested (pre-display-filter)').to.equal(3)
        // And its presence genuinely costs the survivors significance. The exact value is
        // the assertion that bites: BH is a step-up, so T1|HIGH (rank 1) does NOT take its
        // own 0.028·12/1 = 0.336 — it inherits the smaller q from rank 4 (0.08146·12/4 =
        // 0.24438) via the running min. If T3 were dropped from the family (m=8) this cell
        // would read 0.16292 instead, so pin the number, not an inequality.
        const T1 = sec.groups.find(g => g.term === 'T1')
        expect(T1.cells['pass|HIGH'].pDnm).to.be.closeTo(0.028, 1e-6)     // binom(2,3,0.1)
        expect(T1.cells['pass|HIGH'].qDnm).to.be.closeTo(0.24438, 1e-5)   // = 0.08146·12/4, inherited by step-up
        expect(T1.cells['pass|HIGH'].qDnm, 'must NOT be the filter-before-BH value (m=8)').to.not.be.closeTo(0.16292, 1e-4)
    })

    it('UNHIT library categories still count toward m (the family is a-priori, not data-defined)', function () {
        // The library defines 5 categories; the cohort only ever touches T1. The other
        // four were still scanned — each has k=0 ⇒ exact p=1 — so m must be 5×4 tiers,
        // NOT 1×4. Correcting across only the hit category is the anti-conservative
        // failure mode (measured ~15% real FDR at nominal 5% on the sparse libraries we
        // bundle, where most categories go unhit).
        const conv = computeConvergence(
            [{gene: 'GA', impact: 'HIGH', curation_status: 'pass', s: 'P1'},
             {gene: 'GB', impact: 'HIGH', curation_status: 'pass', s: 'P2'}],
            {geneCol: 'gene', impactCol: 'impact', sampleCol: 's', minCount: 2,
                geneTerms: new Map([['GA', {fam: ['T1']}], ['GB', {fam: ['T1']}]]),
                dimensions: [{id: 'fam', label: 'Fam'}],
                // T9a..T9d exist in the library but no cohort gene belongs to them.
                sourceUniverse: {fam: {size: 100, counts: {T1: 10, T9a: 5, T9b: 5, T9c: 5, T9d: 5}}},
                totalProbands: 50})
        const sec = conv.sections.find(s => s.id === 'fam')
        expect(sec.nCategories, 'only T1 is hit').to.equal(1)
        expect(sec.mDnm, 'm spans all 5 LIBRARY categories × 4 tiers').to.equal(20)
        expect(sec.mSample).to.equal(20)
        const T1 = sec.groups.find(g => g.term === 'T1')
        expect(T1.cells['pass|HIGH'].pDnm).to.be.closeTo(0.01, 1e-9)
        // q = p·m/rank = 0.01·20/1. Had the 4 unhit categories been dropped (m=4) this
        // would read 0.04 — i.e. 5× more significant than the scan actually justifies.
        expect(T1.cells['pass|HIGH'].qDnm).to.be.closeTo(0.05, 1e-9)
    })

    it('sourceUniverseStats omits constraint when no gnomad bundle (GRCh37 build gate)', function () {
        // No constraint background ⇒ the dimension is absent ⇒ not tested at all,
        // rather than tested against a v4.1 background it doesn't match.
        const su = sourceUniverseStats({clinvar: new Map([['A', {plp: 1}]])}, {})
        expect(su.constraint).to.equal(undefined)
        expect(su.clinvar.size).to.equal(1)
    })
})

describe('gene-set libraries (convergence dimensions)', function () {
    it('bundles load with clean licences and non-empty gene maps', function () {
        const avail = geneSets.available()
        expect(avail.map(a => a.id)).to.include.members(['reactome', 'wikipathways', 'hgncFamily', 'msigdbHallmark'])
        for (const a of avail) {
            expect(a.meta.license, a.id).to.be.a('string').and.not.equal('')
            expect(a.meta.geneCount, a.id).to.be.greaterThan(0)
        }
    })

    it('geneTermsFor adds gene-set memberships (TSC1 is in Reactome mTOR pathways)', function () {
        const terms = geneTermsFor('TSC1', {}, null, {reactome: geneSets.libMap('reactome')})
        expect(terms.reactome).to.be.an('array').with.length.greaterThan(0)
        expect(terms.reactome.join(' ')).to.match(/MTOR|mTOR|TSC/i)
    })

    it('MSigDB Hallmark carries no KEGG/BioCarta sets (encumbered licences excluded)', function () {
        const hm = geneSets.libMap('msigdbHallmark')
        const terms = new Set()
        for (const ts of hm.values()) for (const t of ts) terms.add(t)
        for (const t of terms) expect(t).to.not.match(/^KEGG_|^BIOCARTA_/i)
    })
})

describe('dnm-enrichment (Test B — de novo mutation-rate)', function () {
    const {computeModelEnrichment, categoryRateSums, poissonUpperTail, DE_NOVO, MODELS} = require('../dnm-enrichment')
    const {computeConvergence} = require('../gene-analysis')

    it('poissonUpperTail is exact for small λ and keeps precision for tiny p', function () {
        expect(poissonUpperTail(0, 1.5)).to.equal(1)
        expect(poissonUpperTail(1, 0.7)).to.be.closeTo(1 - Math.exp(-0.7), 1e-12)
        expect(poissonUpperTail(2, 0.5)).to.be.closeTo(1 - Math.exp(-0.5) * 1.5, 1e-12)   // 1-e^-λ(1+λ)
        expect(poissonUpperTail(1, 0)).to.equal(0)                                        // k≥1, zero expectation
        expect(poissonUpperTail(1, null)).to.equal(null)
        expect(poissonUpperTail(3, 1)).to.be.lessThan(poissonUpperTail(2, 1))            // monotone in k
        // tail summation (k≫λ) keeps a tiny p instead of flooring to 0.
        const tiny = poissonUpperTail(6, 0.001)
        expect(tiny).to.be.greaterThan(0).and.to.be.lessThan(1e-18)   // kept precision, not floored to 0
        // value ≈ the leading Poisson term e^−λ·λ⁶/6! (higher terms add only ~λ/7 ≈ 1.4e-4)
        const lead = Math.exp(-0.001) * Math.pow(0.001, 6) / 720
        expect(tiny).to.be.closeTo(lead, lead * 2e-3)
    })

    // Two maps with genuinely different shapes, because they are different things:
    //  - `rates`  = per-gene per-transmission de novo probabilities (the λ input).
    //  - `gnomad` = the constraint bundle, used ONLY for the constraint dimension's gene
    //    universe + its LOEUF/pLI terms. Its lof.mu/mis.mu/syn.mu are a mutability
    //    COVARIATE and must never be mistaken for a rate again.
    // G1/G2/G3 autosomal; GX on chrX (must be excluded — 2·N assumes two copies).
    const rates = new Map([
        ['G1', {pNonSplice: 1e-6, pMis: 5e-6, pSyn: 3e-6, chr: '1'}],
        ['G2', {pNonSplice: 2e-6, pMis: 4e-6, pSyn: 2e-6, chr: '2'}],
        ['G3', {pNonSplice: 1e-6, pMis: 1e-6, pSyn: 1e-6, chr: '3'}],
        ['GX', {pNonSplice: 1e-6, pMis: 1e-6, pSyn: 1e-6, chr: 'X'}]
    ])
    const gnomad = new Map([
        ['G1', {chr: '1', pli: 0.95, loeuf: 0.3}],
        ['G2', {chr: '2'}], ['G3', {chr: '3'}], ['GX', {chr: 'X'}]
    ])
    const fam = new Map([['G1', ['T']], ['G2', ['T']], ['G3', []]])

    it('categoryRateSums excludes non-autosomal genes and sums per class', function () {
        // GX is chrX: λ = 2·N·p counts two parental transmissions, which assumes two
        // copies, so X must never enter Σp — even though the real table carries 819 X genes.
        const cmu = categoryRateSums(rates, {gnomad}, {fam})
        expect(cmu.total.nonSplice).to.be.closeTo(4e-6, 1e-18)     // G1+G2+G3 (not GX)
        expect(cmu.byDim.fam.T.nonSplice).to.be.closeTo(3e-6, 1e-18)   // G1+G2
        expect(cmu.byDim.fam.T.mis).to.be.closeTo(9e-6, 1e-18)
        expect(cmu.byDim.constraint['pLI ≥ 0.9'].nonSplice).to.be.closeTo(1e-6, 1e-18)   // G1 only
        expect(cmu.nGenes, 'modelable autosomal genes').to.equal(3)
    })

    const geneTerms = new Map([['G1', {fam: ['T']}], ['G2', {fam: ['T']}], ['G3', {fam: []}]])
    const V = (o) => Object.assign({curation_status: 'pass', inh: 'de_novo', ref: 'A', alt: 'G', chrom: '1', s: 'P?'}, o)
    const opts = (extra) => Object.assign({model: DE_NOVO, geneCol: 'gene', impactCol: 'impact', sampleCol: 's',
        chromCol: 'chrom', refCol: 'ref', altCol: 'alt', inheritanceCol: 'inh', geneTerms,
        dimensions: [{id: 'fam', label: 'Fam'}], muByGene: rates,
        categoryMu: categoryRateSums(rates, {gnomad}, {fam}), N: 100, nReliable: true, minCount: 1}, extra)

    it('gates to pass de novo SNV autosomal coding, and λ = 2·N·Σp·ê', function () {
        const variants = [
            V({gene: 'G1', impact: 'HIGH', s: 'P1'}),                                   // used lof
            V({gene: 'G2', impact: 'MODERATE', chrom: '2', ref: 'C', alt: 'T', s: 'P2'}), // used mis
            V({gene: 'G1', impact: 'HIGH', ref: 'AT', alt: 'A', s: 'P3'}),               // indel → excluded
            V({gene: 'GX', impact: 'HIGH', chrom: 'X', s: 'P4'}),                        // chrX → excluded
            V({gene: 'G1', impact: 'HIGH', inh: 'inherited', s: 'P5'}),                  // not de novo
            V({gene: 'G1', impact: 'MODIFIER', s: 'P6'})                                 // non-coding → excluded
        ]
        const res = computeModelEnrichment(variants, opts())
        const m = res.meta
        expect(m.nPassDeNovo).to.equal(5)          // P1,P2,indel,X,MODIFIER (P5 inherited excluded)
        expect(m.exclIndel).to.equal(1)
        expect(m.exclXY).to.equal(1)
        expect(m.exclNonCoding).to.equal(1)
        expect(m.nUsed).to.equal(2)
        expect(m.byClass).to.deep.equal({nonSplice: 1, mis: 1, syn: 0})
        // No synonymous variants here ⇒ ê cannot be fitted ⇒ λ falls back to the raw 2·N·Σp
        // (scale 1) and the tab withholds ✓. Pin it, so the λ assertions below are read
        // against a KNOWN scale rather than an accidental one.
        expect(m.calibration.eHatUsable, 'no syn ⇒ ê unfitted').to.equal(false)
        expect(m.eApplied, 'unfitted ê ⇒ scale 1').to.equal(1)
        const T = res.perCategory.sections.find(s => s.id === 'fam').groups.find(g => g.term === 'T')
        expect(res.perCategory.tiers.map(t => t.key)).to.deep.equal(['HIGH', 'HIGH_MOD'])   // no synonymous tier
        expect(T.cells.HIGH.k).to.equal(1)
        expect(T.cells.HIGH.lambda).to.be.closeTo(2 * 100 * 3e-6 * 1, 1e-12)     // 2·N·Σp_nonSplice(T)·ê
        expect(T.cells.HIGH.p).to.be.closeTo(poissonUpperTail(1, 2 * 100 * 3e-6), 1e-12)
        expect(T.cells.HIGH_MOD.k).to.equal(2)                               // nonsense+splice + mis
        expect(T.cells.HIGH.q).to.be.a('number')                            // BH applied
    })

    it('per-class rate gate: a nonsense de novo in a gene with no pNonSplice is excluded (k↔λ stay consistent)', function () {
        const gp = new Map([['GP', {pNonSplice: null, pMis: 5e-6, pSyn: 3e-6, chr: '1'}]])
        const res = computeModelEnrichment([V({gene: 'GP', impact: 'HIGH', s: 'PA'})], Object.assign(opts(), {
            muByGene: gp, categoryMu: categoryRateSums(gp, {gnomad: gp}, {fam: new Map([['GP', ['T']]])}),
            geneTerms: new Map([['GP', {fam: ['T']}]])
        }))
        expect(res.meta.exclNoClassMu).to.equal(1)   // nonsense variant, but no pNonSplice → no modelable target
        expect(res.meta.nUsed).to.equal(0)
        // a missense de novo in the SAME gene IS counted (it has mis.mu)
        const res2 = computeModelEnrichment([V({gene: 'GP', impact: 'MODERATE', s: 'PB'})], Object.assign(opts(), {
            muByGene: gp, categoryMu: categoryRateSums(gp, {gnomad: gp}, {fam: new Map([['GP', ['T']]])}),
            geneTerms: new Map([['GP', {fam: ['T']}]])
        }))
        expect(res2.meta.nUsed).to.equal(1)
        expect(res2.meta.exclNoClassMu).to.equal(0)
    })

    it('k=0 tier cells ARE in the BH family with their exact p=1, matching Test A', function () {
        // T2 carries a single missense de novo → its HIGH tier (LoF) has k=0. Keep the
        // numerator (geneTerms) and denominator (categoryMu) membership consistent.
        const fam2 = new Map([['G1', ['T']], ['G2', ['T2']]])
        const res = computeModelEnrichment([V({gene: 'G2', impact: 'MODERATE', chrom: '2', s: 'P2'})],
            Object.assign(opts(), {geneTerms: new Map([['G1', {fam: ['T']}], ['G2', {fam: ['T2']}]]),
                categoryMu: categoryRateSums(rates, {gnomad}, {fam: fam2})}))
        const sec = res.perCategory.sections.find(s => s.id === 'fam')
        const t2 = sec.groups.find(g => g.term === 'T2')
        expect(t2.cells.HIGH.k).to.equal(0)
        // The tier WAS tested; P(X≥0)=1 exactly. It can never be rejected, but dropping it
        // would let the observed data shrink m — the anti-conservative failure mode.
        expect(t2.cells.HIGH.p, 'k=0 ⇒ exact p=1, still a member of the family').to.equal(1)
        expect(t2.cells.HIGH.q).to.equal(1)
        expect(t2.cells.HIGH_MOD.k).to.equal(1)
        expect(t2.cells.HIGH_MOD.p).to.be.a('number')
        // m spans the A-PRIORI grid: both LIBRARY categories (T and T2) × both coding
        // tiers = 4 — even though only T2 carries an observed de novo.
        expect(sec.m, 'family spans library category × tier, incl. unhit + no-hit cells').to.equal(4)
        expect(sec.nCategories, 'only T2 was hit').to.equal(1)
        expect(t2.cells.HIGH_MOD.q).to.be.closeTo(t2.cells.HIGH_MOD.p * 4, 1e-9)   // rank 1 of m=4
    })

    it('synonymous calibration control is computed genome-wide (obs ÷ 2N·Σsyn.μ)', function () {
        const variants = [
            V({gene: 'G3', impact: 'LOW', chrom: '3', s: 'P1'}),   // syn de novo (G3 has syn.mu, no fam term)
            V({gene: 'G1', impact: 'HIGH', s: 'P2'})               // lof (not synonymous)
        ]
        const res = computeModelEnrichment(variants, opts())
        const cmu = categoryRateSums(rates, {gnomad}, {fam})
        expect(res.meta.byClass.syn).to.equal(1)
        expect(res.meta.calibration.syn.exp).to.be.closeTo(2 * 100 * cmu.total.syn, 1e-12)
        expect(res.meta.calibration.syn.ratio).to.be.closeTo(1 / (2 * 100 * cmu.total.syn), 1e-6)
    })

    it('Test A captures the indel that Test B excludes (no variant is dropped)', function () {
        const indel = {gene: 'G1', impact: 'HIGH', curation_status: 'pass', inh: 'de_novo', ref: 'AT', alt: 'A', chrom: '1', s: 'P1'}
        // Test B excludes it (SNV-only)
        const b = computeModelEnrichment([indel], opts())
        expect(b.meta.exclIndel).to.equal(1)
        expect(b.meta.nUsed).to.equal(0)
        // Test A counts it (origin/type-agnostic)
        const a = computeConvergence([indel], {geneCol: 'gene', impactCol: 'impact', sampleCol: 's', minCount: 1,
            geneTerms: new Map([['G1', {fam: ['T']}]]), dimensions: [{id: 'fam', label: 'Fam'}], totalProbands: 1})
        const g = a.sections.find(s => s.id === 'fam').groups.find(x => x.term === 'T')
        expect(g.cells['pass|ALL'].variants).to.equal(1)   // the indel is represented in Test A
    })

    it('non-de-novo model is registered but not computed (extension stub)', function () {
        const res = computeModelEnrichment([], {model: MODELS.recessive_hom, dimensions: [], N: 100})
        expect(res.perCategory.sections).to.have.lengthOf(0)
        expect(res.meta.notImplemented).to.equal('frequency')
    })

    it('per-gene: LoF/missense/protein-altering are separate discovery families; synonymous is calibration', function () {
        const variants = [
            V({gene: 'G1', impact: 'HIGH', s: 'P1'}),                                    // G1 LoF
            V({gene: 'G2', impact: 'MODERATE', chrom: '2', ref: 'C', alt: 'T', s: 'P2'}), // G2 missense
            V({gene: 'G3', impact: 'LOW', chrom: '3', s: 'P7'})                          // G3 synonymous
        ]
        const pg = computeModelEnrichment(variants, opts()).perGene
        const row = (g, t) => pg.rows.find(r => r.gene === g && r.track === t)
        // G1 nonsense: k=1, p=pNonSplice, λ=2·N·p·ê
        expect(row('G1', 'lof').k).to.equal(1)
        expect(row('G1', 'lof').lambda).to.be.closeTo(2 * 100 * 1e-6, 1e-12)
        expect(row('G1', 'lof').p).to.be.closeTo(poissonUpperTail(1, 2 * 100 * 1e-6), 1e-12)
        expect(row('G1', 'lof').q).to.be.a('number')                 // discovery FDR
        // G1 protein-altering: μ = lof.mu + mis.mu
        expect(row('G1', 'protein_altering').mu).to.be.closeTo(6e-6, 1e-18)
        expect(row('G1', 'mis')).to.equal(undefined)                 // no observed missense in G1 → no row
        // synonymous is a calibration row: q stays null
        expect(row('G3', 'syn').q).to.equal(null)
        // The scan is EXOME-WIDE: m counts every AUTOSOMAL gene with a μ for that track
        // (G1/G2/G3 — GX is chrX and excluded), not just the genes with an observed de
        // novo. Correcting only across observed genes would let the data pick the family.
        expect(pg.familySizes).to.deep.equal({lof: 3, mis: 3, protein_altering: 3, syn: 3})
        // …while only the observed (gene, track) rows are materialised for display.
        expect(pg.observedRows).to.deep.equal({lof: 1, mis: 1, protein_altering: 2, syn: 1})
        // q is corrected against the exome-wide m, not the 1 observed LoF row.
        expect(row('G1', 'lof').q).to.be.closeTo(row('G1', 'lof').p * 3, 1e-12)
    })
})
