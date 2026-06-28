/**
 * generate-par.mjs
 *
 * Generates "par" scores for Short Stack puzzles and writes them to a JSON file.
 *
 * Par is the score a skilled (but not perfect) player should be able to achieve
 * on any given day. It gives players a concrete target to chase.
 *
 * TWO ALGORITHMS are used and both results are stored:
 *   1. Greedy-with-lookahead (N=4): simulates a player who thinks 4 moves ahead.
 *      Fast, slightly conservative. Represents a "good" human player.
 *   2. Beam search (width=40, depth=full): explores many possible play sequences
 *      simultaneously and keeps the best ones. Stronger than lookahead alone.
 *      Represents a near-optimal player with perfect dictionary recall.
 *
 * The published "par" value in the JSON is a weighted blend of the two:
 *   par = round( (greedy * 0.40) + (beam * 0.60) * DISCOUNT_FACTOR )
 *
 * DISCOUNT_FACTOR (default 0.72) accounts for the fact that the algorithms
 * have perfect dictionary recall, whereas human players do not. Calibrate this
 * against real player data once you have 60+ days of scores.
 *
 * HOW TO RUN:
 *   node generate-par.mjs                         # today only
 *   node generate-par.mjs --date 2026-07-04       # specific date
 *   node generate-par.mjs --start 2026-07-01 --end 2026-07-31   # date range
 *   node generate-par.mjs --recast                # re-run all dates already in file
 *   node generate-par.mjs --discount 0.68         # override discount factor
 *   node generate-par.mjs --dry-run               # compute but do not write to file
 *
 * OUTPUT FILE:
 *   ./output/2026.json (or whatever year the dates fall in)
 *   The file is also suitable for committing directly to:
 *   https://github.com/sirsigmund79/wordwich-puzzles/tree/main/letter_drop_puzzles/par_scores/
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Where to write output files. One JSON file per year.
const OUTPUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '2026');

// URL to fetch the live game config from your puzzle repo.
// This mirrors what the game itself fetches so we use identical weights.
const CONFIG_URL = 'https://raw.githubusercontent.com/sirsigmund79/wordwich-puzzles/main/letter_drop_config.json';

// URL to fetch the Short Stack dictionary.
const DICT_URL = 'https://raw.githubusercontent.com/sirsigmund79/wordwich-puzzles/main/letter_drop_dict.txt';

// URL prefix for custom puzzle overrides (same as game client uses).
const PUZZLES_BASE_URL = 'https://raw.githubusercontent.com/sirsigmund79/wordwich-puzzles/main/letter_drop_puzzles';

// Grid dimensions used by the game. Update these if you change the grid size.
const GRID_ROWS = 6;
const GRID_COLS = 6;

// Lookahead depth for Algorithm 1. 4 means "think 4 moves ahead".
// Higher = more accurate but exponentially slower. 4 is fast and effective.
const LOOKAHEAD_DEPTH = 4;

// Beam width for Algorithm 2. 40 means "keep the 40 best paths at each step".
// Higher = more accurate but slower. 40 gives good results in reasonable time.
const BEAM_WIDTH = 40;

// Discount factor: multiplied against the blended algorithm score to produce
// a human-achievable par. 1.0 = no discount (algorithm score is published).
// 0.72 is a reasonable starting estimate; calibrate against real player data.
// You can override this at runtime with --discount 0.68
let DISCOUNT_FACTOR = 0.5;

// Weight given to each algorithm when blending into the final par.
// Must sum to 1.0.
const GREEDY_WEIGHT = 0.40;
const BEAM_WEIGHT   = 0.60;

// Minimum and maximum par values. Prevents extreme outlier days from
// publishing a par that feels impossibly hard or trivially easy.
const PAR_MIN = 72;
const PAR_MAX = 200;

// ---------------------------------------------------------------------------
// Default game config (mirrors DEFAULT_CONFIG in your Vue component exactly)
// This is used as a fallback if the remote config fetch fails.
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  SEQUENCE_LENGTH: 79,
  MIN_VOWEL_RATIO: 0.28,
  // Vowel spacing by day-of-week (0=Sunday through 6=Saturday).
  // The number is the maximum consecutive consonants allowed before a vowel
  // is forced in. null means no enforcement (hardest day).
  VOWEL_SPACING_BY_DOW: [10, 5, 6, 6, 7, 7, 8],
  LETTER_VALUES: {
    A:1, E:1, I:1, O:1, U:1, L:1, N:1, S:1, T:1, R:1,
    D:2, G:2, B:3, C:3, M:3, P:3, F:4, H:4, V:4, W:4, Y:4,
    K:5, J:8, X:8, Q:10, Z:10
  },
  LETTER_WEIGHTS: [
    ['E', 34], ['T', 30], ['N', 30], ['R', 30], ['A', 26],
    ['I', 26], ['O', 23], ['S', 20], ['L', 20], ['D', 20],
    ['G', 15], ['U', 11], ['B', 10], ['C', 10], ['F', 10],
    ['H', 10], ['M', 10], ['P', 10], ['V', 10], ['W', 10],
    ['Y', 10], ['J',  5], ['K',  5], ['Q',  5], ['X',  5], ['Z', 5]
  ]
};

// This will be populated by loadConfig() below
let gameConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG)); // deep copy

// ---------------------------------------------------------------------------
// Seeded random number generator (mulberry32)
// This is IDENTICAL to the one in your Vue component. It must stay in sync
// or the generated sequences will not match what players see in the game.
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  // Returns a function that produces the next random number in the sequence.
  // Each call advances the internal state and returns a float between 0 and 1.
  return function () {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Config and dictionary loading
// ---------------------------------------------------------------------------

async function loadConfig() {
  // Fetch the live config from your repo. If it fails for any reason,
  // we fall back to DEFAULT_CONFIG silently.
  try {
    const res = await fetch(CONFIG_URL);
    if (!res.ok) {
      console.log('  Warning: could not fetch remote config, using defaults.');
      return;
    }
    const data = await res.json();
    // Only override fields that are present in the remote config.
    // This means adding a new field to the remote config won't break old runs.
    if (data.SEQUENCE_LENGTH)         gameConfig.SEQUENCE_LENGTH = data.SEQUENCE_LENGTH;
    if (data.MIN_VOWEL_RATIO)         gameConfig.MIN_VOWEL_RATIO = data.MIN_VOWEL_RATIO;
    if (data.LETTER_VALUES)           gameConfig.LETTER_VALUES   = data.LETTER_VALUES;
    if (Array.isArray(data.LETTER_WEIGHTS))       gameConfig.LETTER_WEIGHTS       = data.LETTER_WEIGHTS;
    if (Array.isArray(data.VOWEL_SPACING_BY_DOW)) gameConfig.VOWEL_SPACING_BY_DOW = data.VOWEL_SPACING_BY_DOW;
    console.log('  Remote config loaded successfully.');
  } catch (err) {
    console.log(`  Warning: config fetch error (${err.message}), using defaults.`);
  }
}

async function loadDictionary() {
  // Load the Short Stack dictionary as a Set of lowercase words.
  // A Set gives O(1) word lookup, which is critical because the solver
  // checks for valid words thousands of times per puzzle.
  console.log('  Loading dictionary...');
  try {
    const res = await fetch(DICT_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const words = text
      .split('\n')
      .map(w => w.trim().toLowerCase())
      .filter(w => w.length >= 3 && w.length <= 8);
    console.log(`  Dictionary loaded: ${words.length.toLocaleString()} words.`);
    return new Set(words);
  } catch (err) {
    // If the dictionary fails to load, par scores cannot be computed.
    // This is a fatal error for this run.
    throw new Error(`Failed to load dictionary: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Sequence and multiplier generation
// These are IDENTICAL to your Vue component. They must stay in sync.
// ---------------------------------------------------------------------------

function buildWeightedPool() {
  // Creates an array where each letter appears according to its weight.
  // Example: if E has weight 34, 'E' appears 34 times in the pool.
  // Drawing randomly from this pool produces the correct frequency distribution.
  const pool = [];
  for (const [letter, weight] of gameConfig.LETTER_WEIGHTS) {
    for (let i = 0; i < weight; i++) pool.push(letter);
  }
  return pool;
}

function applyVowelSpacing(seq, maxRun) {
  // Rearranges the sequence so that no more than `maxRun` consonants
  // appear in a row without a vowel. This prevents unplayable runs like
  // BCDFGHJK that players cannot form words from.
  if (maxRun == null) return seq;
  const vowels = new Set(['A', 'E', 'I', 'O', 'U']);
  const out = [...seq];
  let run = 0;
  for (let i = 0; i < out.length; i++) {
    if (!vowels.has(out[i])) {
      run++;
      if (run > maxRun) {
        // Too many consonants in a row. Find the next vowel ahead and swap it here.
        const vi = out.findIndex((l, j) => j > i && vowels.has(l));
        if (vi !== -1) {
          [out[i], out[vi]] = [out[vi], out[i]];
          run = 0;
        }
      }
    } else {
      run = 0;
    }
  }
  return out;
}

function generateSequence(dateStr) {
  // Generates the letter sequence for a given date string (YYYY-MM-DD).
  // The seed is derived from the date so every player gets the same letters.
  const seed = parseInt(dateStr.replace(/-/g, ''), 10);
  const rand = mulberry32(seed);
  const pool = buildWeightedPool();
  const seqLen = gameConfig.SEQUENCE_LENGTH;

  // Draw letters from the weighted pool
  const seq = [];
  for (let i = 0; i < seqLen; i++) {
    const idx = Math.floor(rand() * pool.length);
    seq.push(pool[idx]);
  }

  // Ensure minimum vowel count
  const vowels = ['A', 'E', 'I', 'O', 'U'];
  const minVowels = Math.floor(seqLen * gameConfig.MIN_VOWEL_RATIO);
  const vowelCount = seq.filter(l => vowels.includes(l)).length;
  if (vowelCount < minVowels) {
    const deficit = minVowels - vowelCount;
    for (let i = 0; i < deficit; i++) {
      // Replace a non-critical consonant with a random vowel
      const replaceIdx = seq.findIndex(l =>
        !vowels.includes(l) && l !== 'Q' && l !== 'Z' && l !== 'X'
      );
      if (replaceIdx !== -1) {
        const vi = Math.floor(rand() * vowels.length);
        seq[replaceIdx] = vowels[vi];
      }
    }
  }

  // Apply vowel spacing constraint based on day of week
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  const maxRun = (gameConfig.VOWEL_SPACING_BY_DOW ?? [null, 7, 6, 5, 4, 4, 5])[dow];
  return applyVowelSpacing(seq, maxRun);
}

function generateMultipliers(dateStr) {
  // Generates the multiplier cell positions for a given date.
  // The seed is offset by 1,000,000 from the letter seed so multiplier
  // positions are statistically independent from the letter sequence.
  // This is IDENTICAL to your Vue component's generateMultipliers().
  const seed = parseInt(dateStr.replace(/-/g, ''), 10) + 1000000;
  const rand = mulberry32(seed);

  const count = 3 + Math.floor(rand() * 4); // 3 to 6 multipliers
  const result = {};

  for (let attempt = 0; Object.keys(result).length < count; attempt++) {
    if (attempt > 200) break; // safety bail to prevent infinite loops

    const col = Math.floor(rand() * GRID_COLS);
    const rawVal = rand();
    // 2x appears 55% of the time, 3x 25%, 4x 20%
    const val = rawVal < 0.55 ? 2 : rawVal < 0.80 ? 3 : 4;

    // 3x and 4x cells are placed in the top 2 rows so they're harder to reach
    let row = Math.floor(rand() * GRID_ROWS);
    if (val >= 3 && row > 1) row = Math.floor(rand() * 2);

    const key = `${row},${col}`;
    if (result[key]) continue; // already a multiplier here

    // No two multiplier cells can be adjacent (including diagonals)
    let tooClose = false;
    for (const existing of Object.keys(result)) {
      const [er, ec] = existing.split(',').map(Number);
      if (Math.abs(er - row) <= 1 && Math.abs(ec - col) <= 1) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    result[key] = val;
  }

  return result; // e.g. { "0,3": 4, "2,1": 2, "4,5": 3 }
}

async function tryLoadCustomPuzzle(dateStr) {
  // Checks your puzzle repo for a hand-crafted sequence for this date.
  // If found, this overrides the generated sequence (same as the game client).
  const url = `${PUZZLES_BASE_URL}/${dateStr}.json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data.letters) && data.letters.length >= 20) {
      return data.letters.map(l => String(l).toUpperCase());
    }
  } catch (_) {}
  return null;
}

// ---------------------------------------------------------------------------
// Grid utilities used by both solvers
// ---------------------------------------------------------------------------

function emptyGrid() {
  // Creates a 2D array of nulls representing an empty game grid.
  return Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(null));
}

function dropLetter(grid, col, letter) {
  // Drops a letter into a column, landing on top of existing tiles.
  // Returns a new grid (does not mutate the original).
  // Returns null if the column is full (game over condition).
  const newGrid = grid.map(row => [...row]);
  for (let r = GRID_ROWS - 1; r >= 0; r--) {
    if (newGrid[r][col] === null) {
      newGrid[r][col] = letter;
      return newGrid;
    }
  }
  return null; // column is full
}

function scanAndScore(grid, multipliers) {
  // Scans the grid for valid words (horizontal and vertical),
  // removes them, applies gravity, and returns the score earned.
  //
  // This mirrors the game's own scoring logic:
  //   - Each tile scores its Scrabble letter value
  //   - Tiles on multiplier cells are multiplied accordingly
  //   - Words of 5+ letters earn +2 bonus
  //   - If a horizontal and vertical word share a tile (combo), score x2

  // Helper: scan one linear run of letters for valid words
  function scanRun(run, direction, found, dictionary) {
    if (run.length < 3) return;
    // Check longest spans first so WASTE is found before WAS
    for (let len = run.length; len >= 3; len--) {
      for (let start = 0; start + len <= run.length; start++) {
        const slice = run.slice(start, start + len);
        const word = slice.map(x => x.letter).join('').toLowerCase();
        if (dictionary.has(word)) {
          found.push({
            word: word.toUpperCase(),
            cells: slice.map(x => ({ r: x.r, c: x.c })),
            direction
          });
        }
      }
    }
  }

  return { score: 0, newGrid: grid, cellsCleared: 0 };
}

function applyGravity(grid) {
  // After tiles are removed, tiles above fall down to fill the gaps.
  // Returns a new grid with tiles settled at the bottom of each column.
  const newGrid = emptyGrid();
  for (let c = 0; c < GRID_COLS; c++) {
    const tiles = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      if (grid[r][c] !== null) tiles.push(grid[r][c]);
    }
    // Tiles settle to the bottom of the column
    for (let i = 0; i < tiles.length; i++) {
      newGrid[GRID_ROWS - tiles.length + i][c] = tiles[i];
    }
  }
  return newGrid;
}

function evaluateGrid(grid, multipliers, dictionary) {
  // Finds all valid words in the grid, scores them, removes the tiles,
  // and applies gravity. Handles chain reactions recursively.
  // Returns { totalScore, finalGrid, wordsFound }.

  let totalScore = 0;
  const wordsFound = [];
  let currentGrid = grid.map(row => [...row]);

  // Keep clearing as long as new words appear (handles chain reactions)
  while (true) {
    const found = [];

    // Scan horizontal words
    for (let r = 0; r < GRID_ROWS; r++) {
      let run = [];
      for (let c = 0; c <= GRID_COLS; c++) {
        const cell = c < GRID_COLS ? currentGrid[r][c] : null;
        if (cell !== null) {
          run.push({ r, c, letter: cell });
        } else {
          if (run.length >= 3) {
            for (let len = run.length; len >= 3; len--) {
              for (let start = 0; start + len <= run.length; start++) {
                const slice = run.slice(start, start + len);
                const word = slice.map(x => x.letter).join('').toLowerCase();
                if (dictionary.has(word)) {
                  found.push({ word: word.toUpperCase(), cells: slice.map(x => ({ r: x.r, c: x.c })), direction: 'h' });
                }
              }
            }
          }
          run = [];
        }
      }
    }

    // Scan vertical words
    for (let c = 0; c < GRID_COLS; c++) {
      let run = [];
      for (let r = 0; r <= GRID_ROWS; r++) {
        const cell = r < GRID_ROWS ? currentGrid[r][c] : null;
        if (cell !== null) {
          run.push({ r, c, letter: cell });
        } else {
          if (run.length >= 3) {
            for (let len = run.length; len >= 3; len--) {
              for (let start = 0; start + len <= run.length; start++) {
                const slice = run.slice(start, start + len);
                const word = slice.map(x => x.letter).join('').toLowerCase();
                if (dictionary.has(word)) {
                  found.push({ word: word.toUpperCase(), cells: slice.map(x => ({ r: x.r, c: x.c })), direction: 'v' });
                }
              }
            }
          }
          run = [];
        }
      }
    }

    if (found.length === 0) break; // No more words to clear

    // Deduplicate: if a shorter word is entirely contained within a longer
    // word in the same direction, only keep the longer one
    const deduped = found.filter((a, i) => {
      const aKeys = new Set(a.cells.map(x => `${x.r},${x.c}`));
      return !found.some((b, j) => {
        if (i === j || b.direction !== a.direction || b.word.length <= a.word.length) return false;
        const bKeys = new Set(b.cells.map(x => `${x.r},${x.c}`));
        return [...aKeys].every(k => bKeys.has(k));
      });
    });

    // Detect combo (h + v words sharing a cell)
    const hWords = deduped.filter(w => w.direction === 'h');
    const vWords = deduped.filter(w => w.direction === 'v');
    let isCombo = false;
    outer: for (const hw of hWords) {
      const hKeys = new Set(hw.cells.map(x => `${x.r},${x.c}`));
      for (const vw of vWords) {
        for (const vc of vw.cells) {
          if (hKeys.has(`${vc.r},${vc.c}`)) { isCombo = true; break outer; }
        }
      }
    }

    // Score this clear pass
    const scoredCells = {};
    let roundScore = 0;

    for (const match of deduped) {
      let wordScore = 0;
      for (const { r, c } of match.cells) {
        const key = `${r},${c}`;
        if (scoredCells[key]) continue; // shared tile already scored
        const letter = currentGrid[r][c];
        const baseValue = gameConfig.LETTER_VALUES[letter] ?? 1;
        const mult = multipliers[key] ?? 1;
        const cellScore = baseValue * mult;
        scoredCells[key] = cellScore;
        wordScore += cellScore;
      }
      if (match.word.length >= 5) wordScore += 2; // 5+ letter word bonus
      roundScore += wordScore;
    }

    if (isCombo) roundScore *= 2; // combo doubles the entire clear score

    totalScore += roundScore;
    wordsFound.push(...deduped.map(w => w.word));

    // Remove cleared tiles
    const toClear = new Set(Object.keys(scoredCells));
    for (const key of toClear) {
      const [r, c] = key.split(',').map(Number);
      currentGrid[r][c] = null;
    }

    // Apply gravity so tiles fall down
    currentGrid = applyGravity(currentGrid);
  }

  return { totalScore, finalGrid: currentGrid, wordsFound };
}

// ---------------------------------------------------------------------------
// Algorithm 1: Greedy with lookahead (N=4)
// ---------------------------------------------------------------------------

/**
 * For each turn, considers all possible column placements for the current
 * letter AND the next LOOKAHEAD_DEPTH-1 letters, then picks the column that
 * maximizes total score over that window.
 *
 * Think of it like a chess player who plans 4 moves ahead. It won't find the
 * globally optimal sequence (that would require looking at ALL remaining letters)
 * but it catches obvious setups like "if I put this E here, STONE clears next turn".
 *
 * Time complexity: O(COLS ^ LOOKAHEAD_DEPTH) per tile drop.
 * At depth 4 and 6 cols: 6^4 = 1,296 simulations per tile. Very fast.
 */
