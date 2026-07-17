const {describe, it, before, after} = require('mocha')
const {expect} = require('chai')
const request = require('supertest')
const fs = require('fs')
const path = require('path')
const ExcelJS = require('exceljs')

const app = require('../server')

// Clean up any curation file produced during tests
const curationFile = path.join(__dirname, '..', 'example_data', 'variants.curation.json')

describe('API /api/config', function () {
    it('returns server configuration', async function () {
        const res = await request(app).get('/api/config').expect(200)
        expect(res.body).to.have.property('genome', 'hg38')
        expect(res.body).to.have.property('columns').that.is.an('array')
        expect(res.body.columns).to.include('chrom')
        expect(res.body.columns).to.include('pos')
        expect(res.body.columns).to.include('ref')
        expect(res.body.columns).to.include('alt')
        expect(res.body).to.have.property('totalVariants').that.is.a('number')
        expect(res.body.totalVariants).to.equal(10)
    })
})

describe('API /api/variants', function () {
    it('returns paginated variant list', async function () {
        const res = await request(app).get('/api/variants').expect(200)
        expect(res.body).to.have.property('total', 10)
        expect(res.body).to.have.property('page', 1)
        expect(res.body).to.have.property('data').that.is.an('array')
        expect(res.body.data.length).to.equal(10)
    })

    it('respects per_page parameter', async function () {
        const res = await request(app).get('/api/variants?per_page=3').expect(200)
        expect(res.body.data.length).to.equal(3)
        expect(res.body.pages).to.equal(4)
    })

    it('supports pagination', async function () {
        const res = await request(app).get('/api/variants?per_page=3&page=2').expect(200)
        expect(res.body.page).to.equal(2)
        expect(res.body.data.length).to.equal(3)
    })

    it('filters by gene', async function () {
        const res = await request(app).get('/api/variants?gene=GENE2').expect(200)
        expect(res.body.total).to.equal(2)
        res.body.data.forEach(v => expect(v.gene).to.equal('GENE2'))
    })

    it('filters by impact', async function () {
        const res = await request(app).get('/api/variants?impact=HIGH').expect(200)
        expect(res.body.total).to.equal(5)
        res.body.data.forEach(v => expect(v.impact).to.equal('HIGH'))
    })

    it('filters by multiple impact values (comma-separated)', async function () {
        const res = await request(app).get('/api/variants?impact=HIGH,MODERATE').expect(200)
        expect(res.body.total).to.equal(8)
        res.body.data.forEach(v => expect(['HIGH', 'MODERATE']).to.include(v.impact))
    })

    it('uses exact match for categorical filters', async function () {
        // Filtering by inheritance=de_novo should NOT match "inherited" via includes
        const res = await request(app).get('/api/variants?inheritance=de_novo').expect(200)
        res.body.data.forEach(v => expect(v.inheritance).to.equal('de_novo'))
        expect(res.body.total).to.equal(8) // 8 de_novo, not 10
    })

    it('filters by numeric range (frequency_max)', async function () {
        const res = await request(app).get('/api/variants?frequency_max=0.001').expect(200)
        res.body.data.forEach(v => {
            expect(Number(v.frequency)).to.be.at.most(0.001)
        })
    })

    it('filters by numeric range (quality_min)', async function () {
        const res = await request(app).get('/api/variants?quality_min=45').expect(200)
        res.body.data.forEach(v => {
            expect(Number(v.quality)).to.be.at.least(45)
        })
    })

    it('combines multiple filters', async function () {
        const res = await request(app)
            .get('/api/variants?impact=HIGH&frequency_max=0.001')
            .expect(200)
        expect(res.body.total).to.be.greaterThan(0)
        res.body.data.forEach(v => {
            expect(v.impact).to.equal('HIGH')
            expect(Number(v.frequency)).to.be.at.most(0.001)
        })
    })

    it('sorts by column ascending', async function () {
        const res = await request(app)
            .get('/api/variants?sort=pos&order=asc')
            .expect(200)
        const positions = res.body.data.map(v => v.pos)
        for (let i = 1; i < positions.length; i++) {
            expect(positions[i]).to.be.at.least(positions[i - 1])
        }
    })

    it('sorts by column descending', async function () {
        const res = await request(app)
            .get('/api/variants?sort=pos&order=desc')
            .expect(200)
        const positions = res.body.data.map(v => v.pos)
        for (let i = 1; i < positions.length; i++) {
            expect(positions[i]).to.be.at.most(positions[i - 1])
        }
    })
})

describe('API /api/variants functional_filter', function () {
    // Helper to build the functional_filter query param
    function ff(conditions) {
        return encodeURIComponent(JSON.stringify(conditions))
    }

    // Test data (example_data/variants.tsv):
    //   impact: HIGH×5, MODERATE×3, LOW×2
    //   quality values: 35 42 50 28 38 45 55 32 48 30

    it('categorical "in" – single value matches expected rows', async function () {
        const conds = [{col: 'impact', op: 'in', values: ['HIGH']}]
        const res = await request(app)
            .get(`/api/variants?functional_filter=${ff(conds)}`)
            .expect(200)
        expect(res.body.total).to.equal(5)
        res.body.data.forEach(v => expect(v.impact).to.equal('HIGH'))
    })

    it('categorical "in" – multiple values act as OR within the condition', async function () {
        const conds = [{col: 'impact', op: 'in', values: ['HIGH', 'MODERATE']}]
        const res = await request(app)
            .get(`/api/variants?functional_filter=${ff(conds)}`)
            .expect(200)
        expect(res.body.total).to.equal(8)
        res.body.data.forEach(v => expect(['HIGH', 'MODERATE']).to.include(v.impact))
    })

    it('categorical "in" is case-insensitive', async function () {
        const conds = [{col: 'impact', op: 'in', values: ['high', 'moderate']}]
        const res = await request(app)
            .get(`/api/variants?functional_filter=${ff(conds)}`)
            .expect(200)
        expect(res.body.total).to.equal(8)
    })

    it('numeric ">" – returns only variants above threshold', async function () {
        // quality > 40: values 42,50,45,55,48 → 5 variants
        const conds = [{col: 'quality', op: '>', value: 40}]
        const res = await request(app)
            .get(`/api/variants?functional_filter=${ff(conds)}`)
            .expect(200)
        expect(res.body.total).to.equal(5)
        res.body.data.forEach(v => expect(Number(v.quality)).to.be.greaterThan(40))
    })

    it('numeric ">=" – returns variants at or above threshold', async function () {
        // quality >= 50: 50, 55 → 2 variants
        const conds = [{col: 'quality', op: '>=', value: 50}]
        const res = await request(app)
            .get(`/api/variants?functional_filter=${ff(conds)}`)
            .expect(200)
        expect(res.body.total).to.equal(2)
        res.body.data.forEach(v => expect(Number(v.quality)).to.be.at.least(50))
    })

    it('numeric "<" – returns variants below threshold', async function () {
        // quality < 30: 28 → 1 variant
        const conds = [{col: 'quality', op: '<', value: 30}]
        const res = await request(app)
            .get(`/api/variants?functional_filter=${ff(conds)}`)
            .expect(200)
        expect(res.body.total).to.equal(1)
        res.body.data.forEach(v => expect(Number(v.quality)).to.be.lessThan(30))
    })

    it('numeric "<=" – returns variants at or below threshold', async function () {
        // quality <= 30: 28, 30 → 2 variants
        const conds = [{col: 'quality', op: '<=', value: 30}]
        const res = await request(app)
            .get(`/api/variants?functional_filter=${ff(conds)}`)
            .expect(200)
        expect(res.body.total).to.equal(2)
        res.body.data.forEach(v => expect(Number(v.quality)).to.be.at.most(30))
    })

    it('categorical "eq" – matches exact single value', async function () {
        const conds = [{col: 'impact', op: 'eq', value: 'LOW'}]
        const res = await request(app)
            .get(`/api/variants?functional_filter=${ff(conds)}`)
            .expect(200)
        expect(res.body.total).to.equal(2)
        res.body.data.forEach(v => expect(v.impact).to.equal('LOW'))
    })

    it('categorical "neq" – excludes the specified value', async function () {
        // neq HIGH → MODERATE(3) + LOW(2) = 5
        const conds = [{col: 'impact', op: 'neq', value: 'HIGH'}]
        const res = await request(app)
            .get(`/api/variants?functional_filter=${ff(conds)}`)
            .expect(200)
        expect(res.body.total).to.equal(5)
        res.body.data.forEach(v => expect(v.impact).to.not.equal('HIGH'))
    })

    it('"contains" – substring match on categorical column', async function () {
        // inheritance contains "de" matches "de_novo" (8 variants)
        const conds = [{col: 'inheritance', op: 'contains', value: 'de'}]
        const res = await request(app)
            .get(`/api/variants?functional_filter=${ff(conds)}`)
            .expect(200)
        expect(res.body.total).to.equal(8)
    })

    it('multiple OR conditions – variant passes if ANY condition matches', async function () {
        // impact=HIGH (5) OR quality>40 (5); combined OR: 7 unique variants
        // HIGH variants with quality: 35,50,38,55,48  (all pass via impact)
        // MODERATE variants with quality>40: 42,45     (pass via quality)
        const conds = [
            {col: 'impact', op: 'in', values: ['HIGH']},
            {col: 'quality', op: '>', value: 40}
        ]
        const res = await request(app)
            .get(`/api/variants?functional_filter=${ff(conds)}`)
            .expect(200)
        expect(res.body.total).to.equal(7)
        res.body.data.forEach(v => {
            const byImpact = v.impact === 'HIGH'
            const byQuality = Number(v.quality) > 40
            expect(byImpact || byQuality).to.be.true
        })
    })

    it('three-way OR: HIGH or MODERATE or quality>=50', async function () {
        // HIGH(5) + MODERATE(3) + quality>=50 includes only already-covered variants → 8
        const conds = [
            {col: 'impact', op: 'eq', value: 'HIGH'},
            {col: 'impact', op: 'eq', value: 'MODERATE'},
            {col: 'quality', op: '>=', value: 50}
        ]
        const res = await request(app)
            .get(`/api/variants?functional_filter=${ff(conds)}`)
            .expect(200)
        expect(res.body.total).to.equal(8)
    })

    it('functional_filter AND regular filter are ANDed together', async function () {
        // functional: impact=HIGH OR quality>40 (7 variants)
        // AND regular: gene=GENE1 (2 variants: chr1:12345 HIGH, chr1:54321 MODERATE/quality=42>40)
        const conds = [
            {col: 'impact', op: 'in', values: ['HIGH']},
            {col: 'quality', op: '>', value: 40}
        ]
        const res = await request(app)
            .get(`/api/variants?functional_filter=${ff(conds)}&gene=GENE1`)
            .expect(200)
        expect(res.body.total).to.equal(2)
        res.body.data.forEach(v => expect(v.gene).to.equal('GENE1'))
    })

    it('empty conditions array returns all variants', async function () {
        const conds = []
        const res = await request(app)
            .get(`/api/variants?functional_filter=${ff(conds)}`)
            .expect(200)
        expect(res.body.total).to.equal(10)
    })

    it('invalid JSON in functional_filter is ignored gracefully', async function () {
        const res = await request(app)
            .get('/api/variants?functional_filter=not_valid_json')
            .expect(200)
        expect(res.body.total).to.equal(10)
    })

    it('unknown column in functional_filter returns zero matches', async function () {
        const conds = [{col: 'nonexistent_col', op: 'eq', value: 'anything'}]
        const res = await request(app)
            .get(`/api/variants?functional_filter=${ff(conds)}`)
            .expect(200)
        expect(res.body.total).to.equal(0)
    })

    it('unknown operator in functional_filter returns zero matches', async function () {
        const conds = [{col: 'impact', op: 'INVALID_OP', value: 'HIGH'}]
        const res = await request(app)
            .get(`/api/variants?functional_filter=${ff(conds)}`)
            .expect(200)
        expect(res.body.total).to.equal(0)
    })

    it('functional_filter is preserved in filter-config save/load round-trip', async function () {
        const filtersFile = path.join(__dirname, '..', 'example_data', 'variants.filters.json')
        const conds = [{col: 'impact', op: 'in', values: ['HIGH', 'MODERATE']}]
        const filterConfig = {functional_filter: JSON.stringify(conds)}

        await request(app).put('/api/filter-config').send(filterConfig).expect(200)
        const res = await request(app).get('/api/filter-config').expect(200)
        expect(res.body).to.have.property('functional_filter')
        const loaded = JSON.parse(res.body.functional_filter)
        expect(loaded).to.deep.equal(conds)

        if (fs.existsSync(filtersFile)) fs.unlinkSync(filtersFile)
    })
})

describe('API /api/variants curation_counts and all_notes', function () {
    after(function () {
        if (fs.existsSync(curationFile)) fs.unlinkSync(curationFile)
    })

    it('returns curation_counts with all variants at startup', async function () {
        const res = await request(app).get('/api/variants').expect(200)
        expect(res.body).to.have.property('curation_counts')
        const counts = res.body.curation_counts
        expect(counts).to.have.property('pass').that.is.a('number')
        expect(counts).to.have.property('fail').that.is.a('number')
        expect(counts).to.have.property('uncertain').that.is.a('number')
        expect(counts).to.have.property('pending').that.is.a('number')
        expect(counts.pass + counts.fail + counts.uncertain + counts.pending).to.equal(10)
    })

    it('returns all_notes as an array', async function () {
        const res = await request(app).get('/api/variants').expect(200)
        expect(res.body).to.have.property('all_notes').that.is.an('array')
    })

    it('curation_counts reflect curated variants across all pages', async function () {
        // Curate two variants
        await request(app).put('/api/variants/0/curate').send({status: 'pass', note: 'Good variant'}).expect(200)
        await request(app).put('/api/variants/5/curate').send({status: 'fail', note: 'Bad variant'}).expect(200)
        // Fetch only page 1 with 3 per page
        const res = await request(app).get('/api/variants?per_page=3&page=1').expect(200)
        const counts = res.body.curation_counts
        expect(counts.pass).to.be.at.least(1)
        expect(counts.fail).to.be.at.least(1)
        // Counts should span all 10 variants, not just the 3 on page 1
        expect(counts.pass + counts.fail + counts.uncertain + counts.pending).to.equal(10)
    })

    it('all_notes includes notes from curated variants across all pages', async function () {
        const res = await request(app).get('/api/variants?per_page=3&page=1').expect(200)
        expect(res.body.all_notes).to.include('Good variant')
        expect(res.body.all_notes).to.include('Bad variant')
    })

    it('all_notes are sorted alphabetically', async function () {
        const res = await request(app).get('/api/variants').expect(200)
        const notes = res.body.all_notes
        for (let i = 1; i < notes.length; i++) {
            expect(notes[i].localeCompare(notes[i - 1])).to.be.at.least(0)
        }
    })
})

describe('API /api/variants/:id', function () {
    it('returns a single variant by id', async function () {
        const res = await request(app).get('/api/variants/0').expect(200)
        expect(res.body).to.have.property('id', 0)
        expect(res.body).to.have.property('chrom')
        expect(res.body).to.have.property('pos')
    })

    it('returns 404 for unknown id', async function () {
        await request(app).get('/api/variants/9999').expect(404)
    })
})

describe('API /api/variants/:id/curate', function () {
    after(function () {
        // Clean up curation file
        if (fs.existsSync(curationFile)) fs.unlinkSync(curationFile)
    })

    it('updates curation status', async function () {
        const res = await request(app)
            .put('/api/variants/0/curate')
            .send({status: 'pass', note: 'Looks good'})
            .expect(200)
        expect(res.body.curation_status).to.equal('pass')
        expect(res.body.curation_note).to.equal('Looks good')
    })

    it('persists curation to disk', async function () {
        await request(app)
            .put('/api/variants/1/curate')
            .send({status: 'fail'})
            .expect(200)
        expect(fs.existsSync(curationFile)).to.be.true
        const data = JSON.parse(fs.readFileSync(curationFile, 'utf-8'))
        // Curation is now persisted using stable key (chrom:pos:ref:alt)
        expect(data).to.have.property('chr1:54321:C:T')
        expect(data['chr1:54321:C:T'].status).to.equal('fail')
    })

    it('rejects invalid curation status', async function () {
        await request(app)
            .put('/api/variants/0/curate')
            .send({status: 'invalid_status'})
            .expect(400)
    })

    it('returns 404 for unknown variant', async function () {
        await request(app)
            .put('/api/variants/9999/curate')
            .send({status: 'pass'})
            .expect(404)
    })
})

describe('API /api/curate/batch', function () {
    after(function () {
        if (fs.existsSync(curationFile)) fs.unlinkSync(curationFile)
    })

    it('curates multiple variants at once', async function () {
        const res = await request(app)
            .put('/api/curate/batch')
            .send({ids: [2, 3], status: 'uncertain'})
            .expect(200)
        expect(res.body.updated).to.equal(2)
        expect(res.body.data).to.have.lengthOf(2)
        res.body.data.forEach(v => expect(v.curation_status).to.equal('uncertain'))
    })

    it('rejects non-array ids', async function () {
        await request(app)
            .put('/api/curate/batch')
            .send({ids: 'not-array', status: 'pass'})
            .expect(400)
    })

    it('rejects invalid status', async function () {
        await request(app)
            .put('/api/curate/batch')
            .send({ids: [0], status: 'bad'})
            .expect(400)
    })
})

describe('API /api/curate/gene', function () {
    after(function () {
        if (fs.existsSync(curationFile)) fs.unlinkSync(curationFile)
    })

    it('curates all variants in a gene', async function () {
        const res = await request(app)
            .put('/api/curate/gene')
            .send({gene: 'GENE2', status: 'fail'})
            .expect(200)
        expect(res.body).to.have.property('updated', 2)
        expect(res.body).to.have.property('gene', 'GENE2')
        expect(res.body.data).to.have.lengthOf(2)
        res.body.data.forEach(v => {
            expect(v.gene).to.equal('GENE2')
            expect(v.curation_status).to.equal('fail')
        })
    })

    it('requires gene parameter', async function () {
        await request(app)
            .put('/api/curate/gene')
            .send({status: 'pass'})
            .expect(400)
    })

    it('rejects invalid status', async function () {
        await request(app)
            .put('/api/curate/gene')
            .send({gene: 'GENE1', status: 'bad'})
            .expect(400)
    })

    it('returns 404 for unknown gene', async function () {
        await request(app)
            .put('/api/curate/gene')
            .send({gene: 'NONEXISTENT', status: 'fail'})
            .expect(404)
    })

    it('supports curation note for gene', async function () {
        const res = await request(app)
            .put('/api/curate/gene')
            .send({gene: 'GENE1', status: 'fail', note: 'Hypervariable gene'})
            .expect(200)
        expect(res.body.updated).to.equal(2)
        res.body.data.forEach(v => {
            expect(v.curation_note).to.equal('Hypervariable gene')
        })
    })
})

describe('API /api/curate/sample', function () {
    after(function () {
        if (fs.existsSync(curationFile)) fs.unlinkSync(curationFile)
    })

    it('curates all variants for a sample', async function () {
        const res = await request(app)
            .put('/api/curate/sample')
            .send({sample: 'all', status: 'fail'})
            .expect(200)
        expect(res.body).to.have.property('updated').that.is.a('number')
        expect(res.body).to.have.property('sample', 'all')
        expect(res.body.updated).to.be.greaterThan(0)
        res.body.data.forEach(v => {
            expect(v.curation_status).to.equal('fail')
        })
    })

    it('requires sample parameter', async function () {
        await request(app)
            .put('/api/curate/sample')
            .send({status: 'pass'})
            .expect(400)
    })

    it('rejects invalid status', async function () {
        await request(app)
            .put('/api/curate/sample')
            .send({sample: 'all', status: 'bad'})
            .expect(400)
    })

    it('returns 404 for unknown sample', async function () {
        await request(app)
            .put('/api/curate/sample')
            .send({sample: 'NONEXISTENT_SAMPLE', status: 'fail'})
            .expect(404)
    })

    it('supports curation note for sample', async function () {
        const res = await request(app)
            .put('/api/curate/sample')
            .send({sample: 'all', status: 'fail', note: 'Low quality sample'})
            .expect(200)
        expect(res.body.updated).to.be.greaterThan(0)
        res.body.data.forEach(v => {
            expect(v.curation_note).to.equal('Low quality sample')
        })
    })
})

describe('API /api/filters', function () {
    it('returns filter options for columns', async function () {
        const res = await request(app).get('/api/filters').expect(200)
        expect(res.body).to.have.property('categorical').that.is.an('object')
        expect(res.body).to.have.property('numeric').that.is.an('array')
        expect(res.body.categorical).to.have.property('curation_status')
        expect(res.body.categorical.curation_status).to.include('pass')
        expect(res.body.categorical.curation_status).to.include('fail')
        expect(res.body.categorical).to.have.property('gene')
        expect(res.body.categorical).to.have.property('impact')
    })

    it('classifies numeric columns separately', async function () {
        const res = await request(app).get('/api/filters').expect(200)
        expect(res.body.numeric).to.include('frequency')
        expect(res.body.numeric).to.include('quality')
        // Numeric columns should not appear in categorical
        expect(res.body.categorical).to.not.have.property('frequency')
        expect(res.body.categorical).to.not.have.property('quality')
    })
})

