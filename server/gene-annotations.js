/**
 * Gene Annotation Fetcher
 *
 * Fetches gene-level annotations from MyGene.info – a free, high-performance
 * aggregation API that combines data from NCBI, UniProt, ClinVar, OMIM,
 * gnomAD, and other sources.  No API key required.
 *
 * Results are cached in-memory (24 h TTL) so repeated lookups for the same
 * gene are instant.  Batch queries (up to 1000 genes) are used to minimise
 * network round-trips and stay well within rate limits.
 *
 * Graceful fallback: if the API is unreachable or returns an error the
 * caller gets null and a machine-readable error string for reporting.
 */

'use strict'

const MYGENE_BASE = 'https://mygene.info/v3'
const MAX_PATHWAYS = 10

// Fields we request – kept minimal to reduce payload & latency.
// Covers: gene summary, genomic location, OMIM/MIM, KEGG pathways, and
// InterPro protein domains (used by the Gene Analysis convergence tab).
const QUERY_FIELDS = [
    'symbol', 'name', 'summary', 'type_of_gene',
    'genomic_pos', 'genomic_pos_hg19',
    'MIM', 'generif',
    'pathway.kegg', 'interpro'
].join(',')

// In-memory cache: gene → {data, fetchedAt}
const cache = new Map()
const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24 hours

/**
 * Fetch annotations for a single gene.
 *
 * @param {string} gene - HUGO gene symbol
 * @returns {Promise<{symbol, name, summary, mim, genomicPos, geneType, error} | null>}
 */
async function fetchGeneAnnotation(gene) {
    if (!gene) return null

    const cached = cache.get(gene)
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
        return cached.data
    }

    try {
        const url = `${MYGENE_BASE}/query?q=symbol:${encodeURIComponent(gene)}&species=human&fields=${QUERY_FIELDS}&size=1`

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10000)

        const response = await fetch(url, {
            headers: {'Accept': 'application/json'},
            signal: controller.signal
        })
        clearTimeout(timeout)

        if (!response.ok) {
            return cacheAndReturn(gene, {symbol: gene, error: `MyGene.info HTTP ${response.status}`})
        }

        const body = await response.json()
        if (!body.hits || body.hits.length === 0) {
            return cacheAndReturn(gene, {symbol: gene, error: 'Gene not found in MyGene.info'})
        }

        const hit = body.hits[0]
        const result = parseHit(hit, gene)
        return cacheAndReturn(gene, result)
    } catch (err) {
        const msg = err.name === 'AbortError' ? 'MyGene.info request timed out' : `MyGene.info error: ${err.message}`
        return cacheAndReturn(gene, {symbol: gene, error: msg})
    }
}

/**
 * Fetch annotations for multiple genes in a single batch request.
 * MyGene.info supports POST /query with q=symbol1,symbol2,... (up to 1000).
 *
 * @param {string[]} genes - Array of HUGO gene symbols
 * @returns {Promise<Map<string, object>>}  gene → annotation object
 */
async function fetchGeneAnnotationsBatch(genes) {
    if (!genes || genes.length === 0) return new Map()

    const results = new Map()
    const toFetch = []

    // Use cached results where available
    for (const gene of genes) {
        const cached = cache.get(gene)
        if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
            results.set(gene, cached.data)
        } else {
            toFetch.push(gene)
        }
    }

    if (toFetch.length === 0) return results

    // Batch in groups of 200 (well under the 1000 limit)
    const batchSize = 200
    for (let i = 0; i < toFetch.length; i += batchSize) {
        const batch = toFetch.slice(i, i + batchSize)
        try {
            const url = `${MYGENE_BASE}/query`
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 15000)

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json'
                },
                body: `q=${batch.join(',')}&scopes=symbol&species=human&fields=${QUERY_FIELDS}`,
                signal: controller.signal
            })
            clearTimeout(timeout)

            if (!response.ok) {
                // Mark all genes in this batch as failed
                for (const gene of batch) {
                    const err = {symbol: gene, error: `MyGene.info batch HTTP ${response.status}`}
                    results.set(gene, err)
                    cacheAndReturn(gene, err)
                }
                continue
            }

            const hits = await response.json()
            const hitMap = new Map()
            if (Array.isArray(hits)) {
                for (const hit of hits) {
                    if (hit.symbol) hitMap.set(hit.symbol, hit)
                    // Also try the query term
                    if (hit.query) hitMap.set(hit.query, hit)
                }
            }

            for (const gene of batch) {
                const hit = hitMap.get(gene)
                if (hit && !hit.notfound) {
                    const result = parseHit(hit, gene)
                    results.set(gene, result)
                    cacheAndReturn(gene, result)
                } else {
                    const err = {symbol: gene, error: 'Gene not found in MyGene.info'}
                    results.set(gene, err)
                    cacheAndReturn(gene, err)
                }
            }
        } catch (err) {
            const msg = err.name === 'AbortError' ? 'MyGene.info batch timed out' : `MyGene.info batch error: ${err.message}`
            for (const gene of batch) {
                const errObj = {symbol: gene, error: msg}
                results.set(gene, errObj)
                cacheAndReturn(gene, errObj)
            }
        }
    }

    return results
}

/**
 * Parse a MyGene.info hit into our annotation format.
 */
function parseHit(hit, gene) {
    const result = {
        symbol: hit.symbol || gene,
        name: hit.name || '',
        summary: hit.summary || '',
        geneType: hit.type_of_gene || '',
        mim: hit.MIM || null,
        genomicPos: null,
        pathways: [],
        domains: [],
        error: null
    }

    // Genomic position (hg38 preferred, hg19 fallback)
    if (hit.genomic_pos) {
        const gp = Array.isArray(hit.genomic_pos) ? hit.genomic_pos[0] : hit.genomic_pos
        if (gp && gp.chr && gp.start && gp.end) {
            result.genomicPos = {chr: `chr${gp.chr}`, start: gp.start, end: gp.end, strand: gp.strand}
        }
    }

    // KEGG pathways
    if (hit.pathway && hit.pathway.kegg) {
        const kegg = Array.isArray(hit.pathway.kegg) ? hit.pathway.kegg : [hit.pathway.kegg]
        result.pathways = kegg.map(p => ({id: p.id, name: p.name})).slice(0, MAX_PATHWAYS)
    }

    // InterPro protein domains (names) — for the Gene Analysis convergence tab
    if (hit.interpro) {
        const ip = Array.isArray(hit.interpro) ? hit.interpro : [hit.interpro]
        result.domains = [...new Set(ip.map(d => d && d.desc).filter(Boolean))]
    }

    return result
}

function cacheAndReturn(gene, data) {
    cache.set(gene, {data, fetchedAt: Date.now()})
    return data
}

/**
 * Clear the annotation cache (useful for testing).
 */
function clearAnnotationCache() {
    cache.clear()
}

module.exports = {fetchGeneAnnotation, fetchGeneAnnotationsBatch, clearAnnotationCache}
