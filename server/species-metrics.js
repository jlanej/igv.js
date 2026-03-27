/**
 * Species Metrics Module
 *
 * Parses species-annotated BED files produced by kmer_denovo_filter
 * (kraken2_spans.bed.gz, kraken2_spans_expanded.bed.gz, kraken2_reads.bed.gz)
 * and provides per-variant species composition summaries for clinical review.
 *
 * Designed for clinical geneticists evaluating cross-species contamination
 * in de novo variant calls from trio sequencing data.
 */

const fs = require('fs')
const zlib = require('zlib')
const path = require('path')
const log = require('./logger')

// -------------------------------------------------------------------------
// BED column indices (0-based) matching kmer_denovo_filter output schema
// -------------------------------------------------------------------------
const COL = {
    CHROM: 0,
    START: 1,
    END: 2,
    TAXON_NAME: 3,
    DOMAIN: 4,
    GUARD_STATUS: 5,
    IS_NONHUMAN: 6,
    READ_NAME: 7,
    VARIANT: 8,
    READ_SET: 9,
    MAPQ: 10,
    SOFTCLIP_LEFT: 11,
    SOFTCLIP_RIGHT: 12,
    IS_SPLIT: 13,
    IS_SUPPLEMENTARY: 14
}

// Contamination assessment thresholds (fraction of non-human reads)
const CONTAMINATION_TIERS = [
    {label: 'clean',   max: 0.02, description: 'Minimal non-human signal (≤2%)'},
    {label: 'caution', max: 0.05, description: 'Low-level non-human signal (2–5%)'},
    {label: 'concern', max: 0.15, description: 'Moderate non-human signal (5–15%)'},
    {label: 'high',    min: 0.15, description: 'High non-human signal (>15%)'}
]

// Cache parsed BED data (keyed by file path → variant key → rows)
const bedCache = new Map()

/**
 * Read a BED file (plain text or gzipped) and return parsed rows.
 * Lines starting with '#' or 'track' are skipped as headers.
 *
 * @param {string} filePath - Absolute path to the BED file
 * @returns {Array<string[]>} Array of tab-split row arrays
 */
function readBedFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return []

    let content
    if (filePath.endsWith('.gz')) {
        const compressed = fs.readFileSync(filePath)
        content = zlib.gunzipSync(compressed).toString('utf-8')
    } else {
        content = fs.readFileSync(filePath, 'utf-8')
    }

    const rows = []
    for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('track')) continue
        rows.push(trimmed.split('\t'))
    }
    return rows
}

/**
 * Parse a BED file and index rows by variant key for fast lookup.
 * Results are cached per file path.
 *
 * @param {string} filePath - Path to the BED file
 * @returns {Map<string, Array<Object>>} variant key → parsed row objects
 */
function parseBedByVariant(filePath) {
    if (bedCache.has(filePath)) return bedCache.get(filePath)

    const variantMap = new Map()
    const rows = readBedFile(filePath)

    for (const cols of rows) {
        if (cols.length < 10) continue  // need at least variant column

        const variantKeys = (cols[COL.VARIANT] || '').split(',')
        const row = {
            chrom: cols[COL.CHROM],
            start: parseInt(cols[COL.START], 10),
            end: parseInt(cols[COL.END], 10),
            taxonName: cols[COL.TAXON_NAME] || 'Unknown',
            domain: cols[COL.DOMAIN] || 'Unknown',
            guardStatus: cols[COL.GUARD_STATUS] || 'Unknown',
            isNonhuman: cols[COL.IS_NONHUMAN] === 'true',
            readName: cols[COL.READ_NAME] || '',
            readSet: cols[COL.READ_SET] || '',
            mapq: cols[COL.MAPQ] !== undefined ? parseInt(cols[COL.MAPQ], 10) : 0,
            softclipLeft: cols[COL.SOFTCLIP_LEFT] !== undefined ? parseInt(cols[COL.SOFTCLIP_LEFT], 10) : 0,
            softclipRight: cols[COL.SOFTCLIP_RIGHT] !== undefined ? parseInt(cols[COL.SOFTCLIP_RIGHT], 10) : 0,
            isSplit: cols[COL.IS_SPLIT] === 'true',
            isSupplementary: cols[COL.IS_SUPPLEMENTARY] === 'true'
        }

        for (const vk of variantKeys) {
            const key = vk.trim()
            if (!key) continue
            if (!variantMap.has(key)) variantMap.set(key, [])
            variantMap.get(key).push(row)
        }
    }

    bedCache.set(filePath, variantMap)
    return variantMap
}

/**
 * Classify a non-human fraction into a contamination tier.
 *
 * @param {number} fraction - Fraction of non-human reads (0–1)
 * @returns {{label: string, description: string}}
 */
function classifyContamination(fraction) {
    for (const tier of CONTAMINATION_TIERS) {
        if (tier.max !== undefined && fraction <= tier.max) return tier
        if (tier.min !== undefined && fraction >= tier.min) return tier
    }
    return {label: 'unknown', description: 'Unable to classify'}
}

