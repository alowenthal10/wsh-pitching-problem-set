"""Location and Pitching models for the pitcher page, fit on one season of Statcast.

Location model
  For each pitch type, count state (ahead / even / behind) and batter side (same / opposite hand
  as the pitcher), average the run value of every pitch thrown at each spot on a 0.1 ft grid, then
  smooth with a Gaussian kernel and shrink thin cells toward the situation average. The kernel width
  is chosen by fitting on odd days and keeping the width whose surfaces best predict even-day run values.
  A pitch's location value is its cell's smoothed run value minus the situation average, so it
  measures where the pitch was thrown and not the count it was thrown in.
  Coordinates are the catcher's view with x mirrored for left-handed pitchers (so +x is always the
  pitcher's glove side), and height rescaled to each batter's strike zone (1.5 to 3.5 ft).

Pitching model
  A least-squares blend of the tjStuff+ prediction and the location value, fit to each pitch's
  actual run value. Location fits same-game outcomes far better than it predicts later ones, so its
  weight is then shrunk to the share (0-100%) that best predicts second-half run value per pitcher
  from first-half data. The output is in runs per pitch, which gives model-expected runs and ERA.

Scaling matches tjStuff+: per-pitch plus = 100 - 10 * z-score (lower run value is better), a
pitcher's plus is the mean over his pitches, and 20-80 grades use the per-pitch-type spread.
"""
import numpy as np
import pandas as pd

GRID = {"x0": -2.0, "dx": 0.1, "nx": 41, "z0": 0.0, "dz": 0.1, "nz": 51}
SIGMA_CHOICES = (2.0, 3.0, 4.0, 5.0)   # kernel widths tried, in 0.1-ft bins; the data picks one
PRIOR_PITCHES = 100       # shrinkage toward the situation average
MIN_SURFACE_PITCHES = 15000
FALLBACK = {"SI": "FF", "FC": "FF", "FA": "FF", "ST": "SL", "SV": "CU", "KC": "CU", "CS": "CU", "EP": "CU",
            "FS": "CH", "FO": "CH", "SC": "CH", "KN": "CH"}
COUNTS = ("ahead", "even", "behind")
SIDES = ("same", "opp")


def add_location_features(df):
    """Run value (batter's perspective), mirrored x, zone-scaled height, count state, batter side."""
    df = df.copy()
    rv = df["delta_run_exp"]
    # Savant's sign convention is checked from the data: a ball must help the batter.
    sign = 1.0 if rv[df["description"] == "ball"].mean() > 0 else -1.0
    df["rv"] = sign * rv
    df["lx"] = np.where(df["p_throws"] == "L", -df["plate_x"], df["plate_x"])
    if {"sz_top", "sz_bot"} <= set(df.columns):
        span = (df["sz_top"] - df["sz_bot"]).where(lambda s: s > 0.5)
        df["lz"] = (1.5 + 2 * (df["plate_z"] - df["sz_bot"]) / span).fillna(df["plate_z"])
    else:
        df["lz"] = df["plate_z"]
    df["count_state"] = np.select([df["strikes"] > df["balls"], df["strikes"] == df["balls"]], ["ahead", "even"], "behind")
    df["side"] = np.where(df["stand"] == df["p_throws"], "same", "opp")
    return df


def surface_types(df):
    counts = df["pitch_type"].value_counts()
    own = set(counts[counts >= MIN_SURFACE_PITCHES].index)
    def to_type(pt):
        if pt in own:
            return pt
        fb = FALLBACK.get(pt, "FF")
        return fb if fb in own else (FALLBACK.get(fb, "FF") if FALLBACK.get(fb, "FF") in own else "FF")
    return {pt: to_type(pt) for pt in counts.index}, sorted(own)


def _bins(df):
    ix = np.clip(np.rint((df["lx"].to_numpy() - GRID["x0"]) / GRID["dx"]), 0, GRID["nx"] - 1).astype(int)
    iz = np.clip(np.rint((df["lz"].to_numpy() - GRID["z0"]) / GRID["dz"]), 0, GRID["nz"] - 1).astype(int)
    return iz, ix


def _blur(a, sigma):
    r = int(3 * sigma)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    a = np.apply_along_axis(lambda v: np.convolve(v, k, mode="same"), 0, a)
    return np.apply_along_axis(lambda v: np.convolve(v, k, mode="same"), 1, a)


def fit_surfaces(df, type_map, sigma):
    """{surface_type: {count_state: {side: 2-D array of location value}}} from rows with run value."""
    d = df[df["rv"].notna()].assign(st=df["pitch_type"].map(type_map))
    out = {}
    for (st, cs, side), g in d.groupby(["st", "count_state", "side"]):
        iz, ix = _bins(g)
        s = np.zeros((GRID["nz"], GRID["nx"])); n = np.zeros_like(s)
        np.add.at(s, (iz, ix), g["rv"].to_numpy()); np.add.at(n, (iz, ix), 1.0)
        m = float(g["rv"].mean())
        out.setdefault(st, {}).setdefault(cs, {})[side] = (_blur(s, sigma) + PRIOR_PITCHES * m) / (_blur(n, sigma) + PRIOR_PITCHES) - m
    return out


def location_values(df, surfaces, type_map):
    iz, ix = _bins(df)
    v = np.zeros(len(df))
    st = df["pitch_type"].map(type_map).to_numpy()
    cs, side = df["count_state"].to_numpy(), df["side"].to_numpy()
    for key in set(zip(st, cs, side)):
        mask = (st == key[0]) & (cs == key[1]) & (side == key[2])
        grid = surfaces.get(key[0], {}).get(key[1], {}).get(key[2])
        if grid is not None:
            v[mask] = grid[iz[mask], ix[mask]]
    return v