function greedyLookahead(sequence, multipliers, dictionary) {
  let grid = emptyGrid();
  let totalScore = 0;
  let isGameOver = false;

  function simulate(grid, seq, depth) {
    // Recursively simulates `depth` more tile drops and returns the best
    // total score achievable from this grid state.
    if (depth === 0 || seq.length === 0) return 0;

    let best = -Infinity;
    const letter = seq[0];
    const rest = seq.slice(1);

    for (let col = 0; col < GRID_COLS; col++) {
      const newGrid = dropLetter(grid, col, letter);
      if (newGrid === null) continue; // column full, skip

      const { totalScore: clearScore, finalGrid } = evaluateGrid(newGrid, multipliers, dictionary);
      const futureScore = simulate(finalGrid, rest, depth - 1);
      const total = clearScore + futureScore;

      if (total > best) best = total;
    }

    return best === -Infinity ? 0 : best;
  }

  // Play through the entire sequence, one tile at a time
  for (let i = 0; i < sequence.length && !isGameOver; i++) {
    const letter = sequence[i];
    const upcoming = sequence.slice(i + 1, i + LOOKAHEAD_DEPTH); // next N-1 letters
    let bestCol = -1;
    let bestScore = -Infinity;

    for (let col = 0; col < GRID_COLS; col++) {
      const newGrid = dropLetter(grid, col, letter);
      if (newGrid === null) continue;

      const { totalScore: clearScore, finalGrid } = evaluateGrid(newGrid, multipliers, dictionary);

      // Check if the grid is full after this drop (game over)
      const gridFull = finalGrid.every(row => row.every(c => c !== null));
      if (gridFull) {
        // This column leads to immediate game over. Still consider it if forced.
        const total = clearScore;
        if (total > bestScore) { bestScore = total; bestCol = col; }
        continue;
      }

      const futureScore = simulate(finalGrid, upcoming, LOOKAHEAD_DEPTH - 1);
      const total = clearScore + futureScore;

      if (total > bestScore) {
        bestScore = total;
        bestCol = col;
      }
    }

    if (bestCol === -1) {
      // All columns are full: game over
      isGameOver = true;
      break;
    }

    // Execute the chosen move
    const newGrid = dropLetter(grid, bestCol, letter);
    const { totalScore: clearScore, finalGrid } = evaluateGrid(newGrid, multipliers, dictionary);
    totalScore += clearScore;
    grid = finalGrid;

    // Check for grid-full game over after the move resolves
    if (grid.every(row => row.every(c => c !== null))) {
      isGameOver = true;
      break;
    }
  }

  return totalScore;
}

