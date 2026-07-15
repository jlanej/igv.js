/**
 * Unit tests for the MitoCarta 3.0 provider (mitocarta.js).
 *
 * The heavy lifting is the pure `xlsRowsToMaps` transform (SheetJS rows → the three
 * gene maps + per-gene annotation); it is fully deterministic and network-free, so it
 * carries most of the coverage. The loader/annotation surface is tested for its
 * offline-degradation contract (bundles are CC BY-NC, gitignored, and absent in CI —
 * so `available()` is empty and `annotationFor` returns null there), with a spot-check
 * that only runs when a local runtime download has populated the bundles.
 *
 * All tests here are network-free and deterministic.
 */

const {describe, it} = require('mocha')
const {expect} = require('chai')

const mitocarta = require('../mitocarta')
const {mergeWithDefaults} = require('../export-config')

const LIST = 'MitoCarta3.0_List'
const SUB = 'MitoCarta3.0_SubMitoLocalization'
const PATH = 'MitoCarta3.0_MitoPathways'
const M = 'MitoCarta3.0'   // mito flag value

describe('mitocarta.xlsRowsToMaps — pure transform (genome-universe, sheet B)', function () {
    // Rows mirror the real sheet-B structure: ALL screened genes, mito flagged by
    // MitoCarta3.0_List. Non-mito rows carry empty sub-loc/pathways (as in the source).
    const rows = [
        {Symbol: 'ndufa1', [LIST]: M, [SUB]: 'MIM', [PATH]: 'OXPHOS > Complex I > CI subunits | OXPHOS > OXPHOS subunits'},
        {Symbol: 'SDHB', [LIST]: M, [SUB]: 'MOM|IMS', [PATH]: 'OXPHOS > Complex II > CII subunits'},
        {Symbol: 'FOO1', [LIST]: M, [SUB]: 'unknown', [PATH]: 0},   // mito, unknown subloc, numeric-0 path
        {Symbol: 'BAR2', [LIST]: M, [SUB]: 'Membrane', [PATH]: ''}, // mito, blank pathways
        {Symbol: 'DUP3', [LIST]: M, [SUB]: 'Matrix | Matrix', [PATH]: 'Metabolism > Amino acid metabolism > Glycine metabolism | Metabolism'},
        {Symbol: 'NOTMITO', [LIST]: '0.0', [SUB]: '', [PATH]: 0},   // NON-mito genome gene
        {Symbol: 'INTERACT', [LIST]: 'mito-interacting', [SUB]: '', [PATH]: 0}, // interacting ≠ mito
        {Symbol: '   ', [LIST]: M, [SUB]: 'MIM', [PATH]: 'X > Y'},  // empty symbol → skipped
    ]
    const {localization, subLoc, pathways, annotation} = mitocarta.xlsRowsToMaps(rows)

    it('includes EVERY screened gene in the universe (non-mito carry [])', function () {
        // 7 genes with a symbol (empty-symbol row skipped) — this is the "% all genes" denominator.
        expect([...localization.keys()].sort()).to.deep.equal(
            ['BAR2', 'DUP3', 'FOO1', 'INTERACT', 'NDUFA1', 'NOTMITO', 'SDHB'])
        expect(localization.get('NDUFA1')).to.deep.equal([mitocarta.MITO_TERM])
        expect(localization.get('NOTMITO')).to.deep.equal([])       // non-mito → no term, still in universe
        expect(localization.get('INTERACT')).to.deep.equal([])      // mito-interacting is NOT mito
    })

    it('splits sub-localization only on the pipe and de-duplicates (mito genes only)', function () {
        expect(subLoc.get('SDHB')).to.deep.equal(['MOM', 'IMS'])
        expect(subLoc.get('DUP3')).to.deep.equal(['Matrix'])
        expect(subLoc.get('BAR2')).to.deep.equal(['Membrane'])
        expect(subLoc.get('NOTMITO')).to.deep.equal([])             // present in universe, no term
    })

    it('drops "unknown" as missing sub-localization (gene still mitochondrial)', function () {
        expect(subLoc.get('FOO1')).to.deep.equal([])
        expect(localization.get('FOO1')).to.deep.equal([mitocarta.MITO_TERM])
        expect(annotation.get('FOO1')).to.deep.equal({mito: true, subLoc: []})
    })

    it('ancestor-expands pathway hierarchies and de-duplicates shared ancestors', function () {
        expect(pathways.get('NDUFA1')).to.deep.equal([
            'OXPHOS', 'OXPHOS > Complex I', 'OXPHOS > Complex I > CI subunits', 'OXPHOS > OXPHOS subunits',
        ])
        // The bare "Metabolism" path collapses into the ancestor already emitted by the leaf path.
        expect(pathways.get('DUP3')).to.deep.equal([
            'Metabolism', 'Metabolism > Amino acid metabolism', 'Metabolism > Amino acid metabolism > Glycine metabolism',
        ])
    })

    it('emits no pathway terms for empty / numeric-0 / non-mito genes', function () {
        expect(pathways.get('FOO1')).to.deep.equal([])
        expect(pathways.get('BAR2')).to.deep.equal([])
        expect(pathways.get('NOTMITO')).to.deep.equal([])
    })

    it('annotates ONLY mitochondrial genes (non-mito absent from the annotation map)', function () {
        expect(annotation.has('NOTMITO')).to.equal(false)
        expect(annotation.has('INTERACT')).to.equal(false)
        expect(annotation.get('SDHB')).to.deep.equal({mito: true, subLoc: ['MOM', 'IMS']})
        for (const [g, ann] of annotation) expect(ann.subLoc).to.deep.equal(subLoc.get(g) || [])
    })

    it('skips rows with an empty symbol entirely', function () {
        expect(localization.has('')).to.equal(false)
        expect([...localization.keys()]).to.not.include('X')
    })
})

