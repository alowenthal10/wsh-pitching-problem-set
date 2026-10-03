/* Leaderboard: every qualified pitcher in a season, filterable by team, role, and sample; rows link to player pages. */
(async () => {
const { createApp, ref, reactive, computed, watch } = Vue;
const { HOME_TEAM, gStyle, show, fold, playerHref, teamSpot } = Site;
const QS = new URLSearchParams(location.search);
const SEASONS = await Site.seasons();
const MIN_CHOICES = [50, 150, 300, 1000];

const COLS = [
  { key: 'pitching_grade', label: 'Pitching', grade: true, desc: true, title: 'Pitching grade (20–80): Stuff and Location blended to predict run value' },
  { key: 'stuff_grade', label: 'Stuff', grade: true, desc: true, title: 'Stuff grade (20–80) from tjStuff+' },
  { key: 'loc_grade', label: 'Location', grade: true, desc: true, title: 'Location grade (20–80)' },
  { key: 'n', label: 'Pitches', num: 0, desc: true },
  { key: 'ip', label: 'IP', num: 1, desc: true },
  { key: 'era', label: 'ERA', num: 2, desc: false },
  { key: 'exp_era', label: 'xERA', num: 2, desc: false, title: 'Model-expected ERA from the Pitching model' },
];

createApp({
  template: `
<header class="topbar"><div class="wrap">
  <a class="brand" href="./">Pitcher Page</a>
  <site-search :season="season" :latest="SEASONS[0]"></site-search>
  <span class="badge live" title="Statcast and MLB Stats API, rebuilt daily">Real data</span>
</div></header>
<main class="wrap lb">
  <div class="lb-head">
    <div>
      <div class="eyebrow">{{ season }} season · MLB</div>
      <h1>Pitching leaders</h1>
      <p>Every qualified pitcher, graded on the 20–80 scale by the models on the player pages. <span class="spot-inline"><img class="spot" :src="teamSpot(HOME_TEAM, 120)" alt="" @error="$event.target.remove()"></span>Nationals pitchers are highlighted. Select a row to open a pitcher's page.</p>
    </div>
  </div>

  <div class="lb-controls">
    <label class="ctl"><span class="eyebrow">Season</span>
      <select id="lb-season" v-model.number="season"><option v-for="y in SEASONS" :key="y" :value="y">{{ y }}</option></select></label>
    <label class="ctl"><span class="eyebrow">Team</span>
      <select id="lb-team" v-model="team"><option value="">All teams</option><option v-for="t in teams" :key="t.abbr" :value="t.abbr">{{ t.name }}</option></select></label>
    <div class="ctl"><span class="eyebrow">Role</span>
      <div class="seg" role="group" aria-label="Role">
        <button v-for="r in ['', 'SP', 'RP']" :key="r" :aria-pressed="role === r" @click="role = r">{{ r === '' ? 'All' : r === 'SP' ? 'Starters' : 'Relievers' }}</button>
      </div></div>
    <label class="ctl"><span class="eyebrow">Min. pitches</span>
      <select id="lb-min" v-model.number="minN"><option v-for="m in MIN_CHOICES" :key="m" :value="m">{{ m }}+</option></select></label>
    <label class="ctl" style="flex:1 1 180px;max-width:260px"><span class="eyebrow">Filter names</span>
      <input id="lb-q" type="search" v-model="q" placeholder="e.g. Cavalli" autocomplete="off"></label>
    <button class="btn" @click="team = team === HOME_TEAM ? '' : HOME_TEAM" :aria-pressed="team === HOME_TEAM">{{ team === HOME_TEAM ? 'Show all teams' : 'Nationals only' }}</button>
  </div>

  <div class="lb-note">
    <span><b>Qualified pitchers only.</b> The leaderboard and search include pitchers with 50 or more pitches in {{ season }}. The default view shows 300+ pitches, because grades on smaller samples are noisy.</span>
    <span v-if="meta">Statcast through {{ meta.through }} · {{ rows.length }} of {{ all.length }} pitchers shown.</span>
  </div>

  <div class="panel tablewrap" style="padding:4px 8px">
    <p v-if="error" class="empty">{{ error }}</p>
    <table v-else>
      <thead><tr>
        <th>#</th><th>Pitcher</th><th class="c">Team</th><th>Role</th>
        <th v-for="c in COLS" :key="c.key" class="sortable" :class="c.grade ? 'c' : 'r'" :title="c.title" :aria-sort="sortKey === c.key ? (sortDesc ? 'descending' : 'ascending') : 'none'" @click="sortBy(c)">{{ c.label }}</th>
        <th class="c" title="His best pitch by Stuff grade (5%+ usage)">Best pitch</th>
      </tr></thead>
      <tbody>
        <tr v-for="(x, i) in rows" :key="x.id" :class="{ home: x.team === HOME_TEAM }" tabindex="0" @click="open(x)" @keydown.enter="open(x)">
          <td class="rank">{{ i + 1 }}</td>
          <td><div class="who">
            <img :src="'https://midfield.mlbstatic.com/v1/people/' + x.id + '/spots/60'" alt="" loading="lazy" @error="$event.target.style.visibility = 'hidden'">
            <div><a :href="href(x)" @click.stop>{{ x.name }}</a><div class="small muted">{{ x.throws === 'L' ? 'LHP' : 'RHP' }}</div></div>
          </div></td>
          <td class="c">
            <img v-if="teamSpot(x.team, x.team_id) && !badSpot[x.team]" class="spot" :class="{ home: x.team === HOME_TEAM }" :src="teamSpot(x.team, x.team_id)"
                 :alt="x.team_name || x.team" :title="x.team_name || x.team" loading="lazy" @error="badSpot[x.team] = true">
            <span v-else class="team-chip" :class="{ home: x.team === HOME_TEAM }" :title="x.team_name">{{ x.team || '—' }}</span>
          </td>
          <td class="small">{{ x.role || '—' }}</td>
          <td v-for="c in COLS" :key="c.key" :class="c.grade ? 'c' : 'r num'">
            <span v-if="c.grade && x[c.key] != null" class="g" :style="gStyle(x[c.key])" :title="String(x[c.key])">{{ show(x[c.key]) }}</span>
            <template v-else>{{ x[c.key] != null ? (c.grade ? '—' : Number(x[c.key]).toFixed(c.num)) : '—' }}</template>
          </td>
          <td class="c"><span v-if="x.best" class="mono small">{{ x.best.code }} <span class="g" :style="gStyle(x.best.grade)">{{ show(x.best.grade) }}</span></span></td>
        </tr>
        <tr v-if="!rows.length && !error"><td :colspan="COLS.length + 5" class="empty">No pitchers match these filters.</td></tr>
      </tbody>
    </table>
  </div>
  <footer>
    <p>Stuff grades: <a href="https://github.com/tnestico/tjstuff_plus" target="_blank" rel="noopener">tjStuff+</a> by Thomas Nestico (MIT License). Location and Pitching grades and xERA: this project's models, fit on Statcast (<a href="https://github.com/alowenthal10/wsh-pitching-problem-set" target="_blank" rel="noopener">code, PRD, and method</a>). Innings and ERA from the MLB Stats API. Data © MLB Advanced Media, used for non-commercial purposes.</p>
  </footer>
</main>`,
  setup() {
    const season = ref(SEASONS.includes(+QS.get('season')) ? +QS.get('season') : SEASONS[0]);
    const team = ref(QS.get('team') || ''), role = ref(QS.get('role') || ''), q = ref(QS.get('q') || '');
    const minN = ref(MIN_CHOICES.includes(+QS.get('min')) ? +QS.get('min') : 300);
    const sortKey = ref(QS.get('sort') || 'pitching_grade'), sortDesc = ref(QS.get('dir') !== 'asc');
    const meta = ref(null), people = ref([]), error = ref('');
    const badSpot = reactive({});   // teams whose logo failed to load fall back to the abbreviation
    const bySlug = computed(() => new Map(people.value.map(p => [p.id, p])));

    async function load() {
      error.value = '';
      try {
        const r = await fetch(`data/stuff/${season.value}/index.json`);
        if (!r.ok) throw new Error(r.status);
        meta.value = await r.json();
      } catch (e) {
        meta.value = null;
        error.value = 'League data has not been built for this site yet. It is produced by the GitHub Actions pipeline (see the README).';
      }
    }
    Site.people().then(p => { people.value = p; });
    if (season.value) load(); else error.value = 'League data has not been built for this site yet. It is produced by the GitHub Actions pipeline (see the README).';
    watch(season, load);

    const all = computed(() => meta.value?.pitchers || []);
    const teams = computed(() => {
      const m = new Map();
      for (const x of all.value) if (x.team) m.set(x.team, x.team_name || x.team);
      return [...m].map(([abbr, name]) => ({ abbr, name })).sort((a, b) => a.name.localeCompare(b.name));
    });
    const rows = computed(() => {
      const f = fold(q.value.trim()), k = sortKey.value, dir = sortDesc.value ? -1 : 1;
      return all.value
        .filter(x => x.n >= minN.value && (!team.value || x.team === team.value) && (!role.value || x.role === role.value) && (!f || fold(x.name).includes(f)))
        .slice().sort((a, b) => (a[k] == null) - (b[k] == null) || dir * ((a[k] ?? 0) - (b[k] ?? 0)) || b.n - a.n);
    });
    function sortBy(c) { if (sortKey.value === c.key) sortDesc.value = !sortDesc.value; else { sortKey.value = c.key; sortDesc.value = c.desc; } }
    const href = x => { const pp = bySlug.value.get(x.id); return pp ? playerHref(pp, season.value, SEASONS[0]) : `player.html?id=${x.id}`; };
    const open = x => { location.href = href(x); };

    // keep filters in the URL so a view can be shared
    watch([season, team, role, minN, q, sortKey, sortDesc], () => {
      const u = new URLSearchParams();
      if (season.value !== SEASONS[0]) u.set('season', season.value);
      if (team.value) u.set('team', team.value);
      if (role.value) u.set('role', role.value);
      if (minN.value !== 300) u.set('min', minN.value);
      if (q.value) u.set('q', q.value);
      if (sortKey.value !== 'pitching_grade' || !sortDesc.value) { u.set('sort', sortKey.value); u.set('dir', sortDesc.value ? 'desc' : 'asc'); }
      history.replaceState(null, '', location.pathname + (u.toString() ? '?' + u : ''));
    });

    return { SEASONS, MIN_CHOICES, COLS, HOME_TEAM, season, team, role, q, minN, sortKey, sortDesc, meta, all, teams, rows, error,
      sortBy, href, open, gStyle, show, teamSpot, badSpot };
  },
}).component('site-search', Site.SiteSearch).mount('#app');
})();
