# Summary: decisions, assumptions, and AI use

## What I built
- **A working site** (https://alowenthal10.github.io/wsh-pitching-problem-set/), with two kinds of page:
  - **Leaderboard:** every qualified pitcher in the league, with the Nationals highlighted.
  - **Pitcher pages:** one per pitcher, at a clean URL. All built in Vue 3 to match the club's stack.
- **Real data and models throughout:**
  - **Stuff:** Statcast scored with the open-source tjStuff+ model.
  - **Location and Pitching:** my own models, built on the same Statcast data.
  - **Live MLB Stats API:** bios, results and transactions.
  - **Biomechanics:** Driveline's open motion-capture data.
  - **Placeholder:** the formula that credits a results gap in the results-adjusted grade, which is R&D's call and labeled on the page.
- **A PRD** ([PRD.md](PRD.md)) that uses the prototype's results to set requirements, handoffs and the roadmap for a Rails/Vue production build.

## Key decisions
- **Lead with the verdict.** The GM asked for opinionated, so the Pitching grade, a role label and a written bottom line come first. Evidence follows in order of decision value.
- **Grades, never percentiles, always with reliability.** A 60 on 150 pitches shouldn't look like a 60 on 2,500. Every grade shows an uncertainty band, and small samples are flagged.
- **Fix splotchy heatmaps at the source.** Draw the Location model's surface instead of averaging noisy outcomes, with the smoothing width chosen by out-of-sample fit.
- **Validate everything out of sample.** Two results shaped the product:
  - Model grades predict a pitcher's second half better than his own first-half results (r 0.26–0.29 vs. 0.13–0.23). That justifies the model-first layout.
  - Location is a stable skill but barely predicts future run value. A full-weight blend made the Pitching model worse, so its weight is now chosen out of sample. The PRD makes this a requirement for every model.
- **Pitch Lab answers what the Stuff model can.** Movement and velocity changes run the real model. Grip and seam questions need a model that doesn't exist yet, so the presets are league references, labeled as hypotheses.
- **Keep results next to grades.** Habitual over- and under-performers get multi-season context and graded traits the models miss.
- **Built for baseball ops too.** A transaction log (IL stints, options, trades), plus a searchable leaderboard so any pitcher is two clicks away.
- **Embed, don't rebuild.** Biomechanics is a slot for Baseball Sciences' viewer. New models plug into a registry with no new front-end code.

## Assumptions
- The club's internal models work like the FanGraphs primer describes. The public models here stand in for them.
- Grade spread follows tjStuff+'s method (per pitch type, percentile-based), and expected ERA = league ERA + 9 × model runs above average ÷ IP. Both are proposals for R&D to confirm.
- Production uses internal data behind club auth. The public sources here are licensed for non-commercial use only.

## How I used AI
I used Claude (Anthropic's Claude Code agent) as my engineering partner, and I am responsible for the result.

- **I directed:**
  - the product decisions and scope;
  - moving from mock data to real data and models;
  - the MLB data sources;
  - the leaderboard, team filtering and Nationals focus;
  - presentation details like team logos.
- **I reviewed** each version on the live site.
- **Claude:**
  - proposed the page structure and priorities;
  - wrote the code (the Vue app, the data pipeline, the Location and Pitching models, the validation checks);
  - drafted this summary and the PRD.
- **Claude tested** each change in a headless browser and against synthetic data before deploying. It also caught and fixed modeling problems the validation surfaced, such as the Location over-weighting and the seam-effect calibration.

<!-- Edit "How I used AI" so it reflects exactly what you did versus what Claude did. -->
