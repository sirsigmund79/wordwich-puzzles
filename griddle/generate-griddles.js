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
 *   3. Applies difficulty-appropriate staticCells patterns using the same
 *      logic as your Apps Script
 *   4. Writes one CSV row per puzzle (3 rows per date)
 *
 * THE GRID STRUCTURE (always the same):
 *   Rows 0, 2, 4 are horizontal words (H1, H2, H3)
 *   Cols 0, 2, 4 are vertical words   (V1, V2, V3)
 *   The four "hole" positions [1,1] [1,3] [3,1] [3,3] are always null
 *   All other cells are letter-bearing grid cells
 *
 * OUTPUT CSV COLUMNS:
 *   puzzleDate  | difficulty | solutionGrid | staticCells
 *
 *   puzzleDate  — M/D/YYYY format (matches what your game reads from the sheet)
 *   difficulty  — Easy / Medium / Hard
 *   solutionGrid — JSON string, 5x5 array, nulls at hole positions
 *   staticCells  — JSON string, 5x5 array of true/false/null
 *
 * HOW TO RUN:
 *   node generate-griddles.mjs                              # today, 3 puzzles
 *   node generate-griddles.mjs --date 2026-07-04            # specific date
 *   node generate-griddles.mjs --start 2026-07-01 --end 2026-07-31
 *   node generate-griddles.mjs --dry-run                    # print to console only
 *   node generate-griddles.mjs --count 5                    # generate 5 candidates
 *                                                            # per difficulty per date
 *                                                            # so you can pick the best
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

const OUTPUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'output');

// Word file URLs — same files your HTML tool uses
// These are fetched from your GitHub repo. If you add them to the repo
// under a griddle/ folder, update these URLs accordingly.
const COMMON_WORDS_URL = 'https://raw.githubusercontent.com/sirsigmund79/wordwich-puzzles/main/griddle/common_words.txt';
const DICT_WORDS_URL   = 'https://raw.githubusercontent.com/sirsigmund79/wordwich-puzzles/main/griddle/wordle_words.txt';

// How many generation attempts before giving up on a date/difficulty combo.
// The HTML tool uses 5000; we use the same.
const MAX_ATTEMPTS = 5000;

// How many candidate grids to generate per difficulty level per date.
// Default 1 gives you one grid per difficulty. Use --count 3 to get
// multiple options to choose from in the spreadsheet.
let CANDIDATES_PER_DIFFICULTY = 1;

// Difficulty settings — mirrors your Apps Script GRID_CONFIG exactly
const GRID_CONFIG = {
  Easy:   { minLocked: 11, maxLocked: 13, helperWeight: 0.8 },
  Medium: { minLocked:  9, maxLocked: 12, helperWeight: 0.4 },
  Hard:   { minLocked:  8, maxLocked: 10, helperWeight: 0.1 },
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

function buildCSVRow(dateStr, difficulty, solutionGrid, staticCells) {
  const sheetDate = toSheetDate(dateStr);
  const solJson   = gridToJsonStr(solutionGrid);
  const statJson  = gridToJsonStr(staticCells);

  return [
    escapeCSV(sheetDate),
    escapeCSV(difficulty),
    escapeCSV(solJson),
    escapeCSV(statJson),
  ].join(',');
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dates:    null,
    dryRun:   false,
    count:    1,
    commonFile: null,
    dictFile:   null,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i+1]) {
      opts.dates = [args[++i]];
    } else if (args[i] === '--start' && args[i+1]) {
      const start = args[++i];
      const end   = (args[i+1] && !args[i+1].startsWith('--')) ? args[++i] : todayStr();
      opts.dates  = dateRange(start, end);
    } else if (args[i] === '--dry-run') {
      opts.dryRun = true;
    } else if (args[i] === '--count' && args[i+1]) {
      opts.count = parseInt(args[++i]) || 1;
    } else if (args[i] === '--common' && args[i+1]) {
      opts.commonFile = args[++i];
    } else if (args[i] === '--dict' && args[i+1]) {
      opts.dictFile = args[++i];
    }
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
  if (opts.dryRun) console.log('DRY RUN: no files will be written.\n');

  // Load word files. Being lazy for now and just swapping the URLs so we default to Wordle
  const commonUrl = opts.dictFile ?? DICT_WORDS_URL;
  const dictUrl   = opts.commonFile   ?? COMMON_WORDS_URL;

  console.log('Loading word files...');
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

  const difficulties = ['Easy', 'Medium', 'Hard'];
  const csvRows = ['puzzleDate,difficulty,solutionGrid,staticCells']; // header
  let generated = 0, failed = 0;

  for (const dateStr of datesToProcess) {
    process.stdout.write(`  ${dateStr}: `);
    const dateResults = [];

    for (const difficulty of difficulties) {
      const diffResults = [];

      for (let ci = 0; ci < CANDIDATES_PER_DIFFICULTY; ci++) {
        const seed = dateSeed(dateStr, difficulty, ci);
        const rand = seededRand(seed);

        // Generate solution grid
        const words = generateWaffle(commonWords, dictWords, rand);

        if (!words) {
          diffResults.push({ difficulty, success: false });
          failed++;
          continue;
        }

        const solutionGrid = buildGrid(words);
        const staticCells  = generateStaticCells(difficulty, rand);

        diffResults.push({
          difficulty,
          success:      true,
          solutionGrid,
          staticCells,
          words,         // kept for console display
        });
        generated++;
      }

      dateResults.push({ difficulty, results: diffResults });
    }

    // Log result summary for this date
    const summary = dateResults.map(dr => {
      const successes = dr.results.filter(r => r.success);
      if (successes.length === 0) return `${dr.difficulty}:FAILED`;
      // Show first candidate's words as a preview
      const words = successes[0].words;
      return `${dr.difficulty}:[${words.slice(0,3).join(',')}...]`;
    }).join('  ');
    console.log(summary);

    // Add CSV rows
    for (const { difficulty, results } of dateResults) {
      for (const result of results) {
        if (!result.success) continue;

        // If multiple candidates, append candidate number to distinguish them
        const diffLabel = CANDIDATES_PER_DIFFICULTY > 1
          ? `${difficulty}-${results.indexOf(result) + 1}`
          : difficulty;

        csvRows.push(buildCSVRow(dateStr, diffLabel, result.solutionGrid, result.staticCells));
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
  console.log('  3. Copy the rows you want into your Griddle puzzle sheet');
  console.log('  4. Run your Apps Script to verify/adjust staticCells as needed');
  console.log('\nNote: the staticCells are algorithmically generated but you can always');
  console.log('override them in the sheet using your visual helper columns.');
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
