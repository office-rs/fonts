#!/usr/bin/env python3
"""Integrity gate for a sliced dist tree (spec 6.5): files parse, hashes/sizes match,
codepoint union equals the source cmap (CJK region + common-0's preloaded family
ASCII), budgets hold."""
import argparse, hashlib, json, sys
from pathlib import Path
from fontTools.ttLib import TTFont

BUDGETS = {"common": 1_000_000, "block": 300_000}
CJK_START = 0x2E80  # must mirror slice.py: sliced coverage is the CJK region
ASCII_LO, ASCII_HI = 0x20, 0x7E  # must mirror slice.py: common-0 preloads family ASCII

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
            src_path = find_source(Path(args.sources), key)
            # collections: verify against face 0 (slice.py's default --face-index;
            # the manifest does not record the face a family was cut from)
            src = TTFont(src_path, fontNumber=0) if src_path.suffix.lower() == ".ttc" \
                else TTFont(src_path)
            src_cps = set(src.getBestCmap())
            expected = ({cp for cp in src_cps if cp >= CJK_START}
                        | {cp for cp in src_cps if ASCII_LO <= cp <= ASCII_HI})
            if seen != expected:
                missing = len(expected - seen)
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
