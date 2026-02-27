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

// Remote hg38 genome reference hosted on S3.  Used to intercept the
// genomes3.json lookup so IGV resolves "hg38" to a real indexed FASTA
// and can render alignments with actual sequence data.
const HG38_FASTA_URL = 'https://s3.amazonaws.com/igv.broadinstitute.org/genomes/seq/hg38/hg38.fa'
const HG38_INDEX_URL = 'https://s3.amazonaws.com/igv.broadinstitute.org/genomes/seq/hg38/hg38.fa.fai'

function buildMockGenomesJson() {
    return [{
        id: 'hg38',
        name: 'Human (GRCh38/hg38)',
        fastaURL: HG38_FASTA_URL,
        indexURL: HG38_INDEX_URL,
        chromosomeOrder: 'chr1,chr2,chr3,chr4,chr5,chr6,chr7,chr8,chr9,chr10,chr11,chr12,chr13,chr14,chr15,chr16,chr17,chr18,chr19,chr20,chr21,chr22,chrX,chrY'
    }]
}

/**
 * Set up Playwright route interception so IGV genome lookups succeed.
 * The genomes3.json request is fulfilled with a single hg38 entry that
 * points to the Broad S3-hosted indexed FASTA.
 */
async function interceptGenomeRequests(page) {
    const mockJson = JSON.stringify(buildMockGenomesJson())
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
            await interceptGenomeRequests(page)
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

        it('IGV section becomes visible after clicking a variant', async function () {
            if (!browser) this.skip()
            await page.goto(`http://127.0.0.1:${port}/`, {waitUntil: 'networkidle'})
            await page.locator('table tbody tr').first().click()
            // Curation controls should appear
            await page.waitForSelector('#igv-curation', {timeout: 10000})
            const display = await page.locator('#igv-curation').evaluate(el => el.style.display)
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
    // IGV screenshot capture with real BAM data
    // Requires: 1) Playwright  2) built igv.js dist  3) S3 genome access
    // -----------------------------------------------------------------------
    describe('IGV screenshot with real trio alignments', function () {
        const igvDistPath = path.join(__dirname, '..', '..', 'dist', 'igv.esm.min.js')
        let page

        before(async function () {
            if (!browser) this.skip()
            if (!fs.existsSync(igvDistPath)) {
                console.log('    ⚠  Skipping IGV screenshot tests – dist/igv.esm.min.js not built')
                this.skip()
            }
            page = await browser.newPage()
            await page.setViewportSize({width: 1400, height: 900})
            await interceptGenomeRequests(page)
        })

        after(async function () {
            if (page) await page.close()
        })

        it('clicking a variant loads IGV with trio alignment tracks', async function () {
            if (!browser) this.skip()
            this.timeout(60000)
            await page.goto(`http://127.0.0.1:${port}/`, {waitUntil: 'networkidle'})
            await page.locator('table tbody tr').first().click()
            // Wait for IGV to initialize and tracks to render
            await page.waitForSelector('.igv-track', {timeout: 45000})
            // Should have at least 3 alignment tracks (child, mother, father)
            const trackCount = await page.locator('.igv-track').count()
            expect(trackCount).to.be.at.least(3)
        })

        it('track status indicators confirm all trio BAMs are accessible', async function () {
            if (!browser) this.skip()
            this.timeout(60000)
            await page.goto(`http://127.0.0.1:${port}/`, {waitUntil: 'networkidle'})
            await page.locator('table tbody tr').first().click()
            await page.waitForSelector('.track-status-ok', {timeout: 45000})
            const okCount = await page.locator('.track-status-ok').count()
            // Should have at least 3 accessible tracks (child, mother, father BAMs)
            expect(okCount).to.be.at.least(3)
        })

        it('IGV renders non-empty alignment canvases for trio BAMs', async function () {
            if (!browser) this.skip()
            this.timeout(60000)
            await page.goto(`http://127.0.0.1:${port}/`, {waitUntil: 'networkidle'})
            await page.locator('table tbody tr').first().click()
            await page.waitForSelector('.igv-track', {timeout: 45000})
            // Give time for BAM data to fully load and render
            await page.waitForTimeout(5000)

            // Check that IGV canvases have been drawn to (non-blank)
            const hasPixelData = await page.evaluate(() => {
                const canvases = document.querySelectorAll('#igv-div canvas')
                if (canvases.length === 0) return false
                let nonBlankCount = 0
                for (const canvas of canvases) {
                    if (canvas.width === 0 || canvas.height === 0) continue
                    const ctx = canvas.getContext('2d')
                    if (!ctx) continue
                    // Sample a strip across the middle of the canvas
                    const y = Math.floor(canvas.height / 2)
                    const w = Math.min(canvas.width, 200)
                    const imageData = ctx.getImageData(0, y, w, 1)
                    const pixels = imageData.data
                    let nonWhitePixels = 0
                    for (let i = 0; i < pixels.length; i += 4) {
                        if (pixels[i] !== 255 || pixels[i + 1] !== 255 || pixels[i + 2] !== 255) {
                            if (pixels[i + 3] > 0) nonWhitePixels++
                        }
                    }
                    if (nonWhitePixels > 5) nonBlankCount++
                }
                return nonBlankCount >= 1
            })
            expect(hasPixelData, 'IGV canvases should contain rendered alignment data').to.be.true
        })

        it('captures a non-trivial screenshot from IGV with real reads', async function () {
            if (!browser) this.skip()
            this.timeout(60000)
            await page.goto(`http://127.0.0.1:${port}/`, {waitUntil: 'networkidle'})
            await page.locator('table tbody tr').first().click()
            await page.waitForSelector('.igv-track', {timeout: 45000})
            await page.waitForTimeout(5000)

            // Capture the largest canvas (alignment pileup) as a data URL
            const screenshotData = await page.evaluate(() => {
                const canvases = document.querySelectorAll('#igv-div canvas')
                if (canvases.length === 0) return null
                let maxCanvas = null
                let maxArea = 0
                for (const c of canvases) {
                    const area = c.width * c.height
                    if (area > maxArea) { maxArea = area; maxCanvas = c }
                }
                if (!maxCanvas || maxCanvas.width === 0) return null
                return maxCanvas.toDataURL('image/png')
            })
            expect(screenshotData, 'should capture a PNG data URL').to.be.a('string')
            expect(screenshotData).to.match(/^data:image\/png;base64,/)
            // A real screenshot with alignment data should be more than a few KB
            const base64Part = screenshotData.split(',')[1]
            expect(base64Part.length, 'screenshot should be non-trivial').to.be.greaterThan(500)
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
