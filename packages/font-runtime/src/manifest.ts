// Manifest schema (v1) types, validation, and multi-manifest merging.

export type SliceFormat = 'otf' | 'woff2';

export interface FontFileRef { url: string; format: SliceFormat; sha256: string; bytes: number; }
export interface FontSliceRef extends FontFileRef {
  id: string; kind: 'common' | 'block'; preload?: boolean; codepoints: [number, number][];
}
export interface FontFamily { displayName: string; full?: FontFileRef; whole?: FontFileRef; slices?: FontSliceRef[]; }
export interface FontManifest { version: 1; generated: string; families: Record<string, FontFamily>; }

const SHA256_RE = /^[0-9a-f]{64}$/;

// Sentinel base for relative-url resolution: manifest urls are relative to the
// manifest's own directory, so any resolution to a different origin (scheme-bearing,
// protocol-relative, or opaque like data:) escapes the contract and is rejected.
const MANIFEST_BASE = 'http://manifest.invalid';

function isRelativeUrl(u: string): boolean {
  if (u === '') { return false; }
  let resolved: URL;
  try { resolved = new URL(u, MANIFEST_BASE); } catch { return false; }
  return resolved.origin === MANIFEST_BASE;
}

function fail(msg: string): never { throw new Error(`manifest: ${msg}`); }

export function parseManifest(json: unknown): FontManifest {
  if (typeof json !== 'object' || json === null) { fail('not an object'); }
  const m = json as Record<string, unknown>;
  if (m.version !== 1) { fail(`unsupported version ${String(m.version)}`); }
  if (typeof m.generated !== 'string') { fail('generated must be a string'); }
  const familiesIn = m.families;
  if (typeof familiesIn !== 'object' || familiesIn === null) { fail('families must be an object'); }
  const families: Record<string, FontFamily> = {};
  for (const [key, raw] of Object.entries(familiesIn)) {
    const f = raw as Record<string, unknown>;
    if (typeof f.displayName !== 'string' || f.displayName === '') { fail(`families.${key}.displayName`); }
    const family: FontFamily = { displayName: f.displayName };
    for (const slot of ['full', 'whole'] as const) {
      const ref = f[slot] as Record<string, unknown> | undefined;
      if (ref === undefined) { continue; }
      if (typeof ref.url !== 'string' || !isRelativeUrl(ref.url)) { fail(`families.${key}.${slot} url must be a non-empty relative path`); }
      if (!isValidFormat(ref.format) || !SHA256_RE.test(String(ref.sha256))) {
        fail(`families.${key}.${slot}`);
      }
      family[slot] = { url: ref.url as string, format: ref.format as SliceFormat, sha256: ref.sha256 as string, bytes: ref.bytes as number };
    }
    if (Array.isArray(f.slices)) {
      family.slices = (f.slices as Record<string, unknown>[]).map((s, i) => {
        if (typeof s.id !== 'string' || (s.kind !== 'common' && s.kind !== 'block')) { fail(`families.${key}.slices[${i}]`); }
        if (typeof s.url !== 'string' || !isRelativeUrl(s.url)) { fail(`families.${key}.slices[${i}] url must be a non-empty relative path`); }
        if (!isValidFormat(s.format) || !SHA256_RE.test(String(s.sha256))) { fail(`families.${key}.slices[${i}]`); }
        const cps = s.codepoints as [number, number][];
        if (!Array.isArray(cps) || cps.some(([lo, hi]) => !Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi || lo < 0)) {
          fail(`families.${key}.slices[${i}].codepoint range`);
        }
        return { id: s.id, kind: s.kind, preload: s.preload === true, url: s.url as string,
                 format: s.format as SliceFormat, sha256: s.sha256 as string, bytes: s.bytes as number,
                 codepoints: cps };
      });
    }
    families[key] = family;
  }
  return { version: 1, generated: m.generated, families };
}

function isValidFormat(f: unknown): boolean { return f === 'otf' || f === 'woff2'; }

export function mergeManifests(list: FontManifest[]): FontManifest {
  const families: Record<string, FontFamily> = {};
  for (const m of list) {
    for (const [key, fam] of Object.entries(m.families)) {
      if (key in families) { fail(`family key conflict: ${key}`); }
      families[key] = fam;
    }
  }
  return { version: 1, generated: new Date().toISOString(), families };
}
