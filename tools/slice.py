#!/usr/bin/env python3
"""Slice a font into codepoint-range WOFF2 subsets + manifest.json (spec 6.2).

Common slices: frequency-clustered (top-N chars from a freq table, present in cmap).
common-0 (the preload slice) additionally carries the family's own ASCII
(cmap-present U+0020-007E): a run whose resolved font slots all name the CJK
family must shape its digits/Latin from the family itself, not from the global
fallback chain ("bold digits" bug, 2026-10-18).
Block slices: remaining CJK codepoints (>= CJK_START) chunked into fixed-size ranges.
Latin codepoints outside ASCII (< CJK_START, > 0x7E) are NOT sliced here — the
Latin family ships whole.
"""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

CJK_START = 0x2E80  # CJK radicals onwards; Latin/punct stays in the whole Latin font
ASCII_LO, ASCII_HI = 0x20, 0x7E  # preloaded into common-0 (see module docstring)


def load_cmap(path: str, face_index: int) -> set[int]:
    font = TTFont(path, fontNumber=face_index)
    return set(font.getBestCmap().keys())


def load_freq(path: str | None, cmap: set[int]) -> list[int]:
    """Frequency-ordered codepoints from a `char\tcount` table.

    Only chars present in the cmap AND in the CJK region are kept — commons
    stay CJK-only; the family's ASCII reaches common-0 only through the
    explicit preload merge in main(), never from the freq table.
    """
    if not path:
        return []
    chars = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        ch = line.split("\t")[0]
        if len(ch) == 1 and ord(ch) in cmap and ord(ch) >= CJK_START:
            chars.append(ord(ch))
    return chars


def to_ranges(cps: list[int]) -> list[list[int]]:
    """Compress a sorted-or-compressible codepoint list into closed [lo, hi] ranges."""
    out, start, prev = [], None, None
    for cp in sorted(cps):
        if start is None:
            start = prev = cp
            continue
        if cp == prev + 1:
            prev = cp
        else:
            out.append([start, prev])
            start = prev = cp
    if start is not None:
        out.append([start, prev])
    return out


def ext(flavor: str | None) -> str:
    return ".woff2" if flavor == "woff2" else ".otf"


def emit(src: str, face_index: int, unicodes: list[int], out_path: Path,
         flavor: str | None) -> None:
    """Subset `src` down to `unicodes` and save as `flavor` at `out_path`.

    TTFont.save() only applies the woff2 flavor when `font.flavor` is set on the
    font object itself — Options.flavor alone does not survive a direct save.
    """
    opts = subset.Options()
    opts.flavor = flavor
    opts.name_IDs = ["*"]  # keep name table for displayName matching
    opts.drop_tables += ["DSIG"]
    # load_font ignores fontNumber for ttc; reopen with the right face when needed
    font = TTFont(src, fontNumber=face_index) if src.lower().endswith(".ttc") \
        else subset.load_font(src, opts)
    font.flavor = flavor
    ss = subset.Subsetter(opts)
    ss.populate(unicodes=unicodes)
    ss.subset(font)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    font.save(str(out_path))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--key", required=True)
    ap.add_argument("--display-name")
    ap.add_argument("--freq")
    ap.add_argument("--out", required=True)
    ap.add_argument("--face-index", type=int, default=0)
    ap.add_argument("--common-count", type=int, default=4)
    ap.add_argument("--common-per-slice", type=int, default=800)
    ap.add_argument("--block-size", type=int, default=256)
    ap.add_argument("--no-woff2", action="store_true")
    ap.add_argument("--is-latin", action="store_true",
                    help="treat as the whole Latin family: emit only whole+manifest")
    args = ap.parse_args()

    out_dir = Path(args.out)
    fam_dir = out_dir / args.key
    fam_dir.mkdir(parents=True, exist_ok=True)
    src_font = TTFont(args.input, fontNumber=args.face_index)
    display = args.display_name or next(
        (r.toUnicode() for r in src_font["name"].names if r.nameID == 1), args.key)
    cmap = load_cmap(args.input, args.face_index)
    flavor = None if args.no_woff2 else "woff2"

    family: dict = {"displayName": display}

    def file_entry(rel: str) -> dict:
        data = (fam_dir / rel).read_bytes()
        return {"url": f"{args.key}/{rel}",
                "format": "otf" if flavor is None else "woff2",
                "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}

    if args.is_latin:
        emit(args.input, args.face_index, sorted(cmap),
             fam_dir / ("regular" + ext(flavor)), flavor)
        family["whole"] = file_entry("regular" + ext(flavor))
    else:
        freq = load_freq(args.freq, cmap)
        commons = freq[: args.common_count * args.common_per_slice]
        # common-0 preloads the family's own ASCII: a run whose resolved font
        # slots all name this family shapes ASCII digits/Latin from here, not
        # from the global fallback chain ("bold digits" bug, 2026-10-18).
        ascii_preload = sorted(cp for cp in cmap if ASCII_LO <= cp <= ASCII_HI)
        slices = []
        for i in range(args.common_count):
            chunk = commons[i * args.common_per_slice:(i + 1) * args.common_per_slice]
            if i == 0 and ascii_preload:
                chunk = sorted(set(chunk) | set(ascii_preload))
            if not chunk:
                break
            rel = f"common-{i}{ext(flavor)}"
            emit(args.input, args.face_index, chunk, fam_dir / rel, flavor)
            entry = file_entry(rel)
            entry.update({"id": f"common-{i}", "kind": "common", "preload": i == 0,
                          "codepoints": to_ranges(chunk)})
            slices.append(entry)
        rest = sorted(cp for cp in cmap
                      if cp >= CJK_START and cp not in set(commons))
        for i in range(0, len(rest), args.block_size):
            chunk = rest[i:i + args.block_size]
            rel = f"blk-{i // args.block_size:04d}{ext(flavor)}"
            emit(args.input, args.face_index, chunk, fam_dir / rel, flavor)
            entry = file_entry(rel)
            entry.update({"id": f"blk-{i // args.block_size:04d}", "kind": "block",
                          "codepoints": to_ranges(chunk)})
            slices.append(entry)
        family["slices"] = slices
        # full fallback (woff2-encoded whole source)
        emit(args.input, args.face_index, sorted(cmap),
             fam_dir / f"full{ext(flavor)}", flavor)
        family["full"] = file_entry(f"full{ext(flavor)}")

    manifest_path = out_dir / "manifest.json"
    if manifest_path.exists():
        merged = json.loads(manifest_path.read_text(encoding="utf-8"))
    else:
        merged = {"version": 1,
                  "generated": datetime.now(timezone.utc).isoformat(),
                  "families": {}}
    assert args.key not in merged["families"], f"family key conflict: {args.key}"
    merged["families"][args.key] = family
    manifest_path.write_text(json.dumps(merged, ensure_ascii=False, indent=1),
                             encoding="utf-8")
    print(f"sliced {args.key}: {len(family.get('slices', []))} slices -> {fam_dir}")


if __name__ == "__main__":
    main()
