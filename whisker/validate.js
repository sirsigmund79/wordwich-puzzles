#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'whisker_config.json');
let config;

try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  console.error(`✗ Failed to parse whisker_config.json: ${e.message}`);
  process.exit(1);
}

const errors = [];
let layoutsValid = 0;
let customPuzzlesValid = 0;

// ── Tile point values ───────────────────────────────────────────────────────
const POINTS = {
  A:1,B:3,C:3,D:2,E:1,F:4,G:2,H:4,I:1,J:8,K:5,L:1,M:3,
  N:1,O:1,P:3,Q:10,R:1,S:1,T:1,U:1,V:4,W:4,X:8,Y:4,Z:10
};

// ── Helpers ─────────────────────────────────────────────────────────────────
function err(msg) { errors.push(msg); }

function getWordSlots(cells) {
  // Returns set of cell keys that belong to at least one word slot (run ≥ 2)
  const cellSet = new Set(cells.map(c => `${c.x},${c.y}`));
  const inSlot = new Set();

  // Group by row → find horizontal runs
  const byRow = {};
  for (const c of cells) {
    (byRow[c.y] = byRow[c.y] || []).push(c.x);
  }
  for (const [y, xs] of Object.entries(byRow)) {
    const sorted = [...xs].sort((a, b) => a - b);
    let run = [sorted[0]];
    for (let i = 1; i <= sorted.length; i++) {
      if (i < sorted.length && sorted[i] === sorted[i - 1] + 1) {
        run.push(sorted[i]);
      } else {
        if (run.length >= 2) run.forEach(x => inSlot.add(`${x},${y}`));
        run = i < sorted.length ? [sorted[i]] : [];
      }
    }
  }

  // Group by col → find vertical runs
  const byCol = {};
  for (const c of cells) {
    (byCol[c.x] = byCol[c.x] || []).push(c.y);
  }
  for (const [x, ys] of Object.entries(byCol)) {
    const sorted = [...ys].sort((a, b) => a - b);
    let run = [sorted[0]];
    for (let i = 1; i <= sorted.length; i++) {
      if (i < sorted.length && sorted[i] === sorted[i - 1] + 1) {
        run.push(sorted[i]);
      } else {
        if (run.length >= 2) run.forEach(y => inSlot.add(`${x},${y}`));
        run = i < sorted.length ? [sorted[i]] : [];
      }
    }
  }

  return inSlot;
}

function validateLayout(layout, prefix, requireMultiplier = false) {
  const { name, dimensions, cells } = layout;
  if (!name) err(`${prefix}: missing name`);
  if (!dimensions || typeof dimensions.cols !== 'number' || typeof dimensions.rows !== 'number') {
    err(`${prefix}: invalid dimensions`);
    return;
  }
  if (!Array.isArray(cells) || cells.length === 0) {
    err(`${prefix}: cells must be a non-empty array`);
    return;
  }

  // Duplicate check
  const seen = new Set();
  for (const c of cells) {
    const key = `${c.x},${c.y}`;
    if (seen.has(key)) err(`${prefix}: duplicate cell at (${c.x},${c.y})`);
    seen.add(key);
  }

  // Bounds + multiplier check
  for (const c of cells) {
    if (c.x < 0 || c.x >= dimensions.cols) err(`${prefix}: cell (${c.x},${c.y}) x out of bounds [0,${dimensions.cols - 1}]`);
    if (c.y < 0 || c.y >= dimensions.rows) err(`${prefix}: cell (${c.x},${c.y}) y out of bounds [0,${dimensions.rows - 1}]`);
    if (requireMultiplier || c.multiplier !== undefined) {
      if (!Number.isInteger(c.multiplier) || c.multiplier < 1)
        err(`${prefix}: cell (${c.x},${c.y}) multiplier must be integer ≥ 1`);
    }
  }

  // Word-slot coverage
  const inSlot = getWordSlots(cells);
  for (const c of cells) {
    const key = `${c.x},${c.y}`;
    if (!inSlot.has(key)) err(`${prefix}: cell (${c.x},${c.y}) is isolated (no word slot of length ≥ 2)`);
  }
}

