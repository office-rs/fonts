"""Tests for tools/slice.py — spec 6.2 slicing semantics.

Run with the pinned interpreter:
  C:/Users/flw/AppData/Local/Python/pythoncore-3.14-64/python.exe -m pytest tools/ -q
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

CJK_START = 0x2E80  # must mirror slice.py: only CJK codepoints get sliced


def run_slice(inp: str, key: str, extra: list[str] = []) -> dict:
    out = tempfile.mkdtemp()
    subprocess.run(
        [sys.executable, str(REPO / "tools/slice.py"), "--input", inp,
         "--key", key, "--out", out, "--block-size", "64", *extra],
        check=True,
    )
    return json.loads((Path(out) / "manifest.json").read_text(encoding="utf-8"))


def test_small_font_slices():
    # NotoSans is the Latin family: ships whole (no slices), converted to woff2.
    m = run_slice(str(REPO / "sources/NotoSans-Regular.ttf"), "notosans",
                  ["--is-latin"])
    fam = m["families"]["notosans"]
    assert fam["displayName"]
    assert fam["whole"]["format"] == "woff2"
    assert fam["whole"]["bytes"] > 0
    assert "slices" not in fam and "full" not in fam


def test_cjk_layout_common_then_blocks():
    m = run_slice(
        str(REPO / "sources/NotoSansCJKsc-Regular.otf"), "notosanscjksc",
        ["--freq", str(REPO / "tools/freq/junda.txt"),
         "--common-count", "2", "--common-per-slice", "500",
         "--block-size", "2048"],
    )
    fam = m["families"]["notosanscjksc"]
    commons = [s for s in fam["slices"] if s["kind"] == "common"]
    blocks = [s for s in fam["slices"] if s["kind"] == "block"]
    assert len(commons) == 2 and commons[0]["preload"] is True
    assert len(blocks) >= 10  # ~29k CJK codepoints / 2048 per block
    # slice intervals must be disjoint across all slices
    seen = set()
    for s in fam["slices"]:
        for lo, hi in s["codepoints"]:
            assert lo <= hi
            assert not any(c in seen for c in range(lo, hi + 1))
            seen.update(range(lo, hi + 1))
    # slices cover exactly the CJK region of the source cmap — Latin stays whole
    from fontTools.ttLib import TTFont
    src = TTFont(REPO / "sources/NotoSansCJKsc-Regular.otf")
    src_cps = set(src.getBestCmap().keys())
    assert seen == {cp for cp in src_cps if cp >= CJK_START}
