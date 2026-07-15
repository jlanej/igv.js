/**
 * MitoCarta 3.0 (Broad Institute) — mitochondrial gene-set dimensions for the Gene
 * Analysis convergence tab, plus a per-gene "mitochondrial" annotation.
 *
 * Three grouping dimensions:
 *   - mitoLocalization    : binary — is the gene in MitoCarta3.0 (localized to mito)?
 *   - mitoSubLocalization : sub-mitochondrial localization (Matrix / MIM / MOM / IMS / …)
 *   - mitoPathways        : the MitoPathways3.0 functional hierarchy
 *
 * All three come from the SINGLE Human.MitoCarta3.0.xls, sheet "B Human All Genes" —
 * the ~19,243-gene genome MitoCarta screened, with a `MitoCarta3.0_List` flag marking
 * the 1,136-gene inventory and `MitoCarta3.0_SubMitoLocalization` / `MitoCarta3.0_MitoPathways`
 * filled in for those genes. Reading sheet B (not the mito-only sheet A) gives us the
 * genome background the binary test needs.
 *
 * BACKGROUND UNIVERSE differs by dimension, on purpose:
 *   - localization ("mito vs not"): the FULL screened genome (~19,243), so "% all genes"
 *     is a gene's share of all genes (mito ≈ 5.9%). A mito-only universe would be 100%
 *     → degenerate. Every screened gene is kept in this lib (non-members carry []).
 *   - subLoc / pathways ("which compartment / pathway"): only the mito genes carrying
 *     that annotation (the within-mito ORA background, like Reactome/WikiPathways), so
 *     the test measures SPECIFICITY among mito genes rather than re-reporting the overall
 *     mito-enrichment signal. Non-members are dropped from these libs.
 *
 * Ancestor-expanding each gene's "A > B > C" pathway paths reproduces the MitoPathways3.0
 * set membership exactly (one set per hierarchy node), so a gene converges at every level
 * of its lineage.
 *
 * LICENSING / DISTRIBUTION: MitoCarta is CC BY-NC (academic, non-commercial) — we do
 * NOT redistribute it and it never enters the image. Each deployment downloads the .xls
 * from the Broad at runtime (download-if-missing) into a writable dir beside wherever the
 * server was launched — see cacheDir(), which handles the read-only image filesystems
 * (Apptainer .sif etc.) this normally runs on. Offline / egress-blocked deployments
 * simply don't get the MitoCarta dimensions (they degrade to "unavailable", like every
 * other network-dependent fallback).
 * Cite: Rath et al., Nucleic Acids Res 2021;49:D1541 (MitoCarta3.0);
 * data © Broad Institute, https://www.broadinstitute.org/mitocarta.
 *
 * The pure parse/transform function (xlsRowsToMaps) is exported and unit-tested; only
 * the SheetJS `.xls` byte-read is library code.
 */

'use strict'

const fs = require('fs')
const os = require('os')
const zlib = require('zlib')
const path = require('path')
const log = require('./logger')

const DATA_DIR = path.join(__dirname, 'data', 'genesets')
const BROAD_BASE = 'https://personal.broadinstitute.org/scalvo/MitoCarta3.0/'
const XLS_URL = BROAD_BASE + 'Human.MitoCarta3.0.xls'
const XLS_NAME = 'Human.MitoCarta3.0.xls'

// ---------------------------------------------------------------------------
// Where the runtime download + derived bundles go.
//
// DATA_DIR lives inside the image and is READ-ONLY in most real deployments
// (Apptainer/Singularity .sif, read-only Docker rootfs) — writing there fails with
// EROFS. So resolve a genuinely writable dir by PROBING (permission bits lie on a
// read-only mount), preferring:
//   1. $MITOCARTA_CACHE_DIR   — explicit override
//   2. DATA_DIR               — dev checkouts / writable images
//   3. <cwd>/.mitocarta-cache — the directory the server was LAUNCHED from. Apptainer
//                               bind-mounts $PWD by default, so this is a host-side,
//                               writable, persistent dir: download once, reuse forever,
//                               and nothing licensed ever enters the image.
//   4. <tmpdir>/igv-mitocarta — last resort (ephemeral: re-downloads each boot)
// findFile() also reads DATA_DIR, so a copy placed there still works.
// ---------------------------------------------------------------------------
function isWritable(dir) {
    try {
        fs.mkdirSync(dir, {recursive: true})
        const probe = path.join(dir, `.wtest-${process.pid}`)
        fs.writeFileSync(probe, '')
        fs.unlinkSync(probe)
        return true
    } catch (_) { return false }
}

