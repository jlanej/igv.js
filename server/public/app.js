/**
 * IGV Variant Review - Client Application
 *
 * Provides dynamic variant filtering, IGV-based trio alignment viewing,
 * manual curation workflow, and gene-level summarization.
 */

/* global igv */

(function () {
    'use strict'

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------
    let config = {}
    let currentPage = 1
    let perPage = 50
    let totalPages = 1
    let totalFiltered = 0
    let sortField = ''
    let sortOrder = ''
    let variants = []
    let selectedIds = new Set()
    let activeVariantId = null
    let igvBrowser = null
    let filterOptions = {}

    // -----------------------------------------------------------------------
    // Init
    // -----------------------------------------------------------------------
    async function init() {
        try {
            const [cfgRes, filterRes] = await Promise.all([
                fetch('/api/config').then(r => r.json()),
                fetch('/api/filters').then(r => r.json())
            ])
            config = cfgRes
            filterOptions = filterRes

            document.getElementById('stat-total').textContent = config.totalVariants

            buildFilterPanel()
            setupTabs()
            setupCurationButtons()
            setupExport()
            setupPagination()

            await loadVariants()
        } catch (err) {
            console.error('Init failed:', err)
            document.querySelector('main').innerHTML =
                '<p style="padding:40px;color:red;">Failed to connect to server. Is the server running?</p>'
        }
    }

    // -----------------------------------------------------------------------
    // Filter panel
    // -----------------------------------------------------------------------
    function buildFilterPanel() {
        const container = document.getElementById('filter-controls')
        container.innerHTML = ''

        // Curation status filter
        const curationGroup = createFilterGroup('curation_status', filterOptions['curation_status'] || [])
        container.appendChild(curationGroup)

        for (const col of config.columns) {
            if (col === 'curation_status' || col === 'curation_note') continue

            const values = filterOptions[col]
            if (values) {
                // Categorical filter (dropdown)
                container.appendChild(createFilterGroup(col, values))
            } else {
                // Numeric / text range or free-text
                const isNumeric = ['pos', 'quality'].includes(col) || col.startsWith('freq')
                if (isNumeric) {
                    container.appendChild(createRangeFilter(col))
                }
            }
        }
    }

    function createFilterGroup(col, options) {
        const div = document.createElement('div')
        div.className = 'filter-group'
        div.innerHTML = `<label>${formatLabel(col)}</label>
            <select data-filter="${col}">
                <option value="">All</option>
                ${options.map(o => `<option value="${o}">${o}</option>`).join('')}
            </select>`
        return div
    }

    function createRangeFilter(col) {
        const div = document.createElement('div')
        div.className = 'filter-group'
        div.innerHTML = `<label>${formatLabel(col)}</label>
            <div class="range-inputs">
                <input type="number" step="any" placeholder="Min" data-filter="${col}_min">
                <input type="number" step="any" placeholder="Max" data-filter="${col}_max">
            </div>`
        return div
    }

    function getActiveFilters() {
        const params = {}
        document.querySelectorAll('[data-filter]').forEach(el => {
            const key = el.dataset.filter
            const val = el.value.trim()
            if (val) params[key] = val
        })
        return params
    }

    function clearFilters() {
        document.querySelectorAll('[data-filter]').forEach(el => { el.value = '' })
        currentPage = 1
        loadVariants()
    }

    // -----------------------------------------------------------------------
    // Variant loading
    // -----------------------------------------------------------------------
    async function loadVariants() {
        const filters = getActiveFilters()
        const params = new URLSearchParams({
            ...filters,
            page: currentPage,
            per_page: perPage
        })
        if (sortField) {
            params.set('sort', sortField)
            params.set('order', sortOrder)
        }

        const res = await fetch(`/api/variants?${params}`)
        const data = await res.json()

        variants = data.data
        totalFiltered = data.total
        totalPages = data.pages
        currentPage = data.page

        renderTable()
        updateStats()
        updatePagination()
    }

    // -----------------------------------------------------------------------
    // Table rendering
    // -----------------------------------------------------------------------
    function renderTable() {
        const displayCols = getDisplayColumns()

        // Header
        const headerRow = document.getElementById('table-header')
        headerRow.innerHTML = '<th><input type="checkbox" id="header-check"></th>' +
            displayCols.map(col => {
                let cls = ''
                if (sortField === col) cls = sortOrder === 'asc' ? 'sort-asc' : 'sort-desc'
                return `<th class="${cls}" data-sort="${col}">${formatLabel(col)}</th>`
            }).join('') +
            '<th>Curation</th>'

        // Body
        const tbody = document.getElementById('table-body')
        tbody.innerHTML = variants.map(v => {
            const isSelected = selectedIds.has(v.id)
            const isActive = v.id === activeVariantId
            const rowClass = isActive ? 'active-variant' : isSelected ? 'selected' : ''
            return `<tr class="${rowClass}" data-id="${v.id}">
                <td><input type="checkbox" class="row-check" ${isSelected ? 'checked' : ''}></td>
                ${displayCols.map(col => `<td title="${escapeHtml(String(v[col] || ''))}">${escapeHtml(String(v[col] || ''))}</td>`).join('')}
                <td><span class="badge badge-${v.curation_status || 'pending'}">${v.curation_status || 'pending'}</span></td>
            </tr>`
        }).join('')

        // Event listeners
        document.getElementById('header-check').addEventListener('change', (e) => {
            const checked = e.target.checked
            variants.forEach(v => { if (checked) selectedIds.add(v.id); else selectedIds.delete(v.id) })
            renderTable()
        })

        tbody.querySelectorAll('tr').forEach(tr => {
            tr.addEventListener('click', (e) => {
                if (e.target.type === 'checkbox') return
                const id = parseInt(tr.dataset.id, 10)
                selectVariant(id)
            })
            tr.querySelector('.row-check').addEventListener('change', (e) => {
                const id = parseInt(tr.dataset.id, 10)
                if (e.target.checked) selectedIds.add(id); else selectedIds.delete(id)
                tr.classList.toggle('selected', e.target.checked)
            })
        })

        headerRow.querySelectorAll('[data-sort]').forEach(th => {
            th.addEventListener('click', () => {
                const col = th.dataset.sort
                if (sortField === col) {
                    sortOrder = sortOrder === 'asc' ? 'desc' : 'asc'
                } else {
                    sortField = col
                    sortOrder = 'asc'
                }
                loadVariants()
            })
        })
    }

    function getDisplayColumns() {
        const hide = new Set(['id', 'curation_status', 'curation_note'])
        return config.columns.filter(c => !hide.has(c))
    }

    // -----------------------------------------------------------------------
    // Variant selection & IGV
    // -----------------------------------------------------------------------
    async function selectVariant(id) {
        activeVariantId = id
        const v = variants.find(x => x.id === id)
        if (!v) return

        renderTable()

        // Update IGV header
        document.getElementById('igv-title').textContent =
            `${v.chrom}:${v.pos} ${v.ref}→${v.alt} (${v.gene || 'unknown gene'})`
        document.getElementById('igv-curation').style.display = 'flex'
        document.getElementById('curation-note').value = v.curation_note || ''

        // Set up single-variant curation buttons
        document.querySelectorAll('#igv-curation [data-status]').forEach(btn => {
            btn.onclick = () => curateVariant(id, btn.dataset.status)
        })
        document.getElementById('btn-save-note').onclick = () => {
            curateVariant(id, null, document.getElementById('curation-note').value)
        }

        await showInIgv(v)
    }

    async function showInIgv(variant) {
        const pos = parseInt(variant.pos, 10)
        const flank = 100
        const locus = `${variant.chrom}:${Math.max(1, pos - flank)}-${pos + flank}`

        if (igvBrowser) {
            // Navigate existing browser
            await igvBrowser.search(locus)
            return
        }

        // Build tracks from variant's file references
        const tracks = buildTracks(variant)

        const igvDiv = document.getElementById('igv-div')
        igvDiv.innerHTML = ''

        // Load igv.js dynamically
        if (typeof igv === 'undefined') {
            await loadScript('/igv-dist/igv.esm.min.js')
        }

        const igvOptions = {
            genome: config.genome,
            locus: locus,
            tracks: tracks
        }

        igvBrowser = await igv.createBrowser(igvDiv, igvOptions)
    }

    function buildTracks(variant) {
        const tracks = []
        const members = [
            {label: 'child', prefix: 'child'},
            {label: 'mother', prefix: 'mother'},
            {label: 'father', prefix: 'father'}
        ]

        for (const m of members) {
            const fileCol = `${m.prefix}_file`
            const indexCol = `${m.prefix}_index`
            const file = variant[fileCol]
            if (!file) continue

            const url = file.startsWith('http') ? file : `/data/${file}`
            const track = {
                type: 'alignment',
                name: `${m.label} (${variant[`${m.prefix}_gt`] || ''})`.trim(),
                url: url,
                height: 200,
                sort: {
                    chr: variant.chrom,
                    position: parseInt(variant.pos, 10),
                    option: 'BASE',
                    direction: 'ASC'
                }
            }

            const idx = variant[indexCol]
            if (idx) {
                track.indexURL = idx.startsWith('http') ? idx : `/data/${idx}`
            }

            const format = file.endsWith('.cram') ? 'cram' : file.endsWith('.bam') ? 'bam' : undefined
            if (format) track.format = format

            tracks.push(track)
        }

        // If no per-variant files, try building from config-level file columns
        if (tracks.length === 0) {
            // Fallback: check if there are any *_file columns at all
            for (const col of config.columns) {
                if (col.endsWith('_file') && variant[col]) {
                    const name = col.replace('_file', '')
                    const file = variant[col]
                    const url = file.startsWith('http') ? file : `/data/${file}`
                    tracks.push({
                        type: 'alignment',
                        name: name,
                        url: url,
                        height: 200
                    })
                }
            }
        }

        return tracks
    }

    async function loadScript(src) {
        return new Promise((resolve, reject) => {
            // For ES modules, use dynamic import
            if (src.endsWith('.esm.min.js') || src.endsWith('.esm.js')) {
                import(src).then(mod => {
                    window.igv = mod.default || mod
                    resolve()
                }).catch(reject)
            } else {
                const s = document.createElement('script')
                s.src = src
                s.onload = resolve
                s.onerror = reject
                document.head.appendChild(s)
            }
        })
    }

    // -----------------------------------------------------------------------
    // Curation
    // -----------------------------------------------------------------------
    async function curateVariant(id, status, note) {
        const body = {}
        if (status) body.status = status
        if (note !== undefined && note !== null) body.note = note

        const res = await fetch(`/api/variants/${id}/curate`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)
        })
        const updated = await res.json()

        // Update local state
        const idx = variants.findIndex(v => v.id === id)
        if (idx !== -1) variants[idx] = updated

        renderTable()
        updateStats()
    }

    async function batchCurate(status) {
        if (selectedIds.size === 0) return alert('No variants selected')

        const res = await fetch('/api/variants/batch/curate', {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ids: [...selectedIds], status})
        })
        await res.json()

        selectedIds.clear()
        await loadVariants()
    }

    // -----------------------------------------------------------------------
    // Gene summary
    // -----------------------------------------------------------------------
    async function loadSummary() {
        const filters = getActiveFilters()
        const params = new URLSearchParams(filters)
        const res = await fetch(`/api/summary?${params}`)
        const data = await res.json()

        document.getElementById('summary-info').textContent =
            `${data.total_genes || 0} genes with ${data.total_variants || 0} variants matching filters`

        const tbody = document.getElementById('summary-body')
        if (!data.summary || data.summary.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7">No gene data available</td></tr>'
            return
        }

        tbody.innerHTML = data.summary.map(g => `<tr>
            <td><span class="gene-link" data-gene="${escapeHtml(g.gene)}">${escapeHtml(g.gene)}</span></td>
            <td>${g.total}</td>
            <td class="curation-pass">${g.pass}</td>
            <td class="curation-fail">${g.fail}</td>
            <td class="curation-uncertain">${g.uncertain}</td>
            <td class="curation-pending">${g.pending}</td>
            <td>${g.variants.map(v =>
                `<span class="badge badge-${v.curation_status}" title="${v.chrom}:${v.pos} ${v.ref}→${v.alt}">${v.chrom}:${v.pos}</span> `
            ).join('')}</td>
        </tr>`).join('')

        // Gene click -> filter to gene
        tbody.querySelectorAll('.gene-link').forEach(el => {
            el.addEventListener('click', () => {
                const gene = el.dataset.gene
                const sel = document.querySelector('[data-filter="gene"]')
                if (sel) { sel.value = gene; loadVariants(); switchTab('variants') }
            })
        })
    }

    // -----------------------------------------------------------------------
    // Stats
    // -----------------------------------------------------------------------
    function updateStats() {
        document.getElementById('stat-filtered').textContent = totalFiltered
        let pass = 0, fail = 0, uncertain = 0, pending = 0
        variants.forEach(v => {
            if (v.curation_status === 'pass') pass++
            else if (v.curation_status === 'fail') fail++
            else if (v.curation_status === 'uncertain') uncertain++
            else pending++
        })
        document.getElementById('stat-pass').textContent = pass
        document.getElementById('stat-fail').textContent = fail
        document.getElementById('stat-uncertain').textContent = uncertain
        document.getElementById('stat-pending').textContent = pending
    }

    // -----------------------------------------------------------------------
    // Pagination
    // -----------------------------------------------------------------------
    function setupPagination() {
        document.getElementById('btn-prev').addEventListener('click', () => {
            if (currentPage > 1) { currentPage--; loadVariants() }
        })
        document.getElementById('btn-next').addEventListener('click', () => {
            if (currentPage < totalPages) { currentPage++; loadVariants() }
        })
    }

    function updatePagination() {
        document.getElementById('btn-prev').disabled = currentPage <= 1
        document.getElementById('btn-next').disabled = currentPage >= totalPages
        document.getElementById('page-info').textContent =
            `Page ${currentPage} of ${totalPages} (${totalFiltered} variants)`
    }

    // -----------------------------------------------------------------------
    // Tabs
    // -----------------------------------------------------------------------
    function setupTabs() {
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => switchTab(tab.dataset.tab))
        })
    }

    function switchTab(name) {
        document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name))
        document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${name}`))
        if (name === 'summary') loadSummary()
    }

    // -----------------------------------------------------------------------
    // Event setup
    // -----------------------------------------------------------------------
    function setupCurationButtons() {
        document.querySelectorAll('#filter-panel .curation-buttons [data-status]').forEach(btn => {
            btn.addEventListener('click', () => batchCurate(btn.dataset.status))
        })
    }

    function setupExport() {
        document.getElementById('btn-export').addEventListener('click', () => {
            const filters = getActiveFilters()
            const params = new URLSearchParams(filters)
            window.open(`/api/export?${params}`, '_blank')
        })

        document.getElementById('btn-apply-filters').addEventListener('click', () => {
            currentPage = 1
            loadVariants()
        })

        document.getElementById('btn-clear-filters').addEventListener('click', clearFilters)
    }

    // -----------------------------------------------------------------------
    // Utilities
    // -----------------------------------------------------------------------
    function formatLabel(col) {
        return col.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    }

    function escapeHtml(str) {
        const div = document.createElement('div')
        div.textContent = str
        return div.innerHTML
    }

    // -----------------------------------------------------------------------
    // Boot
    // -----------------------------------------------------------------------
    document.addEventListener('DOMContentLoaded', init)
})()
