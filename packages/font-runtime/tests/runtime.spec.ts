import { afterEach, describe, expect, it, vi } from 'vitest';
import { FontRuntime, DEFAULT_NOTO_MANIFEST_URL } from '../src/index';

const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))
  .map((b) => b.toString(16).padStart(2, '0')).join('');

afterEach(() => { vi.unstubAllGlobals(); });

// sha256 must be the real digest of the bytes the slice URL serves ('slice-bytes'
// in the happy-path tests) — computed per-test via sha() and injected here.
function manifestJson(displayName: string, key: string, sha256: string) {
  return { version: 1, generated: '', families: { [key]: { displayName,
    slices: [{ id: 'common-0', kind: 'common', preload: true, url: `${key}/common-0.otf`, format: 'otf',
               sha256, bytes: 9, codepoints: [[19968, 19990]] }] } } };
}

describe('FontRuntime', () => {
  it('ready() merges default Noto manifest with user manifests', async () => {
    const s = await sha('slice-bytes');
    // Default URL serves the Noto family; user manifests serve their own family —
    // a single shared body would self-conflict on the family key at merge time.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(
      JSON.stringify(url === DEFAULT_NOTO_MANIFEST_URL
        ? manifestJson('Noto Sans CJK SC', 'notosanscjksc', s)
        : manifestJson('User Font', 'userfam', s)),
      { headers: { 'content-type': 'application/json' } })));
    const rt = new FontRuntime({ manifests: ['http://x/m.json'], includeDefaultNoto: true });
    const m = await rt.ready();
    expect(Object.keys(m.families)).toContain('notosanscjksc');
    expect(Object.keys(m.families)).toContain('userfam');
  });
  it('ready() throws on duplicate family key across manifests', async () => {
    const s = await sha('slice-bytes');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(manifestJson('F', 'f', s)), { headers: { 'content-type': 'application/json' } })));
    const rt = new FontRuntime({ manifests: ['http://x/m.json'], includeDefaultNoto: false });
    // both manifests (user + itself via dedup-less list) — construct conflict directly:
    const rt2 = new FontRuntime({ manifests: ['http://x/a.json', 'http://x/b.json'], includeDefaultNoto: false });
    await expect(rt2.ready()).rejects.toThrow(/conflict/);
    await rt.ready();  // single manifest is fine
  });
  it('watchText returns plans only for uncovered codepoints', async () => {
    const s = await sha('slice-bytes');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('.json')) { return new Response(JSON.stringify(manifestJson('F', 'f', s)), { headers: { 'content-type': 'application/json' } }); }
      return new Response('slice-bytes');
    }));
    const rt = new FontRuntime({ manifests: ['http://x/m.json'], includeDefaultNoto: false });
    await rt.ready();
    const first = rt.watchText([19968]);           // uncovered → slice
    expect(first.families[0].sliceIds).toEqual(['common-0']);
    for await (const _ of rt.ensure(first)) { /* load it */ }
    const second = rt.watchText([19968, 19969]);   // both covered now
    expect(second.families).toEqual([]);
  });
  it('slice fetch error surfaces via onFontError', async () => {
    const s = await sha('slice-bytes');            // manifest sha of 'slice-bytes', but the slice URL serves 'garbage'
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('.json')) { return new Response(JSON.stringify(manifestJson('F', 'f', s)), { headers: { 'content-type': 'application/json' } }); }
      return new Response('garbage');               // sha256 mismatch → retry → final failure reported via onError
    }));
    const errors: string[] = [];
    const rt = new FontRuntime({ manifests: ['http://x/m.json'], includeDefaultNoto: false, onFontError: (e) => errors.push(e.sliceId) });
    await rt.ready();
    const plan = rt.watchText([19968]);
    for await (const _ of rt.ensure(plan)) { /* drain; nothing yields */ }
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]).toBe('common-0');
  });
});
