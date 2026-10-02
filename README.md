# Pitcher Page: BPE problem set

**Live mockup:** https://alowenthal10.github.io/wsh-pitching-problem-set/mockup/

| Deliverable | File |
|---|---|
| 1. Mockup | [`mockup/index.html`](mockup/index.html): open it in a browser. No build step. |
| 2. Product Requirements Document | [`docs/PRD.md`](docs/PRD.md) |
| 3. Decisions, assumptions, and AI use | [`docs/SUMMARY.md`](docs/SUMMARY.md) |

## Running the mockup

Open `mockup/index.html` directly, or serve the folder:

```sh
npx http-server mockup -p 8080   # or: python3 -m http.server -d mockup 8080
```

The page loads Vue 3 and fonts from public CDNs. Bio, roster, and season results come from the MLB Stats API, called from your browser. If that API can't be reached, the page shows a synthetic demo pitcher instead.

### What's real
- **MLB Stats API** (live, in the browser): bio, teams, rosters, transactions, season results.
- **Statcast + tjStuff+** (built by GitHub Actions): every pitcher's pitch types, usage, velocity, movement, spin, extension, arm angle, whiff%, xwOBA, location spread, and Stuff grades. Scored with [tjStuff+](https://github.com/tnestico/tjstuff_plus) by Thomas Nestico (MIT License). Pitch Lab runs the same model in the browser.
- **This project's Location and Pitching models** ([`pipeline/location_model.py`](pipeline/location_model.py)), fit on the same Statcast data: Location and Pitching grades, the location heatmaps, and model-expected ERA for the current and previous season.

- **Traits, release metrics, and pitch-design presets** ([`pipeline/traits.py`](pipeline/traits.py)), from the same Statcast data: perceived velocity, fastball approach angle versus expected, release-point consistency, times-through-the-order penalty, arm-angle tell risk, per-pitch release metrics, and seam-shifted wake (measured spin axis versus actual movement, calibrated on four-seamers). Pitch Lab presets are the shape of the league's top-quarter pitches from similar arm angles and the league's top-quarter seam effect.
- **Reference deliveries** ([`pipeline/obp_reference.py`](pipeline/obp_reference.py)): real motion capture from [Driveline's OpenBiomechanics Project](https://github.com/drivelineresearch/openbiomechanics) (CC BY-NC-SA 4.0), matched to the pitcher's throwing hand and arm angle. It is a reference delivery, not the pitcher's own motion; the page says so.

Still a placeholder, and tagged on the page: the formula that credits a persistent results gap in the results-adjusted grade, which R&D should own.

### Data pipeline
`pipeline/location_model.py` builds the Location model (smoothed run value by spot, for each pitch type, count state, and batter side; the smoothing width is chosen out of sample) and the Pitching model (a least-squares blend of Stuff and Location fit to actual run value, with Location's weight set by out-of-sample prediction), and runs a split-half check of both. `pipeline/build_stuff.py` downloads the season's Statcast pitches from Baseball Savant (cached by day), scores every pitch with tjStuff+ exactly as its notebook does, and writes one JSON file per pitcher to `mockup/data/stuff/<season>/`. `pipeline/export_model.py` converts the tjStuff+ model to `mockup/model/tjstuff_v3.json` for the browser; `mockup/model/tjstuff.js` evaluates it (checked against Python to within 0.0001 tjStuff+ points).

`.github/workflows/pages.yml` runs the pipeline daily during the season and on every push, then deploys the site. **Settings → Pages → Source must be set to "GitHub Actions."** Run the workflow manually with **validate** checked to recompute 2024 and compare against Nestico's published 2024 leaderboard. **Result (Oct 2, 2026): r = 0.999 and a mean absolute difference of 0.08 tjStuff+ points across 562 pitchers with 300+ pitches**, so the Savant-based pipeline reproduces the published model.

**Split-half check** (fit on odd days, test on even days; pitchers with 200+ pitches in each half):

| | 2025 (465 pitchers) | 2026 (461 pitchers) |
|---|---|---|
| Stability, first half vs second half: Stuff / Location / Pitching / actual run value | 0.98 / 0.63 / 0.94 / 0.23 | 0.97 / 0.70 / 0.90 / 0.13 |
| Predicts second-half run value: **Pitching** / Stuff / Location / first-half results | **0.29** / 0.27 / 0.02 / 0.23 | **0.26** / 0.24 / 0.02 / 0.13 |
| Location smoothing width chosen | 0.3 ft | 0.3 ft |
| Location weight in the Pitching blend | 30% of fitted | 40% of fitted |

Data © MLB Advanced Media, used for non-commercial purposes.

## Page tour

- **Summary:** Pitching, Stuff, and Location grades (20–80) with reliability bands, role label, results-adjusted grade, and a written bottom line.
- **Arsenal:** per-pitch grades, shape, and results. Selecting a pitch drives the rest of the page.
- **Pitch Lab:** grip presets and sliders projecting Stuff-grade changes, shown on a Stuff surface with an achievable-shape envelope.
- **Locations:** Location-model surfaces by count (Ahead, Even, Behind), with the pitcher's actual location contours, plus a raw-binned toggle for comparison.
- **Results vs. model:** expected vs. actual ERA by season, a persistent over/under-performer flag, and traits the models don't capture.
- **Availability & transactions:** real IL history (stints and days missed), options, recalls, trades, and signings, with a timeline and a filterable log.
- **Biomechanics:** slot for the Baseball Sciences skeletal viewer, with a release-metrics comparison against the four-seam.
- **Models on this page:** the registry that renders every grade, including planned and open slots.
