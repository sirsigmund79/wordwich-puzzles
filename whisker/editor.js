#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const CONFIG_PATH = path.join(__dirname, 'whisker_config.json');
const PORT = 3747;

// ── HTML ──────────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Whisker Template Editor</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: system-ui, -apple-system, sans-serif;
  background: #111827;
  color: #e2e8f0;
  display: flex;
  height: 100vh;
  overflow: hidden;
}

/* ── Sidebar ── */
#sidebar {
  width: 210px;
  background: #1e293b;
  border-right: 1px solid #334155;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}
#sidebar-header {
  padding: 14px 16px 10px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  color: #64748b;
  border-bottom: 1px solid #334155;
}
#template-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}
.tpl-item {
  padding: 8px 10px;
  border-radius: 7px;
  cursor: pointer;
  font-size: 13px;
  color: #94a3b8;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: background 0.1s;
}
.tpl-item:hover { background: #263348; color: #e2e8f0; }
.tpl-item.active { background: #1d4ed8; color: #fff; }
.tpl-item .tpl-cells {
  margin-left: auto;
  font-size: 11px;
  opacity: 0.6;
  flex-shrink: 0;
}
#sidebar-btns {
  padding: 10px;
  border-top: 1px solid #334155;
  display: flex;
  gap: 6px;
}
.sb-btn {
  flex: 1;
  padding: 7px 4px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  transition: background 0.1s;
}
#btn-add { background: #1e3a5f; color: #60a5fa; }
#btn-add:hover { background: #1e4a7f; }
#btn-delete { background: #3b1c1c; color: #f87171; }
#btn-delete:hover { background: #501f1f; }

/* ── Main ── */
#main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ── Toolbar ── */
#toolbar {
  background: #1e293b;
  border-bottom: 1px solid #334155;
  padding: 12px 20px;
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
#name-input {
  background: #0f172a;
  border: 1px solid #334155;
  color: #f1f5f9;
  padding: 6px 11px;
  border-radius: 7px;
  font-size: 15px;
  font-weight: 600;
  width: 200px;
  transition: border-color 0.15s;
}
#name-input:focus { outline: none; border-color: #3b82f6; }

.dim-group {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  color: #64748b;
}
.dim-label { font-size: 11px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; }
.dim-btn {
  width: 26px; height: 26px;
  background: #0f172a;
  border: 1px solid #334155;
  color: #94a3b8;
  border-radius: 5px;
  cursor: pointer;
  font-size: 16px;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.1s;
  line-height: 1;
}
.dim-btn:hover { background: #1e3a5f; color: #60a5fa; }
.dim-val {
  min-width: 22px;
  text-align: center;
  font-size: 15px;
  font-weight: 700;
  color: #e2e8f0;
}

#toolbar-right { margin-left: auto; display: flex; align-items: center; gap: 12px; }
#hint { font-size: 12px; color: #475569; }
#btn-save {
  background: #166534;
  color: #86efac;
  border: none;
  padding: 8px 22px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 700;
  transition: background 0.15s;
  white-space: nowrap;
}
#btn-save:hover { background: #15803d; }
#btn-save.unsaved { background: #92400e; color: #fcd34d; }
#btn-save.unsaved:hover { background: #b45309; }

/* ── Grid area ── */
#grid-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  padding: 28px;
  overflow: auto;
}
#grid {
  display: grid;
  gap: 5px;
}

/* Cell states */
.cell {
  border-radius: 9px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
  transition: transform 0.07s, background 0.1s;
  position: relative;
  user-select: none;
  border: 2px solid transparent;
}
.cell:hover { transform: scale(1.07); z-index: 1; }
.cell:active { transform: scale(0.94); }

.cell-off {
  background: rgba(255,255,255,0.04);
  border: 2px dashed rgba(255,255,255,0.1);
}
.cell-off:hover {
  background: rgba(255,255,255,0.09);
  border-color: rgba(255,255,255,0.25);
}

