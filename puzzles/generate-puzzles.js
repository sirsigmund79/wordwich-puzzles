/**
 * generate-puzzles.mjs
 *
 * Auto-generates Letter Loaf daily puzzles and writes them as JSON files
 * following the existing -ww2.json naming convention.
 *
 * WHAT THIS SCRIPT DOES:
 *   For each date in the requested range, it:
 *   1. Loads the dictionary and all existing puzzles from the repo
 *   2. Skips dates that already have a hand-crafted or auto-generated puzzle
 *   3. Selects three letter pairs based on difficulty targets for that day of week
 *   4. Scores the pairs, picks hint words, sets pass/perfect scores
 *   5. Writes a JSON file ready to commit to the repo
 *
 * MEASURING DIFFICULTY — THE REACHABLE CEILING:
 *   A pair's difficulty is NOT how many words the dictionary holds. It's how
 *   many points a real player can actually reach. K-S has hundreds of matches
 *   because you can pluralise almost any K word; K-A has a few dozen, most of
 *   them obscure. Those two pairs cannot carry the same target score.
 *
 *   So every pair gets a CEILING: the score of its CEILING_WORDS most familiar
 *   matching words, where familiarity comes from word_frequency.txt (an English
 *   frequency list intersected with the game dictionary, most common first).
 *   That is roughly "what a strong player who empties their head can score".
 *
 *     K-A  ceiling  33   (KARMA, KAPPA, KOALA, KANA... and then nothing)
 *     K-S  ceiling  70   (KIDS, KNOWS, KISS, KEEPS, KEYS...)
 *     E-A  ceiling 129   (EXTRA, EUREKA, ENIGMA, ENCYCLOPEDIA...)
 *
 * PER-ROUND SCORING — ROUNDS ARE ALLOWED TO DIFFER:
 *   perfectScore = ceiling x the day's REACH factor, so a round's target is set
 *   by its own pair, not by a flat daily number. A hard day raises REACH (you
 *   must find more of what's out there), it does not paste the same threshold
 *   onto three unequal pairs. A puzzle with rounds worth 32 / 55 / 79 is a
 *   normal, intended outcome: the 32 is a genuinely barren pair and demanding
 *   79 from it would just be unfair.
 *
 * PER-DAY SHAPE — THE ANCHOR ROUND:
 *   What each day guarantees is a peak, not a floor: at least one round must
 *   reach ANCHOR_MIN points (the day's headline challenge), and no round may
 *   exceed ANCHOR_MAX. The other two rounds land wherever their pairs land.
 *   Easy days additionally refuse barren pairs outright (MIN_CEILING), so a
 *   Monday never opens with a brick wall.
 *
 * CONSTRAINTS (hard limits — never violated):
 *   - At least MIN_WORD_COUNT matching words, and MIN_KNOWN_WORDS of them
 *     familiar enough that the round is solvable at all
 *   - Every pair clears the day's MIN_CEILING
 *   - At least one round reaches the day's ANCHOR_MIN; none exceeds ANCHOR_MAX
 *   - Day total is at least the day's MIN_TOTAL (no cap — totals vary by design)
 *   - passScore is 8%-20% of perfectScore (random within that range)
 *   - hintWord is a word players will recognise (see "Hint vocabulary" below)
 *   - No pair used more than once in the past 60 days
 *   - No identical 3-pair sequence (regardless of order) in the past 90 days
 *   - At most one easy-ending pair (R/Y/S/D) per day
 *
 * HOW TO RUN:
 *   node generate-puzzles.js --days 30            # 30 more days after the last puzzle
 *   node generate-puzzles.js                      # today only
 *   node generate-puzzles.js --date 2026-07-04    # one specific date
 *   node generate-puzzles.js --start 2026-07-01 --end 2026-12-31
 *   node generate-puzzles.js --start 2026-07-01 --days 14
 *   node generate-puzzles.js --days 30 --dry-run  # print the schedule, write nothing
 *   node generate-puzzles.js --force              # overwrite existing AUTO puzzles
 *                                                 # (never overwrites manual puzzles)
 *
 * OUTPUT:
 *   ./YYYY-MM-DD-ww2.json, alongside this script in puzzles/ — ready to commit.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SCRIPT_DIR  = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR  = SCRIPT_DIR;
const DICT_PATH   = path.join(SCRIPT_DIR, '..', 'letterloaf_dict.txt');
const FREQ_PATH   = path.join(SCRIPT_DIR, 'word_frequency.txt');
const HINT_PATH   = path.join(SCRIPT_DIR, 'hint_words.txt');

// GitHub repo details — used only as a fallback if the local dictionary is gone
const GITHUB_REPO  = 'sirsigmund79/wordwich-puzzles';
const BRANCH       = 'main';
const DICT_URL     = `https://raw.githubusercontent.com/${GITHUB_REPO}/${BRANCH}/letterloaf_dict.txt`;

// How many of a pair's most familiar words make up its reachable ceiling.
// ~20 is what a strong player produces before they run dry.
const CEILING_WORDS = 20;

// Day profiles (0=Sunday through 6=Saturday).
//
//   reach      perfectScore = round(pair ceiling x reach). Higher = you must
//              find more of what the pair actually offers = harder.
//   anchorMin  at least one round must reach this many points — the day's peak.
//   anchorMax  no round may exceed this, so the peak stays where we aimed it.
//   minCeiling pairs below this ceiling are barred from the day entirely.
//              Low on hard days: that is what lets a truly barren pair through
//              at, say, 32 points while another round still climbs to 79.
//   minTotal   floor on the sum of the three rounds. There is deliberately no
//              ceiling on the total — days are meant to vary.
const DAY_PROFILE = {
  0: { label: 'Tough',  reach: 0.72, anchorMin: 82, anchorMax: 98, minCeiling: 45, minTotal: 165 }, // Sunday
  1: { label: 'Easy',   reach: 0.44, anchorMin: 46, anchorMax: 62, minCeiling: 85, minTotal: 115 }, // Monday
  2: { label: 'Medium', reach: 0.50, anchorMin: 56, anchorMax: 72, minCeiling: 70, minTotal: 130 }, // Tuesday
  3: { label: 'Medium', reach: 0.56, anchorMin: 63, anchorMax: 80, minCeiling: 58, minTotal: 140 }, // Wednesday
  4: { label: 'Hard',   reach: 0.63, anchorMin: 72, anchorMax: 90, minCeiling: 48, minTotal: 150 }, // Thursday
  5: { label: 'Hard',   reach: 0.67, anchorMin: 78, anchorMax: 94, minCeiling: 44, minTotal: 155 }, // Friday
  6: { label: 'Medium', reach: 0.50, anchorMin: 56, anchorMax: 72, minCeiling: 70, minTotal: 130 }, // Saturday
};

// Absolute floor for any round. A pair whose ceiling lands under this still
// gets a playable target — it just stays small.
const MIN_ROUND_SCORE = 24;

// "Easy endings" — pairs ending with these letters are common and feel easy.
// At most one per day is allowed.
const EASY_ENDINGS = new Set(['R', 'Y', 'S', 'D']);

// How recently (days) a pair must NOT have been used
const RECENCY_WINDOW_DAYS = 60;

// How far back to check for identical 3-pair sets (regardless of order)
const SEQUENCE_WINDOW_DAYS = 90;

// Minimum constraints — never publish a pair that fails these
const MIN_WORD_COUNT   = 60;  // matching words in the dictionary
const MIN_KNOWN_WORDS  = 15;  // of those, how many must be familiar enough to find
const MIN_FULL_SCORE   = 200; // must have at least 200 possible points

// ---------------------------------------------------------------------------
// Length-based scoring — mirrors your Apps Script calculateScore exactly
// ---------------------------------------------------------------------------

function scoreWord(word) {
  const len = word.length;
  if (len === 4)  return 1;
  if (len === 5)  return 2;
  if (len === 6)  return 4;
  if (len === 7)  return 7;
  if (len >= 8)   return 11;
  return 0;
}

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

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

function diffDays(a, b) {
  // Returns how many days ago `a` was relative to `b`
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

function dowOf(dateStr) {
  return new Date(dateStr + 'T00:00:00').getDay();
}

// Seeded random for reproducibility — same puzzle every time script runs for same date
function seededRand(seed) {
  let s = seed;
  return function() {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function dateSeed(dateStr) {
  // Turns "2026-07-04" into a number for seeding
  return parseInt(dateStr.replace(/-/g, ''), 10);
}

function shuffle(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

// ---------------------------------------------------------------------------
// Dictionary loading
// ---------------------------------------------------------------------------

async function loadDictionary() {
  let text;
  if (fs.existsSync(DICT_PATH)) {
    console.log('  Loading dictionary from letterloaf_dict.txt...');
    text = fs.readFileSync(DICT_PATH, 'utf8');
  } else {
    console.log('  Local dictionary missing — fetching from GitHub...');
    text = await fetchText(DICT_URL);
  }
  // Keep only words of 4+ letters (same as your Apps Script)
  const words = text
    .toUpperCase()
    .split('\n')
    .map(w => w.trim())
    .filter(w => w.length >= 4 && /^[A-Z]+$/.test(w));
  console.log(`  Dictionary: ${words.length.toLocaleString()} words loaded.`);
  return words;
}

// ---------------------------------------------------------------------------
// Familiarity ranks
// word_frequency.txt holds the game's own words ordered most-common-first, so
// line 1 is the most familiar word and the last line the least. Rank is the
// only thing that separates "K-S has 792 matches" from "a player can name 15
// of them" — without it every pair looks equally rich.
// ---------------------------------------------------------------------------

function loadFrequencyRanks() {
  if (!fs.existsSync(FREQ_PATH)) {
    throw new Error(
      `Missing ${path.basename(FREQ_PATH)} — it holds the word familiarity ranks ` +
      `that difficulty is derived from.`
    );
  }
  const ranks = new Map();
  let rank = 0;
  for (const line of fs.readFileSync(FREQ_PATH, 'utf8').split('\n')) {
    const word = line.trim().toUpperCase();
    if (!word) continue;
    if (!ranks.has(word)) ranks.set(word, ++rank);
  }
  console.log(`  Familiarity ranks: ${ranks.size.toLocaleString()} words.`);
  return ranks;
}

// ---------------------------------------------------------------------------
// Hint vocabulary
// Frequency rank measures how often a word is SAID, which is not the same as
// how well it is known: subtitle data ranks HONG and PERRY above CHARM, because
// characters say them out loud. Both are real dictionary words, and both make
// useless hints. hint_words.txt (the 2,315 Wordle answers, a list curated for
// exactly this — everyday five-letter words) is the recognizability filter.
// ---------------------------------------------------------------------------

function loadHintWords() {
  if (!fs.existsSync(HINT_PATH)) {
    console.log(`  Warning: ${path.basename(HINT_PATH)} missing — hints fall back to frequency alone.`);
    return new Set();
  }
  const set = new Set(
    fs.readFileSync(HINT_PATH, 'utf8').split('\n').map(w => w.trim().toUpperCase()).filter(Boolean)
  );
  console.log(`  Hint vocabulary: ${set.size.toLocaleString()} words.`);
  return set;
}

// ---------------------------------------------------------------------------
// Pair analysis
// Computes all matching words and scores for a given start/end letter pair.
// This mirrors your Apps Script generatePuzzleStats logic.
// ---------------------------------------------------------------------------

function analyzePair(startLetter, endLetter, dictionary, lex) {
  // Returns null if pair fails minimum constraints.
  const { ranks, hintWords } = lex;
  const start = startLetter.toUpperCase();
  const end   = endLetter.toUpperCase();

  const matching = dictionary.filter(w => w.startsWith(start) && w.endsWith(end));

  if (matching.length < MIN_WORD_COUNT) return null;

  const fullScore = matching.reduce((sum, w) => sum + scoreWord(w), 0);
  if (fullScore < MIN_FULL_SCORE) return null;

  // The words a player has any chance of naming, most familiar first.
  const known = matching
    .filter(w => ranks.has(w))
    .sort((a, b) => ranks.get(a) - ranks.get(b));

  if (known.length < MIN_KNOWN_WORDS) return null;

  // Reachable ceiling: what emptying your head is worth on this pair.
  const ceiling = known
    .slice(0, CEILING_WORDS)
    .reduce((sum, w) => sum + scoreWord(w), 0);

  // Count words by length bucket
  const byLength = {};
  for (const w of matching) {
    const len = Math.min(w.length, 10); // group 10+ together
    byLength[len] = (byLength[len] || 0) + 1;
  }

  // Best hint material: matches in the curated hint vocabulary that are also
  // common, most familiar first. Both halves are needed — curated-only lets
  // REBUS through for R-S when RULES was available, and common-only lets HONG
  // through for H-G. Often empty (plural and -ING pairs are absent from the
  // curated list by design, and rare words fail the rank cut); pickHintWord
  // then falls back to plain familiarity.
  const hintable = matching
    .filter(w => hintWords.has(w) && (ranks.get(w) ?? Infinity) <= HINT_MAX_RANK)
    .sort((a, b) => ranks.get(a) - ranks.get(b));

  return {
    pair: `${start}-${end}`,
    start,
    end,
    wordCount: matching.length,
    knownCount: known.length,
    fullScore,
    ceiling,
    byLength,
    words: matching,   // kept for hint word selection later
    known,             // familiar matches, most common first
    hintable,          // curated-vocabulary matches, most common first
  };
}

// Precompute ALL valid pairs from the dictionary once upfront.
// This is the expensive step but only runs once per script invocation.
function buildPairIndex(dictionary, lex) {
  console.log('  Building pair index (this takes ~15 seconds)...');
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const index = {};  // key: "A-B", value: analyzePair result or null

  for (const s of letters) {
    for (const e of letters) {
      const result = analyzePair(s, e, dictionary, lex);
      if (result) {
        index[`${s}-${e}`] = result;
      }
    }
  }

  const validCount = Object.keys(index).length;
  console.log(`  Pair index: ${validCount} valid pairs found out of 676 possible.`);
  return index;
}

// ---------------------------------------------------------------------------
// Existing puzzle loading
// Fetches all *-ww2.json files from the repo to build:
//   - A map of date -> puzzle (for skipping and constraint checking)
//   - A history of which pairs have been used recently
// ---------------------------------------------------------------------------

function loadExistingPuzzles() {
  console.log('  Reading existing puzzles...');

  const puzzleFiles = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('-ww2.json'));
  const byDate = {};

  for (const file of puzzleFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, file), 'utf8'));
      if (data && data.date && Array.isArray(data.rounds)) {
        byDate[data.date] = {
          ...data,
          _filename: file,
          _isAuto: file.includes('-auto') || (data._auto === true),
        };
      }
    } catch (_) {
      // Skip files that can't be parsed
    }
  }

  // Build a flat history of all pair usages with dates, sorted oldest first
  const pairHistory = [];
  for (const [date, puzzle] of Object.entries(byDate)) {
    for (const round of puzzle.rounds) {
      pairHistory.push({
        date,
        pair: `${round.startLetter.toUpperCase()}-${round.endLetter.toUpperCase()}`,
      });
    }
  }
  pairHistory.sort((a, b) => a.date.localeCompare(b.date));

  console.log(`  Found ${Object.keys(byDate).length} existing puzzles.`);
  return { byDate, pairHistory };
}

// ---------------------------------------------------------------------------
// History constraint checking
// ---------------------------------------------------------------------------

function recentlyUsedPairs(targetDate, pairHistory) {
  // Returns a Set of pairs used within RECENCY_WINDOW_DAYS before targetDate
  const cutoff = addDays(targetDate, -RECENCY_WINDOW_DAYS);
  const used = new Set();
  for (const entry of pairHistory) {
    if (entry.date >= cutoff && entry.date < targetDate) {
      used.add(entry.pair);
    }
  }
  return used;
}

function recentTrioSets(targetDate, byDate) {
  // Returns an array of Sets, each representing a 3-pair combo used in the
  // past SEQUENCE_WINDOW_DAYS. We track the SET (not order) of pairs.
  const cutoff = addDays(targetDate, -SEQUENCE_WINDOW_DAYS);
  const trios = [];
  for (const [date, puzzle] of Object.entries(byDate)) {
    if (date >= cutoff && date < targetDate) {
      const pairSet = new Set(puzzle.rounds.map(r =>
        `${r.startLetter.toUpperCase()}-${r.endLetter.toUpperCase()}`
      ));
      trios.push(pairSet);
    }
  }
  return trios;
}

function isTrioDuplicate(candidatePairs, existingTrios) {
  // Returns true if the candidate trio (as an array of pair strings) is
  // the same SET as any existing trio (order-independent comparison)
  const candidateSet = new Set(candidatePairs);
  for (const trio of existingTrios) {
    if (trio.size === candidateSet.size &&
        [...trio].every(p => candidateSet.has(p))) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pair selection
// ---------------------------------------------------------------------------

// A pair's target score, set by that pair's own reachable ceiling. This is the
// whole point: three pairs on the same day get three different numbers.
function perfectScoreFor(pairData, profile) {
  const raw = Math.round(pairData.ceiling * profile.reach);
  return Math.max(MIN_ROUND_SCORE, Math.min(profile.anchorMax, raw));
}

function selectThreePairs(dateStr, pairIndex, recentPairs, existingTrios, rand) {
  const profile = DAY_PROFILE[dowOf(dateStr)];

  // Pairs rich enough for today, not used recently.
  const candidates = Object.values(pairIndex).filter(p =>
    p.ceiling >= profile.minCeiling &&
    !recentPairs.has(p.pair)
  );

  const picked = pickThree(candidates, existingTrios, rand, profile);
  if (picked) return picked;

  // Nothing fit — most often the recency window has eaten the pool, or no
  // remaining pair can carry today's anchor. Drop the minCeiling gate (keeping
  // the anchor requirement, which is the part players feel) and retry.
  const fallback = Object.values(pairIndex).filter(p => !recentPairs.has(p.pair));
  return pickThree(fallback, existingTrios, rand, profile);
}

function pickThree(pool, existingTrios, rand, profile) {
  // Attempts to pick 3 non-conflicting pairs from the pool.
  // Tries up to 500 random combinations before giving up.

  const shuffled = shuffle(pool, rand);
  if (shuffled.length < 3) return null;

  for (let attempt = 0; attempt < 500; attempt++) {
    // Pick 3 random candidates (using seeded shuffle for reproducibility)
    const startIdx = (attempt * 3) % Math.max(shuffled.length - 3, 1);
    const pick = [];
    const pickIndices = new Set();

    // Collect 3 distinct pairs
    let i = startIdx;
    while (pick.length < 3 && pickIndices.size < shuffled.length) {
      const idx = i % shuffled.length;
      if (!pickIndices.has(idx)) {
        pickIndices.add(idx);
        pick.push(shuffled[idx]);
      }
      i++;
    }

    if (pick.length < 3) continue;

    // Rule: at most one easy-ending pair per day
    const easyCount = pick.filter(p => EASY_ENDINGS.has(p.end)).length;
    if (easyCount > 1) continue;

    // Rule: this exact combination (as a set) must not have been used recently
    const pairStrings = pick.map(p => p.pair);
    if (isTrioDuplicate(pairStrings, existingTrios)) continue;

    // Rule: all three pairs must be distinct
    const pairSet = new Set(pairStrings);
    if (pairSet.size < 3) continue;

    // Rule: one round has to be today's peak. Everything else is free to sit
    // wherever its pair lands — a 32 next to a 79 is the intended shape.
    const scores = pick.map(p => perfectScoreFor(p, profile));
    if (Math.max(...scores) < profile.anchorMin) continue;

    // Rule: the day still has to be worth playing overall.
    if (scores.reduce((a, b) => a + b, 0) < profile.minTotal) continue;

    // Order the rounds so the day builds toward the anchor.
    pick.sort((a, b) => perfectScoreFor(a, profile) - perfectScoreFor(b, profile));

    return pick;
  }

  return null; // Could not find a valid combination
}

// ---------------------------------------------------------------------------
// Hint word selection
// ---------------------------------------------------------------------------

// Hints come from the same familiarity ranking that drives difficulty, so a
// hint is always a word players actually know — no hand-maintained list.
// 5 letters is the sweet spot: long enough to demonstrate the pattern, short
// enough not to give away the round's best scoring word.

const HINT_POOL_SIZE = 6;      // choose among this many of the most familiar options
const HINT_MAX_RANK  = 12000;  // a curated word this far down the list is not "everyday"

// The frequency list is built from film subtitles, so its common words include
// things we will not print on the board as the day's worked example. This bars
// them from being HINTS only — they stay perfectly playable if a player finds
// them. Ordinary-but-blunt vocabulary (DEAD, DAMN, GUNS) is deliberately absent:
// over-blocking costs good hints for no gain.
const HINT_BLOCKLIST = new Set([
  'ANUS','ARSE','ARSES','BITCH','BITCHY','BOOBS','BOOBY','BUTT','BUTTS',
  'COCK','COCKS','CRAP','CRAPPY','CUNT','CUNTS','DICK','DICKS','DYKE',
  'FAGIN','FAGS','FAGGOT','FART','FARTS','FUCK','FUCKED','FUCKER','FUCKS',
  'HOOKER','HORNY','JIZZ','NAZI','NAZIS','NIGGER','NUDE','NUDES','NUDIE',
  'PENIS','PIMP','PISS','PISSED','POOP','PORN','PORNO','PRICK','PUKE',
  'PUSS','PUSSY','QUEERS','RAPE','RAPED','RAPES','RAPING','RAPIST',
  'SEMEN','SEXY','SHIT','SHITS','SHITTY','SLUT','SLUTS','SPERM',
  'TITS','TITTY','TURD','TURDS','TWAT','UNDIES','VAGINA','WANKER',
  'WHORE','WHORES',
]);

function pickHintWord(pairData, rand) {
  const allowed = w => !HINT_BLOCKLIST.has(w);

  // Preferred: a curated everyday word, chosen from the most familiar few so
  // hints still vary between uses of a pair.
  const curated = pairData.hintable.filter(allowed);
  if (curated.length) {
    const pool = curated.slice(0, Math.min(HINT_POOL_SIZE, curated.length));
    return pool[Math.floor(rand() * pool.length)];
  }

  // Fallback for pairs the curated list does not reach (K-S, N-G, V-Y...).
  // Here recognizability beats variety, so take the single most familiar short
  // match rather than sampling: KIDS over KILNS, VERY over VICHY.
  const known = pairData.known.filter(allowed);  // already most familiar first
  for (const len of [4, 6, 5]) {
    const hit = known.find(w => w.length === len);
    if (hit) return hit;
  }
  return known[0] ?? null;
}

// ---------------------------------------------------------------------------
// Perfect score and pass score calculation
// ---------------------------------------------------------------------------

function computePassScore(perfectScore, rand) {
  // passScore is 8%-20% of perfectScore, minimum 1
  const pct = 0.08 + rand() * 0.12;
  return Math.max(1, Math.round(perfectScore * pct));
}

// ---------------------------------------------------------------------------
// Puzzle assembly
// ---------------------------------------------------------------------------

function assemblePuzzle(dateStr, selectedPairs, pairIndex, rand) {
  const profile = DAY_PROFILE[dowOf(dateStr)];

  const rounds = selectedPairs.map((pairData, i) => {
    const perfectScore = perfectScoreFor(pairData, profile);
    const passScore    = computePassScore(perfectScore, rand);
    const hintWord     = pickHintWord(pairData, rand);

    return {
      round: i + 1,
      startLetter: pairData.start.toLowerCase(),
      endLetter:   pairData.end.toLowerCase(),
      passScore,
      perfectScore,
      hintWord: hintWord ? hintWord.toLowerCase() : null,
    };
  });

  const maxScore = rounds.reduce((sum, r) => sum + r.perfectScore, 0);

  return {
    date:     dateStr,
    maxScore,
    rounds,
    _auto:    true,   // internal flag so we know this was auto-generated
                      // (not surfaced to players, just for repo management)
  };
}

// ---------------------------------------------------------------------------
// File output
// ---------------------------------------------------------------------------

function writePuzzleFile(puzzle, dryRun) {
  const filename = `${puzzle.date}-ww2.json`;
  const filePath = path.join(OUTPUT_DIR, filename);

  if (!dryRun) {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(puzzle, null, 2));
  }

  return filename;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dates:    null,   // array of date strings, or null = resolved in main()
    days:     null,   // with no --start: N days on from the last puzzle in the folder
    dryRun:   false,
    force:    false,  // overwrite existing AUTO puzzles (never manual ones)
  };

  let start = null, end = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i+1]) {
      opts.dates = [args[++i]];
    } else if (args[i] === '--start' && args[i+1]) {
      start = args[++i];
      // Bare positional end date: `--start A B` is the same as `--start A --end B`
      if (args[i+1] && !args[i+1].startsWith('--')) end = args[++i];
    } else if (args[i] === '--end' && args[i+1]) {
      end = args[++i];
    } else if (args[i] === '--days' && args[i+1]) {
      opts.days = parseInt(args[++i], 10);
    } else if (args[i] === '--dry-run') {
      opts.dryRun = true;
    } else if (args[i] === '--force') {
      opts.force = true;
    }
  }

  if (start) {
    // --start with --days but no --end means "N days from the start date"
    const stop = end ?? (opts.days ? addDays(start, opts.days - 1) : todayStr());
    opts.dates = dateRange(start, stop);
    opts.days  = null;
  } else if (end) {
    opts.dates = dateRange(todayStr(), end);
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Letter Loaf Puzzle Generator ===\n');

  const opts = parseArgs();

  if (opts.dryRun)  console.log('DRY RUN: no files will be written.\n');
  if (opts.force)   console.log('FORCE: will overwrite existing auto-generated puzzles.\n');

  // Load dictionary and build pair index (expensive but runs only once)
  const dictionary = await loadDictionary();
  const lexicon    = { ranks: loadFrequencyRanks(), hintWords: loadHintWords() };
  const pairIndex  = buildPairIndex(dictionary, lexicon);

  // Load all existing puzzles from the repo for constraint checking
  const { byDate: existingPuzzles, pairHistory } = loadExistingPuzzles();

  // Determine which dates to generate. Bare `--days N` means "extend the run by
  // N days", picking up the day after the last puzzle already in the folder.
  let datesToProcess = opts.dates;
  if (!datesToProcess && opts.days) {
    const dates = Object.keys(existingPuzzles).sort();
    const from  = dates.length ? addDays(dates[dates.length - 1], 1) : todayStr();
    datesToProcess = dateRange(from, addDays(from, opts.days - 1));
    console.log(`  Extending by ${opts.days} days from ${from}.`);
  }
  datesToProcess ??= [todayStr()];
  console.log(`\nDates to process: ${datesToProcess.length}`);

  let processed = 0, skipped = 0, failed = 0;

  for (const dateStr of datesToProcess) {
    process.stdout.write(`  ${dateStr}: `);

    // Skip if a puzzle already exists for this date
    if (existingPuzzles[dateStr]) {
      const existing = existingPuzzles[dateStr];
      if (!existing._isAuto || !opts.force) {
        // Hand-crafted puzzles are NEVER overwritten. Auto puzzles are skipped
        // unless --force is passed.
        const type = existing._isAuto ? 'auto-generated' : 'MANUAL (protected)';
        console.log(`skipped — ${type} puzzle already exists.`);
        skipped++;
        continue;
      }
      console.log(`overwriting existing auto puzzle...`);
    }

    // Also check output folder for a file already written this run
    const outPath = path.join(OUTPUT_DIR, `${dateStr}-ww2.json`);
    if (fs.existsSync(outPath) && !opts.force) {
      console.log(`skipped — already written this run (use --force to overwrite).`);
      skipped++;
      continue;
    }

    // Build constraint context for this specific date
    const recentPairs = recentlyUsedPairs(dateStr, pairHistory);
    const existingTrios = recentTrioSets(dateStr, existingPuzzles);

    // Seeded random so this date always produces the same puzzle
    const rand = seededRand(dateSeed(dateStr));

    // Select three pairs
    const selectedPairs = selectThreePairs(dateStr, pairIndex, recentPairs, existingTrios, rand);
    if (!selectedPairs) {
      console.log(`FAILED — could not find 3 valid pairs meeting constraints.`);
      failed++;
      continue;
    }

    // Assemble the puzzle JSON
    const puzzle = assemblePuzzle(dateStr, selectedPairs, pairIndex, rand);

    // Write the file
    const filename = writePuzzleFile(puzzle, opts.dryRun);

    const profile = DAY_PROFILE[dowOf(dateStr)];
    const shape = puzzle.rounds
      .map((r, i) => `${selectedPairs[i].pair} ${String(r.perfectScore).padStart(2)}`)
      .join('   ');
    console.log(
      `done — ${profile.label.padEnd(6)} total=${String(puzzle.maxScore).padStart(3)}   ${shape}`
    );

    // Update in-memory history so subsequent dates in this run respect recency
    
      existingPuzzles[dateStr] = puzzle;
      for (const round of puzzle.rounds) {
        pairHistory.push({
          date: dateStr,
          pair: `${round.startLetter.toUpperCase()}-${round.endLetter.toUpperCase()}`,
        });
      }
    

    processed++;
  }

  console.log(`\nDone. Generated: ${processed}, Skipped: ${skipped}, Failed: ${failed}.`);

  if (failed > 0) {
    console.log('\nNote: Failed dates usually mean the constraint window is too tight');
    console.log('(too many pairs excluded by recency). Try a wider date range or');
    console.log('run with --force to regenerate recent auto-puzzles.');
  }

  if (!opts.dryRun && processed > 0) {
    console.log('\nFiles are written straight into puzzles/. Next step:');
    console.log(`  git add puzzles/`);
    console.log(`  git commit -m "Add auto-generated puzzles"`);
    console.log(`  git push`);
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
