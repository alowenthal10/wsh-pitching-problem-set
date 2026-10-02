"""Reference deliveries for the biomechanics panel, from Driveline's OpenBiomechanics Project.

Data: https://github.com/drivelineresearch/openbiomechanics (dataset-v1 release, pitching_landmarks.zip
and baseball_pitching/data/poi/poi_metrics.csv). Licensed CC BY-NC-SA 4.0; this file's output is a
derived, resampled subset under the same license.

For each throwing hand, keeps the fastest pitch in each 5-degree arm-angle bucket. Arm angle is
computed the way Statcast defines it: the shoulder-to-hand angle above horizontal at ball release,
seen from behind the plate. Each delivery is resampled to 72 frames from peak knee height to just
after maximum internal rotation, in a pitcher-centered frame (forward, arm side, up), in meters.

  python pipeline/obp_reference.py landmarks.csv poi_metrics.csv mockup/data/biomech/reference.json
"""
import json, sys

import numpy as np
import pandas as pd

JOINTS = ["rear_ankle_jc", "rear_knee_jc", "rear_hip", "lead_ankle_jc", "lead_knee_jc", "lead_hip",
          "shoulder_jc", "elbow_jc", "wrist_jc", "hand_jc", "glove_shoulder_jc", "glove_elbow_jc",
          "glove_wrist_jc", "glove_hand_jc", "thorax_prox", "thorax_dist"]
FRAMES = 72


def frame_axes(g):
    """Forward = stride direction (rear ankle at start to lead ankle at foot plant); up = +z."""
    fp = g.iloc[(g["time"] - g["fp_100_time"].iloc[0]).abs().argmin()]
    s = g.iloc[0]
    f = np.array([fp["lead_ankle_jc_x"] - s["rear_ankle_jc_x"], fp["lead_ankle_jc_y"] - s["rear_ankle_jc_y"], 0.0])
    f /= np.linalg.norm(f)
    up = np.array([0, 0, 1.0])
    side = np.cross(up, f)     # left of the pitcher when facing the plate
    origin = np.array([s["rear_ankle_jc_x"], s["rear_ankle_jc_y"], 0.0])
    return origin, f, side, up


def build(landmarks, poi):
    lm = pd.read_csv(landmarks)
    meta = pd.read_csv(poi)[["session_pitch", "p_throws", "pitch_speed_mph"]]
    out = []
    for sp, g in lm.groupby("session_pitch"):
        g = g.sort_values("time")
        m = meta[meta["session_pitch"] == sp]
        if m.empty or g[["pkh_time", "BR_time", "MIR_time", "fp_100_time"]].isna().any(axis=None):
            continue
        throws = m["p_throws"].iloc[0]
        origin, f, side, up = frame_axes(g)
        arm_sign = -1.0 if throws == "R" else 1.0   # arm side is the pitcher's right for RHP
        def coords(row):
            pts = []
            for j in JOINTS:
                v = np.array([row[f"{j}_x"], row[f"{j}_y"], row[f"{j}_z"]]) - origin
                pts += [v @ f, arm_sign * (v @ side), v @ up]
            return pts
        t0, t1 = g["pkh_time"].iloc[0], g["MIR_time"].iloc[0] + 0.12
        ts = np.linspace(t0, t1, FRAMES)
        frames = []
        for t in ts:
            row = g.iloc[(g["time"] - t).abs().argmin()]
            frames.append([round(float(v), 3) for v in coords(row)])
        br = g.iloc[(g["time"] - g["BR_time"].iloc[0]).abs().argmin()]
        c = np.array(coords(br)).reshape(-1, 3)
        sh, hand = c[JOINTS.index("shoulder_jc")], c[JOINTS.index("hand_jc")]
        arm_angle = float(np.degrees(np.arctan2(hand[2] - sh[2], abs(hand[1] - sh[1]))))
        ev = lambda col: round(float((g[col].iloc[0] - t0) / (t1 - t0)), 3)
        out.append({"id": sp, "throws": throws, "speed": float(m["pitch_speed_mph"].iloc[0]), "arm_angle": round(arm_angle, 1),
                    "events": {"foot_plant": ev("fp_100_time"), "max_er": ev("MER_time"), "release": ev("BR_time")},
                    "frames": frames})
    df = pd.DataFrame([{k: o[k] for k in ("id", "throws", "speed", "arm_angle")} for o in out])
    df["bucket"] = (df["arm_angle"] // 5).astype(int)
    keep = set(df.sort_values("speed", ascending=False).drop_duplicates(["throws", "bucket"])["id"])
    refs = [o for o in out if o["id"] in keep]
    return {"source": "Driveline OpenBiomechanics Project (dataset-v1)", "url": "https://github.com/drivelineresearch/openbiomechanics",
            "license": "CC BY-NC-SA 4.0", "changes": "Resampled to 72 frames, rotated to a pitcher-centered frame; fastest pitch per 5-degree arm-angle bucket.",
            "joints": JOINTS, "axes": ["forward", "arm_side", "up"], "units": "m", "references": sorted(refs, key=lambda o: (o["throws"], o["arm_angle"]))}


if __name__ == "__main__":
    data = build(sys.argv[1], sys.argv[2])
    import os
    os.makedirs(os.path.dirname(sys.argv[3]), exist_ok=True)
    with open(sys.argv[3], "w") as fh:
        json.dump(data, fh, separators=(",", ":"))
    print(f"{len(data['references'])} reference deliveries:", [(r['throws'], r['arm_angle'], r['speed']) for r in data["references"]])
