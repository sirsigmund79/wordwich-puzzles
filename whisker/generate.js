#!/usr/bin/env node
'use strict';

// Usage:
//   node generate.js YYYY-MM-DD [YYYY-MM-DD] [--extra N] [--attempts N] [--dry-run]
//
// For each date, picks a template, places multipliers, then finds a tile bank
// that guarantees ≥5 complete board fills where all word slots are valid
// dictionary words. Retries up to --attempts times per date.

const fs = require('fs');
const path = require('path');

// ── Constants ─────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'whisker_config.json');
const DICT_PATH   = path.join(__dirname, '..', 'letterloaf_dict.txt');
const MAX_SOLVER_NODES = 300000; // per-attempt backtracking limit

// ── PRNG (mulberry32) ─────────────────────────────────────────────────────────
function makeRng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    s = t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Tile points ───────────────────────────────────────────────────────────────
const POINTS = {
  A:1,B:3,C:3,D:2,E:1,F:4,G:2,H:4,I:1,J:8,K:5,L:1,M:3,
  N:1,O:1,P:3,Q:10,R:1,S:1,T:1,U:1,V:4,W:4,X:8,Y:4,Z:10
};

// ── Dictionary ─────────────────────────────────────────────────────────────────
function loadDict() {
  const byLen = {};
  for (const line of fs.readFileSync(DICT_PATH, 'utf8').split('\n')) {
    const w = line.trim().toUpperCase();
    if (w.length < 2) continue;
    if (!byLen[w.length]) byLen[w.length] = [];
    byLen[w.length].push(w);
  }
  return byLen;
}

// ── Tile pool ─────────────────────────────────────────────────────────────────
function buildPool(dist) {
  const pool = [];
  for (const [l, n] of Object.entries(dist))
    for (let i = 0; i < n; i++) pool.push(l);
  return pool;
}

function buildBank(letters) {
  const b = {};
  for (const l of letters) b[l] = (b[l] || 0) + 1;
  return b;
}

// ── Fisher-Yates ──────────────────────────────────────────────────────────────
function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Word slots ─────────────────────────────────────────────────────────────────
// Returns array of runs: each run is an array of cell indices that form a
// consecutive horizontal or vertical sequence of ≥2 cells.
function computeWordSlots(cells) {
  const slots = [];
  const byRow = {}, byCol = {};
  cells.forEach((c, i) => {
    (byRow[c.y] = byRow[c.y] || []).push({ v: c.x, idx: i });
    (byCol[c.x] = byCol[c.x] || []).push({ v: c.y, idx: i });
  });
  const addRuns = groups => {
    for (const items of Object.values(groups)) {
      items.sort((a, b) => a.v - b.v);
      let run = [items[0].idx];
      for (let i = 1; i <= items.length; i++) {
        if (i < items.length && items[i].v === items[i - 1].v + 1) {
          run.push(items[i].idx);
        } else {
          if (run.length >= 2) slots.push(run);
          run = i < items.length ? [items[i].idx] : [];
        }
      }
    }
  };
  addRuns(byRow);
  addRuns(byCol);
  return slots;
}

// ── Multiplier placement ──────────────────────────────────────────────────────
// Picks 2–4 cells randomly; no two may be orthogonally adjacent.
function placeMultipliers(cells, rand) {
  const count = 2 + Math.floor(rand() * 3); // 2, 3, or 4
  const indices = shuffle([...Array(cells.length).keys()], rand);
  const placed = [];
  for (const idx of indices) {
    if (placed.length >= count) break;
    const { x, y } = cells[idx];
    if (!placed.some(p => Math.abs(cells[p].x - x) + Math.abs(cells[p].y - y) === 1))
      placed.push(idx);
  }
  return placed.map(idx => ({ idx, multiplier: rand() < 0.7 ? 2 : 3 }));
}

// ── Backtracking solver ───────────────────────────────────────────────────────
// Returns the number of complete valid fills found (up to `target`), or -1
// if the solver hit the node limit before finding `target` configs.
function countConfigs(wordSlots, bankIn, dictByLen, target) {
  const bank = { ...bankIn };
  // Process longer slots first: they constrain more cells and prune earlier.
  const slots = [...wordSlots].sort((a, b) => b.length - a.length);
  const assignment = new Array(Object.keys(bankIn).reduce((_, __, ___, obj) => obj, {}));
  const assign = {};
  let found = 0, nodes = 0, aborted = false;

  function solve(si) {
    if (nodes++ > MAX_SOLVER_NODES) { aborted = true; return true; }
    if (si === slots.length) { found++; return found >= target; }

    const slot = slots[si];
    const words = dictByLen[slot.length];
    if (!words) return false;

    for (const word of words) {
      const newCells = [], spent = [];
      let ok = true;

      for (let i = 0; i < slot.length; i++) {
        const ci = slot[i], ltr = word[i];
        if (assign[ci] !== undefined) {
          if (assign[ci] !== ltr) { ok = false; break; }
        } else {
          if ((bank[ltr] || 0) <= 0) { ok = false; break; }
          bank[ltr]--;
          spent.push(ltr);
          assign[ci] = ltr;
          newCells.push(ci);
        }
      }

      const done = ok && solve(si + 1);
      for (const ci of newCells) delete assign[ci];
      for (const l of spent) bank[l] = (bank[l] || 0) + 1;
      if (done) return true;
    }
    return false;
  }

  solve(0);
  return aborted ? -1 : found;
}

