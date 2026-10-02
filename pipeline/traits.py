"""Traits the pitch models don't see, release metrics, seam-shifted wake, and pitch-design comps.

All from one season of Statcast. Grades are 50 + 10 * z-score among pitchers with 300+ pitches
(clipped to 20-80), oriented so higher is better for the pitcher.

Seam-shifted wake: Statcast's spin_axis is the measured spin axis; the ball's actual movement
direction comes from pfx_x / pfx_z. On a pure Magnus pitch the two agree. The mapping between them
is calibrated on the data (fastballs, where seam effects are small) instead of assumed, and the
deviation is reported in the pitcher's frame (positive = movement rotated toward his arm side).
"""
import numpy as np
import pandas as pd

QUALIFIED = 300
Y_PLATE = 17 / 12


def _wrap(a):
    return (a + 180) % 360 - 180


def add_trait_features(df):
    df = df.copy()
    hand = np.where(df["p_throws"] == "L", 1.0, -1.0)      # catcher-view x -> arm side positive
    df["rel_side"] = hand * df["release_pos_x"] if "release_pos_x" in df else np.nan
    df["rel_height"] = df["release_pos_z"] if "release_pos_z" in df else np.nan
    # vertical approach angle at the plate from the 9-parameter fit
    vyf = -np.sqrt(np.maximum(df["vy0"] ** 2 - 2 * df["ay"] * (50 - Y_PLATE), 0))
    t = (vyf - df["vy0"]) / df["ay"]
    vzf = df["vz0"] + df["az"] * t
    df["vaa"] = -np.degrees(np.arctan(vzf / vyf))
    df["perceived_gain"] = (df["effective_speed"] - df["release_speed"]) if "effective_speed" in df else np.nan
    # movement direction in the pitcher's frame: 0 = straight up, + toward arm side
    hb_arm = hand * df["pfx_x"]
    df["move_angle"] = np.degrees(np.arctan2(hb_arm, df["pfx_z"]))
    df["ssw_dev"] = np.nan
    if "spin_axis" in df and df["spin_axis"].notna().any():
        fb = df[(df["pitch_type"] == "FF") & df["spin_axis"].notna()]      # four-seamers carry the least seam effect
        if len(fb) < 1000:
            fb = df[df["pitch_type"].isin(["FF", "SI", "FC"]) & df["spin_axis"].notna()]
        raw = np.degrees(np.arctan2(fb["pfx_x"], fb["pfx_z"]))   # catcher-view movement direction
        best = None
        for sgn in (1, -1):     # spin_axis = sgn * movement direction + offset; pick the tighter fit
            d = np.radians(fb["spin_axis"] - sgn * raw)
            off = np.degrees(np.arctan2(np.sin(d).mean(), np.cos(d).mean()))
            spread = 1 - np.hypot(np.sin(d).mean(), np.cos(d).mean())
            if best is None or spread < best[2]:
                best = (sgn, off, spread)
        sgn, off, _ = best
        spin_dir = (df["spin_axis"] - off) / sgn                     # movement direction implied by spin (catcher view)
        dev_catcher = _wrap(np.degrees(np.arctan2(df["pfx_x"], df["pfx_z"])) - spin_dir)
        df["ssw_dev"] = hand * dev_catcher                         # mirror to the pitcher's frame
    return df


def _z(series, pool):
    mu, sd = pool.mean(), pool.std()
    return (series - mu) / sd if sd and sd > 0 else series * 0


def _grade(z, sign=1):
    return np.clip(50 + 10 * sign * z, 20, 80)


