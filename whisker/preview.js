#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// ── PRNG (matches game's mulberry32) ─────────────────────────────────────────
function mulberry32(seed) {
  seed |= 0;
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function makeRng(seed) {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    s = t; // advance state
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Tile point values ────────────────────────────────────────────────────────
const POINTS = {
  A:1,B:3,C:3,D:2,E:1,F:4,G:2,H:4,I:1,J:8,K:5,L:1,M:3,
  N:1,O:1,P:3,Q:10,R:1,S:1,T:1,U:1,V:4,W:4,X:8,Y:4,Z:10
};

// ── Fisher-Yates shuffle ─────────────────────────────────────────────────────
function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Build weighted tile pool from distribution ───────────────────────────────
function buildPool(distribution) {
  const pool = [];
  for (const [letter, count] of Object.entries(distribution)) {
    for (let i = 0; i < count; i++) pool.push(letter);
  }
  return pool;
}

// ── ASCII grid renderer ──────────────────────────────────────────────────────
function renderGrid(template, tiles) {
  const { dimensions, cells } = template;
  const cellMap = {};
  cells.forEach((c, i) => { cellMap[`${c.x},${c.y}`] = { ...c, tile: tiles[i] || null }; });

  const multSymbol = m => m >= 3 ? '③' : m === 2 ? '②' : ' ';

  const lines = [];
  // Column header
  lines.push('   ' + Array.from({ length: dimensions.cols }, (_, x) => ` ${x} `).join(''));
  lines.push('   ' + '───'.repeat(dimensions.cols));

  for (let y = 0; y < dimensions.rows; y++) {
    let row = `${String(y).padStart(2)} |`;
    for (let x = 0; x < dimensions.cols; x++) {
      const key = `${x},${y}`;
      if (cellMap[key]) {
        const { tile, multiplier } = cellMap[key];
        const letter = tile ? tile.letter : '□';
        row += ` ${letter}${multSymbol(multiplier)}`;
      } else {
        row += '   ';
      }
    }
    lines.push(row);
  }
  return lines.join('\n');
}

// ── Multiplier placement (mirrors generate.js) ───────────────────────────────
// Max 4 multipliers, no two orthogonally adjacent.
function placeMultipliers(cells, rand) {
  const count = 2 + Math.floor(rand() * 3);
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

// ── Max score calculation ────────────────────────────────────────────────────
function computeMaxScore(cells, tiles, cellCount) {
  const mults = cells.map(c => c.multiplier || 1).sort((a, b) => b - a);
  const pts = [...tiles].map(t => t.points).sort((a, b) => b - a).slice(0, cellCount);
  return mults.reduce((sum, m, i) => sum + m * (pts[i] || 0), 0);
}

// ── Main ─────────────────────────────────────────────────────────────────────
const configPath = path.join(__dirname, 'whisker_config.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  console.error(`Failed to read whisker_config.json: ${e.message}`);
  process.exit(1);
}

const dateArg = process.argv[2];
let dateStr;
if (dateArg) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
    console.error('Usage: node preview.js [YYYY-MM-DD]');
    process.exit(1);
  }
  dateStr = dateArg;
} else {
  const now = new Date();
  dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

console.log(`\n═══ Whisker Preview: ${dateStr} ${'═'.repeat(40 - dateStr.length)}\n`);

// Check for custom puzzle override
const custom = config.custom_puzzles?.[dateStr];
if (custom) {
  console.log('★  CUSTOM PUZZLE OVERRIDE for this date\n');
  console.log(`Layout: ${custom.layout.name} (${custom.layout.dimensions.cols}×${custom.layout.dimensions.rows}, ${custom.layout.cells.length} cells)\n`);
  console.log(renderGrid(custom.layout, custom.tiles));
  console.log('\nTile bank:');
  console.log(custom.tiles.map(t => `  ${t.letter} (${t.points}pt)`).join('\n'));
  const maxScore = custom.maxScore || computeMaxScore(custom.layout.cells, custom.tiles, custom.layout.cells.length);
  console.log(`\nMax score:  ${maxScore}`);
  console.log(`Par score:  ${Math.floor(maxScore * 0.4)}`);
  process.exit(0);
}

// Seeded generation
const seed = parseInt(dateStr.replace(/-/g, ''), 10);
const rand = makeRng(seed);

const templates = config.algorithm.layout_templates;
const templateIdx = Math.floor(rand() * templates.length);
const template = templates[templateIdx];
const cellCount = template.cells.length;

// Place multipliers (same algorithm as generate.js, same PRNG state)
const multPlacements = placeMultipliers(template.cells, rand);
const cells = template.cells.map((c, i) => ({
  ...c,
  multiplier: (multPlacements.find(m => m.idx === i) || {}).multiplier || 1
}));

// Draw tiles (PRNG continues after multiplier placement)
const pool = shuffle(buildPool(config.algorithm.tile_distribution), rand);
const drawnLetters = pool.slice(0, cellCount);

const tiles = drawnLetters.map((letter, i) => ({
  id: i,
  letter,
  points: POINTS[letter] ?? 0
}));

const maxScore = computeMaxScore(cells, tiles, cellCount);

console.log(`Template:   #${templateIdx} "${template.name}" (${template.dimensions.cols}×${template.dimensions.rows}, ${cellCount} cells)`);
console.log(`Seed:       ${seed}\n`);
console.log(renderGrid({ ...template, cells }, tiles));

console.log('\nTile bank:');
const sorted = [...tiles].sort((a, b) => b.points - a.points || a.letter.localeCompare(b.letter));
const rows = [];
for (let i = 0; i < sorted.length; i += 6) {
  rows.push('  ' + sorted.slice(i, i + 6).map(t => `${t.letter}(${t.points})`).join('  '));
}
console.log(rows.join('\n'));

console.log(`\nMax score:  ${maxScore}`);
console.log(`Par score:  ${Math.floor(maxScore * 0.4)}`);
console.log(`\nMultiplier key:  ②=×2  ③=×3  (blank=×1)`);
console.log('');
