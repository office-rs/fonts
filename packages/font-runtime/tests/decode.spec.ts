import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeIfNeeded } from '../src/decode';

describe('decodeIfNeeded', () => {
  it('passes otf through untouched', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await decodeIfNeeded(bytes, 'otf')).toBe(bytes);
  });
  it('decodes woff2 back to the original ttf bytes', async () => {
    const woff2 = new Uint8Array(readFileSync('test-data/abc.woff2'));
    const ttf = new Uint8Array(readFileSync('test-data/abc.ttf'));
    const out = await decodeIfNeeded(woff2, 'woff2');
    expect(out.byteLength).toBe(ttf.byteLength);
    expect(out[0]).toBe(0x00); expect(out[1]).toBe(0x01); expect(out[2]).toBe(0x00); expect(out[3]).toBe(0x00); // sfntVersion of TrueType
  });
});

describe('decoder entry (woff2-encoder/decompress)', () => {
  // Guards the shape decode.ts relies on. The previous decoder (`wawoff2`)
  // hung forever in real browsers: its wrapper registered
  // `onRuntimeInitialized` on the require() result, but the binding assigns
  // `module.exports = Module` only inside its Node-only branch, so a browser
  // bundler hands back an EMPTY object and the init promise never resolves.
  // Node worked, which is why the breakage survived unit testing — these
  // guards fail loudly at unit level if the replacement ever changes shape.
  it('default-exports the decompress function directly', async () => {
    const mod = await import('woff2-encoder/decompress');
    expect(typeof mod.default).toBe('function');
  });
  it('decodes the same bytes as decodeIfNeeded', async () => {
    const mod = await import('woff2-encoder/decompress');
    const woff2 = new Uint8Array(readFileSync('test-data/abc.woff2'));
    const direct = await mod.default(new Uint8Array(woff2));
    const viaRuntime = await decodeIfNeeded(new Uint8Array(woff2), 'woff2');
    expect(viaRuntime.byteLength).toBe(direct.byteLength);
  });
  it('returns an exact-size copy stable across later decodes', async () => {
    const mod = await import('woff2-encoder/decompress');
    const first = new Uint8Array(readFileSync('test-data/abc.woff2'));
    const out = await mod.default(first);
    expect(out.buffer.byteLength).toBe(out.byteLength); // not a view into a shared heap
    const snapshot = new Uint8Array(out);
    await mod.default(new Uint8Array(first)); // decode again…
    expect(Array.from(out)).toEqual(Array.from(snapshot)); // …first result untouched → fresh copy per call
  });
});