let cacheDirMemo = null
function cacheDir() {
    if (cacheDirMemo) return cacheDirMemo
    const launchDir = path.join(process.cwd(), '.mitocarta-cache')
    const fallback = path.join(os.tmpdir(), 'igv-mitocarta')
    for (const c of [process.env.MITOCARTA_CACHE_DIR, DATA_DIR, launchDir, fallback]) {
        if (c && isWritable(c)) { cacheDirMemo = c; break }
    }
    if (!cacheDirMemo) cacheDirMemo = fallback   // nothing writable; writes fail & we degrade
    if (cacheDirMemo !== DATA_DIR) log.info(`MitoCarta: cache dir ${cacheDirMemo} (${DATA_DIR} is read-only)`)
    return cacheDirMemo
}

/** Locate a data file: a build-time copy baked into the image wins, else the cache. */
function findFile(name) {
    const baked = path.join(DATA_DIR, name)
    if (fs.existsSync(baked)) return baked
    const cached = path.join(cacheDir(), name)
    return fs.existsSync(cached) ? cached : null
}

// The all-genes background sheet + column headers (resolved by NAME, robust to order).
const XLS_SHEET = 'B Human All Genes'
const COL_SYMBOL = 'Symbol'
const COL_LIST = 'MitoCarta3.0_List'   // == MITO_FLAG for the 1,136-gene inventory
const COL_SUBLOC = 'MitoCarta3.0_SubMitoLocalization'
const COL_PATH = 'MitoCarta3.0_MitoPathways'
const MITO_FLAG = 'MitoCarta3.0'       // the value marking a mitochondrial gene

// dimId -> {file (derived bundle), label, term derivation, config toggle}
const DIMS = [
    {id: 'mitoLocalization', file: 'mitocarta_localization.json.gz', label: 'Mitochondrial localization (MitoCarta)'},
    {id: 'mitoSubLocalization', file: 'mitocarta_sublocalization.json.gz', label: 'Sub-mitochondrial localization (MitoCarta)'},
    {id: 'mitoPathways', file: 'mitocarta_pathways.json.gz', label: 'Mitochondrial pathway (MitoCarta)'},
]
const MITO_TERM = 'Localized to mitochondria (MitoCarta3.0)'

const META_BASE = {
    source: 'MitoCarta3.0 (Broad Institute)', version: 'MitoCarta3.0',
    license: 'CC BY-NC 4.0 (academic / non-commercial)', url: 'https://www.broadinstitute.org/mitocarta',
    citation: 'Rath et al., Nucleic Acids Res 2021;49:D1541',
}

// ---------------------------------------------------------------------------
// Pure parse / transform (unit-tested; no I/O)
// ---------------------------------------------------------------------------

/**
 * From the all-genes sheet-B rows (array of objects keyed by header, as SheetJS
 * sheet_to_json yields), build all three gene maps and the per-gene annotation. EVERY
 * screened gene appears in localization/subLoc/pathways (non-members carry []); the
 * background universe is then selected at write time (writeBundle's keepEmpty) — the
 * whole genome for localization, the annotated-mito subset for subLoc/pathways. A gene
 * is mitochondrial iff its `MitoCarta3.0_List` == "MitoCarta3.0".
 *   localization : gene -> [MITO_TERM] | []                     mito vs not
 *   subLoc       : gene -> [Matrix/MIM/MOM/IMS/Membrane …] | [] sub-mitochondrial
 *   pathways     : gene -> [MitoPathways terms, ancestors] | [] functional hierarchy
 *   annotation   : mito gene -> {mito:true, subLoc:[…]}         Gene Summary column
 * @param {Array<Object>} rows
 * @returns {{localization:Map, subLoc:Map, pathways:Map, annotation:Map}}
 */
