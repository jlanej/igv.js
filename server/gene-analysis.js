/**
 * Gene Analysis — convergence of singleton genes on shared attributes.
 *
 * Inverts the per-gene annotations: for each grouping dimension, maps
 * `term -> {individuals, genes}` over the variants in each stratification cell,
 * and keeps terms that recur.
 *
 * INDEPENDENT SIGNALS: the headline metric is the number of DISTINCT
 * INDIVIDUALS (probands/samples), NOT the number of variants. One individual
 * with several de novo hits in genes that share a term counts as 1 — so a
 * single hypermutated proband cannot masquerade as convergence. Distinct genes
 * are reported alongside (locus heterogeneity), so single-proband cohorts still
 * see gene-level convergence.
 *
 * Pure / deterministic (no I/O) so it is unit-testable in isolation.
 */

'use strict'

// Cumulative impact tiers (matches SAMPLE_SUMMARY_IMPACT_GROUPS in server.js).
const IMPACT_TIERS = [
    {key: 'HIGH', label: 'HIGH', impacts: ['HIGH']},
    {key: 'HIGH_MOD', label: 'HIGH+MOD', impacts: ['HIGH', 'MODERATE']},
    {key: 'HIGH_MOD_LOW', label: 'HIGH+MOD+LOW', impacts: ['HIGH', 'MODERATE', 'LOW']},
    // ALL: no impact restriction — includes MODIFIER, blank, and any other
    // impact value, so convergence is not limited to the HIGH/MOD/LOW set.
    {key: 'ALL', label: 'ALL', impacts: null}
]

// Curation strata.
const STATUS_FILTERS = [
    {key: 'pass', label: 'pass', match: (s) => s === 'pass'},
    {key: 'all', label: 'all', match: () => true}
]

// Grouping dimensions (v0). Each gene contributes a list of term strings per
// dimension in the `geneTerms` map supplied by the caller.
const DIMENSIONS = [
    {id: 'constraint', label: 'Constraint tail (gnomAD)'},
    {id: 'clinvar', label: 'ClinVar gene history'},
    {id: 'domain', label: 'Protein domain (InterPro)'}
]

// Broadest cell (superset of all others) — used to decide which terms to show.
const REF_CELL = 'all|ALL'

function buildCells() {
    const cells = []
    for (const st of STATUS_FILTERS) {
        for (const tier of IMPACT_TIERS) {
            cells.push({key: `${st.key}|${tier.key}`, label: `${st.label}·${tier.label}`,
                statusKey: st.key, tierKey: tier.key, st, tier})
        }
    }
    return cells
}

/**
 * @param {Array<Object>} variants
 * @param {Object} opts
 * @param {string} opts.geneCol
 * @param {string|null} opts.impactCol
 * @param {string|null} opts.sampleCol   individual identifier column (sample_id/trio_id)
 * @param {Map<string,{constraint:string[],clinvar:string[],domain:string[]}>} opts.geneTerms  keyed by UPPERCASE gene
 * @param {number} [opts.minCount=2]      keep a term with >= this many distinct individuals OR genes
 * @returns {{cells:Array, sections:Array, hasSamples:boolean}}
 */
function computeConvergence(variants, opts) {
    const {geneCol, impactCol, sampleCol, geneTerms, minCount = 2} = opts
    const cells = buildCells()

    // acc[dimId][term][cellKey] = {individuals:Set, genes:Set}
    const acc = {}
    for (const d of DIMENSIONS) acc[d.id] = {}
    const cellGenes = {}, cellInds = {}
    for (const c of cells) { cellGenes[c.key] = new Set(); cellInds[c.key] = new Set() }

    for (const v of variants) {
        const gene = geneCol ? v[geneCol] : null
        if (!gene) continue
        const terms = geneTerms.get(String(gene).toUpperCase())
        if (!terms) continue
        const upper = String(gene).toUpperCase()
        const impact = impactCol ? String(v[impactCol] || '').toUpperCase() : ''
        const status = v.curation_status
        // The independent unit: the proband/sample. Falls back to a single
        // 'all' bucket when the data has no sample column.
        const individual = sampleCol ? (v[sampleCol] || 'unknown') : 'all'

        for (const c of cells) {
            if (!c.st.match(status)) continue
            // tier.impacts === null (ALL) means no impact restriction.
            if (impactCol && c.tier.impacts && !c.tier.impacts.includes(impact)) continue
            cellGenes[c.key].add(upper)
            cellInds[c.key].add(individual)
            for (const d of DIMENSIONS) {
                const tlist = terms[d.id] || []
                for (const term of tlist) {
                    const bucket = acc[d.id][term] || (acc[d.id][term] = {})
                    const cd = bucket[c.key] || (bucket[c.key] = {individuals: new Set(), genes: new Set()})
                    cd.individuals.add(individual)   // <-- dedup by individual
                    cd.genes.add(upper)
                }
            }
        }
    }

    const sections = DIMENSIONS.map(d => {
        const groups = []
        for (const term of Object.keys(acc[d.id])) {
            const bucket = acc[d.id][term]
            const ref = bucket[REF_CELL] || {individuals: new Set(), genes: new Set()}
            const refIndividuals = ref.individuals.size
            const refGenes = ref.genes.size
            if (refIndividuals < minCount && refGenes < minCount) continue
            const cellCounts = {}
            for (const c of cells) {
                const cd = bucket[c.key]
                cellCounts[c.key] = cd ? {individuals: cd.individuals.size, genes: cd.genes.size}
                    : {individuals: 0, genes: 0}
            }
            groups.push({term, refIndividuals, refGenes, cells: cellCounts, genes: [...ref.genes].sort()})
        }
        // Rank by independent recurrence first (individuals), then locus heterogeneity (genes).
        groups.sort((a, b) => b.refIndividuals - a.refIndividuals || b.refGenes - a.refGenes || a.term.localeCompare(b.term))
        return {id: d.id, label: d.label, groups}
    })

    const cellSummary = cells.map(c => ({
        key: c.key, label: c.label, statusKey: c.statusKey, tierKey: c.tierKey,
        genes: cellGenes[c.key].size, individuals: cellInds[c.key].size
    }))

    return {cells: cellSummary, sections, hasSamples: !!sampleCol}
}

/** Derive the per-gene term lists (v0 dimensions) from the assembled annotations. */
function geneTermsFor(gene, providerObj, myGeneAnn) {
    const constraint = []
    const g = providerObj && providerObj.gnomad
    if (g && !g.error) {
        if (typeof g.loeuf === 'number' && g.loeuf < 0.6) constraint.push('LOEUF < 0.6 (LoF-constrained)')
        if (typeof g.pli === 'number' && g.pli >= 0.9) constraint.push('pLI ≥ 0.9')
    }
    const clinvar = []
    const c = providerObj && providerObj.clinvar
    if (c && !c.error && c.plp > 0) clinvar.push('Has ClinVar P/LP')
    const domain = (myGeneAnn && !myGeneAnn.error && Array.isArray(myGeneAnn.domains)) ? myGeneAnn.domains : []
    return {constraint, clinvar, domain}
}

module.exports = {computeConvergence, geneTermsFor, DIMENSIONS, IMPACT_TIERS, STATUS_FILTERS}
