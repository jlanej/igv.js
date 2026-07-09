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
        dataDictionary: true,     // "Read Me" guide + per-tab column dictionary
        geneSummary: true,        // Gene summary tab
        sampleSummary: true,      // Sample summary tab
        sampleQc: true,           // Sample QC tab (if data exists)
        appliedFilters: true,     // Applied filters tab
        annotationStatus: true    // Annotation status / failure tracking
    },

    // Per-gene impact counts on the Gene Summary tab (curation-derived, not
    // fetched). "passByImpact" counts HIGH/MODERATE/LOW variants that pass
    // review; "totalByImpact" counts them regardless of review status.
    // NOTE: only HIGH/MODERATE/LOW are counted — MODIFIER and blank impacts are
    // excluded, so the three pass columns need not sum to the Pass column.
    impactCounts: {
        passByImpact: true,
        totalByImpact: false
    },

    // Visual elements
    igvScreenshots: true,         // Capture & embed IGV screenshots
    lollipopPlots: true,          // Generate & embed lollipop plots
    proteinDomains: true,         // Fetch protein domains for lollipop plots

    // Gene annotations. Legacy flat flags below are MyGene.info fields; the
    // nested objects are pluggable providers registered in annotation-registry.js.
    geneAnnotations: {
        enabled: true,            // Master toggle (gates every provider)
        // --- MyGene.info fields (wired directly in server.js) ---
        geneName: true,           // Full gene name
        summary: true,            // Gene function summary
        omim: true,               // OMIM disease associations (MIM number)
        pathways: true,           // KEGG pathway memberships
        geneType: true,           // Gene biotype
        // --- Registry providers (each {enabled, ...sub-columns}) ---
        gnomadConstraint: {       // gnomAD gene constraint (live API)
            enabled: true,
            loeuf: true,          // LOEUF (oe_lof_upper)
            pli: true,            // pLI
            constrainedFlag: true, // derived Yes/No LoF-constrained flag
            misZ: false           // missense Z-score
        },
        clinvar: {                // ClinVar gene-level counts (bundled file)
            enabled: true,
            p: true,              // count of Pathogenic variants
            lp: true,             // count of Likely-pathogenic variants
            plp: false,           // combined P+LP count (off; P and LP shown separately)
            hasPlp: true,         // Yes/No has any P or LP
            vus: false,           // count of uncertain-significance variants
            conflicts: false      // count with conflicting classifications
        },
        geneLists: {              // Gene-list membership flags (bundled lists)
            enabled: true         // e.g. COSMIC / panel membership — see data/gene-lists
        }
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
    merged.variantColumns = {...DEFAULT_EXPORT_CONFIG.variantColumns, ...(partial.variantColumns || {})}
    merged.impactCounts = {...DEFAULT_EXPORT_CONFIG.impactCounts, ...(partial.impactCounts || {})}

    // geneAnnotations mixes flat flags with nested provider objects. A shallow
    // spread would let a partial that sets a single nested sub-flag (e.g.
    // {gnomadConstraint: {loeuf: false}}) drop the provider's other keys
    // (including `enabled`), so each nested provider object is merged in turn.
    merged.geneAnnotations = {...DEFAULT_EXPORT_CONFIG.geneAnnotations, ...(partial.geneAnnotations || {})}
    const pGA = partial.geneAnnotations || {}
    for (const key of ['gnomadConstraint', 'clinvar', 'geneLists']) {
        const base = DEFAULT_EXPORT_CONFIG.geneAnnotations[key] || {}
        const over = (pGA[key] && typeof pGA[key] === 'object') ? pGA[key] : {}
        merged.geneAnnotations[key] = {...base, ...over}
    }

    return merged
}

module.exports = {DEFAULT_EXPORT_CONFIG, mergeWithDefaults, categoriseColumn, filterColumns}
