/**
 * Annotation Registry
 *
 * A small orchestration layer over a set of pluggable gene-annotation
 * providers. Each provider is a self-contained module exposing a uniform
 * contract:
 *
 *   { id, attribution,
 *     isEnabled(cfg) -> boolean,
 *     fetchBatch(genes, cfg) -> Promise<Map<UPPER_SYMBOL, obj|{error}>>,
 *     columns(cfg) -> [{header, key, width}],
 *     toRow(obj, cfg) -> { [key]: value } }
 *
 * Providers fail independently: a network timeout, missing bundled file, or
 * per-gene error yields blank cells plus an Annotation Status entry — never a
 * failed export. Live-API providers (gnomAD) and bundled-file providers
 * (ClinVar, gene-list membership) satisfy the same contract and are merged
 * into one namespaced per-gene object.
 *
 * NOTE: the legacy MyGene.info annotations (gene name/type/OMIM/pathways/
 * summary) remain wired directly in server.js for now; this registry hosts the
 * newer providers and is the extension point for future ones.
 */

'use strict'

const gnomad = require('./providers/gnomad-provider')
const clinvar = require('./providers/clinvar-provider')
const geneLists = require('./providers/genelist-provider')
const log = require('./logger')

// Column order in the Gene Summary sheet follows this array order.
const PROVIDERS = [gnomad, clinvar, geneLists]

function activeProviders(cfg) {
    return PROVIDERS.filter(p => {
        try { return p.isEnabled(cfg) } catch (err) {
            log.warn(`isEnabled() failed for provider ${p.id}: ${err.message}`)
            return false
        }
    })
}

/**
 * Fetch annotations for `genes` from every enabled provider.
 * @returns {Promise<{byGene: Map<gene, {[providerId]: obj|null}>, errors: []}>}
 */
async function annotate(genes, cfg) {
    const byGene = new Map()
    const errors = []
    for (const g of genes) byGene.set(g, {})

    const active = activeProviders(cfg)
    await Promise.all(active.map(async (p) => {
        let map
        try {
            map = await p.fetchBatch(genes, cfg)
        } catch (err) {
            errors.push({source: p.id, error: err.message})
            map = new Map()
        }
        for (const g of genes) {
            const obj = map.get(String(g).toUpperCase())
            if (obj && obj.error) {
                errors.push({source: p.id, gene: g, error: obj.error})
                byGene.get(g)[p.id] = null
            } else {
                byGene.get(g)[p.id] = obj || null
            }
        }
    }))

    return {byGene, errors}
}

/** Ordered union of Gene Summary column descriptors from enabled providers. */
function columns(cfg) {
    const cols = []
    for (const p of PROVIDERS) {
        try {
            if (p.isEnabled(cfg)) cols.push(...p.columns(cfg))
        } catch (err) {
            log.warn(`columns() failed for provider ${p.id}: ${err.message}`)
        }
    }
    return cols
}

/** Flatten one gene's per-provider objects into row cells. */
function applyCells(perGene, cfg) {
    const cells = {}
    for (const p of PROVIDERS) {
        try {
            if (!p.isEnabled(cfg)) continue
            const obj = perGene ? perGene[p.id] : null
            Object.assign(cells, p.toRow(obj, cfg))
        } catch (err) {
            log.warn(`toRow() failed for provider ${p.id}: ${err.message}`)
        }
    }
    return cells
}

/** One data-source/licence line per enabled provider (for Annotation Status). */
function attributions(cfg) {
    const out = []
    for (const p of PROVIDERS) {
        try {
            if (p.isEnabled(cfg) && p.attribution) out.push({source: p.id, details: p.attribution})
        } catch (err) { /* ignore */ }
    }
    return out
}

module.exports = {annotate, columns, applyCells, attributions, PROVIDERS}
