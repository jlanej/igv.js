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

// Precision-preserving numeric parse — for the per-gene mutation rates (μ ≈ 1e-6…1e-7),
// which fnum's round-to-4dp would collapse to 0. Keeps the full source value.
function ffloat(x) {
    const t = String(x).trim()
    if (t === '' || t === 'NA' || t === 'NaN') return null
    const v = parseFloat(t)
    return Number.isFinite(v) ? v : null
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
    // Per-consequence per-gene mutation rates (μ) + chromosome — for the de novo
    // mutation-rate enrichment (λ = 2·N·μ). μ is SNV-only, per transmission.
    const cMuLof = idx['lof.mu'], cMuMis = idx['mis.mu'], cMuSyn = idx['syn.mu'], cChr = idx['chromosome']
    const need = Math.max(cMisz, cMuLof, cMuMis, cMuSyn, cChr)

    const genes = {}
    for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split('\t')
        if (c.length <= need) continue
        if (String(c[cMane]).trim().toLowerCase() !== 'true') continue
        const sym = c[cGene].trim()
        if (!sym) continue
        const rec = {}
        const loeuf = fnum(c[cLoeuf]), pli = fnum(c[cPli]), misZ = fnum(c[cMisz])
        if (loeuf !== null) rec.loeuf = loeuf
        if (pli !== null) rec.pli = pli
        if (misZ !== null) rec.misZ = misZ
        // Gene set is UNCHANGED (genes with ≥1 constraint estimate) so Test A's
        // constraint universe stays identical; μ/chr just decorate those genes.
        if (Object.keys(rec).length === 0) continue
        const muLof = ffloat(c[cMuLof]), muMis = ffloat(c[cMuMis]), muSyn = ffloat(c[cMuSyn])
        if (muLof !== null) rec.muLof = muLof
        if (muMis !== null) rec.muMis = muMis
        if (muSyn !== null) rec.muSyn = muSyn
        const chr = String(c[cChr] || '').trim().replace(/^chr/i, '').toUpperCase()   // '1'…'22','X','Y'
        if (chr) rec.chr = chr
        genes[sym.toUpperCase()] = rec  // MANE is unique per gene
    }

    const payload = {
        meta: {
            _source: 'gnomAD v4.1 constraint_metrics.tsv (MANE Select transcripts)',
            _license: 'CC0 (attribution requested)',
            _build: 'GRCh38',
            _fields: {loeuf: 'lof.oe_ci.upper', pli: 'lof.pLI', misZ: 'mis.z_score',
                muLof: 'lof.mu', muMis: 'mis.mu', muSyn: 'syn.mu', chr: 'chromosome'}
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

// -------------------------------------------------------------------------
// Gene-set libraries (convergence dimensions): gene -> [set names].
// Reactome + WikiPathways pathways (CC0), HGNC gene families (attribution),
// MSigDB Hallmark processes (CC BY). Written to data/genesets/*.json.gz.
// -------------------------------------------------------------------------
const GENESETS_DIR = path.join(__dirname, '..', 'data', 'genesets')
const GS_HGNC_URL = 'https://storage.googleapis.com/public-download-files/hgnc/tsv/tsv/hgnc_complete_set.txt'
const GS_REACTOME_URL = 'https://reactome.org/download/current/ReactomePathways.gmt.zip'
const GS_WIKIPATHWAYS_URL = 'https://data.wikipathways.org/current/gmt/'
const GS_HALLMARK_URL = 'https://data.broadinstitute.org/gsea-msigdb/msigdb/release/2024.1.Hs/h.all.v2024.1.Hs.symbols.gmt'
const GS_PATHWAY_MAX_GENES = 500   // drop generic mega-pathways; enrichment handles the rest

const crypto = require('crypto')

/** Extract the first (single) file from a ZIP buffer — stored or deflated. */
function unzipFirst(buf) {
    if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('not a zip file')
    const method = buf.readUInt16LE(8)
    const csize = buf.readUInt32LE(18)
    const nameLen = buf.readUInt16LE(26)
    const extraLen = buf.readUInt16LE(28)
    const start = 30 + nameLen + extraLen
    const comp = csize > 0 ? buf.slice(start, start + csize) : buf.slice(start)
    if (method === 0) return comp
    if (method === 8) return zlib.inflateRawSync(comp)
    throw new Error(`unsupported zip compression method ${method}`)
}

/** Parse a GMT: `setName<TAB>desc<TAB>gene<TAB>gene…` → {UPPER_SYMBOL:[term,…]}. */
function parseGmt(text, nameFn, geneMap, maxGenes) {
    const gt = {}
    for (const line of text.split('\n')) {
        const cols = line.replace(/\r$/, '').split('\t')
        if (cols.length < 3) continue
        const term = nameFn(cols)
        let syms = cols.slice(2).map(g => g.trim()).filter(Boolean)
        syms = geneMap ? syms.map(g => geneMap[g]).filter(Boolean) : syms.map(g => g.toUpperCase())
        syms = [...new Set(syms)]
        if (!syms.length || (maxGenes && syms.length > maxGenes)) continue
        for (const s of syms) (gt[s] || (gt[s] = [])).push(term)
    }
    return gt
}

function writeGeneSet(fileId, meta, geneTerms) {
    const genes = {}
    for (const g of Object.keys(geneTerms)) {
        const terms = [...new Set(geneTerms[g])].sort()
        if (terms.length) genes[g] = terms
    }
    const termCount = new Set(Object.values(genes).flat()).size
    const payload = {meta: {...meta, geneCount: Object.keys(genes).length, termCount}, genes}
    payload.meta.sha256 = crypto.createHash('sha256')
        .update(JSON.stringify(payload)).digest('hex').slice(0, 16)
    fs.mkdirSync(GENESETS_DIR, {recursive: true})
    const out = path.join(GENESETS_DIR, fileId + '.json.gz')
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)), {level: 9})
    fs.writeFileSync(out, gz)
    process.stdout.write(`Wrote ${out}\n  genes: ${payload.meta.geneCount}  terms: ${termCount}  size: ${(gz.length / 1024).toFixed(0)} KiB (gz)\n`)
}

