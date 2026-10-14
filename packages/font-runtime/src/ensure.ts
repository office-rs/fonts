// Ensure pipeline: fetch planned slices with dedup, bounded concurrency,
// a sha256 integrity gate, and a single retry before marking a slice failed.

import type { FontManifest, FontSliceRef } from './manifest';
import type { FontSlicePlan } from './select';
import { FontLoadError } from './errors';

export interface FetchJob { url: string; sha256: string; format: 'otf' | 'woff2'; }
export type FetchResult = { job: FetchJob; ok: true; bytes: Uint8Array } | { job: FetchJob; ok: false; error: string };
export interface Fetcher { fetchBatch(jobs: FetchJob[]): Promise<FetchResult[]>; }
export interface EnsureState { loaded: Set<string>; failed: Set<string>; inflight: Set<string>; }

export function createEnsureState(): EnsureState { return { loaded: new Set(), failed: new Set(), inflight: new Set() }; }

export async function* runEnsure(
  manifest: FontManifest, plan: FontSlicePlan, state: EnsureState, fetcher: Fetcher,
  opts: { maxConcurrency: number; onError?: (err: FontLoadError) => void },
): AsyncGenerator<{ family: string; id: string; bytes: Uint8Array }> {
  const jobs: Array<{ key: string; family: string; slice: FontSliceRef; retry: boolean }> = [];
  for (const fp of plan.families) {
    const fam = manifest.families[fp.family];
    if (!fam) { continue; }
    const refs: FontSliceRef[] =
      fp.load === 'full' ? [] :
      fp.load === 'whole' ? [] :
      (fam.slices ?? []).filter((s) => fp.sliceIds.includes(s.id));
    for (const slice of refs) {
      const key = `${fp.family}/${slice.id}`;
      if (state.loaded.has(key) || state.failed.has(key) || state.inflight.has(key)) { continue; }
      state.inflight.add(key);
      jobs.push({ key, family: fp.family, slice, retry: false });
    }
  }
  // Simple pool: batch jobs up to maxConcurrency; one retry pass for failed jobs.
  for (let pass = 0; pass < 2 && jobs.length > 0; pass++) {
    const pending = jobs.splice(0);
    for (let i = 0; i < pending.length; i += opts.maxConcurrency) {
      const batch = pending.slice(i, i + opts.maxConcurrency);
      const results = await fetcher.fetchBatch(batch.map((j) => ({ url: j.slice.url, sha256: j.slice.sha256, format: j.slice.format })));
      for (const r of results) {
        const j = batch.find((b) => b.slice.url === r.job.url)!;
        if (r.ok && await sha256Hex(r.bytes) === r.job.sha256) {
          state.loaded.add(j.key); state.inflight.delete(j.key);
          yield { family: j.family, id: j.slice.id, bytes: r.bytes };
        } else if (pass === 0 && !j.retry) {
          jobs.push({ ...j, retry: true });   // one retry (spec 9)
        } else {
          // Final failure: mark failed, report via onError, keep going — one bad
          // slice must not abort the other slices (spec 9).
          state.inflight.delete(j.key); state.failed.add(j.key);
          if (opts.onError) { opts.onError(new FontLoadError(j.family, j.slice.id, `slice fetch/hash failed: ${r.ok ? 'sha256' : 'network'}`)); }
        }
      }
    }
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
