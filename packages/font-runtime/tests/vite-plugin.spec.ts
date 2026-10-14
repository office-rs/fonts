// Tests for the rwordFonts vite plugin: build emit + dev middleware (design spec 6.7.1).
//
// The fixture package (tests/fixtures/fonts-fixture) is copied into the workspace
// node_modules in beforeAll so the plugin's `@office-rs/fonts-fixture` resolution
// works exactly like a real host consuming the published asset packages (no alias).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, createServer } from 'vite';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import rwordFonts from '../src/vite';

const testDir = fileURLToPath(new URL('.', import.meta.url));
const fixtureSrc = join(testDir, 'fixtures', 'fonts-fixture');
// packages/font-runtime/tests -> repo root where the workspace node_modules lives.
const fixtureLink = resolve(testDir, '../../../node_modules/@office-rs/fonts-fixture');
const tempDirs: string[] = [];

// Minimal host project: index.html pulls main.js which imports the virtual module.
function fixtureProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rword-fonts-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'index.html'),
    '<!doctype html><html><body>x<script type="module" src="/main.js"></script></body></html>');
  writeFileSync(join(dir, 'main.js'),
    "import { manifestUrl } from 'virtual:rword-fonts';\nconsole.log(manifestUrl);\n");
  return dir;
}

// The built JS chunks of the fixture project, concatenated (for substring asserts).
function builtJs(dir: string): string {
  const assets = join(dir, 'dist', 'assets');
  return readdirSync(assets).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(assets, f), 'utf8')).join('\n');
}

beforeAll(() => {
  rmSync(fixtureLink, { recursive: true, force: true });
  cpSync(fixtureSrc, fixtureLink, { recursive: true });
});

afterAll(() => {
  rmSync(fixtureLink, { recursive: true, force: true });
  for (const dir of tempDirs) { rmSync(dir, { recursive: true, force: true }); }
});

describe('rwordFonts vite plugin', () => {
  it('build: emits slice assets + merged manifest with package-relative urls, manifestUrl carries base and version key', { timeout: 60_000 }, async () => {
    const dir = fixtureProject();
    await build({
      root: dir,
      base: '/sub/',
      configFile: false,
      plugins: [rwordFonts({ families: ['fixture'] })],
      logLevel: 'silent',
    });

    // Emitted files land at dist/rword-fonts/... — vite asset fileName carries NO base
    // (base is applied to served URLs only), so the on-disk path must not contain /sub/.
    const out = join(dir, 'dist');
    expect(existsSync(join(out, 'rword-fonts/ff/common-0.woff2'))).toBe(true);
    expect(existsSync(join(out, 'rword-fonts/ff/blk-0000.woff2'))).toBe(true);
    expect(existsSync(join(out, 'rword-fonts/ff/full.woff2'))).toBe(true);   // full slot is emitted too
    expect(existsSync(join(out, 'sub/rword-fonts/ff/common-0.woff2'))).toBe(false);
    expect(readFileSync(join(out, 'rword-fonts/ff/common-0.woff2'), 'utf8')).toBe('fake-common-0');

    // The merged manifest keeps PACKAGE-RELATIVE urls: the runtime resolves them
    // against the manifest's own URL (base + rword-fonts/manifest.json), which
    // lands exactly on the emitted asset path. No rewrite to rword-fonts/... here.
    const m = JSON.parse(readFileSync(join(out, 'rword-fonts/manifest.json'), 'utf8'));
    expect(m.version).toBe(1);
    expect(m.families.ff.displayName).toBe('Fixture Font');
    expect(m.families.ff.slices[0].url).toBe('ff/common-0.woff2');
    expect(m.families.ff.slices[1].url).toBe('ff/blk-0000.woff2');
    expect(m.families.ff.full.url).toBe('ff/full.woff2');

    // The virtual module baked into the bundle: base-aware manifest URL with the
    // version cache-bust query (encodeURIComponent turns '@' into %40).
    const js = builtJs(dir);
    expect(js).toContain('/sub/rword-fonts/manifest.json');
    expect(js).toContain('fixture%400.0.1');
  });

  it('dev: middleware serves merged manifest + slice files under base', { timeout: 60_000 }, async () => {
    const server = await createServer({
      root: fixtureProject(),
      base: '/sub/',
      configFile: false,
      plugins: [rwordFonts({ families: ['fixture'] })],
      // Pin IPv4 loopback: on Windows the default bind is IPv6-only, which
      // refuses fetch() connections to 127.0.0.1.
      server: { host: '127.0.0.1' },
      logLevel: 'silent',
    });
    await server.listen(0);
    try {
      const port = (server.httpServer!.address() as { port: number }).port;
      const origin = `http://127.0.0.1:${port}`;

      const slice = await fetch(`${origin}/sub/@rword-fonts/ff/common-0.woff2`);
      expect(slice.status).toBe(200);
      expect(slice.headers.get('content-type')).toContain('font/woff2');
      expect(await slice.text()).toBe('fake-common-0');

      const manifest = await fetch(`${origin}/sub/@rword-fonts/manifest.json`);
      expect(manifest.status).toBe(200);
      expect(manifest.headers.get('content-type')).toContain('application/json');
      expect(JSON.parse(await manifest.text()).families.ff.displayName).toBe('Fixture Font');

      const missing = await fetch(`${origin}/sub/@rword-fonts/ff/none.woff2`);
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