async function buildGeneSets() {
    // HGNC: entrez→symbol map (for WikiPathways) + gene families. TSV quotes any
    // field containing the '|' multi-value separator, so strip outer quotes.
    process.stdout.write(`Fetching ${GS_HGNC_URL} …\n`)
    const hgncResp = await fetch(GS_HGNC_URL)
    if (!hgncResp.ok) throw new Error(`HGNC HTTP ${hgncResp.status}`)
    const hgncLines = (await hgncResp.text()).split('\n')
    const hh = hgncLines[0].split('\t')
    const hi = {sym: hh.indexOf('symbol'), grp: hh.indexOf('gene_group'), ent: hh.indexOf('entrez_id'), lt: hh.indexOf('locus_type')}
    const entrez2sym = {}, hgncFamily = {}
    for (let i = 1; i < hgncLines.length; i++) {
        const c = hgncLines[i].split('\t')
        const sym = (c[hi.sym] || '').trim()
        if (!sym) continue
        const up = sym.toUpperCase()
        const ent = (c[hi.ent] || '').trim()
        if (ent) entrez2sym[ent] = up   // full map (all loci) — WikiPathways Entrez→symbol lookup
        // Gene-family convergence is a PROTEIN-CODING background. HGNC also groups
        // lncRNA / miRNA / pseudogene / tRNA / snoRNA loci into families (~12k of the
        // ~28k grouped genes); including them pads the prevalence denominator ~1.8× and
        // overstates every coding family's fold / anti-conservatively inflates its q. A
        // de novo coding DNM can realistically only hit a coding gene, so restrict the
        // family universe to locus_type 'gene with protein product'.
        const grp = (c[hi.grp] || '').trim().replace(/^"|"$/g, '')
        const isCoding = (c[hi.lt] || '').trim() === 'gene with protein product'
        if (grp && isCoding) for (const g of grp.split('|')) { const t = g.trim(); if (t) (hgncFamily[up] || (hgncFamily[up] = [])).push(t) }
    }
    writeGeneSet('hgnc_family', {
        id: 'hgncFamily', label: 'Gene family (HGNC)', source: 'HGNC gene groups',
        version: 'hgnc_complete_set', url: 'https://www.genenames.org/download/statistics-and-files/',
        license: 'Custom — no restrictions on use; attribution requested',
        licenseUrl: 'https://www.genenames.org/about/', builtWith: 'build-annotation-data.js buildGeneSets',
        note: 'Protein-coding genes only (HGNC locus_type "gene with protein product") — non-coding loci excluded so the prevalence background is the coding genome.',
    }, hgncFamily)

    // Reactome (symbols; zipped GMT, Homo sapiens R-HSA rows).
    process.stdout.write(`Fetching ${GS_REACTOME_URL} …\n`)
    const rResp = await fetch(GS_REACTOME_URL)
    if (!rResp.ok) throw new Error(`Reactome HTTP ${rResp.status}`)
    const reactText = unzipFirst(Buffer.from(await rResp.arrayBuffer())).toString('utf-8')
    writeGeneSet('reactome', {
        id: 'reactome', label: 'Pathway (Reactome)', source: 'Reactome ReactomePathways.gmt (Homo sapiens)',
        version: 'current', url: 'https://reactome.org/download-data', license: 'CC0 1.0',
        licenseUrl: 'https://reactome.org/license', note: `pathways with <= ${GS_PATHWAY_MAX_GENES} genes`,
        builtWith: 'build-annotation-data.js buildGeneSets',
    }, parseGmt(reactText, c => c[0].trim(), null, GS_PATHWAY_MAX_GENES))

    // WikiPathways (Entrez → symbol; latest dated GMT for Homo sapiens).
    const wpIndex = await (await fetch(GS_WIKIPATHWAYS_URL)).text()
    const wpFile = (wpIndex.match(/wikipathways-\d+-gmt-Homo_sapiens\.gmt/g) || []).sort().pop()
    if (!wpFile) throw new Error('WikiPathways GMT not found in index')
    process.stdout.write(`Fetching ${GS_WIKIPATHWAYS_URL}${wpFile} …\n`)
    const wpText = await (await fetch(GS_WIKIPATHWAYS_URL + wpFile)).text()
    const wpName = (cols) => {
        const parts = cols[0].split('%')
        const wp = parts.find(p => /^WP\d/.test(p)) || ''
        return wp ? `${parts[0].trim()} (${wp})` : parts[0].trim()
    }
    writeGeneSet('wikipathways', {
        id: 'wikipathways', label: 'Pathway (WikiPathways)',
        source: 'WikiPathways GMT (Homo sapiens, Entrez→symbol via HGNC)',
        version: (wpFile.match(/\d+/) || [''])[0], url: GS_WIKIPATHWAYS_URL, license: 'CC0 1.0',
        licenseUrl: 'https://www.wikipathways.org/terms.html', note: `pathways with <= ${GS_PATHWAY_MAX_GENES} genes`,
        builtWith: 'build-annotation-data.js buildGeneSets',
    }, parseGmt(wpText, wpName, entrez2sym, GS_PATHWAY_MAX_GENES))

    // MSigDB Hallmark (50 broad, well-separated processes; symbols).
    process.stdout.write(`Fetching ${GS_HALLMARK_URL} …\n`)
    const hmResp = await fetch(GS_HALLMARK_URL)
    if (!hmResp.ok) throw new Error(`MSigDB HTTP ${hmResp.status}`)
    const hmText = await hmResp.text()
    const hmName = (cols) => {
        let n = cols[0]
        if (n.startsWith('HALLMARK_')) n = n.slice('HALLMARK_'.length)
        return n.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())
    }
    writeGeneSet('msigdb_hallmark', {
        id: 'msigdbHallmark', label: 'Hallmark process (MSigDB)', source: 'MSigDB Hallmark (h.all, symbols)',
        version: 'v2024.1.Hs', url: 'https://www.gsea-msigdb.org/gsea/msigdb/', license: 'CC BY 4.0',
        licenseUrl: 'https://www.gsea-msigdb.org/gsea/msigdb/license_terms_list.jsp',
        builtWith: 'build-annotation-data.js buildGeneSets',
    }, parseGmt(hmText, hmName, null, null))
}

