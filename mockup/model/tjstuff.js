/* Evaluates the exported tjStuff+ model (pipeline/export_model.py) in the browser.
   tjStuff+ by Thomas Nestico, MIT License: https://github.com/tnestico/tjstuff_plus */
(function (root) {
  function TjStuff(m) { this.m = m; this.n = m.features.length; }
  // Raw model output: expected run value of the pitch (lower is better for the pitcher).
  TjStuff.prototype.xrv = function (x) {
    const m = this.m, z = new Array(this.n);
    for (let i = 0; i < this.n; i++) z[i] = (x[i] - m.center[i]) / m.scale[i];
    let s = 0;
    for (const t of m.trees) {
      const f = t[0], thr = t[1], l = t[2], r = t[3], leaf = t[4];
      if (!f.length) { s += leaf[0]; continue; }
      let i = 0;
      for (;;) { const c = z[f[i]] <= thr[i] ? l[i] : r[i]; if (c < 0) { s += leaf[-c - 1]; break; } i = c; }
    }
    return s;
  };
  root.TjStuff = TjStuff;
  if (typeof module !== 'undefined') module.exports = TjStuff;
})(typeof window !== 'undefined' ? window : globalThis);
