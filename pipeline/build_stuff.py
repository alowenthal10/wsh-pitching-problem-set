"""Build real Stuff data for the pitcher page from Statcast and tjStuff+.

  python pipeline/build_stuff.py --season 2026 --model path/to/lgbm_model_2020_2023.joblib --out mockup/data
  python pipeline/build_stuff.py --validate --model ... --reference path/to/tjstuff_plus_pitch_data_2024.csv

Method follows tjStuff+ v3 (Thomas Nestico, MIT): https://github.com/tnestico/tjstuff_plus
  * features: start_speed, spin_rate, extension, az, ax, x0, z0, and speed/az/|ax| differences
    from the pitcher's primary fastball (most-thrown of FF/SI/FC that season)
  * left-handed pitchers have ax mirrored; right-handed pitchers have x0 mirrored
  * tjStuff+ = 100 - 10 * z-score of predicted run value, standardized within the season
  * 20-80 pitch grade = 50 + 10 * (tjStuff+ - pitch-type mean) / std, where
    std = (99.9th - 0.1th percentile) / 6 across pitchers with 10+ pitches of that type

Statcast (Baseball Savant) uses different column names than the MLB Gameday feed the model
was trained on. The mapping is below. Savant does not export x0/z0 (position at y = 50 ft),
so they are recovered exactly from the 9-parameter trajectory and the plate crossing.
"""
import argparse, json, math, os, sys, warnings
from datetime import date, datetime, timezone

import joblib
import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

FEATURES = ["start_speed", "spin_rate", "extension", "az", "ax", "x0", "z0", "speed_diff", "az_diff", "ax_diff"]
FASTBALLS = ["FF", "SI", "FC"]
Y_PLATE = 17 / 12
SWINGS = {"swinging_strike", "swinging_strike_blocked", "foul", "foul_tip", "hit_into_play", "foul_bunt", "missed_bunt", "bunt_foul_tip"}
WHIFFS = {"swinging_strike", "swinging_strike_blocked", "missed_bunt"}
MIN_PITCHES = 50        # pitchers below this are left out of the site data
MIN_TYPE_PITCHES = 10   # matches tjStuff+ pitch-type scaling
SAMPLE_PER_TYPE = 60    # pitches kept per type for Pitch Lab what-if runs in the browser


# ---------------------------------------------------------------- data

SAVANT = "https://baseballsavant.mlb.com/statcast_search/csv"


def fetch_day(day, season, cache_dir, refresh):
    """One day of regular-season pitches from Baseball Savant (a day is well under the 25k-row cap)."""
    import io, time, requests
    path = os.path.join(cache_dir, f"{day}.csv.gz")
    if os.path.exists(path) and not refresh:
        return pd.read_csv(path)
    params = {"all": "true", "hfGT": "R|", "hfSea": f"{season}|", "player_type": "pitcher", "game_date_gt": day,
              "game_date_lt": day, "min_pitches": 0, "min_results": 0, "group_by": "name", "sort_col": "pitches",
              "sort_order": "desc", "min_abs": 0, "type": "details"}
    for attempt in range(4):
        try:
            res = requests.get(SAVANT, params=params, timeout=120, headers={"User-Agent": "pitcher-page-pipeline"})
            res.raise_for_status()
            text = res.content.decode("utf-8-sig")
            if not text.lstrip().lstrip('"').startswith("pitch_type"):
                raise ValueError(f"unexpected response for {day}: {text[:120]!r}")
            df = pd.read_csv(io.StringIO(text), low_memory=False)
            df.to_csv(path, index=False, compression="gzip")
            return df
        except Exception as e:  # network hiccups and Savant rate limits
            if attempt == 3:
                raise
            print(f"retry {day}: {e}", file=sys.stderr)
            time.sleep(5 * 2 ** attempt)


def fetch_statcast(season, cache_dir=".statcast-cache", refetch_days=3):
    """Every regular-season pitch for a season. Days already cached are reused, except the most
    recent few, which Savant can still revise."""
    from concurrent.futures import ThreadPoolExecutor
    from datetime import timedelta
    cache_dir = os.path.join(cache_dir, str(season))
    os.makedirs(cache_dir, exist_ok=True)
    start, end = date(season, 3, 15), min(date(season, 10, 5), date.today() - timedelta(days=1))
    days = [start + timedelta(d) for d in range((end - start).days + 1)]
    recent = set(days[-refetch_days:])
    with ThreadPoolExecutor(4) as ex:
        frames = list(ex.map(lambda d: fetch_day(d.isoformat(), season, cache_dir, d in recent), days))
    frames = [f for f in frames if f is not None and len(f)]
    if not frames:
        sys.exit(f"Baseball Savant returned no pitches for {season}")
    return pd.concat(frames, ignore_index=True)


