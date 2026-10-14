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
