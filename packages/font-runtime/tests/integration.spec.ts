// Shared-contract integration guard: the REAL FontRuntime against a REAL vite
// dev server serving the fixture package through the rwordFonts middleware.
// This seam would have caught two cross-layer defects the per-unit suites
// could not see:
//   - the double sha256 gate (runEnsure re-hashing DECODED ttf bytes against
//     the woff2-file digest in the manifest — every woff2 slice failed), and
//   - missing manifest-relative url resolution (bare `ff/common-0.woff2`
//     fetched against the document base instead of the manifest's location).
// The fixture payloads are real woff2 files for exactly this reason.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import rwordFonts from '../src/vite';
import { FontRuntime } from '../src/index';

const testDir = fileURLToPath(new URL('.', import.meta.url));
const fixtureSrc = join(testDir, 'fixtures', 'fonts-fixture');
// packages/font-runtime/tests -> repo root where the workspace node_modules lives.
const fixtureLink = resolve(testDir, '../../../node_modules/@office-rs/fonts-fixture');
const tempDirs: string[] = [];
let server: ViteDevServer;
let origin: string;

beforeAll(async () => {
  rmSync(fixtureLink, { recursive: true, force: true });
  cpSync(fixtureSrc, fixtureLink, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'rword-fonts-e2e-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>x</body></html>');
  server = await createServer({
    root: dir,
    base: '/sub/',
    configFile: false,
    plugins: [rwordFonts({ families: ['fixture'] })],
    // Pin IPv4 loopback: on Windows the default bind is IPv6-only, which
    // refuses fetch() connections to 127.0.0.1.
    server: { host: '127.0.0.1' },
    logLevel: 'silent',
  });
  await server.listen(0);
  origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
});

afterAll(async () => {
  await server.close();
  rmSync(fixtureLink, { recursive: true, force: true });
  for (const dir of tempDirs) { rmSync(dir, { recursive: true, force: true }); }
});

describe('FontRuntime x vite dev server (shared contract)', () => {
  it('ready() -> selectInitial() -> ensure() loads a fixture slice end-to-end', { timeout: 60_000 }, async () => {
    // The manifestUrl a real host embeds comes from the virtual module; resolve
    // it against the dev origin exactly like a browser resolves it against the
    // document base (it is root-relative with a cache-bust query).
    const virtual = await server.ssrLoadModule('virtual:rword-fonts') as { manifestUrl: string };
    const manifestUrl = new URL(virtual.manifestUrl, origin).href;
    expect(manifestUrl).toContain('/sub/@rword-fonts/manifest.json');

    const errors: string[] = [];
    const rt = new FontRuntime({
      manifests: [manifestUrl],
      includeDefaultNoto: false,
      onFontError: (e) => errors.push(`${e.family}/${e.sliceId}: ${e.message}`),
    });
    const m = await rt.ready();
    // Manifest urls were rewritten against the manifest's own location (6.7) —
    // the query string on the manifest url must not leak into slice urls.
    expect(m.families.ff.slices![0].url).toBe(`${origin}/sub/@rword-fonts/ff/common-0.woff2`);

    // The fixture's common-0 covers U+4E00 and is far smaller than full, so the
    // planner must pick the SLICE (not the full short-circuit).
    const plan = rt.selectInitial([19968], ['Fixture Font']);
    expect(plan.families).toEqual([{ family: 'ff', load: 'slices', sliceIds: ['common-0'] }]);

    const got: Array<{ id: string; bytes: Uint8Array }> = [];
    for await (const s of rt.ensure(plan)) { got.push({ id: s.id, bytes: s.bytes }); }
    expect(errors).toEqual([]);
    expect(got.length).toBeGreaterThanOrEqual(1);
    expect(got[0].id).toBe('common-0');
    // Single hash gate passed on the woff2 file and the slice yielded DECODED
    // bytes: TrueType sfnt magic 00 01 00 00, not the wOF2 container header.
    expect(got[0].bytes.length).toBeGreaterThan(0);
    expect(Array.from(got[0].bytes.slice(0, 4))).toEqual([0x00, 0x01, 0x00, 0x00]);
    // Coverage converged: the watcher stops re-planning the loaded codepoint.
    expect(rt.watchText([19968]).families).toEqual([]);
  });
});