def flight_time(vy0, ay, y):
    """Seconds from y = 50 ft to y (ft), from the constant-acceleration fit."""
    a, b, c = 0.5 * ay, vy0, 50.0 - y
    disc = np.sqrt(np.maximum(b * b - 4 * a * c, 0))
    return (-b - disc) / (2 * a)


def prepare(df):
    df = df[df["game_type"] == "R"].copy() if "game_type" in df else df.copy()
    need = ["pitcher", "player_name", "p_throws", "pitch_type", "game_date", "release_speed", "release_spin_rate",
            "release_extension", "ax", "ay", "az", "vx0", "vy0", "vz0", "plate_x", "plate_z", "pfx_x", "pfx_z"]
    missing = [c for c in need if c not in df]
    if missing:
        sys.exit(f"Statcast data is missing columns: {missing}")
    df = df.dropna(subset=need)
    df = df[~df["pitch_type"].isin(["PO", "IN", "AB", "UN"])]
    df["year"] = pd.to_datetime(df["game_date"]).dt.year

    # Savant -> Gameday feature names
    t_plate = flight_time(df["vy0"], df["ay"], Y_PLATE)
    df["start_speed"] = df["release_speed"]
    df["spin_rate"] = df["release_spin_rate"]
    df["extension"] = df["release_extension"]
    x0 = df["plate_x"] - df["vx0"] * t_plate - 0.5 * df["ax"] * t_plate ** 2
    df["z0"] = df["plate_z"] - df["vz0"] * t_plate - 0.5 * df["az"] * t_plate ** 2
    lefty = df["p_throws"] == "L"
    df["ax_m"] = np.where(lefty, -df["ax"], df["ax"])    # tjStuff+ mirrors ax for LHP
    df["x0"] = np.where(lefty, x0, -x0)                  # and x0 for RHP

    # primary fastball per pitcher-season: most-thrown of FF/SI/FC, ties to the faster pitch
    fb = (df[df["pitch_type"].isin(FASTBALLS)]
          .groupby(["pitcher", "year", "pitch_type"])
          .agg(fb_speed=("start_speed", "mean"), fb_az=("az", "mean"), fb_ax=("ax_m", "mean"), fb_n=("start_speed", "size"))
          .reset_index().sort_values(["fb_n", "fb_speed"], ascending=False)
          .drop_duplicates(["pitcher", "year"]).rename(columns={"pitch_type": "fb_type"}))
    df = df.merge(fb[["pitcher", "year", "fb_type", "fb_speed", "fb_az", "fb_ax"]], on=["pitcher", "year"], how="inner")
    df["speed_diff"] = df["start_speed"] - df["fb_speed"]
    df["az_diff"] = df["az"] - df["fb_az"]
    df["ax_diff"] = (df["ax_m"] - df["fb_ax"]).abs()
    return df


def score(df, model):
    X = df[["start_speed", "spin_rate", "extension", "az", "ax_m", "x0", "z0", "speed_diff", "az_diff", "ax_diff"]].to_numpy(float)
    df["xrv"] = model.predict(X)
    mean, sd = df["xrv"].mean(), df["xrv"].std()
    df["tj"] = 100 - 10 * (df["xrv"] - mean) / sd
    return df, float(mean), float(sd)


def grade_scales(df):
    """Per-pitch-type (and 'All') mean/std used to convert tjStuff+ to 20-80, as in tjStuff+ v3."""
    out = {}
    by_type = df.groupby(["pitcher", "pitch_type"])["tj"].agg(["mean", "size"]).reset_index()
    by_type = by_type[by_type["size"] >= MIN_TYPE_PITCHES]
    for pt, g in by_type.groupby("pitch_type"):
        lo, hi = g["mean"].quantile(0.001), g["mean"].quantile(0.999)
        out[pt] = {"mean": float(g["mean"].mean()), "std": float((hi - lo) / 6) or 1.0, "n": int(len(g))}
    allp = df.groupby("pitcher")["tj"].agg(["mean", "size"]).reset_index()
    allp = allp[allp["size"] >= MIN_TYPE_PITCHES]
    lo, hi = allp["mean"].quantile(0.001), allp["mean"].quantile(0.999)
    out["All"] = {"mean": float(allp["mean"].mean()), "std": float((hi - lo) / 6), "n": int(len(allp))}
    return out