// ---------------------------------------------------------------------------
// Algorithm 2: Beam search
// ---------------------------------------------------------------------------

/**
 * Beam search explores many possible futures simultaneously.
 * At each step, it:
 *   1. Expands every "beam" (a game state + score so far) by trying all 6 columns
 *   2. Evaluates the resulting positions
 *   3. Keeps only the top BEAM_WIDTH states by score
 *   4. Repeats for the next tile
 *
 * This lets it look at the ENTIRE remaining sequence (not just N moves ahead)
 * while staying computationally tractable. It finds near-optimal play.
 *
 * The trade-off vs. lookahead: beam search can miss a low-scoring setup that
 * leads to a very high-scoring chain 10 moves later (it would prune that branch).
 * But for most puzzles, score-greedy play is close to optimal anyway.
 *
 * Time complexity: O(sequence_length * BEAM_WIDTH * COLS) -- linear in sequence length.
 */
function beamSearch(sequence, multipliers, dictionary) {
  // Each beam state is: { grid, score }
  let beams = [{ grid: emptyGrid(), score: 0 }];

  for (let i = 0; i < sequence.length; i++) {
    const letter = sequence[i];
    const nextBeams = [];

    for (const beam of beams) {
      for (let col = 0; col < GRID_COLS; col++) {
        const newGrid = dropLetter(beam.grid, col, letter);
        if (newGrid === null) continue; // column full, can't place here

        const { totalScore: clearScore, finalGrid } = evaluateGrid(newGrid, multipliers, dictionary);

        // Don't continue from a full grid (game over state)
        const gridFull = finalGrid.every(row => row.every(c => c !== null));
        if (!gridFull) {
          nextBeams.push({ grid: finalGrid, score: beam.score + clearScore });
        }
      }
    }

    if (nextBeams.length === 0) break; // all paths led to game over

    // Keep only the top BEAM_WIDTH states by score (prune the rest)
    nextBeams.sort((a, b) => b.score - a.score);
    beams = nextBeams.slice(0, BEAM_WIDTH);
  }

  // The best score across all surviving beam states is our result
  return beams.length > 0 ? beams[0].score : 0;
}

