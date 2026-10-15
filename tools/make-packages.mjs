// Generate per-family npm asset packages from dist/v1 (spec 6.7 channel 2).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'dist/v1/manifest.json'), 'utf8'));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? '0.1.0';

for (const key of Object.keys(manifest.families)) {
  const pkgDir = join(root, 'packages', `fonts-${key}`);
  rmSync(pkgDir, { recursive: true, force: true });
  mkdirSync(join(pkgDir, 'dist'), { recursive: true });
  cpSync(join(root, 'dist/v1', key), join(pkgDir, 'dist', key), { recursive: true });
  // Noto fonts are OFL; the license must travel with the slices.
  cpSync(join(root, 'sources/OFL.txt'), join(pkgDir, 'dist/OFL.txt'));
  // Copy only this family's files; manifest.json is per-family-filtered.
  const fam = { version: 1, generated: manifest.generated, families: { [key]: manifest.families[key] } };
  writeFileSync(join(pkgDir, 'dist/manifest.json'), JSON.stringify(fam));
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name: `@office-rs/fonts-${key}`,
    version,
    private: false,
    description: `Sliced ${manifest.families[key].displayName} WOFF2 assets + manifest for @office-rs/font-runtime (on-demand web font loading)`,
    license: 'OFL-1.1',
    repository: { type: 'git', url: 'git+https://github.com/office-rs/fonts.git' },
    publishConfig: { access: 'public' },
    files: ['dist'],
    sideEffects: false,
  }, null, 2) + '\n');
  console.log(`packaged @office-rs/fonts-${key}`);
}