.cell-on {
  background: #1e3a5f;
  border-color: #3b6fa0;
  color: #93c5fd;
}
.cell-on:hover { background: #254a78; }

/* ── Info bar ── */
#info-bar {
  display: flex;
  gap: 20px;
  align-items: center;
  font-size: 13px;
  color: #64748b;
  min-height: 20px;
}
.info-ok { color: #34d399; }
.info-warn { color: #fb923c; }

/* ── Legend ── */
#legend {
  display: flex;
  gap: 18px;
  font-size: 12px;
  color: #475569;
}
.leg { display: flex; align-items: center; gap: 7px; }
.swatch {
  width: 16px; height: 16px;
  border-radius: 4px;
  border: 2px solid transparent;
  flex-shrink: 0;
}
.sw-off  { background: rgba(255,255,255,0.04); border: 2px dashed rgba(255,255,255,0.1); }
.sw-on   { background: #1e3a5f; border-color: #3b6fa0; }
</style>
</head>
<body>

<div id="sidebar">
  <div id="sidebar-header">Templates</div>
  <div id="template-list"></div>
  <div id="sidebar-btns">
    <button class="sb-btn" id="btn-add">+ New</button>
    <button class="sb-btn" id="btn-delete">✕ Delete</button>
  </div>
</div>

<div id="main">
  <div id="toolbar">
    <input id="name-input" type="text" placeholder="template-name" maxlength="40" spellcheck="false" />
    <div class="dim-group">
      <span class="dim-label">Cols</span>
      <button class="dim-btn" id="cols-minus">−</button>
      <span class="dim-val" id="cols-val">5</span>
      <button class="dim-btn" id="cols-plus">+</button>
    </div>
    <div class="dim-group">
      <span class="dim-label">Rows</span>
      <button class="dim-btn" id="rows-minus">−</button>
      <span class="dim-val" id="rows-val">5</span>
      <button class="dim-btn" id="rows-plus">+</button>
    </div>
    <div id="toolbar-right">
      <span id="hint">Click to activate · click again to deactivate</span>
      <button id="btn-save">Save to config</button>
    </div>
  </div>

  <div id="grid-area">
    <div id="grid"></div>
    <div id="info-bar">
      <span id="cell-count"></span>
      <span id="validation"></span>
    </div>
    <div id="legend">
      <div class="leg"><div class="swatch sw-off"></div>inactive — click to activate</div>
      <div class="leg"><div class="swatch sw-on"></div>active — click to deactivate</div>
      <span style="font-size:11px;color:#334155">Multipliers are placed automatically when puzzles are generated</span>
    </div>
  </div>
</div>

<script>
let config = null;
let selectedIdx = 0;
let unsaved = false;

// Working copy of the template under edit
let cur = { name: '', cols: 5, rows: 5, cells: [] };

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  const res = await fetch('/config');
  config = await res.json();
  selectedIdx = 0;
  loadTemplate(0);
  renderSidebar();
}

// ── Load template into cur ────────────────────────────────────────────────────
function loadTemplate(idx) {
  const t = config.algorithm.layout_templates[idx];
  cur = {
    name: t.name,
    cols: t.dimensions.cols,
    rows: t.dimensions.rows,
    cells: t.cells.map(({ x, y }) => ({ x, y }))
  };
  document.getElementById('name-input').value = cur.name;
  document.getElementById('cols-val').textContent = cur.cols;
  document.getElementById('rows-val').textContent = cur.rows;
  renderGrid();
}

// Write cur back into config at selectedIdx (call before switching or saving)
function commitCur() {
  config.algorithm.layout_templates[selectedIdx] = {
    name: cur.name,
    dimensions: { cols: cur.cols, rows: cur.rows },
    cells: cur.cells.map(({ x, y }) => ({ x, y }))
  };
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function renderSidebar() {
  // Sync cur name/cells into config so sidebar shows live data
  commitCur();

  const list = document.getElementById('template-list');
  list.innerHTML = '';
  config.algorithm.layout_templates.forEach((t, i) => {
    const div = document.createElement('div');
    div.className = 'tpl-item' + (i === selectedIdx ? ' active' : '');
    div.innerHTML =
      '<span>' + escHtml(t.name) + '</span>' +
      '<span class="tpl-cells">' + t.cells.length + 'c</span>';
    div.onclick = () => selectTemplate(i);
    list.appendChild(div);
  });
}

function selectTemplate(idx) {
  if (idx === selectedIdx) return;
  commitCur();
  selectedIdx = idx;
  loadTemplate(idx);
  renderSidebar();
}

// ── Grid ──────────────────────────────────────────────────────────────────────
function cellAt(x, y) {
  return cur.cells.some(c => c.x === x && c.y === y);
}

function clickCell(x, y) {
  const idx = cur.cells.findIndex(c => c.x === x && c.y === y);
  if (idx === -1) cur.cells.push({ x, y });
  else cur.cells.splice(idx, 1);
  markUnsaved();
  renderGrid();
  renderSidebar();
}

function renderGrid() {
  const grid = document.getElementById('grid');
  const size = Math.min(64, Math.max(40, Math.floor(520 / Math.max(cur.cols, cur.rows))));
  grid.style.gridTemplateColumns = 'repeat(' + cur.cols + ', ' + size + 'px)';
  grid.innerHTML = '';

  for (let y = 0; y < cur.rows; y++) {
    for (let x = 0; x < cur.cols; x++) {
      const active = cellAt(x, y);
      const div = document.createElement('div');
      div.className = 'cell ' + (active ? 'cell-on' : 'cell-off');
      div.style.width = div.style.height = size + 'px';
      div.title = active
        ? '(' + x + ',' + y + ') active — click to deactivate'
        : '(' + x + ',' + y + ') — click to activate';
      div.onclick = () => clickCell(x, y);
      grid.appendChild(div);
    }
  }

  updateInfoBar();
}

// ── Validation ────────────────────────────────────────────────────────────────
function getIsolatedCells(cells) {
  const inSlot = new Set();
  const byRow = {}, byCol = {};
  for (const c of cells) {
    (byRow[c.y] = byRow[c.y] || []).push(c.x);
    (byCol[c.x] = byCol[c.x] || []).push(c.y);
  }
  function processRuns(groups, keyFn) {
    for (const [k, vals] of Object.entries(groups)) {
      const sorted = [...vals].sort((a, b) => a - b);
      let run = [sorted[0]];
      for (let i = 1; i <= sorted.length; i++) {
        if (i < sorted.length && sorted[i] === sorted[i-1]+1) { run.push(sorted[i]); }
        else {
          if (run.length >= 2) run.forEach(v => inSlot.add(keyFn(k, v)));
          run = i < sorted.length ? [sorted[i]] : [];
        }
      }
    }
  }
  processRuns(byRow, (y, x) => x+','+y);
  processRuns(byCol, (x, y) => x+','+y);
  return cells.filter(c => !inSlot.has(c.x+','+c.y));
}

function updateInfoBar() {
  const n = cur.cells.length;
  document.getElementById('cell-count').textContent = n + ' active cell' + (n !== 1 ? 's' : '');

  const val = document.getElementById('validation');
  if (n === 0) { val.textContent = ''; val.className = ''; return; }
  const iso = getIsolatedCells(cur.cells);
  if (iso.length > 0) {
    val.className = 'info-warn';
    val.textContent = '⚠ ' + iso.length + ' isolated cell' + (iso.length > 1 ? 's' : '') + ' — each needs a neighbour';
  } else if (n < 4) {
    val.className = 'info-warn';
    val.textContent = '⚠ very few cells';
  } else {
    val.className = 'info-ok';
    val.textContent = '✓ valid layout';
  }
}

// ── Dimension controls ────────────────────────────────────────────────────────
function adjustDim(dim, delta) {
  const next = cur[dim] + delta;
  if (next < 2 || next > 10) return;
  cur[dim] = next;
  cur.cells = cur.cells.filter(c => c.x < cur.cols && c.y < cur.rows);
  document.getElementById(dim === 'cols' ? 'cols-val' : 'rows-val').textContent = next;
  markUnsaved();
  renderGrid();
  renderSidebar();
}

document.getElementById('cols-minus').onclick = () => adjustDim('cols', -1);
document.getElementById('cols-plus').onclick  = () => adjustDim('cols', +1);
document.getElementById('rows-minus').onclick = () => adjustDim('rows', -1);
document.getElementById('rows-plus').onclick  = () => adjustDim('rows', +1);

document.getElementById('name-input').oninput = e => {
  cur.name = e.target.value;
  markUnsaved();
  renderSidebar(); // picks up cur.name via commitCur()
};

// ── Add / Delete ──────────────────────────────────────────────────────────────
document.getElementById('btn-add').onclick = () => {
  commitCur();
  config.algorithm.layout_templates.push({
    name: 'new-template',
    dimensions: { cols: 5, rows: 5 },
    cells: []
  });
  selectedIdx = config.algorithm.layout_templates.length - 1;
  loadTemplate(selectedIdx);
  renderSidebar();
  markUnsaved();
  const inp = document.getElementById('name-input');
  inp.focus(); inp.select();
};

document.getElementById('btn-delete').onclick = () => {
  if (config.algorithm.layout_templates.length <= 1) {
    alert('Cannot delete the last template.');
    return;
  }
  if (!confirm('Delete template "' + cur.name + '"?')) return;
  config.algorithm.layout_templates.splice(selectedIdx, 1);
  selectedIdx = Math.min(selectedIdx, config.algorithm.layout_templates.length - 1);
  loadTemplate(selectedIdx);
  renderSidebar();
  markUnsaved();
};

// ── Save ──────────────────────────────────────────────────────────────────────
function markUnsaved() {
  unsaved = true;
  const btn = document.getElementById('btn-save');
  btn.className = 'unsaved';
  btn.textContent = 'Save to config ●';
}

document.getElementById('btn-save').onclick = async () => {
  commitCur();
  const btn = document.getElementById('btn-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const res = await fetch('/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config, null, 2) + '\\n'
    });
    if (!res.ok) throw new Error(await res.text());
    unsaved = false;
    btn.className = '';
    btn.textContent = 'Saved ✓';
    btn.disabled = false;
    setTimeout(() => { if (!unsaved) btn.textContent = 'Save to config'; }, 2000);
  } catch (e) {
    btn.className = 'unsaved';
    btn.textContent = 'Save failed — retry';
    btn.disabled = false;
    alert('Save error: ' + e.message);
  }
};

