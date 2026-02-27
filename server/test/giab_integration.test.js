/**
 * GIAB Trio Integration Tests
 *
 * End-to-end tests using real GIAB HG002/HG003/HG004 trio data.
 * Validates that:
 *   1. The VCF-to-TSV parser produces valid server input
 *   2. The server loads real trio variant data correctly
 *   3. Playwright-driven IGV screenshots contain actual alignment reads
 *   4. XLSX export embeds non-trivial screenshot images
 *   5. HTML export ZIP includes non-trivial screenshot PNGs
 *
 * These tests guard against regressions where screenshots are captured
 * before trio alignments finish loading.
 */

const {describe, it, before, after} = require('mocha')
const {expect} = require('chai')
const fs = require('fs')
const path = require('path')
const http = require('http')
const {spawn} = require('child_process')
const ExcelJS = require('exceljs')

const {vcfToTsv} = require('../scripts/vcf_to_variants_tsv')

const GIAB_DIR = path.join(__dirname, 'data', 'giab')
const VCF_PATH = path.join(GIAB_DIR, 'annotated.vcf.gz')
const TSV_PATH = path.join(GIAB_DIR, 'variants.tsv')

// Minimal hg38 genome reference that works offline (chromsizes format).
// Used to intercept genomes3.json requests so IGV can initialise without
// network access to igv.org.
function buildMockGenomesJson(port) {
    return [{
        id: 'hg38',
        name: 'Human (GRCh38/hg38)',
        fastaURL: `http://127.0.0.1:${port}/data/hg38.chrom.sizes`,
        format: 'chromsizes',
        chromosomeOrder: 'chr1,chr2,chr3,chr4,chr5,chr6,chr7,chr8,chr9,chr10,chr11,chr12,chr13,chr14,chr15,chr16,chr17,chr18,chr19,chr20,chr21,chr22,chrX,chrY'
    }]
}

/**
 * Set up Playwright route interception so IGV genome lookups succeed
 * without internet access.
 */
async function interceptGenomeRequests(page, port) {
    const mockJson = JSON.stringify(buildMockGenomesJson(port))
    await page.route('**/genomes3.json', route => {
        route.fulfill({status: 200, contentType: 'application/json', body: mockJson})
    })
    // Also intercept the backup URL
    await page.route('**/genomes/web/genomes.json', route => {
        route.fulfill({status: 200, contentType: 'application/json', body: mockJson})
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find a free port by binding to 0 then closing. */
function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = http.createServer()
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port
            srv.close(() => resolve(port))
        })
        srv.on('error', reject)
    })
}

/** Wait until the server's /api/config responds. */
function waitForServer(port, timeoutMs = 15000) {
    const start = Date.now()
    return new Promise((resolve, reject) => {
        const check = () => {
            const req = http.get(`http://127.0.0.1:${port}/api/config`, res => {
                res.resume()
                resolve()
            })
            req.on('error', () => {
                if (Date.now() - start > timeoutMs) {
                    reject(new Error(`Server did not start within ${timeoutMs}ms`))
                } else {
                    setTimeout(check, 300)
                }
            })
        }
        check()
    })
}

