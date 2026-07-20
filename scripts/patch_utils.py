"""Shared patch-label normalization for the data-prep scripts.

Source spreadsheets store patch numbers as Excel floats (with the usual
binary-float imprecision, e.g. "2.2999999999999998" for 2.3) and
sometimes extra text (e.g. "6.7 est."). The game's own versioning
switched from decimal patches to "Luna I".."Luna VIII" for the 8 patches
after 5.8 -- banners.json uses the Luna names, so any other source using
"6.0".."6.7" for that span must be remapped to match.
"""
import re

LUNA_NAMES = ["Luna I", "Luna II", "Luna III", "Luna IV", "Luna V", "Luna VI", "Luna VII", "Luna VIII"]


def format_patch(raw: str) -> str:
    numeric = re.match(r"[\d.]+", raw.strip())
    value = round(float(numeric.group()), 1)
    if 6.0 <= value <= 6.7:
        return LUNA_NAMES[round((value - 6.0) * 10)]
    return f"{value:.1f}"
