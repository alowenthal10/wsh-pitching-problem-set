(async () => {
// Same version stamp as this script's URL (set by pipeline/build_site.py), so the template isn't served stale.
const ASSET_V = document.currentScript ? new URL(document.currentScript.src).search : '';
const { createApp, reactive, ref, computed, watch, nextTick, onMounted } = Vue;
// Which pitcher and season: player pages at /<slug>/ set window.PITCHER; player.html also takes ?id=.
const QS = new URLSearchParams(location.search);
const FIXED_ID = +((window.PITCHER || {}).id || QS.get('id')) || null;
const [TEMPLATE, SEASONS] = await Promise.all([fetch('assets/player-template.html' + ASSET_V).then(r => r.text()), Site.seasons()]);

/* ---------------- Model registry (drives every grade on the page) ---------------- */
const MODELS = {
  pitching: { key: 'pitching', label: 'Pitching', short: 'Pitching+', model: 'pitching_plus', version: '3.2.0', status: 'live', stableN: 250, sd: { pitcher: 5, pitch: 9 }, color: 'var(--accent)', desc: 'Stuff, location, count, and platoon together. Best single estimate of run prevention.' },
  stuff:    { key: 'stuff', label: 'Stuff', short: 'Stuff+', model: 'stuff_plus', version: '4.1.0', status: 'live', stableN: 80, sd: { pitcher: 10, pitch: 18 }, color: 'var(--g-hi)', desc: 'Physical traits only: velocity, movement, spin, release, extension, and differences from the primary fastball.' },
  location: { key: 'location', label: 'Location', short: 'Location+', model: 'location_plus', version: '2.3.0', status: 'live', stableN: 400, sd: { pitcher: 4, pitch: 8 }, color: '#7A8AA3', desc: 'Value of where each pitch was thrown, specific to count, pitch type, and batter side.' },
};
const FUTURE = [
  { key: 'seam', label: 'Seam → movement', model: 'seam_movement', status: 'planned', slot: 'Pitch Lab presets', desc: 'Predicts movement from grip and seam orientation. Owned by Baseball Sciences.' },
];
let SEASON = SEASONS.includes(+QS.get('season')) ? +QS.get('season') : (SEASONS[0] || 2026);
const DEFAULT_TEAM = 120;              // Washington Nationals
const DEFAULT_PITCHER = /cavalli/i;   // Nationals default; other teams open on their innings leader

/* ---------------- MLB Stats API adapter ---------------- */
const API = 'https://statsapi.mlb.com/api/v1';
const mlb = {
  headshot: id => `https://midfield.mlbstatic.com/v1/people/${id}/spots/120`,
  async json(url) {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 6000);
    try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error(r.status); return await r.json(); }
    finally { clearTimeout(to); }
  },
  person: id => mlb.json(`${API}/people/${id}?hydrate=currentTeam,transactions,stats(group=[pitching],type=[yearByYear],sportId=1)`),
  teams: s => mlb.json(`${API}/teams?sportId=1&season=${s}`),
  roster: (t, s, type) => mlb.json(`${API}/teams/${t}/roster?rosterType=${type}&season=${s}&hydrate=person(stats(type=[season],group=[pitching],season=${s}))`),
};