function xlsRowsToMaps(rows) {
    const localization = new Map(), subLoc = new Map(), pathways = new Map(), annotation = new Map()
    for (const row of rows || []) {
        const sym = String(row[COL_SYMBOL] || '').trim().toUpperCase()
        if (!sym) continue
        const isMito = String(row[COL_LIST] || '').trim() === MITO_FLAG
        // Every screened gene is in each lib (universe = genome); non-mito genes hold [].
        localization.set(sym, isMito ? [MITO_TERM] : [])
        // SubMitoLocalization (mito genes only) is single- or (rarely) pipe-delimited,
        // e.g. "MOM|IMS" — the pipe is MitoCarta3.0's only multi-value delimiter
        // (verified against the source). "unknown" is MISSING sub-localization, not a
        // shared attribute — drop it so it forms neither a spurious convergence category
        // nor a "Yes — unknown" annotation (the gene still counts as mitochondrial).
        let subs = []
        if (isMito) {
            const rawSub = String(row[COL_SUBLOC] || '').trim()
            subs = rawSub ? [...new Set(rawSub.split('|').map(s => s.trim()).filter(s => s && !/^unknown$/i.test(s)))] : []
        }
        subLoc.set(sym, subs)
        // MitoPathways (mito genes only): pipe-separated "A > B > C" hierarchy paths
        // (empty = "0"). List the gene under every ANCESTOR level so convergence is
        // detectable at any depth — this reproduces the MitoPathways3.0 set membership
        // (one set per hierarchy node: "OXPHOS", "OXPHOS > Complex III", …).
        let terms = []
        if (isMito) {
            const rawPath = String(row[COL_PATH] || '').trim()
            if (rawPath && rawPath !== '0') {
                const set = new Set()
                for (const p of rawPath.split('|')) {
                    const parts = p.split('>').map(s => s.trim()).filter(Boolean)
                    for (let k = 1; k <= parts.length; k++) set.add(parts.slice(0, k).join(' > '))
                }
                terms = [...set]
            }
        }
        pathways.set(sym, terms)
        if (isMito) annotation.set(sym, {mito: true, subLoc: subs})
    }
    return {localization, subLoc, pathways, annotation}
}

// ---------------------------------------------------------------------------
// SheetJS .xls read (library code — not unit-tested here)
// ---------------------------------------------------------------------------
function readXlsRows(buffer) {
    let XLSX
    try { XLSX = require('xlsx') } catch (e) {
        log.warn('MitoCarta: the "xlsx" package is not installed — cannot parse the .xls (run `npm install`).')
        return null
    }
    const wb = XLSX.read(buffer, {type: 'buffer'})
    const sheet = wb.Sheets[XLS_SHEET] || wb.Sheets[wb.SheetNames.find(n => /All Genes/i.test(n) && /^B/i.test(n))]
    if (!sheet) { log.warn(`MitoCarta: sheet "${XLS_SHEET}" not found in the .xls.`); return null }
    return XLSX.utils.sheet_to_json(sheet, {defval: ''})
}

// ---------------------------------------------------------------------------
// Runtime download-if-missing + derived-bundle cache
// ---------------------------------------------------------------------------
// OLE2/CFB magic — the leading bytes of every legacy .xls. Validating it guards
// against a captive-portal HTML page or an error body saved under the .xls name.
const XLS_MAGIC = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])
const FETCH_TIMEOUT_MS = 30000

