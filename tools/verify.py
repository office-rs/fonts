#!/usr/bin/env python3
"""Integrity gate for a sliced dist tree (spec 6.5): files parse, hashes/sizes match,
codepoint union equals the source cmap (CJK region), budgets hold."""
import argparse, hashlib, json, sys
from pathlib import Path
from fontTools.ttLib import TTFont

BUDGETS = {"common": 1_000_000, "block": 300_000}
CJK_START = 0x2E80  # must mirror slice.py: sliced coverage is the CJK region

def fail(msg: str) -> None:
    print(f"verify: {msg}", file=sys.stderr); sys.exit(1)

def find_source(sources_dir: Path, key: str) -> Path:
    """Source font for a family key: stem equals the key or starts with `key-`
    (notosanscjksc -> NotoSansCJKsc-Regular.otf). The `key-` boundary keeps
    `notosans` from matching NotoSansCJKsc-Regular.otf."""
    for p in sorted(sources_dir.iterdir()):
        stem = p.stem.lower()
        if stem == key or stem.startswith(key + "-"):
            return p
    fail(f"{key}: no source font matching key in {sources_dir}")

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest")
    ap.add_argument("--sources", required=False)
    args = ap.parse_args()
    root = Path(args.manifest).parent
    m = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    if m.get("version") != 1:
        fail("unsupported manifest version")
    for key, fam in m["families"].items():
        for ref in filter(None, [fam.get("whole"), fam.get("full")]):
            check_file(root, ref, key)
        seen: set[int] = set()
        for s in fam.get("slices", []):
            check_file(root, s, key)
            if s["bytes"] > BUDGETS.get(s["kind"], 1 << 30):
                fail(f"{key}/{s['id']} over budget: {s['bytes']}")
            for lo, hi in s["codepoints"]:
                if lo > hi:
                    fail(f"{key}/{s['id']} bad range")
                if seen.intersection(range(lo, hi + 1)):
                    fail(f"{key}/{s['id']} overlapping codepoints")
                seen.update(range(lo, hi + 1))
            TTFont(root / s["url"])  # parses (woff2 needs brotli installed)
        if args.sources and fam.get("slices"):
            src = TTFont(find_source(Path(args.sources), key))
            src_cjk = {cp for cp in src.getBestCmap() if cp >= CJK_START}
            if seen != src_cjk:
                missing = len(src_cjk - seen)
                fail(f"{key} coverage mismatch, missing {missing} codepoints")
    print("verify: ok")

def check_file(root: Path, ref: dict, key: str) -> None:
    p = root / ref["url"]
    if not p.exists():
        fail(f"{key}: missing file {ref['url']}")
    data = p.read_bytes()
    if len(data) != ref["bytes"] or hashlib.sha256(data).hexdigest() != ref["sha256"]:
        fail(f"{key}/{ref['url']}: sha256/bytes mismatch")

if __name__ == "__main__":
    main()
