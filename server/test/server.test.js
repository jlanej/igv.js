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

        // Screenshot sheet should exist for variant 0
        const screenshotSheet = workbook.worksheets.find(s => s.name !== 'Variants')
        expect(screenshotSheet).to.exist
        // Should have back-link text
        expect(screenshotSheet.getCell('D1').value).to.have.property('text', '← Back to Variants')
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
        expect(res.text).to.include('Next variant')
        expect(res.text).to.include('Previous variant')
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