describe('API /api/summary', function () {
    it('returns gene-level summary', async function () {
        const res = await request(app).get('/api/summary').expect(200)
        expect(res.body).to.have.property('total_genes').that.is.a('number')
        expect(res.body).to.have.property('total_variants').that.is.a('number')
        expect(res.body).to.have.property('summary').that.is.an('array')
        expect(res.body.total_genes).to.be.greaterThan(0)
    })

    it('returns summary with curation counts per gene', async function () {
        const res = await request(app).get('/api/summary').expect(200)
        const gene = res.body.summary[0]
        expect(gene).to.have.property('gene')
        expect(gene).to.have.property('total')
        expect(gene).to.have.property('pass')
        expect(gene).to.have.property('fail')
        expect(gene).to.have.property('uncertain')
        expect(gene).to.have.property('pending')
        expect(gene).to.have.property('variants').that.is.an('array')
    })

    it('respects filters in summary', async function () {
        const res = await request(app).get('/api/summary?impact=HIGH').expect(200)
        expect(res.body.total_variants).to.equal(5)
    })
})

describe('API /api/sample-summary', function () {
    it('returns sample-level summary', async function () {
        const res = await request(app).get('/api/sample-summary').expect(200)
        expect(res.body).to.have.property('total_samples').that.is.a('number')
        expect(res.body).to.have.property('total_variants').that.is.a('number')
        expect(res.body).to.have.property('thresholds').that.is.an('array')
        expect(res.body).to.have.property('impact_groups').that.is.an('array')
        expect(res.body).to.have.property('samples').that.is.an('array')
        expect(res.body).to.have.property('cohort_summary').that.is.an('object')
        expect(res.body.total_samples).to.be.greaterThan(0)
    })

    it('returns correct impact groups', async function () {
        const res = await request(app).get('/api/sample-summary').expect(200)
        expect(res.body.impact_groups).to.deep.equal(['HIGH', 'HIGH||MODERATE', 'HIGH||MODERATE||LOW'])
    })

    it('returns correct frequency thresholds', async function () {
        const res = await request(app).get('/api/sample-summary').expect(200)
        expect(res.body.thresholds).to.deep.equal(['freq = 0', 'all'])
    })

    it('returns per-sample counts by impact and frequency', async function () {
        const res = await request(app).get('/api/sample-summary').expect(200)
        const sample = res.body.samples[0]
        expect(sample).to.have.property('sample_id')
        expect(sample).to.have.property('total')
        expect(sample).to.have.property('counts').that.is.an('object')
        expect(sample.counts).to.have.property('HIGH')
        expect(sample.counts).to.have.property('HIGH||MODERATE')
        expect(sample.counts).to.have.property('HIGH||MODERATE||LOW')
        // Each impact group should have counts for each threshold
        expect(sample.counts['HIGH']).to.have.property('freq = 0')
        expect(sample.counts['HIGH']).to.have.property('all')
    })

    it('returns cohort summary with mean and median', async function () {
        const res = await request(app).get('/api/sample-summary').expect(200)
        const cs = res.body.cohort_summary
        expect(cs).to.have.property('HIGH')
        expect(cs['HIGH']).to.have.property('freq = 0')
        expect(cs['HIGH']['freq = 0']).to.have.property('mean').that.is.a('number')
        expect(cs['HIGH']['freq = 0']).to.have.property('median').that.is.a('number')
        expect(cs['HIGH']).to.have.property('all')
        expect(cs['HIGH']['all']).to.have.property('mean').that.is.a('number')
        expect(cs['HIGH']['all']).to.have.property('median').that.is.a('number')
    })

    it('respects filters in sample summary', async function () {
        const res = await request(app).get('/api/sample-summary?impact=HIGH').expect(200)
        expect(res.body.total_variants).to.equal(5)
    })

    it('returns per-sample total_unfiltered count', async function () {
        const res = await request(app).get('/api/sample-summary').expect(200)
        const sample = res.body.samples[0]
        expect(sample).to.have.property('total_unfiltered').that.is.a('number')
        expect(sample.total_unfiltered).to.be.at.least(sample.total)
    })

    it('returns per-sample curation_counts breakdown', async function () {
        const res = await request(app).get('/api/sample-summary').expect(200)
        const sample = res.body.samples[0]
        expect(sample).to.have.property('curation_counts').that.is.an('object')
        expect(sample.curation_counts).to.have.property('pass').that.is.a('number')
        expect(sample.curation_counts).to.have.property('fail').that.is.a('number')
        expect(sample.curation_counts).to.have.property('uncertain').that.is.a('number')
        expect(sample.curation_counts).to.have.property('pending').that.is.a('number')
        // Sum of curation counts should equal total
        const cc = sample.curation_counts
        expect(cc.pass + cc.fail + cc.uncertain + cc.pending).to.equal(sample.total)
    })

    it('curation_counts reflect actual curation status', async function () {
        // All variants should start as pending (before any curation test)
        const res = await request(app).get('/api/sample-summary').expect(200)
        const sample = res.body.samples[0]
        const cc = sample.curation_counts
        // Sum of statuses must equal total regardless of previous test state
        expect(cc.pass + cc.fail + cc.uncertain + cc.pending).to.equal(sample.total)
    })
})

describe('API /api/export', function () {
    it('returns TSV with header and data rows', async function () {
        const res = await request(app)
            .get('/api/export')
            .expect(200)
            .expect('Content-Type', /tab-separated/)
        const lines = res.text.trim().split('\n')
        expect(lines.length).to.equal(11) // header + 10 data rows
        expect(lines[0]).to.include('chrom')
        expect(lines[0]).to.include('curation_status')
    })

    it('exports filtered subset', async function () {
        const res = await request(app)
            .get('/api/export?impact=HIGH')
            .expect(200)
        const lines = res.text.trim().split('\n')
        expect(lines.length).to.equal(6) // header + 5 HIGH-impact variants
    })
})

describe('API /api/export/xlsx', function () {
    it('returns XLSX with variant data', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({variantIds: [0, 1, 2]})
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)
            .expect('Content-Type', /spreadsheetml/)
        expect(Buffer.isBuffer(res.body)).to.be.true
        expect(res.body.length).to.be.greaterThan(0)
    })

    it('exports all variants when no ids specified', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({})
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)
            .expect('Content-Type', /spreadsheetml/)
        expect(res.body.length).to.be.greaterThan(0)
    })

    it('includes screenshot tabs when screenshots provided', async function () {
        this.timeout(10000)
        // Minimal 1x1 red PNG as base64
        const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({
                variantIds: [0],
                screenshots: {'0': tinyPng}
            })
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)
            .expect('Content-Type', /spreadsheetml/)
        expect(res.body.length).to.be.greaterThan(0)
    })

    it('returns 400 when no variants match', async function () {
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({variantIds: [9999]})
            .expect(400)
        expect(res.body).to.have.property('error')
    })

    it('produces a valid workbook with correct structure', async function () {
        this.timeout(10000)
        const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({
                variantIds: [0, 1],
                screenshots: {'0': tinyPng}
            })
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        // Parse the XLSX back
        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        // Should have at least 2 sheets: Variants + 1 screenshot
        expect(workbook.worksheets.length).to.be.at.least(2)
        const variantsSheet = workbook.getWorksheet('Variants')
        expect(variantsSheet).to.exist

        // Header row should include Screenshot, chrom, pos, ref, alt
        const headerRow = variantsSheet.getRow(1)
        const headerValues = []
        headerRow.eachCell(cell => headerValues.push(cell.value))
        expect(headerValues).to.include('Chrom')
        expect(headerValues).to.include('Pos')
        expect(headerValues).to.include('Ref')
        expect(headerValues).to.include('Alt')
        expect(headerValues).to.include('Screenshot')

        // Should have 2 data rows (variants 0 and 1)
        expect(variantsSheet.rowCount).to.equal(3) // header + 2 data rows

        // Screenshot sheet should use short numeric index name
        const screenshotSheet = workbook.getWorksheet('1')
        expect(screenshotSheet).to.exist
        // Should have back-link text
        expect(screenshotSheet.getCell('D1').value).to.have.property('text', '← Back to Variants')

        // Main table should have a hyperlink from the Screenshot column to the screenshot tab
        const dataRow = variantsSheet.getRow(2)
        const linkCell = dataRow.getCell(1)
        expect(linkCell.value).to.have.property('text', '📷 View')
        expect(linkCell.value).to.have.property('hyperlink', "#'1'!A1")
    })

    it('includes Gene Summary and Sample Summary sheets', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({variantIds: [0, 1, 2, 3, 4]})
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        // Should have Gene Summary sheet
        const geneSummary = workbook.getWorksheet('Gene Summary')
        expect(geneSummary).to.exist
        const gsHeader = []
        geneSummary.getRow(1).eachCell(cell => gsHeader.push(cell.value))
        expect(gsHeader).to.include('Gene')
        expect(gsHeader).to.include('Total')
        expect(gsHeader).to.include('Pass')
        expect(gsHeader).to.include('Fail')
        // Should have data rows for genes
        expect(geneSummary.rowCount).to.be.at.least(2)

        // Should have Sample Summary sheet
        const sampleSummary = workbook.getWorksheet('Sample Summary')
        expect(sampleSummary).to.exist
        const ssHeader = []
        sampleSummary.getRow(1).eachCell(cell => ssHeader.push(cell.value))
        expect(ssHeader).to.include('Sample')
        expect(ssHeader).to.include('Passing Filters')
        expect(ssHeader).to.include('Unfiltered')
        expect(ssHeader).to.include('Curated')
        expect(ssHeader).to.include('Pass')
        expect(ssHeader).to.include('Fail')
        // Should have at least one data row
        expect(sampleSummary.rowCount).to.be.at.least(2)
    })
})

describe('XLSX Applied Filters sheet', function () {
    it('includes Applied Filters sheet when filters provided', async function () {
        this.timeout(10000)
        const sentFilters = {impact: 'HIGH', frequency_max: '0.001'}
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({
                variantIds: [0, 1, 2],
                filters: sentFilters
            })
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        const filtersSheet = workbook.getWorksheet('Applied Filters')
        expect(filtersSheet).to.exist
        const fHeader = []
        filtersSheet.getRow(1).eachCell(cell => fHeader.push(cell.value))
        expect(fHeader).to.include('Filter')
        expect(fHeader).to.include('Value')
        // Sheet now always includes a 'Variant Filters' heading + filter rows + 'Export Settings' heading + settings rows
        expect(filtersSheet.rowCount).to.be.at.least(Object.keys(sentFilters).length + 1)
        // Check filter values appear somewhere in the sheet
        const filterValues = []
        for (let r = 2; r <= filtersSheet.rowCount; r++) {
            filterValues.push(filtersSheet.getRow(r).getCell(1).value)
        }
        expect(filterValues).to.include('Impact')
        expect(filterValues).to.include('Frequency Max')
        // Export Settings section should also be present
        expect(filterValues).to.include('Export Settings')
        expect(filterValues).to.include('Genome Build')
    })

    it('always creates Applied Filters sheet (includes Export Settings even without filters)', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({variantIds: [0, 1]})
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)
        const filtersSheet = workbook.getWorksheet('Applied Filters')
        expect(filtersSheet).to.exist
        // Should contain Export Settings even with no user filters
        const filterValues = []
        for (let r = 2; r <= filtersSheet.rowCount; r++) {
            filterValues.push(filtersSheet.getRow(r).getCell(1).value)
        }
        expect(filterValues).to.include('Export Settings')
        expect(filterValues).to.include('Genome Build')
    })

    it('renders functional_filter as human-readable condition rows in XLSX', async function () {
        this.timeout(10000)
        const conditions = [
            {col: 'impact', op: 'in', values: ['HIGH', 'MODERATE']},
            {col: 'quality', op: '>', value: 40}
        ]
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({
                variantIds: [0, 1, 2, 3, 4],
                filters: {functional_filter: JSON.stringify(conditions)}
            })
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)
        const filtersSheet = workbook.getWorksheet('Applied Filters')
        expect(filtersSheet).to.exist
        const rowValues = []
        for (let r = 1; r <= filtersSheet.rowCount; r++) {
            const row = filtersSheet.getRow(r)
            rowValues.push({filter: row.getCell(1).value, value: row.getCell(2).value})
        }
        // Should have a "Functional Filter (OR)" label row
        const ffRow = rowValues.find(r => String(r.filter || '').includes('Functional Filter'))
        expect(ffRow).to.exist
        // Should have per-condition rows with human-readable descriptions
        const condRow1 = rowValues.find(r => String(r.value || '').includes('impact in [HIGH, MODERATE]'))
        expect(condRow1).to.exist
        const condRow2 = rowValues.find(r => String(r.value || '').includes('quality > 40'))
        expect(condRow2).to.exist
    })

    it('includes sort and search in Applied Filters sheet', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({
                variantIds: [0, 1, 2],
                filters: {sort: 'quality', order: 'desc', search: 'GENE1'}
            })
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)
        const filtersSheet = workbook.getWorksheet('Applied Filters')
        expect(filtersSheet).to.exist
        const filterValues = []
        const filterCellValues = {}
        for (let r = 2; r <= filtersSheet.rowCount; r++) {
            const row = filtersSheet.getRow(r)
            const label = String(row.getCell(1).value || '')
            const val = String(row.getCell(2).value || '')
            filterValues.push(label)
            filterCellValues[label] = val
        }
        // Sort row should appear (with order combined)
        expect(filterValues).to.include('Sort')
        expect(filterCellValues['Sort']).to.include('quality')
        expect(filterCellValues['Sort']).to.include('desc')
        // Search row should appear
        expect(filterValues).to.include('Search')
        expect(filterCellValues['Search']).to.equal('GENE1')
    })

    it('includes variantColumns in Applied Filters / Export Settings', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({
                variantIds: [0],
                exportConfig: {variantColumns: {coreVariant: true, geneInfo: true, frequency: false}}
            })
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)
        const filtersSheet = workbook.getWorksheet('Applied Filters')
        expect(filtersSheet).to.exist
        const filterValues = []
        const filterCellValues = {}
        for (let r = 2; r <= filtersSheet.rowCount; r++) {
            const row = filtersSheet.getRow(r)
            const label = String(row.getCell(1).value || '')
            const val = String(row.getCell(2).value || '')
            filterValues.push(label)
            filterCellValues[label] = val
        }
        // Excluded columns should be listed
        expect(filterValues).to.include('Variant Columns Excluded')
        expect(filterCellValues['Variant Columns Excluded']).to.include('frequency')
    })
})

describe('XLSX full row coloring by curation status', function () {
    after(function () {
        if (fs.existsSync(curationFile)) fs.unlinkSync(curationFile)
    })

    it('colors entire row green for pass status', async function () {
        this.timeout(10000)
        // First curate variant 0 as pass
        await request(app)
            .put('/api/variants/0/curate')
            .send({status: 'pass'})
            .expect(200)

        const res = await request(app)
            .post('/api/export/xlsx')
            .send({variantIds: [0]})
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        const ws = workbook.getWorksheet('Variants')
        const dataRow = ws.getRow(2) // first data row
        // Check that a non-status cell has green fill (pass = FFD5F5E3)
        const firstCell = dataRow.getCell(1)
        expect(firstCell.fill).to.exist
        expect(firstCell.fill.fgColor).to.exist
        expect(firstCell.fill.fgColor.argb).to.equal('FFD5F5E3')
    })

    it('colors entire row red for fail status', async function () {
        this.timeout(10000)
        await request(app)
            .put('/api/variants/1/curate')
            .send({status: 'fail'})
            .expect(200)

        const res = await request(app)
            .post('/api/export/xlsx')
            .send({variantIds: [1]})
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        const ws = workbook.getWorksheet('Variants')
        const dataRow = ws.getRow(2)
        const firstCell = dataRow.getCell(1)
        expect(firstCell.fill).to.exist
        expect(firstCell.fill.fgColor).to.exist
        expect(firstCell.fill.fgColor.argb).to.equal('FFFADBD8')
    })

    it('colors entire row orange for uncertain status', async function () {
        this.timeout(10000)
        await request(app)
            .put('/api/variants/2/curate')
            .send({status: 'uncertain'})
            .expect(200)

        const res = await request(app)
            .post('/api/export/xlsx')
            .send({variantIds: [2]})
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        const ws = workbook.getWorksheet('Variants')
        const dataRow = ws.getRow(2)
        const firstCell = dataRow.getCell(1)
        expect(firstCell.fill).to.exist
        expect(firstCell.fill.fgColor).to.exist
        expect(firstCell.fill.fgColor.argb).to.equal('FFFDEBD0')
    })
})

describe('XLSX Sample Summary cohort statistics', function () {
    it('includes Mean, Median, and Std Dev rows in Sample Summary', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({variantIds: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]})
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        const sampleSummary = workbook.getWorksheet('Sample Summary')
        expect(sampleSummary).to.exist

        // Collect all values from the Sample column
        const sampleLabels = []
        sampleSummary.eachRow((row, rowNumber) => {
            if (rowNumber > 1) {
                const val = row.getCell(1).value
                if (val) sampleLabels.push(val)
            }
        })
        expect(sampleLabels).to.include('Mean')
        expect(sampleLabels).to.include('Median')
        expect(sampleLabels).to.include('Std Dev')
    })

    it('cohort stats rows have numeric values', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({variantIds: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]})
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        const sampleSummary = workbook.getWorksheet('Sample Summary')
        // Find the Mean row (should be after sample data + blank row)
        let meanRowNum = null
        sampleSummary.eachRow((row, rowNumber) => {
            if (row.getCell(1).value === 'Mean') meanRowNum = rowNumber
        })
        expect(meanRowNum).to.be.a('number')
        // Unfiltered column (col 2) should be a number
        const unfilteredMean = sampleSummary.getRow(meanRowNum).getCell(2).value
        expect(unfilteredMean).to.be.a('number')
    })
})

describe('XLSX screenshot image embedding', function () {
    it('embeds a valid PNG image in the screenshot worksheet', async function () {
        this.timeout(10000)
        const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({
                variantIds: [0],
                screenshots: {'0': tinyPng}
            })
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        // Find the screenshot worksheet by numeric index name
        const screenshotSheet = workbook.getWorksheet('1')
        expect(screenshotSheet).to.exist

        // Verify that the sheet has an embedded image
        const images = screenshotSheet.getImages()
        expect(images).to.be.an('array').with.length.greaterThan(0)

        // Verify image placement (should start after info rows, col 0)
        const img = images[0]
        expect(img.range.tl.row).to.be.at.least(5)
        expect(img.range.tl.col).to.equal(0)

        // Verify the workbook has media with valid PNG data
        expect(workbook.model.media).to.be.an('array').with.length.greaterThan(0)
        const media = workbook.model.media[0]
        expect(media.type).to.equal('image')
        expect(media.extension).to.equal('png')
        expect(media.buffer).to.be.an.instanceOf(Buffer)
        // Check PNG magic bytes
        const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47])
        expect(media.buffer.slice(0, 4).equals(pngHeader)).to.be.true
    })

    it('places screenshot tabs after all data tabs', async function () {
        this.timeout(10000)
        const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({
                variantIds: [0, 1, 2],
                screenshots: {'0': tinyPng, '1': tinyPng}
            })
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        // Collect sheet names in order
        const sheetNames = workbook.worksheets.map(ws => ws.name)

        // Data tabs should appear before screenshot tabs
        const variantsIdx = sheetNames.indexOf('Variants')
        const geneSummaryIdx = sheetNames.indexOf('Gene Summary')
        const sampleSummaryIdx = sheetNames.indexOf('Sample Summary')
        const screenshot1Idx = sheetNames.indexOf('1')
        const screenshot2Idx = sheetNames.indexOf('2')

        expect(variantsIdx).to.be.at.least(0)
        expect(geneSummaryIdx).to.be.at.least(0)
        expect(sampleSummaryIdx).to.be.at.least(0)
        expect(screenshot1Idx).to.be.at.least(0)
        expect(screenshot2Idx).to.be.at.least(0)

        // Screenshot tabs should come after all data tabs
        expect(screenshot1Idx).to.be.greaterThan(variantsIdx)
        expect(screenshot1Idx).to.be.greaterThan(geneSummaryIdx)
        expect(screenshot1Idx).to.be.greaterThan(sampleSummaryIdx)
        expect(screenshot2Idx).to.be.greaterThan(sampleSummaryIdx)
    })

    it('includes additional variant summary info in screenshot tabs', async function () {
        this.timeout(10000)
        const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({
                variantIds: [0],
                screenshots: {'0': tinyPng}
            })
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        const screenshotSheet = workbook.getWorksheet('1')
        expect(screenshotSheet).to.exist

        // Collect all label values from column A
        const labels = []
        screenshotSheet.eachRow(row => {
            const val = row.getCell(1).value
            if (val) labels.push(val)
        })

        // Should include additional context fields
        expect(labels).to.include('Variant:')
        expect(labels).to.include('Gene:')
        expect(labels).to.include('Impact:')
        expect(labels).to.include('Inheritance:')
        expect(labels).to.include('Frequency:')
        expect(labels).to.include('Quality:')
        expect(labels).to.include('Status:')
    })

    it('includes trio AD, GQ, and child DKA/DKT in screenshot tabs', async function () {
        this.timeout(10000)
        const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({
                variantIds: [0],
                screenshots: {'0': tinyPng}
            })
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        const screenshotSheet = workbook.getWorksheet('1')
        expect(screenshotSheet).to.exist

        // Collect all label/value pairs from the screenshot tab
        const labels = []
        const values = []
        screenshotSheet.eachRow(row => {
            const label = row.getCell(1).value
            const val = row.getCell(2).value
            if (label) labels.push(label)
            if (val != null) values.push(String(val))
        })

        // Trio AD should appear
        expect(labels).to.include('AD:')
        // Trio GQ should appear
        expect(labels).to.include('GQ:')
        // DKA/DKT should appear
        expect(labels).to.include('DKA/DKT:')
    })
})