async function fetchToFile(url, dest) {
    if (fs.existsSync(dest)) return true
    if (typeof fetch !== 'function') { log.warn('MitoCarta: global fetch unavailable — cannot download.'); return false }
    const tmp = dest + '.tmp'
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)   // portable (no AbortSignal.timeout dep)
    try {
        log.info(`MitoCarta: downloading ${url} …`)
        const resp = await fetch(url, {signal: ac.signal})
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const buf = Buffer.from(await resp.arrayBuffer())
        // Reject anything that is not a real .xls (bad magic / implausibly small).
        if (buf.length < 4096 || !buf.subarray(0, 8).equals(XLS_MAGIC)) throw new Error(`not a valid .xls (${buf.length} bytes)`)
        fs.mkdirSync(path.dirname(dest), {recursive: true})
        fs.writeFileSync(tmp, buf)
        fs.renameSync(tmp, dest)   // atomic swap — readers never see a partial file
        return true
    } catch (err) {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch (_) { /* ignore */ }
        log.warn(`MitoCarta: download failed (${url}): ${err.message}`); return false
    } finally { clearTimeout(timer) }
}

function writeBundle(file, meta, geneMap, keepEmpty) {
    // The lib's stored gene set IS its background universe (the "% all genes" denominator).
    //   keepEmpty=true  (localization): keep EVERY screened gene incl. non-members ([]),
    //                   so the universe is the whole ~19k-gene genome — the correct null
    //                   for the binary "mito vs not" test (mito ≈ 5.9% of all genes).
    //   keepEmpty=false (subLoc/pathways): keep only annotated genes, so the universe is
    //                   the mito genes carrying that annotation — the within-mito ORA
    //                   background (matches Reactome/WikiPathways) that measures pathway/
    //                   compartment SPECIFICITY rather than re-reporting the mito signal.
    const genes = {}
    let memberGenes = 0
    for (const [g, terms] of geneMap) {
        const t = [...new Set(terms)].sort()
        if (t.length) { genes[g] = t; memberGenes++ }
        else if (keepEmpty) genes[g] = []
    }
    const payload = {meta: {...META_BASE, ...meta, geneCount: Object.keys(genes).length, memberGenes}, genes}
    fs.writeFileSync(path.join(cacheDir(), file), zlib.gzipSync(Buffer.from(JSON.stringify(payload)), {level: 9}))
}

/**
 * Ensure the derived MitoCarta bundles exist: download the raw files if missing, parse,
 * and write the gitignored derived .gz. Idempotent; safe to call repeatedly. Returns
 * true if the bundles are available afterwards. Never throws (degrades to unavailable).
 */
