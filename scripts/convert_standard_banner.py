"""
Convert "standard banner.xlsx" into data/standard_banner.json:
  - "character": {"initial": {five_star, four_star}, "additions": [...]}
  - "weapon": {"initial": {five_star, four_star}, "additions": [...]}

Sheet 1 ("initial banner"): column B = initial 5-star characters, column C
= initial 4-star characters, column D = initial 5-star weapons, column E =
initial 4-star weapons (weapon columns added later; resolved against the
local "Weapon List" roster instead of "Character List").

Sheet 2 ("additions per patch"): column A = patch (stored as a float by
Excel, needs re-formatting), columns B/C = up to two 4-star character
additions that patch, column D = a 5-star character addition that patch
(at most one ever appears in this file). Verified against real game
history: patch 3.1's row lists 3 names across B/C/D (dori, collei,
tighnari) -- confirmed this is 2 four-star additions (Dori, Collei) plus
Tighnari as a genuine 5-star addition to the standard banner in 3.1, not a
data-entry mistake. This sheet has no weapon-addition columns yet, so
"weapon"."additions" is empty until that data is added to the source file.

Names in this sheet are inconsistently cased and contain a few
typos/spacing quirks (e.g. "yunjin", "ga ming", "sethoss", "skyward
blade"), so each name is resolved to its canonical spelling via a
normalized (lowercased, space/punctuation stripped) lookup built from the
banner-history file's "Character List"/"Weapon List" sheets. Any name that
fails to resolve is reported, not silently guessed.
"""
import difflib
import json
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

from patch_utils import format_patch

ROOT = Path(__file__).resolve().parent.parent
SRC_XLSX = ROOT / "standard banner.xlsx"
ROSTER_XLSX = ROOT / "Genshin Impact Character & Weapon Banner History.xlsx"
OUT_JSON = ROOT / "data" / "standard_banner.json"

NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def col_to_idx(ref: str) -> int:
    letters = re.match(r"([A-Z]+)", ref).group(1)
    idx = 0
    for ch in letters:
        idx = idx * 26 + (ord(ch) - 64)
    return idx


def load_shared_strings(z: zipfile.ZipFile) -> list[str]:
    root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    return ["".join(t.text or "" for t in si.findall(".//s:t", NS)) for si in root.findall("s:si", NS)]


def load_rows(z: zipfile.ZipFile, sheet_path: str, shared: list[str]) -> dict[int, dict[int, str]]:
    root = ET.fromstring(z.read(sheet_path))
    row_map = {}
    for row in root.findall(".//s:sheetData/s:row", NS):
        row_dict = {}
        for c in row.findall("s:c", NS):
            col = col_to_idx(c.get("r"))
            t = c.get("t")
            v = c.find("s:v", NS)
            val = v.text if v is not None else ""
            if t == "s" and val != "":
                val = shared[int(val)]
            row_dict[col] = val
        row_map[int(row.get("r"))] = row_dict
    return row_map


def normalize(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def load_canonical_names(sheet_xml: str) -> dict[str, str]:
    """normalized name -> canonical (properly-cased) name, from a local
    roster sheet (Character List = sheet4, Weapon List = sheet5) in the
    banner-history file."""
    with zipfile.ZipFile(ROSTER_XLSX) as z:
        shared = load_shared_strings(z)
        rows = load_rows(z, sheet_xml, shared)

    lookup = {}
    for row in rows.values():
        name = row.get(4)
        if name:
            lookup[normalize(name)] = name.strip()
    return lookup


def resolve_name(raw: str, lookup: dict[str, str]) -> str:
    key = normalize(raw)
    if key in lookup:
        return lookup[key]
    close = difflib.get_close_matches(key, lookup.keys(), n=1, cutoff=0.75)
    if close:
        resolved = lookup[close[0]]
        print(f"NOTE: resolved '{raw}' -> '{resolved}' via fuzzy match")
        return resolved
    print(f"WARNING: could not resolve name '{raw}' to a known roster entry, keeping as-is")
    return raw.strip()


def main() -> None:
    character_lookup = load_canonical_names("xl/worksheets/sheet4.xml")
    weapon_lookup = load_canonical_names("xl/worksheets/sheet5.xml")

    with zipfile.ZipFile(SRC_XLSX) as z:
        shared = load_shared_strings(z)
        initial_rows = load_rows(z, "xl/worksheets/sheet1.xml", shared)
        addition_rows = load_rows(z, "xl/worksheets/sheet2.xml", shared)

    initial_char_five_star = []
    initial_char_four_star = []
    initial_weapon_five_star = []
    initial_weapon_four_star = []
    for row_num in sorted(initial_rows):
        if row_num == 1:
            continue  # header
        row = initial_rows[row_num]
        if row.get(2):
            initial_char_five_star.append(resolve_name(row[2], character_lookup))
        if row.get(3):
            initial_char_four_star.append(resolve_name(row[3], character_lookup))
        if row.get(4):
            initial_weapon_five_star.append(resolve_name(row[4], weapon_lookup))
        if row.get(5):
            initial_weapon_four_star.append(resolve_name(row[5], weapon_lookup))

    character_additions = []
    for row_num in sorted(addition_rows):
        if row_num == 1:
            continue  # header
        row = addition_rows[row_num]
        patch_raw = row.get(1)
        if not patch_raw:
            continue
        four_star = [resolve_name(row[c], character_lookup) for c in (2, 3) if row.get(c)]
        five_star = [resolve_name(row[4], character_lookup)] if row.get(4) else []
        if not four_star and not five_star:
            continue
        character_additions.append({"patch": format_patch(patch_raw), "five_star": five_star, "four_star": four_star})

    output = {
        "character": {
            "initial": {"five_star": initial_char_five_star, "four_star": initial_char_four_star},
            "additions": character_additions,
        },
        "weapon": {
            "initial": {"five_star": initial_weapon_five_star, "four_star": initial_weapon_four_star},
            "additions": [],
        },
    }

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")
    print(
        f"Characters: {len(initial_char_five_star)} initial 5-star, {len(initial_char_four_star)} initial 4-star, "
        f"{len(character_additions)} patch additions.\n"
        f"Weapons: {len(initial_weapon_five_star)} initial 5-star, {len(initial_weapon_four_star)} initial 4-star, "
        f"0 patch additions (source sheet has no weapon-addition columns yet).\n"
        f"Wrote {OUT_JSON}"
    )


if __name__ == "__main__":
    main()