def to_grade(tj, sc):
    return float(min(80, max(20, 50 + 10 * (tj - sc["mean"]) / sc["std"])))


# ---------------------------------------------------------------- per-pitcher JSON

def r(x, d=2):
    return None if x is None or (isinstance(x, float) and math.isnan(x)) else round(float(x), d)


def loc_stats(g):
    if len(g) < 5:
        return None
    x, z = g["plate_x"].to_numpy(), g["plate_z"].to_numpy()
    rho = float(np.corrcoef(x, z)[0, 1]) if x.std() > 0 and z.std() > 0 else 0.0
    return [r(x.mean(), 3), r(z.mean(), 3), r(x.std(), 3), r(z.std(), 3), r(rho, 3), int(len(g))]


def xwoba(g):
    if "woba_denom" not in g:
        return None
    pa = g[g["woba_denom"] == 1]
    if not len(pa):
        return None
    val = pa["estimated_woba_using_speedangle"].where(pa["estimated_woba_using_speedangle"].notna(), pa["woba_value"]) \
        if "estimated_woba_using_speedangle" in pa else pa["woba_value"]
    return r(val.mean(), 3)


def whiff(g):
    if "description" not in g:
        return None
    sw = g["description"].isin(SWINGS).sum()
    return r(g["description"].isin(WHIFFS).sum() / sw, 3) if sw else None


def movement_time(p):
    """Effective time T in pfx = 0.5 * a * T^2, fit by least squares on this pitcher's pitches of one type.
    Pitch Lab uses it to turn movement changes (inches) into the acceleration changes the model takes.
    Fitting it from the data keeps the conversion consistent with however Savant defines pfx."""
    a1, a2 = p["ax"].to_numpy(), (p["az"] + 32.174).to_numpy()
    t2 = 2 * (p["pfx_x"].to_numpy() @ a1 + p["pfx_z"].to_numpy() @ a2) / (a1 @ a1 + a2 @ a2)
    return float(np.sqrt(t2)) if t2 > 0 else 0.39


def pitcher_json(pid, g, scales, rng):
    hand = g["p_throws"].iloc[0]
    sign = -1 if hand == "R" else 1   # arm-side positive horizontal break
    name = g["player_name"].iloc[0]
    if "," in name:
        last, first = [s.strip() for s in name.split(",", 1)]
        name = f"{first} {last}"
    n = len(g)
    pitches = []
    for pt, p in g.groupby("pitch_type"):
        if len(p) < max(5, 0.02 * n):
            continue
        samp = p.sample(min(SAMPLE_PER_TYPE, len(p)), random_state=int(rng.integers(1e9)))
        sample = samp[["start_speed", "spin_rate", "extension", "az", "ax_m", "x0", "z0"]].round(3).to_numpy().tolist()
        tj = float(p["tj"].mean())
        sc = scales.get(pt) or scales["All"]
        pitches.append({
            "code": pt,
            "name": p["pitch_name"].iloc[0] if "pitch_name" in p else pt,
            "n": int(len(p)),
            "usage": r(len(p) / n, 4),
            "velo": r(p["start_speed"].mean(), 1),
            "ivb": r(p["pfx_z"].mean() * 12, 1),
            "hb": r(sign * p["pfx_x"].mean() * 12, 1),
            "ivb_sd": r(p["pfx_z"].std() * 12, 2),
            "hb_sd": r(p["pfx_x"].std() * 12, 2),
            "spin": int(round(p["spin_rate"].mean())),
            "ext": r(p["extension"].mean(), 2),
            "whiff": whiff(p),
            "xwoba": xwoba(p),
            "stuff_plus": r(tj, 1),
            "stuff_grade": r(to_grade(tj, sc), 1),
            "t40": r(movement_time(p), 4),
            "loc": {"all": loc_stats(p), "R": loc_stats(p[p["stand"] == "R"]) if "stand" in p else None,
                    "L": loc_stats(p[p["stand"] == "L"]) if "stand" in p else None},
            "sample": sample,
        })
    pitches.sort(key=lambda x: -x["usage"])
    months = []
    mo = pd.to_datetime(g["game_date"]).dt.month.clip(4, 9)
    for m, gm in g.groupby(mo):
        months.append({"m": int(m), "n": int(len(gm)), "stuff_plus": r(gm["tj"].mean(), 1),
                       "stuff_grade": r(to_grade(gm["tj"].mean(), scales["All"]), 1)})
    tj_all = float(g["tj"].mean())
    return {
        "id": int(pid), "name": name, "throws": hand, "n": n,
        "arm_angle": r(g["arm_angle"].mean(), 1) if "arm_angle" in g and g["arm_angle"].notna().any() else None,
        "extension": r(g["extension"].mean(), 2),
        "fastball": {"type": g["fb_type"].iloc[0], "speed": r(g["fb_speed"].iloc[0], 3), "az": r(g["fb_az"].iloc[0], 3), "ax": r(g["fb_ax"].iloc[0], 3)},
        "stuff_plus": r(tj_all, 1), "stuff_grade": r(to_grade(tj_all, scales["All"]), 1),
        "months": months, "pitches": pitches,
    }