def fit_blend(df):
    """Least squares: actual run value ~ b0 + b1 * stuff xRV + b2 * location value."""
    d = df[df["rv"].notna()]
    X = np.column_stack([np.ones(len(d)), d["xrv"], d["loc_v"]])
    b, *_ = np.linalg.lstsq(X, d["rv"].to_numpy(), rcond=None)
    return [float(x) for x in b]


def plus(v):
    """Per-pitch plus scale: 100 average, 10 per standard deviation, lower run value is better."""
    return 100 - 10 * (v - v.mean()) / v.std()


def halves(df):
    day = pd.to_datetime(df["game_date"]).dt.dayofyear
    return df[day % 2 == 1].copy(), df[day % 2 == 0].copy()


def choose_sigma(df):
    """Kernel width whose odd-day surfaces best predict even-day pitch run values."""
    h1, h2 = halves(df)
    type_map, _ = surface_types(h1)
    test = h2[h2["rv"].notna()]
    scores = {}
    for sg in SIGMA_CHOICES:
        v = location_values(test, fit_surfaces(h1, type_map, sg), type_map)
        scores[sg] = float(np.corrcoef(v, test["rv"])[0, 1])
    best = max(scores, key=scores.get)
    return best, {f"{s / 10:.1f} ft": round(c, 4) for s, c in scores.items()}


def blend_values(df, b, lam):
    """Pitching xRV with the location weight scaled by lam, re-centered so it averages the actual run value."""
    raw = b[1] * df["xrv"] + lam * b[2] * df["loc_v"]
    return raw - raw.mean() + df["rv"].mean()


def apply(df, sigma, lam=1.0):
    """Fit both models on df and add loc_v, loc, pxrv, pitching columns. Returns (df, artifacts)."""
    type_map, own = surface_types(df)
    surfaces = fit_surfaces(df, type_map, sigma)
    df["loc_v"] = location_values(df, surfaces, type_map)
    ols = fit_blend(df)
    df["pxrv"] = blend_values(df, ols, lam)
    blend = [float(df["pxrv"].mean() - (ols[1] * df["xrv"] + lam * ols[2] * df["loc_v"]).mean()), ols[1], lam * ols[2]]
    loc_mean, loc_sd = float(df["loc_v"].mean()), float(df["loc_v"].std())
    df["loc"] = plus(df["loc_v"])
    df["pitching"] = plus(df["pxrv"])
    return df, {"type_map": type_map, "surface_types": own, "surfaces": surfaces, "blend": blend, "ols_blend": ols, "loc_weight": lam, "sigma_ft": sigma / 10,
                "loc_mean": loc_mean, "loc_sd": loc_sd, "pxrv_mean": float(df["pxrv"].mean())}


def surfaces_json(art):
    """Heatmap grids as 20-80 grades (ints), row-major from the bottom of the zone up."""
    m, sd = art["loc_mean"], art["loc_sd"]
    types = {}
    for st, by_count in art["surfaces"].items():
        types[st] = {cs: {side: np.clip(np.rint(50 - 10 * (g - m) / sd), 20, 80).astype(int).ravel().tolist()
                          for side, g in by_side.items()} for cs, by_side in by_count.items()}
    return {"grid": GRID, "frame": "catcher's view, x mirrored for LHP (+x = glove side); z scaled to the batter's zone (1.5-3.5 ft)",
            "type_map": art["type_map"], "types": types, "blend": art["blend"]}


def split_half(df, sigma, min_pitches=200):
    """Fit on odd days, test on even days. Chooses the Pitching model's location weight, then reports how
    stable each metric is across halves and how well each first-half metric predicts the second half's
    actual run value per pitch."""
    h1, h2 = halves(df)
    h1, art = apply(h1, sigma)
    h2["loc_v"] = location_values(h2, art["surfaces"], art["type_map"])
    agg = lambda h, cols: h.groupby("pitcher").agg(n=("rv", "size"), **{c: (c, "mean") for c in cols})
    ols = art["ols_blend"]
    for h in (h1, h2):
        h["a_"] = -h["rv"]                        # higher is better
        h["s_"], h["l_"] = -h["xrv"], -h["loc_v"]
    # location weight: the share of the fitted coefficient that best predicts the second half
    a2 = agg(h2, ["a_"])
    weights = {}
    for lam in np.round(np.linspace(0, 1, 11), 1):
        h1["p_"] = -blend_values(h1, ols, lam)
        m = agg(h1, ["p_"]).join(a2, lsuffix="1", rsuffix="2", how="inner")
        m = m[(m["n1"] >= min_pitches) & (m["n2"] >= min_pitches)]
        weights[float(lam)] = float(m["p_"].corr(m["a_"]))
    lam = max(weights, key=weights.get)
    h1["p_"] = -blend_values(h1, ols, lam)
    h2["p_"] = -blend_values(h2, ols, lam)
    m = agg(h1, ["s_", "l_", "p_", "a_"]).join(agg(h2, ["s_", "l_", "p_", "a_"]), lsuffix="1", rsuffix="2", how="inner")
    m = m[(m["n1"] >= min_pitches) & (m["n2"] >= min_pitches)]
    out = {"pitchers": int(len(m)), "min_pitches_per_half": min_pitches, "loc_weight": lam,
           "loc_weight_choice": {f"{k:.0%}": round(v, 3) for k, v in weights.items()}}
    for k, name in (("s_", "stuff"), ("l_", "location"), ("p_", "pitching"), ("a_", "actual_run_value")):
        out[f"{name}_reliability"] = round(float(m[f"{k}1"].corr(m[f"{k}2"])), 3)
        out[f"{name}_predicts_2nd_half"] = round(float(m[f"{k}1"].corr(m["a_2"])), 3)
    return out