describe('API /api/export/html', function () {
    const binaryParse = (res, callback) => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => callback(null, Buffer.concat(chunks)))
    }

    it('returns a ZIP file with HTML report', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/html')
            .send({variantIds: [0, 1]})
            .buffer(true)
            .parse(binaryParse)
            .expect(200)
            .expect('Content-Type', /zip/)
        expect(res.body.length).to.be.greaterThan(0)
        // ZIP magic bytes
        expect(res.body[0]).to.equal(0x50) // P
        expect(res.body[1]).to.equal(0x4B) // K
    })

    it('returns 400 when no variants match', async function () {
        const res = await request(app)
            .post('/api/export/html')
            .send({variantIds: [9999]})
            .expect(400)
        expect(res.body).to.have.property('error')
    })

    it('contains an index.html with interactive table', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/html')
            .send({variantIds: [0, 1, 2]})
            .buffer(true)
            .parse(binaryParse)
            .expect(200)

        // Parse the ZIP
        const JSZip = require('jszip')
        const zip = await JSZip.loadAsync(res.body)

        const htmlFile = zip.file('variants_report/index.html')
        expect(htmlFile).to.exist
        const html = await htmlFile.async('string')

        // Verify interactive features
        expect(html).to.include('variantTable')
        expect(html).to.include('searchBox')
        expect(html).to.include('statusFilter')
        expect(html).to.include('pagination')
        expect(html).to.include('Variant Review Report')
    })

    it('includes screenshots in ZIP when provided', async function () {
        this.timeout(10000)
        const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
        const res = await request(app)
            .post('/api/export/html')
            .send({
                variantIds: [0, 1],
                screenshots: {'0': tinyPng}
            })
            .buffer(true)
            .parse(binaryParse)
            .expect(200)

        const JSZip = require('jszip')
        const zip = await JSZip.loadAsync(res.body)

        // Should have a screenshots directory with a PNG
        const screenshotFiles = Object.keys(zip.files).filter(f =>
            f.startsWith('variants_report/screenshots/') && f.endsWith('.png')
        )
        expect(screenshotFiles).to.have.length(1)

        // Verify the PNG is valid
        const pngData = await zip.file(screenshotFiles[0]).async('nodebuffer')
        const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47])
        expect(pngData.slice(0, 4).equals(pngHeader)).to.be.true

        // HTML should reference the screenshot
        const html = await zip.file('variants_report/index.html').async('string')
        expect(html).to.include('screenshot_0_chr1_12345.png')
        expect(html).to.include('screenshotModal')
        expect(html).to.include('gallery')
    })

    it('includes gene summary tab when gene column exists', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/html')
            .send({variantIds: [0, 1, 2]})
            .buffer(true)
            .parse(binaryParse)
            .expect(200)

        const JSZip = require('jszip')
        const zip = await JSZip.loadAsync(res.body)
        const html = await zip.file('variants_report/index.html').async('string')
        expect(html).to.include('Gene Summary')
        expect(html).to.include('geneGrid')
    })

    it('includes applied filters in HTML', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/html')
            .send({
                variantIds: [0, 1],
                filters: {impact: 'HIGH', frequency_max: '0.001'}
            })
            .buffer(true)
            .parse(binaryParse)
            .expect(200)

        const JSZip = require('jszip')
        const zip = await JSZip.loadAsync(res.body)
        const html = await zip.file('variants_report/index.html').async('string')
        expect(html).to.include('Applied Filters')
        expect(html).to.include('Impact')
    })

    it('includes curation stats in HTML', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/html')
            .send({})
            .buffer(true)
            .parse(binaryParse)
            .expect(200)

        const JSZip = require('jszip')
        const zip = await JSZip.loadAsync(res.body)
        const html = await zip.file('variants_report/index.html').async('string')
        // Should have stat cards
        expect(html).to.include('stat-card')
        expect(html).to.include('Pass')
        expect(html).to.include('Fail')
        expect(html).to.include('Pending')
    })
})

describe('API /api/sample-summary includes sd in cohort_summary', function () {
    it('cohort_summary cells have sd field', async function () {
        const res = await request(app).get('/api/sample-summary').expect(200)
        const cs = res.body.cohort_summary
        const firstGroup = Object.keys(cs)[0]
        const firstThreshold = Object.keys(cs[firstGroup])[0]
        expect(cs[firstGroup][firstThreshold]).to.have.property('sd')
        expect(cs[firstGroup][firstThreshold].sd).to.be.a('number')
    })
})

describe('Stable curation keys', function () {
    after(function () {
        if (fs.existsSync(curationFile)) fs.unlinkSync(curationFile)
    })

    it('saves curation with stable chrom:pos:ref:alt key', async function () {
        await request(app)
            .put('/api/variants/0/curate')
            .send({status: 'pass'})
            .expect(200)
        const data = JSON.parse(fs.readFileSync(curationFile, 'utf-8'))
        // Variant 0: chr1:12345:A:G
        expect(data).to.have.property('chr1:12345:A:G')
        expect(data['chr1:12345:A:G'].status).to.equal('pass')
        // Should NOT have numeric key
        expect(data).to.not.have.property('0')
    })

    it('includes curation note in stable key entry', async function () {
        await request(app)
            .put('/api/variants/0/curate')
            .send({note: 'Test note'})
            .expect(200)
        const data = JSON.parse(fs.readFileSync(curationFile, 'utf-8'))
        expect(data['chr1:12345:A:G'].note).to.equal('Test note')
    })
})

describe('Static files', function () {
    it('serves the UI index.html', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('IGV')
    })

    it('includes HTML export button', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('btn-export-html')
        expect(res.text).to.include('Export HTML')
    })

    it('serves app.js with exportHtml function', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('exportHtml')
        expect(res.text).to.include('/api/export/html')
    })

    it('serves app.js', async function () {
        await request(app).get('/app.js').expect(200)
    })

    it('serves styles.css', async function () {
        await request(app).get('/styles.css').expect(200)
    })
})

describe('UI: Curation row coloring', function () {
    it('index.html includes track-load-status container', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('id="track-load-status"')
    })

    it('styles.css contains curation row color classes', async function () {
        const res = await request(app).get('/styles.css').expect(200)
        expect(res.text).to.include('tr.curation-pass')
        expect(res.text).to.include('tr.curation-fail')
        expect(res.text).to.include('tr.curation-uncertain')
        expect(res.text).to.include('tr.curation-pending')
    })

    it('app.js applies curation class to table rows', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('curationClass')
        expect(res.text).to.include('curation-${v.curation_status')
    })
})

describe('UI: Keyboard shortcuts', function () {
    it('index.html contains keyboard shortcuts panel', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('id="shortcuts-panel"')
        expect(res.text).to.include('id="shortcuts-toggle"')
        expect(res.text).to.include('Keyboard Shortcuts')
    })

    it('shortcuts panel documents all shortcut keys', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('Next uncurated variant')
        expect(res.text).to.include('Prev uncurated variant')
        expect(res.text).to.include('Mark as Pass')
        expect(res.text).to.include('Mark as Fail')
        expect(res.text).to.include('Mark as Uncertain')
        expect(res.text).to.include('Pass &amp; advance')
    })

    it('app.js registers keyboard event handlers', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('setupKeyboardShortcuts')
        expect(res.text).to.include('selectNextVariant')
        expect(res.text).to.include('selectPrevVariant')
        expect(res.text).to.include('curateAndAdvance')
    })
})

describe('UI: Track load validation', function () {
    it('app.js includes validateTrackLoading function', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('validateTrackLoading')
        expect(res.text).to.include('track-load-status')
    })

    it('styles.css includes track status indicator styles', async function () {
        const res = await request(app).get('/styles.css').expect(200)
        expect(res.text).to.include('.track-status')
        expect(res.text).to.include('.track-status-ok')
        expect(res.text).to.include('.track-status-error')
        expect(res.text).to.include('.track-status-empty')
    })
})

describe('API /api/filter-config', function () {
    const filtersFile = path.join(__dirname, '..', 'example_data', 'variants.filters.json')

    after(function () {
        if (fs.existsSync(filtersFile)) fs.unlinkSync(filtersFile)
    })

    it('returns empty object when no saved filters exist', async function () {
        if (fs.existsSync(filtersFile)) fs.unlinkSync(filtersFile)
        const res = await request(app).get('/api/filter-config').expect(200)
        expect(res.body).to.deep.equal({})
    })

    it('saves filter configuration', async function () {
        const filters = {impact: 'HIGH', quality_min: '30'}
        const res = await request(app)
            .put('/api/filter-config')
            .send(filters)
            .expect(200)
        expect(res.body).to.have.property('ok', true)
        expect(fs.existsSync(filtersFile)).to.be.true
        const saved = JSON.parse(fs.readFileSync(filtersFile, 'utf-8'))
        expect(saved).to.deep.equal(filters)
    })

    it('loads previously saved filter configuration', async function () {
        const filters = {gene: 'GENE1', frequency_max: '0.01'}
        fs.writeFileSync(filtersFile, JSON.stringify(filters), 'utf-8')
        const res = await request(app).get('/api/filter-config').expect(200)
        expect(res.body).to.deep.equal(filters)
    })

    it('overwrites previously saved filters', async function () {
        const filters1 = {impact: 'HIGH'}
        const filters2 = {gene: 'GENE2', quality_min: '50'}
        await request(app).put('/api/filter-config').send(filters1).expect(200)
        await request(app).put('/api/filter-config').send(filters2).expect(200)
        const res = await request(app).get('/api/filter-config').expect(200)
        expect(res.body).to.deep.equal(filters2)
    })
})

describe('UI: Resizable table', function () {
    it('index.html includes resize handle', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('id="table-resize-handle"')
    })

    it('styles.css includes resize handle styles', async function () {
        const res = await request(app).get('/styles.css').expect(200)
        expect(res.text).to.include('#table-resize-handle')
        expect(res.text).to.include('ns-resize')
    })

    it('app.js includes setupTableResize function', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('setupTableResize')
        expect(res.text).to.include('variantTableHeight')
    })
})

describe('UI: Uncurated variant navigation', function () {
    it('app.js navigates to uncurated variants', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('curation_status')
        expect(res.text).to.include("=== 'pending'")
    })

    it('index.html documents uncurated navigation in shortcuts', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('Next uncurated variant')
        expect(res.text).to.include('Prev uncurated variant')
    })
})

describe('UI: Filter persistence buttons', function () {
    it('index.html includes save and load filter buttons', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('id="btn-save-filters"')
        expect(res.text).to.include('id="btn-load-filters"')
    })

    it('app.js includes filter persistence functions', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('saveFilterConfig')
        expect(res.text).to.include('loadSavedFilters')
        expect(res.text).to.include('applyFiltersToUI')
    })
})

describe('UI: Sample Summary tab', function () {
    it('index.html includes sample summary tab', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('data-tab="sample-summary"')
        expect(res.text).to.include('id="tab-sample-summary"')
        expect(res.text).to.include('id="sample-summary-body"')
    })

    it('index.html includes cohort summary elements', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('id="cohort-summary-header"')
        expect(res.text).to.include('id="cohort-summary-body"')
        expect(res.text).to.include('Cohort Summary')
        expect(res.text).to.include('Per-Sample Counts')
    })

    it('app.js includes loadSampleSummary function', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('loadSampleSummary')
        expect(res.text).to.include('sample-summary')
        expect(res.text).to.include('cohort-summary-header')
        expect(res.text).to.include('cohort_summary')
    })

    it('app.js renders curation breakdown columns in sample summary', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('curation_counts')
        expect(res.text).to.include('total_unfiltered')
        expect(res.text).to.include('Passing Filters')
        expect(res.text).to.include('Curated')
        expect(res.text).to.include('Unfiltered')
    })

    it('app.js renders sample curation buttons in sample summary', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('sample-curate-btn')
        expect(res.text).to.include('curateSample')
        expect(res.text).to.include('Flag Sample')
        expect(res.text).to.include('/api/curate/sample')
    })
})

describe('UI: Gene curation buttons', function () {
    it('index.html includes Flag Gene column header', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('Flag Gene')
    })

    it('app.js includes curateGene function', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('curateGene')
        expect(res.text).to.include('gene-curate-btn')
    })
})

describe('API /api/sample-qc', function () {
    it('returns QC structure with loaded flag', async function () {
        const res = await request(app).get('/api/sample-qc').expect(200)
        expect(res.body).to.have.property('loaded').that.is.a('boolean')
        expect(res.body).to.have.property('trios').that.is.an('array')
        expect(res.body).to.have.property('metric_columns').that.is.an('array')
        expect(res.body).to.have.property('thresholds').that.is.an('object')
    })

    it('returns freemix threshold configuration', async function () {
        const res = await request(app).get('/api/sample-qc').expect(200)
        expect(res.body.thresholds).to.have.property('freemix')
        expect(res.body.thresholds.freemix).to.be.an('array')
        expect(res.body.thresholds.freemix.length).to.equal(4)
        expect(res.body.thresholds.freemix[0]).to.have.property('label', 'pass')
        expect(res.body.thresholds.freemix[1]).to.have.property('label', 'warn')
        expect(res.body.thresholds.freemix[2]).to.have.property('label', 'fail')
        expect(res.body.thresholds.freemix[3]).to.have.property('label', 'critical')
    })
})

describe('API /api/config includes QC metadata', function () {
    it('config has hasSampleQc and qcMetricThresholds', async function () {
        const res = await request(app).get('/api/config').expect(200)
        expect(res.body).to.have.property('hasSampleQc').that.is.a('boolean')
        expect(res.body).to.have.property('qcMetricThresholds').that.is.an('object')
        expect(res.body.qcMetricThresholds).to.have.property('freemix')
    })
})

describe('UI: Sample QC tab', function () {
    it('index.html includes sample QC tab elements', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('data-tab="sample-qc"')
        expect(res.text).to.include('id="tab-sample-qc"')
        expect(res.text).to.include('id="sample-qc-body"')
    })

    it('app.js includes loadSampleQc function', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('loadSampleQc')
        expect(res.text).to.include('sample-qc')
    })

    it('app.js includes QC warning indicator rendering', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('qc-warn-indicator')
        expect(res.text).to.include('qcStatusTitle')
        expect(res.text).to.include('qcCellClass')
    })

    it('styles.css includes QC badge and indicator styles', async function () {
        const res = await request(app).get('/styles.css').expect(200)
        expect(res.text).to.include('.qc-badge')
        expect(res.text).to.include('.qc-badge-pass')
        expect(res.text).to.include('.qc-badge-warn')
        expect(res.text).to.include('.qc-badge-fail')
        expect(res.text).to.include('.qc-badge-critical')
        expect(res.text).to.include('.qc-warn-indicator')
        expect(res.text).to.include('.qc-cell-pass')
        expect(res.text).to.include('.qc-cell-warn')
        expect(res.text).to.include('.qc-cell-fail')
        expect(res.text).to.include('.qc-cell-critical')
    })
})

describe('UI: Collapsible filter groups', function () {
    it('index.html includes collapse/expand all button', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('id="btn-toggle-all-filters"')
        expect(res.text).to.include('Collapse All')
    })

    it('app.js includes collapsible filter group functions', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('toggleFilterGroup')
        expect(res.text).to.include('setupFilterCollapseAll')
        expect(res.text).to.include('updateCollapseAllButton')
    })

    it('app.js creates filter groups with toggle headers', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('filter-group-header')
        expect(res.text).to.include('filter-group-content')
        expect(res.text).to.include('toggle-icon')
    })

    it('styles.css includes collapsible filter group styles', async function () {
        const res = await request(app).get('/styles.css').expect(200)
        expect(res.text).to.include('.filter-group-header')
        expect(res.text).to.include('.filter-group-content')
        expect(res.text).to.include('.filter-group.collapsed')
        expect(res.text).to.include('.toggle-icon')
    })
})

describe('UI: Collapsible sidebar', function () {
    it('index.html includes sidebar collapse toggle button', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('id="btn-collapse-sidebar"')
    })

    it('app.js includes sidebar toggle functions', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('setupSidebarToggle')
        expect(res.text).to.include('toggleSidebar')
        expect(res.text).to.include('sidebar-collapsed')
    })

    it('styles.css includes sidebar collapse styles', async function () {
        const res = await request(app).get('/styles.css').expect(200)
        expect(res.text).to.include('#btn-collapse-sidebar')
        expect(res.text).to.include('.sidebar-collapsed')
    })

    it('index.html documents sidebar toggle shortcut', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('Toggle sidebar')
        expect(res.text).to.include('Ctrl+B')
    })
})

describe('UI: Display mode controller', function () {
    it('index.html includes display mode select', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('id="display-mode-select"')
        expect(res.text).to.include('SQUISHED')
        expect(res.text).to.include('EXPANDED')
        expect(res.text).to.include('COLLAPSED')
    })

    it('app.js includes display mode control setup', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('setupDisplayModeControl')
        expect(res.text).to.include('display-mode-select')
    })

    it('app.js applies selected display mode to new tracks', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include("const displayMode = sel ? sel.value : 'SQUISHED'")
        expect(res.text).to.include('displayMode: displayMode')
    })

    it('styles.css includes display mode control styles', async function () {
        const res = await request(app).get('/styles.css').expect(200)
        expect(res.text).to.include('#igv-controls')
        expect(res.text).to.include('.display-mode-label')
    })
})

describe('UI: IGV scroll-into-view on variant selection', function () {
    it('app.js scrolls IGV section into view on variant selection', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include("igvSection.scrollIntoView")
        expect(res.text).to.include("block: 'nearest'")
    })

    it('app.js scrolls active row into view within table', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('activeRow.scrollIntoView')
    })

    it('showInIgv navigates to locus before loading tracks', async function () {
        const res = await request(app).get('/app.js').expect(200)
        // search() should come before loadTrackList() to avoid two loading cycles
        const searchPos = res.text.indexOf('igvBrowser.search(locus)')
        const loadPos = res.text.indexOf('igvBrowser.loadTrackList(tracks)')
        expect(searchPos).to.be.greaterThan(-1)
        expect(loadPos).to.be.greaterThan(-1)
        expect(searchPos).to.be.lessThan(loadPos)
    })
})

describe('UI: Increased IGV viewer height', function () {
    it('styles.css sets IGV min-height to 400px', async function () {
        const res = await request(app).get('/styles.css').expect(200)
        expect(res.text).to.include('min-height: 400px')
    })
})

describe('API /api/variants search', function () {
    it('filters variants by search term matching gene name', async function () {
        const res = await request(app).get('/api/variants?search=GENE2').expect(200)
        expect(res.body.total).to.equal(2)
        res.body.data.forEach(v => expect(v.gene).to.equal('GENE2'))
    })

    it('filters variants by search term matching chrom', async function () {
        const res = await request(app).get('/api/variants?search=chr10').expect(200)
        expect(res.body.total).to.equal(1)
        expect(res.body.data[0].chrom).to.equal('chr10')
    })

    it('search is case-insensitive', async function () {
        const res = await request(app).get('/api/variants?search=gene4').expect(200)
        expect(res.body.total).to.equal(2)
        res.body.data.forEach(v => expect(v.gene).to.equal('GENE4'))
    })

    it('search combines with other filters', async function () {
        const res = await request(app).get('/api/variants?search=GENE1&impact=HIGH').expect(200)
        expect(res.body.total).to.equal(1)
        expect(res.body.data[0].gene).to.equal('GENE1')
        expect(res.body.data[0].impact).to.equal('HIGH')
    })

    it('returns empty when search matches nothing', async function () {
        const res = await request(app).get('/api/variants?search=NONEXISTENT').expect(200)
        expect(res.body.total).to.equal(0)
        expect(res.body.data).to.have.lengthOf(0)
    })
})

describe('API /api/summary includes sample count', function () {
    it('each gene entry has a samples count', async function () {
        const res = await request(app).get('/api/summary').expect(200)
        res.body.summary.forEach(g => {
            expect(g).to.have.property('samples').that.is.a('number')
        })
    })

    it('samples count reflects distinct samples per gene', async function () {
        const res = await request(app).get('/api/summary').expect(200)
        // All example data has no sample_id/trio_id column, so samples = 0
        // But we verify the property exists and is numeric
        const gene1 = res.body.summary.find(g => g.gene === 'GENE1')
        expect(gene1).to.exist
        expect(gene1).to.have.property('samples').that.is.a('number')
        expect(gene1.total).to.equal(2)
    })
})

describe('UI: Variant search bar', function () {
    it('index.html includes search input', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('id="variant-search"')
        expect(res.text).to.include('placeholder="Search variants')
    })

    it('index.html includes search clear button', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('id="variant-search-clear"')
    })

    it('app.js includes setupVariantSearch function', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('setupVariantSearch')
        expect(res.text).to.include('variant-search')
    })

    it('styles.css includes search bar styles', async function () {
        const res = await request(app).get('/styles.css').expect(200)
        expect(res.text).to.include('.variant-search-wrap')
    })
})

