/**
 * generate-griddles.mjs
 *
 * Generates Griddle puzzle candidates and outputs them as a CSV file
 * ready to copy-paste into your Google Sheet.
 *
 * WHAT THIS SCRIPT DOES:
 *   For each date in the requested range it:
 *   1. Loads your two word files (common words + full dictionary) from the repo
 *   2. Generates three valid 5x5 grids (Easy, Medium, Hard) using the same
 *      word-intersection algorithm as your waffle-generator HTML tool
 *   3. Validates all 6 words in each grid against the Free Dictionary API —
 *      grids with any invalid/proper-noun words are retried automatically
 *   4. Applies difficulty-appropriate staticCells patterns using the same
 *      logic as your Apps Script
 *   5. Writes one CSV row per puzzle (3 rows per date), including the words
 *      and their definitions for post-game display
 *
 * THE GRID STRUCTURE (always the same):
 *   Rows 0, 2, 4 are horizontal words (H1, H2, H3)
 *   Cols 0, 2, 4 are vertical words   (V1, V2, V3)
 *   The four "hole" positions [1,1] [1,3] [3,1] [3,3] are always null
 *   All other cells are letter-bearing grid cells
 *
 * OUTPUT CSV COLUMNS:
 *   puzzleDate  | difficulty | solutionGrid | staticCells | words | definitions
 *
 *   puzzleDate   — M/D/YYYY format (matches what your game reads from the sheet)
 *   difficulty   — Easy / Medium / Hard
 *   solutionGrid — JSON string, 5x5 array, nulls at hole positions
 *   staticCells  — JSON string, 5x5 array of true/false/null
 *   words        — JSON array of the 6 words: [h1, h2, h3, v1, v2, v3]
 *   definitions  — JSON array of {word, pos, def} objects, one per word,
 *                  same order as `words`. Use for post-game definition display.
 *
 * HOW TO RUN:
 *   node generate-griddles.mjs                              # today, 3 puzzles
 *   node generate-griddles.mjs --date 2026-07-04            # specific date
 *   node generate-griddles.mjs --start 2026-07-01 --end 2026-07-31
 *   node generate-griddles.mjs --dry-run                    # print to console only
 *   node generate-griddles.mjs --count 5                    # generate 5 candidates
 *                                                            # per difficulty per date
 *                                                            # so you can pick the best
 *   node generate-griddles.mjs --skip-validation            # skip dictionary API checks
 *                                                            # (faster, no definitions)
 *   node generate-griddles.mjs --no-dedupe                  # skip recent-word exclusion
 *
 * WORD DEDUPLICATION:
 *   By default the script reads all existing CSV files in ./output/ and excludes
 *   any word that appeared in a puzzle within the last 40 days of the target date.
 *   This prevents players from seeing the same word twice within a 40-day window.
 *   Words generated during the current run are also tracked, so a word used on an
 *   earlier date in the same batch won't appear on a later date within 40 days.
 *   Use --no-dedupe to disable this (e.g. if your word list is very small).
 *
 * SETUP:
 *   Make sure your word files are accessible. The script reads them from your
 *   GitHub repo. Alternatively, place them in the same folder and pass local paths:
 *   node generate-griddles.mjs --common common_words.txt --dict wordle_words.txt
 *
 * OUTPUT:
 *   ./output/griddles-YYYY-MM-DD.csv  (one file per run)
 *   Open in Excel or Google Sheets, then copy rows into your puzzle sheet.
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output');

// Default word files — resolved relative to this script so no network call is needed.
// Primary pool: Wordle answer words — common, recognizable, preferred for grid slots.
const COMMON_WORDS_DEFAULT = path.join(SCRIPT_DIR, 'wordle_words.txt');
// Fallback pool: all 5-letter words from the Letterloaf dictionary (~8,939 words).
// Obscure entries are filtered out naturally by the dictionary API validation step.
const DICT_WORDS_DEFAULT   = path.join(SCRIPT_DIR, 'griddle_dict.txt');

// Free Dictionary API base URL used to validate words and fetch definitions.
const FREE_DICT_API = 'https://api.dictionaryapi.dev/api/v2/entries/en';

// How many generation attempts before giving up on a date/difficulty combo.
// The HTML tool uses 5000; we use the same.
const MAX_ATTEMPTS = 5000;

// How many times to try a new generated grid when words fail dictionary
// validation. Each retry uses a different seed so it produces different words.
const MAX_VALIDATION_RETRIES = 50;

// Words used in puzzles within this many days of the target date are excluded
// from generation to avoid players seeing the same word twice in a short window.
const RECENT_WORD_WINDOW_DAYS = 40;

// How many candidate grids to generate per difficulty level per date.
// Default 1 gives you one grid per difficulty. Use --count 3 to get
// multiple options to choose from in the spreadsheet.
let CANDIDATES_PER_DIFFICULTY = 1;

// Difficulty settings — mirrors your Apps Script GRID_CONFIG exactly
const GRID_CONFIG = {
  Easy:   { minLocked: 11, maxLocked: 14, helperWeight: 0.8 },
  Medium: { minLocked:  11, maxLocked: 12, helperWeight: 0.4 },
  Hard:   { minLocked:  9, maxLocked: 10, helperWeight: 0.1 },
};

// The four "hole" positions — always the same in every Griddle puzzle.
// These cells are always null in both solutionGrid and staticCells.
const HOLES = [[1,1],[1,3],[3,1],[3,3]];

// "Helper" corners — the Apps Script biases toward locking these on Easy
// puzzles because they're the corners and center, easiest for players to
// use as anchors. Same as your helperCoords in the Apps Script.
const HELPER_COORDS = [[0,0],[0,4],[4,0],[4,4],[2,2]];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function dateRange(startStr, endStr) {
  const dates = [];
  const cur = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr   + 'T00:00:00');
  while (cur <= end) {
    dates.push(cur.toISOString().split('T')[0]);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// Convert YYYY-MM-DD to M/D/YYYY (the format your game reads from the sheet)
function toSheetDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${m}/${d}/${y}`;
}

// Seeded random for reproducible output — same puzzle every time for same date
function seededRand(seed) {
  let s = seed;
  return function() {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function dateSeed(dateStr, difficulty, candidateIndex) {
  // Different seed per date + difficulty + candidate so each combination
  // produces a unique grid. Difficulty offset prevents Easy/Medium/Hard from
  // all generating the same words.
  const base = parseInt(dateStr.replace(/-/g, ''), 10);
  const diffOffset = { Easy: 0, Medium: 777777, Hard: 1555555 }[difficulty] ?? 0;
  return base + diffOffset + candidateIndex * 99991;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Recently-used word deduplication
// ---------------------------------------------------------------------------

// dateWordMap: Map<YYYY-MM-DD, Set<UPPERCASE_WORD>>
// Built at startup from historical CSV files and updated as each new puzzle
// is generated, so within-run date ordering is also respected.
const dateWordMap = new Map();

function sheetDateToIso(sheetDate) {
  // "M/D/YYYY" → "YYYY-MM-DD"
  const [m, d, y] = sheetDate.split('/').map(Number);
  if (!y || !m || !d) throw new Error(`Unparseable date: ${sheetDate}`);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function extractWordsFromGrid(grid) {
  // Reconstructs [h1, h2, h3, v1, v2, v3] from a parsed solutionGrid.
  if (!Array.isArray(grid) || grid.length < 5) return [];
  const get = (r, c) => grid[r]?.[c] ?? '';
  const words = [
    [0,1,2,3,4].map(c => get(0, c)).join(''), // h1
    [0,1,2,3,4].map(c => get(2, c)).join(''), // h2
    [0,1,2,3,4].map(c => get(4, c)).join(''), // h3
    [0,1,2,3,4].map(r => get(r, 0)).join(''), // v1
    [0,1,2,3,4].map(r => get(r, 2)).join(''), // v2
    [0,1,2,3,4].map(r => get(r, 4)).join(''), // v3
  ];
  return words.filter(w => w.length === 5 && /^[A-Z]+$/.test(w));
}

function parseCSV(text) {
  // RFC 4180-compliant parser that handles quoted fields containing commas,
  // newlines, and doubled-quote escaping ("") — the exact format this script
  // produces for solutionGrid/staticCells.
  const rows = [];
  let row = [], field = '', inQ = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // "" → "
        else                      { inQ = false; }        // closing quote
      } else {
        field += ch;
      }
    } else {
      if      (ch === '"')  { inQ = true; }
      else if (ch === ',')  { row.push(field); field = ''; }
      else if (ch === '\r') { /* skip CR */ }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else                  { field += ch; }
    }
  }
  if (field || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function loadHistoricalWords(outputDir) {
  // Reads all CSV files in outputDir and populates dateWordMap.
  // Supports both old (4-column) and new (6-column) file formats.
  if (!fs.existsSync(outputDir)) return 0;

  const csvFiles = fs.readdirSync(outputDir)
    .filter(f => f.endsWith('.csv'))
    .map(f => path.join(outputDir, f));

  let totalDates = 0;

  for (const csvFile of csvFiles) {
    try {
      const text  = fs.readFileSync(csvFile, 'utf8');
      const rows  = parseCSV(text);
      if (rows.length < 2) continue;

      const header   = rows[0];
      const dateCol  = header.indexOf('puzzleDate');
      const wordsCol = header.indexOf('words');       // present in new format
      const gridCol  = header.indexOf('solutionGrid');

      if (dateCol === -1 || gridCol === -1) continue;

      for (const row of rows.slice(1)) {
        const rawDate = row[dateCol]?.trim();
        if (!rawDate) continue;

        let dateStr;
        try { dateStr = sheetDateToIso(rawDate); } catch { continue; }

        // Prefer the `words` column; fall back to parsing solutionGrid
        let words = null;
        if (wordsCol !== -1 && row[wordsCol]) {
          try { words = JSON.parse(row[wordsCol]); } catch { /* fall through */ }
        }
        if (!words && row[gridCol]) {
          try { words = extractWordsFromGrid(JSON.parse(row[gridCol])); } catch { continue; }
        }
        if (!Array.isArray(words) || words.length === 0) continue;

        if (!dateWordMap.has(dateStr)) { dateWordMap.set(dateStr, new Set()); totalDates++; }
        const set = dateWordMap.get(dateStr);
        for (const w of words) if (w && typeof w === 'string') set.add(w.toUpperCase());
      }
    } catch (err) {
      console.warn(`  Warning: could not read ${path.basename(csvFile)}: ${err.message}`);
    }
  }

  return totalDates;
}

function getRecentlyUsedWords(targetDateStr, windowDays) {
  // Returns a Set of all words used in the [targetDate - windowDays, targetDate - 1] range.
  const used   = new Set();
  const target = new Date(targetDateStr + 'T00:00:00');
  for (let i = 1; i <= windowDays; i++) {
    const d = new Date(target);
    d.setDate(d.getDate() - i);
    const dStr  = d.toISOString().split('T')[0];
    const words = dateWordMap.get(dStr);
    if (words) for (const w of words) used.add(w);
  }
  return used;
}

function registerGeneratedWords(dateStr, words) {
  // Records a newly generated puzzle's words in dateWordMap so later dates in
  // the same run can exclude them.
  if (!dateWordMap.has(dateStr)) dateWordMap.set(dateStr, new Set());
  const set = dateWordMap.get(dateStr);
  for (const w of words) set.add(w.toUpperCase());
}

// ---------------------------------------------------------------------------
// Word file loading
// ---------------------------------------------------------------------------

async function loadWordFile(urlOrPath) {
  // Accepts either a URL (https://...) or a local file path
  let text;
  if (urlOrPath.startsWith('http')) {
    const res = await fetch(urlOrPath);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${urlOrPath}`);
    text = await res.text();
  } else {
    if (!fs.existsSync(urlOrPath)) throw new Error(`File not found: ${urlOrPath}`);
    text = fs.readFileSync(urlOrPath, 'utf8');
  }

  // Keep only 5-letter alphabetic words, uppercased
  // This is identical to how your HTML tool loads word files
  return text
    .split('\n')
    .map(w => w.trim().toUpperCase())
    .filter(w => w.length === 5 && /^[A-Z]+$/.test(w));
}

// ---------------------------------------------------------------------------
// Free Dictionary API — word validation and definition lookup
// ---------------------------------------------------------------------------

// Cache results so the same word is never looked up twice in one run.
const defCache = new Map(); // lowercase word -> { valid, pos, def }

async function lookupWord(word) {
  const key = word.toLowerCase();
  if (defCache.has(key)) return defCache.get(key);

  let result;
  // Retry up to 2 times for transient network/server errors.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${FREE_DICT_API}/${key}`);

      if (!res.ok) {
        // Transient server error — wait and retry
        if (attempt < 2) { await sleep(500 * (attempt + 1)); continue; }
        console.warn(`    Warning: API returned ${res.status} for "${word}", treating as invalid`);
        result = { valid: false };
        break;
      }

      const data = await res.json();

      // The API returns an array of entry objects for known words, or a plain
      // object like {"title":"No Definitions Found",...} for unknown words.
      // Both cases come back as HTTP 200, so we must inspect the body.
      if (!Array.isArray(data) || data.length === 0) {
        result = { valid: false };
        break;
      }

      const firstMeaning = data[0]?.meanings?.[0];
      const pos = firstMeaning?.partOfSpeech ?? '';
      const def = firstMeaning?.definitions?.[0]?.definition ?? '';
      result = { valid: true, pos, def };
      break;

    } catch (err) {
      if (attempt < 2) { await sleep(500 * (attempt + 1)); continue; }
      console.warn(`    Warning: network error looking up "${word}" after 3 attempts: ${err.message}`);
      result = { valid: false };
    }
  }

  defCache.set(key, result);
  return result;
}

