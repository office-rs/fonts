// Vite plugin: emit slice assets at build, serve from node_modules in dev (spec 6.7.1).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

const VIRTUAL = 'virtual:rword-fonts';
const RESOLVED_VIRTUAL = '\0' + VIRTUAL;
const ASSET_DIR = 'rword-fonts';           // stable, base-agnostic dist path
const DEV_MOUNT = '/@rword-fonts';         // vite-namespace mount for dev serving

export interface RwordFontsOptions { families: string[]; }

// Minimal manifest shapes the plugin copies around; the full schema lives in ./manifest.
interface FontFileRefLike { url: string }
interface FamilyLike { whole?: FontFileRefLike; full?: FontFileRefLike; slices?: FontFileRefLike[] }
type FamiliesLike = Record<string, FamilyLike>;

export default function rwordFonts(opts: RwordFontsOptions): Plugin {
  const require = createRequire(import.meta.url);
  let base = '/';
  let devMount = DEV_MOUNT;
  let serving = false;

  // Resolve every family package once up front: dist dir + manifest families + version.
  const plans = opts.families.map((family) => {
    const pkgJsonPath = require.resolve(`@office-rs/fonts-${family}/package.json`);
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { version: string };
    const distDir = join(dirname(pkgJsonPath), 'dist');
    const manifest = JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8')) as { families: FamiliesLike };
    return { family, version: pkg.version, distDir, families: manifest.families };
  });

  // Cache-bust key: any family package version bump changes the manifest URL query.
  const versionKey = plans.map((p) => `${p.family}@${p.version}`).join(',');
  const mergedFamilies: FamiliesLike = Object.assign({}, ...plans.map((p) => p.families));
  const mergedManifestJson = JSON.stringify({ version: 1, generated: '', families: mergedFamilies });

  // Resolve `rel` strictly under `dir`; null when it escapes (middleware input is untrusted).
  function under(dir: string, rel: string): string | null {
    const root = resolve(dir);
    const full = resolve(root, rel);
    return full.startsWith(root + sep) ? full : null;
  }

  // Build-time read: escaping or missing files fail the build loudly with context.
  function readUnder(dir: string, rel: string, what: string): Buffer {
    const full = under(dir, rel);
    if (full === null) { throw new Error(`rword-fonts: ${what} url escapes its package dir: ${rel}`); }
    try {
      return readFileSync(full);
    } catch (err) {
      throw new Error(`rword-fonts: cannot read ${what} file ${rel}: ${String(err)}`);
    }
  }

  function contentType(path: string): string {
    return path.endsWith('.woff2') ? 'font/woff2' : 'application/json';
  }

  return {
    name: 'rword-fonts',

    configResolved(cfg) {
      base = cfg.base || '/';
      serving = cfg.command === 'serve';
      devMount = base.replace(/\/$/, '') + DEV_MOUNT;
    },

    resolveId(id) { return id === VIRTUAL ? RESOLVED_VIRTUAL : null; },

    load(id) {
      if (id !== RESOLVED_VIRTUAL) { return null; }
      // Build: the emitted asset path (base + rword-fonts/manifest.json).
      // Dev: the middleware mount. Both serve the merged manifest, and slice urls
      // stay package-relative, so resolving them against the manifest's own URL
      // behaves identically in both modes.
      const dir = serving ? devMount : base + ASSET_DIR;
      const manifestUrl = `${dir}/manifest.json?v=${encodeURIComponent(versionKey)}`;
      return `export const manifestUrl = ${JSON.stringify(manifestUrl)};\n`;
    },

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith(devMount)) { next(); return; }
        let rel = url.slice(devMount.length).split('?')[0].replace(/^\//, '');
        try { rel = decodeURIComponent(rel); } catch { res.statusCode = 400; res.end('bad request'); return; }

        if (rel === 'manifest.json') {
          res.setHeader('content-type', 'application/json');
          res.end(mergedManifestJson);
          return;
        }
        const familyKey = rel.split('/')[0];
        const plan = plans.find((p) => familyKey in p.families);
        const file = plan === undefined ? null : under(plan.distDir, rel);
        if (file === null) { res.statusCode = 404; res.end('not found'); return; }
        try {
          res.setHeader('content-type', contentType(rel));
          res.end(readFileSync(file));
        } catch {
          res.statusCode = 404; res.end('not found');
        }
      });
    },

    generateBundle() {
      for (const plan of plans) {
        for (const [key, fam] of Object.entries(plan.families)) {
          for (const slot of ['whole', 'full'] as const) {
            const ref = fam[slot];
            if (ref === undefined) { continue; }
            this.emitFile({ type: 'asset', fileName: `${ASSET_DIR}/${ref.url}`,
                            source: readUnder(plan.distDir, ref.url, `families.${key}.${slot}`) });
          }
          for (const s of fam.slices ?? []) {
            this.emitFile({ type: 'asset', fileName: `${ASSET_DIR}/${s.url}`,
                            source: readUnder(plan.distDir, s.url, `families.${key}.slices`) });
          }
        }
      }
      // Manifest urls stay PACKAGE-RELATIVE on purpose: the runtime resolves them
      // against the manifest's own URL (base + rword-fonts/manifest.json), which
      // lands exactly on the emitted asset paths above.
      this.emitFile({ type: 'asset', fileName: `${ASSET_DIR}/manifest.json`, source: mergedManifestJson });
    },
  };
}
