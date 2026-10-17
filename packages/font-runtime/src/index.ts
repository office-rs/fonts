// FontRuntime facade: manifest merge + selection + ensure + typing watcher (spec section 7).
import { mergeManifests, parseManifest, type FontManifest, type FontFamily, type FontFileRef, type FontSliceRef } from './manifest.js';
import { selectInitial, type FontSlicePlan } from './select.js';
import { createEnsureState, runEnsure, FULL_SLICE_ID, WHOLE_SLICE_ID, type EnsureState } from './ensure.js';
import { createFetcher, type Fetcher } from './fetcher.js';
import { FontLoadError } from './errors.js';
import { IntervalSet } from './coverage.js';

export const DEFAULT_NOTO_MANIFEST_URL = 'https://cdn.jsdelivr.net/gh/office-rs/fonts@v1/dist/v1/manifest.json';

export interface FontRuntimeOptions {
  manifests: string[];
  includeDefaultNoto?: boolean;     // default true
  preloadCommon?: boolean;          // default true
  maxConcurrency?: number;          // default 6
  onFontError?: (err: FontLoadError) => void;
}
export interface FontSlice { family: string; id: string; bytes: Uint8Array; }

/**
 * Spec 6.7: every url inside a manifest is relative to the manifest's own
 * location. Rewrite all refs (whole/full/slices) to absolute urls against the
 * url the manifest was fetched from, so downstream fetchers never resolve a
 * bare relative url against the document base. parseManifest guarantees every
 * ref url is relative, so this is always a plain path join. Returns new
 * objects — the parsed manifest is never mutated.
 */
function resolveManifestUrls(m: FontManifest, manifestUrl: string): FontManifest {
  const abs = (u: string): string => new URL(u, manifestUrl).href;
  const file = <T extends FontFileRef>(r: T): T => ({ ...r, url: abs(r.url) });
  const families = Object.fromEntries(Object.entries(m.families).map(([key, fam]): [string, FontFamily] => {
    const out: FontFamily = { displayName: fam.displayName };
    if (fam.whole) { out.whole = file(fam.whole); }
    if (fam.full) { out.full = file(fam.full); }
    if (fam.slices) { out.slices = fam.slices.map(file); }
    return [key, out];
  }));
  return { ...m, families };
}

export class FontRuntime {
  private merged: FontManifest | null = null;
  private state = createEnsureState();
  // Per-family codepoints of slices already ENSURED (not merely offered by the
  // manifest): starts empty per family, grows via markCovered as slices load —
  // watchText reports exactly what is not loaded yet.
  private covered = new Map<string, IntervalSet>();
  private fetcher: Fetcher;

  constructor(private opts: FontRuntimeOptions) { this.fetcher = createFetcher(); }

  async ready(): Promise<FontManifest> {
    if (this.merged) { return this.merged; }
    // Manifest urls must be absolute before use: the vite plugin's virtual
    // module emits root-relative urls ('/@rword-fonts/manifest.json?v=…') —
    // Node fetch rejects those outright, and where fetch accepts them
    // (browsers) resolveManifestUrls crashes on new URL(rel, rootRelative)
    // because a root-relative string is an invalid URL base, silently sinking
    // init into the legacy full-font fallback. Absolutize against the document
    // base; in non-browser hosts (Node/vitest) there is no location, so the
    // module url (a file:// url) stands in as the base. Absolute urls pass
    // through URL resolution untouched.
    const docBase = (globalThis as { location?: { href?: string } }).location?.href ?? import.meta.url;
    const urls = [...(this.opts.includeDefaultNoto !== false ? [DEFAULT_NOTO_MANIFEST_URL] : []), ...this.opts.manifests]
      .map((u) => new URL(u, docBase).href);
    const manifests: FontManifest[] = [];
    for (const url of urls) {
      const res = await fetch(url);
      if (!res.ok) { throw new FontLoadError('', '', `manifest fetch failed: ${url}`); }
      manifests.push(resolveManifestUrls(parseManifest(await res.json()), url));
    }
    this.merged = mergeManifests(manifests);
    for (const key of Object.keys(this.merged.families)) {
      this.covered.set(key, new IntervalSet());
    }
    return this.merged;
  }

  selectInitial(codepoints: number[], families: string[]): FontSlicePlan {
    return selectInitial(this.requireReady(), codepoints, families, { preloadCommon: this.opts.preloadCommon !== false });
  }

  // No throw on slice failures (Task 4 no-throw ruling): runEnsure reports them
  // through its onError, forwarded to the caller's onFontError. Only ready()
  // throws (manifest fetch/parse/merge).
  async *ensure(plan: FontSlicePlan): AsyncGenerator<FontSlice> {
    const m = this.requireReady();
    for await (const s of runEnsure(m, plan, this.state, this.fetcher, {
      maxConcurrency: this.opts.maxConcurrency ?? 6,
      onError: (e) => this.opts.onFontError?.(e),
    })) {
      // A whole/full file covers every slice the manifest offers for the
      // family — mark them all so watchText never re-plans it.
      if (s.id === WHOLE_SLICE_ID || s.id === FULL_SLICE_ID) {
        this.markCovered(s.family, m.families[s.family]?.slices ?? []);
      } else {
        const ref = m.families[s.family]?.slices?.find((r) => r.id === s.id);
        if (ref) { this.markCovered(s.family, [ref]); }   // before yield, or watchText never converges
      }
      yield s;
    }
  }

  /** Typing watcher: delta codepoints -> plans for slices not yet loaded. */
  watchText(codepoints: number[]): FontSlicePlan {
    const m = this.requireReady();
    const families: FontSlicePlan['families'] = [];
    for (const [key, fam] of Object.entries(m.families)) {
      if (!fam.slices) { continue; }
      const covered = this.covered.get(key)!;
      const missing = codepoints.filter((cp) => !covered.contains(cp));
      if (missing.length === 0) { continue; }
      const hit = fam.slices.filter((s) => s.codepoints.some(([lo, hi]) => missing.some((cp) => cp >= lo && cp <= hi)));
      if (hit.length === 0) { continue; }
      families.push({ family: key, load: 'slices', sliceIds: hit.map((s) => s.id) });
    }
    return { families };
  }

  /** Called after slices load successfully so the watcher stops re-reporting. */
  markCovered(family: string, slices: FontSliceRef[]): void {
    let set = this.covered.get(family);
    if (!set) { set = new IntervalSet(); this.covered.set(family, set); }
    set.addRanges(slices.flatMap((s) => s.codepoints));
  }

  private requireReady(): FontManifest {
    if (!this.merged) { throw new Error('FontRuntime.ready() must resolve first'); }
    return this.merged;
  }
}
export { FontLoadError } from './errors.js';
export type { FontManifest, FontSliceRef, SliceFormat } from './manifest.js';
export type { FontSlicePlan, FamilyPlan } from './select.js';