// Warn before closing with unsaved changes
window.addEventListener('beforeunload', e => {
  if (unsaved) { e.preventDefault(); e.returnValue = ''; }
});

// ── Utils ─────────────────────────────────────────────────────────────────────
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

boot();
</script>
</body>
</html>`;

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);

  } else if (req.method === 'GET' && req.url === '/config') {
    try {
      const data = fs.readFileSync(CONFIG_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch (e) {
      res.writeHead(500);
      res.end(e.message);
    }

  } else if (req.method === 'POST' && req.url.startsWith('/save')) {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('error', err => {
      console.error('[request error]', err.message);
      if (!res.headersSent) { res.writeHead(500); res.end(err.message); }
    });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        JSON.parse(body); // validate before writing
        fs.writeFileSync(CONFIG_PATH, body, 'utf8');
        console.log('[saved] whisker_config.json');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e) {
        console.error('[save error]', e.message);
        if (!res.headersSent) { res.writeHead(400); res.end(e.message); }
      }
    });

  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Is another instance running?`);
  } else {
    console.error('[server error]', err.message);
  }
  process.exit(1);
});

// Listen on all interfaces (IPv4 + IPv6) so localhost resolves correctly on any system
server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Whisker editor → ${url}`);
  console.log('Press Ctrl+C to stop.\n');
  exec(`start ${url}`, err => {
    if (err) console.log(`Open your browser at: ${url}`);
  });
});