// ── Validate algorithm section ───────────────────────────────────────────────
if (!config.algorithm) {
  err('Missing config.algorithm');
} else {
  // Tile distribution
  const dist = config.algorithm.tile_distribution;
  if (!dist || typeof dist !== 'object') {
    err('algorithm.tile_distribution must be an object');
  } else {
    for (const [letter, count] of Object.entries(dist)) {
      if (!Number.isInteger(count) || count < 1) {
        err(`tile_distribution["${letter}"] must be a positive integer, got ${count}`);
      }
    }
  }

  // Layout templates
  const templates = config.algorithm.layout_templates;
  if (!Array.isArray(templates) || templates.length === 0) {
    err('algorithm.layout_templates must be a non-empty array');
  } else {
    for (const t of templates) {
      validateLayout(t, `layout "${t.name || '?'}"`);
      if (errors.length === 0 || !errors.some(e => e.startsWith(`layout "${t.name}"`))) {
        layoutsValid++;
      }
    }
    layoutsValid = templates.length - errors.filter(e => e.startsWith('layout ')).length;
  }
}

// ── Validate custom_puzzles ──────────────────────────────────────────────────
const custom = config.custom_puzzles;
if (custom && typeof custom === 'object') {
  for (const [date, puzzle] of Object.entries(custom)) {
    const prefix = `custom_puzzle "${date}"`;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      err(`${prefix}: key must be YYYY-MM-DD`);
    }

    if (!puzzle.layout) {
      err(`${prefix}: missing layout`);
    } else {
      validateLayout(puzzle.layout, `${prefix} layout`, true);
    }

    if (!Array.isArray(puzzle.tiles)) {
      err(`${prefix}: tiles must be an array`);
    } else {
      const cellCount = puzzle.layout?.cells?.length ?? 0;
      if (puzzle.tiles.length < cellCount) {
        err(`${prefix}: tiles.length (${puzzle.tiles.length}) is less than cell count (${cellCount})`);
      }
      const ids = new Set();
      for (const tile of puzzle.tiles) {
        if (typeof tile.id !== 'number') err(`${prefix}: tile missing numeric id`);
        if (typeof tile.letter !== 'string' || tile.letter.length !== 1) err(`${prefix}: tile id=${tile.id} has invalid letter`);
        if (typeof tile.points !== 'number' || tile.points < 0) err(`${prefix}: tile id=${tile.id} has invalid points`);
        if (ids.has(tile.id)) err(`${prefix}: duplicate tile id ${tile.id}`);
        ids.add(tile.id);
      }

      // Compute and report expected maxScore (uses top cellCount tiles when extra tiles present)
      if (puzzle.layout?.cells && puzzle.tiles.length >= cellCount) {
        const sortedMults = [...puzzle.layout.cells].map(c => c.multiplier || 1).sort((a, b) => b - a);
        const sortedPts = [...puzzle.tiles].map(t => t.points).sort((a, b) => b - a).slice(0, cellCount);
        const computedMax = sortedMults.reduce((sum, m, i) => sum + m * (sortedPts[i] || 0), 0);
        if (typeof puzzle.maxScore !== 'number' || puzzle.maxScore < 0) {
          err(`${prefix}: maxScore must be a non-negative number`);
        } else if (puzzle.maxScore !== 0 && puzzle.maxScore !== computedMax) {
          console.warn(`  ⚠ ${prefix}: maxScore is ${puzzle.maxScore}, computed optimal is ${computedMax}`);
        }
      }
    }

    customPuzzlesValid++;
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
if (errors.length === 0) {
  console.log(`✓ ${layoutsValid} layouts valid, ${customPuzzlesValid} custom puzzles, 0 errors`);
} else {
  console.log(`✗ ${layoutsValid} layouts valid, ${customPuzzlesValid} custom puzzles, ${errors.length} error(s):`);
  for (const e of errors) console.log(`  · ${e}`);
  process.exit(1);
}
