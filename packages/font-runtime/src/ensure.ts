// Ensure pipeline: fetch planned slices (plus whole-/full-file family refs under
// pseudo ids) with dedup, bounded concurrency, and a single retry before marking
// a slice failed. Integrity is the fetcher's contract: serveJobs verifies
// sha256 on the RAW bytes before decoding, so r.ok === true already means the
// hash matched — re-hashing here would compare decoded TTF bytes against the
// woff2-file digest and reject every woff2 slice by construction.

import type { FontManifest, FontSliceRef } from './manifest';
import type { FontSlicePlan } from './select';
import type { Fetcher } from './fetcher';
import { FontLoadError } from './errors';

export interface EnsureState { loaded: Set<string>; failed: Set<string>; inflight: Set<string>; }

export function createEnsureState(): EnsureState { return { loaded: new Set(), failed: new Set(), inflight: new Set() }; }

// Pseudo slice ids for whole-file / full-file family plans: whole/full refs are
// FontFileRefs (no id of their own), but they ride the same slice pipeline —
// dedup keys, yields, and error reports carry these ids.
export const WHOLE_SLICE_ID = '__whole__';
export const FULL_SLICE_ID = '__full__';

export async function* runEnsure(
  manifest: FontManifest, plan: FontSlicePlan, state: EnsureState, fetcher: Fetcher,
  opts: { maxConcurrency: number; onError?: (err: FontLoadError) => void },
): AsyncGenerator<{ family: string; id: string; bytes: Uint8Array }> {
  const jobs: Array<{ key: string; family: string; slice: FontSliceRef; retry: boolean }> = [];
  // Keys this run added to state.inflight; swept in the finally below if the
  // run terminates abnormally (consumer break, body throw, fetchBatch reject).
  const thisRunKeys = new Set<string>();
  for (const fp of plan.families) {
    const fam = manifest.families[fp.family];
    if (!fam) { continue; }
    const refs: FontSliceRef[] =
      fp.load === 'whole' && fam.whole
        ? [{ ...fam.whole, id: WHOLE_SLICE_ID, kind: 'common', codepoints: [] }]
      : fp.load === 'full' && fam.full
        ? [{ ...fam.full, id: FULL_SLICE_ID, kind: 'common', codepoints: [] }]
      : fp.load === 'slices'
        ? (fam.slices ?? []).filter((s) => fp.sliceIds.includes(s.id))
        : [];
    for (const slice of refs) {
      const key = `${fp.family}/${slice.id}`;
      if (state.loaded.has(key) || state.failed.has(key) || state.inflight.has(key)) { continue; }
      state.inflight.add(key);
      thisRunKeys.add(key);
      jobs.push({ key, family: fp.family, slice, retry: false });
    }
  }
  // Simple pool: batch jobs up to maxConcurrency; one retry pass for failed jobs.
  try {
    for (let pass = 0; pass < 2 && jobs.length > 0; pass++) {
      const pending = jobs.splice(0);
      for (let i = 0; i < pending.length; i += opts.maxConcurrency) {
        const batch = pending.slice(i, i + opts.maxConcurrency);
        const results = await fetcher.fetchBatch(batch.map((j) => ({ url: j.slice.url, sha256: j.slice.sha256, format: j.slice.format })));
        for (const r of results) {
          const j = batch.find((b) => b.slice.url === r.url)!;
          // Single hash gate: the fetcher already verified sha256 on raw bytes
          // (serveJobs) — success here is r.ok alone, and r.bytes are DECODED.
          if (r.ok) {
            state.loaded.add(j.key); state.inflight.delete(j.key);
            yield { family: j.family, id: j.slice.id, bytes: r.bytes };
          } else if (pass === 0 && !j.retry) {
            jobs.push({ ...j, retry: true });   // one retry (spec 9)
          } else {
            // Final failure: mark failed, report via onError, keep going — one bad
            // slice must not abort the other slices (spec 9). The fetcher's
            // error string carries the cause (network vs sha256 mismatch).
            state.inflight.delete(j.key); state.failed.add(j.key);
            if (opts.onError) { opts.onError(new FontLoadError(j.family, j.slice.id, `slice fetch failed: ${r.error}`)); }
          }
        }
      }
    }
  } finally {
    // Success/failure paths above delete resolved keys individually; this sweep
    // only removes keys still present because the run aborted early, so a later
    // run can retry them. Delete is idempotent — nothing already resolved is
    // resurrected.
    for (const key of thisRunKeys) { state.inflight.delete(key); }
  }
}