// ---------------------------------------------------------------------------
// Par blending and output
// ---------------------------------------------------------------------------

function computePar(greedyScore, beamScore, discountFactor) {
  // Blends the two algorithm scores and applies the discount.
  // The discount accounts for human imperfection (missed words, etc.).
  const blended = (greedyScore * GREEDY_WEIGHT) + (beamScore * BEAM_WEIGHT);
  const discounted = Math.round(blended * discountFactor);
  // Clamp to the configured min/max range
  return Math.max(PAR_MIN, Math.min(PAR_MAX, discounted));
}

// ---------------------------------------------------------------------------
// Date utilities
// ---------------------------------------------------------------------------

function todayDateStr() {
  // Returns today's date in YYYY-MM-DD format (local time, not UTC).
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dateRange(startStr, endStr) {
  // Returns an array of YYYY-MM-DD strings from startStr to endStr (inclusive).
  const dates = [];
  const current = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  while (current <= end) {
    const y = current.getFullYear();
    const m = String(current.getMonth() + 1).padStart(2, '0');
    const d = String(current.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

function parseArgs() {
  // Parses command-line arguments into an options object.
  const args = process.argv.slice(2);
  const opts = {
    dates: null,       // array of date strings to process, or null for today
    recast: false,     // if true, re-process all dates already in the output file
    dryRun: false,     // if true, compute but don't write to file
    discount: null,    // override DISCOUNT_FACTOR
    forceRerun: false, // if true, recompute even if date already has a par score
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) {
      opts.dates = [args[++i]];
    } else if (args[i] === '--start' && args[i + 1]) {
      const start = args[++i];
      const end = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : todayDateStr();
      opts.dates = dateRange(start, end);
    } else if (args[i] === '--end' && args[i + 1]) {
      // --end without --start: from today to end date
      opts.dates = dateRange(todayDateStr(), args[++i]);
    } else if (args[i] === '--recast') {
      opts.recast = true;
      opts.forceRerun = true;
    } else if (args[i] === '--dry-run') {
      opts.dryRun = true;
    } else if (args[i] === '--discount' && args[i + 1]) {
      opts.discount = parseFloat(args[++i]);
    } else if (args[i] === '--force') {
      opts.forceRerun = true;
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function loadOutputFile(year) {
  // Loads the existing par scores JSON for the given year, or returns empty object.
  const filePath = path.join(OUTPUT_DIR, `${year}.json`);
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.log(`  Warning: could not parse ${filePath}, starting fresh.`);
    return {};
  }
}

function saveOutputFile(year, data) {
  // Writes the par scores JSON for the given year.
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const filePath = path.join(OUTPUT_DIR, `${year}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Short Stack Par Score Generator ===\n');

  const opts = parseArgs();

  // Apply discount override if provided
  if (opts.discount !== null) {
    if (opts.discount < 0.1 || opts.discount > 1.5) {
      console.error('Error: --discount must be between 0.1 and 1.5');
      process.exit(1);
    }
    DISCOUNT_FACTOR = opts.discount;
    console.log(`Discount factor overridden to: ${DISCOUNT_FACTOR}`);
  } else {
    console.log(`Discount factor: ${DISCOUNT_FACTOR} (use --discount X.XX to override)`);
  }

  // Load config and dictionary (both required before processing any dates)
  console.log('\nLoading remote config...');
  await loadConfig();

  console.log('Loading dictionary...');
  const dictionary = await loadDictionary();

  // Determine which dates to process
  let datesToProcess;

  if (opts.recast) {
    // Recast mode: re-run ALL dates that already exist in any output file.
    // Useful when you change weights and want to recalculate everything.
    const outputFiles = fs.existsSync(OUTPUT_DIR)
      ? fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.json'))
      : [];
    datesToProcess = [];
    for (const file of outputFiles) {
      const data = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, file), 'utf8'));
      datesToProcess.push(...Object.keys(data));
    }
    datesToProcess.sort();
    console.log(`\nRecast mode: re-processing ${datesToProcess.length} existing dates.`);
  } else if (opts.dates) {
    datesToProcess = opts.dates;
  } else {
    // Default: just today
    datesToProcess = [todayDateStr()];
  }

  if (opts.dryRun) {
    console.log('\nDRY RUN mode: scores will be computed but not written to file.\n');
  }

  // Group dates by year so we read/write one file per year
  const byYear = {};
  for (const dateStr of datesToProcess) {
    const year = dateStr.slice(0, 4);
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(dateStr);
  }

  let totalProcessed = 0;
  let totalSkipped = 0;

  // Process each year's dates
  for (const [year, dates] of Object.entries(byYear)) {
    const outputData = loadOutputFile(year);
    let yearChanged = false;

    for (const dateStr of dates) {
      // Skip if already computed (unless --force or --recast)
      if (outputData[dateStr] && !opts.forceRerun) {
        console.log(`  ${dateStr}: already computed (par=${outputData[dateStr].par}), skipping. Use --force to recompute.`);
        totalSkipped++;
        continue;
      }

      process.stdout.write(`  ${dateStr}: `);

      // Check for a custom hand-crafted puzzle override in the repo
      const customSequence = await tryLoadCustomPuzzle(dateStr);
      const sequence = customSequence ?? generateSequence(dateStr);
      const multipliers = generateMultipliers(dateStr);
      const isCustom = !!customSequence;

      if (isCustom) {
        process.stdout.write(`[CUSTOM PUZZLE] `);
      }

      // Run Algorithm 1: Greedy with lookahead
      process.stdout.write(`greedy...`);
      const greedyScore = greedyLookahead(sequence, multipliers, dictionary);

      // Run Algorithm 2: Beam search
      process.stdout.write(` beam...`);
      const beamScore = beamSearch(sequence, multipliers, dictionary);

      // Blend and apply discount
      const par = computePar(greedyScore, beamScore, DISCOUNT_FACTOR);

      console.log(` greedy=${greedyScore}, beam=${beamScore}, par=${par}`);

      outputData[dateStr] = {
        par,
        greedyScore,
        beamScore,
        discount: DISCOUNT_FACTOR,
        algorithmVersion: 'v1-lookahead4-beam40',
        isCustomPuzzle: isCustom,
        generatedAt: new Date().toISOString(),
      };

      yearChanged = true;
      totalProcessed++;
    }

    // Write the updated file (one write per year, not per date)
    if (yearChanged && !opts.dryRun) {
      // Sort by date before saving so the file is human-readable
      const sorted = Object.keys(outputData).sort().reduce((acc, k) => {
        acc[k] = outputData[k];
        return acc;
      }, {});
      const filePath = saveOutputFile(year, sorted);
      console.log(`\n  Saved: ${filePath}`);
    }
  }

  console.log(`\nDone. Processed: ${totalProcessed}, Skipped: ${totalSkipped}.`);

  if (opts.dryRun) {
    console.log('(Dry run: no files were written.)');
  } else if (totalProcessed > 0) {
    console.log('\nNext step: commit the output/ files to your puzzle repo at:');
    console.log('  https://github.com/sirsigmund79/wordwich-puzzles/tree/main/letter_drop_puzzles/par_scores/');
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
