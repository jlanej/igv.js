/**
 * Protein Domain Fetcher
 *
 * Fetches protein domain annotations from the UniProt REST API for a given
 * gene symbol.  Returns Pfam / InterPro domain positions on the canonical
 * (SwissProt-reviewed) human protein so they can be rendered on lollipop
 * plots.
 *
 * Results are cached in-memory so repeated lookups for the same gene are
 * instant.
 */

'use strict'

const UNIPROT_BASE = 'https://rest.uniprot.org/uniprotkb/search'

// In-memory cache: gene → {proteinLength, domains[], fetchedAt}
const cache = new Map()
const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24 hours

/**
 * Domain colors – visually distinct palette for rendering on the gene bar.
 */
const DOMAIN_PALETTE = [
    '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
    '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
    '#aec7e8', '#ffbb78', '#98df8a', '#ff9896', '#c5b0d5'
]

/**
 * Fetch protein domain data for a human gene from UniProt.
 *
 * @param {string} gene - HUGO gene symbol (e.g. "BRCA1", "TP53")
 * @returns {Promise<{proteinLength: number, domains: Array<{name: string, start: number, end: number, accession: string}>, accession: string} | null>}
 */
async function fetchProteinDomains(gene) {
    if (!gene) return null

    // Check cache
    const cached = cache.get(gene)
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
        return cached.data
    }

    try {
        // Query UniProt for reviewed human proteins matching this gene
        const url = `${UNIPROT_BASE}?query=gene:${encodeURIComponent(gene)}+AND+organism_id:9606+AND+reviewed:true&format=json&size=1`

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10000)

        const response = await fetch(url, {
            headers: {'Accept': 'application/json'},
            signal: controller.signal
        })
        clearTimeout(timeout)

        if (!response.ok) {
            return cacheAndReturn(gene, null)
        }

        const data = await response.json()
        if (!data.results || data.results.length === 0) {
            return cacheAndReturn(gene, null)
        }

        const entry = data.results[0]
        const accession = entry.primaryAccession || ''
        const proteinLength = entry.sequence ? entry.sequence.length : 0

        // Extract domain features
        const domains = []
        if (entry.features) {
            for (const feat of entry.features) {
                if (feat.type === 'Domain' || feat.type === 'Region') {
                    const start = feat.location && feat.location.start ? feat.location.start.value : null
                    const end = feat.location && feat.location.end ? feat.location.end.value : null
                    if (start != null && end != null) {
                        domains.push({
                            name: feat.description || feat.type,
                            start,
                            end,
                            accession: (feat.evidences && feat.evidences[0] && feat.evidences[0].id) || ''
                        })
                    }
                }
            }
        }

        // If no features were returned in the search (UniProt sometimes omits them from
        // search results), try fetching the full entry directly
        if (domains.length === 0 && accession) {
            const fullDomains = await fetchDomainsFromEntry(accession)
            if (fullDomains) {
                domains.push(...fullDomains)
            }
        }

        const result = {proteinLength, domains, accession}
        return cacheAndReturn(gene, result)
    } catch (err) {
        // Network errors, timeouts, etc. – return null gracefully
        return cacheAndReturn(gene, null)
    }
}

/**
 * Fetch domain features from a specific UniProt entry by accession.
 */
async function fetchDomainsFromEntry(accession) {
    try {
        const url = `https://rest.uniprot.org/uniprotkb/${encodeURIComponent(accession)}?format=json`

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10000)

        const response = await fetch(url, {
            headers: {'Accept': 'application/json'},
            signal: controller.signal
        })
        clearTimeout(timeout)

        if (!response.ok) return null

        const entry = await response.json()
        const domains = []
        if (entry.features) {
            for (const feat of entry.features) {
                if (feat.type === 'Domain' || feat.type === 'Region') {
                    const start = feat.location && feat.location.start ? feat.location.start.value : null
                    const end = feat.location && feat.location.end ? feat.location.end.value : null
                    if (start != null && end != null) {
                        domains.push({
                            name: feat.description || feat.type,
                            start,
                            end,
                            accession: (feat.evidences && feat.evidences[0] && feat.evidences[0].id) || ''
                        })
                    }
                }
            }
        }
        return domains.length > 0 ? domains : null
    } catch {
        return null
    }
}

function cacheAndReturn(gene, data) {
    cache.set(gene, {data, fetchedAt: Date.now()})
    return data
}

/**
 * Clear the domain cache (useful for testing).
 */
function clearCache() {
    cache.clear()
}

module.exports = {fetchProteinDomains, clearCache, DOMAIN_PALETTE}
