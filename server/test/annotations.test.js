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
const {computeConvergence, geneTermsFor, sourceUniverseStats, hypergeomUpperTail, benjaminiHochberg} = require('../gene-analysis')
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
        expect(d1.cells['pass|HIGH']).to.deep.equal({individuals: 1, genes: 2})       // X only
        expect(d1.cells['pass|HIGH_MOD']).to.deep.equal({individuals: 2, genes: 3})   // X + Y
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

    it('sourceUniverseStats derives per-source prevalence from bundles + libraries', function () {
        const gnomad = new Map([['A', {pli: 0.95}], ['B', {pli: 0.1}], ['C', {loeuf: 0.3}]])
        const gencc = new Map([['A', {moi: ['Autosomal dominant']}], ['B', {moi: ['Autosomal recessive']}]])
        const fam = new Map([['A', ['T']], ['B', ['T']], ['C', []]])
        const su = sourceUniverseStats({gnomad, gencc}, {fam})
        expect(su.constraint.size).to.equal(3)
        expect(su.constraint.counts['pLI ≥ 0.9']).to.equal(1)                        // A
        expect(su.constraint.counts['LOEUF < 0.6 (LoF-constrained)']).to.equal(1)    // C
        expect(su.gencc.size).to.equal(2)
        expect(su.gencc.counts['Autosomal dominant']).to.equal(1)
        expect(su.fam.size).to.equal(3)
        expect(su.fam.counts.T).to.equal(2)                                          // A,B
    })

    it('per-source prevalence + descriptive proportions + ORA attach to groups', function () {
        // Source universe for dim "fam": 10 genes, term T carried by 3 (A,B,C).
        const famLib = new Map([['A', ['T']], ['B', ['T']], ['C', ['T']],
            ['D', []], ['E', []], ['F', []], ['G', []], ['H', []], ['I', []], ['J', []]])
        const srcU = sourceUniverseStats({}, {fam: famLib})
        expect(srcU.fam.size).to.equal(10)
        expect(srcU.fam.counts.T).to.equal(3)
        const conv = computeConvergence(
            [{gene: 'A', s: 'X', impact: 'HIGH', curation_status: 'pass'},
             {gene: 'B', s: 'Y', impact: 'HIGH', curation_status: 'pass'}],
            {geneCol: 'gene', impactCol: 'impact', sampleCol: 's', minCount: 2,
                geneTerms: new Map([['A', {fam: ['T']}], ['B', {fam: ['T']}]]),
                dimensions: [{id: 'fam', label: 'Family'}], sourceUniverse: srcU,
                selectedSizes: {fam: 2}, selectedSize: 2, totalProbands: 20})
        const fam = conv.sections.find(s => s.id === 'fam')
        const grp = fam.groups.find(g => g.term === 'T')
        expect(grp.refGenes).to.equal(2)
        expect(grp.prevalence).to.be.closeTo(0.3, 1e-9)          // 3/10 (per-source)
        expect(grp.pctGenes).to.be.closeTo(1, 1e-9)              // 2 of 2 selected genes
        expect(grp.pctDnms).to.be.closeTo(1, 1e-9)               // 2 of 2 variants
        expect(grp.fold).to.be.closeTo((2 / 20) / 0.3, 1e-9)     // proband-rate / prevalence
        expect(grp.enrichP).to.be.closeTo(3 / 45, 1e-9)          // hypergeom(2,10,3,2)
        expect(grp.enrichQ).to.be.closeTo(3 / 45, 1e-9)          // single test
        // Raw counts to reconstruct the proportions
        expect(grp.catSize).to.equal(3)                          // source genes in T (% all genes numerator)
        expect(grp.refVariants).to.equal(2)                      // your variants in T (% DNMs numerator)
        expect(fam.sourceSize).to.equal(10)                      // source universe size (% all genes denom)
        expect(conv.totalProbands).to.equal(20)
        expect(conv.selectedSize).to.equal(2)                    // % genes denominator
        expect(conv.totalVariants).to.equal(2)                   // % DNMs denominator
    })

    it('a dimension with no source universe gets null prevalence/ORA but keeps descriptive rates', function () {
        const conv = computeConvergence(
            [{gene: 'A', s: 'X', impact: 'HIGH', curation_status: 'pass'},
             {gene: 'B', s: 'Y', impact: 'HIGH', curation_status: 'pass'}],
            {geneCol: 'gene', impactCol: 'impact', sampleCol: 's', minCount: 2,
                geneTerms: new Map([['A', {domain: ['Dom']}], ['B', {domain: ['Dom']}]]),
                dimensions: [{id: 'domain', label: 'Domain'}], sourceUniverse: {}, selectedSize: 2, totalProbands: 5})
        const grp = conv.sections.find(s => s.id === 'domain').groups[0]
        expect(grp.prevalence).to.equal(null)
        expect(grp.enrichP).to.equal(null)
        expect(grp.enrichQ).to.equal(null)
        expect(grp.fold).to.equal(null)
        expect(grp.pctGenes).to.be.closeTo(1, 1e-9)              // rates need no source
    })

    it('no sample column → probands collapse, Fold suppressed, prevalence intact', function () {
        const srcU = sourceUniverseStats({}, {fam: new Map([['A', ['T']], ['B', ['T']], ['C', ['T']], ['D', []]])})
        const conv = computeConvergence(
            [{gene: 'A', impact: 'HIGH', curation_status: 'pass'}, {gene: 'B', impact: 'HIGH', curation_status: 'pass'}],
            {geneCol: 'gene', impactCol: 'impact', sampleCol: null, minCount: 2,
                geneTerms: new Map([['A', {fam: ['T']}], ['B', {fam: ['T']}]]),
                dimensions: [{id: 'fam', label: 'Family'}], sourceUniverse: srcU,
                selectedSizes: {fam: 2}, selectedSize: 2, totalProbands: 1})
        const grp = conv.sections.find(s => s.id === 'fam').groups[0]
        expect(conv.hasSamples).to.equal(false)
        expect(grp.fold).to.equal(null)                          // no proband base → no fold
        expect(grp.prevalence).to.be.closeTo(3 / 4, 1e-9)        // prevalence still valid (3 of 4)
    })

    it('sourceUniverseStats omits constraint when no gnomad bundle (GRCh37 build gate)', function () {
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
