# Whisker — Puzzle Config

Whisker is a daily crossword-fill word game at [letter-loaf.com](https://letter-loaf.com).
The game fetches this config at startup to get its daily puzzle layout and tile distribution.

## How the game uses this config

At startup, `Whisker.vue` fetches:

```
https://raw.githubusercontent.com/sirsigmund79/wordwich-puzzles/main/whisker/whisker_config.json
```

Priority order for puzzle selection:

1. `config.custom_puzzles["YYYY-MM-DD"]` — hand-authored override for a specific date
2. `config.algorithm` — seeded generation using layout templates + tile distribution
3. Hardcoded emergency fallback shapes built into the game (if fetch fails entirely)

The PRNG is seeded from the date (`YYYYMMDD` as integer), so a given date always produces
the same puzzle. Adding or reordering templates reshuffles all past dates — use
`custom_puzzles` to pin specific dates if stability matters.

---

## Config schema

```jsonc
{
  "version": 1,
  "algorithm": {
    "layout_templates": [ /* LayoutTemplate[] */ ],
    "tile_distribution": { "A": 9, "B": 2, /* ... */ }
  },
  "custom_puzzles": {
    "YYYY-MM-DD": {
      "layout": /* LayoutTemplate */,
      "tiles": [ { "id": 0, "letter": "A", "points": 1 }, /* ... */ ],
      "maxScore": 80
    }
  }
}
```

### LayoutTemplate

```jsonc
{
  "name": "plus",
  "dimensions": { "cols": 5, "rows": 7 },
  "cells": [
    { "x": 0, "y": 2, "multiplier": 2 },
    { "x": 1, "y": 2, "multiplier": 1 }
  ]
}
```

- `x` / `y`: zero-based column/row index
- `multiplier`: integer ≥ 1. Score for a cell = `tile_points × multiplier`
- Teal highlight = ×2, yellow highlight = ×3

### Layout design rules

| Rule | Requirement |
|------|-------------|
| Word slots | Every cell must be in at least one horizontal or vertical run of ≥ 2 consecutive cells |
| Intersections | At least one cell should be shared between a horizontal and vertical run |
| Grid size | ≤ 10 × 10 (mobile renders at 320px max width) |
| Cell count | 8–25 active cells |
| Multipliers | ~70–80% at ×1, ~15–20% at ×2, ~5–10% at ×3; avoid ×4+ in standard templates |

### Tile point values (Scrabble)

```
A=1  B=3  C=3  D=2  E=1  F=4  G=2  H=4  I=1  J=8  K=5  L=1  M=3
N=1  O=1  P=3  Q=10 R=1  S=1  T=1  U=1  V=4  W=4  X=8  Y=4  Z=10
```

---

## Adding a new layout template

1. Add an entry to `algorithm.layout_templates` in `whisker_config.json`
2. Run `node validate.js` to check for errors
3. Run `node preview.js` (or `node preview.js YYYY-MM-DD`) to see what it looks like

Note: adding a template reshuffles which template is selected for every date. If you want
a specific date to keep its current puzzle, add it as a `custom_puzzle` before pushing.

---

## Authoring a custom puzzle

Custom puzzles override seeded generation for a specific date. They're useful for
holidays, themed puzzles, or when you want guaranteed solvability.

1. Design a layout (or reuse one from `layout_templates`)
2. Choose exactly one tile per active cell
3. Calculate `maxScore` = sum of `(tile.points × cell.multiplier)` for the optimal
   tile-to-cell pairing (pair highest-value tiles with highest-multiplier cells)
4. Add to `custom_puzzles`:

```jsonc
"custom_puzzles": {
  "2025-12-25": {
    "layout": {
      "name": "xmas-tree",
      "dimensions": { "cols": 5, "rows": 7 },
      "cells": [
        { "x": 2, "y": 0, "multiplier": 3 },
        { "x": 1, "y": 1, "multiplier": 1 },
        { "x": 2, "y": 1, "multiplier": 1 },
        { "x": 3, "y": 1, "multiplier": 1 }
      ]
    },
    "tiles": [
      { "id": 0, "letter": "S", "points": 1 },
      { "id": 1, "letter": "T", "points": 1 },
      { "id": 2, "letter": "A", "points": 1 },
      { "id": 3, "letter": "R", "points": 1 }
    ],
    "maxScore": 0
  }
}
```

Set `maxScore` to `0` to disable scoring for the puzzle. Run `node validate.js` — it
will report the computed optimal score alongside any warnings if `maxScore` looks off.

---

## Scripts

### validate.js

Checks every layout and custom puzzle for structural correctness.

```
node validate.js
```

Output: `✓ 8 layouts valid, 0 custom puzzles, 0 errors`
Or a list of errors with layout name and cell coordinates.

**Checks performed:**
- All cell `x`/`y` coordinates within `dimensions`
- Every cell belongs to a word slot of length ≥ 2
- No duplicate cells (same `x,y` twice)
- All multipliers are integers ≥ 1
- Tile distribution values are positive integers
- Custom puzzle tiles have the right shape (`{ id, letter, points }`)
- Custom puzzle `maxScore` is a non-negative number
- Custom puzzle tile count matches cell count

### preview.js

Renders what a player would see on a given date.

```
node preview.js              # today
node preview.js 2025-07-04   # specific date
```

Output includes:
- Which layout template was selected (or "CUSTOM PUZZLE OVERRIDE")
- ASCII grid with letters (or `□` for empty active cell, `②`/`③` for multipliers)
- Full tile bank sorted by point value
- Theoretical max score
- Par score (50% of max)
