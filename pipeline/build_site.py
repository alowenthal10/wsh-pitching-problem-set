"""Generate the static pages that give every pitcher a clean URL on GitHub Pages.

  python pipeline/build_site.py mockup

Reads mockup/data/stuff/<season>/index.json for every built season and writes:
  mockup/<slug>/index.html   a small shell of player.html for each pitcher (e.g. /mackenzie-gore/)
  mockup/data/pitchers.json  [{id, name, slug, seasons}] for search and leaderboard links
  mockup/data/seasons.json   built seasons, newest first
  mockup/mockup/index.html   redirect from the old /mockup/ address to the site root

GitHub Pages serves files only, so each player URL is a real page (HTTP 200) rather than a
404-page redirect. Pitchers who share a name get their MLBAM id appended to the slug.
"""
import glob, html, json, os, re, sys, time, unicodedata

RESERVED = {"assets", "data", "model", "mockup", "player", "index"}


def slugify(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "pitcher"


def main(site):
    seasons, people = [], {}
    for path in sorted(glob.glob(os.path.join(site, "data", "stuff", "*", "index.json")), reverse=True):
        meta = json.load(open(path))
        seasons.append(meta["season"])
        for p in meta["pitchers"]:
            e = people.setdefault(p["id"], {"id": p["id"], "name": p["name"], "seasons": []})
            e["seasons"].append(meta["season"])
    by_slug = {}
    for p in people.values():
        by_slug.setdefault(slugify(p["name"]), []).append(p)
    for slug, ps in by_slug.items():
        for p in ps:
            p["slug"] = slug if len(ps) == 1 and slug not in RESERVED else f"{slug}-{p['id']}"
    # Cache-busting: GitHub Pages lets browsers reuse assets for 10 minutes, so stamp every shared asset
    # URL with this build's version and new deploys show up on a normal refresh.
    version = (os.environ.get("GITHUB_SHA") or str(int(time.time())))[:12]
    for page in ("index.html", "player.html"):
        path = os.path.join(site, page)
        text = re.sub(r'((?:src|href)="(?:assets|model)/[^"?]+\.(?:js|css))(\?v=[^"]*)?"', rf'\1?v={version}"', open(path).read())
        open(path, "w").write(text)
    shell = open(os.path.join(site, "player.html")).read()
    for p in people.values():
        boot = (f'<base href="../">\n<script>window.PITCHER = {json.dumps({"id": p["id"], "slug": p["slug"]})};</script>\n'
                f'<title>{html.escape(p["name"])} · Pitcher Page</title>\n')
        page = re.sub(r"<title>.*?</title>\n?", "", shell, count=1).replace('<meta charset="utf-8">', '<meta charset="utf-8">\n' + boot, 1)
        os.makedirs(os.path.join(site, p["slug"]), exist_ok=True)
        with open(os.path.join(site, p["slug"], "index.html"), "w") as f:
            f.write(page)
    with open(os.path.join(site, "data", "pitchers.json"), "w") as f:
        json.dump(sorted(people.values(), key=lambda p: p["name"]), f, separators=(",", ":"))
    with open(os.path.join(site, "data", "seasons.json"), "w") as f:
        json.dump(seasons, f)
    os.makedirs(os.path.join(site, "mockup"), exist_ok=True)
    with open(os.path.join(site, "mockup", "index.html"), "w") as f:
        f.write('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=../">'
                '<link rel="canonical" href="../"><title>Moved</title><p>The pitcher page moved to the <a href="../">site root</a>.</p>')
    print(f"{len(people)} pitcher pages for seasons {seasons}; asset version {version}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "mockup")