// Validates all 6 words against the dictionary API.
// Returns { valid: boolean, invalidWords: string[], definitions: [{word,pos,def}] }
async function validateAndFetchDefinitions(words) {
  const lookups = await Promise.all(words.map(w => lookupWord(w)));
  const invalidWords = words.filter((_, i) => !lookups[i].valid);

  if (invalidWords.length > 0) {
    return { valid: false, invalidWords, definitions: [] };
  }

  const definitions = words.map((w, i) => ({
    word: w,
    pos:  lookups[i].pos,
    def:  lookups[i].def,
  }));

  return { valid: true, invalidWords: [], definitions };
}

// ---------------------------------------------------------------------------
// Waffle (grid) generation algorithm
// This is a direct port of generateWaffle() and buildGrid() from index.html.
// The logic is identical — only the random function differs (seeded vs Math.random).
// ---------------------------------------------------------------------------

function findMatches(pattern, list) {
  // Finds all words in `list` that match a regex pattern.
  // Used to find words fitting a partial constraint like "S....".
  const rx = new RegExp(`^${pattern}$`);
  return list.filter(w => rx.test(w));
}

function getSlotCandidate(pattern, pool, userPool, used, rand) {
  // Tries to find a word for a constrained slot.
  // Prefers words from userPool (common words) over pool (full dictionary).
  // Excludes words already used in this grid attempt.
  const userMatches = findMatches(pattern, userPool).filter(w => !used.has(w));
  if (userMatches.length) {
    return userMatches[Math.floor(rand() * userMatches.length)];
  }
  const dictMatches = findMatches(pattern, pool).filter(w => !used.has(w));
  if (dictMatches.length) {
    return dictMatches[Math.floor(rand() * dictMatches.length)];
  }
  return null; // no valid word found for this slot
}

