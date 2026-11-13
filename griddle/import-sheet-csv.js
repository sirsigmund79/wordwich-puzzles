/**
 * One-time move of Griddle off Google Sheets: turns a CSV export of the
 * "Word Hash Puzzles" sheet into griddle/puzzles.json.
 *
 *   node import-sheet-csv.js path/to/export.csv            # writes puzzles.json
 *   node import-sheet-csv.js path/to/export.csv --dry-run
 *
 * Each day is resolved exactly the way the game used to resolve it from the
 * sheet (rows matched by difficulty, leftovers fill empty slots in id order),
 * so every day plays as it did. Ids are kept as-is, since saved progress and
 * stats on players' devices are keyed on them.
 *
 * Only re-run this if the sheet changed after the import; it replaces
 * puzzles.json wholesale.
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { LEVELS, savePuzzleFile, wordsFromGrid } from './puzzles-json.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE   = path.join(SCRIPT_DIR, 'puzzles.json');

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r') { /* skip */ }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function sheetDateToIso(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s ?? '').trim());
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

// Some sheet cells were pasted CSV-quoted twice; the game repaired them on read.
function parseDefinitions(raw) {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { /* try the repair */ }
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    try { return JSON.parse(t.slice(1, -1).replace(/""/g, '"')); } catch { /* give up */ }
  }
  return [];
}

const defaultPar = d => (d === 'Easy' ? 1 : d === 'Medium' ? 2 : 4);

function main() {
  const [csvPath] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const dryRun = process.argv.includes('--dry-run');
  if (!csvPath) { console.error('Usage: node import-sheet-csv.js export.csv [--dry-run]'); process.exit(1); }

  const [header, ...body] = parseCSV(fs.readFileSync(csvPath, 'utf8'));
  const col = name => header.indexOf(name);
  const C = {
    id: col('id'), difficulty: col('difficulty'), extraLetters: col('extraLetters'),
    solutionGrid: col('solutionGrid'), staticCells: col('staticCells'),
    puzzleDate: col('puzzleDate'), griddleNumber: col('griddleNumber'),
    definitions: col('definitions'), par: col('Par') !== -1 ? col('Par') : col('par'),
  };
  for (const k of ['id', 'solutionGrid', 'staticCells', 'puzzleDate']) {
    if (C[k] === -1) throw new Error(`Sheet has no "${k}" column`);
  }

  const byDate = new Map();
  for (const r of body) {
    const date = sheetDateToIso(r[C.puzzleDate]);
    if (!date || !r[C.solutionGrid]?.trim()) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(r);
  }

  const data = { schema: 1, days: {} };
  const seenIds = new Set();
  const notes = [];

  for (const date of [...byDate.keys()].sort()) {
    const rows = byDate.get(date).sort((a, b) => Number(a[C.id]) - Number(b[C.id]));

    const slots = [null, null, null], rest = [];
    for (const r of rows) {
      const i = LEVELS.indexOf(r[C.difficulty]);
      if (i !== -1 && !slots[i]) slots[i] = r; else rest.push(r);
    }
    slots.forEach((s, i) => { if (!s && rest.length) slots[i] = rest.shift(); });
    if (rest.length) notes.push(`${date}: ${rest.length} extra row(s) dropped (the game never showed them)`);

    const puzzles = slots.filter(Boolean).map((r, i) => {
      const id = Number(r[C.id]);
      if (seenIds.has(id)) throw new Error(`Duplicate id ${id} on ${date}`);
      seenIds.add(id);

      const solutionGrid = JSON.parse(r[C.solutionGrid]);
      const staticCells  = JSON.parse(r[C.staticCells]);
      const sheetDifficulty = r[C.difficulty] || null;
      const difficulty = LEVELS.includes(sheetDifficulty) ? sheetDifficulty : LEVELS[i];

      const p = {
        id,
        difficulty,
        solutionGrid,
        staticCells,
        words: wordsFromGrid(solutionGrid),
        definitions: parseDefinitions(r[C.definitions]),
      };

      // The game read a lowercase `par` column, so the sheet's "Par" was never
      // applied; par came from the sheet's difficulty, and a blank difficulty
      // meant 4. Keep the par players actually saw, and carry over the "Par"
      // values that were evidently meant to apply.
      const sheetPar = C.par !== -1 ? r[C.par]?.trim() : '';
      if (sheetPar) {
        p.par = Number(sheetPar);
        if (p.par !== defaultPar(sheetDifficulty)) notes.push(`${date} ${difficulty}: par ${p.par} from the sheet's Par column (was showing ${defaultPar(sheetDifficulty)})`);
      } else if (defaultPar(sheetDifficulty) !== defaultPar(difficulty)) {
        p.par = defaultPar(sheetDifficulty);
      }

      const extra = C.extraLetters !== -1 ? r[C.extraLetters]?.trim() : '';
      if (extra) p.extraLetters = extra;
      return p;
    });

    data.days[date] = { griddleNumber: Number(rows[0][C.griddleNumber]) || 0, puzzles };
  }

  const dates = Object.keys(data.days);
  console.log(`${dates.length} days, ${seenIds.size} puzzles, ${dates[0]} to ${dates.at(-1)}`);
  notes.forEach(n => console.log(`  note: ${n}`));
  if (dryRun) return;
  savePuzzleFile(OUT_FILE, data);
  console.log(`Wrote ${OUT_FILE}`);
}

main();