describe('UI: VCF track support', function () {
    it('app.js includes VCF track building logic', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('config.vcfTrack')
        expect(res.text).to.include("type: 'variant'")
        expect(res.text).to.include("format: 'vcf'")
    })

    it('app.js supports per-variant VCF columns', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('_vcf`')
        expect(res.text).to.include('_vcf_index`')
        expect(res.text).to.include('_vcf_id`')
        expect(res.text).to.include('vcfMap')
    })
})

describe('Per-trio VCF columns in variant data', function () {
    it('config columns include VCF-related columns', async function () {
        const res = await request(app).get('/api/config').expect(200)
        const cols = res.body.columns
        expect(cols).to.include('child_vcf')
        expect(cols).to.include('mother_vcf')
        expect(cols).to.include('father_vcf')
        expect(cols).to.include('child_vcf_index')
        expect(cols).to.include('mother_vcf_index')
        expect(cols).to.include('father_vcf_index')
        expect(cols).to.include('child_vcf_id')
        expect(cols).to.include('mother_vcf_id')
        expect(cols).to.include('father_vcf_id')
    })

    it('variants contain VCF file and sample ID data', async function () {
        const res = await request(app).get('/api/variants').expect(200)
        expect(res.body.data).to.be.an('array').with.length.greaterThan(0)
        const v = res.body.data[0]
        expect(v).to.have.property('child_vcf')
        expect(v).to.have.property('mother_vcf')
        expect(v).to.have.property('father_vcf')
        expect(v).to.have.property('child_vcf_id')
        expect(v).to.have.property('mother_vcf_id')
        expect(v).to.have.property('father_vcf_id')
        expect(v.child_vcf).to.match(/\.vcf\.gz$/)
        expect(v.child_vcf_index).to.match(/\.vcf\.gz\.tbi$/)
    })
})

describe('UI: Gene summary Samples column', function () {
    it('index.html includes Samples column in gene summary header', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('<th>Samples</th>')
    })

    it('app.js renders sample count in gene summary rows', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('g.samples')
    })
})

describe('XLSX Gene Summary includes Samples column', function () {
    it('Gene Summary sheet has Samples header', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({variantIds: [0, 1, 2, 3, 4]})
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        const geneSummary = workbook.getWorksheet('Gene Summary')
        expect(geneSummary).to.exist
        const gsHeader = []
        geneSummary.getRow(1).eachCell(cell => gsHeader.push(cell.value))
        expect(gsHeader).to.include('Samples')
    })
})

describe('UI: IGV title shows trio AD, GQ, and DKA/DKT metadata', function () {
    it('app.js contains buildIgvTitle helper that renders AD badges', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('buildIgvTitle')
        expect(res.text).to.include('child_AD')
        expect(res.text).to.include('mother_AD')
        expect(res.text).to.include('father_AD')
        expect(res.text).to.include('igv-meta')
        expect(res.text).to.include('Allelic Depth')
    })

    it('app.js renders GQ badges for trio members', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('child_GQ')
        expect(res.text).to.include('mother_GQ')
        expect(res.text).to.include('father_GQ')
        expect(res.text).to.include('Genotype Quality')
    })

    it('app.js renders child DKA/DKT metric', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('child_DKA_DKT')
        expect(res.text).to.include('DKA/DKT')
    })

    it('styles.css contains igv-meta badge styling', async function () {
        const res = await request(app).get('/styles.css').expect(200)
        expect(res.text).to.include('.igv-meta')
        expect(res.text).to.include('.igv-locus')
        expect(res.text).to.include('.igv-gene')
    })

    it('variant data includes AD, GQ, and DKA_DKT columns', async function () {
        const res = await request(app).get('/api/variants').expect(200)
        const v = res.body.data[0]
        expect(v).to.have.property('child_AD')
        expect(v).to.have.property('mother_AD')
        expect(v).to.have.property('father_AD')
        expect(v).to.have.property('child_GQ')
        expect(v).to.have.property('mother_GQ')
        expect(v).to.have.property('father_GQ')
        expect(v).to.have.property('child_DKA_DKT')
    })
})

describe('UI: Curation note suggestions dropdown', function () {
    it('index.html includes note-suggestions select element', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('id="note-suggestions"')
        expect(res.text).to.include('Previous notes')
    })

    it('app.js includes refreshNoteSuggestions function', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('refreshNoteSuggestions')
        expect(res.text).to.include('note-suggestions')
        expect(res.text).to.include('curation_note')
    })

    it('app.js populates textarea from dropdown selection', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('setupNoteSuggestions')
        expect(res.text).to.include("sel.value")
        expect(res.text).to.include("curation-note")
    })

    it('styles.css includes note-suggestions styling', async function () {
        const res = await request(app).get('/styles.css').expect(200)
        expect(res.text).to.include('#note-suggestions')
    })
})

describe('UI: Previous notes and curation counts from server', function () {
    it('app.js uses server-provided curation counts in updateStats', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('curationCounts.pass')
        expect(res.text).to.include('curationCounts.fail')
        expect(res.text).to.include('curationCounts.uncertain')
        expect(res.text).to.include('curationCounts.pending')
    })

    it('app.js uses server-provided allNotes in refreshNoteSuggestions', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('allNotes')
        expect(res.text).to.include('data.all_notes')
    })

    it('app.js calls refreshNoteSuggestions in loadVariants', async function () {
        const res = await request(app).get('/app.js').expect(200)
        // Verify refreshNoteSuggestions is called inside loadVariants (after data load)
        const loadVariantsMatch = res.text.match(/async function loadVariants\(\)[\s\S]*?(?=\n    async function|\n    function)/)
        expect(loadVariantsMatch).to.not.be.null
        expect(loadVariantsMatch[0]).to.include('refreshNoteSuggestions()')
    })
})

// ── Documentation validation ─────────────────────────────────────────────────
describe('Documentation', function () {
    const docsDir = path.join(__dirname, '..', '..', 'docs')
    const screenshotsDir = path.join(docsDir, 'screenshots')

    const expectedScreenshots = [
        '01-overview.png',
        '02-variant-table.png',
        '03-filter-panel.png',
        '04-igv-viewer.png',
        '05-gene-summary.png',
        '06-sample-summary.png',
        '07-keyboard-shortcuts.png',
        '08-curation-workflow.png',
    ]

    it('docs/index.html exists', function () {
        expect(fs.existsSync(path.join(docsDir, 'index.html'))).to.be.true
    })

    expectedScreenshots.forEach(name => {
        it(`screenshot ${name} exists`, function () {
            const filePath = path.join(screenshotsDir, name)
            expect(fs.existsSync(filePath), `${name} missing`).to.be.true
            const stat = fs.statSync(filePath)
            expect(stat.size).to.be.greaterThan(0)
        })
    })

    it('docs/index.html references all screenshots', function () {
        const html = fs.readFileSync(path.join(docsDir, 'index.html'), 'utf8')
        expectedScreenshots.forEach(name => {
            expect(html).to.include(`screenshots/${name}`,
                `docs/index.html does not reference ${name}`)
        })
    })
})

// =========================================================================
// Lollipop Plot API
// =========================================================================
describe('Lollipop Plot API', function () {
    this.timeout(15000)

    function getSvg(url) {
        return request(app)
            .get(url)
            .buffer(true)
            .parse((res, callback) => {
                let data = ''
                res.setEncoding('utf8')
                res.on('data', chunk => { data += chunk })
                res.on('end', () => callback(null, data))
            })
    }

    it('GET /api/lollipop/:gene returns SVG for a known gene', async function () {
        const res = await getSvg('/api/lollipop/GENE1').expect(200)
        expect(res.body).to.include('<svg')
        expect(res.body).to.include('GENE1')
        expect(res.body).to.include('Lollipop Plot')
    })

    it('returns 404 for unknown gene', async function () {
        const res = await request(app)
            .get('/api/lollipop/NONEXISTENT_GENE')
            .expect(404)
        expect(res.body.error).to.include('No variants found')
    })

    it('SVG contains impact legend colors', async function () {
        const res = await getSvg('/api/lollipop/GENE1').expect(200)
        expect(res.body).to.include('#e74c3c')  // HIGH
        expect(res.body).to.include('HIGH')
    })

    it('SVG includes variant positions as lollipop circles', async function () {
        const res = await getSvg('/api/lollipop/GENE1').expect(200)
        expect(res.body).to.include('<circle')
        expect(res.body).to.include('<line')
        expect(res.body).to.include('chr1:12345')
    })

    it('respects filters in query string', async function () {
        const res = await getSvg('/api/lollipop/GENE1?impact=HIGH').expect(200)
        expect(res.body).to.include('GENE1')
        expect(res.body).to.include('<circle')
    })
})

// =========================================================================
// Lollipop Plot SVG Generator (unit tests)
// =========================================================================
describe('Lollipop SVG Generator', function () {
    const {generateLollipopSvg} = require('../lollipop')

    it('generates SVG for a gene with variants', function () {
        const variants = [
            {chrom: 'chr1', pos: 1000, ref: 'A', alt: 'G', impact: 'HIGH'},
            {chrom: 'chr1', pos: 2000, ref: 'C', alt: 'T', impact: 'MODERATE'}
        ]
        const svg = generateLollipopSvg('TEST_GENE', variants)
        expect(svg).to.include('<svg')
        expect(svg).to.include('TEST_GENE')
        expect(svg).to.include('2 variants')
        expect(svg).to.include('#e74c3c')  // HIGH color
        expect(svg).to.include('#f39c12')  // MODERATE color
    })

    it('generates empty-state SVG for no variants', function () {
        const svg = generateLollipopSvg('EMPTY_GENE', [])
        expect(svg).to.include('<svg')
        expect(svg).to.include('No variants')
    })

    it('handles single variant', function () {
        const variants = [{chrom: 'chr1', pos: 5000, ref: 'G', alt: 'A', impact: 'LOW'}]
        const svg = generateLollipopSvg('SINGLE', variants)
        expect(svg).to.include('<svg')
        expect(svg).to.include('1 variant')
        expect(svg).to.include('<circle')
    })

    it('handles multiple variants at same position', function () {
        const variants = [
            {chrom: 'chr1', pos: 1000, ref: 'A', alt: 'G', impact: 'HIGH'},
            {chrom: 'chr1', pos: 1000, ref: 'A', alt: 'T', impact: 'MODERATE'}
        ]
        const svg = generateLollipopSvg('OVERLAP', variants)
        expect(svg).to.include('<svg')
        // Count data circles (those with a <title> tooltip child)
        const dataCircles = svg.match(/<circle[^>]*>[\s\S]*?<title>/g)
        expect(dataCircles).to.have.length(2)
    })

    it('respects custom width and height options', function () {
        const variants = [{chrom: 'chr1', pos: 1000, ref: 'A', alt: 'G'}]
        const svg = generateLollipopSvg('SIZED', variants, {width: 600, height: 200})
        expect(svg).to.include('width="600"')
        expect(svg).to.include('height="200"')
    })

    it('escapes special characters in gene names', function () {
        const variants = [{chrom: 'chr1', pos: 1000, ref: 'A', alt: 'G'}]
        const svg = generateLollipopSvg('GENE<>&"TEST', variants)
        expect(svg).to.not.include('GENE<>')
        expect(svg).to.include('GENE&lt;&gt;&amp;&quot;TEST')
    })

    it('renders protein domains on the gene bar when provided', function () {
        const variants = [
            {chrom: 'chr17', pos: 43044295, ref: 'A', alt: 'G', impact: 'HIGH'}
        ]
        const domains = [
            {name: 'RING-type', start: 1, end: 101},
            {name: 'BRCT 1', start: 1646, end: 1736},
            {name: 'BRCT 2', start: 1756, end: 1855}
        ]
        const svg = generateLollipopSvg('BRCA1', variants, {
            domains,
            proteinLength: 1863,
            accession: 'P38398'
        })
        expect(svg).to.include('domain-rect')
        expect(svg).to.include('RING-type')
        expect(svg).to.include('BRCT')
        expect(svg).to.include('P38398')
        expect(svg).to.include('1863 aa')
        expect(svg).to.include('Protein domains (aa) scaled proportionally on bar')
    })

    it('falls back to standard plot when no domains provided', function () {
        const variants = [{chrom: 'chr1', pos: 1000, ref: 'A', alt: 'G'}]
        const svg = generateLollipopSvg('TEST', variants)
        expect(svg).to.not.include('class="domain-rect"')
        expect(svg).to.not.include('Protein domains (aa)')
    })

    it('assigns distinct colors to different domains', function () {
        const variants = [{chrom: 'chr1', pos: 1000, ref: 'A', alt: 'G'}]
        const domains = [
            {name: 'Domain_A', start: 10, end: 100},
            {name: 'Domain_B', start: 200, end: 300}
        ]
        const svg = generateLollipopSvg('TEST', variants, {
            domains, proteinLength: 500
        })
        // Both domains should be present as rects
        const domainRects = svg.match(/class="domain-rect"/g)
        expect(domainRects).to.have.length(2)
        // Domain names in tooltips
        expect(svg).to.include('Domain_A')
        expect(svg).to.include('Domain_B')
    })

    it('renders domain legend at bottom when domains present', function () {
        const variants = [{chrom: 'chr1', pos: 1000, ref: 'A', alt: 'G'}]
        const domains = [{name: 'Kinase', start: 50, end: 200}]
        const svg = generateLollipopSvg('TEST', variants, {
            domains, proteinLength: 400
        })
        // Legend should include the domain name
        expect(svg).to.include('Kinase')
    })
})

// =========================================================================
// XLSX Gene Lollipop Plot worksheets
// =========================================================================
describe('XLSX Gene Lollipop Plot worksheets', function () {
    after(function () {
        if (fs.existsSync(curationFile)) fs.unlinkSync(curationFile)
    })

    it('includes Gene Lollipop Plot worksheet when lollipopPlots provided', async function () {
        this.timeout(10000)
        // Create a minimal valid PNG (1x1 white pixel)
        const pngData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='

        const res = await request(app)
            .post('/api/export/xlsx')
            .send({
                variantIds: [0, 1, 2],
                lollipopPlots: {GENE1: pngData}
            })
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        const lpSheet = workbook.getWorksheet('LP GENE1')
        expect(lpSheet).to.exist
        expect(lpSheet.getCell('A1').value).to.include('Lollipop Plot')
        expect(lpSheet.getCell('A1').value).to.include('GENE1')
    })

    it('lollipop sheet includes variant count and back link', async function () {
        this.timeout(10000)
        const pngData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='

        const res = await request(app)
            .post('/api/export/xlsx')
            .send({
                variantIds: [0, 1, 2],
                lollipopPlots: {GENE1: pngData}
            })
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        const lpSheet = workbook.getWorksheet('LP GENE1')
        expect(lpSheet).to.exist
        // Variant count row
        expect(lpSheet.getCell('A2').value).to.equal('Variants:')
        const b2 = lpSheet.getCell('B2').value
        expect(b2).to.include('total')
        expect(b2).to.include('passing')
        // Back link
        const d1 = lpSheet.getCell('D1').value
        expect(d1).to.have.property('text', '← Back to Variants')
    })

    it('omits lollipop sheets when no lollipopPlots provided', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({variantIds: [0, 1, 2]})
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        const sheetNames = workbook.worksheets.map(ws => ws.name)
        const lpSheets = sheetNames.filter(n => n.startsWith('LP '))
        expect(lpSheets).to.have.length(0)
    })

    it('supports multiple gene lollipop plots', async function () {
        this.timeout(10000)
        const pngData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='

        const res = await request(app)
            .post('/api/export/xlsx')
            .send({
                variantIds: [0, 1, 2, 3],
                lollipopPlots: {GENE1: pngData, GENE2: pngData}
            })
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        expect(workbook.getWorksheet('LP GENE1')).to.exist
        expect(workbook.getWorksheet('LP GENE2')).to.exist
    })
})

// =========================================================================
// XLSX gene→lollipop hyperlinks
// =========================================================================
describe('XLSX gene to lollipop hyperlinks', function () {
    it('gene cells link to lollipop sheet when lollipop plots are provided', async function () {
        this.timeout(10000)
        const pngData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='

        const res = await request(app)
            .post('/api/export/xlsx')
            .send({
                variantIds: [0, 1, 2],
                lollipopPlots: {GENE1: pngData}
            })
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        const variantsSheet = workbook.getWorksheet('Variants')
        expect(variantsSheet).to.exist

        // Find the gene column index
        const headerRow = variantsSheet.getRow(1)
        let geneColIdx = -1
        headerRow.eachCell((cell, colNumber) => {
            if (cell.value && cell.value.toString().toLowerCase() === 'gene') geneColIdx = colNumber
        })
        expect(geneColIdx).to.be.greaterThan(0)

        // Check that a GENE1 row has a hyperlink to the LP sheet
        let foundLink = false
        variantsSheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return // skip header
            const geneCell = row.getCell(geneColIdx)
            const cellValue = geneCell.value
            if (cellValue && typeof cellValue === 'object' && cellValue.text === 'GENE1') {
                expect(cellValue.hyperlink).to.include('LP GENE1')
                foundLink = true
            }
        })
        expect(foundLink).to.be.true
    })

    it('gene cells without lollipop plot have no hyperlink', async function () {
        this.timeout(10000)
        const pngData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='

        const res = await request(app)
            .post('/api/export/xlsx')
            .send({
                variantIds: [0, 1, 2, 3],
                lollipopPlots: {GENE1: pngData}  // Only GENE1, not GENE2
            })
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        const variantsSheet = workbook.getWorksheet('Variants')
        const headerRow = variantsSheet.getRow(1)
        let geneColIdx = -1
        headerRow.eachCell((cell, colNumber) => {
            if (cell.value && cell.value.toString().toLowerCase() === 'gene') geneColIdx = colNumber
        })

        // GENE2 rows should have plain text, not hyperlinks
        variantsSheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return
            const geneCell = row.getCell(geneColIdx)
            const cellValue = geneCell.value
            if (cellValue === 'GENE2' || (cellValue && typeof cellValue === 'object' && cellValue.text === 'GENE2')) {
                // Should be plain text
                expect(typeof cellValue).to.equal('string')
            }
        })
    })
})

// =========================================================================
// XLSX variant column filtering
// =========================================================================
describe('XLSX variant column filtering', function () {
    it('excludes file path columns when filePaths is false', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({
                variantIds: [0, 1],
                exportConfig: {variantColumns: {filePaths: false}}
            })
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        const variantsSheet = workbook.getWorksheet('Variants')
        const headers = []
        variantsSheet.getRow(1).eachCell(cell => {
            headers.push(cell.value)
        })
        // Should not contain file-path-like columns
        const fileHeaders = headers.filter(h => {
            const lower = h.toLowerCase().replace(/ /g, '_')
            return lower.endsWith('_file') || lower.endsWith('_index')
        })
        expect(fileHeaders).to.have.length(0)
    })

    it('includes all columns by default', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({variantIds: [0, 1]})
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        const variantsSheet = workbook.getWorksheet('Variants')
        const headers = []
        variantsSheet.getRow(1).eachCell(cell => {
            headers.push(cell.value)
        })
        // Should have many columns (gene, impact, etc.)
        expect(headers.length).to.be.greaterThan(4)
    })

    it('always includes curation columns regardless of config', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({
                variantIds: [0, 1],
                exportConfig: {variantColumns: {otherAnnotations: false}}
            })
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        const variantsSheet = workbook.getWorksheet('Variants')
        const headers = []
        variantsSheet.getRow(1).eachCell(cell => {
            headers.push(cell.value)
        })
        expect(headers).to.include('Curation Status')
        expect(headers).to.include('Curation Note')
    })
})

// =========================================================================
// HTML export with export config
// =========================================================================
describe('HTML export with export config', function () {
    const binaryParse = (res, callback) => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => callback(null, Buffer.concat(chunks)))
    }

    it('accepts exportConfig and filters columns', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/html')
            .send({
                variantIds: [0, 1],
                exportConfig: {variantColumns: {filePaths: false}}
            })
            .buffer(true)
            .parse(binaryParse)
            .expect(200)

        const JSZip = require('jszip')
        const zip = await JSZip.loadAsync(res.body)
        const html = await zip.file('variants_report/index.html').async('string')
        // Should not contain file path column headers
        expect(html).to.not.include('Child File')
    })

    it('respects screenshot config', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/html')
            .send({
                variantIds: [0, 1],
                exportConfig: {igvScreenshots: false}
            })
            .buffer(true)
            .parse(binaryParse)
            .expect(200)

        const JSZip = require('jszip')
        const zip = await JSZip.loadAsync(res.body)
        const html = await zip.file('variants_report/index.html').async('string')
        // Should still have the variants table
        expect(html).to.include('variantTable')
    })
})

