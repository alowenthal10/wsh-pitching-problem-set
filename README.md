# Pitcher Pages: BPE problem set

**Live site:** https://alowenthal10.github.io/wsh-pitching-problem-set/

A league pitching leaderboard plus a page for every qualified pitcher. Pitchers are graded on the 20–80 scale by Stuff, Location, and Pitching models, built on real Statcast data and refreshed daily.

| Deliverable | Where |
|---|---|
| 1. Mockup, now a working site | [Live site](https://alowenthal10.github.io/wsh-pitching-problem-set/) · source in [`mockup/`](mockup/) |
| 2. Product Requirements Document | [`docs/PRD.md`](docs/PRD.md) |
| 3. Decisions, assumptions, and AI use | [`docs/SUMMARY.md`](docs/SUMMARY.md) |

## The site
- **Leaderboard** (site root): every pitcher with 50+ pitches; the default view shows 300+. Columns are Pitching, Stuff, and Location grades, IP, ERA, model-expected ERA, and best pitch. Filter by team, role, minimum pitches, and season (2025–2026). The Nationals are highlighted, and filters are kept in the URL.
- **Pitcher pages** at clean URLs, e.g. [`/cade-cavalli/`](https://alowenthal10.github.io/wsh-pitching-problem-set/cade-cavalli/). Search is available from the header on every page. Each page has:
  - **Summary:** three grades with reliability bands, a role label, and a written bottom line.
  - **Arsenal:** per-pitch grades, shape, and results.
  - **Pitch Lab:** reshape a pitch and re-score it with the real Stuff model in the browser. Presets come from league data.
  - **Locations:** Location-model surfaces by count and batter side, with where he actually throws the pitch.
  - **Results vs. model:** expected vs. actual ERA by season, plus graded traits the models miss.
  - **Availability & transactions:** IL history, options, and moves.
  - **Biomechanics:** release-point comparison across pitches, with a real motion-captured reference delivery.

The one placeholder, labeled on the page, is the formula that credits a persistent results gap in the results-adjusted grade. That's for R&D to own.

## Data and models

| Piece | Source |
|---|---|
| Pitch data (~710k pitches per season) | Statcast via Baseball Savant |
| Bio, rosters, transactions, IP/ERA | MLB Stats API |
| Stuff model | [tjStuff+](https://github.com/tnestico/tjstuff_plus) by Thomas Nestico (MIT), reproduced from Savant data |
| Location and Pitching models, traits, presets | This project ([`pipeline/location_model.py`](pipeline/location_model.py), [`pipeline/traits.py`](pipeline/traits.py)) |
| Reference deliveries | [Driveline OpenBiomechanics](https://github.com/drivelineresearch/openbiomechanics) (CC BY-NC-SA 4.0) |

Data © MLB Advanced Media, used for non-commercial purposes.

**Validation:**
- **Stuff model:** recomputing 2024 reproduces Nestico's published tjStuff+ at r = 0.999, with a mean difference of 0.08 points across 562 pitchers.
- **Split-half test** (fit on odd days, test on even days; pitchers with 200+ pitches in each half):

| | 2025 | 2026 |
|---|---|---|
| Stability across halves: Stuff / Location / Pitching / actual results | 0.98 / 0.63 / 0.94 / 0.23 | 0.97 / 0.70 / 0.90 / 0.13 |
| Predicts second-half run value: **Pitching** / Stuff / Location / first-half results | **0.29** / 0.27 / 0.02 / 0.23 | **0.26** / 0.24 / 0.02 / 0.13 |

## How it's built
- **Pipeline** ([`pipeline/`](pipeline/)), run daily by [GitHub Actions](.github/workflows/pages.yml):
  - download the season's Statcast data (cached by day);
  - score every pitch with tjStuff+;
  - fit the Location and Pitching models;
  - compute traits;
  - add team, role, IP, and ERA from the Stats API;
  - write one JSON file per pitcher;
  - generate a small page per pitcher;
  - deploy `mockup/` as the site root.
- **Front end** ([`mockup/`](mockup/)): Vue 3, no build step. `index.html` is the leaderboard. `player.html` plus `assets/` is the pitcher page. `model/` holds the tjStuff+ model exported to run in the browser.
- **Run locally:** after a data build, run `npx http-server mockup`, then open `/` or `player.html?id=<MLBAM id>`. Without data, the pitcher page falls back to a labeled synthetic demo.
- **Validate the Stuff model:** run the workflow manually with **validate** checked.
- **GitHub Pages:** Settings → Pages → Source must be **GitHub Actions**.
