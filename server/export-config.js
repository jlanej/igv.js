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

    // Genome build for coordinate reference
    genomeBuild: 'hg38'
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

    return merged
}

module.exports = {DEFAULT_EXPORT_CONFIG, mergeWithDefaults}
