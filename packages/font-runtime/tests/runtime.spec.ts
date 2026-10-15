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
  it('DEFAULT_NOTO_MANIFEST_URL points at the published dist/v1 layout', () => {
    // Tripwire: the repo publishes the CDN manifest at dist/v1/manifest.json
    // (see tools/make-packages.mjs / dist/v1); a wrong path 404s every default
    // integration at runtime while looking fine locally.
    expect(DEFAULT_NOTO_MANIFEST_URL).toBe('https://cdn.jsdelivr.net/gh/office-rs/fonts@v1/dist/v1/manifest.json');
  });
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
  it('whole-only family: selectInitial plans whole, ensure loads it, watchText stops planning it', async () => {
    const s = await sha('whole-bytes');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('.json')) {
        return new Response(JSON.stringify({ version: 1, generated: '', families: { wf: { displayName: 'WholeF',
          whole: { url: 'wf/whole.otf', format: 'otf', sha256: s, bytes: 11 } } } }),
          { headers: { 'content-type': 'application/json' } });
      }
      return new Response('whole-bytes');
    }));
    const rt = new FontRuntime({ manifests: ['http://x/m.json'], includeDefaultNoto: false });
    await rt.ready();
    const plan = rt.selectInitial([65], ['WholeF']);
    expect(plan.families).toEqual([{ family: 'wf', load: 'whole', sliceIds: [] }]);
    const got: Array<[string, string]> = [];
    for await (const sl of rt.ensure(plan)) { got.push([sl.family, sl.id]); }
    expect(got).toEqual([['wf', '__whole__']]);
    expect(rt.watchText([65])).toEqual({ families: [] });
  });
  it('ready() resolves manifest urls against the manifest\'s own location (spec 6.7)', async () => {
    const s = await sha('slice-bytes');
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(url);
      if (url.endsWith('.json')) {
        return new Response(JSON.stringify({ version: 1, generated: '', families: { f: { displayName: 'F',
          whole: { url: 'w/whole.otf', format: 'otf', sha256: s, bytes: 11 },
          slices: [{ id: 'common-0', kind: 'common', preload: true, url: 'f/common-0.otf', format: 'otf',
                     sha256: s, bytes: 9, codepoints: [[19968, 19990]] }] } } }),
          { headers: { 'content-type': 'application/json' } });
      }
      return new Response('slice-bytes');
    }));
    const rt = new FontRuntime({ manifests: ['http://x/fonts/manifest.json'], includeDefaultNoto: false });
    const m = await rt.ready();
    // Every ref url (whole + slices) is rewritten against the manifest's own url.
    expect(m.families.f.slices![0].url).toBe('http://x/fonts/f/common-0.otf');
    expect(m.families.f.whole!.url).toBe('http://x/fonts/w/whole.otf');
    // The resolved absolute url is what the slice pipeline actually fetches —
    // a bare relative url would be resolved against the document base instead.
    for await (const _ of rt.ensure(rt.watchText([19968]))) { /* drain */ }
    expect(seen).toContain('http://x/fonts/f/common-0.otf');
    expect(seen).not.toContain('f/common-0.otf');
  });
  it('ready() absolutizes root-relative manifest urls against the document base before fetching', async () => {
    // The vite plugin's virtual module emits a root-relative manifest url
    // ('/@rword-fonts/manifest.json?v=…'). Node's fetch rejects it outright,
    // and where fetch does resolve it (browsers) resolveManifestUrls then
    // crashes — a root-relative string is an invalid base for new URL(rel, u)
    // — sinking init into the legacy full-font fallback. Non-browser hosts
    // have no document location, so the module url (file:// under vitest) is
    // the accepted base.
    const s = await sha('slice-bytes');
    const expected = new URL('/x/manifest.json', import.meta.url).href;
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url);
      seen.push(u);
      if (u !== expected) { return new Response('', { status: 404 }); }   // only the absolutized form serves
      return new Response(JSON.stringify(manifestJson('F', 'f', s)), { headers: { 'content-type': 'application/json' } });
    }));
    const rt = new FontRuntime({ manifests: ['/x/manifest.json'], includeDefaultNoto: false });
    const m = await rt.ready();   // must resolve; the bare '/x/…' form must never reach fetch
    expect(Object.keys(m.families)).toContain('f');
    expect(seen).toEqual([expected]);
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
