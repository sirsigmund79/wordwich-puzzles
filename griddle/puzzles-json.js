/**
 * Reading and writing griddle/puzzles.json, the one file the game reads every
 * Griddle puzzle from (through wordwich-game's netlify/functions/puzzles.mjs).
 *
 * Shape:
 *
 *   {
 *     "schema": 1,
 *     "days": {
 *       "2026-11-15": {
 *         "griddleNumber": 259,
 *         "puzzles": [                       // always Easy, Medium, Hard in that order
 *           {
 *             "id": 718,                     // unique forever; player progress is keyed on it
 *             "difficulty": "Easy",
 *             "solutionGrid": [["F","O","C","U","S"], ["L",null,"H",null,"N"], ...],
 *             "staticCells":  [[false,true,...], ...],   // true = pre-filled, null = hole
 *             "words": ["FOCUS", ...],       // [h1, h2, h3, v1, v2, v3]
 *             "definitions": [{ "word", "pos", "def" }],
 *             "par": 2,                      // optional, defaults by difficulty
 *             "extraLetters": "XQ"           // optional decoy letters for the bank
 *           }, ...
 *         ]
 *       }
 *     }
 *   }
 *
 * To fix a puzzle, edit it here and push: the site picks it up within minutes,
 * no build or deploy. Do not change an `id` once a day has gone live.
 */

import fs from 'fs';

export const LEVELS = ['Easy', 'Medium', 'Hard'];

export function loadPuzzleFile(file) {
  if (!fs.existsSync(file)) return { schema: 1, days: {} };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.days ??= {};
  return data;
}

/** Highest id and griddleNumber in use, so new puzzles carry on from them. */
export function lastNumbers(data) {
  let id = 0, griddleNumber = 0;
  for (const day of Object.values(data.days)) {
    griddleNumber = Math.max(griddleNumber, day.griddleNumber || 0);
    for (const p of day.puzzles) id = Math.max(id, p.id || 0);
  }
  return { id, griddleNumber };
}

/**
 * Pretty enough to review and hand-edit in a diff: one day per block, one grid
 * row per line, everything else compact.
 */
export function serializePuzzles(data) {
  const j = v => JSON.stringify(v);
  const grid = g => `[\n${g.map(r => `            ${j(r)}`).join(',\n')}\n          ]`;

  const dates = Object.keys(data.days).sort();
  const days = dates.map(date => {
    const day = data.days[date];
    const puzzles = day.puzzles.map(p => {
      const fields = Object.entries(p).map(([k, v]) =>
        `          ${j(k)}: ${k === 'solutionGrid' || k === 'staticCells' ? grid(v) : j(v)}`);
      return `        {\n${fields.join(',\n')}\n        }`;
    });
    return `    ${j(date)}: {\n      "griddleNumber": ${j(day.griddleNumber)},\n      "puzzles": [\n${puzzles.join(',\n')}\n      ]\n    }`;
  });

  return `{\n  "schema": ${j(data.schema ?? 1)},\n  "days": {\n${days.join(',\n')}\n  }\n}\n`;
}

export function savePuzzleFile(file, data) {
  fs.writeFileSync(file, serializePuzzles(data));
}

/** [h1, h2, h3, v1, v2, v3] read straight off a solution grid. */
export function wordsFromGrid(grid) {
  const row = r => grid[r].join('');
  const col = c => grid.map(r => r[c]).join('');
  return [row(0), row(2), row(4), col(0), col(2), col(4)];
}
