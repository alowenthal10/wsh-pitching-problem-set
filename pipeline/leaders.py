"""League index fields for the leaderboard: team, role, innings, ERA, model-expected ERA, best pitch.

Team and role come from Statcast (the fielding team on his latest pitch; a start is a game in which
he pitched in the first inning). Innings, ERA, and team names come from the MLB Stats API at build
time; if it can't be reached, those columns are left empty and the leaderboard still works.
"""
import json
import urllib.request

import numpy as np

API = "https://statsapi.mlb.com/api/v1"


def _get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "pitcher-page-pipeline"}), timeout=60) as r:
        return json.load(r)


def _ip(s):
    w, _, f = str(s or "0").partition(".")
    return int(w or 0) + int(f or 0) / 3


def season_stats(season):
    """({pitcher_id: {ip, er, era}}, {team_abbr: {id, name}}, league_era) from the Stats API."""
    try:
        d = _get(f"{API}/stats?stats=season&group=pitching&season={season}&sportId=1&playerPool=All&limit=5000")
        teams = _get(f"{API}/teams?sportId=1&season={season}")
    except Exception as e:  # network or API change: leaderboard falls back to Statcast-only columns
        print(f"Stats API unavailable for {season}: {e}")
        return {}, {}, None
    out, er_all, ip_all = {}, 0.0, 0.0
    for sp in d.get("stats", [{}])[0].get("splits", []):
        pid, st = sp.get("player", {}).get("id"), sp.get("stat", {})
        if not pid:
            continue
        o = out.setdefault(pid, {"ip": 0.0, "er": 0})
        o["ip"] += _ip(st.get("inningsPitched"))
        o["er"] += int(st.get("earnedRuns") or 0)
    for o in out.values():
        o["era"] = o["er"] * 9 / o["ip"] if o["ip"] else None
        er_all += o["er"]; ip_all += o["ip"]
    tmap = {t["abbreviation"]: {"id": t["id"], "name": t["name"]} for t in teams.get("teams", []) if t.get("abbreviation")}
    return out, tmap, (er_all * 9 / ip_all if ip_all else None)


def statcast_team_role(g):
    """(team abbreviation on his latest pitch, starts, games) from one pitcher's Statcast rows."""
    team = None
    if {"home_team", "away_team", "inning_topbot"} <= set(g.columns):
        last = g.sort_values(["game_date"] + (["at_bat_number"] if "at_bat_number" in g else [])).iloc[-1]
        team = last["home_team"] if last["inning_topbot"] == "Top" else last["away_team"]
    starts = games = None
    if {"game_pk", "inning"} <= set(g.columns):
        first = g.groupby("game_pk")["inning"].min()
        games, starts = int(len(first)), int((first == 1).sum())
    return team, starts, games


def index_entry(pj, g, stats, teams, lg_era):
    team, starts, games = statcast_team_role(g)
    st = stats.get(pj["id"], {})
    best = max(pj["pitches"], key=lambda x: (x["usage"] >= 0.05, x["stuff_grade"]), default=None)
    exp_era = None
    if lg_era and st.get("ip") and pj.get("runs_above_avg") is not None:
        exp_era = round(lg_era + 9 * pj["runs_above_avg"] / st["ip"], 2)
    return {
        "id": pj["id"], "name": pj["name"], "throws": pj["throws"], "n": pj["n"],
        "team": team, "team_name": teams.get(team, {}).get("name"), "team_id": teams.get(team, {}).get("id"),
        "role": None if games is None else ("SP" if starts >= max(3, 0.5 * games) else "RP"), "starts": starts, "games": games,
        "ip": round(st["ip"], 1) if st.get("ip") else None, "era": round(st["era"], 2) if st.get("era") is not None else None,
        "exp_era": exp_era,
        "stuff_plus": pj.get("stuff_plus"), "stuff_grade": pj.get("stuff_grade"),
        "loc_grade": pj.get("loc_grade"), "pitching_grade": pj.get("pitching_grade"), "pitching_plus": pj.get("pitching_plus"),
        "best": {"code": best["code"], "grade": best["stuff_grade"]} if best else None,
    }
