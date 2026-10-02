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

**All Stuff, Location, and Pitching values, pitch shapes, heatmaps, Pitch Lab projections, and biomechanics in the mockup are illustrative.** They are not outputs of any real model.

## Page tour

- **Summary:** Pitching, Stuff, and Location grades (20–80) with reliability bands, role label, results-adjusted grade, and a written bottom line.
- **Arsenal:** per-pitch grades, shape, and results. Selecting a pitch drives the rest of the page.
- **Pitch Lab:** grip presets and sliders projecting Stuff-grade changes, shown on a Stuff surface with an achievable-shape envelope.
- **Locations:** Location-model surfaces by count (Ahead, Even, Behind), with the pitcher's actual location contours, plus a raw-binned toggle for comparison.
- **Results vs. model:** expected vs. actual ERA by season, a persistent over/under-performer flag, and traits the models don't capture.
- **Biomechanics:** slot for the Baseball Sciences skeletal viewer, with a release-metrics comparison against the four-seam.
- **Models on this page:** the registry that renders every grade, including planned and open slots.