function generateWaffle(primaryWords, secondaryWords, rand) {
  // Generates a valid set of 6 intersecting 5-letter words.
  // Returns [h1, h2, h3, v1, v2, v3] or null if no valid grid found.
  //
  // Grid layout:
  //   h1 fills row 0: [0,0][0,1][0,2][0,3][0,4]
  //   h2 fills row 2: [2,0][2,1][2,2][2,3][2,4]
  //   h3 fills row 4: [4,0][4,1][4,2][4,3][4,4]
  //   v1 fills col 0: [0,0][1,0][2,0][3,0][4,0]
  //   v2 fills col 2: [0,2][1,2][2,2][3,2][4,2]
  //   v3 fills col 4: [0,4][1,4][2,4][3,4][4,4]
  //
  // Intersection constraints:
  //   v1[0] = h1[0], v1[2] = h2[0], v1[4] = h3[0]
  //   v2[0] = h1[2], v2[2] = h2[2], v2[4] = h3[2]
  //   v3[0] = h1[4], v3[2] = h2[4], v3[4] = h3[4]

  const p1 = primaryWords;    // common words — preferred
  const p2 = secondaryWords;  // full dictionary — fallback

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const used = new Set();

    // Pick h1 first — any word from the common list
    let h1;
    if (p1.length) h1 = p1[Math.floor(rand() * p1.length)];
    else if (p2.length) h1 = p2[Math.floor(rand() * p2.length)];
    else continue;
    used.add(h1);

    // v1, v2, v3 are constrained by h1's letters at positions 0, 2, 4
    const v1 = getSlotCandidate(`${h1[0]}....`, p2, p1, used, rand);
    if (!v1) continue;
    used.add(v1);

    const v2 = getSlotCandidate(`${h1[2]}....`, p2, p1, used, rand);
    if (!v2) continue;
    used.add(v2);

    const v3 = getSlotCandidate(`${h1[4]}....`, p2, p1, used, rand);
    if (!v3) continue;
    used.add(v3);

    // h2 and h3 are constrained by v1/v2/v3 at their middle and bottom letters
    const h2 = getSlotCandidate(`${v1[2]}.${v2[2]}.${v3[2]}`, p2, p1, used, rand);
    if (!h2) continue;
    used.add(h2);

    const h3 = getSlotCandidate(`${v1[4]}.${v2[4]}.${v3[4]}`, p2, p1, used, rand);
    if (!h3) continue;
    used.add(h3);

    // All 6 words must be distinct
    const sol = [h1, h2, h3, v1, v2, v3];
    if (new Set(sol).size === 6) return sol;
  }

  return null; // exhausted attempts
}

