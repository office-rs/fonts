// WOFF2 -> TTF decode via wawoff2, lazily instantiated on first woff2 slice.
import type { SliceFormat } from './manifest';

/**
 * Minimal typed surface of the `wawoff2` package (v2 ships no type
 * declarations). It is a CommonJS emscripten build: `require('wawoff2')`
 * yields `{ compress, decompress }`, and `decompress(buffer)` is itself an
 * async function that awaits the wasm runtime initialization before its
 * first real call — so memoizing the function reference is all the lazy
 * initialization we need on this side.
 */
interface Wawoff2Module {
  compress: (data: Uint8Array) => Promise<Uint8Array>;
  decompress: (data: Uint8Array) => Promise<Uint8Array>;
}

type Decompress = (data: Uint8Array) => Promise<Uint8Array>;

let decompress: Decompress | null = null;

async function loadWawoff2(): Promise<Decompress> {
  if (decompress) { return decompress; }
  // Node ESM-CJS interop may expose the exports either directly on the
  // namespace or nested under `default`; accept both shapes.
  // @ts-expect-error wawoff2 ships no type declarations; shape validated below.
  const raw = (await import('wawoff2')) as unknown as Partial<Wawoff2Module> & { default?: Partial<Wawoff2Module> };
  const fn = raw.decompress ?? raw.default?.decompress;
  if (typeof fn !== 'function') {
    throw new Error('wawoff2: expected a `decompress` export, none found');
  }
  decompress = async (data: Uint8Array) => {
    const out = await fn(data);
    // The emscripten binding can return a view into the wasm heap; copy it
    // so the result stays valid regardless of later calls.
    return new Uint8Array(out);
  };
  return decompress;
}

export async function decodeIfNeeded(bytes: Uint8Array, format: SliceFormat): Promise<Uint8Array> {
  if (format === 'otf') { return bytes; }
  const fn = await loadWawoff2();
  return fn(bytes);
}
