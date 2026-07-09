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

const CLINVAR_URL = 'https://ftp.ncbi.nlm.nih.gov/pub/clinvar/tab_delimited/gene_specific_summary.txt'
const OUT_DIR = path.join(__dirname, '..', 'data', 'annotations')
const OUT_FILE = path.join(OUT_DIR, 'clinvar_gene_summary.json.gz')

function num(x) {
    const t = String(x).trim()
    return (t === '' || t === '-') ? 0 : (parseInt(t, 10) || 0)
}

async function buildClinvar() {
    process.stdout.write(`Fetching ${CLINVAR_URL} …\n`)
    const resp = await fetch(CLINVAR_URL, {headers: {'Accept': 'text/plain'}})
    if (!resp.ok) throw new Error(`ClinVar HTTP ${resp.status}`)
    const text = await resp.text()

    // Columns (header on line 2, prefixed with '#'):
    // Symbol GeneID Total_submissions Total_alleles Submissions_reporting_this_gene
    // Alleles_reported_Pathogenic_Likely_pathogenic Gene_MIM_number Number_uncertain Number_with_conflicts
    const genes = {}
    let dated = ''
    for (const line of text.split('\n')) {
        if (line.startsWith('#')) {
            const m = line.match(/dated\s+(.+)$/i)
            if (m) dated = m[1].trim()
            continue
        }
        const c = line.split('\t')
        if (c.length < 9) continue
        const sym = c[0].trim()
        if (!sym || sym === '-') continue
        const total = num(c[3])
        if (total <= 0) continue   // keep only genes with variants in ClinVar
        // last-wins collapses the handful of dual-MIM pseudoautosomal duplicate rows
        genes[sym.toUpperCase()] = {plp: num(c[5]), vus: num(c[7]), conflicts: num(c[8]), total}
    }

    const payload = {
        meta: {
            _source: 'NCBI ClinVar gene_specific_summary.txt',
            _license: 'public domain',
            _dated: dated,
            _field_help: {
                plp: 'Alleles_reported_Pathogenic_Likely_pathogenic',
                vus: 'Number_uncertain',
                conflicts: 'Number_with_conflicts',
                total: 'Total_alleles'
            }
        },
        genes
    }

    fs.mkdirSync(OUT_DIR, {recursive: true})
    const raw = Buffer.from(JSON.stringify(payload))
    const gz = zlib.gzipSync(raw, {level: 9})
    fs.writeFileSync(OUT_FILE, gz)
    process.stdout.write(`Wrote ${OUT_FILE}\n  genes: ${Object.keys(genes).length}\n  dated: ${dated || 'n/a'}\n  size: ${(gz.length / 1024).toFixed(0)} KiB (gz)\n`)
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

async function main() {
    try {
        await buildClinvar()
        await buildGnomad()
        process.stdout.write('Done.\n')
    } catch (err) {
        process.stderr.write(`Build failed: ${err.message}\n`)
        process.exit(1)
    }
}

main()
