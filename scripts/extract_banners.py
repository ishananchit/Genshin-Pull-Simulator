"""
Build data/banners.json: a flat list of {patch, phase, banner_type,
five_star, four_star} entries, one per banner instance.

Primary source: the Fandom wiki's "Wish/History" page (cached rendered
HTML at data/external/wiki_wish_history.json, fetched by
fetch_wiki_wish_history.py). It has one section per game version, each
listing every wish run that version with its featured units directly (no
item-id resolution needed, and no coverage gaps -- it goes all the way to
the same "Luna VIII" version as the user's local spreadsheet).

Permanent wishes (e.g. "Wanderlust Invocation", "Beginners' Wish") have no
featured units and are skipped -- they're not patch-specific banners.

Banner type per row is classified from the *resolved rarities/composition*,
not the banner's flavor-text name:
  - four_star count == 0 and five_star count >= 2  -> "chronicled"
    (Chronicled Wish always mixes >=2 old 5-stars, characters and/or
    weapons, with no 4-star rate-ups)
  - all unit names found in the local Weapon List roster -> "weapon"
  - otherwise -> "character"

Phase numbering: "phase" is a per-patch index over *distinct start dates*
across ALL banner types (character, weapon, chronicled combined), not a
per-type counter. Banners that ran at the same time -- including
concurrent/dual character banners (~2.3 onward), which share their exact
start date -- land on the same phase number, so the app can show them
together instead of as separate consecutive phases. A phase can therefore
have more than one "character" entry, plus a "weapon" and/or "chronicled"
entry, all sharing the same patch+phase. Dates are only used to compute
this grouping; they are not written to the output.

Cross-check: the resulting 5-star headliner sequence for "character"
banners is compared, in order, against the local banner-history
spreadsheet's own row 9 (Character Banner sheet) -- verified earlier to
hold genuine manually-entered values, not formulas.

Chronicled 4-star pools: the aggregated "Wish/History" page's compact
table omits the 4-star pool for Chronicled Wish rows entirely (verified:
the raw HTML for those rows contains zero card-quality-4 markup). But
each chronicled banner's own dated instance page (e.g. "Ode to the Dawn
Breeze/2024-03-13") *does* list the full 4-star pool -- confirmed
real/legitimate (regional chronicled banners list ~12 4-star characters
+ ~20 4-star weapons from that region; the special "mega" chronicled
banners list nearly every 4-star in the game). Fetched per chronicled
entry via fetch_chronicled_four_star(), cached to
data/external/chronicled_instance_pages.json.
"""
import html as htmllib
import json
import re
import time
import urllib.parse
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WIKI_JSON = ROOT / "data" / "external" / "wiki_wish_history.json"
BANNER_XLSX = ROOT / "Genshin Impact Character & Weapon Banner History.xlsx"
CHRONICLED_CACHE_JSON = ROOT / "data" / "external" / "chronicled_instance_pages.json"
OUT_JSON = ROOT / "data" / "banners.json"

NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}

HEADING_RE = re.compile(r'<span class="mw-headline" id="([^"]+)">')
ROW_RE = re.compile(r"<tr>(?:(?!<tr>).)*?</tr>", re.S)
WISH_NAME_RE = re.compile(r'<td><span typeof="mw:File"><a href="[^"]+" title="([^"]+)"')
QUALITY_RE = re.compile(r"card-quality-(\d)")
TITLE_RE = re.compile(r'title="([^"]+)"')


def col_to_idx(ref: str) -> int:
    letters = re.match(r"([A-Z]+)", ref).group(1)
    idx = 0
    for ch in letters:
        idx = idx * 26 + (ord(ch) - 64)
    return idx


def load_shared_strings(z: zipfile.ZipFile) -> list[str]:
    root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    return ["".join(t.text or "" for t in si.findall(".//s:t", NS)) for si in root.findall("s:si", NS)]


def read_row(z: zipfile.ZipFile, shared: list[str], sheet_xml: str, row_num: int) -> dict[int, str]:
    root = ET.fromstring(z.read(sheet_xml))
    for row in root.findall(".//s:sheetData/s:row", NS):
        if int(row.get("r")) != row_num:
            continue
        out = {}
        for c in row.findall("s:c", NS):
            col = col_to_idx(c.get("r"))
            t = c.get("t")
            v = c.find("s:v", NS)
            val = v.text if v is not None else ""
            if t == "s" and val != "":
                val = shared[int(val)]
            out[col] = val
        return out
    return {}


