"""Shared test helpers — a tiny CJK source font.

The real NotoSansCJKsc-Regular.otf is a 16 MB, ~44k-codepoint source; slicing
it per test costs minutes. `make_tiny_cjk_font` pre-subsets it down to ASCII
plus ~500 frequent CJK codepoints so slice/verify round-trip tests run in
seconds while keeping the codepoint layout (ASCII + CJK-only region) real.
"""
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

REPO = Path(__file__).resolve().parent.parent


def make_tiny_cjk_font(dest: Path, cjk_count: int = 500) -> Path:
    """Subset NotoSansCJKsc into `dest`: ASCII 0x20-0x7E + top `cjk_count`
    freq-list CJK codepoints present in the cmap. Returns `dest`."""
    src = REPO / "sources/NotoSansCJKsc-Regular.otf"
    cmap = TTFont(src).getBestCmap()
    keep = [cp for cp in sorted(cmap) if 0x20 <= cp <= 0x7E]
    freq_lines = (REPO / "tools/freq/junda.txt").read_text(
        encoding="utf-8").splitlines()
    cjk = [ord(line.split("\t")[0]) for line in freq_lines
           if len(line.split("\t")[0]) == 1
           and ord(line.split("\t")[0]) in cmap
           and ord(line.split("\t")[0]) >= 0x2E80]
    keep += cjk[:cjk_count]
    opts = subset.Options()
    opts.drop_tables += ["DSIG"]
    font = subset.load_font(str(src), opts)
    ss = subset.Subsetter(opts)
    ss.populate(unicodes=keep)
    ss.subset(font)
    dest.parent.mkdir(parents=True, exist_ok=True)
    font.save(str(dest))
    return dest
