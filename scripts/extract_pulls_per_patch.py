"""
Build data/pulls_per_patch.json from "genshin pulls.xlsx" (sheet1): a
dedicated file the user maintains with {patch, limited pulls, standard
pulls, standard pulls updated} per patch. The "standard pulls updated"
column is preferred when present; falls back to "standard pulls" (col C)
otherwise.

Patch numbers are stored as Excel floats and, for the 8 patches after
5.8, use "6.0".."6.7" -- remapped to "Luna I".."Luna VIII" via
patch_utils.format_patch to match banners.json.
"""
import json
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

from patch_utils import format_patch

ROOT = Path(__file__).resolve().parent.parent
PULLS_XLSX = ROOT / "genshin pulls.xlsx"
OUT_JSON = ROOT / "data" / "pulls_per_patch.json"

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


def load_row_map(z: zipfile.ZipFile, sheet_path: str, shared: list[str]) -> dict[int, dict[int, str]]:
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


def main() -> None:
    with zipfile.ZipFile(PULLS_XLSX) as z:
        shared = load_shared_strings(z)
        row_map = load_row_map(z, "xl/worksheets/sheet1.xml", shared)

    header = row_map[1]
    standard_col = 3
    for col, name in header.items():
        if name == "standard pulls updated":
            standard_col = col
            break

    results = []
    for row_num in sorted(row_map):
        if row_num == 1:
            continue  # header
        row = row_map[row_num]
        patch_raw = row.get(1)
        limited_raw = row.get(2)
        standard_raw = row.get(standard_col)
        if not patch_raw or limited_raw in (None, "") or standard_raw in (None, ""):
            continue
        results.append(
            {
                "patch": format_patch(patch_raw),
                "limited_pulls": round(float(limited_raw), 2),
                "standard_pulls": round(float(standard_raw), 2),
            }
        )

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"Wrote {len(results)} patch entries to {OUT_JSON}")


if __name__ == "__main__":
    main()