// -------------------------------------------------------------------------
// InterPro protein-domain background: human gene -> [InterPro entry names].
// Sources the "Protein domain" convergence dimension AND its background offline.
// Ensembl BioMart's interpro_description is byte-identical to MyGene's
// interpro[].desc, so export domain terms and the background align exactly (no
// remapping). Human-only (~3 MB, one request) — no need for protein2ipr (~100 GB).
// -------------------------------------------------------------------------
const BIOMART_URL = 'https://www.ensembl.org/biomart/martservice'
const BIOMART_QUERY = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE Query>' +
    '<Query virtualSchemaName="default" formatter="TSV" header="0" uniqueRows="1" datasetConfigVersion="0.6">' +
    '<Dataset name="hsapiens_gene_ensembl" interface="default">' +
    '<Attribute name="external_gene_name"/><Attribute name="interpro"/><Attribute name="interpro_description"/>' +
    '</Dataset></Query>'

async function buildInterproDomain() {
    process.stdout.write(`Fetching ${BIOMART_URL} (human gene → InterPro) …\n`)
    // BioMart wants the query as a urlencoded form field; genome-wide pull is slow.
    let text = ''
    for (let attempt = 1; attempt <= 3 && text.split('\n').length < 10000; attempt++) {
        const resp = await fetch(BIOMART_URL, {
            method: 'POST',
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
            body: 'query=' + encodeURIComponent(BIOMART_QUERY),
        })
        if (resp.ok) text = await resp.text()
        if (/^error|not allowed|<html/i.test(text.slice(0, 40))) text = ''
        if (text.split('\n').length < 10000) await new Promise(r => setTimeout(r, 4000))
    }
    if (text.split('\n').length < 10000) throw new Error('BioMart returned too few rows (transient? retry)')

    const byGene = {}   // UPPER symbol -> Set(domain description)
    for (const line of text.split('\n')) {
        const c = line.split('\t')       // gene \t IPR accession \t interpro_description
        const sym = (c[0] || '').trim().toUpperCase()
        const desc = (c[2] || '').trim()
        if (!sym || !desc) continue
        ;(byGene[sym] || (byGene[sym] = new Set())).add(desc)
    }
    const genes = {}
    for (const sym of Object.keys(byGene)) genes[sym] = [...byGene[sym]].sort()
    writeGeneSet('interpro_domain', {
        id: 'domain', label: 'Protein domain (InterPro)',
        source: 'Ensembl BioMart hsapiens_gene_ensembl (external_gene_name + interpro_description)',
        version: 'Ensembl current', url: BIOMART_URL,
        license: 'EMBL-EBI terms (InterPro CC0); Ensembl free to use',
        licenseUrl: 'https://www.ebi.ac.uk/about/terms-of-use',
        note: 'aligns with MyGene interpro[].desc', builtWith: 'build-annotation-data.js buildInterproDomain',
    }, genes)
}

// Named build steps — run all, or only those named on the CLI.
const STEPS = {clinvar: buildClinvar, gnomad: buildGnomad, gencc: buildGencc, genesets: buildGeneSets, interpro: buildInterproDomain}

async function main() {
    try {
        const want = process.argv.slice(2).filter(a => STEPS[a])
        const steps = want.length ? want : Object.keys(STEPS)
        for (const s of steps) await STEPS[s]()
        process.stdout.write('Done.\n')
    } catch (err) {
        process.stderr.write(`Build failed: ${err.message}\n`)
        process.exit(1)
    }
}

main()
