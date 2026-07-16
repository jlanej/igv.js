/**
 * HTML EXPORT — the self-contained, interactive single-file report.
 *
 * Extracted from server.js. A pure function of its arguments: it takes the already
 * filtered variants, the columns, the screenshots and the precomputed stats, and
 * returns a string. It reads no module state and performs no I/O, so the only way to
 * break it is to change what the caller passes.
 *
 * Screenshots arrive as base64 data URIs so the HTML works standalone, without
 * extracting image files from the ZIP.
 */

'use strict'

/**
 * Build a self-contained, interactive HTML report for variant export.
 * Screenshots are embedded as base64 data URIs so the HTML works without
 * extracting image files from the ZIP.
 */
function buildExportHtml(variants, columns, screenshotFiles, screenshots, geneSummary, filterEntries, stats, geneCol) {
    const totalVariants = variants.length
    const hasScreenshots = Object.keys(screenshotFiles).length > 0
    const escHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

    // Build table rows JSON for client-side filtering.
    // Embed screenshot data URIs directly so the HTML is self-contained.
    const variantData = variants.map(v => {
        const row = {}
        for (const col of columns) {
            row[col] = v[col] ?? ''
        }
        row._id = v.id
        row._hasScreenshot = !!screenshotFiles[String(v.id)]
        row._screenshotFile = screenshotFiles[String(v.id)] || ''
        // Embed the data URI for self-contained HTML; fall back to
        // relative path for the ZIP-extracted screenshots/ directory
        row._screenshotDataUri = screenshots[String(v.id)] || ''
        return row
    })

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Variant Review Report</title>
<style>
  :root {
    --primary: #2c3e50; --primary-light: #34495e; --accent: #3498db;
    --success: #27ae60; --danger: #e74c3c; --warning: #f39c12; --muted: #95a5a6;
    --bg: #f5f7fa; --card-bg: #ffffff; --border: #e1e8ed;
    --text: #2c3e50; --text-light: #7f8c8d;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
  .container { max-width: 1600px; margin: 0 auto; padding: 20px; }
  header { background: linear-gradient(135deg, var(--primary), var(--primary-light)); color: white; padding: 24px 32px; border-radius: 12px; margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; }
  header h1 { font-size: 1.5rem; font-weight: 600; }
  header .meta { font-size: 0.85rem; opacity: 0.85; }
  .stats-bar { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
  .stat-card { background: var(--card-bg); border-radius: 8px; padding: 14px 20px; flex: 1; min-width: 140px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); border-left: 4px solid var(--border); text-align: center; }
  .stat-card .stat-value { font-size: 1.8rem; font-weight: 700; }
  .stat-card .stat-label { font-size: 0.8rem; color: var(--text-light); text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-card.pass { border-left-color: var(--success); } .stat-card.pass .stat-value { color: var(--success); }
  .stat-card.fail { border-left-color: var(--danger); } .stat-card.fail .stat-value { color: var(--danger); }
  .stat-card.uncertain { border-left-color: var(--warning); } .stat-card.uncertain .stat-value { color: var(--warning); }
  .stat-card.pending { border-left-color: var(--muted); } .stat-card.pending .stat-value { color: var(--muted); }
  .stat-card.total { border-left-color: var(--accent); } .stat-card.total .stat-value { color: var(--accent); }

  .tabs { display: flex; gap: 4px; margin-bottom: 0; border-bottom: 2px solid var(--border); }
  .tab { padding: 10px 20px; cursor: pointer; background: transparent; border: none; font-size: 0.9rem; color: var(--text-light); border-bottom: 2px solid transparent; margin-bottom: -2px; transition: all 0.2s; }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
  .tab-content { display: none; } .tab-content.active { display: block; }

  .panel { background: var(--card-bg); border-radius: 0 0 12px 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); padding: 20px; margin-bottom: 24px; }
  .toolbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
  .search-box { padding: 8px 14px; border: 1px solid var(--border); border-radius: 6px; font-size: 0.9rem; width: 300px; outline: none; transition: border-color 0.2s; }
  .search-box:focus { border-color: var(--accent); }
  .filter-select { padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; font-size: 0.85rem; background: white; cursor: pointer; }
  .result-count { font-size: 0.85rem; color: var(--text-light); margin-left: auto; }

  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  thead th { background: var(--primary); color: white; padding: 10px 12px; text-align: left; font-weight: 600; cursor: pointer; user-select: none; white-space: nowrap; position: sticky; top: 0; z-index: 10; }
  thead th:hover { background: var(--primary-light); }
  thead th .sort-arrow { margin-left: 4px; opacity: 0.5; font-size: 0.7rem; }
  thead th.sorted .sort-arrow { opacity: 1; }
  tbody td { padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  tbody tr:hover { background: #eef2f7; }
  tbody tr.status-pass { background: #d5f5e3; } tbody tr.status-pass:hover { background: #c1f0d5; }
  tbody tr.status-fail { background: #fadbd8; } tbody tr.status-fail:hover { background: #f5c6c0; }
  tbody tr.status-uncertain { background: #fdebd0; } tbody tr.status-uncertain:hover { background: #fce0b4; }
  .table-wrapper { overflow-x: auto; max-height: 70vh; overflow-y: auto; }

  .status-badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
  .status-badge.pass { background: #d5f5e3; color: #1e8449; }
  .status-badge.fail { background: #fadbd8; color: #c0392b; }
  .status-badge.uncertain { background: #fdebd0; color: #d68910; }
  .status-badge.pending { background: #eaeded; color: #7f8c8d; }

  .screenshot-link { color: var(--accent); text-decoration: none; font-weight: 500; }
  .screenshot-link:hover { text-decoration: underline; }

  .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 1000; justify-content: center; align-items: center; }
  .modal-overlay.active { display: flex; }
  .modal { background: white; border-radius: 12px; max-width: 95vw; max-height: 95vh; overflow: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
  .modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: white; z-index: 1; }
  .modal-header h3 { font-size: 1rem; }
  .modal-close { background: none; border: none; font-size: 1.5rem; cursor: pointer; color: var(--text-light); padding: 4px 8px; border-radius: 4px; }
  .modal-close:hover { background: #f0f0f0; color: var(--text); }
  .modal-body { padding: 20px; }
  .modal-body img { max-width: 100%; height: auto; border-radius: 4px; }
  .modal-nav { display: flex; justify-content: space-between; padding: 12px 20px; border-top: 1px solid var(--border); }
  .modal-nav button { padding: 6px 16px; border: 1px solid var(--border); border-radius: 6px; background: white; cursor: pointer; font-size: 0.85rem; }
  .modal-nav button:hover { background: #f0f0f0; }
  .modal-nav button:disabled { opacity: 0.4; cursor: default; }
  .modal-info { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 0.85rem; margin-bottom: 12px; }
  .modal-info dt { font-weight: 600; color: var(--text-light); }
  .modal-info dd { color: var(--text); }

  .gene-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
  .gene-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
  .gene-card h4 { font-size: 1rem; margin-bottom: 8px; color: var(--primary); }
  .gene-card .gene-stats { display: flex; gap: 8px; flex-wrap: wrap; }
  .gene-card .gene-stat { font-size: 0.8rem; padding: 2px 8px; border-radius: 4px; }

  .filter-chips { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
  .filter-chip { background: #eaf2f8; color: var(--accent); padding: 4px 12px; border-radius: 16px; font-size: 0.8rem; }
  .filter-chip strong { margin-right: 4px; }

  .pagination { display: flex; gap: 4px; justify-content: center; align-items: center; margin-top: 16px; }
  .pagination button { padding: 6px 12px; border: 1px solid var(--border); border-radius: 4px; background: white; cursor: pointer; font-size: 0.85rem; }
  .pagination button:hover { background: #f0f0f0; }
  .pagination button.active { background: var(--accent); color: white; border-color: var(--accent); }
  .pagination button:disabled { opacity: 0.4; cursor: default; }
  .pagination .page-info { font-size: 0.85rem; color: var(--text-light); margin: 0 8px; }

  ${hasScreenshots ? `
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
  .gallery-item { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; cursor: pointer; transition: box-shadow 0.2s; }
  .gallery-item:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.12); }
  .gallery-item img { width: 100%; height: 200px; object-fit: cover; border-bottom: 1px solid var(--border); }
  .gallery-item .gallery-info { padding: 10px 12px; }
  .gallery-item .gallery-info h4 { font-size: 0.9rem; margin-bottom: 4px; }
  .gallery-item .gallery-info p { font-size: 0.8rem; color: var(--text-light); }
  ` : ''}

  @media (max-width: 768px) {
    .container { padding: 12px; }
    header { padding: 16px; }
    .stats-bar { flex-direction: column; }
    .toolbar { flex-direction: column; }
    .search-box { width: 100%; }
    table { font-size: 0.75rem; }
  }

  @media print {
    .toolbar, .tabs, .pagination, .modal-overlay { display: none !important; }
    .tab-content { display: block !important; page-break-inside: avoid; }
    header { background: var(--primary) !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <div>
      <h1>🧬 Variant Review Report</h1>
      <div class="meta">Generated ${new Date().toLocaleDateString('en-US', {year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'})} · ${totalVariants} variants</div>
    </div>
  </header>

  ${filterEntries.length > 0 ? `
  <div class="filter-chips">
    <strong style="font-size:0.85rem;color:var(--text-light);margin-right:4px;">Applied Filters:</strong>
    ${filterEntries.map(f => `<span class="filter-chip"><strong>${escHtml(f.label)}:</strong> ${escHtml(f.value)}</span>`).join('')}
  </div>
  ` : ''}

  <div class="stats-bar">
    <div class="stat-card total"><div class="stat-value">${totalVariants}</div><div class="stat-label">Total</div></div>
    <div class="stat-card pass"><div class="stat-value">${stats.pass}</div><div class="stat-label">Pass</div></div>
    <div class="stat-card fail"><div class="stat-value">${stats.fail}</div><div class="stat-label">Fail</div></div>
    <div class="stat-card uncertain"><div class="stat-value">${stats.uncertain}</div><div class="stat-label">Uncertain</div></div>
    <div class="stat-card pending"><div class="stat-value">${stats.pending}</div><div class="stat-label">Pending</div></div>
  </div>

  <div class="tabs">
    <button class="tab active" data-tab="variants">📋 Variants</button>
    ${hasScreenshots ? '<button class="tab" data-tab="gallery">🖼️ Screenshots</button>' : ''}
    ${geneSummary.length > 0 ? '<button class="tab" data-tab="genes">🧬 Gene Summary</button>' : ''}
  </div>

  <div class="panel">
    <!-- Variants Tab -->
    <div id="tab-variants" class="tab-content active">
      <div class="toolbar">
        <input type="text" class="search-box" id="searchBox" placeholder="Search variants…">
        <select class="filter-select" id="statusFilter">
          <option value="">All Statuses</option>
          <option value="pass">Pass</option>
          <option value="fail">Fail</option>
          <option value="uncertain">Uncertain</option>
          <option value="pending">Pending</option>
        </select>
        ${geneCol ? `<select class="filter-select" id="geneFilter"><option value="">All Genes</option></select>` : ''}
        <span class="result-count" id="resultCount"></span>
      </div>
      <div class="table-wrapper">
        <table id="variantTable">
          <thead><tr id="tableHead"></tr></thead>
          <tbody id="tableBody"></tbody>
        </table>
      </div>
      <div class="pagination" id="pagination"></div>
    </div>

    ${hasScreenshots ? `
    <!-- Gallery Tab -->
    <div id="tab-gallery" class="tab-content">
      <div class="toolbar">
        <input type="text" class="search-box" id="gallerySearch" placeholder="Search screenshots…">
        <span class="result-count" id="galleryCount"></span>
      </div>
      <div class="gallery" id="galleryGrid"></div>
    </div>
    ` : ''}

    ${geneSummary.length > 0 ? `
    <!-- Gene Summary Tab -->
    <div id="tab-genes" class="tab-content">
      <div class="gene-grid" id="geneGrid"></div>
    </div>
    ` : ''}
  </div>
</div>

<!-- Screenshot Modal -->
<div class="modal-overlay" id="screenshotModal">
  <div class="modal">
    <div class="modal-header">
      <h3 id="modalTitle">Screenshot</h3>
      <button class="modal-close" id="modalClose">×</button>
    </div>
    <div class="modal-body">
      <dl class="modal-info" id="modalInfo"></dl>
      <img id="modalImg" src="" alt="Screenshot">
    </div>
    <div class="modal-nav">
      <button id="modalPrev">← Previous</button>
      <button id="modalNext">Next →</button>
    </div>
  </div>
</div>

<script>
(function() {
  const VARIANTS = ${JSON.stringify(variantData)};
  const COLUMNS = ${JSON.stringify(columns)};
  const GENE_SUMMARY = ${JSON.stringify(geneSummary)};
  const HAS_SCREENSHOTS = ${hasScreenshots};
  const PAGE_SIZE = 50;
  let currentPage = 1;
  let sortCol = null;
  let sortAsc = true;
  let filteredVariants = [...VARIANTS];
  let currentModalIdx = -1;
  let screenshotVariants = [];

  // Escape HTML
  function esc(s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }

  // Format column name
  function fmtCol(c) { return c.replace(/_/g, ' ').replace(/\\b\\w/g, s => s.toUpperCase()); }

  // --- Tab switching ---
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
  });

  // --- Build table header ---
  const thead = document.getElementById('tableHead');
  if (HAS_SCREENSHOTS) {
    const th = document.createElement('th');
    th.textContent = '📷';
    th.style.width = '50px';
    thead.appendChild(th);
  }
  COLUMNS.forEach(col => {
    const th = document.createElement('th');
    th.innerHTML = esc(fmtCol(col)) + ' <span class="sort-arrow">⇅</span>';
    th.dataset.col = col;
    th.addEventListener('click', () => {
      if (sortCol === col) { sortAsc = !sortAsc; }
      else { sortCol = col; sortAsc = true; }
      currentPage = 1;
      renderTable();
    });
    thead.appendChild(th);
  });

  // --- Populate gene filter ---
  ${geneCol ? `
  const geneFilter = document.getElementById('geneFilter');
  const genes = [...new Set(VARIANTS.map(v => v.gene).filter(Boolean))].sort();
  genes.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g; opt.textContent = g;
    geneFilter.appendChild(opt);
  });
  geneFilter.addEventListener('change', () => { currentPage = 1; applyFilters(); });
  ` : ''}

  // --- Filtering ---
  function applyFilters() {
    const search = document.getElementById('searchBox').value.toLowerCase();
    const status = document.getElementById('statusFilter').value;
    ${geneCol ? "const gene = document.getElementById('geneFilter').value;" : "const gene = '';"}

    filteredVariants = VARIANTS.filter(v => {
      if (status && (v.curation_status || 'pending') !== status) return false;
      if (gene && v.gene !== gene) return false;
      if (search) {
        const match = COLUMNS.some(c => String(v[c] ?? '').toLowerCase().includes(search));
        if (!match) return false;
      }
      return true;
    });
    renderTable();
  }

  document.getElementById('searchBox').addEventListener('input', () => { currentPage = 1; applyFilters(); });
  document.getElementById('statusFilter').addEventListener('change', () => { currentPage = 1; applyFilters(); });

  // --- Sort & Render Table ---
  function renderTable() {
    let data = [...filteredVariants];
    if (sortCol) {
      data.sort((a, b) => {
        let va = a[sortCol] ?? '', vb = b[sortCol] ?? '';
        if (typeof va === 'number' && typeof vb === 'number') return sortAsc ? va - vb : vb - va;
        va = String(va).toLowerCase(); vb = String(vb).toLowerCase();
        return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      });
    }
    // Update sort arrows
    document.querySelectorAll('#tableHead th').forEach(th => {
      th.classList.toggle('sorted', th.dataset.col === sortCol);
      const arrow = th.querySelector('.sort-arrow');
      if (arrow) arrow.textContent = th.dataset.col === sortCol ? (sortAsc ? '↑' : '↓') : '⇅';
    });

    const totalPages = Math.max(1, Math.ceil(data.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * PAGE_SIZE;
    const pageData = data.slice(start, start + PAGE_SIZE);

    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = '';
    pageData.forEach((v, idx) => {
      const tr = document.createElement('tr');
      const status = v.curation_status || 'pending';
      tr.className = 'status-' + status;

      if (HAS_SCREENSHOTS) {
        const td = document.createElement('td');
        if (v._hasScreenshot) {
          const a = document.createElement('a');
          a.href = '#';
          a.className = 'screenshot-link';
          a.textContent = '📷';
          a.title = 'View screenshot';
          a.addEventListener('click', (e) => { e.preventDefault(); openModal(v._id); });
          td.appendChild(a);
        }
        tr.appendChild(td);
      }

      COLUMNS.forEach(col => {
        const td = document.createElement('td');
        if (col === 'curation_status') {
          const badge = document.createElement('span');
          badge.className = 'status-badge ' + status;
          badge.textContent = status;
          td.appendChild(badge);
        } else {
          td.textContent = v[col] ?? '';
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    document.getElementById('resultCount').textContent = data.length + ' of ' + VARIANTS.length + ' variants';
    renderPagination(totalPages);
  }

  function renderPagination(totalPages) {
    const div = document.getElementById('pagination');
    div.innerHTML = '';
    if (totalPages <= 1) return;
    const prev = document.createElement('button');
    prev.textContent = '← Prev';
    prev.disabled = currentPage <= 1;
    prev.addEventListener('click', () => { currentPage--; renderTable(); });
    div.appendChild(prev);

    const info = document.createElement('span');
    info.className = 'page-info';
    info.textContent = 'Page ' + currentPage + ' of ' + totalPages;
    div.appendChild(info);

    const next = document.createElement('button');
    next.textContent = 'Next →';
    next.disabled = currentPage >= totalPages;
    next.addEventListener('click', () => { currentPage++; renderTable(); });
    div.appendChild(next);
  }

  // --- Screenshot Modal ---
  function openModal(variantId) {
    screenshotVariants = filteredVariants.filter(v => v._hasScreenshot);
    currentModalIdx = screenshotVariants.findIndex(v => v._id === variantId);
    if (currentModalIdx < 0) return;
    showModalContent();
    document.getElementById('screenshotModal').classList.add('active');
  }

  function showModalContent() {
    const v = screenshotVariants[currentModalIdx];
    if (!v) return;
    document.getElementById('modalTitle').textContent = (v.chrom || '') + ':' + (v.pos || '') + ' ' + (v.ref || '') + '→' + (v.alt || '');
    document.getElementById('modalImg').src = v._screenshotDataUri || ('screenshots/' + v._screenshotFile);
    const info = document.getElementById('modalInfo');
    info.innerHTML = '';
    ['gene', 'impact', 'inheritance', 'curation_status', 'curation_note'].forEach(key => {
      if (v[key]) {
        const dt = document.createElement('dt'); dt.textContent = fmtCol(key);
        const dd = document.createElement('dd'); dd.textContent = v[key];
        info.appendChild(dt); info.appendChild(dd);
      }
    });
    document.getElementById('modalPrev').disabled = currentModalIdx <= 0;
    document.getElementById('modalNext').disabled = currentModalIdx >= screenshotVariants.length - 1;
  }

  document.getElementById('modalClose').addEventListener('click', () => {
    document.getElementById('screenshotModal').classList.remove('active');
  });
  document.getElementById('screenshotModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('active');
  });
  document.getElementById('modalPrev').addEventListener('click', () => {
    if (currentModalIdx > 0) { currentModalIdx--; showModalContent(); }
  });
  document.getElementById('modalNext').addEventListener('click', () => {
    if (currentModalIdx < screenshotVariants.length - 1) { currentModalIdx++; showModalContent(); }
  });
  document.addEventListener('keydown', (e) => {
    if (!document.getElementById('screenshotModal').classList.contains('active')) return;
    if (e.key === 'Escape') document.getElementById('screenshotModal').classList.remove('active');
    if (e.key === 'ArrowLeft') document.getElementById('modalPrev').click();
    if (e.key === 'ArrowRight') document.getElementById('modalNext').click();
  });

  ${hasScreenshots ? `
  // --- Screenshot Gallery ---
  function renderGallery() {
    const search = (document.getElementById('gallerySearch')?.value || '').toLowerCase();
    const items = VARIANTS.filter(v => v._hasScreenshot && (!search || COLUMNS.some(c => String(v[c] ?? '').toLowerCase().includes(search))));
    const grid = document.getElementById('galleryGrid');
    grid.innerHTML = '';
    items.forEach(v => {
      const imgSrc = v._screenshotDataUri || ('screenshots/' + v._screenshotFile);
      const div = document.createElement('div');
      div.className = 'gallery-item';
      div.innerHTML = '<img src="' + esc(imgSrc) + '" alt="Screenshot" loading="lazy">'
        + '<div class="gallery-info"><h4>' + esc(v.chrom) + ':' + esc(v.pos) + ' ' + esc(v.ref) + '→' + esc(v.alt) + '</h4>'
        + '<p>' + esc(v.gene || '') + (v.curation_status ? ' · <span class="status-badge ' + (v.curation_status || 'pending') + '">' + esc(v.curation_status || 'pending') + '</span>' : '') + '</p></div>';
      div.addEventListener('click', () => openModal(v._id));
      grid.appendChild(div);
    });
    document.getElementById('galleryCount').textContent = items.length + ' screenshots';
  }
  document.getElementById('gallerySearch')?.addEventListener('input', renderGallery);
  renderGallery();
  ` : ''}

  ${geneSummary.length > 0 ? `
  // --- Gene Summary ---
  (function() {
    const grid = document.getElementById('geneGrid');
    GENE_SUMMARY.forEach(g => {
      const div = document.createElement('div');
      div.className = 'gene-card';
      div.innerHTML = '<h4>' + esc(g.gene) + '</h4>'
        + '<div class="gene-stats">'
        + '<span class="gene-stat" style="background:#eaf2f8;color:var(--accent);">' + g.total + ' total</span>'
        + (g.pass ? '<span class="gene-stat" style="background:#d5f5e3;color:#1e8449;">' + g.pass + ' pass</span>' : '')
        + (g.fail ? '<span class="gene-stat" style="background:#fadbd8;color:#c0392b;">' + g.fail + ' fail</span>' : '')
        + (g.uncertain ? '<span class="gene-stat" style="background:#fdebd0;color:#d68910;">' + g.uncertain + ' uncertain</span>' : '')
        + (g.pending ? '<span class="gene-stat" style="background:#eaeded;color:#7f8c8d;">' + g.pending + ' pending</span>' : '')
        + '</div>';
      grid.appendChild(div);
    });
  })();
  ` : ''}

  // Initial render
  renderTable();
})();
</script>
</body>
</html>`
}

module.exports = {buildExportHtml}
