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
        const screenshotSheet = workbook.worksheets.find(s => s.name !== 'Variants' && s.name !== 'Gene Summary' && s.name !== 'Sample Summary')
        expect(screenshotSheet).to.exist
        // Should have back-link text
        expect(screenshotSheet.getCell('D1').value).to.have.property('text', '← Back to Variants')
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
        expect(ssHeader).to.include('Total')
        // Should have at least one data row
        expect(sampleSummary.rowCount).to.be.at.least(2)
    })
})

describe('XLSX Applied Filters sheet', function () {
    it('includes Applied Filters sheet when filters provided', async function () {
        this.timeout(10000)
        const res = await request(app)
            .post('/api/export/xlsx')
            .send({
                variantIds: [0, 1, 2],
                filters: {impact: 'HIGH', frequency_max: '0.001'}
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
        // Should have 2 filter rows
        expect(filtersSheet.rowCount).to.equal(3) // header + 2 data rows
        // Check filter values
        const filterValues = []
        for (let r = 2; r <= filtersSheet.rowCount; r++) {
            filterValues.push(filtersSheet.getRow(r).getCell(1).value)
        }
        expect(filterValues).to.include('Impact')
        expect(filterValues).to.include('Frequency Max')
    })

    it('omits Applied Filters sheet when no filters provided', async function () {
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
        expect(workbook.getWorksheet('Applied Filters')).to.be.undefined
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
        // Total column (col 2) should be a number
        const totalMean = sampleSummary.getRow(meanRowNum).getCell(2).value
        expect(totalMean).to.be.a('number')
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