// =========================================================================
// Export config module – variantColumns
// =========================================================================
describe('Export config variantColumns', function () {
    const {DEFAULT_EXPORT_CONFIG, mergeWithDefaults, categoriseColumn, filterColumns} = require('../export-config')

    it('DEFAULT_EXPORT_CONFIG includes variantColumns', function () {
        expect(DEFAULT_EXPORT_CONFIG).to.have.property('variantColumns')
        expect(DEFAULT_EXPORT_CONFIG.variantColumns).to.have.property('coreVariant', true)
        expect(DEFAULT_EXPORT_CONFIG.variantColumns).to.have.property('filePaths', true)
        expect(DEFAULT_EXPORT_CONFIG.variantColumns).to.have.property('otherAnnotations', true)
    })

    it('mergeWithDefaults deep-merges variantColumns', function () {
        const merged = mergeWithDefaults({variantColumns: {filePaths: false}})
        expect(merged.variantColumns.filePaths).to.equal(false)
        expect(merged.variantColumns.coreVariant).to.equal(true)
    })

    it('categoriseColumn classifies columns correctly', function () {
        expect(categoriseColumn('chrom')).to.equal('coreVariant')
        expect(categoriseColumn('pos')).to.equal('coreVariant')
        expect(categoriseColumn('gene')).to.equal('geneInfo')
        expect(categoriseColumn('impact')).to.equal('geneInfo')
        expect(categoriseColumn('frequency')).to.equal('frequency')
        expect(categoriseColumn('quality')).to.equal('quality')
        expect(categoriseColumn('child_gt')).to.equal('genotypes')
        expect(categoriseColumn('child_AD')).to.equal('allelicDepth')
        expect(categoriseColumn('child_GQ')).to.equal('genotypeQuality')
        expect(categoriseColumn('sample_id')).to.equal('sampleInfo')
        expect(categoriseColumn('child_file')).to.equal('filePaths')
        expect(categoriseColumn('child_vcf_id')).to.equal('filePaths')
        expect(categoriseColumn('cadd_score')).to.equal('otherAnnotations')
    })

    it('filterColumns removes disabled categories', function () {
        const cols = ['chrom', 'pos', 'ref', 'alt', 'gene', 'child_file', 'curation_status']
        const filtered = filterColumns(cols, {coreVariant: true, geneInfo: true, filePaths: false, otherAnnotations: true})
        expect(filtered).to.include('chrom')
        expect(filtered).to.include('gene')
        expect(filtered).to.not.include('child_file')
        expect(filtered).to.include('curation_status') // always included
    })

    it('filterColumns includes all when no config', function () {
        const cols = ['chrom', 'pos', 'child_file', 'curation_status']
        const filtered = filterColumns(cols, null)
        expect(filtered).to.deep.equal(cols)
    })
})

// =========================================================================
// UI: Lollipop plot integration
// =========================================================================
describe('UI: Lollipop plot integration', function () {
    it('index.html includes lollipop modal', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('lollipop-modal')
        expect(res.text).to.include('lollipop-modal-body')
        expect(res.text).to.include('lollipop-modal-close')
    })

    it('index.html gene summary table has Plot column', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('<th>Plot</th>')
    })

    it('app.js contains lollipop plot functions', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('showLollipopPlot')
        expect(res.text).to.include('lollipop-btn')
        expect(res.text).to.include('svgToPng')
        expect(res.text).to.include('lollipopPlots')
    })

    it('styles.css includes lollipop modal styling', async function () {
        const res = await request(app).get('/styles.css').expect(200)
        expect(res.text).to.include('.modal-overlay')
        expect(res.text).to.include('.lollipop-modal-content')
        expect(res.text).to.include('.lollipop-btn')
    })

    it('index.html includes export config panel', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('export-config-panel')
        expect(res.text).to.include('btn-export-config')
        expect(res.text).to.include('btn-save-export-config')
        expect(res.text).to.include('btn-load-export-config')
        expect(res.text).to.include('data-config-key')
    })

    it('index.html has export config toggles for all feature areas', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('data-config-key="igvScreenshots"')
        expect(res.text).to.include('data-config-key="lollipopPlots"')
        expect(res.text).to.include('data-config-key="proteinDomains"')
        expect(res.text).to.include('data-config-key="geneAnnotations.enabled"')
        expect(res.text).to.include('data-config-key="geneAnnotations.summary"')
        expect(res.text).to.include('data-config-key="geneAnnotations.omim"')
        expect(res.text).to.include('data-config-key="variantColumns.coreVariant"')
        expect(res.text).to.include('data-config-key="variantColumns.filePaths"')
        expect(res.text).to.include('data-config-key="variantColumns.otherAnnotations"')
    })

    it('app.js contains export config functions', async function () {
        const res = await request(app).get('/app.js').expect(200)
        expect(res.text).to.include('loadExportConfig')
        expect(res.text).to.include('saveExportConfig')
        expect(res.text).to.include('getExportConfigFromUI')
        expect(res.text).to.include('applyExportConfigToUI')
    })

    it('styles.css includes export config panel styling', async function () {
        const res = await request(app).get('/styles.css').expect(200)
        expect(res.text).to.include('.config-panel')
        expect(res.text).to.include('.config-section')
    })
})

// =========================================================================
// Protein domain fetcher (pfam.js)
// =========================================================================
describe('Protein domain fetcher', function () {
    const {fetchProteinDomains, clearCache} = require('../pfam')

    afterEach(function () {
        clearCache()
    })

    it('exports fetchProteinDomains and clearCache functions', function () {
        expect(fetchProteinDomains).to.be.a('function')
        expect(clearCache).to.be.a('function')
    })

    it('returns null for empty gene name', async function () {
        const result = await fetchProteinDomains('')
        expect(result).to.be.null
    })

    it('returns null for null gene name', async function () {
        const result = await fetchProteinDomains(null)
        expect(result).to.be.null
    })

    it('gracefully handles unreachable API', async function () {
        this.timeout(15000)
        // In this test environment, external APIs are unreachable
        // The function should return null gracefully
        const result = await fetchProteinDomains('BRCA1')
        // Either null (API unreachable) or valid data (API reachable)
        if (result !== null) {
            expect(result).to.have.property('proteinLength')
            expect(result).to.have.property('domains')
            expect(result).to.have.property('accession')
            expect(result.domains).to.be.an('array')
        }
    })

    it('caches results across calls', async function () {
        this.timeout(15000)
        const result1 = await fetchProteinDomains('TP53')
        const result2 = await fetchProteinDomains('TP53')
        // Both should return the same value (cached)
        expect(result1).to.deep.equal(result2)
    })
})

// =========================================================================
// Export configuration
// =========================================================================
describe('API /api/export-config', function () {
    const exportConfigFile = path.join(__dirname, '..', 'example_data', 'variants.export-config.json')

    after(function () {
        if (fs.existsSync(exportConfigFile)) fs.unlinkSync(exportConfigFile)
    })

    it('returns default config when no saved config exists', async function () {
        if (fs.existsSync(exportConfigFile)) fs.unlinkSync(exportConfigFile)
        const res = await request(app).get('/api/export-config').expect(200)
        expect(res.body).to.have.property('sheets')
        expect(res.body.sheets).to.have.property('variants', true)
        expect(res.body).to.have.property('igvScreenshots', true)
        expect(res.body).to.have.property('lollipopPlots', true)
        expect(res.body).to.have.property('geneAnnotations')
        expect(res.body.geneAnnotations).to.have.property('enabled', true)
        expect(res.body).to.have.property('genomeBuild')
    })

    it('saves export configuration', async function () {
        const config = {igvScreenshots: false, lollipopPlots: true}
        const res = await request(app)
            .put('/api/export-config')
            .send(config)
            .expect(200)
        expect(res.body).to.have.property('ok', true)
        expect(fs.existsSync(exportConfigFile)).to.be.true
    })

    it('loads previously saved export config merged with defaults', async function () {
        const config = {igvScreenshots: false, geneAnnotations: {enabled: false}}
        fs.writeFileSync(exportConfigFile, JSON.stringify(config), 'utf-8')
        const res = await request(app).get('/api/export-config').expect(200)
        // Custom values
        expect(res.body.igvScreenshots).to.equal(false)
        expect(res.body.geneAnnotations.enabled).to.equal(false)
        // Defaults filled in
        expect(res.body.sheets.variants).to.equal(true)
        expect(res.body.lollipopPlots).to.equal(true)
    })

    it('rejects non-object body', async function () {
        await request(app)
            .put('/api/export-config')
            .send('invalid')
            .set('Content-Type', 'application/json')
            .expect(400)
    })
})

// =========================================================================
// Export config module unit tests
// =========================================================================
describe('Export config module', function () {
    const {DEFAULT_EXPORT_CONFIG, mergeWithDefaults} = require('../export-config')

    it('exports DEFAULT_EXPORT_CONFIG with expected keys', function () {
        expect(DEFAULT_EXPORT_CONFIG).to.have.property('sheets')
        expect(DEFAULT_EXPORT_CONFIG).to.have.property('igvScreenshots')
        expect(DEFAULT_EXPORT_CONFIG).to.have.property('lollipopPlots')
        expect(DEFAULT_EXPORT_CONFIG).to.have.property('proteinDomains')
        expect(DEFAULT_EXPORT_CONFIG).to.have.property('geneAnnotations')
        expect(DEFAULT_EXPORT_CONFIG).to.have.property('genomeBuild')
    })

    it('mergeWithDefaults returns defaults for null input', function () {
        const merged = mergeWithDefaults(null)
        expect(merged).to.deep.include(DEFAULT_EXPORT_CONFIG)
    })

    it('mergeWithDefaults preserves custom values', function () {
        const merged = mergeWithDefaults({igvScreenshots: false, geneAnnotations: {enabled: false}})
        expect(merged.igvScreenshots).to.equal(false)
        expect(merged.geneAnnotations.enabled).to.equal(false)
        // Defaults still present
        expect(merged.sheets.variants).to.equal(true)
        expect(merged.lollipopPlots).to.equal(true)
    })
})

// =========================================================================
// Gene annotation module
// =========================================================================
describe('Gene annotation module', function () {
    const {fetchGeneAnnotation, fetchGeneAnnotationsBatch, clearAnnotationCache} = require('../gene-annotations')

    afterEach(function () {
        clearAnnotationCache()
    })

    it('exports fetchGeneAnnotation, fetchGeneAnnotationsBatch, clearAnnotationCache', function () {
        expect(fetchGeneAnnotation).to.be.a('function')
        expect(fetchGeneAnnotationsBatch).to.be.a('function')
        expect(clearAnnotationCache).to.be.a('function')
    })

    it('returns null for empty gene name', async function () {
        const result = await fetchGeneAnnotation('')
        expect(result).to.be.null
    })

    it('returns null for null gene name', async function () {
        const result = await fetchGeneAnnotation(null)
        expect(result).to.be.null
    })

    it('gracefully handles unreachable API', async function () {
        this.timeout(15000)
        const result = await fetchGeneAnnotation('BRCA1')
        // Either an error object (API unreachable) or valid data
        expect(result).to.have.property('symbol', 'BRCA1')
        if (result.error) {
            expect(result.error).to.be.a('string')
        } else {
            expect(result).to.have.property('name')
            expect(result).to.have.property('summary')
        }
    })

    it('returns empty map for empty gene array', async function () {
        const result = await fetchGeneAnnotationsBatch([])
        expect(result).to.be.instanceOf(Map)
        expect(result.size).to.equal(0)
    })

    it('batch fetch returns results for each gene', async function () {
        this.timeout(15000)
        const result = await fetchGeneAnnotationsBatch(['TP53', 'BRCA1'])
        expect(result).to.be.instanceOf(Map)
        expect(result.size).to.equal(2)
        expect(result.has('TP53')).to.be.true
        expect(result.has('BRCA1')).to.be.true
    })

    it('caches results across calls', async function () {
        this.timeout(15000)
        const result1 = await fetchGeneAnnotation('TP53')
        const result2 = await fetchGeneAnnotation('TP53')
        expect(result1).to.deep.equal(result2)
    })
})

// =========================================================================
// Gene annotations API endpoint
// =========================================================================
describe('API /api/gene-annotations', function () {
    it('returns annotations and errors arrays', async function () {
        this.timeout(15000)
        const res = await request(app).get('/api/gene-annotations').expect(200)
        expect(res.body).to.have.property('annotations')
        expect(res.body).to.have.property('errors')
        expect(res.body).to.have.property('genomeBuild')
    })

    it('includes genomeBuild in response', async function () {
        const res = await request(app).get('/api/gene-annotations').expect(200)
        expect(res.body.genomeBuild).to.be.a('string')
    })
})

// =========================================================================
// Lollipop SVG genome build display
// =========================================================================
describe('Lollipop SVG genome build', function () {
    const {generateLollipopSvg} = require('../lollipop')

    it('includes genome build in subtitle when provided', function () {
        const variants = [{chrom: 'chr1', pos: 1000, ref: 'A', alt: 'G', impact: 'HIGH'}]
        const svg = generateLollipopSvg('TEST', variants, {genomeBuild: 'hg38'})
        expect(svg).to.include('[hg38]')
    })

    it('omits build tag when genomeBuild not provided', function () {
        const variants = [{chrom: 'chr1', pos: 1000, ref: 'A', alt: 'G'}]
        const svg = generateLollipopSvg('TEST', variants)
        expect(svg).to.not.include('[hg38]')
        expect(svg).to.not.include('[hg19]')
    })

    it('includes build with domain overlay', function () {
        const variants = [{chrom: 'chr17', pos: 43044295, ref: 'A', alt: 'G', impact: 'HIGH'}]
        const domains = [{name: 'RING-type', start: 1, end: 101}]
        const svg = generateLollipopSvg('BRCA1', variants, {
            domains, proteinLength: 1863, accession: 'P38398', genomeBuild: 'hg38'
        })
        expect(svg).to.include('[hg38]')
        expect(svg).to.include('P38398')
        expect(svg).to.include('Protein domains (aa) scaled proportionally on bar')
    })
})

// =========================================================================
// XLSX export with Annotation Status sheet
// =========================================================================
describe('XLSX Annotation Status worksheet', function () {
    after(function () {
        if (fs.existsSync(curationFile)) fs.unlinkSync(curationFile)
    })

    it('includes Annotation Status sheet with genome build', async function () {
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({variantIds: [], exportConfig: {genomeBuild: 'hg38', geneAnnotations: {enabled: false}}})
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)
        const wb = new ExcelJS.Workbook()
        await wb.xlsx.load(res.body)
        const asws = wb.getWorksheet('Annotation Status')
        expect(asws).to.not.be.undefined
        // Should contain genome build info
        let hasBuild = false
        asws.eachRow(row => {
            if (row.getCell(1).value === 'Genome Build') {
                hasBuild = true
                expect(row.getCell(4).value).to.include('hg38')
            }
        })
        expect(hasBuild).to.be.true
    })

    it('includes export config summary in Annotation Status', async function () {
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({variantIds: [], exportConfig: {igvScreenshots: false, lollipopPlots: true}})
            .buffer(true)
            .parse((res, callback) => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => callback(null, Buffer.concat(chunks)))
            })
            .expect(200)
        const wb = new ExcelJS.Workbook()
        await wb.xlsx.load(res.body)
        const asws = wb.getWorksheet('Annotation Status')
        expect(asws).to.not.be.undefined
        let hasConfig = false
        asws.eachRow(row => {
            if (row.getCell(1).value === 'Export Config') {
                hasConfig = true
                expect(row.getCell(4).value).to.include('Screenshots: OFF')
                expect(row.getCell(4).value).to.include('Lollipop: ON')
            }
        })
        expect(hasConfig).to.be.true
    })
})

describe('XLSX export robustness', function () {
    const xlsxParser = (res, callback) => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => callback(null, Buffer.concat(chunks)))
    }

    it('returns detailed error message on invalid request', async function () {
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({variantIds: [9999]})
            .expect(400)
        expect(res.body).to.have.property('error')
        expect(res.body.error).to.be.a('string')
        expect(res.body.error.length).to.be.greaterThan(0)
    })

    it('exports workbook even with invalid screenshot data', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({
                variantIds: [0, 1],
                screenshots: {'0': 'not-valid-base64!!!'}
            })
            .buffer(true)
            .parse(xlsxParser)
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        const varSheet = workbook.getWorksheet('Variants')
        expect(varSheet).to.exist
        expect(varSheet.rowCount).to.be.at.least(2)
    })

    it('exports workbook even with invalid lollipop image data', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({
                variantIds: [0, 1, 2],
                lollipopPlots: {GENE1: 'not-valid-base64!!!'}
            })
            .buffer(true)
            .parse(xlsxParser)
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        const varSheet = workbook.getWorksheet('Variants')
        expect(varSheet).to.exist
    })

    it('accepts large body payloads without 413 error', async function () {
        this.timeout(30000)
        // Build a fake screenshot entry that pushes the JSON body over the old
        // 50 MB global limit so we can confirm the 200 MB limit is in effect.
        // 51 MB of base64 characters (~= 51 * 1024 * 1024 chars).
        const bigFakeBase64 = 'A'.repeat(51 * 1024 * 1024)
        const screenshots = {'0': `data:image/png;base64,${bigFakeBase64}`}
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({variantIds: [0], screenshots})
            .buffer(true)
            .parse(xlsxParser)
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)
        expect(workbook.getWorksheet('Variants')).to.exist
    })

    it('creates screenshot sheet even when image embed fails', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({
                variantIds: [0],
                screenshots: {'0': 'data:image/png;base64,INVALID_BASE64_DATA!!!'}
            })
            .buffer(true)
            .parse(xlsxParser)
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        expect(workbook.getWorksheet('Variants')).to.exist
        const sheetNames = workbook.worksheets.map(ws => ws.name)
        expect(sheetNames).to.include('1')
    })

    it('handles all variants export without hidden size limits', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({})
            .buffer(true)
            .parse(xlsxParser)
            .expect(200)

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body)

        const varSheet = workbook.getWorksheet('Variants')
        expect(varSheet).to.exist
        expect(varSheet.rowCount).to.equal(11) // header + 10 test variants
    })

    it('includes server error details in 500 JSON response', async function () {
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({variantIds: [99999]})
            .expect(400)
        expect(res.body).to.have.property('error')
        expect(res.body.error).to.include('No variants')
    })
})

// ---------------------------------------------------------------------------
// Species Metrics module
// ---------------------------------------------------------------------------
const speciesMetrics = require('../species-metrics')

