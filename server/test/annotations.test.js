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
const geneLists = require('../providers/genelist-provider')
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

    it('returns P/LP counts for a known gene', async function () {
        const map = await clinvar.fetchBatch(['TSC1'])
        const rec = map.get('TSC1')
        expect(rec).to.be.an('object')
        expect(rec.plp).to.equal(782)
        expect(rec.total).to.equal(5767)
    })

    it('is case-insensitive on symbol', async function () {
        const map = await clinvar.fetchBatch(['tsc1'])
        expect(map.get('TSC1').plp).to.equal(782)
    })

    it('returns null for genes absent from ClinVar', async function () {
        const map = await clinvar.fetchBatch(['NOT_A_REAL_GENE_XYZ'])
        expect(map.get('NOT_A_REAL_GENE_XYZ')).to.equal(null)
    })

    it('toRow maps counts and Has-P/LP flag', function () {
        expect(clinvar.toRow({plp: 782, vus: 2290, conflicts: 613, total: 5767}, cfg))
            .to.deep.equal({clinvarPlp: 782, clinvarHasPlp: 'Yes'})
        expect(clinvar.toRow({plp: 0, vus: 5, conflicts: 0, total: 5}, cfg))
            .to.deep.equal({clinvarPlp: 0, clinvarHasPlp: 'No'})
        expect(clinvar.toRow(null, cfg)).to.deep.equal({clinvarPlp: '', clinvarHasPlp: ''})
    })

    it('columns reflect config sub-flags', function () {
        const headers = clinvar.columns(cfg).map(c => c.header)
        expect(headers).to.include.members(['ClinVar P/LP', 'Has P/LP'])
        expect(headers).to.not.include('ClinVar VUS')  // vus default off
    })
})

describe('gnomAD provider (pure logic)', function () {
    const cfg = mergeWithDefaults({})

    it('parseConstraint maps fields and flags constrained genes', function () {
        expect(gnomad.parseConstraint({pLI: 1, oe_lof_upper: 0.234, mis_z: 3.64}))
            .to.deep.equal({loeuf: 0.234, pli: 1, misZ: 3.64, constrained: true})
    })

    it('flags constrained on LOEUF < 0.35 even with low pLI', function () {
        expect(gnomad.parseConstraint({pLI: 0.2, oe_lof_upper: 0.30}).constrained).to.equal(true)
    })

    it('is not constrained for tolerant genes', function () {
        expect(gnomad.parseConstraint({pLI: 0.001, oe_lof_upper: 1.15, mis_z: 0.3}).constrained).to.equal(false)
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
        expect(byGene.get('TSC1').clinvar.plp).to.equal(782)
        expect(byGene.get('GENE1').clinvar).to.equal(null)
    })

    it('columns/applyCells reflect only enabled providers', function () {
        const cfg = mergeWithDefaults({geneAnnotations: {
            enabled: true, gnomadConstraint: {enabled: false}, clinvar: {enabled: true}, geneLists: {enabled: false}
        }})
        const headers = registry.columns(cfg).map(c => c.header)
        expect(headers).to.include('ClinVar P/LP')
        expect(headers).to.not.include('gnomAD pLI')
        const cells = registry.applyCells({clinvar: {plp: 782, total: 5767}}, cfg)
        expect(cells.clinvarPlp).to.equal(782)
        expect(cells.clinvarHasPlp).to.equal('Yes')
    })

    it('produces no columns when the master toggle is off', function () {
        const cfg = mergeWithDefaults({geneAnnotations: {enabled: false}})
        expect(registry.columns(cfg)).to.have.length(0)
    })
})