function buildGrid(words) {
  // Places the 6 words into a 5x5 grid.
  // Holes ([1,1][1,3][3,1][3,3]) remain null.
  // This is identical to buildGrid() in index.html.
  const [h1, h2, h3, v1, v2, v3] = words;
  const g = Array.from({ length: 5 }, () => Array(5).fill(null));

  // Horizontal words fill their entire rows
  for (let c = 0; c < 5; c++) { g[0][c] = h1[c]; g[2][c] = h2[c]; g[4][c] = h3[c]; }

  // Vertical words fill their entire columns
  // (intersection cells are already set by horizontals and will match)
  for (let r = 0; r < 5; r++) { g[r][0] = v1[r]; g[r][2] = v2[r]; g[r][4] = v3[r]; }

  // Null out the four hole positions
  for (const [r, c] of HOLES) g[r][c] = null;

  return g;
}

// ---------------------------------------------------------------------------
// Static cells generation
// This is a direct port of generateGridForDifficulty() from your Apps Script.
// The logic is identical — only the random function differs (seeded vs Math.random).
// ---------------------------------------------------------------------------

function generateStaticCells(difficulty, rand) {
  // Generates a 5x5 boolean grid where:
  //   true  = cell is pre-filled (player sees the letter, cannot change it)
  //   false = cell is in the letter bank (player must place it)
  //   null  = hole position (not part of the puzzle)

  // Start with a clean grid — holes are null, everything else is false
  const grid = Array.from({ length: 5 }, () => Array(5).fill(false));
  for (const [r, c] of HOLES) grid[r][c] = null;

  const settings = GRID_CONFIG[difficulty] ?? GRID_CONFIG['Medium'];

  // Pick a random target number of locked (true) cells within the range
  const targetCount = Math.floor(
    rand() * (settings.maxLocked - settings.minLocked + 1)
  ) + settings.minLocked;

  const helperWeight = settings.helperWeight;

  // Collect all valid (non-hole) cell coordinates
  const validCoords = [];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      if (grid[r][c] !== null) validCoords.push([r, c]);
    }
  }

  // Shuffle the valid coordinates using the seeded random
  // (the Apps Script uses implicit JS random; we use seeded for reproducibility)
  const coords = [...validCoords];

  let lockedCount = 0;

  while (lockedCount < targetCount && coords.length > 0) {
    // Available helper cells (corners + center) still in the pool
    const availableHelpers = coords.filter(vc =>
      HELPER_COORDS.some(hc => hc[0] === vc[0] && hc[1] === vc[1])
    );

    let index;
    if (availableHelpers.length > 0 && rand() < helperWeight) {
      // Bias toward locking a helper cell (corner/center)
      const helperChoice = availableHelpers[Math.floor(rand() * availableHelpers.length)];
      index = coords.findIndex(vc => vc[0] === helperChoice[0] && vc[1] === helperChoice[1]);
    } else {
      // Pick any valid cell randomly
      index = Math.floor(rand() * coords.length);
    }

    const [r, c] = coords.splice(index, 1)[0];
    grid[r][c] = true;
    lockedCount++;
  }

  return grid;
}