/**
 * Compute per-variant species metrics from BED rows.
 *
 * @param {Array<Object>} rows - Parsed BED rows for a single variant
 * @returns {Object} Species metrics summary
 */
function computeVariantMetrics(rows) {
    if (!rows || rows.length === 0) {
        return {
            totalReads: 0,
            nonhumanReads: 0,
            nonhumanFraction: 0,
            assessment: classifyContamination(0),
            domainCounts: {},
            guardCounts: {},
            topTaxa: [],
            readSetCounts: {DKA: 0, DKU: 0},
            splitReadCount: 0,
            clippingStats: {meanLeft: 0, meanRight: 0, highClipReads: 0}
        }
    }

    // Count unique reads (skip supplementary to avoid double counting)
    const primaryRows = rows.filter(r => !r.isSupplementary)
    const totalReads = primaryRows.length
    const nonhumanReads = primaryRows.filter(r => r.isNonhuman).length
    const nonhumanFraction = totalReads > 0 ? nonhumanReads / totalReads : 0

    // Domain breakdown
    const domainCounts = {}
    for (const r of primaryRows) {
        domainCounts[r.domain] = (domainCounts[r.domain] || 0) + 1
    }

    // Guard status breakdown
    const guardCounts = {}
    for (const r of primaryRows) {
        guardCounts[r.guardStatus] = (guardCounts[r.guardStatus] || 0) + 1
    }

    // Top taxa (species-level classification)
    const taxaCounts = {}
    for (const r of primaryRows) {
        if (r.taxonName && r.taxonName !== 'Unclassified') {
            taxaCounts[r.taxonName] = (taxaCounts[r.taxonName] || 0) + 1
        }
    }
    const topTaxa = Object.entries(taxaCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, count]) => ({name: name.replace(/_/g, ' '), count}))

    // Read set breakdown (DKA vs DKU)
    const readSetCounts = {DKA: 0, DKU: 0}
    for (const r of primaryRows) {
        if (r.readSet === 'DKA') readSetCounts.DKA++
        else if (r.readSet === 'DKU') readSetCounts.DKU++
    }

    // Split read count
    const splitReadCount = primaryRows.filter(r => r.isSplit).length

    // Clipping stats
    const clipLeftVals = primaryRows.map(r => r.softclipLeft).filter(v => !isNaN(v))
    const clipRightVals = primaryRows.map(r => r.softclipRight).filter(v => !isNaN(v))
    const meanLeft = clipLeftVals.length > 0
        ? Math.round((clipLeftVals.reduce((a, b) => a + b, 0) / clipLeftVals.length) * 10) / 10
        : 0
    const meanRight = clipRightVals.length > 0
        ? Math.round((clipRightVals.reduce((a, b) => a + b, 0) / clipRightVals.length) * 10) / 10
        : 0
    const highClipReads = primaryRows.filter(r => r.softclipLeft > 30 || r.softclipRight > 30).length

    return {
        totalReads,
        nonhumanReads,
        nonhumanFraction: Math.round(nonhumanFraction * 10000) / 10000,
        assessment: classifyContamination(nonhumanFraction),
        domainCounts,
        guardCounts,
        topTaxa,
        readSetCounts,
        splitReadCount,
        clippingStats: {meanLeft, meanRight, highClipReads}
    }
}

/**
 * Get species metrics for a specific variant from one or more BED files.
 *
 * @param {string} variantKey - Variant key in chr:pos:ref:alt format (0-based pos in BED)
 * @param {string[]} bedFiles - Array of BED file paths to query
 * @returns {Object} Aggregated species metrics
 */
function getVariantMetrics(variantKey, bedFiles) {
    const allRows = []
    for (const fp of bedFiles) {
        try {
            const variantMap = parseBedByVariant(fp)
            const rows = variantMap.get(variantKey) || []
            allRows.push(...rows)
        } catch (err) {
            log.warn(`Failed to parse BED file ${fp}: ${err.message}`)
        }
    }
    return computeVariantMetrics(allRows)
}

/**
 * Get a summary of species metrics across all variants in the BED file(s).
 *
 * @param {string[]} bedFiles - Array of BED file paths
 * @returns {Object} Global species summary
 */
function getGlobalSummary(bedFiles) {
    const allRows = []
    const variantKeys = new Set()

    for (const fp of bedFiles) {
        try {
            const variantMap = parseBedByVariant(fp)
            for (const [key, rows] of variantMap) {
                variantKeys.add(key)
                allRows.push(...rows)
            }
        } catch (err) {
            log.warn(`Failed to parse BED file ${fp}: ${err.message}`)
        }
    }

    const metrics = computeVariantMetrics(allRows)
    metrics.variantCount = variantKeys.size
    return metrics
}

/**
 * Clear cached BED data (useful for testing).
 */
function clearCache() {
    bedCache.clear()
}

module.exports = {
    readBedFile,
    parseBedByVariant,
    computeVariantMetrics,
    classifyContamination,
    getVariantMetrics,
    getGlobalSummary,
    clearCache,
    CONTAMINATION_TIERS,
    COL
}
