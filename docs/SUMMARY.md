# Summary: decisions, assumptions, and AI use

## What I built

1. **Mockup** ([`mockup/index.html`](../mockup/index.html)): a working pitcher page in Vue 3, the Nationals' front-end framework. It loads real teams, active rosters, bios, and season results from the MLB Stats API. It opens on the Nationals and Cade Cavalli. Changing the Team dropdown reloads the Pitcher dropdown with that team's MLB roster. All model outputs (Stuff, Location, Pitching, Pitch Lab, heatmaps, biomechanics) are illustrative and generated for the mockup. If the API can't be reached, the page switches to a synthetic demo pitcher so no real name ever appears next to invented results.
2. **PRD** ([`PRD.md`](PRD.md)): scope, requirements with priorities, technical design for Rails and Vue, handoffs between R&D, BPE, Baseball Systems, and Baseball Sciences, and a phased roadmap.

## Key decisions

**The page leads with a verdict.** The GM asked for "opinionated." The biggest element on the page is the Pitching grade, with a role label (e.g. "No. 3 starter") and a written bottom line of three or four items. Each item links to its evidence. The order of sections below it follows decision value: arsenal, then the fix (Pitch Lab), then command, then results context, then biomechanics.

**Grades only, with reliability on every grade.** I dropped percentiles entirely and kept the raw plus value on hover. A risk of 20–80 grades is that a 60 on 150 pitches looks the same as a 60 on 2,500. So every grade carries an uncertainty band, and grades below the model's stabilization point get a dashed outline. Using different stabilization points for each model (Stuff stabilizes much faster than Location) is what makes this useful. It tells you to trust the changeup's Stuff grade but not yet its Location grade.

**Fix splotchy heatmaps at the source.** Heatmaps look splotchy because they average noisy pitch outcomes into bins. But we have a model, so we don't need to average anything. The page evaluates the Location model on a fine grid and bands it into 5-grade steps. The pitcher's actual tendencies are drawn on top as contours, so the gap between "where it's valuable" and "where he throws it" is the main thing you see. I show three counts side by side because the primer's Location model is count-specific, and that is where the picture changes most. A "raw binned" toggle shows the problem this solves.

**Pitch Lab: what the Stuff model can answer, and what it can't.** Changing velocity and movement is plain inference on the existing Stuff model, so it's in scope for Phase 2. Grip and seam orientation are not Stuff model inputs. Answering those questions needs a seam-to-movement model, which belongs to Baseball Sciences and R&D. I designed the preset UI so it works now with hand-entered deltas and switches to model predictions later. I also added an "achievable" envelope, because a projection is only useful if the pitcher can actually throw that shape.

**Over/under-performers get their own section.** This was the most important ambiguous note. Pitch-level models leave out things like extension, approach angle, sequencing, and tipping. The page shows several seasons of model-expected ERA against actual ERA and FIP. It flags a persistent gap, and it offers a results-adjusted grade that gives partial credit by innings and consistency. The candidate causes are listed as graded traits, and each one is a slot for a future model. The formula in the mockup is a placeholder, and R&D should own the real one.

**A transaction log for baseball ops.** I added an availability and transactions section built entirely on real MLB Stats API data. It pairs IL placements with activations to count stints and days missed, flags an open IL stint, and shows options, recalls, trades, and signings on a timeline and in a filterable log. Injury history changes how a grade drop should be read, and whether a grip change is worth trying right now. Options remaining and service time need the club's internal roster system. The public feed can only count seasons with an option, so the page labels that number as a count.

**Biomechanics: embed, don't rebuild.** Baseball Sciences already has a viewer. The PRD specifies a web-component contract (two pitch IDs plus a phase) and the page provides the slot. My stand-in links the viewer to a release-metrics table that flags a possible tell, which ties biomechanics back to a pitching decision.

**Extensibility through a registry.** Every grade renders from a model registry entry (key, version, scale, SD, stabilization point). Outputs are stored in a long-format table. Adding a model means a registry row, data, and one line of config, with no new front-end code. The "Models on this page" section shows this, including a planned model and an open slot.