def load_local_rosters() -> tuple[set[str], set[str], list[str]]:
    """Return (character_names, weapon_names, local_character_headliners_in_order)."""
    with zipfile.ZipFile(BANNER_XLSX) as z:
        shared = load_shared_strings(z)

        def load_list_sheet(sheet_xml: str) -> set[str]:
            root = ET.fromstring(z.read(sheet_xml))
            names = set()
            for row in root.findall(".//s:sheetData/s:row", NS):
                cells = {}
                for c in row.findall("s:c", NS):
                    col = col_to_idx(c.get("r"))
                    t = c.get("t")
                    v = c.find("s:v", NS)
                    val = v.text if v is not None else ""
                    if t == "s" and val != "":
                        val = shared[int(val)]
                    cells[col] = val
                name = cells.get(4)  # column D = Name
                if name:
                    names.add(name.strip().lower())
            return names

        character_names = load_list_sheet("xl/worksheets/sheet4.xml")
        weapon_names = load_list_sheet("xl/worksheets/sheet5.xml")

        patch_row = read_row(z, shared, "xl/worksheets/sheet1.xml", 4)
        headliner_row = read_row(z, shared, "xl/worksheets/sheet1.xml", 9)

    maxcol = max(patch_row.keys())
    local_headliners = []
    for col in range(6, maxcol + 1):
        patch = patch_row.get(col)
        name = headliner_row.get(col)
        if patch and name:
            local_headliners.append(name.strip())

    return character_names, weapon_names, local_headliners


def parse_wiki_banners() -> list[dict]:
    data = json.loads(WIKI_JSON.read_text(encoding="utf-8"))
    html = data["parse"]["text"]["*"]

    headings = list(HEADING_RE.finditer(html))
    entries = []
    for i, m in enumerate(headings):
        version_id = htmllib.unescape(m.group(1))
        if not version_id.startswith("Version_"):
            continue  # e.g. "Wishes_by_Version" overview anchor
        patch = version_id[len("Version_"):].replace("_", " ").strip('"')

        start = m.end()
        end = headings[i + 1].start() if i + 1 < len(headings) else len(html)
        chunk = html[start:end]

        rows = ROW_RE.findall(chunk)[1:]  # skip header row
        for row in rows:
            wm = WISH_NAME_RE.search(row)
            if not wm:
                continue
            full_title = htmllib.unescape(wm.group(1))
            parts = full_title.split("/")
            wish_name = parts[0]
            start_date = parts[1] if len(parts) > 1 else None

            units = []
            for qm in QUALITY_RE.finditer(row):
                rarity = int(qm.group(1))
                tm = TITLE_RE.search(row[qm.end():])
                if not tm:
                    continue
                units.append({"name": htmllib.unescape(tm.group(1)), "rarity": rarity})

            if not units or not start_date:
                continue  # permanent wish (no rate-ups, no date)

            entries.append({"patch": patch, "wish_name": wish_name, "start_date": start_date, "units": units})

    return entries


def fetch_chronicled_four_star_pools(chronicled_entries: list[dict]) -> None:
    """For each chronicled entry, fetch its dated instance page and fill in
    four_star with every rarity-4 unit listed there (characters and/or
    weapons, order preserved, deduped). Cached by "wish_name/start_date"
    page key so re-runs don't re-hit the network."""
    cache = {}
    if CHRONICLED_CACHE_JSON.exists():
        cache = json.loads(CHRONICLED_CACHE_JSON.read_text(encoding="utf-8"))

    for e in chronicled_entries:
        page_key = f"{e['wish_name']}/{e['start_date']}"
        if page_key in cache:
            html = cache[page_key]
        else:
            url = (
                "https://genshin-impact.fandom.com/api.php?action=parse&page="
                + urllib.parse.quote(page_key)
                + "&format=json&prop=text"
            )
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (genshin-pull-simulator-data-prep)"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            html = data["parse"]["text"]["*"]
            cache[page_key] = html
            time.sleep(0.5)

        positions = [(m.start(), int(m.group(1))) for m in QUALITY_RE.finditer(html)]
        seen = set()
        four_star = []
        for pos, rarity in positions:
            if rarity != 4:
                continue
            tm = TITLE_RE.search(html[pos:pos + 400])
            if not tm:
                continue
            name = htmllib.unescape(tm.group(1))
            if name not in seen:
                seen.add(name)
                four_star.append({"name": name, "rarity": 4})

        e["four_star"] = four_star

    CHRONICLED_CACHE_JSON.parent.mkdir(parents=True, exist_ok=True)
    CHRONICLED_CACHE_JSON.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")


