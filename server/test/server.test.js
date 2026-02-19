const {describe, it, before, after} = require('mocha')
const {expect} = require('chai')
const request = require('supertest')
const fs = require('fs')
const path = require('path')

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
        expect(data).to.have.property('1')
        expect(data['1'].status).to.equal('fail')
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

describe('API /api/filters', function () {
    it('returns filter options for columns', async function () {
        const res = await request(app).get('/api/filters').expect(200)
        expect(res.body).to.have.property('curation_status')
        expect(res.body.curation_status).to.include('pass')
        expect(res.body.curation_status).to.include('fail')
        expect(res.body).to.have.property('gene')
        expect(res.body).to.have.property('impact')
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

describe('Static files', function () {
    it('serves the UI index.html', async function () {
        const res = await request(app).get('/').expect(200)
        expect(res.text).to.include('IGV')
    })

    it('serves app.js', async function () {
        await request(app).get('/app.js').expect(200)
    })

    it('serves styles.css', async function () {
        await request(app).get('/styles.css').expect(200)
    })
})
