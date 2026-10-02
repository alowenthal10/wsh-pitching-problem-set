/* Shared by the leaderboard (index.html) and player pages: grade colors, data paths, header search. */
(function () {
  const HOME_TEAM = 'WSH';   // Washington Nationals, highlighted on the leaderboard
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const show = g => Math.round(g / 5) * 5;
  const mix = g => { const t = clamp((g - 50) / 30, -1, 1), p = Math.round(Math.abs(t) * 100); return t >= 0 ? `color-mix(in oklab, var(--g-hi) ${p}%, var(--g-mid))` : `color-mix(in oklab, var(--g-lo) ${p}%, var(--g-mid))`; };
  const gStyle = g => { const t = (show(g) - 50) / 30; return { background: mix(show(g)), color: Math.abs(t) > 0.45 ? '#FFFFFF' : 'var(--ink)' }; };
  const fold = s => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

  let peopleP = null, seasonsP = null;
  const getJSON = url => fetch(url).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
  const people = () => peopleP || (peopleP = getJSON('data/pitchers.json').catch(() => []));
  const seasons = () => seasonsP || (seasonsP = getJSON('data/seasons.json').catch(() => []));
  // Player page URL, relative to the site root (player pages set <base href="../">).
  const playerHref = (p, season, latest) => `${p.slug}/` + (season && latest && season !== latest ? `?season=${season}` : '');

  const SiteSearch = {
    props: { season: Number, latest: Number },
    data: () => ({ q: '', open: false, active: 0, all: [] }),
    async mounted() { this.all = await people(); },
    computed: {
      results() {
        const q = fold(this.q.trim());
        if (q.length < 2) return [];
        const parts = q.split(/\s+/);
        return this.all
          .filter(p => { const n = fold(p.name); return parts.every(w => n.includes(w)); })
          .map(p => ({ p, rank: fold(p.name).split(/\s+/).some(w => w.startsWith(parts[0])) ? 0 : 1 }))
          .sort((a, b) => a.rank - b.rank || a.p.name.localeCompare(b.p.name))
          .slice(0, 8).map(x => x.p);
      },
    },
    methods: {
      href(p) { return playerHref(p, p.seasons.includes(this.season) ? this.season : p.seasons[0], this.latest); },
      go(p) { if (p) location.href = this.href(p); },
      close() { setTimeout(() => { this.open = false; }, 150); },
      key(e) {
        if (e.key === 'ArrowDown') { this.active = Math.min(this.active + 1, this.results.length - 1); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { this.active = Math.max(this.active - 1, 0); e.preventDefault(); }
        else if (e.key === 'Enter') this.go(this.results[this.active]);
        else if (e.key === 'Escape') this.open = false;
      },
    },
    template: `
      <div class="search" @focusout="close">
        <input id="site-search" type="search" v-model="q" @focus="open = true" @input="open = true; active = 0" @keydown="key"
               placeholder="Search pitchers" aria-label="Search pitchers" autocomplete="off" role="combobox" :aria-expanded="open && results.length > 0">
        <ul v-if="open && results.length" class="search-results" role="listbox">
          <li v-for="(p, i) in results" :key="p.id" role="option" :aria-selected="i === active">
            <a :href="href(p)" :class="{ active: i === active }" @mouseenter="active = i">{{ p.name }}<span class="muted small mono"> {{ p.seasons.join(', ') }}</span></a>
          </li>
        </ul>
      </div>`,
  };

  window.Site = { HOME_TEAM, clamp, show, gStyle, fold, people, seasons, playerHref, SiteSearch };
})();
