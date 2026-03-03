/**
 * Lollipop Plot SVG Generator
 *
 * Generates lollipop-style mutation plots for a given gene, showing
 * variant positions along the genomic region with impact color-coding.
 */

'use strict'

const IMPACT_COLORS = {
    HIGH: '#e74c3c',
    MODERATE: '#f39c12',
    LOW: '#3498db',
    MODIFIER: '#95a5a6'
}

const DEFAULT_COLOR = '#7f8c8d'

/**
 * Escape text for safe SVG embedding.
 */
function svgEscape(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

/**
 * Generate a lollipop plot SVG for a gene.
 *
 * @param {string} gene - Gene name
 * @param {Array} variants - Array of {chrom, pos, ref, alt, impact, curation_status}
 * @param {Object} [opts] - Options: width, height
 * @returns {string} SVG markup
 */
function generateLollipopSvg(gene, variants, opts = {}) {
    const width = opts.width || 900
    const height = opts.height || 340
    const margin = {top: 60, right: 40, bottom: 60, left: 60}

    if (!variants || variants.length === 0) {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" fill="#999">No variants for ${svgEscape(gene)}</text>
</svg>`
    }

    const plotW = width - margin.left - margin.right
    const plotH = height - margin.top - margin.bottom

    // Sort variants by position and compute range
    const sorted = variants.slice().sort((a, b) => Number(a.pos) - Number(b.pos))
    const positions = sorted.map(v => Number(v.pos))
    let minPos = Math.min(...positions)
    let maxPos = Math.max(...positions)
    if (minPos === maxPos) {
        minPos -= 100
        maxPos += 100
    }
    const pad = Math.max(1, Math.round((maxPos - minPos) * 0.05))
    minPos -= pad
    maxPos += pad

    // Stack overlapping lollipops: group by position, assign height by count
    const posGroups = {}
    for (const v of sorted) {
        const p = Number(v.pos)
        if (!posGroups[p]) posGroups[p] = []
        posGroups[p].push(v)
    }

    const maxStack = Math.max(...Object.values(posGroups).map(g => g.length))
    const stickMaxH = plotH - 30  // leave room for circles at top
    const circleR = Math.min(10, Math.max(5, plotW / (sorted.length * 3)))

    function xScale(pos) {
        return margin.left + ((pos - minPos) / (maxPos - minPos)) * plotW
    }

    // Build lollipops
    const lollipops = []
    for (const [posStr, group] of Object.entries(posGroups)) {
        const pos = Number(posStr)
        const x = xScale(pos)
        group.forEach((v, idx) => {
            const stackRatio = (idx + 1) / maxStack
            const stickH = Math.max(20, stickMaxH * stackRatio)
            const y = margin.top + plotH - stickH
            const color = IMPACT_COLORS[(v.impact || '').toUpperCase()] || DEFAULT_COLOR
            const label = `${v.chrom}:${v.pos} ${v.ref}>${v.alt}` +
                (v.impact ? ` (${v.impact})` : '') +
                (v.curation_status ? ` [${v.curation_status}]` : '')
            lollipops.push({x, y, stickH, color, label, v})
        })
    }

    // Build tick marks for the axis
    const range = maxPos - minPos
    const tickCount = Math.min(8, Math.max(3, Math.floor(plotW / 100)))
    const tickStep = niceStep(range, tickCount)
    const firstTick = Math.ceil(minPos / tickStep) * tickStep
    const ticks = []
    for (let t = firstTick; t <= maxPos; t += tickStep) {
        ticks.push(t)
    }

    const chrom = sorted[0].chrom || ''

    // --- Build SVG ---
    const lines = []
    lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`)
    lines.push(`<style>`)
    lines.push(`  .lollipop-title { font: bold 16px Arial, sans-serif; fill: #2c3e50; }`)
    lines.push(`  .lollipop-subtitle { font: 12px Arial, sans-serif; fill: #7f8c8d; }`)
    lines.push(`  .axis-label { font: 11px Arial, sans-serif; fill: #555; }`)
    lines.push(`  .axis-line { stroke: #bbb; stroke-width: 1; }`)
    lines.push(`  .gene-bar { fill: #2c3e50; rx: 4; }`)
    lines.push(`  .stick { stroke-width: 2; }`)
    lines.push(`  .dot { stroke: #fff; stroke-width: 1.5; }`)
    lines.push(`  .legend-text { font: 11px Arial, sans-serif; fill: #555; }`)
    lines.push(`  .tooltip-text { font: 10px Arial, sans-serif; fill: #333; }`)
    lines.push(`</style>`)

    // Background
    lines.push(`<rect width="${width}" height="${height}" fill="#fff" rx="4"/>`)

    // Title
    lines.push(`<text x="${width / 2}" y="24" text-anchor="middle" class="lollipop-title">${svgEscape(gene)} &#8212; Variant Lollipop Plot</text>`)
    lines.push(`<text x="${width / 2}" y="42" text-anchor="middle" class="lollipop-subtitle">${sorted.length} variant${sorted.length !== 1 ? 's' : ''} on ${svgEscape(chrom)}</text>`)

    // Gene bar (horizontal backbone)
    const barY = margin.top + plotH
    const barH = 8
    lines.push(`<rect x="${margin.left}" y="${barY - barH / 2}" width="${plotW}" height="${barH}" class="gene-bar"/>`)

    // Axis ticks
    for (const t of ticks) {
        const tx = xScale(t)
        lines.push(`<line x1="${tx}" y1="${barY + barH / 2 + 2}" x2="${tx}" y2="${barY + barH / 2 + 8}" class="axis-line"/>`)
        lines.push(`<text x="${tx}" y="${barY + barH / 2 + 20}" text-anchor="middle" class="axis-label">${formatPos(t)}</text>`)
    }

    // Axis label
    lines.push(`<text x="${width / 2}" y="${height - 8}" text-anchor="middle" class="axis-label">Genomic Position (${svgEscape(chrom)})</text>`)

    // Lollipop sticks and dots
    for (const lp of lollipops) {
        lines.push(`<line x1="${lp.x}" y1="${barY - barH / 2}" x2="${lp.x}" y2="${lp.y}" class="stick" stroke="${lp.color}"/>`)
        lines.push(`<circle cx="${lp.x}" cy="${lp.y}" r="${circleR}" fill="${lp.color}" class="dot">`)
        lines.push(`  <title>${svgEscape(lp.label)}</title>`)
        lines.push(`</circle>`)
    }

    // Legend
    const legendX = width - margin.right - 160
    const legendY = margin.top - 5
    let ly = legendY
    for (const [impact, color] of Object.entries(IMPACT_COLORS)) {
        lines.push(`<circle cx="${legendX}" cy="${ly}" r="5" fill="${color}"/>`)
        lines.push(`<text x="${legendX + 10}" y="${ly + 4}" class="legend-text">${impact}</text>`)
        ly += 16
    }

    lines.push(`</svg>`)
    return lines.join('\n')
}

/**
 * Compute a "nice" tick step for an axis.
 */
function niceStep(range, targetTicks) {
    const rough = range / targetTicks
    const magnitude = Math.pow(10, Math.floor(Math.log10(rough)))
    const residual = rough / magnitude
    let nice
    if (residual <= 1.5) nice = 1
    else if (residual <= 3) nice = 2
    else if (residual <= 7) nice = 5
    else nice = 10
    return nice * magnitude
}

/**
 * Format a genomic position for display.
 */
function formatPos(pos) {
    if (pos >= 1e6) return (pos / 1e6).toFixed(2) + 'M'
    if (pos >= 1e3) return (pos / 1e3).toFixed(1) + 'K'
    return String(pos)
}

module.exports = {generateLollipopSvg, IMPACT_COLORS}
