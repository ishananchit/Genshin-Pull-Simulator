"""
One-time fetch of the Genshin Impact Fandom wiki's "Wish/History" page
(rendered HTML, via the MediaWiki API's action=parse&prop=text), cached
locally. This page has one section per game version (1.0 through the
latest, e.g. "Luna VIII"), each listing every wish/banner run that version
with its featured rate-up units (name + rarity) -- the full history, with
no gaps, unlike the abandoned Masterain98/Genshin-Wish-Event-History-Data
pool.json (which stops at patch 4.5).
"""
import json
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_JSON = ROOT / "data" / "external" / "wiki_wish_history.json"

API_URL = (
    "https://genshin-impact.fandom.com/api.php"
    "?action=parse&page=" + urllib.parse.quote("Wish/History")
    + "&format=json&prop=text&section=1"
)


def main() -> None:
    req = urllib.request.Request(API_URL, headers={"User-Agent": "Mozilla/5.0 (genshin-pull-simulator-data-prep)"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(data), encoding="utf-8")
    html_len = len(data["parse"]["text"]["*"])
    print(f"Wrote {html_len} chars of rendered HTML to {OUT_JSON}")


if __name__ == "__main__":
    main()
