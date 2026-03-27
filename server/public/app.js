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
    let curationCounts = {pass: 0, fail: 0, uncertain: 0, pending: 0}
    let allNotes = []

    // Runtime-adjustable IGV settings (initialized from server config +
    // localStorage overrides).  See setupIgvSettings().
    let igvSettings = {
        checkSequenceMD5: false
    }

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

            // Show Sample QC tab if QC data is loaded
            if (config.hasSampleQc) {
                const qcTab = document.getElementById('tab-btn-sample-qc')
                if (qcTab) qcTab.style.display = ''
            }

            buildFilterPanel()
            setupTabs()
            setupCurationButtons()
            setupExport()
            setupPagination()
            setupKeyboardShortcuts()
            setupShortcutsPanel()
            setupSidebarToggle()
            setupDisplayModeControl()
            setupIgvSettings()
            setupBedTrackControls()
            setupVariantSearch()
            setupNoteSuggestions()

            setupTableResize()
            await loadSavedFilters()

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
    // Maximum unique values for a category to display as checkboxes instead of a dropdown
    const CHECKBOX_THRESHOLD = 10

    // Functional filter conditions – each entry: {col, op, value}
    let functionalConditions = []

    function buildFilterPanel() {
        const container = document.getElementById('filter-controls')
        container.innerHTML = ''

        const categorical = filterOptions.categorical || {}
        const numericColumns = filterOptions.numeric || []

        // Curation status filter
        const curationValues = categorical['curation_status'] || []
        container.appendChild(createCheckboxGroup('curation_status', curationValues))

        for (const col of config.columns) {
            if (col === 'curation_status' || col === 'curation_note') continue

            if (numericColumns.includes(col)) {
                container.appendChild(createRangeFilter(col))
            } else {
                const values = categorical[col]
                if (values) {
                    if (values.length <= CHECKBOX_THRESHOLD) {
                        container.appendChild(createCheckboxGroup(col, values))
                    } else {
                        container.appendChild(createFilterGroup(col, values))
                    }
                }
            }
        }

        // Functional filter – OR conditions across any column
        container.appendChild(createFunctionalFilterGroup())

        setupFilterCollapseAll()
    }

    // -----------------------------------------------------------------------
    // Functional Filter
    // -----------------------------------------------------------------------

    const FUNCTIONAL_FILTER_OPS = [
        {value: 'in',       label: 'is one of (comma-separated)'},
        {value: 'eq',       label: 'equals'},
        {value: 'neq',      label: 'not equals'},
        {value: 'contains', label: 'contains'},
        {value: '>',        label: '> (greater than)'},
        {value: '>=',       label: '>= (greater or equal)'},
        {value: '<',        label: '< (less than)'},
        {value: '<=',       label: '<= (less or equal)'}
    ]

    function createFunctionalFilterGroup() {
        const div = document.createElement('div')
        div.className = 'filter-group'
        div.id = 'functional-filter-group'
        div.innerHTML = `
            <div class="filter-group-header" role="button" tabindex="0" aria-expanded="true">
                <span class="toggle-icon">▼</span>Functional Filter
            </div>
            <div class="filter-group-content">
                <p class="functional-filter-hint">OR conditions – a variant passes if <em>any</em> condition matches.</p>
                <div id="functional-filter-rows"></div>
                <button type="button" id="btn-add-condition" class="btn-secondary">+ Add Condition</button>
            </div>`
        setupFilterGroupToggle(div)

        // Render existing conditions (e.g. restored from saved config)
        renderFunctionalFilterRows()

        div.querySelector('#btn-add-condition').addEventListener('click', () => {
            functionalConditions.push({col: config.columns[0] || '', op: 'in', value: ''})
            renderFunctionalFilterRows()
        })

        return div
    }

    function renderFunctionalFilterRows() {
        const container = document.getElementById('functional-filter-rows')
        if (!container) return
        container.innerHTML = ''

        const colOptions = (config.columns || [])
            .filter(c => c !== 'curation_note')
            .map(c => `<option value="${escapeHtml(c)}">${formatLabel(c)}</option>`)
            .join('')

        const opOptions = FUNCTIONAL_FILTER_OPS
            .map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`)
            .join('')

        functionalConditions.forEach((cond, idx) => {
            const row = document.createElement('div')
            row.className = 'functional-condition-row'
            // For "in" operator, display values array as comma-separated string
            const displayVal = cond.op === 'in'
                ? (Array.isArray(cond.values) ? cond.values.join(', ') : (cond.value ?? ''))
                : (cond.value ?? '')
            row.innerHTML = `
                <select class="fc-col">
                    ${colOptions}
                </select>
                <select class="fc-op">
                    ${opOptions}
                </select>
                <input type="text" class="fc-val" placeholder="${cond.op === 'in' ? 'val1, val2, …' : 'value'}" value="${escapeHtml(String(displayVal))}">
                <button type="button" class="fc-remove btn-icon" title="Remove condition">×</button>`

            row.querySelector('.fc-col').value = cond.col
            row.querySelector('.fc-op').value = cond.op

            row.querySelector('.fc-col').addEventListener('change', e => {
                functionalConditions[idx].col = e.target.value
            })
            row.querySelector('.fc-op').addEventListener('change', e => {
                const newOp = e.target.value
                const valInput = row.querySelector('.fc-val')
                // Update placeholder when switching operators
                valInput.placeholder = newOp === 'in' ? 'val1, val2, …' : 'value'
                functionalConditions[idx].op = newOp
                // Migrate stored value ↔ values when toggling to/from "in"
                if (newOp === 'in') {
                    const raw = String(functionalConditions[idx].value ?? '')
                    functionalConditions[idx].values = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : []
                    delete functionalConditions[idx].value
                } else {
                    const raw = Array.isArray(functionalConditions[idx].values)
                        ? functionalConditions[idx].values.join(', ')
                        : (functionalConditions[idx].value ?? '')
                    functionalConditions[idx].value = raw
                    delete functionalConditions[idx].values
                }
            })
            row.querySelector('.fc-val').addEventListener('input', e => {
                if (functionalConditions[idx].op === 'in') {
                    // Store as values array (split on commas)
                    functionalConditions[idx].values = e.target.value
                        .split(',').map(s => s.trim()).filter(Boolean)
                } else {
                    functionalConditions[idx].value = e.target.value
                }
            })
            row.querySelector('.fc-remove').addEventListener('click', () => {
                functionalConditions.splice(idx, 1)
                renderFunctionalFilterRows()
            })

            container.appendChild(row)
        })
    }

    function createFilterGroup(col, options) {
        const div = document.createElement('div')
        div.className = 'filter-group'
        div.dataset.filterCol = col
        div.innerHTML = `<div class="filter-group-header" role="button" tabindex="0" aria-expanded="true"><span class="toggle-icon">▼</span>${formatLabel(col)}</div>
            <div class="filter-group-content">
            <select data-filter="${col}">
                <option value="">All</option>
                ${options.map(o => `<option value="${o}">${o}</option>`).join('')}
            </select>
            </div>`
        setupFilterGroupToggle(div)
        return div
    }

    function createCheckboxGroup(col, options) {
        const div = document.createElement('div')
        div.className = 'filter-group'
        div.dataset.filterCol = col
        div.innerHTML = `<div class="filter-group-header" role="button" tabindex="0" aria-expanded="true"><span class="toggle-icon">▼</span>${formatLabel(col)}</div>
            <div class="filter-group-content">
            <div class="checkbox-group" data-checkbox-filter="${col}">
                ${options.map(o => `<label class="checkbox-option">
                    <input type="checkbox" value="${escapeHtml(o)}"> ${escapeHtml(o)}
                </label>`).join('')}
            </div>
            </div>`
        setupFilterGroupToggle(div)
        return div
    }

    function createRangeFilter(col) {
        const div = document.createElement('div')
        div.className = 'filter-group'
        div.dataset.filterCol = col
        div.innerHTML = `<div class="filter-group-header" role="button" tabindex="0" aria-expanded="true"><span class="toggle-icon">▼</span>${formatLabel(col)}</div>
            <div class="filter-group-content">
            <div class="range-inputs">
                <input type="number" step="any" placeholder="Min" data-filter="${col}_min">
                <input type="number" step="any" placeholder="Max" data-filter="${col}_max">
            </div>
            </div>`
        setupFilterGroupToggle(div)
        return div
    }

    function setupFilterGroupToggle(groupEl) {
        const header = groupEl.querySelector('.filter-group-header')
        header.addEventListener('click', () => toggleFilterGroup(groupEl))
        header.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                toggleFilterGroup(groupEl)
            }
        })
    }

    function toggleFilterGroup(groupEl) {
        groupEl.classList.toggle('collapsed')
        const header = groupEl.querySelector('.filter-group-header')
        header.setAttribute('aria-expanded', !groupEl.classList.contains('collapsed'))
        updateCollapseAllButton()
    }

    function setupFilterCollapseAll() {
        const btn = document.getElementById('btn-toggle-all-filters')
        if (!btn) return
        btn.addEventListener('click', () => {
            const groups = document.querySelectorAll('#filter-controls .filter-group')
            const allCollapsed = [...groups].every(g => g.classList.contains('collapsed'))
            groups.forEach(g => {
                const header = g.querySelector('.filter-group-header')
                if (allCollapsed) {
                    g.classList.remove('collapsed')
                    if (header) header.setAttribute('aria-expanded', 'true')
                } else {
                    g.classList.add('collapsed')
                    if (header) header.setAttribute('aria-expanded', 'false')
                }
            })
            updateCollapseAllButton()
        })
    }

    function updateCollapseAllButton() {
        const btn = document.getElementById('btn-toggle-all-filters')
        if (!btn) return
        const groups = document.querySelectorAll('#filter-controls .filter-group')
        const allCollapsed = [...groups].every(g => g.classList.contains('collapsed'))
        btn.textContent = allCollapsed ? '▶ Expand All' : '▼ Collapse All'
        btn.setAttribute('aria-expanded', !allCollapsed)
    }

    function getActiveFilters() {
        const params = {}

        // Column-specific filters (dropdowns, range inputs)
        document.querySelectorAll('[data-filter]').forEach(el => {
            const key = el.dataset.filter
            const val = el.value.trim()
            if (val) params[key] = val
        })
        // Checkbox group filters (categorical multi-select)
        document.querySelectorAll('[data-checkbox-filter]').forEach(group => {
            const key = group.dataset.checkboxFilter
            const checked = [...group.querySelectorAll('input[type="checkbox"]:checked')]
                .map(cb => cb.value)
            if (checked.length > 0) params[key] = checked.join(',')
        })
        // Serialize functional conditions (skip incomplete rows)
        const activeConds = functionalConditions.filter(c => {
            if (!c.col || !c.op) return false
            // "in" operator requires a non-empty values array
            if (c.op === 'in') return Array.isArray(c.values) && c.values.length > 0
            // all other operators require a non-empty value string
            return String(c.value ?? '').trim() !== ''
        })
        if (activeConds.length > 0) {
            params.functional_filter = JSON.stringify(activeConds)
        }
        // Free-text search
        const searchInput = document.getElementById('variant-search')
        if (searchInput && searchInput.value.trim()) {
            params.search = searchInput.value.trim()
        }
        // Active sort (for reproducibility)
        if (sortField) {
            params.sort = sortField
            params.order = sortOrder || 'asc'
        }
        return params
    }

    function clearFilters() {
        document.querySelectorAll('[data-filter]').forEach(el => { el.value = '' })
        document.querySelectorAll('[data-checkbox-filter] input[type="checkbox"]').forEach(cb => { cb.checked = false })
        functionalConditions = []
        renderFunctionalFilterRows()
        const searchInput = document.getElementById('variant-search')
        if (searchInput) searchInput.value = ''
        sortField = ''
        sortOrder = ''
        currentPage = 1
        loadVariants()
    }

    // -----------------------------------------------------------------------
    // Variant loading
    // -----------------------------------------------------------------------
    async function loadVariants() {
        // getActiveFilters() already includes search and sort for reproducibility;
        // add pagination on top.
        const filters = getActiveFilters()
        const params = new URLSearchParams({
            ...filters,
            page: currentPage,
            per_page: perPage
        })

        const res = await fetch(`/api/variants?${params}`)
        const data = await res.json()

        variants = data.data
        totalFiltered = data.total
        totalPages = data.pages
        currentPage = data.page
        curationCounts = data.curation_counts || {pass: 0, fail: 0, uncertain: 0, pending: 0}
        allNotes = data.all_notes || []

        renderTable()
        updateStats()
        refreshNoteSuggestions()
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
            '<th>Curation</th>' +
            (config.hasSampleQc ? '<th title="Sample QC status (worst across trio)">QC</th>' : '')

        // Body
        const tbody = document.getElementById('table-body')
        tbody.innerHTML = variants.map(v => {
            const isSelected = selectedIds.has(v.id)
            const isActive = v.id === activeVariantId
            const curationClass = ['pass', 'fail', 'uncertain', 'pending'].includes(v.curation_status) ? `curation-${v.curation_status}` : 'curation-pending'
            const rowClass = [curationClass, isActive ? 'active-variant' : isSelected ? 'selected' : ''].filter(Boolean).join(' ')

            let qcCell = ''
            if (config.hasSampleQc) {
                const qcStatus = v._qc_status || ''
                if (qcStatus) {
                    const qcTitle = qcStatusTitle(v)
                    qcCell = `<td title="${escapeHtml(qcTitle)}"><span class="qc-warn-indicator qc-warn-${qcStatus}"></span><span class="qc-badge qc-badge-${qcStatus}">${qcStatus}</span></td>`
                } else {
                    qcCell = '<td></td>'
                }
            }

            return `<tr class="${rowClass}" data-id="${v.id}">
                <td><input type="checkbox" class="row-check" ${isSelected ? 'checked' : ''}></td>
                ${displayCols.map(col => `<td title="${escapeHtml(String(v[col] || ''))}">${escapeHtml(String(v[col] || ''))}</td>`).join('')}
                <td><span class="badge badge-${v.curation_status || 'pending'}">${v.curation_status || 'pending'}</span></td>
                ${qcCell}
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

    function esc(str) {
        const d = document.createElement('div')
        d.textContent = str
        return d.innerHTML
    }

    function buildIgvTitle(v) {
        let html = `<span class="igv-locus">${esc(v.chrom + ':' + v.pos)} ${esc(v.ref)}→${esc(v.alt)}</span>`
        html += ` <span class="igv-gene">${esc(v.gene || 'unknown gene')}</span>`

        // Allelic depths (AD) for trio members
        const adParts = []
        if (v.child_AD != null && v.child_AD !== '') adParts.push('C:' + esc(String(v.child_AD)))
        if (v.mother_AD != null && v.mother_AD !== '') adParts.push('M:' + esc(String(v.mother_AD)))
        if (v.father_AD != null && v.father_AD !== '') adParts.push('F:' + esc(String(v.father_AD)))
        if (adParts.length) html += ` <span class="igv-meta" title="Allelic Depth">AD ${adParts.join(' ')}</span>`

        // Genotype quality (GQ) for trio members
        const gqParts = []
        if (v.child_GQ != null && v.child_GQ !== '') gqParts.push('C:' + esc(String(v.child_GQ)))
        if (v.mother_GQ != null && v.mother_GQ !== '') gqParts.push('M:' + esc(String(v.mother_GQ)))
        if (v.father_GQ != null && v.father_GQ !== '') gqParts.push('F:' + esc(String(v.father_GQ)))
        if (gqParts.length) html += ` <span class="igv-meta" title="Genotype Quality">GQ ${gqParts.join(' ')}</span>`

        // Child DKA/DKT metric
        if (v.child_DKA_DKT != null && v.child_DKA_DKT !== '') {
            html += ` <span class="igv-meta" title="Child DKA/DKT">DKA/DKT ${esc(String(v.child_DKA_DKT))}</span>`
        }

        return html
    }

    function refreshNoteSuggestions() {
        const sel = document.getElementById('note-suggestions')
        if (!sel) return
        sel.innerHTML = '<option value="">Previous notes…</option>'
        allNotes.forEach(n => {
            const o = document.createElement('option')
            o.value = n
            o.textContent = n.length > 60 ? n.slice(0, 57) + '…' : n
            sel.appendChild(o)
        })
        sel.style.display = allNotes.length ? '' : 'none'
    }

    function setupNoteSuggestions() {
        const sel = document.getElementById('note-suggestions')
        if (!sel) return
        sel.addEventListener('change', () => {
            if (sel.value) {
                document.getElementById('curation-note').value = sel.value
                sel.value = ''
            }
        })
    }

    async function selectVariant(id) {
        activeVariantId = id
        const v = variants.find(x => x.id === id)
        if (!v) return

        renderTable()

        // Scroll the active row into view within the table (no full-page jump)
        const activeRow = document.querySelector('#table-body tr.active-variant')
        if (activeRow) activeRow.scrollIntoView({block: 'nearest', behavior: 'smooth'})

        // Update IGV header
        document.getElementById('igv-title').innerHTML = buildIgvTitle(v)
        document.getElementById('igv-curation').style.display = 'flex'
        document.getElementById('curation-note').value = v.curation_note || ''

        // Populate note suggestions from previously used notes
        refreshNoteSuggestions()

        // Set up single-variant curation buttons
        document.querySelectorAll('#igv-curation [data-status]').forEach(btn => {
            btn.onclick = () => curateVariant(id, btn.dataset.status)
        })
        document.getElementById('btn-save-note').onclick = () => {
            curateVariant(id, null, document.getElementById('curation-note').value)
        }

        await showInIgv(v)

        // Load species metrics if BED tracks are configured
        loadSpeciesMetrics(v)

        // Keep the IGV section visible after loading tracks
        const igvSection = document.getElementById('igv-section')
        if (igvSection) igvSection.scrollIntoView({block: 'nearest', behavior: 'smooth'})
    }

    async function showInIgv(variant) {
        const pos = parseInt(variant.pos, 10)
        const flank = 100
        const locus = `${variant.chrom}:${Math.max(1, pos - flank)}-${pos + flank}`

        // Build tracks from variant's file references
        const tracks = buildTracks(variant)

        if (igvBrowser) {
            // Remove existing tracks and load new ones for the selected variant
            igvBrowser.removeAllTracks()
            await igvBrowser.search(locus)
            await igvBrowser.loadTrackList(tracks)
            validateTrackLoading(tracks, variant)
            return
        }

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
        validateTrackLoading(tracks, variant)
    }

    /**
     * Validate that alignment tracks loaded successfully by checking whether
     * each expected track URL is reachable.  Displays per-track status below
     * the IGV viewer so the user can tell at a glance whether an empty
     * pileup is caused by a missing/inaccessible file vs. genuinely no reads.
     */
    async function validateTrackLoading(tracks, variant) {
        const statusDiv = document.getElementById('track-load-status')
        if (!statusDiv) return
        statusDiv.innerHTML = ''

        // Create all status spans up front
        const entries = tracks.map(t => {
            const label = t.name || t.url
            const span = document.createElement('span')
            span.className = 'track-status'
            span.textContent = `${label}: checking…`
            statusDiv.appendChild(span)
            return {label, span, url: t.url}
        })

        // Check all tracks concurrently
        await Promise.all(entries.map(async ({label, span, url}) => {
            try {
                const res = await fetch(url, {method: 'HEAD'})
                if (res.ok) {
                    span.className = 'track-status track-status-ok'
                    span.textContent = `${label}: ✓ file accessible`
                } else {
                    span.className = 'track-status track-status-error'
                    span.textContent = `${label}: ✗ HTTP ${res.status} – file not accessible`
                }
            } catch (err) {
                span.className = 'track-status track-status-error'
                span.textContent = `${label}: ✗ failed to reach file`
            }
        }))

        if (tracks.length === 0) {
            const span = document.createElement('span')
            span.className = 'track-status track-status-empty'
            span.textContent = '⚠ No alignment tracks configured for this variant'
            statusDiv.appendChild(span)
        }
    }

    function buildTracks(variant) {
        const tracks = []
        const sel = document.getElementById('display-mode-select')
        const displayMode = sel ? sel.value : 'SQUISHED'

        // Build per-variant VCF tracks from column data, or fall back to global config
        const vcfMembers = [
            {label: 'child', prefix: 'child'},
            {label: 'mother', prefix: 'mother'},
            {label: 'father', prefix: 'father'}
        ]
        const vcfMap = new Map() // url -> {indexURL, roles: [{label, sampleId}]}
        for (const m of vcfMembers) {
            const vcfFile = variant[`${m.prefix}_vcf`]
            if (!vcfFile) continue
            const url = vcfFile.startsWith('http') ? vcfFile : `/data/${vcfFile}`
            if (!vcfMap.has(url)) {
                const idx = variant[`${m.prefix}_vcf_index`]
                const indexURL = idx ? (idx.startsWith('http') ? idx : `/data/${idx}`) : undefined
                vcfMap.set(url, {indexURL, roles: []})
            }
            const sampleId = variant[`${m.prefix}_vcf_id`]
            if (sampleId) {
                vcfMap.get(url).roles.push({label: m.label, sampleId})
            }
        }

        if (vcfMap.size > 0) {
            for (const [url, {indexURL, roles}] of vcfMap) {
                const vcfTrack = {
                    type: 'variant',
                    format: 'vcf',
                    url: url,
                    displayMode: 'EXPANDED',
                    visibilityWindow: -1
                }
                if (indexURL) vcfTrack.indexURL = indexURL
                if (roles.length > 0) {
                    vcfTrack.name = `Trio VCF (${roles.map(r => `${r.label}: ${r.sampleId}`).join(', ')})`
                } else {
                    vcfTrack.name = 'Trio VCF'
                }
                tracks.push(vcfTrack)
            }
        } else if (config.vcfTrack) {
            // Fall back to global VCF track from --vcf CLI flag
            const vcfTrack = {
                type: 'variant',
                format: 'vcf',
                name: 'Trio VCF',
                url: config.vcfTrack.url,
                displayMode: 'EXPANDED'
            }
            if (config.vcfTrack.samples) {
                vcfTrack.visibilityWindow = -1
                const roles = Object.entries(config.vcfTrack.samples)
                    .map(([role, name]) => `${role}: ${name}`)
                    .join(', ')
                vcfTrack.name = `Trio VCF (${roles})`
            }
            tracks.push(vcfTrack)
        }

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
                displayMode: displayMode,
                colorBy: 'strand',
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

            // CRAM MD5 reference checks are disabled by default to avoid
            // spurious mismatches caused by concurrent reference-sequence
            // cache races in igv.js (see Known Issues in README).
            // Controlled at runtime via the ⚙ settings panel or on the
            // CLI with --check-md5.
            if (format === 'cram') {
                track.checkSequenceMD5 = !!igvSettings.checkSequenceMD5
            }

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
                        height: 200,
                        displayMode: displayMode,
                        colorBy: 'strand'
                    })
                }
            }
        }

        // -------------------------------------------------------------------
        // BED annotation tracks (species-annotated, from kmer_denovo_filter)
        // -------------------------------------------------------------------
        const bedTrackDisplayMode = getBedTrackDisplayMode()

        // Per-variant BED track columns from TSV
        if (config.bedColumns) {
            for (const col of config.bedColumns) {
                const file = variant[col]
                if (!file) continue
                const url = file.startsWith('http') ? file : `/data/${file}`
                const name = col.replace(/_/g, ' ').replace(/bed$/i, '').trim()
                const bedTrack = {
                    type: 'annotation',
                    format: 'bed',
                    name: name,
                    url: url,
                    displayMode: bedTrackDisplayMode,
                    height: 80,
                    color: getBedTrackColor(col),
                    visibilityWindow: -1
                }
                const idxCol = col + '_index'
                const idx = variant[idxCol]
                if (idx) {
                    bedTrack.indexURL = idx.startsWith('http') ? idx : `/data/${idx}`
                }
                tracks.push(bedTrack)
            }
        }

        // Global BED tracks from server config (--bed-tracks CLI)
        if (config.bedTracks && isBedTracksEnabled()) {
            for (const bt of config.bedTracks) {
                const bedTrack = {
                    type: 'annotation',
                    format: 'bed',
                    name: bt.name,
                    url: bt.url,
                    displayMode: bedTrackDisplayMode,
                    height: 80,
                    color: getBedTrackColor(bt.name),
                    visibilityWindow: -1
                }
                if (bt.indexURL) bedTrack.indexURL = bt.indexURL
                tracks.push(bedTrack)
            }
        }

        return tracks
    }

    /**
     * Get display mode for BED annotation tracks.
     * Reads from the BED track display mode selector if present,
     * otherwise defaults to EXPANDED.
     */
    function getBedTrackDisplayMode() {
        const sel = document.getElementById('bed-display-mode-select')
        return sel ? sel.value : 'EXPANDED'
    }

    /**
     * Check whether BED tracks are enabled via the toggle checkbox.
     */
    function isBedTracksEnabled() {
        const chk = document.getElementById('chk-bed-tracks')
        return chk ? chk.checked : true
    }

    /**
     * Assign colors to BED tracks based on their name/type for visual distinction.
     */
    function getBedTrackColor(name) {
        const lower = (name || '').toLowerCase()
        if (lower.includes('expanded')) return '#e67e22'   // orange for expanded spans
        if (lower.includes('span'))     return '#2980b9'   // blue for standard spans
        if (lower.includes('read'))     return '#27ae60'   // green for per-read detail
        return '#8e44ad'                                    // purple default
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
        refreshNoteSuggestions()
    }

    async function batchCurate(status) {
        if (selectedIds.size === 0) {
            showNotification('No variants selected', 'warn')
            return
        }

        const res = await fetch('/api/curate/batch', {
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
            tbody.innerHTML = '<tr><td colspan="10">No gene data available</td></tr>'
            return
        }

        tbody.innerHTML = data.summary.map(g => `<tr>
            <td><span class="gene-link" data-gene="${escapeHtml(g.gene)}">${escapeHtml(g.gene)}</span></td>
            <td>${g.total}</td>
            <td>${g.samples != null ? g.samples : ''}</td>
            <td class="curation-pass">${g.pass}</td>
            <td class="curation-fail">${g.fail}</td>
            <td class="curation-uncertain">${g.uncertain}</td>
            <td class="curation-pending">${g.pending}</td>
            <td>${g.variants.map(v =>
                `<span class="badge badge-${v.curation_status}" title="${v.chrom}:${v.pos} ${v.ref}→${v.alt}">${v.chrom}:${v.pos}</span> `
            ).join('')}</td>
            <td><button class="lollipop-btn" data-gene="${escapeHtml(g.gene)}" title="Lollipop plot for ${escapeHtml(g.gene)}">🍭 Plot</button></td>
            <td>
                <button class="gene-curate-btn curation-pass" data-gene="${escapeHtml(g.gene)}" data-status="pass" title="Flag all ${g.gene} as Pass">✓</button>
                <button class="gene-curate-btn curation-fail" data-gene="${escapeHtml(g.gene)}" data-status="fail" title="Flag all ${g.gene} as Fail">✗</button>
                <button class="gene-curate-btn curation-uncertain" data-gene="${escapeHtml(g.gene)}" data-status="uncertain" title="Flag all ${g.gene} as Uncertain">?</button>
            </td>
        </tr>`).join('')

        // Gene click -> filter to gene
        tbody.querySelectorAll('.gene-link').forEach(el => {
            el.addEventListener('click', () => {
                const gene = el.dataset.gene
                const sel = document.querySelector('[data-filter="gene"]')
                if (sel) { sel.value = gene; loadVariants(); switchTab('variants') }
            })
        })

        // Lollipop plot buttons
        tbody.querySelectorAll('.lollipop-btn').forEach(btn => {
            btn.addEventListener('click', () => showLollipopPlot(btn.dataset.gene))
        })

        // Gene curation buttons
        tbody.querySelectorAll('.gene-curate-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const gene = btn.dataset.gene
                const status = btn.dataset.status
                await curateGene(gene, status)
            })
        })
    }

    async function curateGene(gene, status) {
        try {
            const res = await fetch('/api/curate/gene', {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({gene, status})
            })
            const data = await res.json()
            if (res.ok) {
                showNotification(`Flagged ${data.updated} variants in ${gene} as ${status}`, 'success')
                await loadSummary()
                await loadVariants()
            } else {
                showNotification(data.error || 'Failed to flag gene', 'warn')
            }
        } catch (err) {
            showNotification('Failed to flag gene: ' + err.message, 'warn')
        }
    }

    // -----------------------------------------------------------------------
    // Lollipop plot modal
    // -----------------------------------------------------------------------
    async function showLollipopPlot(gene) {
        const modal = document.getElementById('lollipop-modal')
        const title = document.getElementById('lollipop-modal-title')
        const body = document.getElementById('lollipop-modal-body')

        title.textContent = `Lollipop Plot — ${gene}`
        body.innerHTML = '<p>Loading…</p>'
        modal.style.display = 'flex'

        try {
            const filters = getActiveFilters()
            const params = new URLSearchParams(filters)
            const res = await fetch(`/api/lollipop/${encodeURIComponent(gene)}?${params}`)
            if (!res.ok) {
                const err = await res.json()
                body.innerHTML = `<p style="color:#e74c3c">${err.error || 'Failed to load plot'}</p>`
                return
            }
            const svg = await res.text()
            body.innerHTML = svg
        } catch (err) {
            body.innerHTML = `<p style="color:#e74c3c">Error: ${err.message}</p>`
        }
    }

    // -----------------------------------------------------------------------
    // Sample summary
    // -----------------------------------------------------------------------
    async function loadSampleSummary() {
        const filters = getActiveFilters()
        const params = new URLSearchParams(filters)
        const res = await fetch(`/api/sample-summary?${params}`)
        const data = await res.json()

        document.getElementById('sample-summary-info').textContent =
            `${data.total_samples || 0} samples with ${data.total_variants || 0} variants matching filters`

        // --- Cohort summary table ---
        const cohortHead = document.getElementById('cohort-summary-header')
        const cohortBody = document.getElementById('cohort-summary-body')
        const impactGroups = data.impact_groups || []
        const thresholds = data.thresholds || []

        if (data.cohort_summary && impactGroups.length > 0) {
            let cHeaderHtml = '<th>Statistic</th>'
            for (const ig of impactGroups) {
                for (const t of thresholds) {
                    cHeaderHtml += `<th>${escapeHtml(ig)}<br><small>${escapeHtml(t)}</small></th>`
                }
            }
            cohortHead.innerHTML = cHeaderHtml

            let cohortRows = ''
            for (const stat of ['mean', 'median']) {
                let cells = `<td><strong>${stat.charAt(0).toUpperCase() + stat.slice(1)}</strong></td>`
                for (const ig of impactGroups) {
                    for (const t of thresholds) {
                        const val = (data.cohort_summary[ig] && data.cohort_summary[ig][t] && data.cohort_summary[ig][t][stat]) || 0
                        cells += `<td>${val}</td>`
                    }
                }
                cohortRows += `<tr>${cells}</tr>`
            }
            cohortBody.innerHTML = cohortRows
        } else {
            cohortHead.innerHTML = '<th>Statistic</th>'
            cohortBody.innerHTML = '<tr><td>No cohort data available</td></tr>'
        }

        // --- Per-sample table ---
        const thead = document.getElementById('sample-summary-header')
        const tbody = document.getElementById('sample-summary-body')

        if (!data.samples || data.samples.length === 0) {
            thead.innerHTML = '<th>Sample</th><th>Total</th>'
            tbody.innerHTML = '<tr><td colspan="2">No sample data available</td></tr>'
            return
        }

        // Build header: Sample | Unfiltered | Passing Filters | Curated | Pass | Fail | Uncertain | Pending | Flag Sample | impact_group × threshold combos
        let headerHtml = '<th>Sample</th><th>Unfiltered</th><th>Passing Filters</th>'
        headerHtml += '<th>Curated</th><th class="curation-pass">Pass</th><th class="curation-fail">Fail</th><th class="curation-uncertain">Uncertain</th><th class="curation-pending">Pending</th>'
        headerHtml += '<th>Flag Sample</th>'
        for (const ig of impactGroups) {
            for (const t of thresholds) {
                headerHtml += `<th>${escapeHtml(ig)}<br><small>${escapeHtml(t)}</small></th>`
            }
        }
        thead.innerHTML = headerHtml

        // Build body rows
        tbody.innerHTML = data.samples.map(s => {
            const cc = s.curation_counts || {pass: 0, fail: 0, uncertain: 0, pending: 0}
            const curated = cc.pass + cc.fail + cc.uncertain
            const pctFilter = s.total_unfiltered > 0 ? Math.round(s.total / s.total_unfiltered * 100) : 0
            const pctCurated = s.total > 0 ? Math.round(curated / s.total * 100) : 0
            const pctPass = curated > 0 ? Math.round(cc.pass / curated * 100) : 0
            const pctFail = curated > 0 ? Math.round(cc.fail / curated * 100) : 0
            const pctUncertain = curated > 0 ? Math.round(cc.uncertain / curated * 100) : 0
            const pctPending = s.total > 0 ? Math.round(cc.pending / s.total * 100) : 0

            let cells = `<td>${escapeHtml(s.sample_id)}</td>`
            cells += `<td>${s.total_unfiltered}</td>`
            cells += `<td>${s.total} (${pctFilter}%)</td>`
            cells += `<td>${curated} (${pctCurated}%)</td>`
            cells += `<td class="curation-pass">${cc.pass}${curated > 0 ? ' (' + pctPass + '%)' : ''}</td>`
            cells += `<td class="curation-fail">${cc.fail}${curated > 0 ? ' (' + pctFail + '%)' : ''}</td>`
            cells += `<td class="curation-uncertain">${cc.uncertain}${curated > 0 ? ' (' + pctUncertain + '%)' : ''}</td>`
            cells += `<td class="curation-pending">${cc.pending}${s.total > 0 ? ' (' + pctPending + '%)' : ''}</td>`
            cells += `<td>`
            cells += `<button class="sample-curate-btn curation-pass" data-sample="${escapeHtml(s.sample_id)}" data-status="pass" title="Flag all ${escapeHtml(s.sample_id)} variants as Pass">✓</button>`
            cells += `<button class="sample-curate-btn curation-fail" data-sample="${escapeHtml(s.sample_id)}" data-status="fail" title="Flag all ${escapeHtml(s.sample_id)} variants as Fail">✗</button>`
            cells += `<button class="sample-curate-btn curation-uncertain" data-sample="${escapeHtml(s.sample_id)}" data-status="uncertain" title="Flag all ${escapeHtml(s.sample_id)} variants as Uncertain">?</button>`
            cells += `</td>`
            for (const ig of impactGroups) {
                for (const t of thresholds) {
                    const count = (s.counts[ig] && s.counts[ig][t]) || 0
                    cells += `<td>${count}</td>`
                }
            }
            return `<tr>${cells}</tr>`
        }).join('')

        // Sample curation buttons
        tbody.querySelectorAll('.sample-curate-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const sample = btn.dataset.sample
                const status = btn.dataset.status
                await curateSample(sample, status)
            })
        })
    }

    async function curateSample(sample, status) {
        try {
            const res = await fetch('/api/curate/sample', {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({sample, status})
            })
            const data = await res.json()
            if (res.ok) {
                showNotification(`Flagged ${data.updated} variants in sample ${sample} as ${status}`, 'success')
                await loadSampleSummary()
                await loadVariants()
            } else {
                showNotification(data.error || 'Failed to flag sample', 'warn')
            }
        } catch (err) {
            showNotification('Failed to flag sample: ' + err.message, 'warn')
        }
    }

    // -----------------------------------------------------------------------
    // Sample QC
    // -----------------------------------------------------------------------
    async function loadSampleQc() {
        const res = await fetch('/api/sample-qc')
        const data = await res.json()

        const info = document.getElementById('sample-qc-info')
        const thead = document.getElementById('sample-qc-header')
        const tbody = document.getElementById('sample-qc-body')

        if (!data.loaded || !data.trios || data.trios.length === 0) {
            info.textContent = data.message || 'No sample QC data available'
            thead.innerHTML = '<th>Trio ID</th><th>Status</th>'
            tbody.innerHTML = '<tr><td colspan="2">No QC data loaded</td></tr>'
            return
        }

        info.textContent = `${data.total_trios} trios (${data.total_samples} samples) – ` +
            `Metrics: ${data.metric_columns.join(', ')}`

        const roles = ['proband', 'mother', 'father']
        const metrics = data.metric_columns || []
        const thresholds = data.thresholds || {}

        // Build header: Trio ID | QC Status | role × (sample_id + metrics)
        let headerHtml = '<th>Trio ID</th><th>QC Status</th>'
        for (const role of roles) {
            headerHtml += `<th>${escapeHtml(capitalize(role))}<br><small>Sample ID</small></th>`
            for (const m of metrics) {
                headerHtml += `<th>${escapeHtml(capitalize(role))}<br><small>${escapeHtml(m)}</small></th>`
            }
        }
        thead.innerHTML = headerHtml

        // Build body rows
        tbody.innerHTML = data.trios.map(trio => {
            let cells = `<td>${escapeHtml(trio.trio_id)}</td>`
            cells += `<td><span class="qc-badge qc-badge-${trio.qc_status}">${trio.qc_status}</span></td>`
            for (const role of roles) {
                const sid = (trio.members[role] && trio.members[role].sample_id) || ''
                cells += `<td>${escapeHtml(sid)}</td>`
                for (const m of metrics) {
                    const val = (trio.metrics[m] && trio.metrics[m][role]) != null ? trio.metrics[m][role] : ''
                    const cls = thresholds[m] ? qcCellClass(m, val, thresholds) : ''
                    cells += `<td class="${cls}" title="${escapeHtml(m)}: ${val}">${val}</td>`
                }
            }
            return `<tr>${cells}</tr>`
        }).join('')
    }

    /**
     * Return a CSS class for a QC metric cell based on the metric value
     * and configured thresholds.
     */
    function qcCellClass(metric, value, thresholds) {
        const tiers = thresholds[metric]
        if (!tiers) return ''
        const num = Number(value)
        if (isNaN(num)) return ''
        for (const tier of tiers) {
            if (tier.max !== undefined && num < tier.max) return `qc-cell-${tier.label}`
            if (tier.min !== undefined && num >= tier.min) return `qc-cell-${tier.label}`
        }
        return ''
    }

    /**
     * Build a tooltip string summarising per-metric QC statuses for a variant.
     */
    function qcStatusTitle(v) {
        if (!v._qc_statuses) return v._qc_status || ''
        return Object.entries(v._qc_statuses)
            .map(([m, s]) => `${m}: ${s}`)
            .join(', ')
    }

    function capitalize(s) {
        return s.charAt(0).toUpperCase() + s.slice(1)
    }

    // -----------------------------------------------------------------------
    // Stats
    // -----------------------------------------------------------------------
    function updateStats() {
        document.getElementById('stat-filtered').textContent = totalFiltered
        // Use server-provided counts across ALL variants (not just current page)
        document.getElementById('stat-pass').textContent = curationCounts.pass
        document.getElementById('stat-fail').textContent = curationCounts.fail
        document.getElementById('stat-uncertain').textContent = curationCounts.uncertain
        document.getElementById('stat-pending').textContent = curationCounts.pending
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
        if (name === 'sample-summary') loadSampleSummary()
        if (name === 'sample-qc') loadSampleQc()
    }

    // -----------------------------------------------------------------------
    // Event setup
    // -----------------------------------------------------------------------
    function setupCurationButtons() {
        document.querySelectorAll('#filter-panel .curation-buttons [data-status]').forEach(btn => {
            btn.addEventListener('click', () => batchCurate(btn.dataset.status))
        })
    }

    // -----------------------------------------------------------------------
    // Keyboard shortcuts
    // -----------------------------------------------------------------------
    function selectNextVariant() {
        if (variants.length === 0) return
        const curIdx = variants.findIndex(v => v.id === activeVariantId)
        const startIdx = curIdx === -1 ? 0 : curIdx + 1

        // Try to find next uncurated (pending) variant
        for (let i = 0; i < variants.length; i++) {
            const idx = (startIdx + i) % variants.length
            if (!variants[idx].curation_status || variants[idx].curation_status === 'pending') {
                selectVariant(variants[idx].id)
                return
            }
        }

        // All curated – fall back to normal next
        const nextIdx = curIdx === -1 ? 0 : (curIdx < variants.length - 1 ? curIdx + 1 : 0)
        selectVariant(variants[nextIdx].id)
    }

    function selectPrevVariant() {
        if (variants.length === 0) return
        const curIdx = variants.findIndex(v => v.id === activeVariantId)
        const startIdx = curIdx <= 0 ? variants.length - 1 : curIdx - 1

        // Try to find previous uncurated (pending) variant
        for (let i = 0; i < variants.length; i++) {
            const idx = (startIdx - i + variants.length) % variants.length
            if (!variants[idx].curation_status || variants[idx].curation_status === 'pending') {
                selectVariant(variants[idx].id)
                return
            }
        }

        // All curated – fall back to normal prev
        const prevIdx = curIdx <= 0 ? variants.length - 1 : curIdx - 1
        selectVariant(variants[prevIdx].id)
    }

    async function curateAndAdvance(status) {
        if (activeVariantId == null) return
        await curateVariant(activeVariantId, status)
        selectNextVariant()
    }

    function setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Ctrl+B toggles sidebar regardless of focus
            if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
                e.preventDefault()
                toggleSidebar()
                return
            }

            // Ignore shortcuts when typing in inputs or textareas
            const tag = (e.target.tagName || '').toLowerCase()
            if (tag === 'input' || tag === 'textarea' || tag === 'select') return

            switch (e.key) {
                case 'j':
                case 'ArrowDown':
                    e.preventDefault()
                    selectNextVariant()
                    break
                case 'k':
                case 'ArrowUp':
                    e.preventDefault()
                    selectPrevVariant()
                    break
                case 'p':
                    if (activeVariantId != null) curateVariant(activeVariantId, 'pass')
                    break
                case 'f':
                    if (activeVariantId != null) curateVariant(activeVariantId, 'fail')
                    break
                case 'u':
                    if (activeVariantId != null) curateVariant(activeVariantId, 'uncertain')
                    break
                case 'P':
                    curateAndAdvance('pass')
                    break
                case 'F':
                    curateAndAdvance('fail')
                    break
                case 'U':
                    curateAndAdvance('uncertain')
                    break
                case '?':
                    toggleShortcutsPanel()
                    break
            }
        })
    }

    function setupShortcutsPanel() {
        const toggle = document.getElementById('shortcuts-toggle')
        if (toggle) toggle.addEventListener('click', toggleShortcutsPanel)
    }

    function toggleShortcutsPanel() {
        const panel = document.getElementById('shortcuts-panel')
        if (panel) panel.classList.toggle('visible')
    }

    // -----------------------------------------------------------------------
    // Export Configuration
    // -----------------------------------------------------------------------
    let currentExportConfig = null

    async function loadExportConfig() {
        try {
            const res = await fetch('/api/export-config')
            if (res.ok) {
                currentExportConfig = await res.json()
                applyExportConfigToUI(currentExportConfig)
            }
        } catch (_) { /* defaults will be used */ }
    }

    function applyExportConfigToUI(cfg) {
        const panel = document.getElementById('export-config-panel')
        if (!panel) return
        const checkboxes = panel.querySelectorAll('input[type="checkbox"]')
        checkboxes.forEach(cb => {
            const key = cb.dataset.configKey
            if (!key) return
            const parts = key.split('.')
            let val = cfg
            for (const p of parts) {
                if (val && typeof val === 'object') val = val[p]
                else { val = undefined; break }
            }
            if (val !== undefined) cb.checked = !!val
        })
    }

    function getExportConfigFromUI() {
        const panel = document.getElementById('export-config-panel')
        if (!panel) return currentExportConfig || {}
        const cfg = {
            sheets: {
                variants: true,
                geneSummary: true,
                sampleSummary: true,
                sampleQc: true,
                appliedFilters: true,
                annotationStatus: true
            },
            igvScreenshots: true,
            lollipopPlots: true,
            proteinDomains: true,
            geneAnnotations: {
                enabled: true,
                geneName: true,
                summary: true,
                omim: true,
                pathways: true,
                geneType: true
            },
            variantColumns: {
                coreVariant: true,
                geneInfo: true,
                frequency: true,
                quality: true,
                genotypes: true,
                allelicDepth: true,
                genotypeQuality: true,
                sampleInfo: true,
                filePaths: true,
                otherAnnotations: true
            },
            genomeBuild: (currentExportConfig && currentExportConfig.genomeBuild) || 'hg38'
        }
        const checkboxes = panel.querySelectorAll('input[type="checkbox"]')
        checkboxes.forEach(cb => {
            const key = cb.dataset.configKey
            if (!key) return
            const parts = key.split('.')
            let target = cfg
            for (let i = 0; i < parts.length - 1; i++) {
                if (!target[parts[i]]) target[parts[i]] = {}
                target = target[parts[i]]
            }
            target[parts[parts.length - 1]] = cb.checked
        })
        return cfg
    }

    async function saveExportConfig() {
        const cfg = getExportConfigFromUI()
        try {
            const res = await fetch('/api/export-config', {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(cfg)
            })
            if (res.ok) {
                currentExportConfig = cfg
                showNotification('Export config saved', 'success')
            } else {
                showNotification('Failed to save export config', 'warn')
            }
        } catch (err) {
            showNotification('Failed to save export config', 'warn')
        }
    }

    function setupExport() {
        document.getElementById('btn-export').addEventListener('click', () => {
            const filters = getActiveFilters()
            const params = new URLSearchParams(filters)
            window.open(`/api/export?${params}`, '_blank')
        })

        document.getElementById('btn-export-xlsx').addEventListener('click', () => exportXlsx())

        document.getElementById('btn-export-html').addEventListener('click', () => exportHtml())

        // Lollipop modal close
        document.getElementById('lollipop-modal-close').addEventListener('click', () => {
            document.getElementById('lollipop-modal').style.display = 'none'
        })
        document.getElementById('lollipop-modal').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) e.currentTarget.style.display = 'none'
        })

        document.getElementById('btn-apply-filters').addEventListener('click', () => {
            currentPage = 1
            loadVariants()
        })

        document.getElementById('btn-clear-filters').addEventListener('click', clearFilters)

        document.getElementById('btn-save-filters').addEventListener('click', saveFilterConfig)
        document.getElementById('btn-load-filters').addEventListener('click', async () => {
            await loadSavedFilters()
            currentPage = 1
            await loadVariants()
            showNotification('Filters loaded', 'success')
        })

        // Export config panel
        const configToggle = document.getElementById('btn-export-config')
        if (configToggle) {
            configToggle.addEventListener('click', () => {
                const panel = document.getElementById('export-config-panel')
                if (panel) panel.classList.toggle('visible')
            })
        }
        const saveConfigBtn = document.getElementById('btn-save-export-config')
        if (saveConfigBtn) saveConfigBtn.addEventListener('click', saveExportConfig)
        const loadConfigBtn = document.getElementById('btn-load-export-config')
        if (loadConfigBtn) loadConfigBtn.addEventListener('click', async () => {
            await loadExportConfig()
            showNotification('Export config loaded', 'success')
        })

        // Load export config on startup
        loadExportConfig()
    }

    // -----------------------------------------------------------------------
    // XLSX Export with IGV screenshots
    // -----------------------------------------------------------------------
    async function exportXlsx() {
        const progressDiv = document.getElementById('xlsx-progress')
        const progressFill = document.getElementById('xlsx-progress-fill')
        const progressText = document.getElementById('xlsx-progress-text')
        const btn = document.getElementById('btn-export-xlsx')

        // Get export config from the UI panel
        const exportConfig = getExportConfigFromUI()

        // Fetch all filtered variants across pages
        const filters = getActiveFilters()
        let allVariants = []
        let page = 1
        while (true) {
            const params = new URLSearchParams({...filters, per_page: 200, page})
            const res = await fetch(`/api/variants?${params}`)
            const data = await res.json()
            allVariants = allVariants.concat(data.data)
            if (page >= data.pages) break
            page++
        }

        if (allVariants.length === 0) {
            showNotification('No variants to export', 'warn')
            return
        }

        btn.disabled = true
        progressDiv.style.display = 'block'
        progressText.textContent = 'Preparing screenshots…'
        progressFill.style.width = '0%'

        const screenshots = {}
        const variantIds = allVariants.map(v => v.id)

        // Capture IGV screenshots if enabled in config and the browser is available
        if (exportConfig.igvScreenshots && igvBrowser) {
            for (let i = 0; i < allVariants.length; i++) {
                const v = allVariants[i]
                const pct = Math.round(((i + 1) / allVariants.length) * 80)
                progressText.textContent = `Screenshot ${i + 1}/${allVariants.length}: ${v.chrom}:${v.pos}`
                progressFill.style.width = `${pct}%`

                try {
                    // Load variant-specific tracks and wait for data
                    await loadVariantForScreenshot(v)

                    // Capture the IGV div as a canvas image
                    const imgData = await captureIgvScreenshot()
                    if (imgData) {
                        screenshots[String(v.id)] = imgData
                    }
                } catch (err) {
                    console.warn(`Screenshot failed for variant ${v.id}:`, err)
                }
            }
        }

        // Generate lollipop plots for each gene (if enabled in config)
        const lollipopPlots = {}
        if (exportConfig.lollipopPlots) {
            progressText.textContent = 'Generating gene plots…'
            progressFill.style.width = '85%'
            const geneSet = new Set()
            for (const v of allVariants) {
                if (v.gene && v.curation_status === 'pass') geneSet.add(v.gene)
            }
            for (const gene of geneSet) {
                try {
                    const params = new URLSearchParams(filters)
                    const res = await fetch(`/api/lollipop/${encodeURIComponent(gene)}?${params}`)
                    if (!res.ok) continue
                    const svg = await res.text()
                    const pngData = await svgToPng(svg, 900, 340)
                    if (pngData) lollipopPlots[gene] = pngData
                } catch (err) {
                    console.warn(`Lollipop plot failed for ${gene}:`, err)
                }
            }
        }

        // Send to server for XLSX generation (with retry)
        progressText.textContent = 'Generating XLSX…'
        progressFill.style.width = '90%'

        const maxRetries = 2
        let lastError = null
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                if (attempt > 1) {
                    progressText.textContent = `Retrying XLSX generation (attempt ${attempt}/${maxRetries})…`
                }

                const xlsxRes = await fetch('/api/export/xlsx', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({variantIds, screenshots, lollipopPlots, filters, exportConfig})
                })

                if (!xlsxRes.ok) {
                    let msg = `Export failed (HTTP ${xlsxRes.status})`
                    try { const err = await xlsxRes.json(); msg = err.error || msg } catch (_) {}
                    throw new Error(msg)
                }

                const blob = await xlsxRes.blob()
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = 'variants_export.xlsx'
                document.body.appendChild(a)
                a.click()
                document.body.removeChild(a)
                URL.revokeObjectURL(url)

                progressText.textContent = 'Done!'
                progressFill.style.width = '100%'
                showNotification(`Exported ${allVariants.length} variants to XLSX`, 'success')
                lastError = null
                break
            } catch (err) {
                console.error(`XLSX export error (attempt ${attempt}/${maxRetries}):`, err)
                lastError = err
                if (attempt < maxRetries) {
                    // Brief pause before retry
                    await new Promise(r => setTimeout(r, 1000))
                }
            }
        }
        if (lastError) {
            showNotification('XLSX export failed: ' + lastError.message, 'warn')
        }
        btn.disabled = false
        setTimeout(() => { progressDiv.style.display = 'none' }, 2000)
    }

    // -----------------------------------------------------------------------
    // HTML Export with IGV screenshots
    // -----------------------------------------------------------------------
    async function exportHtml() {
        const progressDiv = document.getElementById('xlsx-progress')
        const progressFill = document.getElementById('xlsx-progress-fill')
        const progressText = document.getElementById('xlsx-progress-text')
        const btn = document.getElementById('btn-export-html')

        // Get export config from the UI panel
        const exportConfig = getExportConfigFromUI()

        // Fetch all filtered variants across pages
        const filters = getActiveFilters()
        let allVariants = []
        let page = 1
        while (true) {
            const params = new URLSearchParams({...filters, per_page: 200, page})
            const res = await fetch(`/api/variants?${params}`)
            const data = await res.json()
            allVariants = allVariants.concat(data.data)
            if (page >= data.pages) break
            page++
        }

        if (allVariants.length === 0) {
            showNotification('No variants to export', 'warn')
            return
        }

        btn.disabled = true
        progressDiv.style.display = 'block'
        progressText.textContent = 'Preparing screenshots…'
        progressFill.style.width = '0%'

        const screenshots = {}
        const variantIds = allVariants.map(v => v.id)

        // Capture IGV screenshots if enabled in config and the browser is available
        if (exportConfig.igvScreenshots && igvBrowser) {
            for (let i = 0; i < allVariants.length; i++) {
                const v = allVariants[i]
                const pct = Math.round(((i + 1) / allVariants.length) * 80)
                progressText.textContent = `Screenshot ${i + 1}/${allVariants.length}: ${v.chrom}:${v.pos}`
                progressFill.style.width = `${pct}%`

                try {
                    // Load variant-specific tracks and wait for data
                    await loadVariantForScreenshot(v)

                    const imgData = await captureIgvScreenshot()
                    if (imgData) {
                        screenshots[String(v.id)] = imgData
                    }
                } catch (err) {
                    console.warn(`Screenshot failed for variant ${v.id}:`, err)
                }
            }
        }

        // Send to server for HTML generation
        progressText.textContent = 'Generating HTML report…'
        progressFill.style.width = '90%'

        try {
            const htmlRes = await fetch('/api/export/html', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({variantIds, screenshots, filters, exportConfig})
            })

            if (!htmlRes.ok) {
                let msg = 'Export failed'
                try { const err = await htmlRes.json(); msg = err.error || msg } catch (_) {}
                throw new Error(msg)
            }

            const blob = await htmlRes.blob()
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = 'variants_export.zip'
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            URL.revokeObjectURL(url)

            progressText.textContent = 'Done!'
            progressFill.style.width = '100%'
            showNotification(`Exported ${allVariants.length} variants to HTML`, 'success')
        } catch (err) {
            console.error('HTML export error:', err)
            showNotification('HTML export failed: ' + err.message, 'warn')
        } finally {
            btn.disabled = false
            setTimeout(() => { progressDiv.style.display = 'none' }, 2000)
        }
    }

    /**
     * Load a variant into IGV for screenshot capture.
     * Mirrors showInIgv() — removes existing tracks, navigates to locus,
     * loads variant-specific tracks, and waits for all track data to be
     * fully loaded before returning.
     *
     * Previous attempts (PRs #35-42) only called search() without loading
     * per-variant tracks, then tried complex polling/retry logic which
     * broke screenshot capture entirely.  The real fix is loading the
     * correct tracks for each variant — loadTrackList() internally awaits
     * updateViews() which awaits loadFeatures() for every viewport, so
     * featureCaches are populated when it returns.
     */
    async function loadVariantForScreenshot(variant) {
        const pos = parseInt(variant.pos, 10)
        const flank = 100
        const locus = `${variant.chrom}:${Math.max(1, pos - flank)}-${pos + flank}`
        const tracks = buildTracks(variant)

        igvBrowser.removeAllTracks()
        await igvBrowser.search(locus)
        await igvBrowser.loadTrackList(tracks)

        // Yield two animation frames so the browser can
        // finish layout and paint after track loading completes.
        // toSVG() reads from featureCache (already populated above)
        // but getBoundingClientRect() in renderSVGContext needs
        // accurate layout.
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    }

    async function captureIgvScreenshot() {
        if (!igvBrowser || typeof igvBrowser.toSVG !== 'function') return null

        try {
            const svgString = igvBrowser.toSVG()
            if (!svgString) return null

            // Convert SVG to PNG via an offscreen Image + Canvas
            const svgBlob = new Blob([svgString], {type: 'image/svg+xml'})
            const svgUrl = URL.createObjectURL(svgBlob)

            return new Promise(resolve => {
                const img = new Image()
                img.onload = () => {
                    const dims = igvBrowser.columnContainer.getBoundingClientRect()
                    const dpr = window.devicePixelRatio || 1
                    const scale = dpr * 2  // 2x for high-res export screenshots
                    const canvas = document.createElement('canvas')
                    canvas.width = dims.width * scale
                    canvas.height = dims.height * scale
                    const ctx = canvas.getContext('2d')
                    ctx.scale(scale, scale)
                    ctx.drawImage(img, 0, 0)
                    URL.revokeObjectURL(svgUrl)
                    resolve(canvas.toDataURL('image/png'))
                }
                img.onerror = (e) => {
                    console.warn('Screenshot SVG-to-PNG conversion failed:', e)
                    URL.revokeObjectURL(svgUrl)
                    resolve(null)
                }
                img.src = svgUrl
            })
        } catch (e) {
            console.warn('Screenshot capture failed:', e)
            return null
        }
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

    /**
     * Convert an SVG string to a PNG data URI using an off-screen canvas.
     */
    function svgToPng(svgText, width, height) {
        return new Promise((resolve) => {
            const blob = new Blob([svgText], {type: 'image/svg+xml;charset=utf-8'})
            const url = URL.createObjectURL(blob)
            const img = new Image()
            img.onload = () => {
                const canvas = document.createElement('canvas')
                canvas.width = width
                canvas.height = height
                const ctx = canvas.getContext('2d')
                ctx.fillStyle = '#fff'
                ctx.fillRect(0, 0, width, height)
                ctx.drawImage(img, 0, 0, width, height)
                URL.revokeObjectURL(url)
                resolve(canvas.toDataURL('image/png'))
            }
            img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
            img.src = url
        })
    }

    function showNotification(msg, type) {
        let el = document.getElementById('notification')
        if (!el) {
            el = document.createElement('div')
            el.id = 'notification'
            el.style.cssText = 'position:fixed;top:60px;right:20px;padding:10px 18px;border-radius:6px;font-size:13px;z-index:999;transition:opacity 0.3s;'
            document.body.appendChild(el)
        }
        el.style.background = type === 'warn' ? '#f39c12' : '#27ae60'
        el.style.color = '#fff'
        el.textContent = msg
        el.style.opacity = '1'
        setTimeout(() => { el.style.opacity = '0' }, 2500)
    }

    // -----------------------------------------------------------------------
    // Collapsible sidebar
    // -----------------------------------------------------------------------
    function setupSidebarToggle() {
        const btn = document.getElementById('btn-collapse-sidebar')
        if (btn) btn.addEventListener('click', toggleSidebar)

        // Restore persisted state
        if (localStorage.getItem('sidebarCollapsed') === 'true') {
            document.getElementById('app').classList.add('sidebar-collapsed')
            if (btn) btn.textContent = '▶'
        }
    }

    function toggleSidebar() {
        const app = document.getElementById('app')
        app.classList.toggle('sidebar-collapsed')
        const collapsed = app.classList.contains('sidebar-collapsed')
        const btn = document.getElementById('btn-collapse-sidebar')
        if (btn) btn.textContent = collapsed ? '▶' : '◀'
        localStorage.setItem('sidebarCollapsed', collapsed)
    }

    // -----------------------------------------------------------------------
    // Display mode control for all tracks
    // -----------------------------------------------------------------------
    function setupDisplayModeControl() {
        const sel = document.getElementById('display-mode-select')
        if (!sel) return
        sel.addEventListener('change', () => {
            const mode = sel.value
            if (!igvBrowser) return
            const tracks = (igvBrowser.trackViews?.map(tv => tv.track).filter(t => t?.type === 'alignment')) ?? []
            tracks.forEach(t => {
                t.displayMode = mode
            })
            if (igvBrowser.updateViews) igvBrowser.updateViews()
        })
    }

    // -----------------------------------------------------------------------
    // IGV settings panel (gear icon dropdown)
    // -----------------------------------------------------------------------
    function setupIgvSettings() {
        // Initialize from server config, then apply any localStorage override
        igvSettings.checkSequenceMD5 = !!config.checkSequenceMD5
        const stored = localStorage.getItem('igv.checkSequenceMD5')
        if (stored !== null) {
            igvSettings.checkSequenceMD5 = stored === 'true'
        }

        // Gear button toggles the panel
        const btn = document.getElementById('btn-igv-settings')
        const panel = document.getElementById('igv-settings-panel')
        if (!btn || !panel) return

        btn.addEventListener('click', (e) => {
            e.stopPropagation()
            const open = panel.style.display !== 'none'
            panel.style.display = open ? 'none' : 'block'
        })

        // Close panel when clicking outside
        document.addEventListener('click', (e) => {
            if (!panel.contains(e.target) && e.target !== btn) {
                panel.style.display = 'none'
            }
        })

        // CRAM MD5 checkbox
        const chk = document.getElementById('chk-cram-md5')
        if (chk) {
            chk.checked = igvSettings.checkSequenceMD5
            chk.addEventListener('change', () => {
                igvSettings.checkSequenceMD5 = chk.checked
                localStorage.setItem('igv.checkSequenceMD5', chk.checked)
            })
        }
    }

    // -----------------------------------------------------------------------
    // BED track controls & species metrics panel
    // -----------------------------------------------------------------------

    /**
     * Set up BED track controls: toggle visibility and display mode.
     * Controls are shown only when BED tracks are configured.
     */
    function setupBedTrackControls() {
        const wrap = document.getElementById('bed-track-controls')
        if (!wrap) return

        // Show controls only when BED tracks are available
        const hasBedTracks = (config.bedTracks && config.bedTracks.length > 0) ||
                             (config.bedColumns && config.bedColumns.length > 0)
        if (!hasBedTracks) {
            wrap.style.display = 'none'
            return
        }
        wrap.style.display = ''

        // BED track toggle
        const chk = document.getElementById('chk-bed-tracks')
        if (chk) {
            const stored = localStorage.getItem('igv.bedTracksEnabled')
            chk.checked = stored !== null ? stored === 'true' : true
            chk.addEventListener('change', () => {
                localStorage.setItem('igv.bedTracksEnabled', chk.checked)
                if (igvBrowser && activeVariantId !== null) {
                    const v = variants.find(x => x.id === activeVariantId)
                    if (v) showInIgv(v)
                }
            })
        }

        // BED display mode change
        const sel = document.getElementById('bed-display-mode-select')
        if (sel) {
            sel.addEventListener('change', () => {
                if (!igvBrowser) return
                const mode = sel.value
                const tracks = (igvBrowser.trackViews?.map(tv => tv.track)
                    .filter(t => t?.type === 'annotation' && t?.format === 'bed')) ?? []
                tracks.forEach(t => { t.displayMode = mode })
                if (igvBrowser.updateViews) igvBrowser.updateViews()
            })
        }
    }

    /**
     * Fetch and display species metrics for the currently selected variant.
     * Shows a compact summary of Kraken2 species classifications from BED tracks.
     */
    async function loadSpeciesMetrics(variant) {
        const panel = document.getElementById('species-metrics-panel')
        if (!panel) return

        const hasBedTracks = (config.bedTracks && config.bedTracks.length > 0) ||
                             (config.bedColumns && config.bedColumns.length > 0)
        if (!hasBedTracks) {
            panel.style.display = 'none'
            return
        }
        panel.style.display = ''

        const body = document.getElementById('species-metrics-body')
        if (!body) return
        body.innerHTML = '<span class="hint">Loading species metrics…</span>'

        try {
            const res = await fetch(`/api/species-metrics?variant_id=${variant.id}`)
            const data = await res.json()

            if (!data.loaded || !data.metrics) {
                body.innerHTML = '<span class="hint">No species classification data available for this variant</span>'
                return
            }

            const m = data.metrics
            body.innerHTML = renderSpeciesMetrics(m)
        } catch (err) {
            body.innerHTML = `<span class="hint">Failed to load species metrics: ${escapeHtml(err.message)}</span>`
        }
    }

    /**
     * Render species metrics as compact HTML for the summary panel.
     */
    function renderSpeciesMetrics(m) {
        if (m.totalReads === 0) {
            return '<span class="hint">No informative reads found in BED tracks for this variant</span>'
        }

        const pct = (m.nonhumanFraction * 100).toFixed(1)
        const assessClass = `species-${m.assessment.label}`

        // Domain breakdown
        const domainEntries = Object.entries(m.domainCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([d, c]) => `<span class="species-domain species-domain-${d.toLowerCase()}">${escapeHtml(d)}: ${c}</span>`)
            .join(' ')

        // Top taxa
        const taxaRows = m.topTaxa.slice(0, 5).map(t =>
            `<span class="species-taxon">${escapeHtml(t.name)}: ${t.count}</span>`
        ).join(' ')

        // Guard status summary
        const guardEntries = Object.entries(m.guardCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([g, c]) => `${g}: ${c}`)
            .join(', ')

        return `
            <div class="species-summary">
                <div class="species-assessment ${assessClass}">
                    <strong>${m.assessment.label.toUpperCase()}</strong>
                    <span>${m.assessment.description}</span>
                </div>
                <div class="species-stats">
                    <span><strong>Total reads:</strong> ${m.totalReads}</span>
                    <span><strong>Non-human:</strong> ${m.nonhumanReads} (${pct}%)</span>
                    <span><strong>DKA/DKU:</strong> ${m.readSetCounts.DKA}/${m.readSetCounts.DKU}</span>
                    <span><strong>Split reads:</strong> ${m.splitReadCount}</span>
                    <span><strong>High-clip reads:</strong> ${m.clippingStats.highClipReads}</span>
                </div>
                <div class="species-domains">
                    <strong>Domains:</strong> ${domainEntries || 'none'}
                </div>
                ${taxaRows ? `<div class="species-taxa"><strong>Top taxa:</strong> ${taxaRows}</div>` : ''}
                <div class="species-guards">
                    <strong>Guard status:</strong> ${guardEntries || 'none'}
                </div>
            </div>`
    }

    // -----------------------------------------------------------------------
    // Variant search bar
    // -----------------------------------------------------------------------
    let searchDebounce = null
    function setupVariantSearch() {
        const input = document.getElementById('variant-search')
        if (!input) return
        input.addEventListener('input', () => {
            clearTimeout(searchDebounce)
            searchDebounce = setTimeout(() => {
                currentPage = 1
                loadVariants()
            }, 300)
        })
        const clearBtn = document.getElementById('variant-search-clear')
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                input.value = ''
                currentPage = 1
                loadVariants()
            })
        }
    }

    // -----------------------------------------------------------------------
    // Resizable variant table
    // -----------------------------------------------------------------------
    function setupTableResize() {
        const handle = document.getElementById('table-resize-handle')
        const tableWrap = document.getElementById('variant-table-wrap')
        if (!handle || !tableWrap) return

        // Restore persisted height
        const saved = localStorage.getItem('variantTableHeight')
        if (saved) tableWrap.style.maxHeight = saved

        let startY, startH

        handle.addEventListener('mousedown', (e) => {
            e.preventDefault()
            startY = e.clientY
            startH = tableWrap.offsetHeight
            handle.classList.add('dragging')
            document.addEventListener('mousemove', onDrag)
            document.addEventListener('mouseup', onRelease)
        })

        function onDrag(e) {
            const delta = e.clientY - startY
            const newH = Math.max(100, startH + delta)
            tableWrap.style.maxHeight = newH + 'px'
        }

        function onRelease() {
            handle.classList.remove('dragging')
            document.removeEventListener('mousemove', onDrag)
            document.removeEventListener('mouseup', onRelease)
            localStorage.setItem('variantTableHeight', tableWrap.style.maxHeight)
        }
    }

    // -----------------------------------------------------------------------
    // Filter config persistence
    // -----------------------------------------------------------------------
    async function saveFilterConfig() {
        const filters = getActiveFilters()
        try {
            const res = await fetch('/api/filter-config', {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(filters)
            })
            if (res.ok) {
                showNotification('Filters saved', 'success')
            } else {
                showNotification('Failed to save filters', 'warn')
            }
        } catch (err) {
            showNotification('Failed to save filters', 'warn')
        }
    }

    async function loadSavedFilters() {
        try {
            const res = await fetch('/api/filter-config')
            if (!res.ok) return
            const filters = await res.json()
            if (!filters || Object.keys(filters).length === 0) return
            applyFiltersToUI(filters)
        } catch (_) { /* no saved filters */ }
    }

    function applyFiltersToUI(filters) {
        for (const [key, val] of Object.entries(filters)) {
            // Functional filter – restore conditions array
            if (key === 'functional_filter') {
                try {
                    const conds = JSON.parse(val)
                    if (Array.isArray(conds)) {
                        functionalConditions = conds
                        renderFunctionalFilterRows()
                    }
                } catch (_) { /* ignore invalid JSON */ }
                continue
            }

            // Search term – restore free-text input
            if (key === 'search') {
                const searchInput = document.getElementById('variant-search')
                if (searchInput) searchInput.value = val
                continue
            }

            // Sort field/order – restore table sort state
            if (key === 'sort') {
                sortField = val
                continue
            }
            if (key === 'order') {
                sortOrder = val
                continue
            }

            // Check for checkbox group first
            const group = document.querySelector(`[data-checkbox-filter="${key}"]`)
            if (group) {
                const values = val.split(',').map(s => s.trim())
                group.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                    cb.checked = values.includes(cb.value)
                })
                continue
            }

            // Drop-down or text/number input
            const el = document.querySelector(`[data-filter="${key}"]`)
            if (el) el.value = val
        }
    }

    // -----------------------------------------------------------------------
    // Boot
    // -----------------------------------------------------------------------
    document.addEventListener('DOMContentLoaded', init)
})()
