#!/usr/bin/env node

/**
 * Generate documentation screenshots from the running variant review server.
 *
 * Usage:
 *   node scripts/generate-screenshots.js
 *
 * Requires: playwright (npx playwright install chromium)
 * Starts the server on a random port, captures 8 screenshots, then exits.
 */

const { execSync, spawn } = require('child_process')
const path = require('path')
const http = require('http')

const DOCS_DIR = path.join(__dirname, '..', 'docs', 'screenshots')
const SERVER_DIR = path.join(__dirname, '..', 'server')
const SERVER_SCRIPT = path.join(SERVER_DIR, 'server.js')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait until the server responds on the given port. */
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

/** Find a free port by binding to 0 and closing. */
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    const { chromium } = require(path.join(SERVER_DIR, 'node_modules', 'playwright'))

    const port = await getFreePort()
    console.log(`Starting server on port ${port}…`)

    const server = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(port)], {
        cwd: SERVER_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
    })

    let serverOutput = ''
    server.stdout.on('data', d => { serverOutput += d })
    server.stderr.on('data', d => { serverOutput += d })

    try {
        await waitForServer(port)
        console.log('Server is ready.')

        const browser = await chromium.launch()
        const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
        const page = await context.newPage()

        const url = `http://127.0.0.1:${port}`
        await page.goto(url, { waitUntil: 'networkidle' })

        // Wait for variant table to populate
        await page.waitForSelector('#table-body tr', { timeout: 10000 })
        // Small extra wait for rendering
        await page.waitForTimeout(500)

        // 01 – Full overview
        await page.screenshot({ path: path.join(DOCS_DIR, '01-overview.png'), fullPage: false })
        console.log('  ✓ 01-overview.png')

        // 02 – Variant table (just the main content area)
        const tableWrap = await page.$('#tab-variants')
        if (tableWrap) {
            await tableWrap.screenshot({ path: path.join(DOCS_DIR, '02-variant-table.png') })
        } else {
            await page.screenshot({ path: path.join(DOCS_DIR, '02-variant-table.png'), fullPage: false })
        }
        console.log('  ✓ 02-variant-table.png')

        // 03 – Filter panel
        const filterPanel = await page.$('#filter-panel')
        if (filterPanel) {
            await filterPanel.screenshot({ path: path.join(DOCS_DIR, '03-filter-panel.png') })
        } else {
            await page.screenshot({ path: path.join(DOCS_DIR, '03-filter-panel.png'), fullPage: false })
        }
        console.log('  ✓ 03-filter-panel.png')

        // 04 – IGV viewer: click on first variant row to load IGV
        const firstRow = await page.$('#table-body tr')
        if (firstRow) {
            await firstRow.click()
            await page.waitForTimeout(1500) // Give IGV time to initialize
        }
        const igvSection = await page.$('#igv-section')
        if (igvSection) {
            await igvSection.screenshot({ path: path.join(DOCS_DIR, '04-igv-viewer.png') })
        } else {
            await page.screenshot({ path: path.join(DOCS_DIR, '04-igv-viewer.png'), fullPage: false })
        }
        console.log('  ✓ 04-igv-viewer.png')

        // 05 – Gene summary tab
        const summaryTab = await page.$('button[data-tab="summary"]')
        if (summaryTab) {
            await summaryTab.click()
            await page.waitForTimeout(500)
        }
        const summaryContent = await page.$('#tab-summary')
        if (summaryContent) {
            await summaryContent.screenshot({ path: path.join(DOCS_DIR, '05-gene-summary.png') })
        } else {
            await page.screenshot({ path: path.join(DOCS_DIR, '05-gene-summary.png'), fullPage: false })
        }
        console.log('  ✓ 05-gene-summary.png')

        // 06 – Sample summary tab
        const sampleSummaryTab = await page.$('button[data-tab="sample-summary"]')
        if (sampleSummaryTab) {
            await sampleSummaryTab.click()
            await page.waitForTimeout(500)
        }
        const sampleSummaryContent = await page.$('#tab-sample-summary')
        if (sampleSummaryContent) {
            await sampleSummaryContent.screenshot({ path: path.join(DOCS_DIR, '06-sample-summary.png') })
        } else {
            await page.screenshot({ path: path.join(DOCS_DIR, '06-sample-summary.png'), fullPage: false })
        }
        console.log('  ✓ 06-sample-summary.png')

        // 07 – Keyboard shortcuts panel
        const shortcutsToggle = await page.$('#shortcuts-toggle')
        if (shortcutsToggle) {
            await shortcutsToggle.click()
            await page.waitForTimeout(300)
        }
        const shortcutsPanel = await page.$('#shortcuts-panel')
        if (shortcutsPanel) {
            await shortcutsPanel.screenshot({ path: path.join(DOCS_DIR, '07-keyboard-shortcuts.png') })
        } else {
            await page.screenshot({ path: path.join(DOCS_DIR, '07-keyboard-shortcuts.png'), fullPage: false })
        }
        console.log('  ✓ 07-keyboard-shortcuts.png')

        // 08 – Curation workflow: go back to variant tab, click a row, show curation buttons
        if (shortcutsToggle) {
            await shortcutsToggle.click() // close shortcuts
            await page.waitForTimeout(200)
        }
        const variantsTab = await page.$('button[data-tab="variants"]')
        if (variantsTab) {
            await variantsTab.click()
            await page.waitForTimeout(300)
        }
        const firstRow2 = await page.$('#table-body tr')
        if (firstRow2) {
            await firstRow2.click()
            await page.waitForTimeout(1000)
        }
        // Capture the full page to show the curation workflow in context
        await page.screenshot({ path: path.join(DOCS_DIR, '08-curation-workflow.png'), fullPage: true })
        console.log('  ✓ 08-curation-workflow.png')

        await browser.close()
        console.log('All screenshots generated successfully.')
    } catch (err) {
        console.error('Error generating screenshots:', err.message)
        console.error('Server output:', serverOutput)
        process.exitCode = 1
    } finally {
        server.kill()
    }
}

main()
