// FontRuntime facade: manifest merge + selection + ensure + typing watcher (spec section 7).
import { mergeManifests, parseManifest, type FontManifest, type FontSliceRef } from './manifest';
import { selectInitial, type FontSlicePlan } from './select';
import { createEnsureState, runEnsure, type EnsureState } from './ensure';
import { createFetcher, type Fetcher } from './fetcher';
import { FontLoadError } from './errors';
import { IntervalSet } from './coverage';

export const DEFAULT_NOTO_MANIFEST_URL = 'https://cdn.jsdelivr.net/gh/office-rs/fonts@v1/dist/manifest.json';

export interface FontRuntimeOptions {
  manifests: string[];
  includeDefaultNoto?: boolean;     // default true
  preloadCommon?: boolean;          // default true
  maxConcurrency?: number;          // default 6
  onFontError?: (err: FontLoadError) => void;
}
export interface FontSlice { family: string; id: string; bytes: Uint8Array; }

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
    const urls = [...(this.opts.includeDefaultNoto !== false ? [DEFAULT_NOTO_MANIFEST_URL] : []), ...this.opts.manifests];
    const manifests: FontManifest[] = [];
    for (const url of urls) {
      const res = await fetch(url);
      if (!res.ok) { throw new FontLoadError('', '', `manifest fetch failed: ${url}`); }
      manifests.push(parseManifest(await res.json()));
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
      const ref = m.families[s.family]?.slices?.find((r) => r.id === s.id);
      if (ref) { this.markCovered(s.family, [ref]); }   // before yield, or watchText never converges
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
export { FontLoadError } from './errors';
export type { FontManifest, FontSliceRef, SliceFormat } from './manifest';
export type { FontSlicePlan, FamilyPlan } from './select';