// ── Max score ─────────────────────────────────────────────────────────────────
function computeMaxScore(cells, tiles, cellCount) {
  const mults = cells.map(c => c.multiplier || 1).sort((a, b) => b - a);
  const pts = [...tiles].map(t => t.points).sort((a, b) => b - a).slice(0, cellCount);
  return mults.reduce((s, m, i) => s + m * (pts[i] || 0), 0);
}

// ── Date utilities ────────────────────────────────────────────────────────────
function dateToSeed(d) { return parseInt(d.replace(/-/g, ''), 10); }
function addDays(d, n) {
  const dt = new Date(d + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function dateRange(s, e) {
  const out = [];
  for (let cur = s; cur <= e; cur = addDays(cur, 1)) out.push(cur);
  return out;
}

// ── Args ──────────────────────────────────────────────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const args = process.argv.slice(2);
let startDate, endDate, extraTiles = 9, dryRun = false, maxAttempts = 250;
const pos = [];
for (let i = 0; i < args.length; i++) {
  if      (args[i] === '--dry-run')  dryRun = true;
  else if (args[i] === '--extra')    extraTiles  = parseInt(args[++i], 10);
  else if (args[i] === '--attempts') maxAttempts = parseInt(args[++i], 10);
  else pos.push(args[i]);
}
if (!pos[0] || !DATE_RE.test(pos[0])) {
  console.error('Usage: node generate.js YYYY-MM-DD [YYYY-MM-DD] [--extra N] [--attempts N] [--dry-run]');
  process.exit(1);
}
startDate = pos[0];
endDate = pos[1] && DATE_RE.test(pos[1]) ? pos[1] : startDate;

// ── Load ──────────────────────────────────────────────────────────────────────
process.stdout.write('Loading dictionary… ');
const dictByLen = loadDict();
const totalWords = Object.values(dictByLen).reduce((s, a) => s + a.length, 0);
console.log(`${totalWords.toLocaleString()} words`);

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const templates = config.algorithm.layout_templates;
const pool = buildPool(config.algorithm.tile_distribution);

// ── Generate ──────────────────────────────────────────────────────────────────
const dates = dateRange(startDate, endDate);
const results = [];
let skipped = 0;

for (const date of dates) {
  if (config.custom_puzzles[date]) { skipped++; continue; }

  const seed     = dateToSeed(date);
  const baseRand = makeRng(seed);

  // Template selection — must be the first PRNG call (matches game's seeded algo)
  const tIdx     = Math.floor(baseRand() * templates.length);
  const template = templates[tIdx];
  const cells    = template.cells; // [{x,y}] — no multipliers
  const cellCount = cells.length;
  const drawCount = cellCount + extraTiles;

  const wordSlots   = computeWordSlots(cells);
  const multipliers = placeMultipliers(cells, baseRand); // consumes baseRand further

  // Find a tile draw that yields ≥5 complete valid crossword fills.
  // Uses separate, deterministic seeds so results are reproducible.
  let validDrawn = null;
  let attemptsUsed = 0;

  for (let a = 0; a < maxAttempts; a++) {
    // Each attempt gets its own PRNG so order of successful attempt is stable.
    const tRand = makeRng((seed ^ ((a + 1) * 0x9e3779b9)) | 0);
    const drawn  = shuffle([...pool], tRand).slice(0, drawCount);
    const bank   = buildBank(drawn);

    const count = countConfigs(wordSlots, bank, dictByLen, 5);
    attemptsUsed = a + 1;

    if (count >= 5) { validDrawn = drawn; break; }
    // count === -1 means solver hit the node limit; still try next draw
  }

  if (!validDrawn) {
    console.log(`  ✗ ${date}: no valid bank found after ${attemptsUsed} attempts`);
    continue;
  }

  // Build layout cells with algorithm-placed multipliers
  const puzzleCells = cells.map((c, i) => {
    const m = multipliers.find(p => p.idx === i);
    return { x: c.x, y: c.y, multiplier: m ? m.multiplier : 1 };
  });

  const tiles    = validDrawn.map((l, i) => ({ id: i, letter: l, points: POINTS[l] || 0 }));
  const maxScore = computeMaxScore(puzzleCells, tiles, cellCount);
  const parScore = Math.floor(maxScore * 0.4);

  config.custom_puzzles[date] = {
    layout: { name: template.name, dimensions: template.dimensions, cells: puzzleCells },
    tiles,
    maxScore,
    parScore
  };

  results.push({ date, template: template.name, cellCount, drawCount, maxScore, parScore, attempts: attemptsUsed });
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log('');
if (results.length) {
  const nw = Math.max(...results.map(r => r.template.length));
  console.log(`  ${'Date'.padEnd(12)} ${'Template'.padEnd(nw + 2)} Cells  Bank  Tries  Max  Par`);
  console.log('  ' + '─'.repeat(12 + nw + 2 + 32));
  for (const r of results) {
    console.log(
      `  ${r.date.padEnd(12)} ${r.template.padEnd(nw + 2)}` +
      ` ${String(r.cellCount).padStart(5)}  ${String(r.drawCount).padStart(4)}` +
      `  ${String(r.attempts).padStart(5)}  ${String(r.maxScore).padStart(4)}  ${String(r.parScore).padStart(3)}`
    );
  }
}
console.log(`\n  Generated: ${results.length}  Skipped: ${skipped}  Total: ${dates.length}\n`);

if (dryRun)        { console.log('  --dry-run: no changes written.\n'); process.exit(0); }
if (!results.length) { console.log('  Nothing to write.\n'); process.exit(0); }

const sorted = {};
for (const k of Object.keys(config.custom_puzzles).sort()) sorted[k] = config.custom_puzzles[k];
config.custom_puzzles = sorted;
fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
console.log(`  Wrote ${CONFIG_PATH}\n`);