def classify(entries: list[dict], character_names: set[str], weapon_names: set[str]) -> list[dict]:
    unclassified = []

    for e in entries:
        units = e["units"]
        five_star = [u for u in units if u["rarity"] == 5]
        four_star = [u for u in units if u["rarity"] == 4]

        if not four_star and len(five_star) >= 2:
            banner_type = "chronicled"
        elif all(u["name"].lower() in weapon_names for u in units):
            banner_type = "weapon"
        elif all(u["name"].lower() in character_names for u in units):
            banner_type = "character"
        else:
            banner_type = "character" if any(u["name"].lower() in character_names for u in units) else "weapon"
            unclassified.append((e["patch"], e["wish_name"], [u["name"] for u in units]))

        e["banner_type"] = banner_type
        e["five_star"] = five_star
        e["four_star"] = four_star

    if unclassified:
        print(f"WARNING: {len(unclassified)} banners had mixed/unrecognized unit names:")
        for u in unclassified:
            print("  ", u)

    return entries


def assign_phases(entries: list[dict]) -> list[dict]:
    """Number phases per patch by distinct start_date across ALL banner
    types combined, so banners that ran at the same time share a phase."""
    by_patch: dict[str, list[dict]] = {}
    for e in entries:
        by_patch.setdefault(e["patch"], []).append(e)

    for patch, patch_entries in by_patch.items():
        distinct_dates = sorted({e["start_date"] for e in patch_entries})
        phase_by_date = {date: i for i, date in enumerate(distinct_dates, start=1)}
        for e in patch_entries:
            e["phase"] = phase_by_date[e["start_date"]]

    return entries


def cross_check(entries: list[dict], local_headliners: list[str]) -> None:
    character_entries = [e for e in entries if e["banner_type"] == "character"]
    character_entries.sort(key=lambda e: (e["patch"], e["start_date"]))

    mismatches = []
    for i, local_name in enumerate(local_headliners):
        if i >= len(character_entries):
            mismatches.append((local_name, "no corresponding wiki entry (index out of range)"))
            continue
        remote_names = {u["name"].lower() for u in character_entries[i]["five_star"]}
        if local_name.lower() not in remote_names:
            mismatches.append((local_name, character_entries[i]))

    if len(character_entries) != len(local_headliners):
        print(
            f"NOTE: local spreadsheet has {len(local_headliners)} character-banner phases, "
            f"wiki-derived data has {len(character_entries)}."
        )

    if mismatches:
        print(f"WARNING: {len(mismatches)} cross-check mismatches:")
        for m in mismatches:
            print("  ", m)
    else:
        print(f"Cross-check OK: all {min(len(local_headliners), len(character_entries))} compared headliners matched.")


def main() -> None:
    character_names, weapon_names, local_headliners = load_local_rosters()
    entries = parse_wiki_banners()
    entries = classify(entries, character_names, weapon_names)

    chronicled_entries = [e for e in entries if e["banner_type"] == "chronicled"]
    fetch_chronicled_four_star_pools(chronicled_entries)
    print(f"Fetched 4-star pools for {len(chronicled_entries)} chronicled banners")

    entries = assign_phases(entries)
    cross_check(entries, local_headliners)

    # `entries` is already in chronological order: parse_wiki_banners walks
    # the wiki page version-by-version, and rows within a version are
    # already date-ordered, so no re-sort is needed (and re-sorting by the
    # patch *label* would be unsafe -- "Luna II" vs "1.1" is not a
    # meaningful string comparison).
    output = [
        {
            "patch": e["patch"],
            "phase": e["phase"],
            "banner_type": e["banner_type"],
            "five_star": e["five_star"],
            "four_star": e["four_star"],
        }
        for e in entries
    ]

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {len(output)} banner entries to {OUT_JSON}")


if __name__ == "__main__":
    main()