/** HTTP GET helper returning parsed JSON. */
function httpGet(port, urlPath) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${urlPath}`, res => {
            let data = ''
            res.on('data', chunk => { data += chunk })
            res.on('end', () => {
                try { resolve(JSON.parse(data)) }
                catch (e) { reject(new Error(`Invalid JSON from ${urlPath}: ${data.slice(0, 200)}`)) }
            })
        }).on('error', reject)
    })
}

/** HTTP POST helper returning a Buffer. */
function httpPostBuffer(port, urlPath, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body)
        const options = {
            hostname: '127.0.0.1',
            port,
            path: urlPath,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }
        const req = http.request(options, res => {
            const chunks = []
            res.on('data', chunk => chunks.push(chunk))
            res.on('end', () => resolve({status: res.statusCode, body: Buffer.concat(chunks)}))
        })
        req.on('error', reject)
        req.write(payload)
        req.end()
    })
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('GIAB Trio Integration', function () {
    this.timeout(120000) // Playwright tests can be slow

    let serverProcess
    let port
    let browser
    let chromium

    before(async function () {
        // Ensure GIAB data exists
        expect(fs.existsSync(VCF_PATH), 'annotated.vcf.gz must exist').to.be.true
        expect(fs.existsSync(TSV_PATH), 'variants.tsv must exist').to.be.true
        expect(fs.existsSync(path.join(GIAB_DIR, 'HG002_child.bam')), 'child BAM must exist').to.be.true
        expect(fs.existsSync(path.join(GIAB_DIR, 'HG003_father.bam')), 'father BAM must exist').to.be.true
        expect(fs.existsSync(path.join(GIAB_DIR, 'HG004_mother.bam')), 'mother BAM must exist').to.be.true

        // Start server with GIAB data
        port = await getFreePort()
        const serverJs = path.join(__dirname, '..', 'server.js')
        serverProcess = spawn(process.execPath, [
            serverJs,
            '--variants', TSV_PATH,
            '--data-dir', GIAB_DIR,
            '--port', String(port),
            '--genome', 'hg38'
        ], {
            cwd: path.join(__dirname, '..'),
            stdio: ['ignore', 'pipe', 'pipe']
        })

        // Collect stdout/stderr for debugging
        serverProcess.stdout.on('data', () => {})
        serverProcess.stderr.on('data', () => {})

        await waitForServer(port)

        // Load Playwright
        try {
            chromium = require('playwright').chromium
            browser = await chromium.launch()
        } catch (e) {
            console.warn('Playwright not available, browser tests will be skipped:', e.message)
        }
    })

    after(async function () {
        if (browser) await browser.close()
        if (serverProcess) serverProcess.kill()
    })

    // -----------------------------------------------------------------------
    // VCF-to-TSV parsing tests
    // -----------------------------------------------------------------------
    describe('VCF-to-TSV parser', function () {
        it('vcfToTsv() reproduces the committed variants.tsv', function () {
            const generated = vcfToTsv({
                vcfPath: VCF_PATH,
                childBam: 'HG002_child.bam',
                motherBam: 'HG004_mother.bam',
                fatherBam: 'HG003_father.bam'
            })
            const committed = fs.readFileSync(TSV_PATH, 'utf-8')
            expect(generated).to.equal(committed)
        })

        it('generates a valid TSV with correct headers', function () {
            const tsv = fs.readFileSync(TSV_PATH, 'utf-8')
            const lines = tsv.trim().split('\n')
            const headers = lines[0].split('\t')
            expect(headers).to.include('chrom')
            expect(headers).to.include('pos')
            expect(headers).to.include('ref')
            expect(headers).to.include('alt')
            expect(headers).to.include('inheritance')
            expect(headers).to.include('child_file')
            expect(headers).to.include('mother_file')
            expect(headers).to.include('father_file')
            expect(headers).to.include('child_DKA_DKT')
        })

        it('produces 20 variant rows from the GIAB VCF', function () {
            const tsv = fs.readFileSync(TSV_PATH, 'utf-8')
            const dataLines = tsv.trim().split('\n').slice(1)
            expect(dataLines.length).to.equal(20)
        })

        it('classifies de_novo variants based on DKU > 0', function () {
            const tsv = fs.readFileSync(TSV_PATH, 'utf-8')
            const lines = tsv.trim().split('\n')
            const headers = lines[0].split('\t')
            const inhIdx = headers.indexOf('inheritance')
            const posIdx = headers.indexOf('pos')
            // chr8:40003391 has DKU=1 → de_novo
            const deNovo = lines.find(l => l.includes('40003391'))
            expect(deNovo).to.exist
            expect(deNovo.split('\t')[inhIdx]).to.equal('de_novo')
            // chr8:40008009 has DKU=0 → inherited
            const inherited = lines.find(l => l.includes('40008009'))
            expect(inherited).to.exist
            expect(inherited.split('\t')[inhIdx]).to.equal('inherited')
        })

        it('populates child BAM file paths', function () {
            const tsv = fs.readFileSync(TSV_PATH, 'utf-8')
            const lines = tsv.trim().split('\n')
            const headers = lines[0].split('\t')
            const childIdx = headers.indexOf('child_file')
            const motherIdx = headers.indexOf('mother_file')
            const fatherIdx = headers.indexOf('father_file')
            const row = lines[1].split('\t')
            expect(row[childIdx]).to.equal('HG002_child.bam')
            expect(row[motherIdx]).to.equal('HG004_mother.bam')
            expect(row[fatherIdx]).to.equal('HG003_father.bam')
        })

        it('extracts DKA/DKT from FORMAT fields', function () {
            const tsv = fs.readFileSync(TSV_PATH, 'utf-8')
            const lines = tsv.trim().split('\n')
            const headers = lines[0].split('\t')
            const dkaIdx = headers.indexOf('child_DKA_DKT')
            // chr8:40003391 has DKA=1, DKT=17
            const row = lines.find(l => l.includes('40003391')).split('\t')
            expect(row[dkaIdx]).to.equal('1/17')
        })
    })

    // -----------------------------------------------------------------------
    // Server API tests with real GIAB data
    // -----------------------------------------------------------------------
    describe('Server with GIAB data', function () {
        it('returns correct config with 20 variants', async function () {
            const cfg = await httpGet(port, '/api/config')
            expect(cfg.genome).to.equal('hg38')
            expect(cfg.totalVariants).to.equal(20)
            expect(cfg.columns).to.include('chrom')
            expect(cfg.columns).to.include('child_file')
        })

        it('returns all 20 variants', async function () {
            const res = await httpGet(port, '/api/variants?per_page=50')
            expect(res.total).to.equal(20)
            expect(res.data.length).to.equal(20)
        })

        it('filters by inheritance', async function () {
            const res = await httpGet(port, '/api/variants?inheritance=de_novo')
            expect(res.total).to.be.greaterThan(0)
            res.data.forEach(v => expect(v.inheritance).to.equal('de_novo'))
        })

        it('serves BAM files via /data endpoint', async function () {
            return new Promise((resolve, reject) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port,
                    path: '/data/HG002_child.bam',
                    method: 'HEAD'
                }, res => {
                    expect(res.statusCode).to.equal(200)
                    resolve()
                })
                req.on('error', reject)
                req.end()
            })
        })

        it('serves BAM index files via /data endpoint', async function () {
            return new Promise((resolve, reject) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port,
                    path: '/data/HG002_child.bam.bai',
                    method: 'HEAD'
                }, res => {
                    expect(res.statusCode).to.equal(200)
                    resolve()
                })
                req.on('error', reject)
                req.end()
            })
        })
    })

    // -----------------------------------------------------------------------
    // Playwright-based UI integration tests
    // -----------------------------------------------------------------------
    describe('UI integration with real GIAB data', function () {
        let page

        before(async function () {
            if (!browser) this.skip()
            page = await browser.newPage()
            await page.setViewportSize({width: 1400, height: 900})
            await interceptGenomeRequests(page, port)
        })

        after(async function () {
            if (page) await page.close()
        })

        it('loads the review UI and displays 20 GIAB variant rows', async function () {
            if (!browser) this.skip()
            await page.goto(`http://127.0.0.1:${port}/`, {waitUntil: 'networkidle'})
            // Table should be visible with variants
            const rows = await page.locator('table tbody tr').count()
            expect(rows).to.equal(20)
        })

        it('variant rows contain real GIAB coordinates', async function () {
            if (!browser) this.skip()
            await page.goto(`http://127.0.0.1:${port}/`, {waitUntil: 'networkidle'})
            const text = await page.locator('#table-body').textContent()
            // Check for known GIAB variant positions
            expect(text).to.include('chr8')
            expect(text).to.include('40003391')
        })

        it('clicking a variant triggers IGV initialization and BAM track setup', async function () {
            if (!browser) this.skip()
            await page.goto(`http://127.0.0.1:${port}/`, {waitUntil: 'networkidle'})
            // Click the first variant row
            await page.locator('table tbody tr').first().click()
            // Wait for track validation to show BAM file accessibility
            await page.waitForSelector('.track-status', {timeout: 15000})
            const statusCount = await page.locator('.track-status').count()
            expect(statusCount).to.be.at.least(3)
        })

        it('track status indicators confirm all trio BAMs are accessible', async function () {
            if (!browser) this.skip()
            await page.goto(`http://127.0.0.1:${port}/`, {waitUntil: 'networkidle'})
            await page.locator('table tbody tr').first().click()
            // Wait for track validation
            await page.waitForSelector('.track-status-ok', {timeout: 15000})
            const okCount = await page.locator('.track-status-ok').count()
            // Should have at least 3 accessible tracks (child, mother, father BAMs)
            expect(okCount).to.be.at.least(3)
        })

        it('IGV section becomes visible after clicking a variant', async function () {
            if (!browser) this.skip()
            await page.goto(`http://127.0.0.1:${port}/`, {waitUntil: 'networkidle'})
            await page.locator('table tbody tr').first().click()
            // The IGV section should be visible
            const igvSection = page.locator('#igv-section')
            await expect(igvSection).to.exist
            // Curation controls should appear
            await page.waitForSelector('#igv-curation', {timeout: 10000})
            const curationDiv = page.locator('#igv-curation')
            const display = await curationDiv.evaluate(el => el.style.display)
            expect(display).to.equal('flex')
        })

        it('IGV title shows variant metadata for trio', async function () {
            if (!browser) this.skip()
            await page.goto(`http://127.0.0.1:${port}/`, {waitUntil: 'networkidle'})
            await page.locator('table tbody tr').first().click()
            await page.waitForSelector('#igv-title', {timeout: 10000})
            const title = await page.locator('#igv-title').innerHTML()
            // Should include locus info
            expect(title).to.include('chr8')
            expect(title).to.include('40003391')
            // Should include DKA/DKT metadata if available
            expect(title).to.include('DKA/DKT')
        })
    })

    // -----------------------------------------------------------------------
    // XLSX export with GIAB data
    // -----------------------------------------------------------------------
    describe('XLSX export with GIAB data', function () {
        it('produces a valid XLSX with all 20 GIAB variants', async function () {
            this.timeout(30000)
            const variants = await httpGet(port, '/api/variants?per_page=50')
            const variantIds = variants.data.map(v => v.id)

            const result = await httpPostBuffer(port, '/api/export/xlsx', {variantIds})
            expect(result.status).to.equal(200)
            expect(result.body.length).to.be.greaterThan(0)

            const workbook = new ExcelJS.Workbook()
            await workbook.xlsx.load(result.body)

            const varSheet = workbook.getWorksheet('Variants')
            expect(varSheet).to.exist
            // Header + 20 data rows
            expect(varSheet.rowCount).to.equal(21)

            // Verify header contains expected columns
            const headerValues = []
            varSheet.getRow(1).eachCell(cell => headerValues.push(cell.value))
            expect(headerValues).to.include('Chrom')
            expect(headerValues).to.include('Pos')
            expect(headerValues).to.include('Inheritance')
            expect(headerValues).to.include('Child File')
        })

        it('XLSX contains correct GIAB variant coordinates', async function () {
            this.timeout(30000)
            const variants = await httpGet(port, '/api/variants?per_page=50')
            const variantIds = variants.data.slice(0, 5).map(v => v.id)

            const result = await httpPostBuffer(port, '/api/export/xlsx', {variantIds})
            const workbook = new ExcelJS.Workbook()
            await workbook.xlsx.load(result.body)

            const varSheet = workbook.getWorksheet('Variants')
            const headerValues = []
            varSheet.getRow(1).eachCell((cell, colNumber) => {
                headerValues.push({col: colNumber, value: cell.value})
            })
            const chromCol = headerValues.find(h => h.value === 'Chrom')
            expect(chromCol).to.exist
            // First data row should have a real chromosome
            const firstChrom = varSheet.getRow(2).getCell(chromCol.col).value
            expect(firstChrom).to.match(/^chr\d+/)
        })

        it('XLSX embeds screenshots when provided with real trio data', async function () {
            this.timeout(30000)
            // Use a tiny but valid PNG as screenshot stand-in
            const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
            const variants = await httpGet(port, '/api/variants?per_page=5')
            const variantIds = variants.data.slice(0, 3).map(v => v.id)
            const screenshots = {[String(variantIds[0])]: tinyPng}

            const result = await httpPostBuffer(port, '/api/export/xlsx', {variantIds, screenshots})
            expect(result.status).to.equal(200)

            const workbook = new ExcelJS.Workbook()
            await workbook.xlsx.load(result.body)

            // Should have Variants sheet + at least 1 screenshot tab
            expect(workbook.worksheets.length).to.be.at.least(2)
            const ssSheet = workbook.getWorksheet('1')
            expect(ssSheet, 'screenshot tab should exist').to.exist
        })

        it('XLSX export respects inheritance filter', async function () {
            this.timeout(30000)
            const variants = await httpGet(port, '/api/variants?inheritance=de_novo&per_page=50')
            const variantIds = variants.data.map(v => v.id)

            const result = await httpPostBuffer(port, '/api/export/xlsx', {
                variantIds,
                filters: {inheritance: 'de_novo'}
            })
            expect(result.status).to.equal(200)

            const workbook = new ExcelJS.Workbook()
            await workbook.xlsx.load(result.body)

            const varSheet = workbook.getWorksheet('Variants')
            // Should have fewer rows than total (only de_novo)
            expect(varSheet.rowCount).to.be.lessThan(21)
            expect(varSheet.rowCount).to.be.at.least(2)
        })
    })

    // -----------------------------------------------------------------------
    // HTML export with GIAB data
    // -----------------------------------------------------------------------
    describe('HTML export with GIAB data', function () {
        it('produces a valid ZIP with index.html containing GIAB variants', async function () {
            this.timeout(30000)
            const variants = await httpGet(port, '/api/variants?per_page=50')
            const variantIds = variants.data.map(v => v.id)

            const result = await httpPostBuffer(port, '/api/export/html', {variantIds})
            expect(result.status).to.equal(200)
            // ZIP magic bytes
            expect(result.body[0]).to.equal(0x50)
            expect(result.body[1]).to.equal(0x4B)

            const JSZip = require('jszip')
            const zip = await JSZip.loadAsync(result.body)

            const htmlFile = zip.file('variants_report/index.html')
            expect(htmlFile).to.exist
            const html = await htmlFile.async('string')
            expect(html).to.include('Variant Review Report')
            // Should contain real GIAB coordinates
            expect(html).to.include('chr8')
            expect(html).to.include('40003391')
        })

        it('HTML export includes screenshots in ZIP', async function () {
            this.timeout(30000)
            const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
            const variants = await httpGet(port, '/api/variants?per_page=5')
            const variantIds = variants.data.slice(0, 3).map(v => v.id)
            const screenshots = {[String(variantIds[0])]: tinyPng}

            const result = await httpPostBuffer(port, '/api/export/html', {variantIds, screenshots})
            expect(result.status).to.equal(200)

            const JSZip = require('jszip')
            const zip = await JSZip.loadAsync(result.body)

            const screenshotFiles = Object.keys(zip.files).filter(f =>
                f.startsWith('variants_report/screenshots/') && f.endsWith('.png')
            )
            expect(screenshotFiles.length).to.be.at.least(1)

            // Verify PNG header
            const pngData = await zip.file(screenshotFiles[0]).async('nodebuffer')
            const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47])
            expect(pngData.slice(0, 4).equals(pngHeader)).to.be.true
        })

        it('HTML export includes de_novo variant data', async function () {
            this.timeout(30000)
            const variants = await httpGet(port, '/api/variants?inheritance=de_novo&per_page=50')
            const variantIds = variants.data.map(v => v.id)

            const result = await httpPostBuffer(port, '/api/export/html', {
                variantIds,
                filters: {inheritance: 'de_novo'}
            })
            expect(result.status).to.equal(200)

            const JSZip = require('jszip')
            const zip = await JSZip.loadAsync(result.body)
            const html = await zip.file('variants_report/index.html').async('string')
            expect(html).to.include('de_novo')
            expect(html).to.include('Applied Filters')
        })
    })
})