// ---------------------------------------------------------------------------
// CSV formatting
// ---------------------------------------------------------------------------

function escapeCSV(value) {
  // Wraps a value in quotes and escapes internal quotes for CSV safety.
  // Necessary because solutionGrid and staticCells contain commas.
  const str = String(value);
  if (str.includes('"') || str.includes(',') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function gridToJsonStr(grid) {
  // Serializes a 5x5 grid to a visually stacked JSON string matching the
  // format your Google Sheet expects — one row per line, indented with spaces.
  // Letters are double-quoted strings, booleans and nulls are unquoted.
  //
  // solutionGrid output:
  //   [
  //    ["F", "I", "N", "A", "L"],
  //    ["E", null, "E", null, "O"],
  //    ...
  //   ]
  //
  // staticCells output:
  //   [
  //         [false, true, false, false, true],
  //         [true, null, false, null, false],
  //    ...
  //   ]
  //
  // The staticCells format uses 6-space indent per row to match your Apps Script
  // formattedString output exactly.

  // Detect whether this is a solutionGrid (contains strings/null)
  // or a staticCells grid (contains booleans/null)
  const isStaticCells = grid.flat().some(v => typeof v === 'boolean');

  const indent = isStaticCells ? '      ' : ' ';

  const rows = grid.map(row => {
    const cells = row.map(cell => {
      if (cell === null)          return 'null';
      if (typeof cell === 'boolean') return cell ? 'true' : 'false';
      return `"${cell}"`;
    });
    return `${indent}[${cells.join(', ')}]`;
  });

  return `[\n${rows.join(',\n')}\n    ]`;
}

function buildCSVRow(dateStr, difficulty, solutionGrid, staticCells, words, definitions) {
  const sheetDate = toSheetDate(dateStr);
  const solJson   = gridToJsonStr(solutionGrid);
  const statJson  = gridToJsonStr(staticCells);
  // words: simple JSON array ["H1","H2","H3","V1","V2","V3"]
  const wordsJson = JSON.stringify(words);
  // definitions: JSON array of {word, pos, def} objects for post-game display
  const defsJson  = JSON.stringify(definitions);

  return [
    escapeCSV(sheetDate),
    escapeCSV(difficulty),
    escapeCSV(solJson),
    escapeCSV(statJson),
    escapeCSV(wordsJson),
    escapeCSV(defsJson),
  ].join(',');
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dates:          null,
    dryRun:         false,
    count:          1,
    commonFile:     null,
    dictFile:       null,
    skipValidation: false,
    noDedupe:       false,
  };

  let startDate = null;
  let endDate   = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i+1]) {
      opts.dates = [args[++i]];
    } else if (args[i] === '--start' && args[i+1]) {
      startDate = args[++i];
    } else if (args[i] === '--end' && args[i+1]) {
      endDate = args[++i];
    } else if (args[i] === '--dry-run') {
      opts.dryRun = true;
    } else if (args[i] === '--count' && args[i+1]) {
      opts.count = parseInt(args[++i]) || 1;
    } else if (args[i] === '--common' && args[i+1]) {
      opts.commonFile = args[++i];
    } else if (args[i] === '--dict' && args[i+1]) {
      opts.dictFile = args[++i];
    } else if (args[i] === '--skip-validation') {
      opts.skipValidation = true;
    } else if (args[i] === '--no-dedupe') {
      opts.noDedupe = true;
    }
  }

  if (startDate && !opts.dates) {
    opts.dates = dateRange(startDate, endDate ?? todayStr());
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Griddle Puzzle Generator ===\n');

  const opts = parseArgs();
  CANDIDATES_PER_DIFFICULTY = opts.count;

  const datesToProcess = opts.dates ?? [todayStr()];
  console.log(`Dates: ${datesToProcess.length}  |  Candidates per difficulty: ${CANDIDATES_PER_DIFFICULTY}`);
  if (opts.skipValidation) console.log('Dictionary validation: SKIPPED (--skip-validation)');
  else                     console.log(`Dictionary validation: ON (up to ${MAX_VALIDATION_RETRIES} retries per candidate)`);
  if (opts.noDedupe) console.log('Word deduplication:   SKIPPED (--no-dedupe)');
  else               console.log(`Word deduplication:   ON (${RECENT_WORD_WINDOW_DAYS}-day window)`);
  if (opts.dryRun) console.log('DRY RUN: no files will be written.\n');

  const commonUrl = opts.commonFile ?? COMMON_WORDS_DEFAULT;
  const dictUrl   = opts.dictFile   ?? DICT_WORDS_DEFAULT;

  console.log('\nLoading word files...');
  let commonWords, dictWords;
  try {
    commonWords = await loadWordFile(commonUrl);
    console.log(`  Common words: ${commonWords.length.toLocaleString()}`);
  } catch (err) {
    console.error(`  Could not load common words: ${err.message}`);
    console.error('  Add your word files to the repo under griddle/ or pass --common path/to/file.txt');
    process.exit(1);
  }
  try {
    dictWords = await loadWordFile(dictUrl);
    console.log(`  Dictionary:   ${dictWords.length.toLocaleString()}`);
  } catch (err) {
    console.error(`  Could not load dictionary words: ${err.message}`);
    process.exit(1);
  }

  // Load word history from existing output CSVs so we can exclude recently used words.
  if (!opts.noDedupe) {
    const historicalDates = loadHistoricalWords(OUTPUT_DIR);
    console.log(`\nWord history: ${historicalDates} date(s) loaded from ${OUTPUT_DIR}`);
  }

  const difficulties = ['Easy', 'Medium', 'Hard'];
  // Header includes new words and definitions columns
  const csvRows = ['puzzleDate,difficulty,solutionGrid,staticCells,words,definitions'];
  let generated = 0, failed = 0;

  for (const dateStr of datesToProcess) {
    process.stdout.write(`\n  ${dateStr}:\n`);

    // Build word pools for this date, excluding words used in the recent window.
    let activeCommon = commonWords;
    let activeDict   = dictWords;
    if (!opts.noDedupe) {
      const recentlyUsed = getRecentlyUsedWords(dateStr, RECENT_WORD_WINDOW_DAYS);
      if (recentlyUsed.size > 0) {
        activeCommon = commonWords.filter(w => !recentlyUsed.has(w));
        activeDict   = dictWords.filter(w => !recentlyUsed.has(w));
        console.log(`    Excluding ${recentlyUsed.size} words used in the last ${RECENT_WORD_WINDOW_DAYS} days (${activeCommon.length}/${commonWords.length} common words remain)`);
      }
    }

    const dateResults = [];

    for (const difficulty of difficulties) {
      const diffResults = [];

      for (let ci = 0; ci < CANDIDATES_PER_DIFFICULTY; ci++) {
        let found = null;
        let validationRetries = 0;

        for (let retry = 0; retry < MAX_VALIDATION_RETRIES && !found; retry++) {
          // Each retry gets its own unique seed so it produces different words.
          // Multiplying by MAX_VALIDATION_RETRIES keeps candidate seeds well-separated.
          const seed = dateSeed(dateStr, difficulty, ci * MAX_VALIDATION_RETRIES + retry);
          const rand = seededRand(seed);

          const words = generateWaffle(activeCommon, activeDict, rand);
          if (!words) continue; // grid generation failed, try next seed

          if (opts.skipValidation) {
            // No API validation — accept the grid as-is with empty definitions
            const solutionGrid = buildGrid(words);
            const staticCells  = generateStaticCells(difficulty, rand);
            found = { difficulty, success: true, words, solutionGrid, staticCells, definitions: [] };
            break;
          }

          // Validate all 6 words against the Free Dictionary API
          process.stdout.write(`    ${difficulty} (try ${retry + 1}): checking [${words.join(', ')}]... `);
          const validation = await validateAndFetchDefinitions(words);

          if (!validation.valid) {
            console.log(`REJECTED — invalid: ${validation.invalidWords.join(', ')}`);
            validationRetries++;
            continue;
          }

          console.log('OK');
          const solutionGrid = buildGrid(words);
          const staticCells  = generateStaticCells(difficulty, rand);
          found = {
            difficulty,
            success:     true,
            words,
            solutionGrid,
            staticCells,
            definitions: validation.definitions,
          };
        }

        if (found) {
          if (validationRetries > 0) {
            console.log(`    ${difficulty}: accepted after ${validationRetries} rejected grid(s)`);
          }
          if (!opts.noDedupe) registerGeneratedWords(dateStr, found.words);
          diffResults.push(found);
          generated++;
        } else {
          console.log(`    ${difficulty}: FAILED — could not find valid grid after ${MAX_VALIDATION_RETRIES} attempts`);
          diffResults.push({ difficulty, success: false });
          failed++;
        }
      }

      dateResults.push({ difficulty, results: diffResults });
    }

    // Add CSV rows for this date
    for (const { difficulty, results } of dateResults) {
      for (const result of results) {
        if (!result.success) continue;

        // If multiple candidates, append candidate number to distinguish them
        const diffLabel = CANDIDATES_PER_DIFFICULTY > 1
          ? `${difficulty}-${results.indexOf(result) + 1}`
          : difficulty;

        csvRows.push(buildCSVRow(
          dateStr,
          diffLabel,
          result.solutionGrid,
          result.staticCells,
          result.words,
          result.definitions,
        ));
      }
    }
  }

  console.log(`\nDone. Generated: ${generated}, Failed: ${failed}.`);

  if (generated === 0) {
    console.log('\nNo puzzles generated. Check that your word files loaded correctly.');
    return;
  }

  // Write CSV output
  const csvContent = csvRows.join('\n');

  if (opts.dryRun) {
    console.log('\n--- CSV Preview (first 5 data rows) ---');
    csvRows.slice(0, 6).forEach(r => console.log(r.substring(0, 120) + '...'));
    return;
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // One output file per run, named with the date range
  const firstDate = datesToProcess[0];
  const lastDate  = datesToProcess[datesToProcess.length - 1];
  const filename  = firstDate === lastDate
    ? `griddles-${firstDate}.csv`
    : `griddles-${firstDate}-to-${lastDate}.csv`;

  const outPath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(outPath, csvContent);
  console.log(`\nSaved: ${outPath}`);

  console.log('\nNext steps:');
  console.log('  1. Open the CSV file');
  console.log('  2. Review the generated grids (you can visualise solutionGrid using');
  console.log('     your existing Google Sheet helper columns)');
  console.log('  3. The `words` column lists all 6 words: [h1, h2, h3, v1, v2, v3]');
  console.log('  4. The `definitions` column contains [{word, pos, def}] for each word');
  console.log('     — use this to display definitions after the game ends');
  console.log('  5. Copy the rows you want into your Griddle puzzle sheet');
  console.log('  6. Run your Apps Script to verify/adjust staticCells as needed');
  console.log('\nNote: the staticCells are algorithmically generated but you can always');
  console.log('override them in the sheet using your visual helper columns.');
  console.log('\nNote: definitions are fetched from dictionaryapi.dev. If a word has a');
  console.log("missing or incomplete entry there, you may want to fill it in manually.");
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
