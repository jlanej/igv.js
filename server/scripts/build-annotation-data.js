#!/usr/bin/env node
/**
 * Build / refresh bundled gene-annotation data files.
 *
 * Currently builds:
 *   data/annotations/clinvar_gene_summary.json.gz
 *     — slimmed from NCBI ClinVar's gene_specific_summary.txt (public domain),
 *       keyed by UPPERCASE gene symbol → {plp, vus, conflicts, total}.
 *
 * These bundled files let the ClinVar provider annotate genes offline (no
 * network at export time). Re-run this script to refresh the snapshot; ClinVar
 * updates the source file weekly.
 *
 *   node scripts/build-annotation-data.js
 *
 * Requires network access. Node 18+ (global fetch).
 */

'use strict'

const fs = require('fs')
const zlib = require('zlib')
const path = require('path')
const readline = require('readline')
const {Readable} = require('stream')

// Per-variant file (has ClinicalSignificance, so P and LP can be counted
// separately). ~440 MB; streamed + gunzipped line-by-line to bound memory.
const CLINVAR_URL = 'https://ftp.ncbi.nlm.nih.gov/pub/clinvar/tab_delimited/variant_summary.txt.gz'
const OUT_DIR = path.join(__dirname, '..', 'data', 'annotations')
const OUT_FILE = path.join(OUT_DIR, 'clinvar_gene_summary.json.gz')

async function buildClinvar() {
    process.stdout.write(`Fetching ${CLINVAR_URL} (~440 MB) …\n`)
    const resp = await fetch(CLINVAR_URL)
    if (!resp.ok) throw new Error(`ClinVar HTTP ${resp.status}`)

    // Stream + gunzip line-by-line so we never hold the ~3 GB uncompressed file.
    const input = Readable.fromWeb(resp.body).pipe(zlib.createGunzip())
    const rl = readline.createInterface({input, crlfDelay: Infinity})

    let cSym = -1, cSig = -1, cAsm = -1, first = true
    const genes = {}
    for await (const line of rl) {
        if (first) {
            const h = line.replace(/^#/, '').split('\t')
            cSym = h.indexOf('GeneSymbol'); cSig = h.indexOf('ClinicalSignificance'); cAsm = h.indexOf('Assembly')
            first = false
            continue
        }
        const c = line.split('\t')
        if (c.length <= Math.max(cSym, cSig, cAsm)) continue
        if (c[cAsm] !== 'GRCh38') continue                 // one assembly -> no double counting
        const rawSym = (c[cSym] || '').trim()
        if (!rawSym || rawSym === '-') continue
        const primary = c[cSig].split(';')[0].trim().toLowerCase()   // ignore appended modifiers
        for (const s of rawSym.replace(/,/g, ';').split(';')) {
            const sym = s.trim().toUpperCase()
            if (!sym || sym === '-') continue
            const r = genes[sym] || (genes[sym] = {p: 0, lp: 0, plp: 0, vus: 0, conflicts: 0, total: 0})
            r.total++
            if (primary === 'pathogenic') { r.p++; r.plp++ }
            else if (primary === 'likely pathogenic') { r.lp++; r.plp++ }
            else if (primary === 'pathogenic/likely pathogenic') { r.plp++ }
            else if (primary === 'uncertain significance') { r.vus++ }
            else if (primary.includes('conflicting')) { r.conflicts++ }
        }
    }

    const payload = {
        meta: {
            _source: 'NCBI ClinVar variant_summary.txt.gz (GRCh38)',
            _license: 'public domain',
            _field_help: {
                p: 'variants classified Pathogenic',
                lp: 'variants classified Likely pathogenic',
                plp: 'P + LP + Pathogenic/Likely pathogenic',
                vus: 'Uncertain significance',
                conflicts: 'Conflicting classifications',
                total: 'variants for the gene on GRCh38'
            }
        },
        genes
    }

    fs.mkdirSync(OUT_DIR, {recursive: true})
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)), {level: 9})
    fs.writeFileSync(OUT_FILE, gz)
    process.stdout.write(`Wrote ${OUT_FILE}\n  genes: ${Object.keys(genes).length}\n  size: ${(gz.length / 1024).toFixed(0)} KiB (gz)\n`)
}

const GNOMAD_URL = 'https://storage.googleapis.com/gcp-public-data--gnomad/release/4.1/constraint/gnomad.v4.1.constraint_metrics.tsv'
const GNOMAD_OUT = path.join(OUT_DIR, 'gnomad_constraint.json.gz')

function fnum(x) {
    const t = String(x).trim()
    if (t === '' || t === 'NA' || t === 'NaN') return null
    const v = parseFloat(t)
    return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null
}

