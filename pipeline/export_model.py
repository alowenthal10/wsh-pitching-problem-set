"""Export the tjStuff+ LightGBM pipeline to a compact JSON the browser can evaluate.

tjStuff+ is by Thomas Nestico (MIT License): https://github.com/tnestico/tjstuff_plus
Output format:
  center, scale: RobustScaler parameters (features are scaled as (x - center) / scale)
  trees: list of [feat, thr, left, right, leaf] arrays. Node i splits on feat[i] at thr[i]
         (go left when x <= thr). Child values >= 0 are node indexes; a negative value c
         is leaf index (-c - 1).
"""
import argparse, json, warnings
import joblib

warnings.filterwarnings("ignore")

FEATURES = ["start_speed", "spin_rate", "extension", "az", "ax", "x0", "z0", "speed_diff", "az_diff", "ax_diff"]


def compact_tree(root):
    feat, thr, left, right, leaf = [], [], [], [], []

    def walk(n):
        if "leaf_value" in n:
            leaf.append(round(n["leaf_value"], 9))
            return -len(leaf)
        assert n["decision_type"] == "<=", n["decision_type"]
        i = len(feat)
        feat.append(n["split_feature"]); thr.append(float(f'{n["threshold"]:.10g}')); left.append(None); right.append(None)
        left[i] = walk(n["left_child"])
        right[i] = walk(n["right_child"])
        return i

    walk(root)
    return [feat, thr, left, right, leaf]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model", help="path to lgbm_model_*.joblib from tnestico/tjstuff_plus")
    ap.add_argument("out")
    ap.add_argument("--source", default="")
    a = ap.parse_args()
    pipe = joblib.load(a.model)
    scaler, gbm = pipe.steps[0][1], pipe.steps[-1][1]
    dump = gbm.booster_.dump_model()
    out = {
        "name": "tjStuff+",
        "version": "v3.0 (trained 2020-2023)",
        "author": "Thomas Nestico",
        "license": "MIT",
        "source": a.source,
        "features": FEATURES,
        "center": scaler.center_.tolist(),
        "scale": scaler.scale_.tolist(),
        "trees": [compact_tree(t["tree_structure"]) for t in dump["tree_info"]],
    }
    with open(a.out, "w") as f:
        json.dump(out, f, separators=(",", ":"))


if __name__ == "__main__":
    main()