# ---------------------------------------------------------------- main

def build(df, model, season, out_dir, model_meta):
    df = prepare(df)
    df = df[df["year"] == season]
    if df.empty:
        sys.exit(f"No Statcast rows for {season}")
    df, xmean, xsd = score(df, model)
    scales = grade_scales(df)
    rng = np.random.default_rng(season)
    d = os.path.join(out_dir, "stuff", str(season))
    os.makedirs(d, exist_ok=True)
    index = []
    for pid, g in df.groupby("pitcher"):
        if len(g) < MIN_PITCHES:
            continue
        pj = pitcher_json(pid, g, scales, rng)
        with open(os.path.join(d, f"{pid}.json"), "w") as f:
            json.dump(pj, f, separators=(",", ":"))
        index.append({"id": pj["id"], "name": pj["name"], "n": pj["n"], "stuff_plus": pj["stuff_plus"]})
    meta = {
        "season": season, "built_at": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "through": str(pd.to_datetime(df["game_date"]).max().date()), "pitches": int(len(df)),
        "source": "Statcast via Baseball Savant (MLB Advanced Media). Non-commercial use.",
        "model": model_meta, "xrv_mean": xmean, "xrv_sd": xsd, "scales": scales,
        "pitchers": sorted(index, key=lambda x: -x["n"]),
    }
    with open(os.path.join(d, "index.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))
    print(f"{season}: {len(df):,} pitches, {len(index)} pitchers -> {d}")


def validate(df, model, reference):
    """Recompute 2024 and compare pitcher-level tjStuff+ with Nestico's published 2024 leaderboard."""
    df = prepare(df)
    df = df[df["year"] == 2024]
    df, _, _ = score(df, model)
    ours = df.groupby("pitcher").agg(tj=("tj", "mean"), n=("tj", "size")).reset_index()
    ref = pd.read_csv(reference)
    ref = ref[ref["pitch_type"] == "All"][["pitcher_id", "tj_stuff_plus", "pitches"]]
    m = ours.merge(ref, left_on="pitcher", right_on="pitcher_id")
    m = m[m["pitches"] >= 300]
    r_ = m["tj"].corr(m["tj_stuff_plus"])
    mae = (m["tj"] - m["tj_stuff_plus"]).abs().mean()
    print(f"Validation vs published 2024 tjStuff+: {len(m)} pitchers with 300+ pitches, r = {r_:.3f}, mean abs diff = {mae:.2f}")
    if r_ < 0.9:
        sys.exit("Validation failed: correlation below 0.9. The Savant-to-Gameday feature mapping needs review.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=date.today().year)
    ap.add_argument("--model", required=True)
    ap.add_argument("--model-source", default="")
    ap.add_argument("--out", default="mockup/data")
    ap.add_argument("--csv", help="use a local Statcast CSV instead of downloading")
    ap.add_argument("--validate", action="store_true", help="recompute 2024 and compare to --reference")
    ap.add_argument("--reference", help="tjstuff_plus_pitch_data_2024.csv")
    a = ap.parse_args()
    model = joblib.load(a.model)
    season = 2024 if a.validate else a.season
    if a.csv:
        df = pd.read_csv(a.csv)
    else:
        df = fetch_statcast(season)
    if a.validate:
        validate(df, model, a.reference)
    else:
        build(df, model, season, a.out, {"name": "tjStuff+", "version": "v3.0 (trained 2020-2023)", "author": "Thomas Nestico",
                                         "license": "MIT", "url": "https://github.com/tnestico/tjstuff_plus", "file": a.model_source})


if __name__ == "__main__":
    main()