**"Like Savant, but better."** I read this as: Savant describes, this page recommends. Concretely that means grades instead of percentiles, a written conclusion, count-based small multiples, reliability on every number, and one pitch selection that drives the whole page.

## Real data (added after the first draft)
After the mockup was hosted, I replaced the mock Stuff layer with real data and an open-source model:
- **tjStuff+** by Thomas Nestico (MIT License) is the Stuff model. A GitHub Action downloads the season's Statcast pitches from Baseball Savant, scores each pitch exactly as the tjStuff+ notebook does, and publishes one small file per pitcher.
- Savant names its columns differently from the MLB Gameday feed the model was trained on. The release position at 50 ft isn't in Savant's export, so the pipeline recovers it exactly from the trajectory fit. A validation mode recomputes 2024 and compares against the published tjStuff+ leaderboard: r = 0.999 with a mean absolute difference of 0.08 points across 562 pitchers.
- Pitch Lab runs the real model in the browser. Sliders re-score a sample of the pitcher's actual pitches. Changing the fastball re-scores every pitch, since the model grades secondaries against the fastball.
- I then built the Location and Pitching models myself on the same data. Location is the smoothed run value of each spot for each pitch type, count state, and batter side, relative to an average location in that situation; the smoothing width is chosen by fitting on odd days and testing on even days. Pitching is a least-squares blend of the Stuff and Location predictions fit to actual run value, so its output is in runs and gives a model-expected ERA. The first real run showed Location is a stable skill (split-half r ≈ 0.65) but barely predicts future run value (r ≈ 0.02), so the full-weight blend predicted worse than Stuff alone. Location's weight in the blend is now chosen by out-of-sample prediction (30–40% of the fitted value). With that change, Pitching predicts a pitcher's second-half run value better than Stuff alone (r = 0.29 vs 0.27 in 2025, 0.26 vs 0.24 in 2026), and both beat the pitcher's own first-half results (0.23 and 0.13). That last comparison is the case for putting model grades ahead of results on the page. A split-half check reports how stable each grade is and how well each predicts second-half run value.
- What remains mock is tagged on the page: grip presets, the results-adjusted crediting formula, the unmodeled-traits list, and biomechanics.

## Deprioritized
- Percentiles (GM preference). The API still returns raw values, so they could come back as a toggle.
- Grip and seam-orientation modeling (Phase 3, owned by partners).
- Skeletal viewer build (embed only). Hitter and team pages, live in-game views.

## Assumptions
- The internal models work like the FanGraphs primer describes. Stuff uses physical traits and differences from the primary fastball. Location is specific to pitch type, count, and platoon. Pitching combines both.
- Grade SDs (Stuff 10 at pitcher level and 18 at pitch level, Location 4 and 8, Pitching 5 and 9) and stabilization points (about 80, 400, and 250 pitches) are placeholders for R&D to replace.
- Model-expected ERA is a linear map from Pitching+. R&D would choose the real estimator.
- The Location model doesn't depend on the pitcher, so surfaces can be computed once per model version. This is flagged as an open question in the PRD.
- Rails is the only API the browser calls in production. MLB Stats API data is pulled on a schedule and cached, not called live.

## How I used AI

I used Claude (Anthropic's Claude Code agent) throughout, and I am responsible for the result.

- **Reading and planning:** Claude parsed the problem set, proposed how to prioritize each stakeholder note, and drafted the page structure. I reviewed and adjusted the priorities.
- **Code:** Claude wrote the mockup: the Vue app, canvas heatmap and Stuff-surface rendering, the synthetic models that stand in for the real ones, and the MLB Stats API adapter with a fallback. It tested the page in headless Chromium at desktop and phone widths, in light and dark themes, and against a mocked API response for the live-data path.
- **PRD and this summary:** Claude drafted both from the decisions above. I edited them for accuracy and tone.
- **What I checked myself:** the baseball logic (grade conventions, role labels, which pitches and counts matter), whether the synthetic numbers are plausible, and that nothing presents invented numbers as real model output.

<!-- Edit the "How I used AI" section so it reflects exactly what you did versus what the AI did. -->
