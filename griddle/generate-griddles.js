/**
 * generate-griddles.js
 *
 * Generates Griddle puzzles and adds them straight to griddle/puzzles.json,
 * the file the game reads. Push the result and the puzzles are live on their
 * dates; there is no sheet to paste into any more.
 *
 * WHAT THIS SCRIPT DOES:
 *   For each date in the requested range it:
 *   1. Builds a word pool per difficulty from the word lists, using each
 *      word's Zipf frequency (word_zipf.txt, the same wordfreq numbers Letter
 *      Loaf uses for rare words) to keep uncommon words out of easier rounds
 *   2. Generates an Easy, a Medium and a Hard 5x5 grid from those pools
 *   3. Validates all 6 words in each grid against the Free Dictionary API —
 *      grids with any invalid/proper-noun words are retried automatically
 *   4. Applies difficulty-appropriate staticCells patterns
 *   5. Adds the day to puzzles.json with the next griddleNumber and puzzle ids
 *
 * DIFFICULTY:
 *   Difficulty comes from two things: how many cells start filled in, and how
 *   common the words are. Every one of the six words in a grid must have a
 *   Zipf frequency of at least `minZipf` for its difficulty (see GRID_CONFIG).
 *   Zipf is log-frequency: ~7.7 is "the", ~5 is "water", ~4 is "chaos",
 *   ~3 is "aorta", under ~2.5 most people won't know the word.
 *   Before this, a single obscure word (often a dictionary fallback forced by
 *   the crossing letters) could land in any round, Easy included.
 *
 * THE GRID STRUCTURE (always the same):
 *   Rows 0, 2, 4 are horizontal words (H1, H2, H3)
 *   Cols 0, 2, 4 are vertical words   (V1, V2, V3)
 *   The four "hole" positions [1,1] [1,3] [3,1] [3,3] are always null
 *
 * HOW TO RUN:
 *   node generate-griddles.js --days 30                    # the 30 days after the last one in puzzles.json
 *   node generate-griddles.js --date 2026-12-04            # one date
 *   node generate-griddles.js --start 2026-12-01 --end 2026-12-31
 *   node generate-griddles.js --days 7 --dry-run           # print only, puzzles.json untouched
 *   node generate-griddles.js --date 2026-12-04 --replace  # regenerate a day that isn't live yet
 *   node generate-griddles.js --skip-validation            # skip dictionary API checks (no definitions)
 *   node generate-griddles.js --no-dedupe                  # skip recent-word exclusion
 *
 *   Dates already in puzzles.json are skipped unless --replace is given, which
 *   keeps that day's griddleNumber and ids. New dates must come after the last
 *   day in the file so griddle numbers stay in order.
 *
 * WORD DEDUPLICATION:
 *   Any word used within 40 days of a date (read from puzzles.json, and from
 *   earlier dates in the same run) is excluded, as is any word already used by
 *   another difficulty on the same date, and anything in blocked_words.txt.
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { LEVELS, loadPuzzleFile, savePuzzleFile, lastNumbers } from './puzzles-json.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SCRIPT_DIR   = path.dirname(fileURLToPath(import.meta.url));
const PUZZLES_FILE = path.join(SCRIPT_DIR, 'puzzles.json');

// Primary pool: Wordle answer words — recognizable, preferred for grid slots.
const COMMON_WORDS_DEFAULT = path.join(SCRIPT_DIR, 'wordle_words.txt');
// Fallback pool: all 5-letter words from the Letterloaf dictionary (~8,939 words).
const DICT_WORDS_DEFAULT   = path.join(SCRIPT_DIR, 'griddle_dict.txt');
// WORD<TAB>ZIPF for every 5-letter word, copied from wordwich-game's
// public/wordbank.txt (the Letter Loaf rarity data). A word missing from it
// counts as Zipf 0, i.e. as rare as it gets.
const ZIPF_DEFAULT         = path.join(SCRIPT_DIR, 'word_zipf.txt');
// Words never to use, whatever their frequency (crude, bodily, slurs...).
const BLOCKED_DEFAULT      = path.join(SCRIPT_DIR, 'blocked_words.txt');

// Free Dictionary API base URL used to validate words and fetch definitions.
// Was api.dictionaryapi.dev — switched 2026-09-27 after that host started
// hanging/timing out (Cloudflare 522) on every lookup, word or not.
const FREE_DICT_API = 'https://freedictionaryapi.com/api/v1/entries/en';

// How many generation attempts before giving up on one seed.
const MAX_ATTEMPTS = 5000;

// How many times to try a new generated grid when words fail dictionary
// validation. Each retry uses a different seed so it produces different words.
const MAX_VALIDATION_RETRIES = 50;

// Words used in puzzles within this many days of the target date are excluded.
const RECENT_WORD_WINDOW_DAYS = 40;

// Per difficulty:
//   minLocked/maxLocked/helperWeight — how many cells start filled in, and how
//     strongly those lean to the corners and centre (easiest anchors)
//   minZipf — every word in the grid must be at least this common
//
// The Easy floor (3.5) leaves ~1,800 dictionary words, plenty to fill grids
// even with 40 days of words excluded. Hard has no floor, as before.
const GRID_CONFIG = {
  Easy:   { minLocked: 11, maxLocked: 14, helperWeight: 0.8, minZipf: 3.5 },
  Medium: { minLocked: 11, maxLocked: 12, helperWeight: 0.4, minZipf: 2.5 },
  Hard:   { minLocked:  9, maxLocked: 10, helperWeight: 0.1, minZipf: 0   },
};

// The four "hole" positions — always the same in every Griddle puzzle.
const HOLES = [[1,1],[1,3],[3,1],[3,3]];

// "Helper" corners and centre, biased toward on Easy puzzles.
const HELPER_COORDS = [[0,0],[0,4],[4,0],[4,4],[2,2]];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dateRange(startStr, endStr) {
  const dates = [];
  for (let cur = startStr; cur <= endStr; cur = addDays(cur, 1)) dates.push(cur);
  return dates;
}

// Seeded random for reproducible output — same puzzle every time for same date
function seededRand(seed) {
  let s = seed;
  return function() {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function dateSeed(dateStr, difficulty, retry) {
  const base = parseInt(dateStr.replace(/-/g, ''), 10);
  const diffOffset = { Easy: 0, Medium: 777777, Hard: 1555555 }[difficulty] ?? 0;
  return base + diffOffset + retry * 99991;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Recently-used word deduplication
// ---------------------------------------------------------------------------

// Map<YYYY-MM-DD, Set<UPPERCASE_WORD>>, from puzzles.json plus this run.
const dateWordMap = new Map();

function registerWords(dateStr, words) {
  if (!dateWordMap.has(dateStr)) dateWordMap.set(dateStr, new Set());
  const set = dateWordMap.get(dateStr);
  for (const w of words) set.add(w.toUpperCase());
}

// Words used on the target date itself or within windowDays either side of
// it. Looking forward only matters with --replace, where later days exist.
function getRecentlyUsedWords(targetDateStr, windowDays) {
  const used = new Set();
  for (let i = -windowDays; i <= windowDays; i++) {
    const words = dateWordMap.get(addDays(targetDateStr, i));
    if (words) for (const w of words) used.add(w);
  }
  return used;
}

// ---------------------------------------------------------------------------
// Zipf frequencies
// ---------------------------------------------------------------------------

function loadZipf(file) {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const zipf = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const [word, value] = line.trim().split('\t');
    if (word) zipf.set(word.toUpperCase(), Number(value) || 0);
  }
  return zipf;
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

// The Free Dictionary API rate-limits aggressively when many requests land at
// once (validateAndFetchDefinitions fires 6 lookups in parallel per grid
// candidate). This queue serializes all outgoing requests with a minimum gap
// between them so we stay under the limit instead of tripping it.
const API_MIN_INTERVAL_MS = 300;
let apiQueue = Promise.resolve();

function throttledFetch(url) {
  const run = apiQueue.then(() => fetch(url));
  // Always advance the queue, even if this request rejects, so one failure
  // doesn't stall every request queued behind it.
  apiQueue = run.then(() => sleep(API_MIN_INTERVAL_MS), () => sleep(API_MIN_INTERVAL_MS));
  return run;
}

const MAX_LOOKUP_ATTEMPTS = 6;

async function lookupWord(word) {
  const key = word.toLowerCase();
  if (defCache.has(key)) return defCache.get(key);

  let result;
  for (let attempt = 0; attempt < MAX_LOOKUP_ATTEMPTS; attempt++) {
    const lastAttempt = attempt === MAX_LOOKUP_ATTEMPTS - 1;
    try {
      const res = await throttledFetch(`${FREE_DICT_API}/${key}`);

      if (res.status === 429) {
        // Rate limited — this is not "word doesn't exist", so back off and
        // retry rather than marking it invalid. Honor Retry-After if given.
        const retryAfterSec = parseFloat(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfterSec)
          ? retryAfterSec * 1000
          : 1000 * Math.pow(2, attempt); // 1s, 2s, 4s, 8s, 16s...
        if (!lastAttempt) {
          console.warn(`    Rate limited (429) on "${word}", waiting ${Math.round(waitMs)}ms (attempt ${attempt + 1}/${MAX_LOOKUP_ATTEMPTS})`);
          await sleep(waitMs);
          continue;
        }
        console.warn(`    Warning: still rate-limited after ${MAX_LOOKUP_ATTEMPTS} attempts for "${word}" — not caching, will retry if looked up again`);
        return { valid: false }; // don't cache — this isn't a real "invalid word" verdict
      }

      if (res.status >= 500) {
        // 5xx means the upstream server failed or is shedding load. This API
        // rate-limits without always saying so — under load it returns a mix of
        // 429, 500 and 502 for words it serves fine when idle. Treat it exactly
        // like 429: back off hard and never cache the failure, or real words get
        // permanently marked invalid for the rest of the run.
        const waitMs = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s, 8s, 16s...
        if (!lastAttempt) {
          console.warn(`    Server error (${res.status}) on "${word}", waiting ${Math.round(waitMs)}ms (attempt ${attempt + 1}/${MAX_LOOKUP_ATTEMPTS})`);
          await sleep(waitMs);
          continue;
        }
        console.warn(`    Warning: still failing (${res.status}) after ${MAX_LOOKUP_ATTEMPTS} attempts for "${word}" — not caching, will retry if looked up again`);
        return { valid: false }; // don't cache — this isn't a real "invalid word" verdict
      }

      if (!res.ok) {
        // Genuine client error (4xx other than 429) — wait and retry, then give up.
        if (!lastAttempt) { await sleep(500 * (attempt + 1)); continue; }
        console.warn(`    Warning: API returned ${res.status} for "${word}", treating as invalid`);
        result = { valid: false };
        break;
      }

      const data = await res.json();

      // The API returns {word, entries:[...]} for known words, or
      // {word, entries:[]} for unknown words — both as HTTP 200, so we must
      // inspect the body rather than trust the status code.
      if (!data || !Array.isArray(data.entries) || data.entries.length === 0) {
        result = { valid: false };
        break;
      }

      const firstEntry = data.entries[0];
      const pos = firstEntry?.partOfSpeech ?? '';
      const def = firstEntry?.senses?.[0]?.definition ?? '';
      result = { valid: true, pos, def };
      break;

    } catch (err) {
      if (!lastAttempt) { await sleep(500 * (attempt + 1)); continue; }
      console.warn(`    Warning: network error looking up "${word}" after ${MAX_LOOKUP_ATTEMPTS} attempts: ${err.message}`);
      return { valid: false }; // transient like 5xx — don't cache the failure
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
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dates:          null,
    days:           null,
    dryRun:         false,
    replace:        false,
    commonFile:     null,
    dictFile:       null,
    zipfFile:       null,
    skipValidation: false,
    noDedupe:       false,
  };

  let startDate = null;
  let endDate   = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if      (a === '--date'  && args[i+1]) opts.dates = [args[++i]];
    else if (a === '--start' && args[i+1]) startDate = args[++i];
    else if (a === '--end'   && args[i+1]) endDate = args[++i];
    else if (a === '--days'  && args[i+1]) opts.days = parseInt(args[++i], 10) || null;
    else if (a === '--dry-run')            opts.dryRun = true;
    else if (a === '--replace')            opts.replace = true;
    else if (a === '--common' && args[i+1]) opts.commonFile = args[++i];
    else if (a === '--dict'   && args[i+1]) opts.dictFile = args[++i];
    else if (a === '--zipf'   && args[i+1]) opts.zipfFile = args[++i];
    else if (a === '--skip-validation')    opts.skipValidation = true;
    else if (a === '--no-dedupe')          opts.noDedupe = true;
    else if (a === '--count') {
      console.error('--count is gone: puzzles now go straight into puzzles.json, one per difficulty.');
      console.error('Use --dry-run to look first, or --replace to regenerate a day.');
      process.exit(1);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }

  if (startDate && !opts.dates) {
    opts.dates = dateRange(startDate, endDate ?? startDate);
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function generatePuzzle(dateStr, difficulty, pools, opts) {
  for (let retry = 0; retry < MAX_VALIDATION_RETRIES; retry++) {
    const rand = seededRand(dateSeed(dateStr, difficulty, retry));

    const words = generateWaffle(pools.common, pools.dict, rand);
    if (!words) continue;

    let definitions = [];
    if (!opts.skipValidation) {
      process.stdout.write(`    ${difficulty} (try ${retry + 1}): checking [${words.join(', ')}]... `);
      const validation = await validateAndFetchDefinitions(words);
      if (!validation.valid) {
        console.log(`REJECTED — invalid: ${validation.invalidWords.join(', ')}`);
        continue;
      }
      console.log('OK');
      definitions = validation.definitions;
    }

    return {
      words,
      solutionGrid: buildGrid(words),
      staticCells:  generateStaticCells(difficulty, rand),
      definitions,
    };
  }
  return null;
}

async function main() {
  console.log('=== Griddle Puzzle Generator ===\n');

  const opts = parseArgs();
  const data = loadPuzzleFile(PUZZLES_FILE);
  const existingDates = Object.keys(data.days).sort();
  const lastExisting  = existingDates.at(-1);

  let datesToProcess = opts.dates;
  if (!datesToProcess) {
    const start = lastExisting ? addDays(lastExisting, 1) : todayStr();
    datesToProcess = dateRange(start, addDays(start, (opts.days ?? 1) - 1));
  }

  // Existing days are left alone unless --replace; new days have to follow the
  // last one so griddle numbers keep counting up with the calendar.
  datesToProcess = datesToProcess.filter(d => {
    if (data.days[d] && !opts.replace) { console.log(`Skipping ${d}: already in puzzles.json (use --replace to regenerate)`); return false; }
    return true;
  });
  const misplaced = datesToProcess.filter(d => !data.days[d] && lastExisting && d < lastExisting);
  if (misplaced.length) {
    console.error(`\nCan't add ${misplaced.join(', ')}: puzzles.json already runs to ${lastExisting}, and griddle numbers follow the calendar.`);
    process.exit(1);
  }
  const live = datesToProcess.filter(d => data.days[d] && d <= addDays(todayStr(), 1));
  if (live.length) console.warn(`\nWarning: replacing ${live.join(', ')}, which may already be live. Players' saved progress for those days will reset.`);

  if (datesToProcess.length === 0) { console.log('\nNothing to generate.'); return; }

  console.log(`Dates: ${datesToProcess[0]} to ${datesToProcess.at(-1)} (${datesToProcess.length})`);
  console.log(opts.skipValidation ? 'Dictionary validation: SKIPPED' : `Dictionary validation: ON (up to ${MAX_VALIDATION_RETRIES} grids per puzzle)`);
  console.log(opts.noDedupe ? 'Word deduplication:   SKIPPED' : `Word deduplication:   ON (${RECENT_WORD_WINDOW_DAYS}-day window + same day)`);
  console.log(`Word commonness:      ${LEVELS.map(l => `${l} Zipf >= ${GRID_CONFIG[l].minZipf}`).join(', ')}`);
  if (opts.dryRun) console.log('DRY RUN: puzzles.json will not be changed.');

  console.log('\nLoading word files...');
  let commonWords, dictWords, zipf;
  try {
    commonWords = await loadWordFile(opts.commonFile ?? COMMON_WORDS_DEFAULT);
    dictWords   = await loadWordFile(opts.dictFile   ?? DICT_WORDS_DEFAULT);
    zipf        = loadZipf(opts.zipfFile ?? ZIPF_DEFAULT);
    if (fs.existsSync(BLOCKED_DEFAULT)) {
      const blocked = new Set(fs.readFileSync(BLOCKED_DEFAULT, 'utf8').split('\n')
        .map(l => l.replace(/#.*/, '').trim().toUpperCase()).filter(Boolean));
      commonWords = commonWords.filter(w => !blocked.has(w));
      dictWords   = dictWords.filter(w => !blocked.has(w));
      console.log(`  Blocked:      ${blocked.size} words (blocked_words.txt)`);
    }
  } catch (err) {
    console.error(`  Could not load word files: ${err.message}`);
    process.exit(1);
  }
  const zipfOf = w => zipf.get(w) ?? 0;
  console.log(`  Common words: ${commonWords.length.toLocaleString()}`);
  console.log(`  Dictionary:   ${dictWords.length.toLocaleString()}`);
  console.log(`  Zipf entries: ${zipf.size.toLocaleString()}`);

  // Each difficulty draws only from words at or above its Zipf floor, in both
  // the preferred pool and the fallback, so the crossing letters can't force an
  // obscure word into an easier round.
  const basePools = Object.fromEntries(LEVELS.map(level => {
    const min = GRID_CONFIG[level].minZipf;
    const pool = {
      common: commonWords.filter(w => zipfOf(w) >= min),
      dict:   dictWords.filter(w => zipfOf(w) >= min),
    };
    console.log(`  ${level.padEnd(6)} pool: ${pool.common.length} common + ${pool.dict.length} dictionary words`);
    return [level, pool];
  }));

  if (!opts.noDedupe) {
    for (const [date, day] of Object.entries(data.days)) {
      if (opts.replace && datesToProcess.includes(date)) continue; // its old words are going away
      for (const p of day.puzzles) registerWords(date, p.words ?? []);
    }
    console.log(`\nWord history: ${dateWordMap.size} day(s) loaded from puzzles.json`);
  }

  let { id: nextId, griddleNumber: nextNumber } = lastNumbers(data);
  let generated = 0, failed = 0;
  const newDays = {};

  for (const dateStr of datesToProcess) {
    console.log(`\n  ${dateStr}:`);
    const previous = data.days[dateStr];
    const puzzles = [];

    for (const [i, difficulty] of LEVELS.entries()) {
      let pools = basePools[difficulty];
      if (!opts.noDedupe) {
        const used = getRecentlyUsedWords(dateStr, RECENT_WORD_WINDOW_DAYS);
        pools = { common: pools.common.filter(w => !used.has(w)), dict: pools.dict.filter(w => !used.has(w)) };
      }

      const found = await generatePuzzle(dateStr, difficulty, pools, opts);
      if (!found) {
        console.log(`    ${difficulty}: FAILED — no valid grid after ${MAX_VALIDATION_RETRIES} attempts (pool: ${pools.common.length} + ${pools.dict.length})`);
        failed++;
        continue;
      }

      const zipfs = found.words.map(zipfOf);
      console.log(`    ${difficulty}: ${found.words.join(' ')}  (rarest Zipf ${Math.min(...zipfs).toFixed(1)})`);
      if (!opts.noDedupe) registerWords(dateStr, found.words);
      generated++;

      puzzles.push({
        id: previous?.puzzles[i]?.id ?? ++nextId,
        difficulty,
        solutionGrid: found.solutionGrid,
        staticCells:  found.staticCells,
        words:        found.words,
        definitions:  found.definitions,
      });
    }

    if (puzzles.length !== LEVELS.length) {
      // Stopping here rather than skipping keeps the calendar free of holes,
      // which later runs couldn't fill (griddle numbers follow the dates).
      console.log(`    Stopping at ${dateStr}: not all three difficulties could be generated.`);
      break;
    }
    newDays[dateStr] = { griddleNumber: previous?.griddleNumber ?? ++nextNumber, puzzles };
  }

  console.log(`\nDone. Generated: ${generated}, Failed: ${failed}.`);
  const added = Object.keys(newDays);
  if (added.length === 0) return;

  if (opts.dryRun) {
    console.log(`Dry run: would write ${added.length} day(s) to puzzles.json.`);
    return;
  }

  Object.assign(data.days, newDays);
  savePuzzleFile(PUZZLES_FILE, data);
  console.log(`\nSaved ${added.length} day(s) to ${PUZZLES_FILE}`);
  console.log('Review the diff, then commit and push — the site picks it up within a few minutes.');
  if (!opts.skipValidation) {
    console.log('Definitions come from freedictionaryapi.com; fix any thin ones directly in puzzles.json.');
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
