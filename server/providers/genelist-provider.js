/**
 * Gene-List Membership Provider
 *
 * Adds one yes/no column per curated gene list dropped into
 * `server/data/gene-lists/*.txt`. Each file is a simple list of HGNC gene
 * symbols (one per line; `#` lines are comments; an optional `# name: Label`
 * directive sets the column header). For each report gene the provider emits
 * "Yes" / "No" for membership in each list.
 *
 * This is the licence-safe way to include annotations from sources whose
 * *content* cannot be redistributed (e.g. COSMIC Cancer Gene Census, OncoKB):
 * the report embeds only a membership boolean derived from a symbol list the
 * user supplies, not the licensed descriptive data. See the README in the
 * gene-lists directory.
 */

'use strict'

const fs = require('fs')
const path = require('path')
const log = require('../logger')

const LIST_DIR = path.join(__dirname, '..', 'data', 'gene-lists')

let lists = null            // [{key, header, members:Set<UPPER_SYMBOL>}]
let loadAttempted = false

function slugKey(name) {
    return 'list_' + String(name).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase()
}

function load() {
    if (loadAttempted) return
    loadAttempted = true
    lists = []
    try {
        if (!fs.existsSync(LIST_DIR)) return
        const files = fs.readdirSync(LIST_DIR).filter(f => f.toLowerCase().endsWith('.txt')).sort()
        for (const f of files) {
            try {
                const content = fs.readFileSync(path.join(LIST_DIR, f), 'utf-8')
                let header = f.replace(/\.txt$/i, '')
                const members = new Set()
                for (const line of content.split('\n')) {
                    const t = line.trim()
                    if (!t) continue
                    if (t.startsWith('#')) {
                        const m = t.match(/^#\s*name:\s*(.+)$/i)
                        if (m) header = m[1].trim()
                        continue
                    }
                    // First whitespace/comma/tab-separated token is the symbol.
                    members.add(t.split(/[\s,\t]+/)[0].trim().toUpperCase())
                }
                if (members.size > 0) lists.push({key: slugKey(header), header, members})
            } catch (err) {
                log.warn(`Failed to read gene list ${f}: ${err.message}`)
            }
        }
    } catch (err) {
        log.warn(`Failed to scan gene-lists directory: ${err.message}`)
    }
}

function isEnabled(cfg) {
    const ga = cfg && cfg.geneAnnotations
    const c = ga && ga.geneLists
    if (!(ga && ga.enabled && c && c.enabled)) return false
    load()
    return lists.length > 0
}

async function fetchBatch(geneList /*, cfg */) {
    load()
    const out = new Map()
    for (const g of geneList) {
        const up = String(g).toUpperCase()
        const hits = {}
        for (const l of lists) hits[l.key] = l.members.has(up)
        out.set(up, hits)
    }
    return out
}

function columns(/* cfg */) {
    load()
    return lists.map(l => ({
        header: l.header,
        key: l.key,
        width: Math.max(10, Math.min(24, l.header.length + 2))
    }))
}

function toRow(obj /*, cfg */) {
    load()
    const cells = {}
    for (const l of lists) {
        cells[l.key] = obj ? (obj[l.key] ? 'Yes' : 'No') : ''
    }
    return cells
}

/** Force a re-scan on next use (testing helper). */
function reset() { lists = null; loadAttempted = false }

module.exports = {
    id: 'geneLists',
    attribution: 'Gene-list membership (user-supplied lists) — see server/data/gene-lists/README.md',
    isEnabled, fetchBatch, columns, toRow, load, reset, LIST_DIR, slugKey
}