describe('Species Metrics module', function () {
    const testBedFile = path.join(__dirname, 'data', 'test_kraken2_spans.bed')

    afterEach(function () {
        speciesMetrics.clearCache()
    })

    describe('readBedFile', function () {
        it('reads plain text BED file', function () {
            const rows = speciesMetrics.readBedFile(testBedFile)
            expect(rows).to.be.an('array')
            expect(rows.length).to.equal(10) // 10 data rows
            expect(rows[0][0]).to.equal('chr1') // chrom of first row
        })

        it('skips header lines starting with #', function () {
            const rows = speciesMetrics.readBedFile(testBedFile)
            // The test file has a #header line – should be excluded
            rows.forEach(r => expect(r[0]).to.not.match(/^#/))
        })

        it('returns empty array for non-existent file', function () {
            const rows = speciesMetrics.readBedFile('/nonexistent/path.bed')
            expect(rows).to.be.an('array')
            expect(rows).to.have.length(0)
        })

        it('returns empty array for null path', function () {
            const rows = speciesMetrics.readBedFile(null)
            expect(rows).to.have.length(0)
        })
    })

    describe('parseBedByVariant', function () {
        it('indexes BED rows by variant key', function () {
            const variantMap = speciesMetrics.parseBedByVariant(testBedFile)
            expect(variantMap).to.be.instanceOf(Map)
            expect(variantMap.size).to.be.greaterThan(0)

            // Check that the first variant key has rows
            const key1 = 'chr1:12344:A:G'
            expect(variantMap.has(key1)).to.be.true
            const rows = variantMap.get(key1)
            expect(rows).to.be.an('array')
            expect(rows.length).to.equal(5) // 4 primary + 1 supplementary
        })

        it('caches results for the same file', function () {
            const map1 = speciesMetrics.parseBedByVariant(testBedFile)
            const map2 = speciesMetrics.parseBedByVariant(testBedFile)
            expect(map1).to.equal(map2)
        })

        it('parses row fields correctly', function () {
            const variantMap = speciesMetrics.parseBedByVariant(testBedFile)
            const rows = variantMap.get('chr1:12344:A:G')
            const r0 = rows[0]
            expect(r0.chrom).to.equal('chr1')
            expect(r0.start).to.equal(12300)
            expect(r0.end).to.equal(12450)
            expect(r0.taxonName).to.equal('Escherichia_coli')
            expect(r0.domain).to.equal('Bacteria')
            expect(r0.guardStatus).to.equal('PASS')
            expect(r0.isNonhuman).to.be.true
            expect(r0.readName).to.equal('read001')
            expect(r0.readSet).to.equal('DKA')
            expect(r0.mapq).to.equal(60)
        })
    })

    describe('computeVariantMetrics', function () {
        it('computes metrics for a set of rows', function () {
            const variantMap = speciesMetrics.parseBedByVariant(testBedFile)
            const rows = variantMap.get('chr1:12344:A:G')
            const metrics = speciesMetrics.computeVariantMetrics(rows)

            expect(metrics.totalReads).to.equal(4) // 4 primary reads (excludes supplementary)
            expect(metrics.nonhumanReads).to.equal(1) // only read001 has isNonhuman=true
            expect(metrics.nonhumanFraction).to.equal(0.25)
            expect(metrics.assessment.label).to.equal('high') // 25% > 15%
            expect(metrics.domainCounts).to.have.property('Bacteria')
            expect(metrics.domainCounts).to.have.property('Human')
            expect(metrics.topTaxa).to.be.an('array')
            expect(metrics.readSetCounts.DKA).to.be.greaterThan(0)
            expect(metrics.splitReadCount).to.equal(1)
        })

        it('handles empty rows', function () {
            const metrics = speciesMetrics.computeVariantMetrics([])
            expect(metrics.totalReads).to.equal(0)
            expect(metrics.nonhumanFraction).to.equal(0)
            expect(metrics.assessment.label).to.equal('clean')
        })

        it('handles null input', function () {
            const metrics = speciesMetrics.computeVariantMetrics(null)
            expect(metrics.totalReads).to.equal(0)
        })
    })

    describe('classifyContamination', function () {
        it('classifies clean samples', function () {
            expect(speciesMetrics.classifyContamination(0).label).to.equal('clean')
            expect(speciesMetrics.classifyContamination(0.01).label).to.equal('clean')
        })

        it('classifies boundary value at 2% as clean', function () {
            expect(speciesMetrics.classifyContamination(0.02).label).to.equal('clean')
        })

        it('classifies caution samples', function () {
            expect(speciesMetrics.classifyContamination(0.03).label).to.equal('caution')
        })

        it('classifies boundary value at 5% as caution', function () {
            expect(speciesMetrics.classifyContamination(0.05).label).to.equal('caution')
        })

        it('classifies concern samples', function () {
            expect(speciesMetrics.classifyContamination(0.08).label).to.equal('concern')
        })

        it('classifies boundary value at 15% as concern', function () {
            expect(speciesMetrics.classifyContamination(0.15).label).to.equal('concern')
        })

        it('classifies high contamination', function () {
            expect(speciesMetrics.classifyContamination(0.20).label).to.equal('high')
            expect(speciesMetrics.classifyContamination(0.16).label).to.equal('high')
        })
    })

    describe('getVariantMetrics', function () {
        it('returns metrics for a known variant', function () {
            const metrics = speciesMetrics.getVariantMetrics('chr1:12344:A:G', [testBedFile])
            expect(metrics.totalReads).to.equal(4)
            expect(metrics.nonhumanReads).to.equal(1)
        })

        it('returns empty metrics for unknown variant', function () {
            const metrics = speciesMetrics.getVariantMetrics('chrX:99999:A:T', [testBedFile])
            expect(metrics.totalReads).to.equal(0)
        })

        it('handles non-existent BED file gracefully', function () {
            const metrics = speciesMetrics.getVariantMetrics('chr1:12344:A:G', ['/nonexistent.bed'])
            expect(metrics.totalReads).to.equal(0)
        })
    })

    describe('getGlobalSummary', function () {
        it('returns summary across all variants', function () {
            const summary = speciesMetrics.getGlobalSummary([testBedFile])
            expect(summary.totalReads).to.be.greaterThan(0)
            expect(summary.variantCount).to.equal(3) // 3 unique variant keys
            expect(summary.domainCounts).to.have.property('Bacteria')
            expect(summary.domainCounts).to.have.property('Human')
        })

        it('returns empty summary for non-existent files', function () {
            const summary = speciesMetrics.getGlobalSummary(['/nonexistent.bed'])
            expect(summary.totalReads).to.equal(0)
            expect(summary.variantCount).to.equal(0)
        })
    })
})

// ---------------------------------------------------------------------------
// Species Metrics API
// ---------------------------------------------------------------------------

describe('API /api/species-metrics', function () {
    it('returns not-loaded when no BED tracks configured', async function () {
        const res = await request(app).get('/api/species-metrics').expect(200)
        expect(res.body).to.have.property('loaded', false)
        expect(res.body).to.have.property('message').that.includes('BED track')
    })

    it('returns not-loaded for per-variant request without BED tracks', async function () {
        const res = await request(app).get('/api/species-metrics?variant_id=0').expect(200)
        expect(res.body).to.have.property('loaded', false)
    })

    it('returns 404 for non-existent variant', async function () {
        const res = await request(app).get('/api/species-metrics?variant_id=9999').expect(404)
        expect(res.body).to.have.property('error')
    })
})

// ---------------------------------------------------------------------------
// Gene Summary: impact-passing counts + annotation columns + Read Me tab
// ---------------------------------------------------------------------------
describe('Gene Summary impact counts and annotations', function () {
    // Collect a streamed binary (xlsx) response into a Buffer.
    function binaryParser(res, callback) {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => callback(null, Buffer.concat(chunks)))
    }

    after(function () {
        if (fs.existsSync(curationFile)) fs.unlinkSync(curationFile)
    })

    it('/api/summary exposes per-gene impact count fields', async function () {
        const res = await request(app).get('/api/summary').expect(200)
        const gene = res.body.summary[0]
        for (const k of ['passHigh', 'passMod', 'passLow', 'high', 'mod', 'low']) {
            expect(gene).to.have.property(k).that.is.a('number')
        }
    })

    it('/api/summary counts HIGH-impact variants passing review', async function () {
        // GENE2 has two HIGH-impact variants and no others in the example data.
        await request(app).put('/api/curate/gene').send({gene: 'GENE2', status: 'pass'}).expect(200)
        const res = await request(app).get('/api/summary').expect(200)
        const g2 = res.body.summary.find(g => g.gene === 'GENE2')
        expect(g2.high).to.equal(2)
        expect(g2.passHigh).to.equal(2)
        expect(g2.passMod).to.equal(0)
        expect(g2.passLow).to.equal(0)
        // Restore pending so later assertions about default state are unaffected.
        await request(app).put('/api/curate/gene').send({gene: 'GENE2', status: 'pending'}).expect(200)
    })

    it('xlsx Gene Summary includes Pass HIGH/MODERATE/LOW columns', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({variantIds: [0, 1, 2, 3, 4], exportConfig: {geneAnnotations: {enabled: false}}})
            .buffer(true).parse(binaryParser).expect(200)
        const wb = new ExcelJS.Workbook()
        await wb.xlsx.load(res.body)
        const header = wb.getWorksheet('Gene Summary').getRow(1).values
        expect(header).to.include.members(['Pass HIGH', 'Pass MODERATE', 'Pass LOW', 'Pass ALL'])
    })

    it('xlsx omits impact columns when passByImpact is off', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({variantIds: [0, 1, 2], exportConfig: {geneAnnotations: {enabled: false}, impactCounts: {passByImpact: false}}})
            .buffer(true).parse(binaryParser).expect(200)
        const wb = new ExcelJS.Workbook()
        await wb.xlsx.load(res.body)
        const header = wb.getWorksheet('Gene Summary').getRow(1).values
        expect(header).to.not.include('Pass HIGH')
    })

    it('xlsx Gene Summary includes ClinVar columns (offline provider)', async function () {
        this.timeout(10000)
        // MyGene fields off + gnomAD off ⇒ no network; ClinVar is a bundled file.
        const exportConfig = {geneAnnotations: {
            enabled: true, geneName: false, summary: false, omim: false, pathways: false, geneType: false,
            gnomadConstraint: {enabled: false}, clinvar: {enabled: true}, geneLists: {enabled: false}
        }}
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({variantIds: [0, 1, 2, 3, 4], exportConfig})
            .buffer(true).parse(binaryParser).expect(200)
        const wb = new ExcelJS.Workbook()
        await wb.xlsx.load(res.body)
        const header = wb.getWorksheet('Gene Summary').getRow(1).values
        expect(header).to.include.members(['ClinVar P', 'ClinVar LP', 'Has P/LP'])
        expect(header).to.not.include('Gene Name')
        expect(header).to.not.include('gnomAD pLI')
    })

    it('xlsx includes a Read Me data-dictionary sheet as the first tab', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({variantIds: [0, 1, 2], exportConfig: {geneAnnotations: {enabled: false}}})
            .buffer(true).parse(binaryParser).expect(200)
        const wb = new ExcelJS.Workbook()
        await wb.xlsx.load(res.body)
        expect(wb.worksheets[0].name).to.equal('Read Me')
        const rm = wb.getWorksheet('Read Me')
        const text = []
        rm.eachRow(r => r.eachCell(c => { if (c.value != null) text.push(String(c.value)) }))
        const joined = text.join(' | ')
        expect(joined).to.contain('Worksheets in this report')
        expect(joined).to.contain('Gene Summary')
        expect(joined).to.contain('Impact counts')
    })

    it('xlsx omits contamination columns when no --bed-tracks are configured', async function () {
        this.timeout(10000)
        // The example data has no kraken2 BED tracks, so contamination is a no-op.
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({variantIds: [0, 1, 2], exportConfig: {geneAnnotations: {enabled: false}}})
            .buffer(true).parse(binaryParser).expect(200)
        const wb = new ExcelJS.Workbook()
        await wb.xlsx.load(res.body)
        const header = wb.getWorksheet('Variants').getRow(1).values
        expect(header).to.not.include('Contamination')
        expect(header).to.not.include('Nonhuman %')
    })

    it('xlsx includes a Gene Analysis convergence sheet (offline dims)', async function () {
        this.timeout(10000)
        // constraint + ClinVar only (offline); domain off + MyGene columns off ⇒ no network.
        const exportConfig = {
            geneAnnotations: {
                enabled: true, geneName: false, summary: false, omim: false, pathways: false, geneType: false,
                gnomadConstraint: {enabled: true}, clinvar: {enabled: true}, geneLists: {enabled: false}
            },
            geneAnalysis: {enabled: true, domain: false}
        }
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({variantIds: [0, 1, 2, 3, 4], exportConfig})
            .buffer(true).parse(binaryParser).expect(200)
        const wb = new ExcelJS.Workbook()
        await wb.xlsx.load(res.body)
        const ga = wb.getWorksheet('Gene Analysis (DNMs)')
        expect(ga, 'Gene Analysis (DNMs) sheet present').to.not.be.undefined
        const text = []
        ga.eachRow(r => r.eachCell(c => { if (c.value != null) text.push(String(c.value)) }))
        const joined = text.join(' | ')
        expect(joined).to.contain('CUMULATIVE impact tiers')   // the pass-tier matrix method note
        expect(joined).to.contain('% all genes')               // the per-source prevalence column
        expect(joined).to.contain('Fold (pass·ALL)')           // the headline fold column
        expect(joined).to.contain('P(X≥k)')                    // the derivation column header
        expect(joined).to.contain('BINOMDIST')                 // the live-formula derivation banner
    })

    it('the SAMPLE track builds a "Gene Analysis (samples)" tab wired to proband counts', function () {
        // The samples tab is only emitted end-to-end when the data has a sample
        // column (the fixtures lack one), so drive the exported builder directly
        // with a real ExcelJS worksheet to cover its unit/fold/q wiring.
        const {computeConvergence} = require('../gene-analysis')
        const {buildGeneAnalysisTab, GA_SAMPLE_TRACK} = require('../server')
        const conv = computeConvergence(
            [{gene: 'G1', s: 'P1', impact: 'HIGH', curation_status: 'pass'},
             {gene: 'G2', s: 'P2', impact: 'HIGH', curation_status: 'pass'}],
            {geneCol: 'gene', impactCol: 'impact', sampleCol: 's', minCount: 2,
                geneTerms: new Map([['G1', {fam: ['T']}], ['G2', {fam: ['T']}]]),
                dimensions: [{id: 'fam', label: 'Fam'}],
                sourceUniverse: {fam: {size: 100, counts: {T: 10}}}, totalProbands: 20})
        conv.probandsWithVariant = 2
        expect(conv.hasSamples).to.equal(true)

        const wb = new ExcelJS.Workbook()
        const styles = {headerFill: {}, headerFont: {}, borderThin: {}}
        buildGeneAnalysisTab(wb, conv, styles, GA_SAMPLE_TRACK)
        const ws = wb.getWorksheet('Gene Analysis (samples)')
        expect(ws, 'samples tab created').to.not.be.undefined

        const text = []
        ws.eachRow(r => r.eachCell(c => { if (c.value != null) text.push(String(c.value)) }))
        const joined = text.join(' | ')
        expect(joined).to.contain('SAMPLE convergence')          // the conservative-track banner
        expect(joined).to.contain('distinct PASS probands')      // the sample unit
        // The header row + a data row for category T with the pass·ALL cell = "2 (q)".
        const hdr = []
        let dataRow = null
        ws.eachRow(r => {
            const first = r.getCell(1).value
            if (first === 'Category') r.eachCell(c => hdr.push(String(c.value)))
            if (first === 'T') dataRow = r
        })
        expect(hdr).to.include.members(['Category', 'pass·ALL', 'all·ALL', 'Fold (pass·ALL)', 'ALL p/q',
            'p (prev)', 'k probands (ALL)', 'n at-risk (ALL)', 'Expected Σpᵢ (ALL)', 'P(X≥k) approx (ALL)'])
        expect(dataRow, 'data row for T').to.not.be.null
        // Pass-tier cell = "count (% of cohort) ✓" — 2 probands, 10% of 20, q=0.01<0.05.
        const passAllCol = hdr.indexOf('pass·ALL') + 1
        expect(String(dataRow.getCell(passAllCol).value)).to.equal('2 (10%) ✓')
        // Fold = observed ÷ expected-under-the-null. Σpᵢ = 0.2 (2 probands, burden 1, p=0.1)
        // ⇒ 2/0.2 = 10×, consistent with this row's own q=0.010. The old form printed "1.0×"
        // — i.e. "exactly chance" — next to a significant q, which is a contradiction.
        const foldCol = hdr.indexOf('Fold (pass·ALL)') + 1
        expect(String(dataRow.getCell(foldCol).value)).to.equal('10×')
        // Exact stats moved off to the right: p / q for the ALL tier.
        const pqCol = hdr.indexOf('ALL p/q') + 1
        expect(String(dataRow.getCell(pqCol).value)).to.equal('0.010 / 0.010')
        // Derivation columns: exact inputs + a LIVE Excel formula, for the ALL tier.
        expect(dataRow.getCell(hdr.indexOf('p (prev)') + 1).value).to.be.closeTo(0.1, 1e-9)
        expect(dataRow.getCell(hdr.indexOf('k probands (ALL)') + 1).value).to.equal(2)     // probands hitting
        expect(dataRow.getCell(hdr.indexOf('n at-risk (ALL)') + 1).value).to.equal(2)      // probands with a pass DNM
        // No derivRefs passed here ⇒ Expected falls back to the plain number (0.1 + 0.1).
        expect(dataRow.getCell(hdr.indexOf('Expected Σpᵢ (ALL)') + 1).value).to.be.closeTo(0.2, 1e-9)
        const pFormula = dataRow.getCell(hdr.indexOf('P(X≥k) approx (ALL)') + 1).value
        expect(pFormula).to.be.an('object')                          // exceljs formula cell
        expect(pFormula.formula).to.match(/^1-BINOMDIST\(.*TRUE\)$/)  // live, reproducible
        expect(pFormula.result).to.be.closeTo(0.01, 1e-9)            // binom(2,2,0.1)=0.1²

        // EVERY tier is derivable, not just ALL — the point of the per-tier block.
        for (const t of ['HIGH', 'HIGH+MOD', 'HIGH+MOD+LOW', 'ALL']) {
            for (const lbl of [`k probands (${t})`, `n at-risk (${t})`, `Expected Σpᵢ (${t})`, `P(X≥k) approx (${t})`]) {
                expect(hdr, `missing derivation column ${lbl}`).to.include(lbl)
            }
        }
        // Header labels must be UNIQUE — the sheet is read by column name.
        expect(new Set(hdr).size, 'duplicate header labels').to.equal(hdr.length)
    })

    it('the derivation sheet publishes a burden histogram that reproduces the exact sample p-value', function () {
        const {computeConvergence, poissonBinomUpperTail} = require('../gene-analysis')
        const {buildGaDerivationSheet, buildGeneAnalysisTab, GA_SAMPLE_TRACK} = require('../server')
        // A1 column letter (for asserting formula addresses).
        const colLetterFor = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) } return s }
        // P1 carries 2 pass DNMs, P2 carries 1 → a non-uniform burden, which is exactly
        // the case a plain binomial cannot represent and the histogram must capture.
        // G2 is MODIFIER so it counts ONLY in the ALL tier — that makes HIGH and ALL
        // numerically DIFFERENT, without which a per-tier bug (e.g. every tier reading the
        // HIGH columns) would pass unnoticed.
        const conv = computeConvergence(
            [{gene: 'G1', s: 'P1', impact: 'HIGH', curation_status: 'pass'},
             {gene: 'G2', s: 'P1', impact: 'MODIFIER', curation_status: 'pass'},
             {gene: 'G3', s: 'P2', impact: 'HIGH', curation_status: 'pass'}],
            {geneCol: 'gene', impactCol: 'impact', sampleCol: 's', minCount: 2,
                geneTerms: new Map([['G1', {fam: ['T']}], ['G2', {fam: ['T']}], ['G3', {fam: ['T']}]]),
                dimensions: [{id: 'fam', label: 'Fam'}],
                sourceUniverse: {fam: {size: 100, counts: {T: 10}}}, totalProbands: 20})

        // Each SECTION must expose its own histogram — it is the sample test's hidden
        // input, and it is per-dimension because each dimension's trials are gated to
        // its own gene universe. Assert the section's copy, not the cohort-wide one:
        // that is what the derivation sheet publishes and what every p-value uses.
        // (This fixture's background has no `genes` set, so the trials are ungated and
        // the two coincide — which is exactly why the assertion must name the one the
        // sheet reads, or it would keep passing after the sheet started reading another.)
        const sec = conv.sections[0]
        expect(sec.burdenHistByTier, 'per-section burdenHistByTier returned').to.be.an('object')
        expect(sec.burdenHistByTier.ALL).to.deep.equal({1: 1, 2: 1})   // P2 has 1, P1 has 2 (incl. MODIFIER)
        expect(sec.burdenHistByTier.HIGH).to.deep.equal({1: 2})        // MODIFIER excluded ⇒ P1:1, P2:1
        expect(sec.nDnmsByTier.HIGH).to.equal(2)
        expect(sec.nDnmsByTier.ALL).to.equal(3)

        const wb = new ExcelJS.Workbook()
        const styles = {headerFill: {}, headerFont: {}, borderThin: {}}
        const passCells = conv.cells.filter(c => c.statusKey === 'pass')
        const refs = buildGaDerivationSheet(wb, conv, styles, passCells)
        expect(refs, 'derivation refs').to.not.be.null
        const dws = wb.getWorksheet('Gene Analysis (derivation)')
        expect(dws, 'derivation sheet created').to.not.be.undefined

        // The histogram is PER DIMENSION (each dimension's trials are gated to its own
        // gene universe), so the refs are keyed by dimension id — using another
        // dimension's block would reproduce nobody's p-value.
        const fam = refs.byDim[sec.id]
        expect(fam, `derivation block for "${sec.id}"`).to.not.be.undefined
        // The published histogram rows must re-sum to THIS dimension's denominators.
        const dCol = fam.dCol, aCol = fam.tierCol.ALL
        let probands = 0, dnms = 0
        for (let r = fam.firstRow; r <= fam.lastRow; r++) {
            const d = dws.getRow(r).getCell(dCol).value
            const n = dws.getRow(r).getCell(aCol).value
            probands += n; dnms += d * n
        }
        expect(probands, 'histogram sums to this dimension\'s at-risk probands').to.equal(sec.nProbandsByTier.ALL)
        expect(dnms, 'Σ dᵢ·n_d sums to this dimension\'s gated pass variants').to.equal(sec.nDnmsByTier.ALL)

        // THE CLAIM: histogram + p reproduces the reported exact p-value.
        const g = sec.groups[0]
        const p = g.prevalence
        const burden = []
        for (let r = fam.firstRow; r <= fam.lastRow; r++) {
            const d = dws.getRow(r).getCell(dCol).value
            for (let i = 0; i < dws.getRow(r).getCell(aCol).value; i++) burden.push(d)
        }
        const reproduced = poissonBinomUpperTail(g.cells['pass|ALL'].individuals, burden.map(d => 1 - Math.pow(1 - p, d)))
        expect(reproduced, 'reproduced == reported pSample').to.be.closeTo(g.cells['pass|ALL'].pSample, 1e-12)

        // And Expected Σpᵢ becomes a live SUMPRODUCT over those very cells.
        buildGeneAnalysisTab(wb, conv, styles, GA_SAMPLE_TRACK, refs)
        const ws = wb.getWorksheet('Gene Analysis (samples)')
        const hdr = []
        let dataRow = null
        ws.eachRow(r => { const f = r.getCell(1).value; if (f === 'Category') r.eachCell(c => hdr.push(String(c.value))); if (f === 'T') dataRow = r })
        const eCell = dataRow.getCell(hdr.indexOf('Expected Σpᵢ (ALL)') + 1).value
        expect(eCell, 'Expected is a live formula').to.be.an('object')
        expect(eCell.formula).to.contain('SUMPRODUCT')
        expect(eCell.formula).to.contain("'Gene Analysis (derivation)'!")
        expect(eCell.result).to.be.closeTo(g.cells['pass|ALL'].expSample, 1e-12)
        // Σ_d n_d·[1-(1-p)^d] == the engine's expectation.
        const manual = burden.reduce((s, d) => s + (1 - Math.pow(1 - p, d)), 0)
        expect(eCell.result).to.be.closeTo(manual, 1e-12)

        // Each tier must be derived from ITS OWN inputs. HIGH excludes the MODIFIER DNM,
        // so its Expected/n genuinely differ from ALL — if every tier read one tier's
        // columns (or one tier's histogram), these would collide.
        const cellVal = (lbl) => dataRow.getCell(hdr.indexOf(lbl) + 1).value
        // n is the DIMENSION's gated at-risk count — not the cohort-wide total.
        expect(cellVal('n at-risk (HIGH)')).to.equal(sec.nProbandsByTier.HIGH)
        const eHigh = cellVal('Expected Σpᵢ (HIGH)')
        expect(eHigh.result).to.be.closeTo(g.cells['pass|HIGH'].expSample, 1e-12)
        expect(eHigh.result, 'HIGH Expected must differ from ALL').to.not.be.closeTo(eCell.result, 1e-9)
        // …and each tier's SUMPRODUCT must read its OWN histogram column, in ITS OWN
        // dimension's block (the blocks are per-dimension now).
        expect(eHigh.formula).to.contain(`$${colLetterFor(fam.tierCol.HIGH)}$${fam.firstRow}`)
        expect(eCell.formula).to.contain(`$${colLetterFor(fam.tierCol.ALL)}$${fam.firstRow}`)
        expect(eHigh.formula).to.not.equal(eCell.formula)

        // The live P(X≥k) formula must reference THAT tier's own k / n cells — a bug that
        // pointed every tier at HIGH's columns would still produce a correct cached
        // .result, so assert the addresses, not just the numbers.
        for (const t of ['HIGH', 'HIGH+MOD', 'HIGH+MOD+LOW', 'ALL']) {
            const P = cellVal(`P(X≥k) approx (${t})`)
            if (!P || typeof P !== 'object') continue
            const kL = colLetterFor(hdr.indexOf(`k probands (${t})`) + 1)
            const nL = colLetterFor(hdr.indexOf(`n at-risk (${t})`) + 1)
            expect(P.formula, `P(X≥k) (${t}) must use its own k/n columns`)
                .to.contain(`${kL}${dataRow.number}-1,${nL}${dataRow.number}`)
        }
    })

    it('BOTH Test B tab builders RUN — every branch, no ReferenceError', function () {
        // This exists because a bad range-delete removed colLetter/FMT_*/fmtP/fmtR from
        // buildDnmRateCategoryTab and shipped: the file still PARSED, so a syntax check
        // could not see it, and the failure only appeared as a ReferenceError at runtime.
        // Six tests broke on one deleted helper. Smoke-run every branch of both builders.
        const {buildDnmRateCategoryTab, buildDnmRatePerGeneTab} = require('../server')
        const styles = {headerFill: {}, headerFont: {}, borderThin: {}}
        const cell = (x) => Object.assign({k: 3, kSyn: 1, T: 4, lambda: 0.01, catMu: 5e-5,
            catMuSyn: 3e-4, theta: 0.14, p: 1e-6, q: 1e-5, pCond: 1e-4, qCond: 1e-3}, x)
        const base = () => ({
            meta: {model: 'de_novo', N: 220, nReliable: true, nUsed: 4, nDistinctProbands: 3,
                exclIndel: 1, exclXY: 1, exclNonCoding: 2, exclNoMu: 1, exclNoClassMu: 1,
                byClass: {nonSplice: 3, mis: 0, syn: 20}, rateGenes: 18541,
                totalP: {nonSplice: 0.0257, mis: 0.352, syn: 0.159},
                classifiedVia: {consequence: 4, impact: 0},
                unmodelledTerms: {intron_variant: 5, splice_region_variant: 3},
                calibration: {syn: {obs: 20, exp: 70.0, ratio: 0.286}, mis: {obs: 0, exp: 154.9, ratio: 0},
                    nonSplice: {obs: 3, exp: 11.3, ratio: 0.265}, synRelSe: 0.22}},
            perCategory: {tiers: [{key: 'HIGH', label: 'nonsense+splice', classes: ['nonSplice']},
                    {key: 'HIGH_MOD', label: 'nonsense+splice+missense', classes: ['nonSplice', 'mis']}],
                sections: [{id: 'fam', label: 'Fam', muSource: true, m: 20, mCond: 20, groups: [
                    {term: 'T', probands: 3, genes: ['A', 'B', 'C'], kTop: 3,
                        cells: {HIGH: cell({}), HIGH_MOD: cell({})}}]}]},
            perGene: {tracks: [{key: 'lof', label: 'nonsense+splice (SNV)', classes: ['nonSplice'], discovery: true},
                    {key: 'syn', label: 'synonymous (calibrator)', classes: ['syn'], discovery: false}],
                rows: [{gene: 'TSC2', track: 'lof', trackLabel: 'nonsense+splice (SNV)', discovery: true,
                    k: 2, mu: 4.17e-6, lambda: 2 * 220 * 4.17e-6, p: 5e-7, q: 1e-4,
                    constraint: {loeuf: 0.21, pli: 0.99}}],
                familySizes: {lof: 18000, syn: 18000}, observedRows: {lof: 1, syn: 0}}
        })
        const withMeta = (over) => { const d = base(); Object.assign(d.meta, over); return d }
        // Every branch of both builders must simply RUN.
        for (const [name, dnm] of [
            ['reliable N', base()],
            ['provisional N', withMeta({nReliable: false})],
            ['IMPACT fallback', withMeta({classifiedVia: {consequence: 0, impact: 4}})],
            ['no unmodelled terms', withMeta({unmodelledTerms: {}})],
        ]) {
            expect(() => buildDnmRateCategoryTab(new ExcelJS.Workbook(), dnm, styles), `category: ${name}`).to.not.throw()
            expect(() => buildDnmRatePerGeneTab(new ExcelJS.Workbook(), dnm, styles), `per-gene: ${name}`).to.not.throw()
        }
        const empty = base(); empty.perCategory.sections = []; empty.perGene.rows = []
        expect(() => buildDnmRateCategoryTab(new ExcelJS.Workbook(), empty, styles), 'category: empty').to.not.throw()
        expect(() => buildDnmRatePerGeneTab(new ExcelJS.Workbook(), empty, styles), 'per-gene: empty').to.not.throw()
        const noCon = base(); noCon.perGene.rows[0].constraint = null
        expect(() => buildDnmRatePerGeneTab(new ExcelJS.Workbook(), noCon, styles), 'per-gene: no constraint').to.not.throw()

        // …and the per-gene headers must align with the column map, carrying BOTH axes.
        const wb = new ExcelJS.Workbook()
        buildDnmRatePerGeneTab(wb, base(), styles)
        const ws = wb.getWorksheet('DNM Rate (per-gene)')
        let hdr = [], row = null
        ws.eachRow(r => { const f = r.getCell(1).value
            if (f === 'Gene') r.eachCell(c => hdr.push(String(c.value)))
            if (/^TSC2/.test(String(f))) row = r })
        expect(hdr).to.deep.equal(['Gene', 'k (de novo variants)', 'p (rate)', 'λ = 2·N·p', 'P(X≥k)', 'q', 'K (cohort)', 'π = p/Σp(exome)', 'P(X≥k | K)', 'q (share)', 'LOEUF', 'pLI', 'Constrained?'])
        // The second axis lands in the right cells: surprise (λ, p) and constraint, side by side.
        expect(row.getCell(hdr.indexOf('LOEUF') + 1).value).to.equal(0.21)
        expect(row.getCell(hdr.indexOf('pLI') + 1).value).to.equal(0.99)
        expect(row.getCell(hdr.indexOf('Constrained?') + 1).value).to.equal('Yes')
    })

    it('BOTH rate tables ship, agree, and the cross-check columns land under their own headers', function () {
        // "Report both" only means anything if the second table is REALLY there and REALLY
        // independent. And inserting two columns mid-table is exactly how a hardcoded index
        // silently starts writing the gene list into the ratio column — so build the real
        // workbook and read the headers back rather than trusting the constants.
        const {computeModelEnrichment, categoryRateSums, DE_NOVO} = require('../dnm-enrichment')
        const {buildDnmRateCategoryTab, buildDnmRatePerGeneTab} = require('../server')
        const dnmRates = require('../dnm-rates')
        const dnw = dnmRates.getRates('denovowest'), mane = dnmRates.getRates('mane')
        expect(dnw.size, 'DeNovoWEST table bundled').to.be.greaterThan(15000)
        expect(mane.size, 'MANE/denovonear table bundled').to.be.greaterThan(15000)
        expect(dnmRates.availableTables(), 'both tables readable').to.include.members(['denovowest', 'mane'])
        // MYC is the concrete gene the MANE table rescues: DeNovoWEST leaves it rate-less (p_all=NA).
        expect(mane.has('MYC'), 'MANE has MYC').to.equal(true)
        expect(dnw.has('MYC'), 'DeNovoWEST does NOT (p_all=NA) — the gap the second table fills').to.equal(false)

        const fam = new Map([['TSC2', ['TSC complex']]])
        const geneTerms = new Map([['TSC2', {fam: ['TSC complex']}]])
        const V = (o) => Object.assign({gene: 'TSC2', curation_status: 'pass', inheritance: 'de_novo', chrom: 'chr16'}, o)
        const variants = [
            V({Consequence: 'stop_gained', impact: 'HIGH', ref: 'C', alt: 'T', sample: 'P1'}),
            V({Consequence: 'frameshift_variant', impact: 'HIGH', ref: 'AT', alt: 'A', sample: 'P2'}),
            V({Consequence: 'synonymous_variant', impact: 'LOW', ref: 'G', alt: 'A', sample: 'P3'})
        ]
        const build = (withAlt) => computeModelEnrichment(variants, Object.assign({
            model: DE_NOVO, geneCol: 'gene', impactCol: 'impact', consequenceCol: 'Consequence',
            sampleCol: 'sample', chromCol: 'chrom', refCol: 'ref', altCol: 'alt', inheritanceCol: 'inheritance',
            geneTerms, dimensions: [{id: 'fam', label: 'Fam'}], muByGene: dnw,
            categoryMu: categoryRateSums(dnw, {}, {fam}, true), rateTable: dnmRates.describe('denovowest'),
            N: 220, nReliable: true, minCount: 1
        }, withAlt ? {altMuByGene: mane, altCategoryMu: categoryRateSums(mane, {}, {fam}, true),
            altTable: dnmRates.describe('mane')} : {}))

        const dnm = build(true)
        // The agreement is the POINT: same 2014 model, independently built on different
        // transcripts. If these ever drift far from 1, the workbook's central claim is false.
        const ag = dnm.meta.altTable.agreement
        for (const cls of ['syn', 'mis', 'nonSplice', 'lof']) {
            expect(ag[cls], `exome-wide ${cls} agreement (alt/primary) must be ~1`).to.be.within(0.9, 1.1)
        }

        const headersOf = (wb, tab, firstCell) => {
            const ws = wb.getWorksheet(tab)
            let hdr = null, dat = null
            ws.eachRow(rw => {
                const f = rw.getCell(1).value
                if (f === 'Category' || f === 'Gene') { hdr = []; rw.eachCell(c => hdr.push(String(c.value))) }
                const fv = typeof f === 'string' ? f.replace(' ✓', '') : f
                if (!dat && fv === firstCell) { dat = []; rw.eachCell({includeEmpty: true}, c => dat.push(c.value)) }
            })
            return {hdr, dat}
        }
        const styles = {headerFill: {}, headerFont: {}, borderThin: {}}

        for (const tab of [['DNM Rate (gene-set)', 'TSC complex'], ['DNM Rate (per-gene)', 'TSC2']]) {
            const wb = new ExcelJS.Workbook()
            buildDnmRateCategoryTab(wb, dnm, styles); buildDnmRatePerGeneTab(wb, dnm, styles)
            const {hdr, dat} = headersOf(wb, tab[0], tab[1])
            expect(hdr, `${tab[0]} has the cross-check columns`).to.include.members(['λ (cross-check)', 'λ ratio'])
            const iR = hdr.indexOf('λ ratio')
            // THE assertion: the ratio column must hold a ratio. A column-index bug puts the
            // gene list or a constraint value here, and a bare `to.exist` would not notice.
            expect(dat[iR], `${tab[0]} λ ratio value sits under its own header`).to.be.a('number')
            expect(dat[iR], `${tab[0]} λ ratio ~1 (the two tables agree on TSC2)`).to.be.within(0.9, 1.1)
            // …and the columns AFTER the insertion point must not have shifted under it.
            const last = tab[0].includes('per-gene') ? 'Constrained?' : 'Genes'
            expect(hdr[hdr.length - 1], `${tab[0]} last column still ${last}`).to.equal(last)
        }

        // With no alt table the columns vanish entirely and the layout closes up cleanly.
        const wb2 = new ExcelJS.Workbook()
        buildDnmRateCategoryTab(wb2, build(false), styles); buildDnmRatePerGeneTab(wb2, build(false), styles)
        for (const tab of [['DNM Rate (gene-set)', 'Genes'], ['DNM Rate (per-gene)', 'Constrained?']]) {
            const {hdr} = headersOf(wb2, tab[0], ' ')
            expect(hdr, `${tab[0]}: no alt table ⇒ no cross-check column`).to.not.include('λ (cross-check)')
            expect(hdr[hdr.length - 1], `${tab[0]}: layout closes up`).to.equal(tab[1])
        }
    })

    it('the DNM Rate tab builds with a live POISSON formula reproducing the Poisson engine (real rates)', function () {
        const {computeModelEnrichment, categoryRateSums, DE_NOVO, poissonUpperTail} = require('../dnm-enrichment')
        const {buildDnmRateCategoryTab} = require('../server')
        const gnomad = require('../providers/gnomad-provider')
        const dnmRates = require('../dnm-rates')
        const gnB = gnomad.getBundle()
        const rates = dnmRates.getRates()
        // The REAL rate table — per-transmission de novo probabilities, not gnomAD's
        // mutability covariate. TSC2 is autosomal and carries a rate for every class.
        expect(rates.size, 'rate bundle loaded').to.be.greaterThan(15000)
        expect(rates.get('TSC2') && rates.get('TSC2').pNonSplice, 'real rate present').to.be.a('number')
        // Two real pass de novo SNVs in TSC2, classified by molecular consequence.
        const fam = new Map([['TSC2', ['TSC complex']]])
        const geneTerms = new Map([['TSC2', {fam: ['TSC complex']}]])
        const variants = [
            {gene: 'TSC2', Consequence: 'stop_gained', impact: 'HIGH', curation_status: 'pass', inheritance: 'de_novo', ref: 'C', alt: 'T', chrom: 'chr16', sample: 'P1'},
            {gene: 'TSC2', Consequence: 'stop_gained', impact: 'HIGH', curation_status: 'pass', inheritance: 'de_novo', ref: 'G', alt: 'A', chrom: 'chr16', sample: 'P2'}
        ]
        const dnm = computeModelEnrichment(variants, {model: DE_NOVO, geneCol: 'gene', impactCol: 'impact',
            consequenceCol: 'Consequence', sampleCol: 'sample', chromCol: 'chrom', refCol: 'ref', altCol: 'alt',
            inheritanceCol: 'inheritance', geneTerms, dimensions: [{id: 'fam', label: 'Fam'}], muByGene: rates,
            categoryMu: categoryRateSums(rates, {gnomad: gnB}, {fam}, true), N: 100, nReliable: true, minCount: 1})
        // λ = 2·N·Σp with NO fitted scale — pin that ê has not come back.
        expect(dnm.meta.eApplied, 'no fitted scale').to.equal(undefined)
        expect(dnm.meta.nUsed).to.equal(2)
        const wb = new ExcelJS.Workbook()
        buildDnmRateCategoryTab(wb, dnm, {headerFill: {}, headerFont: {}, borderThin: {}})
        const ws = wb.getWorksheet('DNM Rate (gene-set)')
        expect(ws, 'DNM Rate tab created').to.not.be.undefined
        const hdr = []; let dataRow = null
        ws.eachRow(r => { const f = r.getCell(1).value; if (f === 'Category') r.eachCell(c => hdr.push(String(c.value))); if (f === 'TSC complex') dataRow = r })
        expect(hdr).to.include.members(['Category', 'LoF (nonsense+splice+frameshift)', 'LoF+missense', 'k (LoF+missense)', 'λ = 2·N·Σp', 'P(X≥k)'])
        expect(hdr).to.not.include('HIGH+MOD+LOW')                      // synonymous is the calibrator, never a discovery tier
        expect(dataRow, 'TSC complex row').to.not.be.null
        const kCell = dataRow.getCell(hdr.indexOf('k (LoF+missense)') + 1).value
        const lamCell = dataRow.getCell(hdr.indexOf('λ = 2·N·Σp') + 1).value
        const pCell = dataRow.getCell(hdr.indexOf('P(X≥k)') + 1).value
        expect(kCell).to.equal(2)
        expect(lamCell.formula).to.match(/^2\*100\*/)                    // λ = 2·N·Σμ live formula
        expect(pCell.formula).to.match(/^1-POISSON\(.*TRUE\)$/)          // live, reproducible
        expect(pCell.result).to.be.closeTo(poissonUpperTail(kCell, lamCell.result), 1e-12)

        // per-gene tab: same test at gene level (TSC2 nonsense), live POISSON reproduces the engine
        const {buildDnmRatePerGeneTab} = require('../server')
        const wb2 = new ExcelJS.Workbook()
        buildDnmRatePerGeneTab(wb2, dnm, {headerFill: {}, headerFont: {}, borderThin: {}})
        const pgws = wb2.getWorksheet('DNM Rate (per-gene)')
        expect(pgws, 'per-gene tab created').to.not.be.undefined
        const phdr = []; let tscRow = null
        pgws.eachRow(r => { const f = r.getCell(1).value; if (f === 'Gene') r.eachCell(c => phdr.push(String(c.value))); if (/^TSC2/.test(String(f))) tscRow = r })
        expect(phdr).to.deep.equal(['Gene', 'k (de novo variants)', 'p (rate)', 'λ = 2·N·p', 'P(X≥k)', 'q', 'K (cohort)', 'π = p/Σp(exome)', 'P(X≥k | K)', 'q (share)', 'LOEUF', 'pLI', 'Constrained?'])
        expect(tscRow, 'TSC2 row').to.not.be.null
        const pgP = tscRow.getCell(phdr.indexOf('P(X≥k)') + 1).value
        const pgLam = tscRow.getCell(phdr.indexOf('λ = 2·N·p') + 1).value
        expect(pgP.formula).to.match(/^1-POISSON\(.*TRUE\)$/)
        expect(pgP.result).to.be.closeTo(poissonUpperTail(tscRow.getCell(2).value, pgLam.result), 1e-12)
    })

    it('the DNM Rate tab withholds ✓ and warns when N is provisional (no Sample-QC)', function () {
        const {buildDnmRateCategoryTab} = require('../server')
        // Hand-built dnm result with a significant q but nReliable:false.
        const dnm = {meta: {model: 'de_novo', N: 5, nReliable: false, nUsed: 3, nDistinctProbands: 3,
                exclIndel: 0, exclXY: 0, exclNonCoding: 0, exclNoMu: 0, exclNoClassMu: 0,
                byClass: {nonSplice: 3, mis: 0, syn: 20}, rateGenes: 18000, totalP: {syn: 0.159},
                calibration: {syn: {obs: 20, exp: 20, ratio: 1}, mis: {}, nonSplice: {}, synRelSe: 0.22}},
            perCategory: {tiers: [{key: 'HIGH', label: 'HIGH', classes: ['nonSplice']}, {key: 'HIGH_MOD', label: 'HIGH+MOD', classes: ['nonSplice', 'mis']}],
                sections: [{id: 'fam', label: 'Fam', muSource: true, groups: [
                    {term: 'T', probands: 3, genes: ['A', 'B', 'C'], kTop: 3,
                        cells: {HIGH: {k: 3, lambda: 0.01, catMu: 5e-5, p: 1e-6, q: 1e-5}, HIGH_MOD: {k: 3, lambda: 0.02, catMu: 1e-4, p: 2e-6, q: 2e-5}}}]}]}}
        const wb = new ExcelJS.Workbook()
        buildDnmRateCategoryTab(wb, dnm, {headerFill: {}, headerFont: {}, borderThin: {}})
        const ws = wb.getWorksheet('DNM Rate (gene-set)')
        // banner warns provisional (the banner legend legitimately mentions "✓" — so check DATA cells, not banner text)
        let bannerText = '', hdr = [], dataRow = null
        ws.eachRow(r => {
            const f = r.getCell(1).value
            if (typeof f === 'string' && f.includes('PROVISIONAL')) bannerText = f
            if (f === 'Category') r.eachCell(c => hdr.push(String(c.value)))
            if (f === 'T') dataRow = r
        })
        expect(bannerText, 'provisional banner').to.contain('PROVISIONAL')
        expect(dataRow, 'T row').to.not.be.null
        // The Poisson q is <0.05, but N is provisional so λ is untrustworthy and the
        // Poisson CANNOT drive a ✓. The scale-free test could — it needs no N — but this
        // fixture gives it no qCond, so nothing earns a ✓ here.
        const highCell = String(dataRow.getCell(hdr.indexOf('HIGH') + 1).value)
        expect(highCell).to.equal('3')                                 // "3", not "3 ✓"
        expect(String(dataRow.getCell(hdr.indexOf('HIGH+MOD') + 1).value)).to.equal('3')
    })

    it('provisional N withholds ✓ — and now that gate MEANS something again', function () {
        // Under the retired fitted-ê design N cancelled out of λ entirely, so this gate was
        // gating on a mechanism that could not occur. With λ = 2·N·Σp, N is back in the
        // formula: a provisional N really does shrink λ and really does make p
        // anti-conservative. The scale-free q is printed but never drives ✓ — it is the
        // WEAKER test against curation skew, which is the hazard that actually threatens
        // this data.
        const {buildDnmRateCategoryTab} = require('../server')
        const cell = (extra) => Object.assign({k: 3, kSyn: 1, T: 4, lambda: 0.01, catMu: 5e-5,
            catMuSyn: 3e-4, theta: 0.14, p: 1e-6, q: 1e-5}, extra)
        const mk = (nReliable) => ({meta: {model: 'de_novo', N: 5, nReliable, nUsed: 4, nDistinctProbands: 3,
                exclIndel: 0, exclXY: 0, exclNonCoding: 0, exclNoMu: 0, exclNoClassMu: 0,
                byClass: {nonSplice: 3, mis: 0, syn: 20}, rateGenes: 18000, totalP: {syn: 0.159},
                calibration: {syn: {obs: 20, exp: 20, ratio: 1}, mis: {}, nonSplice: {}, synRelSe: 0.22}},
            perCategory: {tiers: [{key: 'HIGH', label: 'HIGH', classes: ['nonSplice']}, {key: 'HIGH_MOD', label: 'HIGH+MOD', classes: ['nonSplice', 'mis']}],
                sections: [{id: 'fam', label: 'Fam', muSource: true, m: 20, mCond: 20, groups: [
                    {term: 'T', probands: 3, genes: ['A', 'B', 'C'], kTop: 3,
                        cells: {HIGH: cell({pCond: 1e-4, qCond: 1e-3}), HIGH_MOD: cell({pCond: 2e-4, qCond: 2e-3})}}]}]},
            perGene: {rows: [], familySizes: {}, observedRows: {}}})
        const read = (dnm) => {
            const wb = new ExcelJS.Workbook()
            buildDnmRateCategoryTab(wb, dnm, {headerFill: {}, headerFont: {}, borderThin: {}})
            const ws = wb.getWorksheet('DNM Rate (gene-set)')
            let hdr = [], dataRow = null
            ws.eachRow(r => { const f = r.getCell(1).value
                if (f === 'Category') r.eachCell(c => hdr.push(String(c.value)))
                if (f === 'T') dataRow = r })
            return {hdr, dataRow}
        }
        // Provisional N: no ✓, even though BOTH q's are significant.
        const prov = read(mk(false))
        expect(String(prov.dataRow.getCell(prov.hdr.indexOf('HIGH') + 1).value)).to.equal('3')
        // Defensible N: the Poisson drives ✓.
        const ok = read(mk(true))
        expect(String(ok.dataRow.getCell(ok.hdr.indexOf('HIGH') + 1).value)).to.equal('3 ✓')
        // Both p/q pairs are still printed side by side either way.
        expect(ok.hdr).to.include.members(['HIGH p/q', 'HIGH p/q (scale-free)', 'θ', 'k syn', 'Σp syn'])
    })

    it('the λ formula IS the model — 2·N·Σp, reproducing the printed λ exactly', function () {
        // With no fitted scale there is nothing for the formula to omit: it prints the same
        // arithmetic the p-value used. (Under the retired ê design this cell emitted
        // 2*N*Σp beside a λ of 2*N*Σp*ê, so the sheet contradicted itself — the reason the
        // formula and the value are pinned together here.)
        const {buildDnmRateCategoryTab} = require('../server')
        const N = 100, SUMP = 5e-5
        const dnm = {meta: {model: 'de_novo', N, nReliable: true, nUsed: 4, nDistinctProbands: 3,
                exclIndel: 0, exclXY: 0, exclNonCoding: 0, exclNoMu: 0, exclNoClassMu: 0,
                byClass: {nonSplice: 3, mis: 0, syn: 20}, rateGenes: 18000, totalP: {syn: 0.159},
                calibration: {syn: {obs: 20, exp: 40, ratio: 0.5}, mis: {}, nonSplice: {}, synRelSe: 0.22}},
            perCategory: {tiers: [{key: 'HIGH', label: 'HIGH', classes: ['nonSplice']}],
                sections: [{id: 'fam', label: 'Fam', muSource: true, m: 20, mCond: 20, groups: [
                    {term: 'T', probands: 3, genes: ['A'], kTop: 3,
                        cells: {HIGH: {k: 3, kSyn: 1, T: 4, lambda: 2 * N * SUMP, catMu: SUMP, catMuSyn: 3e-4,
                            theta: 0.14, p: 1e-6, q: 1e-5, pCond: 0.5, qCond: 0.9}}}]}]},
            perGene: {rows: [], familySizes: {}, observedRows: {}}}
        const wb = new ExcelJS.Workbook()
        buildDnmRateCategoryTab(wb, dnm, {headerFill: {}, headerFont: {}, borderThin: {}})
        const ws = wb.getWorksheet('DNM Rate (gene-set)')
        let hdr = [], dataRow = null
        ws.eachRow(r => { const f = r.getCell(1).value
            if (f === 'Category') r.eachCell(c => hdr.push(String(c.value)))
            if (f === 'T') dataRow = r })
        const lam = dataRow.getCell(hdr.indexOf('λ = 2·N·Σp') + 1).value
        expect(lam.result).to.be.closeTo(2 * N * SUMP, 1e-15)
        // The formula must be exactly 2*N*<the Σp cell> — two factors, no third.
        expect(lam.formula).to.match(new RegExp(`^2\\*${N}\\*[A-Z]+\\d+$`))
        // θ is live and shows N is simply absent from it
        const th = dataRow.getCell(hdr.indexOf('θ') + 1).value
        expect(th.formula).to.not.contain(String(N))
        expect(th.result).to.equal(0.14)
    })

    it('Test B RUNS on a GRCh37/hg19 export — the rate table is build-independent', async function () {
        // This REVERSES the old behaviour, and the reason is that the old reason is gone.
        // Test B used to be suppressed here because λ came from gnomAD's μ, which is
        // GRCh38-only. λ now comes from a per-gene-symbol rate table (Samocha 2014 via
        // DeNovoWEST) that carries no coordinates at all — and if anything is GRCh37-native,
        // since DeNovoWEST's rates come from the DDD study. Suppressing on hg19 would now
        // be withholding a valid test for a reason that no longer exists.
        this.timeout(10000)
        const res = await request(app).post('/api/export/xlsx')
            .send({variantIds: [0, 1, 2, 3, 4], exportConfig: {genomeBuild: 'hg19',
                geneAnnotations: {enabled: true, geneName: false, summary: false, omim: false, pathways: false, geneType: false, gnomadConstraint: {enabled: false}, clinvar: {enabled: false}},
                geneAnalysis: {enabled: true, domain: false, dnmRateTest: true}}})
            .buffer(true).parse(binaryParser).expect(200)
        const wb = new ExcelJS.Workbook()
        await wb.xlsx.load(res.body)
        expect(wb.worksheets.map(w => w.name)).to.include.members(['DNM Rate (gene-set)', 'DNM Rate (per-gene)'])
    })

    it('...but the CONSTRAINT dimension gets no Σp without the matching gnomAD build', function () {
        // The one genuinely build-sensitive piece. getBundle() is v4.1/GRCh38, while a GRCh37
        // export takes its per-gene constraint TERMS from the live v2.1.1 API. Feeding the
        // v4.1 bundle to categoryRateSums would count a gene as LOEUF-constrained in Σp per
        // v4.1 while k counted it per v2.1.1 — numerator and denominator over different gene
        // sets. server.js therefore passes gnomad:null on GRCh37; this pins what that does.
        const {categoryRateSums} = require('../dnm-enrichment')
        const dnmRates = require('../dnm-rates')
        const gnomad = require('../providers/gnomad-provider')
        const rates = dnmRates.getRates()
        const withBundle = categoryRateSums(rates, {gnomad: gnomad.getBundle()}, {})
        const without = categoryRateSums(rates, {gnomad: null}, {})
        expect(withBundle.byDim.constraint, 'GRCh38: constraint IS tested').to.exist
        expect(without.byDim.constraint, 'GRCh37: constraint has no Σp ⇒ not tested').to.not.exist
        // The exome-wide target is unaffected — it comes from the rate table, not gnomAD —
        // so ê is still fitted and every other dimension still works on GRCh37.
        expect(without.total.syn).to.be.closeTo(withBundle.total.syn, 1e-12)
        expect(without.nGenes).to.equal(withBundle.nGenes)
    })

    it('xlsx emits the DNM Rate tab when explicitly opted in (inheritance column + rate bundle)', async function () {
        this.timeout(10000)
        const exportConfig = {geneAnnotations: {enabled: true, geneName: false, summary: false, omim: false, pathways: false, geneType: false},
            geneAnalysis: {enabled: true, domain: false, dnmRateTest: true}}
        const res = await request(app).post('/api/export/xlsx')
            .send({variantIds: [0, 1, 2, 3, 4], exportConfig})
            .buffer(true).parse(binaryParser).expect(200)
        const wb = new ExcelJS.Workbook()
        await wb.xlsx.load(res.body)
        const names = wb.worksheets.map(w => w.name)
        expect(names, names.join(',')).to.include.members(['DNM Rate (gene-set)', 'DNM Rate (per-gene)'])   // both tabs wired (placeholder genes ⇒ empty, but present)
    })

    // Test B is ON by default as of 2026-07-16. This guards the CONTRACT that turning it on
    // created: the tabs must appear, and the opt-OUT must still document itself rather than
    // leaving a reader to notice an absence. The old version of this test pinned the default to
    // false and justified it with the gnomAD-μ defect — a defect fixed long before the switch
    // flipped, which is exactly how a guard outlives its reason and starts asserting history.
    it('EVERY tier prints its own Σp, so every printed p can be checked by hand', function () {
        // The standard's second clause: a p-value a reader cannot reproduce from the workbook is
        // not a result, it is an assertion. The derivation block was bound to the TOP tier, so the
        // LoF row printed p/q — and could carry a ✓ — with none of its inputs. Σp was the only
        // one genuinely missing: k is the tier count column, Σp_syn is tier-independent, K per
        // tier is the Observed banner's per-class counts, and Σp(exome) per class is recoverable
        // from the MODEL FIT banner's expected counts (= 2·N·Σp_class).
        const {computeModelEnrichment, categoryRateSums, DE_NOVO} = require('../dnm-enrichment')
        const {buildDnmRateCategoryTab} = require('../server')
        const rates = new Map([['G1', {pSyn: 3e-6, pMis: 5e-6, pNonSplice: 1e-6, pLof: 2e-6, chr: '1'}]])
        const fam = new Map([['G1', ['T']]])
        const V = (o) => Object.assign({gene: 'G1', curation_status: 'pass', inheritance: 'de_novo', chrom: '1'}, o)
        const dnm = computeModelEnrichment([
            V({Consequence: 'stop_gained', ref: 'C', alt: 'T', sample: 's1'}),
            V({Consequence: 'missense_variant', ref: 'A', alt: 'G', sample: 's2'}),
            V({Consequence: 'synonymous_variant', ref: 'G', alt: 'A', sample: 's3'})
        ], {model: DE_NOVO, geneCol: 'gene', impactCol: 'impact', consequenceCol: 'Consequence',
            sampleCol: 'sample', chromCol: 'chrom', refCol: 'ref', altCol: 'alt', inheritanceCol: 'inheritance',
            geneTerms: new Map([['G1', {fam: ['T']}]]), dimensions: [{id: 'fam', label: 'Fam'}],
            muByGene: rates, categoryMu: categoryRateSums(rates, {}, {fam}, true),
            N: 220, nReliable: true, minCount: 1})

        const wb = new ExcelJS.Workbook()
        buildDnmRateCategoryTab(wb, dnm, {headerFill: {}, headerFont: {}, borderThin: {}})
        const ws = wb.getWorksheet('DNM Rate (gene-set)')
        let hdr = null, dat = null
        ws.eachRow(r => {
            const f = r.getCell(1).value
            if (!hdr && f === 'Category') { hdr = []; r.eachCell(c => hdr.push(String(c.value))) }
            if (!dat && f === 'T') { dat = []; r.eachCell({includeEmpty: true}, c => dat.push(c.value)) }
        })
        const tiers = dnm.perCategory.tiers
        // One Σp per tier, each under its OWN tier-named header — "Σp" alone did not say which.
        for (const t of tiers) {
            const i = hdr.indexOf(`Σp (${t.label})`)
            expect(i, `Σp column for tier "${t.label}" exists`).to.be.greaterThan(-1)
            expect(dat[i], `Σp (${t.label}) is a number under its own header`).to.be.a('number')
        }
        const iLof = hdr.indexOf(`Σp (${tiers[0].label})`)
        const iTop = hdr.indexOf(`Σp (${tiers[1].label})`)
        expect(dat[iLof], 'nested tiers: Σp(LoF) < Σp(LoF+missense)').to.be.lessThan(dat[iTop])

        // THE point: reproduce the LoF Poisson p from printed cells alone.
        const kLof = parseInt(String(dat[hdr.indexOf(tiers[0].label)]).replace(' ✓', ''), 10)
        const lam = 2 * 220 * dat[iLof]
        const pByHand = 1 - Math.exp(-lam)                       // k=1 ⇒ P(X≥1)
        const pPrinted = dnm.perCategory.sections[0].groups[0].cells[tiers[0].key].p
        expect(kLof, 'k(LoF) readable from the tier column').to.equal(1)
        expect(pByHand, 'hand-computed LoF p reproduces the engine to 1e-12').to.be.closeTo(pPrinted, 1e-12)
        expect(hdr[hdr.length - 1], 'the Genes column did not shift under the insert').to.equal('Genes')
    })

    it('every live formula uses a LEGACY Excel function name (no silent #NAME? column)', function () {
        // This shipped: BINOM.DIST wrote 264 live #NAME? cells — the entire share column — while
        // the POISSON column beside it worked, because POISSON is the pre-2007 name and needs no
        // prefix. Any function introduced after Excel 2007 must carry an `_xlfn.` prefix in the
        // OOXML, and ExcelJS does not add it. A workbook is a publication supplement: a column of
        // errors is worse than a missing column, because it looks like the data is broken.
        //
        // Drive the BUILDERS, not the HTTP export: the fixture has no sample column and its first
        // rows carry no modelable de novo, so an export produces no formula-bearing tab at all and
        // the scan would pass by finding nothing. (The first version of this test did exactly that
        // — its own non-vacuity assertion caught it.)
        const {computeModelEnrichment, categoryRateSums, DE_NOVO} = require('../dnm-enrichment')
        const {buildDnmRateCategoryTab, buildDnmRatePerGeneTab} = require('../server')
        const dnmRates = require('../dnm-rates')
        const dnw = dnmRates.getRates('denovowest')
        const fam = new Map([['TSC2', ['TSC complex']]])
        const V = (o) => Object.assign({gene: 'TSC2', curation_status: 'pass', inheritance: 'de_novo', chrom: 'chr16'}, o)
        const dnm = computeModelEnrichment([
            V({Consequence: 'stop_gained', impact: 'HIGH', ref: 'C', alt: 'T', sample: 'P1'}),
            V({Consequence: 'frameshift_variant', impact: 'HIGH', ref: 'AT', alt: 'A', sample: 'P2'}),
            V({Consequence: 'synonymous_variant', impact: 'LOW', ref: 'G', alt: 'A', sample: 'P3'})
        ], {model: DE_NOVO, geneCol: 'gene', impactCol: 'impact', consequenceCol: 'Consequence',
            sampleCol: 'sample', chromCol: 'chrom', refCol: 'ref', altCol: 'alt', inheritanceCol: 'inheritance',
            geneTerms: new Map([['TSC2', {fam: ['TSC complex']}]]), dimensions: [{id: 'fam', label: 'Fam'}],
            muByGene: dnw, categoryMu: categoryRateSums(dnw, {}, {fam}, true),
            rateTable: dnmRates.describe('denovowest'), N: 220, nReliable: true, minCount: 1})

        const wb = new ExcelJS.Workbook()
        buildDnmRateCategoryTab(wb, dnm, {headerFill: {}, headerFont: {}, borderThin: {}})
        buildDnmRatePerGeneTab(wb, dnm, {headerFill: {}, headerFont: {}, borderThin: {}})

        // Pre-2007 names only. Extend deliberately — and if a modern name is ever genuinely
        // needed, it must be written WITH the _xlfn. prefix, not added to this list.
        const LEGACY = new Set(['SUM', 'SUMPRODUCT', 'POISSON', 'BINOMDIST', 'IF', 'ROUND', 'MIN', 'MAX', 'ABS', 'EXP', 'LN', 'LOG'])
        const seen = new Set(); const bad = []
        for (const ws of wb.worksheets) {
            ws.eachRow(row => row.eachCell({includeEmpty: false}, cell => {
                const v = cell.value
                const f = (v && typeof v === 'object' && v.formula) ? v.formula : null
                if (!f) return
                for (const m of String(f).matchAll(/([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)) {
                    seen.add(m[1])
                    if (!LEGACY.has(m[1]) && !m[1].startsWith('_xlfn.')) bad.push(`${ws.name}!${cell.address} -> ${m[1]}()`)
                }
            }))
        }
        // Non-vacuity: the tabs really do emit the live formulas this rule governs.
        expect(seen.size, 'live formulas were emitted').to.be.greaterThan(0)
        expect([...seen], 'both tails are live: the Poisson AND the share binomial').to.include.members(['POISSON', 'BINOMDIST'])
        expect(bad, `non-legacy function names ship as #NAME? in Excel: ${bad.slice(0, 6).join(', ')}`).to.deep.equal([])
        // The specific regression: the dotted 2010 name must never come back.
        expect([...seen].filter(f => f.includes('.') && !f.startsWith('_xlfn.')),
            'a dotted (post-2007) name with no _xlfn. prefix').to.deep.equal([])
    })

    it('Test B is ON by default, and opting OUT still documents itself', async function () {
        this.timeout(20000)
        const {DEFAULT_EXPORT_CONFIG} = require('../export-config')
        expect(DEFAULT_EXPORT_CONFIG.geneAnalysis.dnmRateTest, 'default is ON').to.equal(true)
        const base = {geneAnnotations: {enabled: true, geneName: false, summary: false, omim: false, pathways: false, geneType: false},
            geneAnalysis: {enabled: true, domain: false}}

        // ON (the default): the tabs are there.
        const on = await request(app).post('/api/export/xlsx')
            .send({variantIds: [0, 1, 2, 3, 4], exportConfig: base})
            .buffer(true).parse(binaryParser).expect(200)
        const wbOn = new ExcelJS.Workbook()
        await wbOn.xlsx.load(on.body)
        const namesOn = wbOn.worksheets.map(w => w.name)
        expect(namesOn, namesOn.join(',')).to.include.members(['DNM Rate (gene-set)', 'DNM Rate (per-gene)'])
        // …and the Read Me documents all THREE tests, not just the Poisson. A row naming only
        // one of them would leave two families of q-values on the sheet unexplained.
        const rmOn = wbOn.getWorksheet('Read Me')
        let threeRow = null
        rmOn.eachRow(r => { if (String(r.getCell(1).value || '').includes('Three tests')) threeRow = r })
        expect(threeRow, 'Read Me documents the three tests').to.not.be.null
        const tn = String(threeRow.getCell(2).value)
        for (const frag of ['Poisson', 'scale-free', 'share', 'SEPARATE Benjamini-Hochberg families']) {
            expect(tn, `three-tests row names ${frag}`).to.include(frag)
        }

        // OFF (explicit opt-out): no tabs, and the Read Me says why rather than going silent.
        const off = await request(app).post('/api/export/xlsx')
            .send({variantIds: [0, 1, 2, 3, 4],
                exportConfig: Object.assign({}, base, {geneAnalysis: Object.assign({}, base.geneAnalysis, {dnmRateTest: false})})})
            .buffer(true).parse(binaryParser).expect(200)
        const wbOff = new ExcelJS.Workbook()
        await wbOff.xlsx.load(off.body)
        const namesOff = wbOff.worksheets.map(w => w.name)
        expect(namesOff, namesOff.join(',')).to.not.include.members(['DNM Rate (gene-set)', 'DNM Rate (per-gene)'])
        const rmOff = wbOff.getWorksheet('Read Me')
        let withheldRow = null
        rmOff.eachRow(r => { if (String(r.getCell(1).value || '').includes('Mutation-rate test (turned OFF for this export)')) withheldRow = r })
        expect(withheldRow, 'opting out must be documented, not silent').to.not.be.null
        const note = String(withheldRow.getCell(2).value)
        expect(note, 'says what is absent').to.include('NO de novo mutation-rate test')
        expect(note, 'names the opt-out as a SETTING, not a defect').to.include('this is a setting, not a defect')
        expect(note, 'says how to re-enable').to.include('dnmRateTest: true')
        // It must NOT still promise the ê that was measured, found harmful and deleted, and must
        // not blame a defect that has since been fixed.
        expect(note, 'must not promise the deleted ê').to.not.include('applies an empirical calibration')
        expect(note, 'the gnomAD-μ defect is named as HISTORY, not the current reason').to.include('That defect is FIXED')
    })
})