describe('mitocarta — loader offline-degradation contract', function () {
    it('returns null annotation for a gene that is not in MitoCarta', function () {
        // Deterministic regardless of whether the runtime bundles are present locally.
        expect(mitocarta.annotationFor('NOT_A_REAL_GENE_XYZ')).to.equal(null)
        expect(mitocarta.annotationFor('')).to.equal(null)
    })

    it('exposes a well-formed available() list (empty when bundles absent)', function () {
        const avail = mitocarta.available()
        expect(avail).to.be.an('array')
        for (const a of avail) {
            expect(a).to.have.property('id')
            expect(a).to.have.property('label')
            expect(mitocarta.DIMS.map(d => d.id)).to.include(a.id)
        }
    })

    it('libMap returns a Map for a known dim id and an empty Map for an unknown one', function () {
        expect(mitocarta.libMap('mitoLocalization')).to.be.a('Map')
        expect(mitocarta.libMap('does_not_exist').size).to.equal(0)
    })

    it('spot-checks a canonical mito gene ONLY when a local bundle is present', function () {
        if (!mitocarta.available().length) return this.skip()
        const a = mitocarta.annotationFor('NDUFA1')   // Complex I subunit — always in MitoCarta
        expect(a).to.be.an('object')
        expect(a.mito).to.equal(true)
        expect(a.subLoc).to.be.an('array')
    })

    it('uses the genome universe for localization but the within-mito universe for subloc/pathways (bundle present)', function () {
        if (!mitocarta.available().length) return this.skip()
        const loc = mitocarta.libMap('mitoLocalization')
        const sub = mitocarta.libMap('mitoSubLocalization')
        const pat = mitocarta.libMap('mitoPathways')
        // localization keeps the whole screened genome (~19k) — much larger than the
        // annotated-mito libs (~1k); a non-mito gene is present but carries no term.
        expect(loc.size).to.be.greaterThan(15000)
        expect(sub.size).to.be.lessThan(2000)
        expect(pat.size).to.be.lessThan(2000)
        expect(loc.size).to.be.greaterThan(sub.size * 5)
        // subloc/pathways store ONLY members (no empty term lists).
        for (const terms of sub.values()) expect(terms.length).to.be.greaterThan(0)
        for (const terms of pat.values()) expect(terms.length).to.be.greaterThan(0)
    })
})

describe('export-config — MitoCarta toggles', function () {
    it('defaults the three convergence dimensions + the annotation column on', function () {
        const cfg = mergeWithDefaults({})
        expect(cfg.geneAnalysis.mitoLocalization).to.equal(true)
        expect(cfg.geneAnalysis.mitoSubLocalization).to.equal(true)
        expect(cfg.geneAnalysis.mitoPathways).to.equal(true)
        expect(cfg.geneAnnotations.mitocarta).to.equal(true)
    })

    it('respects an explicit opt-out of a MitoCarta dimension', function () {
        const cfg = mergeWithDefaults({geneAnalysis: {mitoPathways: false}})
        expect(cfg.geneAnalysis.mitoPathways).to.equal(false)
        expect(cfg.geneAnalysis.mitoLocalization).to.equal(true)
    })
})
