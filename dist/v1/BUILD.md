# dist/v1 build provenance

Sliced 2026-10-14 by `tools/slice.py` at default parameters
(`--common-count 4 --common-per-slice 800 --block-size 256`), WOFF2 flavor,
freq table `tools/freq/junda.txt` (Jun Da modern Chinese frequency list).

Re-cut 2026-10-18 (both CJK families, same invocations) after slice.py
learned to preload the family's own ASCII into common-0 (the rword "bold
digits" fix): only common-0 changed per family (+9,428 B sans, +14,468 B
serif); every other artifact is byte-identical to the 2026-10-14 cut.

Integrity gate (CI + local, spec 6.5):

```
python tools/verify.py dist/v1/manifest.json --sources sources/
```

Result on this tree: `verify: ok` (exit 0) — all sha256/bytes match, every
slice parses as WOFF2, slice codepoints are disjoint, and each CJK family's
codepoint union equals its source cmap above U+2E80 plus common-0's preloaded
ASCII (U+0020-007E).

## Slice invocations

```bash
python tools/slice.py --input sources/NotoSans-Regular.ttf --key notosans --is-latin --out dist/v1
python tools/slice.py --input sources/NotoSansCJKsc-Regular.otf --key notosanscjksc --freq tools/freq/junda.txt --out dist/v1
python tools/slice.py --input sources/NotoSerifCJKsc-Regular.otf --key notoserifcjksc --freq tools/freq/junda.txt --out dist/v1
```

## Per-family numbers (woff2 bytes)

| family | display name | common | block | largest common | largest block | whole | full | family total |
|---|---|---|---|---|---|---|---|---|
| notosans | Noto Sans | 0 | 0 | — | — | 189,888 | — | 189,888 (0.18 MB) |
| notosanscjksc | Noto Sans CJK SC | 4 | 158 | 330,648 | 176,796 | — | 11,264,580 (10.74 MB) | 24,413,276 (23.28 MB) |
| notoserifcjksc | Noto Serif CJK SC | 4 | 157 | 484,856 | 294,528 | — | 16,476,968 (15.71 MB) | 37,484,992 (35.74 MB) |

Whole tree: 326 files, 62,088,156 B (59.21 MB) of font artifacts plus
`manifest.json` (the 2026-10-14 tree carried one stray extra file, gone with
the re-cut). Original slice wall time: ~16 min total (latin 3 s, sans CJK
6 m 14 s, serif CJK 10 m 0 s); the 2026-10-18 re-cut ran in the same range.

## Budget check (spec 6.2)

- common slice ≤ 1 MB (verify.py gate): largest common is 484,856 B (serif) — PASS
  (common-0 with the ASCII preload lands at 324,004 B serif / 232,916 B sans, still far under)
- block slice ≤ 300 KB (verify.py gate): largest block is 294,528 B (serif) — PASS,
  with only 1.8% headroom; a serif-heavy block-size bump would breach this gate
- jsDelivr 20 MB per-file cap: largest file is serif `full.woff2` at 15.71 MB — PASS
- spec 6.2 slice-count sweet spot 100–200 per CJK family: 162 / 161 — in range
  (above the spec's rough ~100–120 estimate; driven by the 256-codepoint default
  block size over ~44k CJK codepoints per source)

## Sources

Per `sources/VERSIONS.txt`: NotoSans-Regular 2.015, NotoSansCJKsc-Regular 2.004,
NotoSerifCJKsc-Regular 2.003. Licensed under OFL 1.1 (`sources/OFL.txt`).
