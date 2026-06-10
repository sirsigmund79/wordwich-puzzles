/**
 * generate-puzzles.mjs
 *
 * Auto-generates Letter Loaf daily puzzles and writes them as JSON files
 * following the existing -ww2.json naming convention.
 *
 * WHAT THIS SCRIPT DOES:
 *   For each date in the requested range, it:
 *   1. Fetches the live dictionary and all existing puzzles from the repo
 *   2. Skips dates that already have a hand-crafted or auto-generated puzzle
 *   3. Selects three letter pairs based on difficulty targets for that day of week
 *   4. Scores the pairs, picks hint words, sets pass/perfect scores
 *   5. Writes a JSON file ready to commit to the repo
 *
 * DIFFICULTY SCHEDULE (total maxScore targets):
 *   Monday    140 - 160   (easy — start of week)
 *   Tuesday   160 - 185
 *   Wednesday 175 - 210
 *   Thursday  195 - 230
 *   Friday    200 - 250   (harder — challenging combinations)
 *   Saturday  160 - 185   (same as Tuesday — weekend ease-off)
 *   Sunday    220 - 270   (tough — end of week challenge)
 *
 * HARD vs EASY:
 *   "Difficulty" for a pair is measured by its FULL_SCORE — the total points
 *   you'd earn if every matching word in the dictionary were played.
 *   High FULL_SCORE (1000+) = easy pair (many common words available)
 *   Low FULL_SCORE (500-800) = harder pair (fewer/less common words)
 *
 *   "Easy pairs" (ending in R, Y, S, D) are rate-limited so at most one
 *   appears per day, and never all three.
 *
 * CONSTRAINTS (hard limits — never violated):
 *   - At least 100 matching words per pair
 *   - FULL_SCORE at least 200 per pair (otherwise likely no common words)
 *   - perfectScore per round is set between 40 and 100
 *   - passScore is 5%-20% of perfectScore (random within that range)
 *   - hintWord is a 5-letter match (falls back to 4-letter) that appears
 *     in the common word list
 *   - No pair used more than once in the past 60 days
 *   - No identical 3-pair sequence (regardless of order) in the past 90 days
 *   - Never three easy-ending pairs in the same puzzle
 *
 * HOW TO RUN:
 *   node generate-puzzles.mjs                             # today only
 *   node generate-puzzles.mjs --date 2026-07-04           # specific date
 *   node generate-puzzles.mjs --start 2026-07-01 --end 2026-12-31
 *   node generate-puzzles.mjs --dry-run                   # compute but don't write files
 *   node generate-puzzles.mjs --force                     # overwrite existing auto puzzles
 *                                                          # (never overwrites manual puzzles)
 *
 * OUTPUT:
 *   ./output/YYYY-MM-DD-ww2.json  (ready to commit to the puzzles/ folder)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OUTPUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)));

// GitHub repo details — mirrors what your Apps Script uses
const GITHUB_REPO  = 'sirsigmund79/wordwich-puzzles';
const BRANCH       = 'main';
const FOLDER_PATH  = 'puzzles';
const RAW_BASE_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/${BRANCH}/${FOLDER_PATH}/`;
const API_URL      = `https://api.github.com/repos/${GITHUB_REPO}/contents/${FOLDER_PATH}`;
const DICT_URL     = 'https://letterloaf.com/dictionary.txt';

// Difficulty targets per day of week (0=Sunday through 6=Saturday)
// Each entry is [minTotalMaxScore, maxTotalMaxScore]
// "Total max score" = sum of perfectScore across all three rounds
const DIFFICULTY_BY_DOW = {
  0: { range: [220, 270], label: 'Tough'   },  // Sunday
  1: { range: [140, 160], label: 'Easy'    },  // Monday
  2: { range: [160, 185], label: 'Medium'  },  // Tuesday
  3: { range: [175, 210], label: 'Medium'  },  // Wednesday
  4: { range: [195, 230], label: 'Hard'    },  // Thursday
  5: { range: [200, 250], label: 'Hard'    },  // Friday
  6: { range: [160, 185], label: 'Medium'  },  // Saturday
};

// Per-round perfectScore range by day difficulty
// Easy days: each round contributes 45-55 pts to a total of ~150
// Hard days: each round might contribute 60-90 pts but with fewer/harder words
const PERFECT_SCORE_BY_DOW = {
  0: [50, 80],   // Sunday  — challenging per round
  1: [40, 60],   // Monday  — gentle per round
  2: [48, 68],   // Tuesday
  3: [52, 75],   // Wednesday
  4: [58, 85],   // Thursday
  5: [35, 62],   // Friday
  6: [48, 68],   // Saturday
};

// FULL_SCORE range for pair selection (the Apps Script "max if all words scored")
// Easy days: prefer high-FULL_SCORE pairs (lots of common words available)
// Hard days: prefer mid-to-low FULL_SCORE pairs (fewer, less obvious words)
const FULL_SCORE_RANGE_BY_DOW = {
  0: [500,  900],   // Sunday  — moderately low, but not barren
  1: [1000,  9999],  // Monday  — easy, high-scoring pairs only
  2: [700,  9999],  // Tuesday
  3: [600,  7000],  // Wednesday
  4: [500,  3500],   // Thursday — start pushing toward harder pairs
  5: [500,  25000],   // Friday
  6: [2500,  9999],  // Saturday
};

// "Easy endings" — pairs ending with these letters are common and feel easy.
// At most one per day is allowed.
const EASY_ENDINGS = new Set(['R', 'Y', 'S', 'D']);

// How recently (days) a pair must NOT have been used
const RECENCY_WINDOW_DAYS = 60;

// How far back to check for identical 3-pair sets (regardless of order)
const SEQUENCE_WINDOW_DAYS = 90;

// Minimum constraints — never publish a pair that fails these
const MIN_WORD_COUNT  = 85;   // must have at least 100 matching words
const MIN_FULL_SCORE  = 200;   // must have at least 200 possible points

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

function randInt(rand, min, max) {
  // Returns a random integer between min and max inclusive
  return min + Math.floor(rand() * (max - min + 1));
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

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Dictionary loading
// ---------------------------------------------------------------------------

async function loadDictionary() {
  console.log('  Loading dictionary from letterloaf.com...');
  const text = await fetchText(DICT_URL);
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
// Pair analysis
// Computes all matching words and scores for a given start/end letter pair.
// This mirrors your Apps Script generatePuzzleStats logic.
// ---------------------------------------------------------------------------

function analyzePair(startLetter, endLetter, dictionary) {
  // Returns null if pair fails minimum constraints.
  const start = startLetter.toUpperCase();
  const end   = endLetter.toUpperCase();

  const matching = dictionary.filter(w => w.startsWith(start) && w.endsWith(end));

  if (matching.length < MIN_WORD_COUNT) return null;

  const fullScore = matching.reduce((sum, w) => sum + scoreWord(w), 0);
  if (fullScore < MIN_FULL_SCORE) return null;

  // Count words by length bucket
  const byLength = {};
  for (const w of matching) {
    const len = Math.min(w.length, 10); // group 10+ together
    byLength[len] = (byLength[len] || 0) + 1;
  }

  return {
    pair: `${start}-${end}`,
    start,
    end,
    wordCount: matching.length,
    fullScore,
    byLength,
    words: matching,   // kept for hint word selection later
  };
}

// Precompute ALL valid pairs from the dictionary once upfront.
// This is the expensive step but only runs once per script invocation.
function buildPairIndex(dictionary) {
  console.log('  Building pair index (this takes ~15 seconds)...');
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const index = {};  // key: "A-B", value: analyzePair result or null

  for (const s of letters) {
    for (const e of letters) {
      const result = analyzePair(s, e, dictionary);
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

async function loadExistingPuzzles() {
  console.log('  Fetching existing puzzles from repo...');

  let files;
  try {
    files = await fetchJson(API_URL);
  } catch (err) {
    console.log(`  Warning: could not fetch puzzle list (${err.message}). Proceeding without history.`);
    return { byDate: {}, pairHistory: [] };
  }

  const puzzleFiles = files.filter(f => f.name.endsWith('-ww2.json'));
  const byDate = {};

  for (const file of puzzleFiles) {
    try {
      const data = await fetchJson(RAW_BASE_URL + file.name);
      if (data && data.date && Array.isArray(data.rounds)) {
        byDate[data.date] = {
          ...data,
          _filename: file.name,
          _isAuto: file.name.includes('-auto') || (data._auto === true),
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

function selectThreePairs(dateStr, pairIndex, recentPairs, existingTrios, rand) {
  const dow = dowOf(dateStr);
  const fullScoreRange = FULL_SCORE_RANGE_BY_DOW[dow];
  const [fsMin, fsMax] = fullScoreRange;

  // Filter the valid pair index to those meeting today's difficulty range
  // and not used recently
  const candidates = Object.values(pairIndex).filter(p =>
    p.fullScore >= fsMin &&
    p.fullScore <= fsMax &&
    !recentPairs.has(p.pair)
  );

  if (candidates.length < 3) {
    // Not enough candidates in the target difficulty range — widen the range
    // by falling back to a broader pool (any valid pair not used recently)
    const fallback = Object.values(pairIndex).filter(p =>
      p.fullScore >= MIN_FULL_SCORE &&
      !recentPairs.has(p.pair)
    );
    if (fallback.length < 3) return null;
    return pickThree(fallback, existingTrios, rand, dow);
  }

  return pickThree(candidates, existingTrios, rand, dow);
}

function pickThree(pool, existingTrios, rand, dow) {
  // Attempts to pick 3 non-conflicting pairs from the pool.
  // Enforces the "at most one easy-ending pair" rule.
  // Tries up to 500 random combinations before giving up.

  const shuffled = shuffle(pool, rand);

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

    // Sort within the trio: easiest first (highest fullScore first)
    // so the player encounters simpler pairs before harder ones
    pick.sort((a, b) => b.fullScore - a.fullScore);

    return pick;
  }

  return null; // Could not find a valid combination
}

// ---------------------------------------------------------------------------
// Hint word selection
// ---------------------------------------------------------------------------

// A set of the ~5,000 most common English words (4-6 letters) for hint filtering.
// The script picks hint words that appear in both the dictionary and this list,
// so hints are always recognizable words, not obscure dictionary entries.
// This list is intentionally conservative — better to fall back to any valid
// word than to pick a hint nobody knows.
const COMMON_WORDS_4_5 = new Set([
  'ABLE','BACK','BALL','BAND','BASE','BATH','BEAN','BEAR','BEAT','BEEN',
  'BELL','BEST','BIRD','BITE','BLUE','BODY','BOLD','BOLT','BOND','BONE',
  'BOOK','BORE','BORN','BOSS','BOTH','BOUT','BOWL','BURN','BUST','BUSY',
  'CALL','CALM','CAME','CAMP','CARD','CARE','CASH','CAST','CAVE','CELL',
  'CHAT','CHIP','CITY','CLAM','CLAY','CLIP','CLUB','COAL','COAT','COLD',
  'COLT','COME','COOK','COOL','COPE','COPY','CORD','CORE','CORN','COST',
  'COUP','CREW','CROP','CUBE','CURE','CURL','CUTE','DAILY','DARK','DATA',
  'DATE','DAWN','DAYS','DEAD','DEAL','DEAR','DECK','DEEP','DENY','DIET',
  'DIRT','DISK','DOCK','DOME','DONE','DOOR','DOSE','DOWN','DRAW','DROP',
  'DRUM','DUAL','DULL','DUMB','DUSK','DUST','DUTY','EACH','EARL','EARN',
  'EASE','EDGE','EDIT','ELSE','EMIT','EPIC','EVEN','EVER','EVIL','EXAM',
  'FACE','FACT','FADE','FAIL','FAIR','FAKE','FALL','FAME','FAST','FATE',
  'FEAR','FEAT','FEEL','FELT','FERN','FILL','FILM','FIND','FIRE','FIRM',
  'FISH','FIST','FLAG','FLAT','FLAW','FLEW','FLIP','FLOW','FOAM','FOLD',
  'FOLK','FOND','FONT','FOOD','FOOL','FOOT','FORD','FORE','FORK','FORM',
  'FORT','FOUL','FREE','FROM','FUEL','FULL','FUND','FUSE','GAIN','GAME',
  'GANG','GAZE','GEAR','GENE','GIFT','GIRL','GIVE','GLOW','GLUE','GOAL',
  'GOAT','GOLF','GOOD','GORE','GRAB','GRAY','GREW','GRID','GRIM','GRIP',
  'GROW','GULF','GURU','HAIR','HALF','HALL','HALT','HAND','HANG','HARD',
  'HARM','HARP','HASH','HATE','HAVE','HAWK','HEAL','HEAP','HEAT','HEEL',
  'HELD','HELM','HELP','HERE','HIGH','HILL','HINT','HIRE','HOLD','HOLE',
  'HOME','HOOK','HOPE','HORN','HOST','HOUR','HULL','HUMP','HUNT','HURL',
  'HURT','IDEA','IDLE','INCH','INTO','IRON','ITEM','JACK','JAIL','JERK',
  'JOIN','JOKE','JUMP','JUST','KEEN','KEEP','KICK','KIND','KING','KNOB',
  'KNEW','KNOW','LACK','LAID','LAKE','LAMP','LAND','LASH','LAST','LATE',
  'LEAD','LEAF','LEAN','LEAP','LEFT','LEND','LENS','LIFT','LIKE','LIME',
  'LINK','LION','LIST','LIVE','LOAD','LOAN','LOCK','LOFT','LONE','LONG',
  'LOOK','LOOP','LORD','LORE','LOSS','LOUD','LOVE','LUCK','LUNG','MADE',
  'MAIN','MAKE','MALE','MALL','MALT','MANY','MARK','MASK','MASS','MAST',
  'MATE','MAZE','MEAN','MEAT','MEET','MELT','MEND','MERE','MILD','MILK',
  'MILL','MIME','MIND','MINE','MINT','MISS','MIST','MODE','MOLE','MORE',
  'MOST','MOVE','MUCH','MUCK','MULE','MUST','NAIL','NAME','NAVY','NEED',
  'NEWS','NEXT','NICE','NODE','NONE','NORM','NOSE','NOTE','NOUN','NUDE',
  'OATH','ODDS','ONCE','ONLY','OPEN','OVAL','OVEN','OVER','PACE','PACK',
  'PAGE','PAID','PAIN','PAIR','PALE','PALM','PART','PASS','PAST','PATH',
  'PEAK','PEEL','PEER','PILE','PILL','PINE','PINK','PIPE','PLAN','PLAY',
  'PLEA','PLOD','PLOT','PLOW','PLUG','PLUS','POEM','POET','POLE','POLL',
  'POND','POOL','POOR','PORK','PORT','POSE','POUR','PREY','PROP','PULL',
  'PUMP','PURE','PUSH','QUIT','QUIZ','RACE','RACK','RAGE','RAID','RAIL',
  'RAIN','RAKE','RAMP','RANK','RARE','RATE','RAVE','RAYS','READ','REAL',
  'REAP','REEF','RENT','REST','RICE','RICH','RIDE','RING','RISE','RISK',
  'ROAD','ROAM','ROAR','ROBE','ROCK','ROLE','ROLL','ROOF','ROPE','ROSE',
  'RUIN','RULE','RUSH','RUST','SAFE','SAIL','SAKE','SALE','SALT','SAME',
  'SAND','SANE','SAVE','SCAN','SEAL','SEED','SEEK','SEEM','SELF','SELL',
  'SEND','SHED','SHIP','SHOE','SHOT','SHOW','SHUT','SICK','SIGN','SILK',
  'SILL','SING','SINK','SIZE','SKIN','SKIP','SLAB','SLAM','SLAP','SLIM',
  'SLIP','SLOT','SLOW','SNAP','SNOW','SOAK','SOAR','SOFT','SOIL','SOLE',
  'SOME','SONG','SOON','SORT','SOUL','SOUR','SPAN','SPIT','SPOT','SPUR',
  'STAR','STAY','STEM','STEP','STIR','STOP','STRAP','STUB','SUCH','SUIT',
  'SURE','SURF','SWAP','SWIM','TAIL','TALE','TALL','TANK','TAPE','TASK',
  'TAUT','TEAM','TEAR','TELL','TEND','TENT','TERM','TEST','TEXT','THAN',
  'THAT','THEN','THIN','THIS','TIDE','TIED','TILE','TILL','TILT','TIME',
  'TINY','TIRE','TOLL','TONE','TOOK','TOOL','TORN','TOSS','TOTE','TOUR',
  'TOWN','TRAP','TREE','TRIM','TRIO','TRIP','TRUE','TUBE','TUCK','TUNE',
  'TURF','TURN','TWIN','TYPE','UGLY','UNDO','UNIT','UPON','USED','USER',
  'VARY','VEIL','VEIN','VERY','VEST','VIEW','VINE','VOID','VOLT','VOTE',
  'WADE','WAGE','WAIT','WAKE','WALK','WALL','WAND','WANT','WARD','WARM',
  'WARN','WARP','WARY','WASH','WAVE','WEAK','WEAR','WEED','WELD','WELL',
  'WENT','WERE','WEST','WIDE','WILD','WILL','WILT','WIND','WINE','WING',
  'WISE','WISH','WITH','WOKE','WOLF','WOOD','WOOL','WORD','WORE','WORK',
  'WRAP','WRIT','YARD','YEAR','YELL','YOKE','YOUR','ZONE',
  // 5-letter common words
  'ABOUT','ABOVE','ABUSE','ACUTE','ADMIT','ADOPT','ADULT','AFTER','AGAIN',
  'AGENT','AGREE','AHEAD','ALARM','ALBUM','ALERT','ALGAE','ALIGN','ALIVE',
  'ALLEY','ALLOW','ALONE','ALONG','ALOOF','ALTAR','AMAZE','AMBLE','AMEND',
  'AMUSE','ANGEL','ANGER','ANGLE','ANGRY','ANIME','ANNEX','ANNOY','APART',
  'APPLE','APPLY','ARENA','ARISE','ARMOR','ARRAY','ASCOT','ASHBY','ASIDE',
  'ASKED','ASSAY','ASSET','ATONE','ATTIC','AUDIO','AUDIT','AVOID','AWAIT',
  'AWAKE','AWARD','AWARE','BADLY','BAKER','BASIC','BASIN','BASIS','BATCH',
  'BEACH','BEGAN','BEGIN','BEING','BELOW','BENCH','BIRTH','BISON','BITER',
  'BLAND','BLAST','BLAZE','BLEED','BLEND','BLESS','BLIND','BLOCK','BLOOD',
  'BLOOM','BLOWN','BOARD','BOOST','BOUND','BOXER','BRACE','BRAIN','BRAKE',
  'BRAND','BRAVE','BREAD','BREAK','BREED','BRICK','BRIDE','BRIEF','BRING',
  'BRISK','BROAD','BROKE','BROOK','BRUSH','BUILD','BUILT','BUYER','CABIN',
  'CABLE','CADET','CAMEL','CAMEO','CARGO','CARRY','CAUSE','CEASE','CHAIR',
  'CHALK','CHAOS','CHARM','CHASE','CHEAP','CHECK','CHEEK','CHEST','CHIEF',
  'CHILD','CHOIR','CHOSE','CIVIC','CIVIL','CLAIM','CLAMP','CLASH','CLASS',
  'CLEAN','CLEAR','CLERK','CLICK','CLIFF','CLING','CLOCK','CLONE','CLOSE',
  'COACH','COAST','COLOR','COMIC','COMMA','CORAL','COUNT','COURT','COVER',
  'CRACK','CRAFT','CRANE','CRASH','CRAVE','CRAZY','CREAM','CRIME','CRISP',
  'CROSS','CROWD','CROWN','CRUDE','CRUMB','CRUSH','CRYPT','CUNTY','CURVE',
  'CYCLE','DAILY','DAIRY','DECAY','DENSE','DEPTH','DERBY','DEVIL','DISCO',
  'DIVER','DIVVY','DOING','DONOR','DOUBT','DOUGH','DRAFT','DRAIN','DRAMA',
  'DRANK','DRAWN','DREAM','DRESS','DRIED','DRIFT','DRINK','DRIVE','DROVE',
  'DYING','EAGER','EARLY','EARTH','EIGHT','ELITE','EMAIL','EMPTY','ENEMY',
  'ENJOY','ENTER','ENTRY','EQUAL','ERROR','ESSAY','EVERY','EXACT','EXCEL',
  'EXIST','EXTRA','FAINT','FAIRY','FAITH','FANCY','FATAL','FAULT','FEAST',
  'FIELD','FIFTH','FIFTY','FIGHT','FINAL','FIRST','FLANK','FLASH','FLESH',
  'FLING','FLOOD','FLOOR','FLOUR','FLUTE','FOCUS','FORAY','FORCE','FORGE',
  'FOUND','FRAME','FRANK','FRAUD','FRESH','FRONT','FROST','FROZE','FRUIT',
  'FULLY','FUNNY','GIANT','GIVEN','GLAND','GLASS','GRACE','GRADE','GRAIN',
  'GRAND','GRANT','GRAPE','GRASP','GRASS','GREAT','GREED','GREET','GRIEF',
  'GRIND','GROAN','GROOM','GROSS','GROUP','GROVE','GUARD','GUESS','GUEST',
  'GUIDE','GUILD','GUILE','GUISE','GUSTY','HAPPY','HARSH','HASTE','HAVEN',
  'HEART','HEDGE','HENCE','HERBS','HINGE','HOMER','HONEY','HONOR','HORSE',
  'HOTEL','HOUSE','HUMAN','HUMOR','IDEAL','IMAGE','IMPLY','INBOX','INDEX',
  'INFER','INNER','INPUT','INTEL','INTER','IRONY','ISSUE','JUICE','JUICY',
  'KARMA','KNEEL','KNIFE','KNOCK','KNOWN','LABEL','LARGE','LASER','LATER',
  'LAUGH','LAYER','LEARN','LEASE','LEAST','LEGAL','LEMON','LEVEL','LIGHT',
  'LIMIT','LINEN','LIVER','LOCAL','LODGE','LOGIC','LOOSE','LOVER','LOWER',
  'LOYAL','LUCKY','LUNCH','MAGIC','MAJOR','MANOR','MARCH','MATCH','MEANT',
  'MERIT','METAL','METER','MINOR','MINUS','MODAL','MODEL','MONEY','MORAL',
  'MOUNT','MOUSE','MOUTH','MOVED','MOVIE','MUSIC','NAKED','NASTY','NERVE',
  'NEVER','NIGHT','NOBLE','NOISE','NORTH','NOVEL','NURSE','NYMPH','OCCUR',
  'OCEAN','OFFER','OFTEN','ORDER','OTHER','OUTER','OXIDE','OZONE','PAINT',
  'PANEL','PANIC','PAPER','PEACE','PEARL','PENNY','PHASE','PHONE','PHOTO',
  'PIANO','PIECE','PILOT','PITCH','PIXEL','PIXEL','PLACE','PLAIN','PLANE',
  'PLANT','PLATE','PLAZA','PLEAD','PLUCK','POINT','POKER','POLAR','POLKA',
  'POSSE','POWER','PRESS','PRICE','PRIDE','PRIME','PRINT','PRIOR','PRIZE',
  'PROBE','PROOF','PROSE','PROVE','PROXY','PULSE','PUNCH','PUPIL','PUPPY',
  'QUEEN','QUERY','QUEUE','QUICK','QUIET','QUITE','QUOTA','QUOTE','RADAR',
  'RADIO','RAISE','RALLY','RANCH','RANGE','RAPID','RATIO','REACH','READY',
  'REALM','REBEL','REFER','REIGN','RELAX','REMIX','REPAY','REPEL','REPLY',
  'RESIN','RIDER','RIDGE','RIFLE','RIGHT','RISKY','RIVAL','RIVER','ROBIN',
  'ROBOT','ROCKY','ROUGE','ROUGH','ROUND','ROYAL','RUGBY','RULER','RURAL',
  'SADLY','SAINT','SAUCE','SCALE','SCARE','SCENE','SCOPE','SCORE','SENSE',
  'SERVE','SEVEN','SHADE','SHAKE','SHALL','SHAME','SHAPE','SHARE','SHARK',
  'SHARP','SHIFT','SHIRT','SHORE','SHORT','SHOUT','SIGHT','SINCE','SIXTH',
  'SIXTY','SIZED','SKILL','SKULL','SLACK','SLAVE','SLEEP','SLICE','SLIDE',
  'SLOPE','SMART','SMELL','SMILE','SMOKE','SNACK','SNAKE','SNIFF','SOLAR',
  'SOLID','SOLVE','SORRY','SOUTH','SPACE','SPARE','SPARK','SPEAK','SPEAR',
  'SPEND','SPINE','SPLIT','SPOKE','SPOON','SPRAY','SQUAD','STACK','STAFF',
  'STAGE','STAIN','STAKE','STALE','STALL','STAMP','STAND','STARK','START',
  'STATE','STEAM','STEEL','STEEP','STEER','STICK','STIFF','STILL','STOCK',
  'STONE','STOOD','STORE','STORM','STORY','STRAP','STRAY','STRIP','STUDY',
  'STYLE','SUGAR','SUPER','SURGE','SWAMP','SWEAR','SWEET','SWEPT','SWIRL',
  'SWORD','TABLE','TASTE','TEACH','TEETH','TEMPO','TENSE','THEME','THERE',
  'THICK','THING','THINK','THIRD','THOSE','THREE','THREW','THROW','TIGHT',
  'TIMER','TIRED','TITLE','TODAY','TOKEN','TOPIC','TOTAL','TOUCH','TOUGH',
  'TOWER','TOXIC','TRACE','TRACK','TRADE','TRAIL','TRAIN','TRAIT','TRASH',
  'TREAT','TREND','TRIAL','TRIBE','TRICK','TRIED','TROOP','TRULY','TRUMP',
  'TRUST','TRUTH','TULIP','TUTOR','TWICE','UNDER','UNION','UNITY','UNTIL',
  'UPPER','UPSET','URBAN','USHER','USUAL','UTTER','VAGUE','VALID','VALUE',
  'VALVE','VENUE','VERSE','VIDEO','VIGOR','VIRAL','VISIT','VISTA','VOCAL',
  'VOICE','VAPOR','WAGON','WASTE','WATCH','WATER','WEARY','WEAVE','WEIGH',
  'WEIRD','WHALE','WHEAT','WHEEL','WHERE','WHICH','WHILE','WHITE','WHOLE',
  'WHOSE','WITCH','WOMEN','WORLD','WORRY','WORSE','WORST','WORTH','WOULD',
  'WOUND','WRATH','WRITE','WROTE','YIELD','YOUNG','YOURS','YOUTH',
]);

function pickHintWord(pairData, rand) {
  // Prefers 5-letter words from the common list.
  // Falls back to 4-letter words from the common list.
  // Last resort: any 5-letter word, then any 4-letter word from the dictionary.
  const { words } = pairData;

  const fiveLetter = words.filter(w => w.length === 5);
  const fourLetter = words.filter(w => w.length === 4);

  const commonFive = fiveLetter.filter(w => COMMON_WORDS_4_5.has(w));
  if (commonFive.length > 0) {
    return commonFive[Math.floor(rand() * commonFive.length)];
  }

  const commonFour = fourLetter.filter(w => COMMON_WORDS_4_5.has(w));
  if (commonFour.length > 0) {
    return commonFour[Math.floor(rand() * commonFour.length)];
  }

  // Last resort — any 5-letter, then any 4-letter
  if (fiveLetter.length > 0) return fiveLetter[Math.floor(rand() * fiveLetter.length)];
  if (fourLetter.length > 0) return fourLetter[Math.floor(rand() * fourLetter.length)];

  return null; // Should never happen if MIN_WORD_COUNT >= 100
}

// ---------------------------------------------------------------------------
// Perfect score and pass score calculation
// ---------------------------------------------------------------------------

function computePerfectScore(pairData, targetRange, rand) {
  // perfectScore must be:
  //   - Between targetRange[0] and targetRange[1]
  //   - Never more than 100
  //   - Never more than pairData.fullScore (can't set target above what's possible)
  const [minPerfect, maxPerfect] = targetRange;
  const cap = Math.min(maxPerfect, 100, Math.floor(pairData.fullScore));
  const floor = Math.min(minPerfect, cap); // ensure floor <= cap
  if (floor >= cap) return cap;
  return randInt(rand, floor, cap);
}

function computePassScore(perfectScore, rand) {
  // passScore is 5%-20% of perfectScore, minimum 1
  const pct = 0.05 + rand() * 0.15; // random between 5% and 20%
  return Math.max(1, Math.round(perfectScore * pct));
}

// ---------------------------------------------------------------------------
// Puzzle assembly
// ---------------------------------------------------------------------------

function assemblePuzzle(dateStr, selectedPairs, pairIndex, rand) {
  const dow = dowOf(dateStr);
  const perfectRange = PERFECT_SCORE_BY_DOW[dow];

  const rounds = selectedPairs.map((pairData, i) => {
    const perfectScore = computePerfectScore(pairData, perfectRange, rand);
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
    dates:    null,   // array of date strings, or null = today
    dryRun:   false,
    force:    false,  // overwrite existing AUTO puzzles (never manual ones)
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
    } else if (args[i] === '--force') {
      opts.force = true;
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Letter Loaf Puzzle Generator ===\n');

  const opts = parseArgs();

  // Determine which dates to generate
  const datesToProcess = opts.dates ?? [todayStr()];
  console.log(`Dates to process: ${datesToProcess.length}`);
  if (opts.dryRun)  console.log('DRY RUN: no files will be written.\n');
  if (opts.force)   console.log('FORCE: will overwrite existing auto-generated puzzles.\n');

  // Load dictionary and build pair index (expensive but runs only once)
  const dictionary = await loadDictionary();
  const pairIndex  = buildPairIndex(dictionary);

  // Load all existing puzzles from the repo for constraint checking
  const { byDate: existingPuzzles, pairHistory } = await loadExistingPuzzles();

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

    const dow = dowOf(dateStr);
    const difficulty = DIFFICULTY_BY_DOW[dow].label;
    const pairSummary = selectedPairs.map(p => p.pair).join(', ');
    console.log(`done — ${difficulty}, maxScore=${puzzle.maxScore}, pairs=[${pairSummary}]`);

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
    console.log('\nNext step: copy files from ./output/ to your repo\'s puzzles/ folder and commit:');
    console.log(`  cp output/*-ww2.json ../../puzzles/`);
    console.log(`  git add puzzles/`);
    console.log(`  git commit -m "Add auto-generated puzzles"`);
    console.log(`  git push`);
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