/* ---------------- deterministic RNG so the illustrative data is stable per pitcher ---------------- */
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e6) / 1e6; }; }
function gauss(r) { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------------- Illustrative arsenal (shape is a template; values are not real) ---------------- */
const BASE_ARSENAL = [
  { code: 'FF', name: 'Four-seam', color: '#C0182F', usage: .47, n: 1290, velo: 95.6, ivb: 18.6, hb: 9.0,  spin: 2410, stuff: 118, location: 99,  pitching: 106, whiff: .27, xwoba: .318 },
  { code: 'CU', name: 'Curveball', color: '#2D63AE', usage: .16, n: 420,  velo: 81.2, ivb: -8.4, hb: -6.2, spin: 2620, stuff: 108, location: 96,  pitching: 102, whiff: .34, xwoba: .262 },
  { code: 'SL', name: 'Slider',    color: '#8C5BB8', usage: .14, n: 370,  velo: 86.4, ivb: 1.8,  hb: -4.1, spin: 2380, stuff: 104, location: 98,  pitching: 101, whiff: .36, xwoba: .281 },
  { code: 'FC', name: 'Cutter',    color: '#3C9A8E', usage: .14, n: 315,  velo: 90.3, ivb: 9.2,  hb: -1.8, spin: 2350, stuff: 97,  location: 101, pitching: 100, whiff: .21, xwoba: .335 },
  { code: 'CH', name: 'Changeup',  color: '#D88A1E', usage: .09, n: 238,  velo: 87.1, ivb: 8.6,  hb: 13.2, spin: 1720, stuff: 81,  location: 92,  pitching: 88,  whiff: .24, xwoba: .371 },
];

/* Stuff surface per pitch type: relative score; the page anchors it to the observed Stuff+ */
function stuffF(code, v, ivb, hb, ff) {
  switch (code) {
    case 'FF': return 2.6 * v - 0.35 * (ivb - 21.5) ** 2 - 0.10 * (hb - 7) ** 2;
    case 'CU': return 1.1 * v - 0.14 * (ivb + 15) ** 2 - 0.06 * (hb + 9) ** 2;
    case 'SL': return 1.3 * v - 0.20 * (ivb - 0) ** 2 - 0.10 * (hb + 8) ** 2;
    case 'FC': return 1.6 * v - 0.22 * (ivb - 11) ** 2 - 0.22 * (hb + 3) ** 2;
    case 'CH': { const d = ff.velo - v, di = ff.ivb - ivb; return -0.9 * (d - 9.5) ** 2 - 0.40 * (di - 16) ** 2 - 0.12 * (hb - 16) ** 2; }
  }
  return 0;
}
const PRESETS = {
  FF: [ { id: 'cur', name: 'Current grip', note: 'Four-seam, 12:45 tilt', d: { velo: 0, ivb: 0, hb: 0 } },
        { id: 'eff', name: 'Higher spin efficiency', note: 'Fingers more on top; cue for full backspin', d: { velo: 0.2, ivb: 1.8, hb: -1.0 } } ],
  CU: [ { id: 'cur', name: 'Current grip', note: 'Knuckle curve', d: { velo: 0, ivb: 0, hb: 0 } },
        { id: 'hard', name: 'Power curve', note: 'Firmer, more 12–6 orientation', d: { velo: 2.0, ivb: -2.5, hb: 2.0 } } ],
  SL: [ { id: 'cur', name: 'Current grip', note: 'Gyro slider', d: { velo: 0, ivb: 0, hb: 0 } },
        { id: 'sweep', name: 'Sweeper grip', note: 'Seam-shifted wake toward glove side', d: { velo: -2.5, ivb: -1.0, hb: -7.5 } } ],
  FC: [ { id: 'cur', name: 'Current grip', note: 'Four-seam cutter', d: { velo: 0, ivb: 0, hb: 0 } },
        { id: 'ride', name: 'Riding cutter', note: 'Less pronation, more carry', d: { velo: 0.4, ivb: 2.5, hb: 0.5 } } ],
  CH: [ { id: 'cur', name: 'Current grip', note: 'Circle change, four-seam orientation', d: { velo: 0, ivb: 0, hb: 0 } },
        { id: 'ssw', name: 'Seam-shifted changeup', note: 'Two-seam orientation; wake adds depth and fade', d: { velo: -0.4, ivb: -5.0, hb: 2.2 } },
        { id: 'split', name: 'Split-change', note: 'Wider fingers; kills spin', d: { velo: -0.8, ivb: -6.5, hb: -2.0 } } ],
};

/* Statcast pitch types: display names and colors */
const PT = {
  FF: ['Four-seam', '#C0182F'], SI: ['Sinker', '#E0702A'], FC: ['Cutter', '#3C9A8E'], SL: ['Slider', '#8C5BB8'], ST: ['Sweeper', '#C25BAA'],
  SV: ['Slurve', '#6A5ACD'], CU: ['Curveball', '#2D63AE'], KC: ['Knuckle curve', '#1F4E8C'], CS: ['Slow curve', '#5A86C5'],
  CH: ['Changeup', '#D88A1E'], FS: ['Splitter', '#2E9D8F'], FO: ['Forkball', '#4BAE9A'], SC: ['Screwball', '#B58900'],
  KN: ['Knuckleball', '#7A8AA3'], EP: ['Eephus', '#7A8AA3'], FA: ['Fastball', '#C0182F'],
};
const LOC_ALIAS = { SI: 'SI', ST: 'ST', SV: 'CU', KC: 'CU', CS: 'CU', FS: 'CH', FO: 'CH', SC: 'CH', FA: 'FF', KN: 'CH', EP: 'CU' };

/* Location model stand-in, RHP frame, catcher's view (x ft, +x = 1B side). */
const LOC_TARGET = { // same = batter on pitcher's side, opp = opposite
  FF: { same: [0.15, 3.4, .75, .45, 24], opp: [-0.1, 3.4, .75, .45, 22] },
  CU: { same: [0.35, 1.1, .6, .45, 24],  opp: [0.05, 1.1, .6, .45, 22] },
  SL: { same: [0.85, 1.4, .45, .45, 26], opp: [0.55, 1.2, .45, .45, 18] },
  FC: { same: [0.75, 2.1, .45, .6, 16],  opp: [0.6, 2.4, .45, .6, 20] },
  CH: { same: [-0.6, 1.4, .5, .45, 10],  opp: [-0.7, 1.3, .5, .45, 26] },
  SI: { same: [-0.65, 1.9, .5, .55, 22], opp: [-0.45, 2.0, .5, .55, 14] },
  ST: { same: [1.0, 1.5, .45, .45, 28],  opp: [0.7, 1.3, .45, .45, 16] },
};
const locTarget = c => LOC_TARGET[c] || LOC_TARGET[LOC_ALIAS[c]] || LOC_TARGET.FF;
const LOC_ACTUAL = { FF: [0.0, 3.0, .75, .65], CU: [0.25, 1.3, .7, .6], SL: [0.55, 1.6, .65, .6], FC: [0.5, 2.3, .6, .6], CH: [-0.3, 2.05, .7, .7] };
const COUNTS = [
  { key: 'ahead', label: 'Ahead', desc: '0-1, 0-2, 1-2', ball: 9, chase: 9 },
  { key: 'even', label: 'Even', desc: '0-0, 1-1, 2-2', ball: 17, chase: 4 },
  { key: 'behind', label: 'Behind', desc: '1-0, 2-0, 2-1, 3-x', ball: 30, chase: 0 },
];
function locValue(code, same, count, x, z) {
  const t = locTarget(code)[same ? 'same' : 'opp'];
  const dx = (x - t[0]) / t[2], dz = (z - t[1]) / t[3];
  let v = 48 + t[4] * Math.exp(-0.5 * (dx * dx + dz * dz));
  v -= 18 * Math.exp(-0.5 * ((x / 0.45) ** 2 + ((z - 2.5) / 0.5) ** 2));
  const ox = Math.max(0, Math.abs(x) - 0.83), oz = Math.max(0, 1.5 - z, z - 3.5), out = Math.hypot(ox, oz);
  v -= count.ball * Math.min(1.8, out) ** 1.3;
  if (out > 0) v += count.chase * Math.exp(-(((out - 0.25) / 0.2) ** 2));
  return clamp(v, 20, 80);
}

/* ---------------- Transactions ---------------- */
const TX_CATS = [
  { key: 'injury', label: 'Injury', color: 'var(--warn)', re: /injured list|disabled list|rehab assignment/i },
  { key: 'trade', label: 'Trade', color: '#8C5BB8', re: /\btrade|traded\b/i },
  { key: 'acq', label: 'Signing / claim', color: 'var(--ok)', re: /signed|drafted|claimed|purchased|selected .*rule 5/i },
  { key: 'roster', label: 'Roster move', color: 'var(--accent)', re: /optioned|recalled|designated|outright|released|selected the contract|assigned|returned|reinstated|elected free agency/i },
  { key: 'other', label: 'Other', color: 'var(--muted)', re: /./ },
];
const TX_FILTERS = [{ key: 'all', label: 'All' }, ...TX_CATS.filter(c => c.key !== 'other').map(c => ({ key: c.key, label: c.label }))];
const txCat = d => TX_CATS.find(c => c.re.test(d || '')) || TX_CATS[TX_CATS.length - 1];
const DEMO_TX = [ // synthetic demo pitcher only
  ['2021-07-12', 'Synthetic Club drafted Demo LHP in the 1st round.'],
  ['2023-05-02', 'Synthetic Club selected the contract of LHP Demo LHP from Triple-A.'],
  ['2023-06-18', 'Synthetic Club optioned LHP Demo LHP to Triple-A.'],
  ['2023-07-04', 'Synthetic Club recalled LHP Demo LHP from Triple-A.'],
  ['2024-06-10', 'Synthetic Club placed LHP Demo LHP on the 15-day injured list. Left shoulder inflammation.'],
  ['2024-07-02', 'Synthetic Club activated LHP Demo LHP from the 15-day injured list.'],
  ['2025-03-24', 'Synthetic Club optioned LHP Demo LHP to Triple-A.'],
  ['2025-04-09', 'Synthetic Club recalled LHP Demo LHP from Triple-A.'],
  ['2025-12-05', 'Synthetic Club traded LHP Demo LHP to Example Club.'],
  ['2026-08-14', 'Example Club placed LHP Demo LHP on the 15-day injured list. Left middle finger blister.'],
  ['2026-08-30', 'Example Club activated LHP Demo LHP from the 15-day injured list.'],
].map(([date, description], i) => ({ id: i, date, description, fromTeam: null, toTeam: null }));

/* ---------------- Biomechanics stand-in ---------------- */
const PHASES = ['Leg lift', 'Foot strike', 'Max ER', 'Release', 'Follow-through'];
const J = ['head', 'neck', 'sh', 'el', 'wr', 'gsh', 'gel', 'gwr', 'hip', 'bkn', 'ban', 'fkn', 'fan'];
const KEY = [ // x,y in 0..100 (y up); right-handed frame, moving toward +x
  { head: [30, 89], neck: [30, 79], sh: [29, 76], el: [25, 64], wr: [30, 58], gsh: [32, 76], gel: [36, 66], gwr: [31, 59], hip: [30, 48], bkn: [31, 24], ban: [30, 0], fkn: [41, 52], fan: [35, 32] },
  { head: [44, 83], neck: [42, 73], sh: [40, 72], el: [29, 74], wr: [24, 86], gsh: [44, 72], gel: [56, 74], gwr: [64, 72], hip: [45, 41], bkn: [36, 18], ban: [28, 1], fkn: [64, 22], fan: [70, 0] },
  { head: [57, 79], neck: [54, 69], sh: [52, 70], el: [46, 75], wr: [40, 85], gsh: [56, 68], gel: [60, 62], gwr: [56, 58], hip: [52, 38], bkn: [40, 14], ban: [30, 2], fkn: [66, 22], fan: [70, 0] },
  { head: [68, 73], neck: [64, 64], sh: [64, 66], el: [70, 75], wr: [77, 79], gsh: [60, 62], gel: [58, 54], gwr: [55, 50], hip: [58, 36], bkn: [46, 14], ban: [38, 4], fkn: [68, 22], fan: [70, 0] },
  { head: [77, 58], neck: [72, 54], sh: [72, 56], el: [75, 42], wr: [68, 30], gsh: [66, 52], gel: [60, 46], gwr: [56, 44], hip: [62, 34], bkn: [56, 22], ban: [48, 18], fkn: [70, 20], fan: [70, 0] },
];
const BONES = [['head', 'neck', 3], ['neck', 'hip', 6], ['neck', 'sh'], ['sh', 'el'], ['el', 'wr'], ['neck', 'gsh'], ['gsh', 'gel'], ['gel', 'gwr'], ['hip', 'bkn'], ['bkn', 'ban'], ['hip', 'fkn'], ['fkn', 'fan']];
const BIO_DEFAULT = { arm: 0.8, relH: 0.05, relS: 0.03, ext: -0.08, trunk: 0.6 };
const BIO = { // release metrics relative to the primary fastball (illustrative)
  FF: { arm: 0, relH: 0, relS: 0, ext: 0, trunk: 0 },
  CU: { arm: 2.4, relH: 0.12, relS: -0.05, ext: -0.15, trunk: -1.5 },
  SL: { arm: 0.6, relH: 0.03, relS: 0.02, ext: -0.05, trunk: 0.5 },
  FC: { arm: 0.3, relH: 0.02, relS: 0.01, ext: 0.0, trunk: 0.2 },
  CH: { arm: -3.4, relH: -0.21, relS: 0.14, ext: -0.30, trunk: -3.0 },
};

createApp({
  template: TEMPLATE,
  setup() {
    const live = ref(false), shotOk = ref(true);
    const teams = ref([]), teamId = ref(DEFAULT_TEAM);
    const roster = ref([]);
    const pitcherId = ref(null);
    const season = ref(SEASON);
    const p = reactive({ id: 0, name: 'Demo LHP', team: 'Synthetic data', throws: 'L', role: 'Starter', age: null, height: null, armAngle: 41, extension: 6.6 });
    const resultsRaw = ref([]);
    const txRaw = ref([]), txFilter = ref('all'), txAll = ref(false);
    const selected = ref('CH');
    const bats = ref('R');
    const heatMode = ref('model');
    const labCode = ref('CH');
    const preset = ref('cur');
    const labDelta = reactive({ velo: 0, ivb: 0, hb: 0 });
    const bioCode = ref('CH');
    const phase = ref(3);
    const playing = ref(false);
    const labCanvas = ref(null);
    const stuffMeta = ref(null), stuffData = ref(null), stuffStatus = ref('Mock arsenal: real Stuff data has not been built for this site yet.');
    const tj = ref(null);   // tjStuff+ evaluator, loaded on demand
    const realStuff = computed(() => !!(stuffData.value && stuffMeta.value));
    const realModels = computed(() => realStuff.value && stuffData.value.loc_plus != null && !!stuffMeta.value.location);
    const locSurf = ref(null);
    const obp = ref(null), bioViewMode = ref('side');   // Driveline OBP reference deliveries                       // real Location model surfaces (data/location/<season>/surfaces.json)
    const hist = ref({});                            // {season: pitcher model data} for Results vs. model
    const lgEra = ref({});                           // {season: league ERA} from the Stats API
    // One place that decides every Real / Mock tag on the page.
    const TAG = {
      real: (t) => ({ c: 'real', l: 'Real', t }), mock: (t) => ({ c: 'mock', l: 'Mock', t: t || 'Generated for this mockup. Not real data.' }),
      part: (t) => ({ c: 'mock', l: 'Partly mock', t }), place: (t) => ({ c: 'mock', l: 'Placeholder', t }),
    };
    function tag(key) {
      const S = realStuff.value, M = realModels.value;
      switch (key) {
        case 'badge': if (M && stuffData.value?.traits && realDesign.value) return { t: 'Every grade, trait, preset, and release metric is real. The results-adjusted crediting formula is a placeholder, and the skeleton is a reference delivery rather than his own.', l: 'Results-adjusted formula is a placeholder' };
          return { t: M ? 'Every grade is real. Grip presets, the results-adjusted formula, unmodeled traits, and biomechanics are still mock.' : S ? 'Stuff grades and pitch data are real (Statcast, tjStuff+). Location and Pitching grades, heatmap values, grip presets, and biomechanics are mock.' : 'Every grade, pitch metric, heatmap, projection and biomechanic is generated for this mockup. Only bio and season stats are real.',
          l: M ? 'Grip presets & biomechanics are mock' : S ? 'Location & Pitching grades are mock' : 'Grades & pitch data are mock' };
        case 'header': return S ? TAG.real('Statcast data') : TAG.mock();
        case 'g_stuff': return S ? TAG.real('tjStuff+ on Statcast') : TAG.mock();
        case 'g_location': case 'g_pitching': return M ? TAG.real('This project\'s model, fit on Statcast') : TAG.mock();
        case 'adjusted': return M ? TAG.place('Built from real grades and results, but the crediting formula is a placeholder for R&D to set.') : TAG.mock();
        case 'bottom': return M ? TAG.real('Written from the real grades') : TAG.mock('Written from the mock grades.');
        case 'trend': return M ? TAG.real('Monthly grades from Statcast') : S ? TAG.part('Stuff line is real; Pitching and Location lines are mock.') : TAG.mock();
        case 'arsenal': return M ? TAG.real('Statcast, tjStuff+, and this project\'s Location and Pitching models') : S ? TAG.part('Pitch types, shape, results, and Stuff grades are real. Pitch and Loc grades are mock.') : TAG.mock();
        case 'locations': return M ? TAG.real('Location model surfaces and his actual locations. The raw-binned view is simulated.') : S ? TAG.part('Where he throws it is real. The color surface is mock until the Location model is built.') : TAG.mock();
        case 'results': return M && stuffData.value?.traits ? TAG.part('Everything here is real except the results-adjusted crediting formula, a placeholder for R&D.') : M ? TAG.part('Expected ERA, grades, ERA, and FIP are real. The unmodeled traits list is mock.') : TAG.part('Expected ERA, grades and traits are mock. ERA and FIP are real when live data loads.');
        case 'bio': return obpRef.value ? TAG.part('Release table is his real Statcast data. The skeleton is a real motion-captured reference delivery (Driveline OBP), not his own.') : realBio.value ? TAG.part('Release table is real Statcast data. The skeleton is a stand-in.') : TAG.mock();
        case 'traits': return stuffData.value?.traits ? TAG.real('Computed from Statcast, graded against pitchers with 300+ pitches') : TAG.mock();
        case 'presets': return realDesign.value ? { c: 'real', l: 'Data-based presets', t: 'Built from league Statcast data. Whether he can throw these shapes is a question for the pitching staff.' } : { c: 'mock', l: 'Mock presets', t: 'Hand-entered movement changes, not model output.' };
        case 'models': return M ? TAG.real('Stuff, Location, and Pitching are working models. The seam model and open slot are concepts.') : S ? TAG.part('Stuff is tjStuff+ (real). Location and Pitching are placeholders.') : TAG.mock('Model names, versions and settings are placeholders.');
      }
      return TAG.mock();
    }
    const heatRefs = {};
    const themeTick = ref(0);

    /* ---------- grade helpers ---------- */
    const toGrade = (plus, sd) => clamp(50 + 10 * (plus - 100) / sd, 20, 80);
    const show = g => Math.round(g / 5) * 5;
    const mix = (g) => { const t = clamp((g - 50) / 30, -1, 1); const pct = Math.round(Math.abs(t) * 100); return t >= 0 ? `color-mix(in oklab, var(--g-hi) ${pct}%, var(--g-mid))` : `color-mix(in oklab, var(--g-lo) ${pct}%, var(--g-mid))`; };
    const gradeBg = g => mix(show(g));
    const gradeInk = (g, onFill) => { const t = (show(g) - 50) / 30; if (onFill) return Math.abs(t) > 0.45 ? '#FFFFFF' : 'var(--ink)'; return Math.abs(t) < 0.15 ? 'var(--ink)' : (t > 0 ? 'var(--g-hi)' : 'var(--g-lo)'); };
    const gStyle = g => ({ background: gradeBg(g), color: gradeInk(g, true) });
    const barW = g => ((clamp(g, 20, 80) - 20) / 60 * 100) + '%';
    const pct = v => (v * 100).toFixed(1) + '%';
    const signed = (v, d) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d);
    const roleFor = g => { const s = show(g); return s >= 70 ? 'No. 1 starter' : s >= 60 ? 'No. 2 starter' : s >= 55 ? 'No. 3 starter' : s >= 50 ? 'No. 4 starter' : s >= 45 ? 'No. 5 starter / long relief' : 'Up-and-down arm'; };

    /* ---------- arsenal (illustrative, perturbed per pitcher id) ---------- */
    const arsenal = computed(() => {
      if (realStuff.value) return realArsenal();
      const r = rng(p.id || 7);
      const jitter = p.id ? 1 : 0;
      return BASE_ARSENAL.map(b => {
        const x = { ...b };
        if (jitter) { x.stuff = Math.round(b.stuff + gauss(r) * 8); x.location = Math.round(b.location + gauss(r) * 3); x.pitching = Math.round((x.stuff + x.location) / 2 + gauss(r) * 2); x.velo = +(b.velo + gauss(r) * 1.2).toFixed(1); }
        x.grades = { stuff: toGrade(x.stuff, MODELS.stuff.sd.pitch), location: toGrade(x.location, MODELS.location.sd.pitch), pitching: toGrade(x.pitching, MODELS.pitching.sd.pitch) };
        return x;
      });
    });
    // Real pitch types, shape, results, and tjStuff+ grades. Location and Pitching values stay mock.
    function realArsenal() {
      const d = stuffData.value, r = rng(d.id + 5);
      return d.pitches.map(x => {
        const real = x.loc_grade != null;
        const location = real ? x.loc_plus : Math.round(100 + gauss(r) * 4);
        const pitching = real ? x.pitching_plus : 100 + 0.6 * (x.stuff_grade - 50) / 10 * MODELS.pitching.sd.pitch + 0.4 * (location - 100);
        return {
          code: x.code, name: (PT[x.code] || [x.name])[0], color: (PT[x.code] || [0, '#7A8AA3'])[1], usage: x.usage, n: x.n,
          velo: x.velo, ivb: x.ivb, hb: x.hb, spin: x.spin, whiff: x.whiff, xwoba: x.xwoba,
          stuff: x.stuff_plus, location, pitching: real ? pitching : Math.round(pitching), real: x,
          grades: real ? { stuff: x.stuff_grade, location: x.loc_grade, pitching: x.pitching_grade }
                       : { stuff: x.stuff_grade, location: toGrade(location, MODELS.location.sd.pitch), pitching: toGrade(pitching, MODELS.pitching.sd.pitch) },
        };
      });
    }
    const fbCode = computed(() => stuffData.value?.fastball?.type || 'FF');
    const totalPitches = computed(() => arsenal.value.reduce((s, x) => s + x.n, 0));
    const byCode = c => arsenal.value.find(x => x.code === c);
    const selPitch = computed(() => byCode(selected.value));
    const ff = computed(() => byCode('FF'));
    const overall = computed(() => {
      const o = {};
      for (const k of ['pitching', 'stuff', 'location']) {
        const plus = arsenal.value.reduce((s, x) => s + x.usage * x[k], 0);
        const n = totalPitches.value, sd = MODELS[k].sd.pitcher;
        o[k] = { plus, grade: toGrade(plus, sd), ci: Math.max(1, Math.round(10 * (MODELS[k].stableN / n) ** 0.5 * 1.5)) };
      }
      if (realStuff.value) o.stuff = { plus: stuffData.value.stuff_plus, grade: stuffData.value.stuff_grade, ci: o.stuff.ci };
      if (realModels.value) {
        o.location = { plus: stuffData.value.loc_plus, grade: stuffData.value.loc_grade, ci: o.location.ci };
        o.pitching = { plus: stuffData.value.pitching_plus, grade: stuffData.value.pitching_grade, ci: o.pitching.ci };
      }
      return o;
    });
    const headlineModels = [MODELS.pitching, MODELS.stuff, MODELS.location];

    /* ---------- monthly trend ---------- */
    const months = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
    const trend = computed(() => {
      const r = rng((p.id || 7) + 11), o = {};
      for (const k of ['pitching', 'stuff', 'location']) {
        const end = overall.value[k].grade; let g = end - 4 + r() * 2; o[k] = [];
        for (let i = 0; i < 6; i++) { g += (end - g) * 0.35 + gauss(r) * (k === 'location' ? 2.4 : 1.4); o[k].push(clamp(i === 5 ? end : g, 25, 75)); }
      }
      const monthly = (f) => [4, 5, 6, 7, 8, 9].map(m => { const x = stuffData.value.months.find(y => y.m === m); return x && x.n >= 50 && x[f] != null ? clamp(x[f], 25, 75) : null; });
      if (realStuff.value) o.stuff = monthly('stuff_grade');
      if (realModels.value) { o.location = monthly('loc_grade'); o.pitching = monthly('pitching_grade'); }
      return o;
    });
    const trendPts = k => trend.value[k].map((g, i) => ({ i, g })).filter(d => d.g != null);
    const gx = i => 50 + i * (570 / 5);
    const gy = g => 10 + (75 - g) / 50 * 160;

    /* ---------- results vs model ---------- */
    const DEMO_RESULTS = [ // synthetic demo pitcher only
      { season: 2023, ip: 136.1, era: 4.90, k: 151, bb: 57, hr: 21, hbp: 6, bf: 600 },
      { season: 2024, ip: 166.1, era: 4.21, k: 181, bb: 63, hr: 17, hbp: 5, bf: 704 },
      { season: 2025, ip: 159.2, era: 4.25, k: 185, bb: 63, hr: 19, hbp: 7, bf: 686 },
      { season: 2026, ip: 161.0, era: 4.31, k: 178, bb: 58, hr: 18, hbp: 5, bf: 683 },
    ];
    const ipNum = s => { const [w, f] = String(s).split('.'); return +w + (+(f || 0)) / 3; };
    const results = computed(() => {
      if (realModels.value) {   // seasons with model data: expected ERA = league ERA + 9 x model runs above average / IP
        const rows = resultsRaw.value.filter(r => r.ip >= 20 && hist.value[r.season] && lgEra.value[r.season]).map(r => {
          const h = hist.value[r.season];
          const expEra = lgEra.value[r.season] + 9 * h.runs_above_avg / r.ip;
          const fip = (13 * r.hr + 3 * (r.bb + r.hbp) - 2 * r.k) / r.ip + 3.15;
          return { ...r, pplus: h.pitching_plus, grade: h.pitching_grade, expEra, fip, ipText: r.ipText || r.ip.toFixed(1) };
        });
        return { rows, latest: rows[rows.length - 1] || resultsLatest(), real: true };
      }
      const rows = resultsRaw.value.filter(r => r.ip >= 20).slice(-5).map((r, i, arr) => {
        const back = arr.length - 1 - i;
        const pplus = overall.value.pitching.plus - back * 0.8 + ((r.season * 7) % 5 - 2) * 0.3;
        const expEra = 4.10 - (pplus - 100) * 0.07;
        const fip = (13 * r.hr + 3 * (r.bb + r.hbp) - 2 * r.k) / r.ip + 3.15;
        return { ...r, pplus, grade: toGrade(pplus, MODELS.pitching.sd.pitcher), expEra, fip, ipText: r.ipText || r.ip.toFixed(1) };
      });
      return { rows, latest: rows[rows.length - 1] || null };
    });
    function resultsLatest() {
      const r = resultsRaw.value.filter(x => x.ip >= 20).at(-1);
      return r ? { ...r, fip: (13 * r.hr + 3 * (r.bb + r.hbp) - 2 * r.k) / r.ip + 3.15, ipText: r.ipText || r.ip.toFixed(1) } : null;
    }
    const eraTicks = computed(() => {
      const vals = results.value.rows.flatMap(r => [r.era, r.expEra, r.fip]);
      if (!vals.length) return [3, 4, 5];
      const lo = Math.floor(Math.min(...vals, 3) * 2) / 2, hi = Math.ceil(Math.max(...vals, 5) * 2) / 2, t = [];
      for (let v = lo; v <= hi + 1e-9; v += 0.5) t.push(v);
      return t;
    });
    const ex = i => { const n = results.value.rows.length; return n <= 1 ? 335 : 70 + i * (530 / (n - 1)); };
    const ey = v => { const t = eraTicks.value; return 12 + (v - t[0]) / (t[t.length - 1] - t[0]) * 176; };

    const adjusted = computed(() => {
      const rows = results.value.rows;
      const model = overall.value.pitching.grade;
      if (!rows.length) return { grade: model, text: 'No MLB results yet, so the model grade stands.', label: 'Not enough results', long: 'Fewer than 20 MLB innings. The page shows model grades only.' };
      const ipT = rows.reduce((s, r) => s + r.ip, 0);
      const gap = rows.reduce((s, r) => s + (r.era - r.expEra) * r.ip, 0) / ipT; // + = worse than model
      const same = rows.filter(r => Math.sign(r.era - r.expEra) === Math.sign(gap) && Math.abs(r.era - r.expEra) > 0.15).length;
      const cred = clamp(ipT / (ipT + 400), 0, 0.7) * (same / rows.length);
      const gradeGap = -gap / 0.07 / MODELS.pitching.sd.pitcher * 10; // runs → plus → grade
      const grade = clamp(model + cred * gradeGap, 20, 80);
      const dir = gap > 0 ? 'under' : 'over';
      const persistent = same >= Math.max(2, rows.length - 1) && Math.abs(gap) > 0.2;
      const label = persistent ? `Persistent ${dir}performer` : 'Results track the model';
      const long = persistent
        ? `ERA has run ${Math.abs(gap).toFixed(2)} ${gap > 0 ? 'above' : 'below'} the Pitching model's expectation, IP-weighted, in ${same} of ${rows.length} seasons (${Math.round(ipT)} IP). That is long enough to treat as partly real. The adjusted grade credits ${Math.round(cred * 100)}% of the gap.`
        : `Over ${Math.round(ipT)} IP the gap between ERA and the model's expectation is small or switches direction. Trust the model grade.`;
      const text = persistent
        ? `Model says ${show(model)}; ${same} of ${rows.length} seasons ${dir}performed it by ${Math.abs(gap).toFixed(2)} ERA. Crediting ${Math.round(cred * 100)}% of that gap gives ${show(grade)}.`
        : `Results agree with the model within noise, so the grade stays ${show(model)}.`;
      return { grade, gap, persistent, label, long, text, cred };
    });
    const drivers = computed(() => {
      if (stuffData.value?.traits) return stuffData.value.traits;
      const r = rng((p.id || 7) + 3);
      return [
        { name: 'Extension & perceived velocity', grade: toGrade(100 + (p.extension - 6.4) * 25, 10), note: `${p.extension.toFixed(1)} ft extension. The Stuff model uses release, but not hitter reaction time.` },
        { name: 'Fastball approach angle', grade: 50 + gauss(r) * 6, note: 'Flatter VAA up in the zone plays above its movement.' },
        { name: 'Sequencing & tunneling', grade: 50 + gauss(r) * 6, note: 'Pitch-to-pitch context is outside single-pitch models.' },
        { name: 'Times through the order', grade: 50 + gauss(r) * 6, note: 'Third-time penalty versus league.' },
        { name: 'Pitch tipping risk', grade: 50 - Math.abs(BIO.CH.arm) * 3, note: 'From the biomechanics comparison below.' },
      ];
    });

    /* ---------- bottom line (opinionated, generated from the data) ---------- */
    const bottomLine = computed(() => {
      const a = [...arsenal.value];
      const key = realStuff.value ? 'stuff' : 'pitching';
      const best = a.slice().sort((x, y) => y.grades[key] - x.grades[key]).slice(0, 2);
      const worst = a.filter(x => x.usage >= 0.05).sort((x, y) => x.grades[key] - y.grades[key])[0] || a[a.length - 1];
      const o = overall.value;
      const items = [{
        title: best[1] ? `${best[0].name} and ${best[1].name.toLowerCase()} carry the profile.` : `${best[0].name} carries the profile.`,
        body: best[1] ? ` Stuff grades of ${show(best[0].grades.stuff)} and ${show(best[1].grades.stuff)}. Together they are ${pct(best[0].usage + best[1].usage)} of his pitches.` : ` Stuff grade of ${show(best[0].grades.stuff)}.`,
      }, {
        title: `${worst.name} is the lever: ${show(worst.grades.stuff)} stuff, ${show(worst.grades.location)} location.`,
        body: realStuff.value ? ` It is ${pct(worst.usage)} of his pitches. Test shape changes on the real model in Pitch Lab.` : ` ${worst.n < MODELS.location.stableN ? 'Location grade is not yet stable. ' : ''}Pitch Lab projects a seam-shifted version near a 50.`,
        action: { label: `Open ${worst.code} in Pitch Lab`, fn: () => { setLab(worst.code); const pr = presetsFor(worst.code)[1]; if (pr && pr.id !== 'ssw0') applyPreset(pr); go('lab'); } },
      }, {
        title: adjusted.value.persistent ? adjusted.value.label + '.' : 'Results match the grades.',
        body: ' ' + adjusted.value.text,
        action: { label: 'Results vs. model', fn: () => go('context') },
      }];
      const wl = a.slice().sort((x, y) => x.grades.location - y.grades.location)[0];
      if (show(o.location.grade) <= 45) items.splice(2, 0, { title: `Command is the gap: ${show(o.location.grade)} location.`, body: realModels.value ? ` Weakest with the ${wl.name.toLowerCase()} (${show(wl.grades.location)} location).` : ` Weakest with the ${wl.name.toLowerCase()} (${show(wl.grades.location)}), which he leaves too high against opposite-side hitters.`, action: { label: `See ${wl.code} locations`, fn: () => { selected.value = wl.code; bats.value = p.throws === 'L' ? 'R' : 'L'; go('locations'); } } });
      return items.slice(0, 4);
    });

    /* ---------- Pitch Lab ---------- */
    const labPitch = computed(() => byCode(labCode.value));
    const realDesign = computed(() => realStuff.value && !!stuffMeta.value.design);
    const capD = d => ({ velo: +clamp(d.velo, -4, 4).toFixed(1), ivb: +clamp(d.ivb, -10, 10).toFixed(1), hb: +clamp(d.hb, -10, 10).toFixed(1) });
    // Data-based presets: shape of the league's best pitches of this type from similar arm angles, and top-quarter seam effect.
    function designPresets(c) {
      const x = byCode(c), P = x?.real, D = stuffMeta.value.design, d = stuffData.value, out = [{ id: 'cur', name: 'Current shape', note: 'As thrown this season', d: { velo: 0, ivb: 0, hb: 0 } }];
      if (!P) return out;
      const arm = P.release?.arm ?? fbArm.value, bucket = arm != null ? String(Math.floor(arm / 10) * 10) : null;
      const comp = D.comps[c] && (D.comps[c][bucket] || D.comps[c].all);
      if (comp) {
        const isFb = c === d.fastball.type, from = D.comps[c][bucket] ? `${bucket}–${+bucket + 9}° arm angles` : 'all arm angles';
        out.push({ id: 'comp', name: `Shape of the best ${x.name.toLowerCase()}s`, note: `Average shape of the top quarter of ${x.name.toLowerCase()}s by tjStuff+, from pitchers with ${from} (${comp.n} pitchers).`,
          d: capD({ velo: isFb ? 0 : d.fastball.speed + comp.speed_diff - x.velo, ivb: comp.ivb - x.ivb, hb: comp.hb - x.hb }) });
      }
      // Seam-shifted wake is well established for sinkers, changeups, and splitters. On gyro-heavy pitches
      // (cutters, sliders) the 2-D spin axis doesn't predict movement, so no seam preset is offered.
      const L = ['SI', 'CH', 'FS', 'FO'].includes(c) ? D.ssw[c] : null, his = P.release?.ssw_dev;
      if (L && his != null) {
        const target = L.p50 >= 0 ? L.p75 : L.p25, delta = target - his;
        if (Math.abs(delta) >= 2) {
          const th = Math.atan2(x.hb, x.ivb) + delta * Math.PI / 180, m = Math.hypot(x.hb, x.ivb);
          out.push({ id: 'ssw', name: 'Seam effect like the league\'s top quarter', note: `His seam-shifted wake moves this pitch ${his.toFixed(0)}° from what its spin implies; the league's top quarter of ${x.name.toLowerCase()}s gets ${target.toFixed(0)}°. Rotates his movement by ${delta.toFixed(0)}°.`,
            d: capD({ velo: 0, ivb: m * Math.cos(th) - x.ivb, hb: m * Math.sin(th) - x.hb }) });
        } else out.push({ id: 'ssw0', name: 'Seam effect', note: `His seam-shifted wake (${his.toFixed(0)}°) is already in line with the league's top quarter for this pitch.`, d: { velo: 0, ivb: 0, hb: 0 } });
      }
      return out;
    }
    const presetsFor = c => realDesign.value ? designPresets(c) : (PRESETS[c] || [{ id: 'cur', name: 'Current grip', note: 'As thrown', d: { velo: 0, ivb: 0, hb: 0 } }]);
    const presetDeltaText = pr => pr.id === 'cur' ? 'as thrown' : `${signed(pr.d.velo, 1)} mph · ${signed(pr.d.ivb, 1)} IVB · ${signed(pr.d.hb, 1)} HB`;
    function setLab(c) { labCode.value = c; resetLab(); }
    function resetLab() { preset.value = 'cur'; labDelta.velo = 0; labDelta.ivb = 0; labDelta.hb = 0; }
    function applyPreset(pr) { preset.value = pr.id; labDelta.velo = pr.d.velo; labDelta.ivb = pr.d.ivb; labDelta.hb = pr.d.hb; }
    const sliders = [
      { key: 'velo', label: 'Velocity', min: -4, max: 4, step: 0.1, unit: 'mph' },
      { key: 'ivb', label: 'Induced vert.', min: -10, max: 10, step: 0.1, unit: 'in' },
      { key: 'hb', label: 'Horizontal', min: -10, max: 10, step: 0.1, unit: 'in' },
    ];
    const envelope = c => { const x = byCode(c); return { cx: x.hb + (c === 'CH' ? 1 : 0), cy: x.ivb - (c === 'CH' ? 3 : 0), rx: 6.5, ry: 6.5 }; };
    const stuffAt = (c, v, ivb, hb) => { const x = byCode(c), f = ff.value; return x.stuff + stuffF(c, v, ivb, hb, f) - stuffF(c, x.velo, x.ivb, x.hb, f); };
    /* ---------- real Pitch Lab: tjStuff+ on a sample of his actual pitches ---------- */
    const G_FT = 32.174;
    // movement change (in) -> acceleration change (ft/s^2) over Savant's 40-ft movement window
    const dAcc = (inches, t40) => 2 * (inches / 12) / (t40 * t40);
    function featRows(rows, d, fb) {
      // rows: [speed, spin, ext, az, ax_m, x0, z0]; d: per-row deltas; fb: fastball means
      return rows.map(r => {
        const sp = r[0] + d.v, az = r[3] + d.az, ax = r[4] + d.ax;
        return [sp, r[1], r[2], az, ax, r[5], r[6], sp - fb.speed, az - fb.az, Math.abs(ax - fb.ax)];
      });
    }
    const tjOf = (feats) => { const m = stuffMeta.value; let s = 0; for (const f of feats) s += 100 - 10 * (tj.value.xrv(f) - m.xrv_mean) / m.xrv_sd; return s / feats.length; };
    const ptScale = c => stuffMeta.value.scales[c] || stuffMeta.value.scales.All;
    const gradeFor = (plus, c) => { const sc = ptScale(c); return clamp(50 + 10 * (plus - sc.mean) / sc.std, 20, 80); };
    const baseTj = computed(() => {   // sample-based tjStuff+ per type at zero change, for anchoring
      if (!realStuff.value || !tj.value) return {};
      const d = stuffData.value, o = {};
      for (const x of d.pitches) o[x.code] = tjOf(featRows(x.sample, { v: 0, az: 0, ax: 0 }, d.fastball));
      return o;
    });
    function realLab() {
      const d = stuffData.value, x = labPitch.value, P = x.real, isFb = P.code === d.fastball.type;
      const dz = dAcc(labDelta.ivb, P.t40), dx = -dAcc(labDelta.hb, P.t40);
      const delta = { v: labDelta.velo, az: dz, ax: dx };
      const fb = isFb ? { speed: d.fastball.speed + delta.v, az: d.fastball.az + dz, ax: d.fastball.ax + dx } : d.fastball;
      let dOverallPlus = 0, plus = x.stuff;
      for (const q of d.pitches) {
        if (q.code !== P.code && !isFb) continue;
        const now = tjOf(featRows(q.sample, q.code === P.code ? delta : { v: 0, az: 0, ax: 0 }, fb));
        const change = now - baseTj.value[q.code];
        dOverallPlus += q.usage * change;
        if (q.code === P.code) plus = q.stuff_plus + change;
      }
      const all = stuffMeta.value.scales.All;
      const dOverall = clamp(50 + 10 * (d.stuff_plus + dOverallPlus - all.mean) / all.std, 20, 80) - d.stuff_grade;
      const zIvb = labDelta.ivb / Math.max(0.5, P.ivb_sd), zHb = labDelta.hb / Math.max(0.5, P.hb_sd);
      return { real: true, v: x.velo + labDelta.velo, ivb: x.ivb + labDelta.ivb, hb: x.hb + labDelta.hb, plus, dPlus: plus - x.stuff,
        grade: gradeFor(plus, P.code), outside: Math.hypot(zIvb, zHb) > 3, dOverall,
        fbNote: isFb ? 're-scoring every pitch against the new fastball' : '' };
    }
    const lab = computed(() => {
      if (realStuff.value) {
        if (tj.value && labPitch.value?.real) return realLab();
        const x = labPitch.value;   // model still loading
        return { real: true, v: x.velo, ivb: x.ivb, hb: x.hb, plus: x.stuff, dPlus: 0, grade: x.grades.stuff, outside: false, dOverall: 0, fbNote: 'loading model' };
      }
      const x = labPitch.value, v = x.velo + labDelta.velo, ivb = x.ivb + labDelta.ivb, hb = x.hb + labDelta.hb;
      const plus = clamp(stuffAt(x.code, v, ivb, hb), 40, 160);
      const dPlus = plus - x.stuff;
      const grade = toGrade(plus, MODELS.stuff.sd.pitch);
      const dist = Math.hypot(labDelta.ivb, labDelta.hb, labDelta.velo * 2);
      const unc = 1.5 + 0.9 * dist;
      const e = envelope(x.code);
      const outside = ((hb - e.cx) / e.rx) ** 2 + ((ivb - e.cy) / e.ry) ** 2 > 1;
      const dOverall = toGrade(overall.value.pitching.plus + x.usage * dPlus * 0.6, MODELS.pitching.sd.pitcher) - overall.value.pitching.grade;
      if (!stuffF(x.code, 95, 0, 0, x)) return { v, ivb, hb, plus: x.stuff, dPlus: 0, grade: x.grades.stuff, outside: false, dOverall: 0, lo: show(x.grades.stuff), hi: show(x.grades.stuff) };
      return { v, ivb, hb, plus, dPlus, grade, outside, dOverall, lo: show(toGrade(plus - unc, MODELS.stuff.sd.pitch)), hi: show(toGrade(plus + unc, MODELS.stuff.sd.pitch)) };
    });

    /* ---------- color tokens for canvas ---------- */
    function tokens() {
      const cs = getComputedStyle(document.documentElement), hex = n => cs.getPropertyValue(n).trim();
      const rgb = h => { const m = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(m.slice(i, i + 2), 16)); };
      return { lo: rgb(hex('--g-lo')), mid: rgb(hex('--g-mid')), hi: rgb(hex('--g-hi')), ink: hex('--ink'), muted: hex('--muted'), line: hex('--line'), surface: hex('--surface'), surface2: hex('--surface-2'), accent: hex('--accent') };
    }
    const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
    const rampRGB = (T, g) => { const t = clamp((g - 50) / 30, -1, 1); return t >= 0 ? lerp(T.mid, T.hi, t) : lerp(T.mid, T.lo, -t); };

    let surfKey = '', surfCache = null;
    // tjStuff+ grade over a 1-inch IVB x HB grid for this pitch, at its mean traits and the chosen velocity.
    function realSurface(X0, X1, Y0, Y1) {
      const d = stuffData.value, x = labPitch.value, P = x.real, isFb = P.code === d.fastball.type;
      const key = [d.id, P.code, labDelta.velo, X0, Y0].join('|');
      if (key === surfKey) return surfCache;
      const mean = [0, 1, 2, 3, 4, 5, 6].map(i => P.sample.reduce((s, r) => s + r[i], 0) / P.sample.length);
      const at = (dv, divb, dhb) => {
        const dz = dAcc(divb, P.t40), dx = -dAcc(dhb, P.t40);
        const fb = isFb ? { speed: d.fastball.speed + dv, az: d.fastball.az + dz, ax: d.fastball.ax + dx } : d.fastball;
        return tjOf(featRows([mean], { v: dv, az: dz, ax: dx }, fb));
      };
      const anchor = at(0, 0, 0), cells = [];
      for (let ivb = Y0; ivb < Y1; ivb++) for (let hb = X0; hb < X1; hb++) {
        const plus = P.stuff_plus + at(labDelta.velo, ivb + 0.5 - x.ivb, hb + 0.5 - x.hb) - anchor;
        cells.push({ hb, ivb, g: gradeFor(plus, P.code) });
      }
      surfKey = key; surfCache = cells;
      return cells;
    }
    function drawLab() {
      const cv = labCanvas.value; if (!cv) return;
      if (realStuff.value) return drawLabReal(cv);
      const T = tokens(), ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
      const x0 = labPitch.value, pad = { l: 44, r: 14, t: 12, b: 40 }, X0 = Math.floor(x0.hb - 13), X1 = X0 + 26, Y0 = Math.floor(x0.ivb - 12), Y1 = Y0 + 24;
      const sx = h => pad.l + (h - X0) / (X1 - X0) * (W - pad.l - pad.r), sy = v => H - pad.b - (v - Y0) / (Y1 - Y0) * (H - pad.t - pad.b);
      ctx.clearRect(0, 0, W, H);
      const x = labPitch.value, v = lab.value.v, step = 4;
      const img = ctx.createImageData(W, H);
      for (let py = pad.t; py < H - pad.b; py += step) for (let px = pad.l; px < W - pad.r; px += step) {
        const hb = X0 + (px - pad.l) / (W - pad.l - pad.r) * (X1 - X0), ivb = Y0 + (H - pad.b - py) / (H - pad.t - pad.b) * (Y1 - Y0);
        const g = show(toGrade(clamp(stuffAt(x.code, v, ivb, hb), 40, 160), MODELS.stuff.sd.pitch));
        const c = rampRGB(T, g);
        for (let dy = 0; dy < step; dy++) for (let dx = 0; dx < step; dx++) { const i = ((py + dy) * W + px + dx) * 4; img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255; }
      }
      ctx.putImageData(img, 0, 0);
      ctx.strokeStyle = T.line; ctx.lineWidth = 1; ctx.fillStyle = T.muted; ctx.font = '11px "IBM Plex Mono", monospace'; ctx.textAlign = 'center';
      for (let t = Math.ceil(X0 / 5) * 5; t <= X1; t += 5) { ctx.globalAlpha = .5; ctx.beginPath(); ctx.moveTo(sx(t), pad.t); ctx.lineTo(sx(t), H - pad.b); ctx.stroke(); ctx.globalAlpha = 1; ctx.fillText(t, sx(t), H - pad.b + 14); }
      ctx.textAlign = 'right';
      for (let t = Math.ceil(Y0 / 5) * 5; t <= Y1; t += 5) { ctx.globalAlpha = .5; ctx.beginPath(); ctx.moveTo(pad.l, sy(t)); ctx.lineTo(W - pad.r, sy(t)); ctx.stroke(); ctx.globalAlpha = 1; ctx.fillText(t, pad.l - 6, sy(t) + 4); }
      ctx.textAlign = 'left'; ctx.fillText('← glove side   horizontal break (in)   arm side →', pad.l, H - 8);
      ctx.save(); ctx.translate(12, pad.t + (H - pad.t - pad.b) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('induced vertical break (in)', 0, 0); ctx.restore();
      // other pitches for reference
      for (const o of arsenal.value) if (o.code !== x.code && o.hb > X0 && o.hb < X1 && o.ivb > Y0 && o.ivb < Y1) { ctx.fillStyle = T.muted; ctx.globalAlpha = .7; ctx.beginPath(); ctx.arc(sx(o.hb), sy(o.ivb), 3, 0, 7); ctx.fill(); ctx.globalAlpha = 1; ctx.textAlign = 'left'; ctx.fillText(o.code, sx(o.hb) + 6, sy(o.ivb) + 4); }
      // envelope
      const e = envelope(x.code);
      ctx.setLineDash([6, 5]); ctx.strokeStyle = T.ink; ctx.lineWidth = 1.5; ctx.beginPath();
      ctx.ellipse(sx(e.cx), sy(e.cy), Math.abs(sx(e.cx + e.rx) - sx(e.cx)), Math.abs(sy(e.cy + e.ry) - sy(e.cy)), 0, 0, 7); ctx.stroke(); ctx.setLineDash([]);
      // arrow current → projected
      const ax = sx(x.hb), ay = sy(x.ivb), bx = sx(lab.value.hb), by = sy(lab.value.ivb);
      if (Math.hypot(bx - ax, by - ay) > 4) { ctx.strokeStyle = T.ink; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); }
      ctx.lineWidth = 3; ctx.strokeStyle = T.ink; ctx.beginPath(); ctx.arc(ax, ay, 9, 0, 7); ctx.stroke();
      ctx.fillStyle = T.ink; ctx.beginPath(); ctx.arc(bx, by, 7, 0, 7); ctx.fill();
      ctx.font = '600 12px "IBM Plex Sans", sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = T.ink;
      ctx.fillText(`${x.code} now · ${show(x.grades.stuff)}`, ax + 13, ay - 8);
      if (Math.hypot(bx - ax, by - ay) > 4) ctx.fillText(`projected · ${show(lab.value.grade)}`, bx + 11, by + 16);
    }

    function drawLabReal(cv) {
      const T = tokens(), ctx = cv.getContext('2d'), W = cv.width, H = cv.height, x = labPitch.value, P = x.real;
      const pad = { l: 44, r: 14, t: 12, b: 40 }, X0 = Math.floor(x.hb - 13), X1 = X0 + 26, Y0 = Math.floor(x.ivb - 12), Y1 = Y0 + 24;
      const sx = h => pad.l + (h - X0) / (X1 - X0) * (W - pad.l - pad.r), sy = v => H - pad.b - (v - Y0) / (Y1 - Y0) * (H - pad.t - pad.b);
      ctx.clearRect(0, 0, W, H);
      ctx.font = '11px "IBM Plex Mono", monospace'; ctx.fillStyle = T.muted;
      if (!tj.value) { ctx.textAlign = 'center'; ctx.fillText('Loading tjStuff+ model…', W / 2, H / 2); return; }
      for (const c of realSurface(X0, X1, Y0, Y1)) {
        ctx.fillStyle = `rgb(${rampRGB(T, show(c.g))})`;
        ctx.fillRect(Math.floor(sx(c.hb)), Math.floor(sy(c.ivb + 1)), Math.ceil(sx(c.hb + 1) - sx(c.hb)) + 1, Math.ceil(sy(c.ivb) - sy(c.ivb + 1)) + 1);
      }
      ctx.strokeStyle = T.line; ctx.lineWidth = 1; ctx.fillStyle = T.muted; ctx.textAlign = 'center';
      for (let t = Math.ceil(X0 / 5) * 5; t <= X1; t += 5) { ctx.globalAlpha = .5; ctx.beginPath(); ctx.moveTo(sx(t), pad.t); ctx.lineTo(sx(t), H - pad.b); ctx.stroke(); ctx.globalAlpha = 1; ctx.fillText(t, sx(t), H - pad.b + 14); }
      ctx.textAlign = 'right';
      for (let t = Math.ceil(Y0 / 5) * 5; t <= Y1; t += 5) { ctx.globalAlpha = .5; ctx.beginPath(); ctx.moveTo(pad.l, sy(t)); ctx.lineTo(W - pad.r, sy(t)); ctx.stroke(); ctx.globalAlpha = 1; ctx.fillText(t, pad.l - 6, sy(t) + 4); }
      ctx.textAlign = 'left'; ctx.fillText('← glove side   horizontal break (in)   arm side →', pad.l, H - 8);
      ctx.save(); ctx.translate(12, pad.t + (H - pad.t - pad.b) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('induced vertical break (in)', 0, 0); ctx.restore();
      // his actual pitches (sample), placed by their acceleration difference from the pitch-type mean
      const k = 0.5 * P.t40 * P.t40 * 12, mAz = P.sample.reduce((s, r) => s + r[3], 0) / P.sample.length, mAx = P.sample.reduce((s, r) => s + r[4], 0) / P.sample.length;
      ctx.fillStyle = T.ink; ctx.globalAlpha = .35;
      for (const r of P.sample) { ctx.beginPath(); ctx.arc(sx(x.hb - (r[4] - mAx) * k), sy(x.ivb + (r[3] - mAz) * k), 2.2, 0, 7); ctx.fill(); }
      ctx.globalAlpha = 1;
      ctx.setLineDash([6, 5]); ctx.strokeStyle = T.ink; ctx.lineWidth = 1.5; ctx.beginPath();
      ctx.ellipse(sx(x.hb), sy(x.ivb), Math.abs(sx(x.hb + 2 * P.hb_sd) - sx(x.hb)), Math.abs(sy(x.ivb + 2 * P.ivb_sd) - sy(x.ivb)), 0, 0, 7); ctx.stroke(); ctx.setLineDash([]);
      for (const o of arsenal.value) if (o.code !== x.code && o.hb > X0 && o.hb < X1 && o.ivb > Y0 && o.ivb < Y1) { ctx.fillStyle = T.muted; ctx.beginPath(); ctx.arc(sx(o.hb), sy(o.ivb), 3, 0, 7); ctx.fill(); ctx.textAlign = 'left'; ctx.fillText(o.code, sx(o.hb) + 6, sy(o.ivb) + 4); }
      const ax = sx(x.hb), ay = sy(x.ivb), bx = sx(lab.value.hb), by = sy(lab.value.ivb);
      if (Math.hypot(bx - ax, by - ay) > 4) { ctx.strokeStyle = T.ink; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); }
      ctx.lineWidth = 3; ctx.strokeStyle = T.ink; ctx.beginPath(); ctx.arc(ax, ay, 9, 0, 7); ctx.stroke();
      ctx.fillStyle = T.ink; ctx.beginPath(); ctx.arc(bx, by, 7, 0, 7); ctx.fill();
      ctx.font = '600 12px "IBM Plex Sans", sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(`${x.code} now · ${show(x.grades.stuff)}`, ax + 13, ay - 8);
      if (Math.hypot(bx - ax, by - ay) > 4) ctx.fillText(`projected · ${show(lab.value.grade)}`, bx + 11, by + 16);
    }

    // Location model grade at a spot (pitcher's frame: +x = glove side), bilinear between 0.1-ft cells.
    function surfVal(code, countKey, same, x, z) {
      const S = locSurf.value, g = S.grid, t = S.types[S.type_map[code] || 'FF'] || S.types.FF || Object.values(S.types)[0];
      const a = t[countKey][same ? 'same' : 'opp'];
      const fx = clamp((x - g.x0) / g.dx, 0, g.nx - 1.001), fz = clamp((z - g.z0) / g.dz, 0, g.nz - 1.001);
      const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, at = (jj, ii) => a[jj * g.nx + ii];
      return (1 - u) * (1 - v) * at(j, i) + u * (1 - v) * at(j, i + 1) + (1 - u) * v * at(j + 1, i) + u * v * at(j + 1, i + 1);
    }
    // Most valuable spot for this pitch, count, and batter side (pitcher's frame), searched over a plausible area.
    function bestSpot(code, countKey, same) {
      let best = null;
      for (let z = 0.8; z <= 4.2; z += 0.1) for (let x = -1.4; x <= 1.4; x += 0.1) { const g = surfVal(code, countKey, same, x, z); if (!best || g > best.g) best = { x, z, g }; }
      return best;
    }
    // Where he throws a pitch: [meanX, meanZ, sdX, sdZ, rho], catcher's view. Real Statcast when loaded.
    function actualLoc(code) {
      const real = byCode(code)?.real?.loc;
      if (real) { const l = real[bats.value] || real.all; if (l) return l; }
      const a = LOC_ACTUAL[code] || LOC_ACTUAL[LOC_ALIAS[code]] || LOC_ACTUAL.FF, m = p.throws === 'L' ? -1 : 1;
      return [a[0] * m, a[1], a[2], a[3], 0];
    }
    // Ellipse axes for a correlated bivariate normal
    function locEllipse(l) {
      const vx = l[2] ** 2, vz = l[3] ** 2, c = l[4] * l[2] * l[3], tr = (vx + vz) / 2, det = Math.sqrt(((vx - vz) / 2) ** 2 + c * c);
      return { r1: Math.sqrt(tr + det), r2: Math.sqrt(Math.max(tr - det, 1e-6)), ang: 0.5 * Math.atan2(2 * c, vx - vz) };
    }
    function drawHeat() {
      const T = tokens(), x = selPitch.value;
      const same = bats.value === p.throws, mirror = p.throws === 'L' ? -1 : 1;
      const W = 260, H = 300, X0 = -1.6, X1 = 1.6, Z0 = 0.3, Z1 = 4.5;
      const sx = v => (v - X0) / (X1 - X0) * W, sz = v => H - (v - Z0) / (Z1 - Z0) * H;
      for (const c of COUNTS) {
        const cv = heatRefs[c.key]; if (!cv) continue;
        const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = T.surface2; ctx.fillRect(0, 0, W, H);
        const val = locSurf.value && realModels.value ? (px, pz) => surfVal(x.code, c.key, same, px * mirror, pz) : (px, pz) => locValue(x.code, same, c, px * mirror, pz);
        if (heatMode.value === 'model') {
          const img = ctx.createImageData(W, H), step = 2;
          for (let py = 0; py < H; py += step) for (let px = 0; px < W; px += step) {
            const g = show(val(X0 + px / W * (X1 - X0), Z1 - py / H * (Z1 - Z0)));
            const col = rampRGB(T, g);
            for (let dy = 0; dy < step; dy++) for (let dx = 0; dx < step; dx++) { const i = ((py + dy) * W + px + dx) * 4; img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255; }
          }
          ctx.putImageData(img, 0, 0);
        } else {
          const r = rng(x.code.charCodeAt(0) * 97 + c.ball + (same ? 1 : 2)), a = actualLoc(x.code), bin = 0.25, sums = {};
          for (let i = 0; i < Math.round(x.n * 0.35); i++) {
            const g1 = gauss(r), g2 = gauss(r), px = a[0] + a[2] * g1, pz = a[1] + a[3] * (a[4] * g1 + Math.sqrt(1 - a[4] ** 2) * g2);
            const k = Math.floor(px / bin) + ',' + Math.floor(pz / bin); const o = val(px, pz) + gauss(r) * 22;
            (sums[k] = sums[k] || [0, 0]); sums[k][0] += o; sums[k][1]++;
          }
          for (const k in sums) { const [bx, bz] = k.split(',').map(Number); const col = rampRGB(T, clamp(sums[k][0] / sums[k][1], 20, 80)); ctx.fillStyle = `rgb(${col})`; ctx.fillRect(sx(bx * bin), sz((bz + 1) * bin), sx(bin) - sx(0) + 0.5, sz(0) - sz(bin) + 0.5); }
        }
        // zone + plate
        ctx.strokeStyle = T.ink; ctx.lineWidth = 2; ctx.strokeRect(sx(-0.83), sz(3.5), sx(0.83) - sx(-0.83), sz(1.5) - sz(3.5));
        ctx.lineWidth = 1; ctx.globalAlpha = .35;
        for (const t of [1 / 3, 2 / 3]) { const xx = -0.83 + 1.66 * t, zz = 1.5 + 2 * t; ctx.beginPath(); ctx.moveTo(sx(xx), sz(1.5)); ctx.lineTo(sx(xx), sz(3.5)); ctx.moveTo(sx(-0.83), sz(zz)); ctx.lineTo(sx(0.83), sz(zz)); ctx.stroke(); }
        ctx.globalAlpha = 1;
        ctx.fillStyle = T.surface; ctx.strokeStyle = T.muted; ctx.beginPath();
        const py0 = H - 10; ctx.moveTo(sx(-0.71), py0 - 6); ctx.lineTo(sx(0.71), py0 - 6); ctx.lineTo(sx(0.71), py0); ctx.lineTo(sx(0), py0 + 6); ctx.lineTo(sx(-0.71), py0); ctx.closePath(); ctx.fill(); ctx.stroke();
        // actual distribution contours (50% and 80%)
        const a = actualLoc(x.code), e = locEllipse(a), ppf = (W / (X1 - X0)), ppz = (H / (Z1 - Z0));
        for (const [k, dash] of [[1.177, []], [1.794, [4, 4]]]) {
          ctx.setLineDash(dash); ctx.strokeStyle = T.ink; ctx.lineWidth = 1.6; ctx.beginPath();
          ctx.ellipse(sx(a[0]), sz(a[1]), e.r1 * k * ppf, e.r2 * k * ppz, -e.ang, 0, 7); ctx.stroke();
        }
        ctx.setLineDash([]);
        // batter side label
        ctx.fillStyle = T.muted; ctx.font = '11px "IBM Plex Mono", monospace'; ctx.textAlign = bats.value === 'R' ? 'left' : 'right';
        ctx.fillText(bats.value === 'R' ? 'RHH' : 'LHH', bats.value === 'R' ? 6 : W - 6, 16);
      }
    }
    const locRead = computed(() => {
      if (locSurf.value && realModels.value) {
        const x = selPitch.value, same = bats.value === p.throws, m = p.throws === 'L' ? -1 : 1, a = actualLoc(x.code);
        const b = bestSpot(x.code, 'even', same), bx = b.x * m;
        const miss = Math.hypot((a[0] - bx) * 12, (a[1] - b.z) * 12);
        const dz = a[1] - b.z, dirZ = dz > 0.2 ? 'above' : dz < -0.2 ? 'below' : 'level with';
        const where = b.z < 1.5 ? 'below the zone' : b.z > 3.5 ? 'above the zone' : b.z > 2.9 ? 'at the top of the zone' : b.z < 2.1 ? 'at the bottom of the zone' : 'at mid height';
        const side = Math.abs(b.x) < 0.3 ? 'over the middle' : ((b.x > 0) === (true) ? 'to his glove side' : 'to his arm side');
        return `In even counts the ${x.name.toLowerCase()} grades best ${where}, ${side}, against ${same ? 'same' : 'opposite'}-side hitters. His average location sits about ${Math.round(miss)} inches from that spot, ${dirZ} it. Compare the three counts to see how the value moves when he falls behind.`;
      }
      const x = selPitch.value, same = bats.value === p.throws, m = p.throws === 'L' ? -1 : 1, t0 = locTarget(x.code)[same ? 'same' : 'opp'], t = [t0[0] * m, t0[1]], a = actualLoc(x.code);
      const miss = Math.hypot((a[0] - t[0]) * 12, (a[1] - t[1]) * 12);
      const dirZ = a[1] > t[1] + 0.2 ? 'up' : a[1] < t[1] - 0.2 ? 'down' : '';
      const where = t[1] < 1.6 ? 'below the zone' : t[1] > 3.2 ? 'at the top of the zone' : 'on the edge';
      return `The ${x.name.toLowerCase()} is most valuable ${where} against ${same ? 'same' : 'opposite'}-side hitters (mock surface). His average location${realStuff.value ? ' (real)' : ''} sits about ${Math.round(miss)} inches from that spot${dirZ ? ', missing ' + dirZ : ''}. When he is behind, the value of the edges drops and the middle of the zone costs the most.`;
    });

    /* ---------- transactions ---------- */
    const DAY = 864e5;
    const txList = computed(() => txRaw.value
      .filter(t => t.date && t.description)
      .map((t, i) => ({ key: (t.id ?? i) + t.date, date: t.date.slice(0, 10), t: Date.parse(t.date.slice(0, 10)), description: t.description, cat: txCat(t.description), teams: [t.fromTeam?.name, t.toTeam?.name].filter(Boolean) }))
      .sort((a, b) => a.t - b.t));
    // Pair "placed on ... injured list" with the next "activated/reinstated from ... injured list".
    const ilStints = computed(() => {
      const out = []; let open = null;
      for (const t of txList.value) {
        const d = t.description;
        if (/placed .* on the .*(injured|disabled) list/i.test(d)) { if (!open) open = { start: t.t, startDate: t.date, desc: d }; }
        else if (open && /(activated|reinstated|returned) .* from the .*(injured|disabled) list/i.test(d)) { out.push({ ...open, end: t.t, endDate: t.date }); open = null; }
      }
      if (open) out.push({ ...open, end: null, endDate: null });
      return out.map(s => ({ ...s, days: Math.round(((s.end ?? Date.now()) - s.start) / DAY), detail: (s.desc.match(/injured list\.?\s*(.*)$/i) || [])[1] || '' }));
    });
    const txCounts = computed(() => { const c = { all: txList.value.length }; for (const k of TX_CATS) c[k.key] = txList.value.filter(t => t.cat.key === k.key).length; return c; });
    const txFiltered = computed(() => txList.value.filter(t => txFilter.value === 'all' || t.cat.key === txFilter.value).slice().reverse());
    const txShown = computed(() => txAll.value ? txFiltered.value : txFiltered.value.slice(0, 8));
    const fmtDate = d => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const txSummary = computed(() => {
      const since = new Date().getFullYear() - 2, recent = ilStints.value.filter(s => +s.startDate.slice(0, 4) >= since);
      const open = ilStints.value.find(s => !s.end && Date.now() - s.start < 365 * DAY);
      const last = ilStints.value[ilStints.value.length - 1];
      const optionSeasons = [...new Set(txList.value.filter(t => /\boptioned\b/i.test(t.description)).map(t => t.date.slice(0, 4)))];
      const orgs = new Set(txList.value.flatMap(t => t.teams).filter(n => /^[A-Z]/.test(n || ''))).size;
      return {
        stints3: recent.length, days3: recent.reduce((s, x) => s + x.days, 0), optionSeasons,
        orgs: orgs || '—',
        onIL: open ? { text: `Since ${fmtDate(open.startDate)} (${open.days} days). ${open.detail}` } : null,
        lastIL: last ? `${fmtDate(last.startDate)}${last.endDate ? ' to ' + fmtDate(last.endDate) : ', still open'} · ${last.days} days. ${last.detail}` : '',
      };
    });
    const txTimeline = computed(() => {
      const L = txList.value; if (!L.length) return { years: [], stints: [], events: [] };
      const y0 = Math.max(new Date(L[0].t).getFullYear(), new Date().getFullYear() - 5), t0 = Date.UTC(y0, 0, 1), t1 = Date.UTC(new Date().getFullYear() + 1, 0, 1);
      const X = t => 50 + clamp((t - t0) / (t1 - t0), 0, 1) * 580;
      const years = []; for (let y = y0; y <= new Date().getFullYear(); y++) years.push({ y, x: X(Date.UTC(y, 0, 1)) });
      const stints = ilStints.value.filter(s => (s.end ?? Date.now()) >= t0).map(s => ({ x: X(s.start), w: Math.max(4, X(s.end ?? Date.now()) - X(s.start)), title: `${fmtDate(s.startDate)}: ${s.days} days. ${s.detail}` }));
      const events = L.filter(t => t.t >= t0 && t.cat.key !== 'injury').map(t => ({ x: X(t.t), color: t.cat.color, title: `${fmtDate(t.date)}: ${t.description}` }));
      return { years, stints, events };
    });

    /* ---------- biomechanics ---------- */
    const bioColor = computed(() => byCode(bioCode.value)?.color || 'var(--accent)');
    const bioOf = c => BIO[c] || BIO_DEFAULT;
    const phaseName = computed(() => PHASES[Math.round(phase.value)]);
    function pose(t, code) {
      const i = Math.min(3, Math.floor(t)), f = t - i, A = KEY[i], B = KEY[i + 1], out = {};
      const flip = p.throws === 'L';
      for (const j of J) out[j] = [A[j][0] + (B[j][0] - A[j][0]) * f, A[j][1] + (B[j][1] - A[j][1]) * f];
      if (code) { // rotate throwing arm about shoulder by 3x arm-angle delta, strongest at release
        const w = Math.exp(-((t - 3) ** 2) / 0.6), ang = -bioOf(code).arm * 3 * w * Math.PI / 180, s = out.sh;
        for (const j of ['el', 'wr']) { const dx = out[j][0] - s[0], dy = out[j][1] - s[1]; out[j] = [s[0] + dx * Math.cos(ang) - dy * Math.sin(ang), s[1] + dx * Math.sin(ang) + dy * Math.cos(ang)]; }
        const dy = bioOf(code).relH * 6 * w; out.wr[1] += dy;
      }
      for (const j of J) out[j] = [flip ? 400 - (40 + out[j][0] * 3.2) : 40 + out[j][0] * 3.2, 268 - out[j][1] * 2.35];
      return out;
    }
    // ---- skeleton view model: real reference delivery (Driveline OBP) when loaded, else the stand-in ----
    const OBP_BONES = [['rear_ankle_jc', 'rear_knee_jc', 4], ['rear_knee_jc', 'rear_hip', 4], ['lead_ankle_jc', 'lead_knee_jc', 4], ['lead_knee_jc', 'lead_hip', 4],
      ['rear_hip', 'lead_hip', 4], ['thorax_dist', 'thorax_prox', 6], ['thorax_prox', 'glove_shoulder_jc', 4], ['glove_shoulder_jc', 'glove_elbow_jc', 4],
      ['glove_elbow_jc', 'glove_wrist_jc', 4], ['glove_wrist_jc', 'glove_hand_jc', 3], ['thorax_prox', 'shoulder_jc', 4], ['shoulder_jc', 'elbow_jc', 5],
      ['elbow_jc', 'wrist_jc', 5], ['wrist_jc', 'hand_jc', 4]];
    const ARM_JOINTS = ['elbow_jc', 'wrist_jc', 'hand_jc'];
    const fbArm = computed(() => stuffData.value?.pitches.find(x => x.code === fbCode.value)?.release?.arm ?? p.armAngle ?? null);
    const armDelta = c => { const q = stuffData.value?.pitches.find(x => x.code === c)?.release?.arm; return q != null && fbArm.value != null ? q - fbArm.value : (realStuff.value ? 0 : bioOf(c).arm); };
    const obpRef = computed(() => {
      const d = obp.value; if (!d) return null;
      const same = d.references.filter(r => r.throws === p.throws), pool = same.length ? same : d.references, target = fbArm.value ?? 40;
      return pool.reduce((best, r) => Math.abs(r.arm_angle - target) < Math.abs(best.arm_angle - target) ? r : best, pool[0]);
    });
    function refFrame(ref, t) {   // phase 0..4 -> frame, through the delivery's real event times
      const e = ref.events, keys = [0, e.foot_plant, e.max_er, e.release, 1], i = Math.min(3, Math.floor(t)), f = keys[i] + (keys[i + 1] - keys[i]) * (t - i);
      const pos = f * (ref.frames.length - 1), a = Math.floor(pos), b = Math.min(ref.frames.length - 1, a + 1), u = pos - a;
      const out = {}, J = obp.value.joints;
      J.forEach((j, k) => { out[j] = [0, 1, 2].map(c => ref.frames[a][3 * k + c] * (1 - u) + ref.frames[b][3 * k + c] * u); });
      return { joints: out, nearRelease: Math.exp(-(((f - e.release) / 0.04) ** 2)) };
    }
    const bioView = computed(() => {
      const ref = obpRef.value, L = p.throws === 'L', col = bioColor.value;
      if (ref) {
        const { joints, nearRelease } = refFrame(ref, phase.value), S = 112;
        const proj = q => bioViewMode.value === 'side'
          ? [L ? 400 - (50 + q[0] * S) : 50 + q[0] * S, 270 - q[2] * S]
          : [L ? 200 + q[1] * S : 200 - q[1] * S, 270 - q[2] * S];
        // comparison arm: rotate elbow-wrist-hand about the shoulder in the catcher's (arm side, up) plane
        const ang = armDelta(bioCode.value) * 3 * nearRelease * Math.PI / 180, sh = joints.shoulder_jc;
        const rot = q => { const ds = q[1] - sh[1], du = q[2] - sh[2]; return [q[0], sh[1] + ds * Math.cos(ang) - du * Math.sin(ang), sh[2] + ds * Math.sin(ang) + du * Math.cos(ang)]; };
        const spine = [0, 1, 2].map(c => joints.thorax_prox[c] - joints.thorax_dist[c]), n = Math.hypot(...spine) || 1;
        const head = proj(joints.thorax_prox.map((v, c) => v + 0.24 * spine[c] / n));
        const hand1 = proj(joints.hand_jc), hand2 = proj(rot(joints.hand_jc));
        return {
          bones: OBP_BONES.map(([a, b, w]) => [...proj(joints[a]), ...proj(joints[b]), w, ARM_JOINTS.includes(b) ? 1 : .55]),
          head, arm2: ['shoulder_jc', ...ARM_JOINTS].map(j => proj(j === 'shoulder_jc' ? joints[j] : rot(joints[j]))),
          balls: [{ x: hand1[0], y: hand1[1], color: 'var(--ink)', label: fbCode.value, dx: L ? -9 : 9, dy: -6 }, { x: hand2[0], y: hand2[1], color: col, label: bioCode.value, dx: L ? -9 : 9, dy: 12 }],
        };
      }
      const A = pose(phase.value, null), B = pose(phase.value, bioCode.value);
      return {
        bones: BONES.map(b => [A[b[0]][0], A[b[0]][1], A[b[1]][0], A[b[1]][1], b[2] || 5, ['el', 'wr'].includes(b[1]) ? 1 : .55]),
        head: A.head, arm2: ['sh', 'el', 'wr'].map(j => B[j]),
        balls: [{ x: A.wr[0], y: A.wr[1], color: 'var(--ink)', label: fbCode.value, dx: L ? -9 : 9, dy: -6 }, { x: B.wr[0], y: B.wr[1], color: col, label: bioCode.value, dx: L ? -9 : 9, dy: 12 }],
      };
    });
    const realBio = computed(() => !!stuffData.value?.pitches?.[0]?.release);
    const bioRows = computed(() => {
      if (realBio.value) {
        const rel = c => stuffData.value.pitches.find(x => x.code === c)?.release || {}, A = rel(fbCode.value), B = rel(bioCode.value);
        const row = (label, k, unit, d, flagAt) => A[k] == null || B[k] == null ? null
          : ({ label, a: A[k].toFixed(d) + unit, b: B[k].toFixed(d) + unit, d: signed(B[k] - A[k], d) + unit, flag: Math.abs(B[k] - A[k]) >= flagAt });
        return [row('Arm angle', 'arm', '°', 1, 2.5), row('Release height', 'height', ' ft', 2, 0.15), row('Release side', 'side', ' ft', 2, 0.12), row('Extension', 'ext', ' ft', 2, 0.25)].filter(Boolean);
      }
      const b = bioOf(bioCode.value), base = { arm: p.armAngle ?? 41, relH: 5.9, relS: 2.1, ext: p.extension, trunk: 38 };
      const row = (label, k, unit, d, flagAt) => ({ label, a: base[k].toFixed(d) + unit, b: (base[k] + b[k]).toFixed(d) + unit, d: signed(b[k], d) + unit, flag: Math.abs(b[k]) >= flagAt });
      return [row('Arm angle', 'arm', '°', 1, 2.5), row('Release height', 'relH', ' ft', 2, 0.15), row('Release side', 'relS', ' ft', 2, 0.12), row('Extension', 'ext', ' ft', 2, 0.25), row('Trunk rotation at release', 'trunk', '°', 1, 2.5)];
    });
    const bioTell = computed(() => {
      const flags = bioRows.value.filter(r => r.flag).map(r => r.label.toLowerCase());
      return flags.length >= 2
        ? { flag: true, text: `The ${(byCode(bioCode.value)?.name || bioCode.value).toLowerCase()} comes out with a different ${new Intl.ListFormat('en', { type: 'conjunction' }).format(flags)} than his ${(byCode(fbCode.value)?.name || 'fastball').toLowerCase()}. Review video with Baseball Sciences before changing the grip.` }
        : { flag: false, text: `Release looks like his ${(byCode(fbCode.value)?.name || 'fastball').toLowerCase()}. No tipping concern from these metrics.` };
    });
    let raf = 0, last = 0;
    function tick(ts) { if (!playing.value) return; const dt = last ? (ts - last) / 1000 : 0; last = ts; phase.value = (phase.value + dt * 0.9) % 4; raf = requestAnimationFrame(tick); }
    function togglePlay() { playing.value = !playing.value; last = 0; if (playing.value) raf = requestAnimationFrame(tick); else cancelAnimationFrame(raf); }

    /* ---------- registry cards ---------- */
    const GH = 'https://github.com/alowenthal10/wsh-pitching-problem-set/blob/claude/job-application-problem-312r2h/pipeline/location_model.py';
    function realCard(m) {
      const L = stuffMeta.value.location, v = L.validation || {}, b = L.blend;
      if (m.key === 'location') return { ...m, model: 'location_value', version: `fit on ${stuffMeta.value.season} Statcast`, status: 'live · real', url: GH, credit: 'This project · method and code',
        desc: 'Smoothed run value of each spot, by pitch type, count state, and batter side, relative to an average location in that situation.',
        note: `Split-half check, odd- vs even-day games (${v.pitchers} pitchers): Location in one half vs the other r = ${v.location_reliability}.` };
      return { ...m, model: 'pitching_blend', version: `fit on ${stuffMeta.value.season} Statcast`, status: 'live · real', url: GH, credit: 'This project · method and code',
        desc: `Blend fit to actual run value: ${b[1].toFixed(3)} × Stuff xRV + ${b[2].toFixed(3)} × Location value. Location's weight is ${Math.round((v.loc_weight ?? 1) * 100)}% of its fitted value, the share that best predicts results in held-out games. Output is in runs, which drives expected ERA.`,
        note: `Predicting run value in held-out games (odd- vs even-day split, ${v.pitchers} pitchers): Pitching r = ${v.pitching_predicts_2nd_half}, Stuff ${v.stuff_predicts_2nd_half}, Location ${v.location_predicts_2nd_half}, actual results ${v.actual_run_value_predicts_2nd_half}.` };
    }
    const registryCards = computed(() => [
      ...Object.values(MODELS).map(m => m.key !== 'stuff' && realModels.value ? realCard(m) : m.key === 'stuff' && realStuff.value ? { ...m, model: 'tjstuff_plus', version: stuffMeta.value.model.version, status: 'live · real',
        desc: 'Open-source Stuff model: predicts a pitch\'s expected run value from velocity, spin, extension, movement, release, and differences from his primary fastball.',
        credit: `${stuffMeta.value.model.author} · ${stuffMeta.value.model.license} License`, url: stuffMeta.value.model.url,
        note: `Scored on ${stuffMeta.value.pitches.toLocaleString()} ${stuffMeta.value.season} Statcast pitches through ${stuffMeta.value.through}. Grade = 50 + 10 × (tjStuff+ − pitch-type mean) ÷ spread.` } : m),
      ...FUTURE, { key: 'next', label: 'Next model', model: 'model_key', status: 'open slot', slot: 'any card, table column, or overlay', desc: 'Register outputs with a scale, SD, and stabilization point. The page renders it with no new front-end code.' }]);

    // ---- navigation between the leaderboard and player pages ----
    const crumbTeam = computed(() => stuffMeta.value?.pitchers?.find(x => x.id === p.id) || null);
    const leadersHref = (team) => './?' + new URLSearchParams({ ...(team ? { team } : {}), ...(SEASON !== SEASONS[0] ? { season: SEASON } : {}) });
    function toLeaders() { if (document.referrer && new URL(document.referrer).pathname === new URL('./', document.baseURI).pathname) history.back(); else location.href = leadersHref(); }
    function changeSeason(y) {
      const u = new URL(location.href);
      if (y === SEASONS[0]) u.searchParams.delete('season'); else u.searchParams.set('season', y);
      location.href = u.toString();
    }
    function go(id) { document.getElementById(id)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }

    /* ---------- data loading ---------- */
    async function loadPitcher(id) {
      try {
        const d = await mlb.person(id), per = d.people[0];
        const splits = (per.stats?.[0]?.splits || []).filter(s => !s.sport || s.sport.id === 1);
        const bySeason = {};
        for (const s of splits) {
          const k = +s.season, st = s.stat, o = bySeason[k] || (bySeason[k] = { season: k, ip: 0, er: 0, k: 0, bb: 0, hr: 0, hbp: 0, bf: 0 });
          o.ip += ipNum(st.inningsPitched || 0); o.er += +st.earnedRuns || 0; o.k += +st.strikeOuts || 0; o.bb += +st.baseOnBalls || 0; o.hr += +st.homeRuns || 0; o.hbp += +st.hitByPitch || 0; o.bf += +st.battersFaced || 0;
        }
        txRaw.value = per.transactions || [];
        resultsRaw.value = Object.values(bySeason).sort((a, b) => a.season - b.season).map(o => ({ ...o, era: o.ip ? o.er * 9 / o.ip : 0, ipText: Math.floor(o.ip) + '.' + Math.round((o.ip % 1) * 3) }));
        Object.assign(p, { id, name: per.fullName, team: per.currentTeam?.name || 'MLB', throws: per.pitchHand?.code || 'R', age: per.currentAge, height: per.height, role: (resultsRaw.value.at(-1)?.ip || 0) > 90 ? 'Starter' : 'Pitcher' });
        shotOk.value = true; live.value = true;
        await loadStuff(id);
      } catch (e) { setDemo(); }
      bats.value = p.throws === 'L' ? 'R' : 'L';
    }
    function setDemo() {
      live.value = false;
      Object.assign(p, { id: 0, name: 'Demo LHP', team: 'Synthetic data', throws: 'L', role: 'Starter', age: 27, height: '6\' 2"' });
      txRaw.value = DEMO_TX;
      stuffData.value = null;
      Object.assign(p, { armAngle: 41, extension: 6.6 });
      resultsRaw.value = DEMO_RESULTS.map(r => ({ ...r, ip: ipNum(r.ip), ipText: String(r.ip) }));
      bats.value = 'R';
    }
    // Real Stuff data built by pipeline/build_stuff.py (GitHub Actions) and the tjStuff+ model for Pitch Lab.
    async function loadStuffMeta() {
      try {
        const r = await fetch(`data/stuff/${SEASON}/index.json`);
        if (!r.ok) throw new Error(r.status);
        stuffMeta.value = await r.json();
        fetch('data/biomech/reference.json').then(r => r.ok ? r.json() : null).then(d => { if (d) obp.value = Object.freeze(d); }).catch(() => {});
        if (stuffMeta.value.location) fetch(`data/location/${SEASON}/surfaces.json`).then(r => r.ok ? r.json() : null).then(d => { if (d) locSurf.value = Object.freeze(d); }).catch(() => {});
        fetch('model/tjstuff_v3.json').then(r => r.ok ? r.json() : null).then(m => { if (m && window.TjStuff) tj.value = Object.freeze(new window.TjStuff(m)); }).catch(() => {});
      } catch (e) { stuffMeta.value = null; stuffStatus.value = 'Mock arsenal: real Stuff data has not been built for this site yet.'; }
    }
    async function loadStuff(id) {
      stuffData.value = null; surfKey = ''; hist.value = {};
      if (!stuffMeta.value || !id) return;
      try {
        const r = await fetch(`data/stuff/${SEASON}/${id}.json`);
        if (!r.ok) throw new Error(r.status);
        const d = await r.json();
        stuffData.value = Object.freeze(d);
        loadHistory(id, d);
        Object.assign(p, { armAngle: d.arm_angle, extension: d.extension });
        const lever = d.pitches.filter(x => x.usage >= 0.05).sort((a, b) => a.stuff_grade - b.stuff_grade)[0] || d.pitches[0];
        selected.value = lever.code; setLab(lever.code);
        bioCode.value = (d.pitches.find(x => x.code !== d.fastball.type) || d.pitches[0]).code;
      } catch (e) {
        stuffStatus.value = `Mock arsenal: no ${SEASON} Statcast data for this pitcher (fewer than 50 pitches, or not in this build).`;
      }
    }
    // Model data for earlier seasons (built by the same pipeline) plus league ERA, for Results vs. model.
    async function loadHistory(id, current) {
      const out = { [SEASON]: current };
      await Promise.all([SEASON - 1, SEASON].map(async (y) => {
        try {
          if (y !== SEASON) { const r = await fetch(`data/stuff/${y}/${id}.json`); if (r.ok) out[y] = await r.json(); }
          if (!lgEra.value[y]) {
            const t = await mlb.json(`${API}/teams/stats?season=${y}&group=pitching&stats=season&sportId=1`);
            let er = 0, ip = 0; for (const s of t.stats?.[0]?.splits || []) { er += +s.stat.earnedRuns || 0; ip += ipNum(s.stat.inningsPitched || 0); }
            if (ip) lgEra.value = { ...lgEra.value, [y]: er * 9 / ip };
          }
        } catch (e) { /* season missing: Results vs. model shows the seasons it has */ }
      }));
      hist.value = out;
    }
    async function loadTeams() {
      try {
        const d = await mlb.teams(SEASON);
        teams.value = d.teams.filter(t => t.sport?.id === 1 || !t.sport).map(t => ({ id: t.id, name: t.name })).sort((a, b) => a.name.localeCompare(b.name));
      } catch (e) { teams.value = []; }
    }
    // Pitchers on the team's active MLB roster (40-man if the active roster is empty, e.g. offseason).
    async function loadRoster(team) {
      try {
        let list = [];
        for (const type of ['active', '40Man']) {
          const d = await mlb.roster(team, SEASON, type);
          list = (d.roster || []).filter(r => r.position?.abbreviation === 'P').map(r => ({
            id: r.person.id, name: r.person.fullName,
            ip: ipNum(r.person.stats?.[0]?.splits?.[0]?.stat?.inningsPitched || 0),
          }));
          if (list.length) break;
        }
        roster.value = list.sort((a, b) => a.name.localeCompare(b.name));
      } catch (e) { roster.value = []; }
    }
    function defaultPitcher(team) {
      const r = roster.value;
      if (!r.length) return null;
      const named = team === DEFAULT_TEAM && r.find(x => DEFAULT_PITCHER.test(x.name));
      return (named || r.slice().sort((a, b) => b.ip - a.ip)[0]).id;
    }
    async function changeTeam(team) {
      await loadRoster(team);
      pitcherId.value = defaultPitcher(team);
      if (pitcherId.value) await loadPitcher(pitcherId.value);
    }

    const redrawAll = () => nextTick(() => { drawLab(); drawHeat(); });
    // Keep pitch selections valid when the arsenal changes (e.g. switching to a pitcher without a splitter).
    watch(arsenal, (a) => {
      const has = c => a.some(x => x.code === c);
      if (!has(selected.value)) selected.value = a[0].code;
      if (!has(labCode.value)) setLab(a[0].code);
      if (!has(bioCode.value) || bioCode.value === fbCode.value) bioCode.value = (a.find(x => x.code !== fbCode.value) || a[0]).code;
    }, { flush: 'sync' });
    watch([lab, labCode, arsenal, themeTick, tj], () => nextTick(drawLab));
    watch([selected, bats, heatMode, arsenal, themeTick, locSurf, () => p.throws], () => nextTick(drawHeat));

    onMounted(async () => {
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => themeTick.value++);
      new MutationObserver(() => themeTick.value++).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      // Start in demo state so the page is complete immediately, then hydrate from the API.
      setDemo();
      redrawAll();
      document.fonts?.ready.then(redrawAll);
      applyPreset(PRESETS.CH[1]);
      await loadStuffMeta();
      if (FIXED_ID) { pitcherId.value = FIXED_ID; await loadPitcher(FIXED_ID); }
      else await Promise.all([loadTeams(), changeTeam(DEFAULT_TEAM)]);
      redrawAll();
    });

    return { MODELS, SEASON, PHASES, BONES, counts: COUNTS, mlb, teams, teamId, changeTeam, live, shotOk, roster, pitcherId, season, p,
      initials: computed(() => p.name.split(' ').map(s => s[0]).join('').slice(0, 2)),
      selected, bats, heatMode, arsenal, totalPitches, selPitch, overall, headlineModels, months, trend, gx, gy,
      results, eraTicks, ex, ey, adjusted, drivers, bottomLine,
      labCode, labPitch, preset, labDelta, sliders, lab, presetsFor, presetDeltaText, setLab, resetLab, applyPreset, labCanvas, heatRefs, locRead,
      TX_CATS, TX_FILTERS, txFilter, txAll, txCounts, txFiltered, txShown, txSummary, txTimeline,
      bioCode, bioColor, phase, phaseName, playing, togglePlay, bioRows, bioTell, registryCards,
      show, gStyle, gradeBg, gradeInk, barW, pct, signed, roleFor, go, loadPitcher,
      SEASONS, fixedId: FIXED_ID, crumbTeam, leadersHref, toLeaders, changeSeason,
      realStuff, realModels, stuffMeta, stuffStatus, fbCode, trendPts, tag, bioView, bioViewMode, obpRef, fbArm, realBio, realDesign,
      mx: h => 30 + (h + 24) / 48 * 260, my: v => 270 - (v + 22) / 48 * 260 };
  }
}).component('site-search', Site.SiteSearch).mount('#app');
})();