let ensuredPromise = null
async function ensureData(opts) {
    if (opts && opts.force) ensuredPromise = null
    if (ensuredPromise) return ensuredPromise           // concurrency-safe: startup + export share one run
    const run = (async () => {
        const derivedPresent = DIMS.every(d => findFile(d.file))
        if (derivedPresent) return true
        try {
            // All three dimensions come from the single .xls, sheet B (all screened genes).
            // Reuse an already-downloaded copy if there is one; else fetch into the
            // writable cache dir (normally .mitocarta-cache/ beside the launch dir).
            let xlsPath = findFile(XLS_NAME)
            if (!xlsPath) {
                const dest = path.join(cacheDir(), XLS_NAME)
                if (await fetchToFile(XLS_URL, dest)) xlsPath = dest
            }
            if (xlsPath) {
                let rows = null
                try { rows = readXlsRows(fs.readFileSync(xlsPath)) }
                catch (pErr) { log.warn(`MitoCarta: .xls parse failed: ${pErr.message}`) }
                if (rows && rows.length) {
                    const {localization, subLoc, pathways} = xlsRowsToMaps(rows)
                    // localization → genome universe (keepEmpty); subLoc/pathways → within-mito universe.
                    if (localization.size) writeBundle('mitocarta_localization.json.gz', {id: 'mitoLocalization', label: 'Mitochondrial localization (MitoCarta)', _note: 'MitoCarta3.0 inventory (1,136 genes) vs the screened genome (~19,243)'}, localization, true)
                    if (subLoc.size) writeBundle('mitocarta_sublocalization.json.gz', {id: 'mitoSubLocalization', label: 'Sub-mitochondrial localization (MitoCarta)', _note: 'MitoCarta3.0_SubMitoLocalization; within-mito universe'}, subLoc, false)
                    if (pathways.size) writeBundle('mitocarta_pathways.json.gz', {id: 'mitoPathways', label: 'Mitochondrial pathway (MitoCarta)', _note: 'MitoCarta3.0_MitoPathways hierarchy (ancestors expanded); within-mito universe'}, pathways, false)
                } else {
                    // Didn't parse (corrupt/incomplete) → discard the CACHED copy so the next
                    // run re-downloads. A baked-in copy is left alone (read-only, not ours).
                    const cached = path.join(cacheDir(), XLS_NAME)
                    if (xlsPath === cached) { try { fs.unlinkSync(cached) } catch (_) { /* ignore */ } }
                }
            }
            cache.clear()
            return DIMS.some(d => findFile(d.file))
        } catch (err) { log.warn(`MitoCarta: ensureData failed: ${err.message}`); return false }
    })()
    // Memoize only SUCCESS (or the in-flight run): a transient failure nulls the memo so
    // a later call retries, instead of pinning "unavailable" for the whole process life.
    ensuredPromise = run.then(
        ok => { if (!ok) ensuredPromise = null; return ok },
        err => { ensuredPromise = null; throw err })
    return ensuredPromise
}

// ---------------------------------------------------------------------------
// Loader interface (mirrors genesets.js)
// ---------------------------------------------------------------------------
const cache = new Map()   // id -> {meta, genes:Map} | null

function loadLibrary(id) {
    if (cache.has(id)) return cache.get(id)
    const entry = DIMS.find(d => d.id === id)
    let lib = null
    if (entry) {
        const file = findFile(entry.file)   // baked into the image, else the runtime cache
        try {
            if (file) {
                const parsed = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf-8'))
                lib = {meta: parsed.meta || {id}, genes: new Map(Object.entries(parsed.genes || {}))}
            }
        } catch (err) { log.warn(`Failed to load MitoCarta library "${id}": ${err.message}`) }
    }
    cache.set(id, lib)
    return lib
}

/** Available dims (derived bundle present), in display order. */
function available() {
    const out = []
    for (const d of DIMS) { const lib = loadLibrary(d.id); if (lib) out.push({id: d.id, label: (lib.meta && lib.meta.label) || d.label, meta: lib.meta}) }
    return out
}
function libMap(id) { const lib = loadLibrary(id); return lib ? lib.genes : new Map() }
function meta(id) { const lib = loadLibrary(id); return lib ? lib.meta : null }

/** Per-gene annotation for the Gene Summary column: {mito, subLoc:[…]} | null.
 *  Non-mito genes are present in the lib with an empty term list, so membership is a
 *  NON-EMPTY-term test, not mere presence. */
function annotationFor(gene) {
    const g = String(gene || '').toUpperCase()
    const loc = loadLibrary('mitoLocalization')
    const terms = loc && loc.genes.get(g)
    if (!terms || !terms.length) return null   // absent OR non-mitochondrial ([])
    const sub = loadLibrary('mitoSubLocalization')
    const s = sub && sub.genes.get(g)
    return {mito: true, subLoc: (s && s.length) ? s : []}
}

function attributions() {
    return available().map(a => `${a.label}: ${META_BASE.source} (${META_BASE.license}), ${META_BASE.citation} — ${META_BASE.url}`)
}

function reset() { cache.clear(); ensuredPromise = null; cacheDirMemo = null }

module.exports = {
    ensureData, available, libMap, meta, annotationFor, attributions, loadLibrary, reset,
    xlsRowsToMaps, readXlsRows, cacheDir, findFile, isWritable,
    DIMS, MITO_TERM, DATA_DIR, XLS_URL, XLS_NAME,
}
