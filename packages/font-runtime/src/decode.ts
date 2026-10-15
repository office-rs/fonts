// WOFF2 -> TTF decode via `woff2-encoder`, lazily imported on the first woff2
// slice. We import the decompress-only subpath: its wasm is base64-embedded
// inside the ES module (no side-car asset to keep reachable), works
// identically on the main thread and inside workers, and measures ~296 KB
// minified — the full `wawoff2` entry shipped both bindings at 1.24 MB.
//
// Why not `wawoff2` (the previous decoder): it never worked in a browser.
// Its wrapper does `const m = require('./build/decompress_binding.js');
// m.onRuntimeInitialized = resolve` — but the emscripten binding assigns
// `module.exports = Module` only inside its Node-only branch, so a browser
// bundler executes the wasm init yet hands the importer an EMPTY object; the
// resolve callback is written to a detached husk and the init promise never
// settles (Rword.init hung forever). Node exercised the Node branch, which
// is why unit tests stayed green. `woff2-encoder` is ESM-first and its
// decompress returns a fresh exact-size Uint8Array per call (covered by a
// test in decode.spec.ts), so no defensive copy on our side.
import type { SliceFormat } from './manifest';

type Decompress = (data: Uint8Array) => Promise<Uint8Array>;

let decompress: Decompress | null = null;

async function loadDecompress(): Promise<Decompress> {
  if (decompress) { return decompress; }
  const mod = await import('woff2-encoder/decompress');
  const fn = mod.default;
  if (typeof fn !== 'function') {
    throw new Error('woff2-encoder/decompress: expected a default-exported function, none found');
  }
  decompress = fn;
  return decompress;
}

export async function decodeIfNeeded(bytes: Uint8Array, format: SliceFormat): Promise<Uint8Array> {
  if (format === 'otf') { return bytes; }
  const fn = await loadDecompress();
  return fn(bytes);
}
