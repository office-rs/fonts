# fonts

Font-slicing pipeline and npm packages for Rword: Python tooling under `tools/` slices full CJK fonts from `sources/` into per-character subset packages under `packages/`, and `packages/font-runtime` (`@office-rs/font-runtime`) loads and stitches those slices at runtime for the web renderer. Design spec: [2026-10-13-font-slicing-design](https://github.com/office-rs/rword/blob/main/docs/superpowers/specs/2026-10-13-font-slicing-design.md).
