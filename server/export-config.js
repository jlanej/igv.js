/**
 * Export Configuration
 *
 * Defines the default export settings and provides persistence helpers.
 * The config controls which sheets, columns, annotations, and visual
 * elements (IGV screenshots, lollipop plots) are included in XLSX/HTML
 * exports.  Configs can be saved to / loaded from a JSON file on disk,
 * following the same pattern as filter configurations.
 */

'use strict'

/**
 * Default export configuration.
 * Every key is a toggleable boolean or a structured setting.
 */
const DEFAULT_EXPORT_CONFIG = {
    // Worksheets to include in XLSX
    sheets: {
        variants: true,           // Main variants sheet (always true)
        geneSummary: true,        // Gene summary tab
        sampleSummary: true,      // Sample summary tab
        sampleQc: true,           // Sample QC tab (if data exists)
        appliedFilters: true,     // Applied filters tab
        annotationStatus: true    // Annotation status / failure tracking
    },

    // Visual elements
    igvScreenshots: true,         // Capture & embed IGV screenshots
    lollipopPlots: true,          // Generate & embed lollipop plots
    proteinDomains: true,         // Fetch protein domains for lollipop plots

    // Gene annotations (fetched from MyGene.info)
    geneAnnotations: {
        enabled: true,            // Master toggle
        geneName: true,           // Full gene name
        summary: true,            // Gene function summary
        omim: true,               // OMIM disease associations
        pathways: true,           // KEGG pathway memberships
        geneType: true            // Gene biotype
    },

    // Variant column categories to include in export
    variantColumns: {
        coreVariant: true,        // chrom, pos, ref, alt
        geneInfo: true,           // gene, impact, inheritance
        frequency: true,          // freq* columns
        quality: true,            // quality
        genotypes: true,          // *_gt columns
        allelicDepth: true,       // *_AD columns
        genotypeQuality: true,    // *_GQ columns
        sampleInfo: true,         // sample_id, trio_id
        filePaths: true,          // *_file, *_index, *_vcf, *_vcf_id columns
        otherAnnotations: true    // All other annotation columns
    },

    // Genome build for coordinate reference
    genomeBuild: 'hg38'
}

/**
 * Categorise a column name into a variantColumns group.
 * @param {string} col - Column header name (e.g. 'chrom', 'child_file', 'gene')
 * @returns {string} Category key matching a variantColumns config property
 */
function categoriseColumn(col) {
    if (['chrom', 'pos', 'ref', 'alt'].includes(col)) return 'coreVariant'
    if (['gene', 'impact', 'inheritance'].includes(col)) return 'geneInfo'
    if (col.startsWith('freq')) return 'frequency'
    if (col === 'quality') return 'quality'
    if (col.endsWith('_gt')) return 'genotypes'
    if (col.endsWith('_AD')) return 'allelicDepth'
    if (col.endsWith('_GQ')) return 'genotypeQuality'
    if (['sample_id', 'trio_id'].includes(col)) return 'sampleInfo'
    if (col.endsWith('_file') || col.endsWith('_index') || col.endsWith('_vcf') || col.endsWith('_vcf_id')) return 'filePaths'
    return 'otherAnnotations'
}

/**
 * Filter columns based on variantColumns config.
 * Curation columns (curation_status, curation_note) are always included.
 * @param {string[]} columns - Array of column names to filter
 * @param {Object|null} variantColumnsCfg - variantColumns config object; null keeps all
 * @returns {string[]} Filtered array of column names
 */
function filterColumns(columns, variantColumnsCfg) {
    if (!variantColumnsCfg) return columns
    return columns.filter(col => {
        if (col === 'curation_status' || col === 'curation_note') return true
        const category = categoriseColumn(col)
        return variantColumnsCfg[category] !== false
    })
}

/**
 * Merge a partial config with defaults, ensuring all keys exist.
 */
function mergeWithDefaults(partial) {
    if (!partial || typeof partial !== 'object') return {...DEFAULT_EXPORT_CONFIG}

    const merged = {...DEFAULT_EXPORT_CONFIG, ...partial}

    // Deep-merge nested objects
    merged.sheets = {...DEFAULT_EXPORT_CONFIG.sheets, ...(partial.sheets || {})}
    merged.geneAnnotations = {...DEFAULT_EXPORT_CONFIG.geneAnnotations, ...(partial.geneAnnotations || {})}
    merged.variantColumns = {...DEFAULT_EXPORT_CONFIG.variantColumns, ...(partial.variantColumns || {})}

    return merged
}

module.exports = {DEFAULT_EXPORT_CONFIG, mergeWithDefaults, categoriseColumn, filterColumns}