async function buildGnomad() {
    process.stdout.write(`Fetching ${GNOMAD_URL} (~95 MB) …\n`)
    const resp = await fetch(GNOMAD_URL, {headers: {'Accept': 'text/tab-separated-values'}})
    if (!resp.ok) throw new Error(`gnomAD HTTP ${resp.status}`)
    const text = await resp.text()

    const lines = text.split('\n')
    const header = lines[0].split('\t')
    const idx = {}
    header.forEach((name, i) => { idx[name] = i })
    // Columns resolved by name (robust to position): MANE Select transcripts only.
    const cGene = idx['gene'], cMane = idx['mane_select']
    const cLoeuf = idx['lof.oe_ci.upper'], cPli = idx['lof.pLI'], cMisz = idx['mis.z_score']

    const genes = {}
    for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split('\t')
        if (c.length <= cMisz) continue
        if (String(c[cMane]).trim().toLowerCase() !== 'true') continue
        const sym = c[cGene].trim()
        if (!sym) continue
        const rec = {}
        const loeuf = fnum(c[cLoeuf]), pli = fnum(c[cPli]), misZ = fnum(c[cMisz])
        if (loeuf !== null) rec.loeuf = loeuf
        if (pli !== null) rec.pli = pli
        if (misZ !== null) rec.misZ = misZ
        if (Object.keys(rec).length > 0) genes[sym.toUpperCase()] = rec  // MANE is unique per gene
    }

    const payload = {
        meta: {
            _source: 'gnomAD v4.1 constraint_metrics.tsv (MANE Select transcripts)',
            _license: 'CC0 (attribution requested)',
            _build: 'GRCh38',
            _fields: {loeuf: 'lof.oe_ci.upper', pli: 'lof.pLI', misZ: 'mis.z_score'}
        },
        genes
    }
    fs.mkdirSync(OUT_DIR, {recursive: true})
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)), {level: 9})
    fs.writeFileSync(GNOMAD_OUT, gz)
    process.stdout.write(`Wrote ${GNOMAD_OUT}\n  genes: ${Object.keys(genes).length}\n  size: ${(gz.length / 1024).toFixed(0)} KiB (gz)\n`)
}

const GENCC_URL = 'https://thegencc.org/download/action/submissions-export-tsv'
const GENCC_OUT = path.join(OUT_DIR, 'gencc.json.gz')
const GENCC_RANK = {Definitive: 6, Strong: 5, Moderate: 4, Limited: 3, Supportive: 2,
    'Disputed Evidence': 1, 'Refuted Evidence': 0, 'Animal Model Only': 0, 'No Known Disease Relationship': 0}
const GENCC_ESTABLISHED = new Set(['Definitive', 'Strong', 'Moderate', 'Limited', 'Supportive'])

async function buildGencc() {
    process.stdout.write(`Fetching ${GENCC_URL} …\n`)
    const resp = await fetch(GENCC_URL)
    if (!resp.ok) throw new Error(`GenCC HTTP ${resp.status}`)
    const lines = (await resp.text()).split('\n')
    const h = lines[0].split('\t')
    const idx = {}
    h.forEach((n, i) => { idx[n] = i })
    const cSym = idx['gene_symbol'], cCls = idx['classification_title'], cMoi = idx['moi_title']

    const byGene = {}
    for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split('\t')
        if (c.length <= Math.max(cSym, cCls, cMoi)) continue
        const sym = (c[cSym] || '').trim().toUpperCase()
        if (!sym) continue
        const cls = (c[cCls] || '').trim(), moi = (c[cMoi] || '').trim()
        const g = byGene[sym] || (byGene[sym] = {best: '', bestRank: -1, moi: new Set()})
        const rk = GENCC_RANK[cls] != null ? GENCC_RANK[cls] : 0
        if (rk > g.bestRank) { g.bestRank = rk; g.best = cls }        // highest validity per gene
        if (GENCC_ESTABLISHED.has(cls) && moi) g.moi.add(moi)         // MOI from established evidence only
    }
    const genes = {}
    for (const sym of Object.keys(byGene)) genes[sym] = {validity: byGene[sym].best || '', moi: [...byGene[sym].moi].sort()}

    const payload = {
        meta: {_source: 'GenCC submissions (thegencc.org)', _license: 'CC0',
            _fields: {validity: 'highest gene-disease classification', moi: 'union of Mode-of-Inheritance for established-evidence submissions'}},
        genes
    }
    fs.mkdirSync(OUT_DIR, {recursive: true})
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)), {level: 9})
    fs.writeFileSync(GENCC_OUT, gz)
    process.stdout.write(`Wrote ${GENCC_OUT}\n  genes: ${Object.keys(genes).length}\n  size: ${(gz.length / 1024).toFixed(0)} KiB (gz)\n`)
}

async function main() {
    try {
        await buildClinvar()
        await buildGnomad()
        await buildGencc()
        process.stdout.write('Done.\n')
    } catch (err) {
        process.stderr.write(`Build failed: ${err.message}\n`)
        process.exit(1)
    }
}

main()
