# Genshin Pull Simulator

A vanilla HTML/CSS/JS web app that replays Genshin Impact's wish (gacha) system patch by patch, using real per-patch pull-income figures and real banner history (patch 1.0 through Luna VIII). No build step, no framework, no dependencies.

Implements: soft-pity curves per banner type, the 50/50 + classic guarantee, Capturing Radiance, Epitomized Path (with its 2.0/5.0 version gating), Chronicled Wish designated-pick, 4-star soft pity, Masterless Starglitter → wish conversion, constellation-tracked character inventory + count-tracked weapon inventory, full wish history, 50/50 and Fate Point statistics, and an optional Welkin Moon / Battle Pass bonus-pull toggle.

## Running it

The app fetches its data files with `fetch()`, which browsers block under a bare `file://` URL — it needs to be served over HTTP. Any static file server works, e.g.:

```
python -m http.server 8000
```

then open `http://localhost:8000/index.html`. (Node alternative: `npx serve .`)

## Files needed to run the app

Just these six paths — this is the entire runtime footprint:

```
index.html
style.css
app.js
data/banners.json
data/standard_banner.json
data/pulls_per_patch.json
```

Copy just those (keeping the `data/` folder structure) to run the app anywhere else.

## What's in the repo but *not* needed to run the app

- **`scripts/`** — maintainer-only tooling that regenerates the `data/*.json` files above from source spreadsheets and cached wiki data. The running app never touches these.
- **`data/external/`** — cached raw wiki fetches, consumed only by `scripts/extract_banners.py`.
- **`*.xlsx`** — source spreadsheets for the data-build scripts (gitignored; see below).

## Regenerating data (optional, maintainers only)

Only relevant if you need to rebuild `data/*.json` after a new patch:

| Output | Script | Source(s) |
|---|---|---|
| `data/pulls_per_patch.json` | `scripts/extract_pulls_per_patch.py` | `genshin pulls.xlsx` |
| `data/standard_banner.json` | `scripts/convert_standard_banner.py` | `standard banner.xlsx` + roster sheets from `Genshin Impact Character & Weapon Banner History.xlsx` |
| `data/banners.json` | `scripts/extract_banners.py` | `data/external/wiki_wish_history.json` (fetched by `scripts/fetch_wiki_wish_history.py`) + `data/external/chronicled_instance_pages.json` + roster sheets from `Genshin Impact Character & Weapon Banner History.xlsx` |

All scripts are pure Python-3-standard-library — nothing to `pip install` (see `requirements.txt`). The `.xlsx` source files are gitignored; keep your own local copies if you plan to re-run these.
