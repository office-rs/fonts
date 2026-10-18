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
ASCII_LO, ASCII_HI = 0x20, 0x7E  # must mirror slice.py: common-0 preloads family ASCII


def run_slice(inp: str, key: str, extra: list[str] = []) -> tuple[Path, dict]:
    """Run slice.py into a fresh temp dir; return (out_dir, parsed manifest)."""
    out = tempfile.mkdtemp()
    subprocess.run(
        [sys.executable, str(REPO / "tools/slice.py"), "--input", inp,
         "--key", key, "--out", out, "--block-size", "64", *extra],
        check=True,
    )
    manifest = json.loads((Path(out) / "manifest.json").read_text(encoding="utf-8"))
    return Path(out), manifest


def assert_woff2_magic(path: Path) -> None:
    # Regression guard for the Task 5 lesson: TTFont.save() only applies the
    # woff2 flavor when font.flavor is set on the font object — the manifest's
    # format field alone would stay green while the bytes stay TTF/OTF.
    assert path.read_bytes()[:4] == b"wOF2", f"not woff2 bytes: {path}"


def test_small_font_slices():
    # NotoSans is the Latin family: ships whole (no slices), converted to woff2.
    out, m = run_slice(str(REPO / "sources/NotoSans-Regular.ttf"), "notosans",
                       ["--is-latin"])
    fam = m["families"]["notosans"]
    assert fam["displayName"]
    assert fam["whole"]["format"] == "woff2"
    assert fam["whole"]["bytes"] > 0
    assert "slices" not in fam and "full" not in fam
    assert_woff2_magic(out / "notosans" / "regular.woff2")


def test_cjk_layout_common_then_blocks():
    out, m = run_slice(
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
    # slices cover the CJK region of the source cmap plus common-0's preloaded
    # family ASCII — the remaining Latin still ships only via the whole Latin
    # family / the family's own `full` fallback
    from fontTools.ttLib import TTFont
    src = TTFont(REPO / "sources/NotoSansCJKsc-Regular.otf")
    src_cps = set(src.getBestCmap().keys())
    assert seen == ({cp for cp in src_cps if cp >= CJK_START}
                    | {cp for cp in src_cps if ASCII_LO <= cp <= ASCII_HI})
    # every artifact class (common, block, full) is genuinely woff2 bytes
    assert_woff2_magic(out / commons[0]["url"])
    assert_woff2_magic(out / blocks[0]["url"])
    assert_woff2_magic(out / fam["full"]["url"])


def test_common0_preloads_family_ascii(tmp_path):
    # "bold digits" regression (2026-10-18): a run whose resolved font slots
    # all name a CJK family shapes its ASCII digits from the global fallback
    # chain when the family's slices carry no ASCII — visually a different
    # (heavier) glyph set. common-0, the preload slice, must carry the
    # family's own cmap-present ASCII, and no other slice may.
    from _testutil import make_tiny_cjk_font
    tiny = make_tiny_cjk_font(tmp_path / "notosanscjksc-tiny.otf")
    out, m = run_slice(
        str(tiny), "notosanscjksc",
        ["--freq", str(REPO / "tools/freq/junda.txt"),
         "--common-count", "2", "--common-per-slice", "200",
         "--block-size", "100"],
    )
    fam = m["families"]["notosanscjksc"]
    common0 = next(s for s in fam["slices"] if s["id"] == "common-0")
    assert common0["preload"] is True
    cps0 = {cp for lo, hi in common0["codepoints"] for cp in range(lo, hi + 1)}
    for ch in "0123456789":
        assert ord(ch) in cps0, f"digit {ch!r} missing from common-0"
    from fontTools.ttLib import TTFont
    src_ascii = {cp for cp in TTFont(tiny).getBestCmap()
                 if ASCII_LO <= cp <= ASCII_HI}
    assert src_ascii, "test font unexpectedly lacks ASCII"
    assert src_ascii <= cps0, "common-0 must preload the family's full ASCII"
    for s in fam["slices"]:
        if s["id"] != "common-0":
            for lo, _hi in s["codepoints"]:
                assert lo >= CJK_START, "ASCII leaked outside common-0"
    assert_woff2_magic(out / common0["url"])