def pitcher_traits(df):
    """{pitcher_id: [trait, ...]} for the 'Traits the pitch models don't see' panel."""
    n = df.groupby("pitcher").size()
    fbt = df.groupby("pitcher")["fb_type"].first()
    fb = df[df["pitch_type"] == df["pitcher"].map(fbt)]
    rows = pd.DataFrame(index=n.index)
    rows["n"] = n
    rows["ext"] = fb.groupby("pitcher")["extension"].mean()
    rows["gain"] = fb.groupby("pitcher")["perceived_gain"].mean()
    # approach angle above what his pitch heights would predict, per fastball type
    fbv = fb[fb["vaa"].notna()].copy()
    fbv["vaa_x"] = np.nan
    for pt, g in fbv.groupby("pitch_type"):
        c = np.polyfit(g["plate_z"], g["vaa"], 1)
        fbv.loc[g.index, "vaa_x"] = g["vaa"] - np.polyval(c, g["plate_z"])
    rows["vaa"] = fbv.groupby("pitcher")["vaa"].mean()
    rows["vaa_x"] = fbv.groupby("pitcher")["vaa_x"].mean()
    # release consistency and arm-angle differences between the fastball and everything else
    rel = df.groupby(["pitcher", "pitch_type"]).agg(n=("rel_side", "size"), side=("rel_side", "mean"), z=("rel_height", "mean"),
                                                     arm=("arm_angle", "mean") if "arm_angle" in df else ("rel_side", "size"))
    dist, armd = {}, {}
    for pid, g in rel.groupby(level=0):
        g = g.droplevel(0)
        f = fbt.get(pid)
        if f not in g.index or len(g) < 2:
            continue
        sec = g.drop(index=f)
        w = sec["n"] / sec["n"].sum()
        dist[pid] = float((w * np.hypot(sec["side"] - g.loc[f, "side"], sec["z"] - g.loc[f, "z"])).sum() * 12)
        if "arm_angle" in df:
            armd[pid] = float((w * (sec["arm"] - g.loc[f, "arm"]).abs()).sum())
    rows["rel_dist"] = pd.Series(dist)
    rows["arm_diff"] = pd.Series(armd)
    # times through the order: run value per pitch (pitcher's view) third time vs first time
    if "n_thruorder_pitcher" in df and df["rv"].notna().any():
        t = df[df["rv"].notna()]
        first = t[t["n_thruorder_pitcher"] == 1].groupby("pitcher")["rv"].agg(["mean", "size"])
        third = t[t["n_thruorder_pitcher"] >= 3].groupby("pitcher")["rv"].agg(["mean", "size"])
        tto = (third["mean"] - first["mean"]).where(third["size"] >= 150)
        rows["tto"] = tto - tto.mean()          # runs per pitch worse than the league's usual penalty
        rows["tto_n"] = third["size"]
    pool = rows[rows["n"] >= QUALIFIED]
    def trait(pid, key, name, value_fmt, note, sign=1, unit=""):
        v = rows.at[pid, key] if key in rows and pid in rows.index else np.nan
        if pd.isna(v):
            return {"name": name, "grade": None, "value": None, "note": note}
        g = float(_grade(_z(pd.Series([v]), pool[key].dropna()).iloc[0], sign))
        return {"name": name, "grade": round(g, 1), "value": value_fmt(v), "note": note}
    out = {}
    for pid in rows.index:
        out[int(pid)] = [
            trait(pid, "gain", "Extension & perceived velocity", lambda v: f"{v:+.1f} mph",
                  f"Fastball plays {rows.at[pid, 'gain']:+.1f} mph faster than its release speed from {rows.at[pid, 'ext']:.1f} ft of extension." if pd.notna(rows.at[pid, 'gain']) else "No effective-speed data."),
            trait(pid, "vaa_x", "Fastball approach angle", lambda v: f"{v:+.2f}°",
                  f"Fastball arrives at {rows.at[pid, 'vaa']:.1f}°, {abs(rows.at[pid, 'vaa_x']):.2f}° {'flatter' if rows.at[pid, 'vaa_x'] > 0 else 'steeper'} than expected for where he throws it." if pd.notna(rows.at[pid, 'vaa_x']) else "Not enough fastballs."),
            trait(pid, "rel_dist", "Release-point consistency", lambda v: f"{v:.1f} in",
                  f"Secondaries leave his hand {rows.at[pid, 'rel_dist']:.1f} in from the fastball's release point, on average. Smaller hides pitches longer." if pd.notna(rows.at[pid, 'rel_dist']) else "Only one pitch type.", sign=-1),
            trait(pid, "tto", "Times through the order", lambda v: f"{v * 100:+.2f} runs/100",
                  (f"Third time through, he allows {rows.at[pid, 'tto'] * 100:+.2f} runs per 100 pitches relative to the league's usual penalty ({int(rows.at[pid, 'tto_n'])} pitches)."
                   if "tto" in rows and pd.notna(rows.at[pid, 'tto']) else "Fewer than 150 pitches the third time through the order."), sign=-1),
            trait(pid, "arm_diff", "Arm-angle tell risk", lambda v: f"{v:.1f}°",
                  f"Secondaries come from an arm angle {rows.at[pid, 'arm_diff']:.1f}° different from the fastball, on average. Bigger gaps are easier to read." if "arm_diff" in rows and pd.notna(rows.at[pid, 'arm_diff']) else "No arm-angle data.", sign=-1),
        ]
    return out


