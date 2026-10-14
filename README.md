# fonts

Font-slicing pipeline and npm packages for [Rword](https://github.com/office-rs/rword):
Python tooling under `tools/` slices full CJK fonts from `sources/` into
per-character subset packages under `packages/`, and `packages/font-runtime`
(`@office-rs/font-runtime`) loads and stitches those slices at runtime for the
web renderer. A typical Chinese document (~1500 distinct characters) pulls
under 3 MB of woff2 instead of a 16–24 MB full font, and the editor keeps
loading more slices as the user types.

Design spec: see the rword repository's
[`docs/superpowers/specs/2026-10-13-font-slicing-design.md`](https://github.com/office-rs/rword/blob/main/docs/superpowers/specs/2026-10-13-font-slicing-design.md).

Repository layout:

| Path | Contents |
|---|---|
| `tools/` | `slice.py` (subsetter), `verify.py` (integrity gate), `make-packages.mjs` (npm packaging), `freq/` (frequency tables), pytest suite |
| `sources/` | Upstream Noto TTF/OTF inputs (OFL). Not redistributed beyond slicing |
| `dist/v1/` | Sliced artifacts for manifest schema v1 (committed; provenance in `dist/v1/BUILD.md`) |
| `packages/font-runtime/` | `@office-rs/font-runtime` — runtime loader + vite plugin |
| `packages/fonts-<key>/` | `@office-rs/fonts-notosans`, `-notosanscjksc`, `-notoserifcjksc` — per-family npm asset packages |
| `examples/vite/` | Runnable vite example dogfooding the plugin (build + dev, zero CDN requests) |

## Three delivery channels

All channels speak the same manifest format and the same URL rule: every `url`
inside a manifest resolves relative to the manifest's own location
(`new URL(rel, manifestUrl)`). `@office-rs/font-runtime` merges multiple
manifests by family key (duplicate key = init error, never silent overwrite).

### Channel 1 — CDN (default, zero config)

Manifest URLs are pinned to a major-version git tag (`v1`); upstream Noto
upgrades re-slice under a new tag, old tags stay reproducible forever:

```
https://cdn.jsdelivr.net/gh/office-rs/fonts@v1/dist/v1/manifest.json
```

`FontRuntime` includes this manifest by default (`includeDefaultNoto: true`),
so plain integrations need no font configuration at all:

```ts
import { FontRuntime } from '@office-rs/font-runtime';
const rt = new FontRuntime({ manifests: [] });            // default Noto CDN manifest
await rt.ready();
```

### Channel 2 — npm asset packages (offline / intranet / compliance)

Install only the families you use (Serif is ~19 MB of slices — don't drag it
into every integration):

```bash
npm i @office-rs/font-runtime @office-rs/fonts-notosans @office-rs/fonts-notosanscjksc
```

**vite hosts (preferred):** the official plugin copies nothing at install time —
at build it emits the selected families' slice files plus a single merged
manifest as static assets; in dev it serves them straight from `node_modules`,
so package upgrades apply immediately.

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import rwordFonts from '@office-rs/font-runtime/vite';

export default defineConfig({
  base: '/rword/',                                       // optional — emitted URLs follow base
  plugins: [rwordFonts({ families: ['notosans', 'notosanscjksc'] })],
});

// application code — the virtual module's types ship with the package
import { manifestUrl } from 'virtual:rword-fonts';
const rt = new FontRuntime({ manifests: [manifestUrl], includeDefaultNoto: false });
```

Consumer vite configs need two settings while the runtime keeps its
`new Worker(new URL(...))` + lazy woff2 decoder shape (the example shows them):

```ts
worker: { format: 'es' },      // the decoder's dynamic import splits the worker bundle;
                               // vite's default 'iife' worker format cannot code-split
build: { target: 'es2022' },   // if your entry uses top-level await (as the example does)
```

**Any other build stack — copy script fallback:** slices are referenced by the
manifest at *runtime*, so bundlers cannot discover them via static imports;
copy the files explicitly and pass the copied manifest URL(s):

```bash
# webpack / Rsbuild / plain static hosts
npm i @office-rs/fonts-notosans @office-rs/fonts-notosanscjksc
npm pkg set scripts.copy:fonts="node scripts/copy-fonts.mjs"
npm run copy:fonts        # -> public/fonts/{…slices, manifest.json}
```

`scripts/copy-fonts.mjs` template (copy each installed family package's
`dist/`, then feed the copied manifest URLs to the runtime):

```js
// scripts/copy-fonts.mjs — copy @office-rs/fonts-* packages into public/fonts/
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const out = 'public/fonts';
rmSync(out, { recursive: true, force: true });

for (const name of readdirSync('node_modules/@office-rs')) {
  if (!name.startsWith('fonts-')) continue;
  const manifestPath = require.resolve(`@office-rs/${name}/dist/manifest.json`);
  const dest = join(out, name);
  mkdirSync(dest, { recursive: true });
  cpSync(dirname(manifestPath), dest, { recursive: true });
  console.log(`fonts: ${name} -> ${dest}/manifest.json`);
}
```

```ts
// manifest URL carries the BASE_URL prefix; slice urls resolve against it
const manifestUrl = `${import.meta.env.BASE_URL}fonts/fonts-notosanscjksc/manifest.json`;
const rt = new FontRuntime({ manifests: [manifestUrl], includeDefaultNoto: false });
```

webpack hosts may equivalently use `copy-webpack-plugin` with
`node_modules/@office-rs/fonts-*/dist/**` → `fonts/[name]/`.

### Channel 3 — self-slicing your own fonts (brand / commercial fonts)

`tools/slice.py` is the public contract: feed it any TTF/OTF/TTC plus an
optional frequency table and it emits manifest-schema-v1-compatible output
(woff2 by default, same format as the official artifacts).

```bash
git clone https://github.com/office-rs/fonts.git && cd fonts
pip install fonttools brotli

python tools/slice.py \
  --input /assets/YourBrandFont.ttf \
  --key   yourbrand \
  --freq  tools/freq/junda.txt \
  --out   dist-brand/
# output: dist-brand/yourbrand/{common-*.woff2, blk-*.woff2} + dist-brand/manifest.json
#   families.yourbrand.displayName comes from the font's name table — a docx
#   referencing that family name matches automatically
python tools/verify.py dist-brand/manifest.json    # same integrity gate as CI
```

Deploy `dist-brand/` into your static dir (e.g. `public/fonts/yourbrand/`) and
pass its manifest URL via `FontRuntime`'s `manifests` array — the default Noto
manifest and your manifest coexist: body text from Noto, brand text from your
slices.

**Licensing — read before slicing a commercial font.** Web font slicing is
redistribution *and* modification, which are separately-licensed SKUs; a
desktop license usually covers neither. You must hold written rights for all
three elements: (1) commercial use, (2) web publishing / embedding — every
browser fetch of a slice is a distribution, and (3) modification / derivative
works — subsetting produces a derivative work. Confirm the "web subset
distribution" form explicitly when procuring. This repository hosts OFL-licensed
Noto fonts only and will never include commercial fonts; compliance is the
integrator's responsibility.

## Re-slicing the official families

Full pipeline (slice → verify → npm packages), as used for the current
`dist/v1` (provenance and per-family numbers in `dist/v1/BUILD.md`):

```bash
pip install fonttools brotli

python tools/slice.py --input sources/NotoSans-Regular.ttf        --key notosans       --is-latin --out dist/v1
python tools/slice.py --input sources/NotoSansCJKsc-Regular.otf   --key notosanscjksc  --freq tools/freq/junda.txt --out dist/v1
python tools/slice.py --input sources/NotoSerifCJKsc-Regular.otf  --key notoserifcjksc --freq tools/freq/junda.txt --out dist/v1

python tools/verify.py dist/v1/manifest.json --sources sources/   # integrity gate (CI runs this too)
npm run make:packages                                            # regenerates packages/fonts-*
```

`slice.py` parameters:

| Parameter | Default | Meaning |
|---|---|---|
| `--input` | required | Source font (TTF/OTF; TTC selects a face via `--face-index`) |
| `--key` | required | Family key — directory name and npm package suffix (`fonts-<key>`) |
| `--out` | required | Output root; writes `<out>/<key>/…` + `<out>/manifest.json` |
| `--display-name` | font name table | Family display name docx runs match against |
| `--freq` | — | Frequency list (one column of codepoints, most frequent first); drives common-slice packing |
| `--face-index` | `0` | Face index inside a TTC collection |
| `--common-count` | `4` | Number of common slices |
| `--common-per-slice` | `800` | Characters per common slice |
| `--block-size` | `256` | Codepoints per block slice |
| `--is-latin` | off | Treat as a Latin family: emit only `whole` + manifest, no slices |
| `--no-woff2` | off | Emit raw TTF/OTF subsets instead of woff2 (`format: "otf"` in the manifest) |

`verify.py` checks every slice parses, `sha256`/`bytes` match the files,
codepoint ranges are disjoint and (with `--sources`) the per-family union
equals the source cmap above U+2E80, plus size budgets: any `common` slice
≤ 1 MB, any `block` slice ≤ 300 KB (woff2 bytes).

### Manifest schema (v1)

```jsonc
{
  "version": 1,
  "generated": "2026-10-13T00:00:00Z",
  "families": {
    "notosans": {
      "displayName": "Noto Sans",
      "whole": { "url": "notosans/regular.woff2", "format": "woff2", "sha256": "…", "bytes": 189888 }
    },
    "notosanscjksc": {
      "displayName": "Noto Sans CJK SC",
      "full":   { "url": "notosanscjksc/full.woff2", "format": "woff2", "sha256": "…", "bytes": 11264580 },
      "slices": [
        { "id": "common-0", "kind": "common", "preload": true,
          "url": "notosanscjksc/common-0.woff2", "format": "woff2", "sha256": "…", "bytes": 223488,
          "codepoints": [[19968, 20249], [12288, 12295]] },   // closed intervals, multiple allowed
        { "id": "blk-0007", "kind": "block", "url": "notosanscjksc/blk-0007.woff2",
          "format": "woff2", "sha256": "…", "bytes": 48290, "codepoints": [[21248, 21503]] }
      ]
    }
  }
}
```

Contract: `version` must be `1`; every `url` is relative to the manifest's own
directory; `format` is `"woff2"` or `"otf"` (both accepted by the decoder);
`codepoints` are closed ranges. Latin families carry `whole`, CJK families
carry `full` (whole-family fallback) + `slices` with `preload: true` on the
common slices. Self-sliced manifests may cover any codepoints (extension
planes, PUA) — the pipeline is not limited to the CJK base plane.

## `@office-rs/font-runtime`

Pure TypeScript, no wasm dependency of its own. Responsibilities: manifest
fetch/merge, initial-slice planning (`selectInitial`, with an 80%-coverage
short-circuit so extreme documents don't enumerate hundreds of slices),
watch-mode delta planning (`watchText`), concurrent fetch with `sha256`
verification, and woff2→TTF decoding in a Web Worker (graceful main-thread
fallback when workers are unavailable).

The woff2 decoder is `wawoff2`'s wasm binding, dynamically imported only when
the first woff2 slice decodes — pure-`"otf"` manifests never pay for it.
Measured in the example build: wawoff2's entry statically imports both its
compress (948 KB) and decompress (323 KB) bindings, so the lazy chunk lands at
**1.24 MB minified / 507 KB gzip** (the compressor is dead weight for us;
tree-shaking is defeated by the package's CommonJS entry). Trimming this — e.g.
importing `wawoff2/build/decompress_binding.js` directly — is a known
follow-up; runtime behavior is unaffected.

API sketch:

```ts
const rt = new FontRuntime({
  manifests: [urlA, urlB],     // merged by family key
  includeDefaultNoto: true,    // prepend the pinned CDN manifest
  preloadCommon: true,         // plan preloadable common slices up front
  maxConcurrency: 6,           // parallel slice fetches
  onFontError: (e) => …,       // slice-level failures never throw
});
await rt.ready();                        // fetch + parse + merge (throws here only)
const plan = rt.selectInitial(codepoints, families);
for await (const s of rt.ensure(plan)) { /* FontSlice: family, id, bytes */ }
const more = rt.watchText(codepoints);   // delta plan for newly typed characters
```

## Example

`examples/vite/` dogfoods the plugin end to end — build output contains all
selected slice assets and dev serves them from `node_modules`, no CDN requests:

```bash
cd examples/vite
npm install
npm run dev     # http://localhost:5173 — lists the slices loaded for a sample text
npm run build   # dist/rword-fonts/{manifest.json, notosans/, notosanscjksc/}
```

## CI

`.github/workflows/slice.yml` (manual dispatch) runs the whole pipeline:
pytest tools → runtime tests → runtime build → `verify.py` integrity gate →
npm package regeneration → example build.

## License

The Noto fonts in `sources/` are SIL Open Font License 1.1; slices of OFL
fonts remain OFL. Tooling in this repository is MIT.