def pitch_release(p):
    """Release metrics and seam-shifted wake for one pitcher's pitch type."""
    m = lambda c: round(float(p[c].mean()), 2) if c in p and p[c].notna().any() else None
    dev = p["ssw_dev"].dropna()
    ssw = round(float(np.degrees(np.arctan2(np.sin(np.radians(dev)).mean(), np.cos(np.radians(dev)).mean()))), 1) if len(dev) >= 10 else None
    return {"arm": m("arm_angle"), "height": m("rel_height"), "side": m("rel_side"), "ext": m("extension"), "ssw_dev": ssw}


def league_design(df):
    """Pitch-design references: shape of top-quarter Stuff pitches by type and 10-degree arm-angle bucket,
    and the league distribution of seam-shifted-wake deviation by type."""
    g = df.groupby(["pitcher", "pitch_type"]).agg(n=("tj", "size"), tj=("tj", "mean"), speed_diff=("speed_diff", "mean"),
                                                   ivb=("pfx_z", "mean"), hbx=("pfx_x", "mean"), hand=("p_throws", "first"),
                                                   arm=("arm_angle", "mean") if "arm_angle" in df else ("tj", "size"),
                                                   ssw=("ssw_dev", "median")).reset_index()
    g = g[g["n"] >= 100]
    g["ivb"] *= 12
    g["hb"] = np.where(g["hand"] == "L", 1, -1) * g["hbx"] * 12
    comps, ssw = {}, {}
    for pt, t in g.groupby("pitch_type"):
        top = t[t["tj"] >= t["tj"].quantile(0.75)]
        if len(top) < 5:
            continue
        entry = {"all": {"n": int(len(top)), "speed_diff": round(float(top["speed_diff"].mean()), 1),
                         "ivb": round(float(top["ivb"].mean()), 1), "hb": round(float(top["hb"].mean()), 1)}}
        if "arm_angle" in df:
            for b, tb in top.groupby((top["arm"] // 10 * 10).astype(int)):
                if len(tb) >= 5:
                    entry[str(b)] = {"n": int(len(tb)), "speed_diff": round(float(tb["speed_diff"].mean()), 1),
                                     "ivb": round(float(tb["ivb"].mean()), 1), "hb": round(float(tb["hb"].mean()), 1)}
        comps[pt] = entry
        s = t["ssw"].dropna()
        if len(s) >= 20:
            ssw[pt] = {"p25": round(float(s.quantile(0.25)), 1), "p50": round(float(s.median()), 1), "p75": round(float(s.quantile(0.75)), 1)}
    return {"comps": comps, "ssw": ssw}
