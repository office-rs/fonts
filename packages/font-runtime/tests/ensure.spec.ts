import { describe, expect, it, vi } from 'vitest';
import { createEnsureState, runEnsure } from '../src/ensure';
import { serveJobs, type Fetcher, type FetchJob, type FetchResult } from '../src/fetcher';
import type { FontLoadError } from '../src/errors';
import { parseManifest } from '../src/manifest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Build a manifest whose single slice's sha256 matches the literal bytes "ABC".
const sha = createHash('sha256').update('ABC').digest('hex');
const manifest = parseManifest({ version: 1, generated: '', families: { f: { displayName: 'F',
  slices: [{ id: 's0', kind: 'block', url: 'u0', format: 'otf', sha256: sha, bytes: 3, codepoints: [[1, 2]] }] } } });
const plan = { families: [{ family: 'f', load: 'slices' as const, sliceIds: ['s0'] }] };

function makeFetcher(map: Record<string, string | Error>, hooks: { activeMax: number; active: number } = { activeMax: 0, active: 0 }) {
  return {
    async fetchBatch(jobs: FetchJob[]): Promise<FetchResult[]> {
      hooks.active += jobs.length;
      hooks.activeMax = Math.max(hooks.activeMax, hooks.active);
      const out = [];
      for (const job of jobs) {
        const v = map[job.url];
        if (v instanceof Error) { out.push({ url: job.url, ok: false as const, error: v.message }); }
        else { out.push({ url: job.url, ok: true as const, bytes: new TextEncoder().encode(v) }); }
      }
      hooks.active -= jobs.length;
      return out;
    },
  } satisfies Fetcher;
}

describe('runEnsure', () => {
  it('yields decoded bytes for a good slice', async () => {
    const got = [];
    for await (const s of runEnsure(manifest, plan, createEnsureState(), makeFetcher({ u0: 'ABC' }), { maxConcurrency: 6 })) { got.push(s); }
    expect(got.map((g) => [g.family, g.id, Buffer.from(g.bytes).toString()])).toEqual([['f', 's0', 'ABC']]);
  });
  it('skips already-loaded slices (dedup)', async () => {
    const state = createEnsureState(); state.loaded.add('f/s0');
    const fetcher = makeFetcher({ u0: 'ABC' });
    const spy = vi.spyOn(fetcher, 'fetchBatch');
    for await (const _ of runEnsure(manifest, plan, state, fetcher, { maxConcurrency: 6 })) { /* drain */ }
    expect(spy).not.toHaveBeenCalled();
  });
  it('marks failed after one retry and never re-queues in the same state', async () => {
    const state = createEnsureState();
    const errFetcher = makeFetcher({ u0: new Error('net') });
    const errors: FontLoadError[] = [];
    const got = [];
    for await (const s of runEnsure(manifest, plan, state, errFetcher, { maxConcurrency: 6, onError: (e) => errors.push(e) })) { got.push(s); }
    expect(got).toEqual([]);
    expect(state.failed.has('f/s0')).toBe(true);
    expect(errors.length).toBe(1);
    expect(errors[0].sliceId).toBe('s0');
    // Second run over the same state must not retry the failed slice.
    const spy = vi.spyOn(errFetcher, 'fetchBatch');
    for await (const _ of runEnsure(manifest, plan, state, errFetcher, { maxConcurrency: 6 })) { /* drain */ }
    expect(spy).not.toHaveBeenCalled();
  });
  it('sha256 mismatch reported by the fetcher is a failure (single hash gate)', async () => {
    // Contract-faithful fake: the REAL fetcher (serveJobs) is the single hash
    // gate — it verifies sha256 on the RAW bytes before decode and reports a
    // mismatch as {ok:false}. runEnsure must not re-hash (r.bytes are decoded
    // TTF, whose digest never matches the woff2-file sha in the manifest).
    const state = createEnsureState();
    const fetcher = makeFetcher({ u0: new Error('sha256 mismatch: u0') });
    const errors: FontLoadError[] = [];
    const got = [];
    for await (const s of runEnsure(manifest, plan, state, fetcher, { maxConcurrency: 6, onError: (e) => errors.push(e) })) { got.push(s); }
    expect(got).toEqual([]);
    expect(state.failed.has('f/s0')).toBe(true);
    expect(errors.length).toBe(1);
    expect(errors[0].sliceId).toBe('s0');
    // Second run over the same state must not re-fetch the failed slice.
    const spy = vi.spyOn(fetcher, 'fetchBatch');
    for await (const _ of runEnsure(manifest, plan, state, fetcher, { maxConcurrency: 6 })) { /* drain */ }
    expect(spy).not.toHaveBeenCalled();
  });
  it('woff2 slice end-to-end: real serveJobs gate yields DECODED ttf bytes', async () => {
    // Manifest sha256 hashes the woff2 FILE (serveJobs checks it on raw bytes
    // pre-decode); the slice must still yield with the decoded TTF payload.
    const woff2 = new Uint8Array(readFileSync('test-data/abc.woff2'));
    const shaWoff2 = createHash('sha256').update(woff2).digest('hex');
    const woff2Manifest = parseManifest({ version: 1, generated: '', families: { f: { displayName: 'F',
      slices: [{ id: 's0', kind: 'block', url: 'f/s0.woff2', format: 'woff2', sha256: shaWoff2, bytes: woff2.length, codepoints: [[1, 2]] }] } } });
    const woff2Plan = { families: [{ family: 'f', load: 'slices' as const, sliceIds: ['s0'] }] };
    const errors: FontLoadError[] = [];
    const fetcher: Fetcher = {
      // The REAL serveJobs as the Fetcher: inject only the byte source (disk).
      fetchBatch: (jobs) => serveJobs(jobs, async (url) => { expect(url).toBe('f/s0.woff2'); return woff2.slice(); }),
    };
    const got = [];
    for await (const s of runEnsure(woff2Manifest, woff2Plan, createEnsureState(), fetcher, { maxConcurrency: 6, onError: (e) => errors.push(e) })) { got.push(s); }
    expect(errors).toEqual([]);
    expect(got.length).toBe(1);
    expect(got[0].id).toBe('s0');
    expect(Array.from(got[0].bytes.slice(0, 4))).toEqual([0x00, 0x01, 0x00, 0x00]);   // decoded sfnt magic
  });
  it('sweeps inflight keys when the consumer breaks out early', async () => {
    const shaOf = (s: string) => createHash('sha256').update(s).digest('hex');
    const manifest2 = parseManifest({ version: 1, generated: '', families: { f: { displayName: 'F',
      slices: [
        { id: 's0', kind: 'block', url: 'u0', format: 'otf', sha256: shaOf('A0'), bytes: 2, codepoints: [[1, 2]] },
        { id: 's1', kind: 'block', url: 'u1', format: 'otf', sha256: shaOf('A1'), bytes: 2, codepoints: [[3, 4]] },
      ] } } });
    const plan2 = { families: [{ family: 'f', load: 'slices' as const, sliceIds: ['s0', 's1'] }] };
    const state = createEnsureState();
    const fetcher = makeFetcher({ u0: 'A0', u1: 'A1' });
    for await (const _ of runEnsure(manifest2, plan2, state, fetcher, { maxConcurrency: 2 })) { break; }
    // Neither key may stay stranded in inflight after an abnormal termination.
    expect(state.inflight.size).toBe(0);
    // The missed slice must be retryable by a later run over the same state.
    const got = [];
    for await (const s of runEnsure(manifest2, plan2, state, fetcher, { maxConcurrency: 2 })) { got.push(s); }
    expect(got.map((g) => g.id)).toEqual(['s1']);
  });
  it('whole-plan family yields the whole file bytes once and dedups on second run', async () => {
    const shaOf = (s: string) => createHash('sha256').update(s).digest('hex');
    const wholeManifest = parseManifest({ version: 1, generated: '', families: { f: { displayName: 'F',
      whole: { url: 'w0', format: 'otf', sha256: shaOf('WHOLE'), bytes: 5 } } } });
    const wholePlan = { families: [{ family: 'f', load: 'whole' as const, sliceIds: [] }] };
    const state = createEnsureState();
    const fetcher = makeFetcher({ w0: 'WHOLE' });
    const got = [];
    for await (const s of runEnsure(wholeManifest, wholePlan, state, fetcher, { maxConcurrency: 6 })) { got.push(s); }
    expect(got.map((g) => [g.family, g.id, Buffer.from(g.bytes).toString()])).toEqual([['f', '__whole__', 'WHOLE']]);
    // Second run over the same state dedups — no refetch.
    const spy = vi.spyOn(fetcher, 'fetchBatch');
    for await (const _ of runEnsure(wholeManifest, wholePlan, state, fetcher, { maxConcurrency: 6 })) { /* drain */ }
    expect(spy).not.toHaveBeenCalled();
  });
  it('full-plan family yields the full file bytes once and dedups on second run', async () => {
    const shaOf = (s: string) => createHash('sha256').update(s).digest('hex');
    const fullManifest = parseManifest({ version: 1, generated: '', families: { f: { displayName: 'F',
      full: { url: 'fl0', format: 'otf', sha256: shaOf('FULL'), bytes: 4 } } } });
    const fullPlan = { families: [{ family: 'f', load: 'full' as const, sliceIds: [] }] };
    const state = createEnsureState();
    const fetcher = makeFetcher({ fl0: 'FULL' });
    const got = [];
    for await (const s of runEnsure(fullManifest, fullPlan, state, fetcher, { maxConcurrency: 6 })) { got.push(s); }
    expect(got.map((g) => [g.family, g.id, Buffer.from(g.bytes).toString()])).toEqual([['f', '__full__', 'FULL']]);
    // Second run over the same state dedups — no refetch.
    const spy = vi.spyOn(fetcher, 'fetchBatch');
    for await (const _ of runEnsure(fullManifest, fullPlan, state, fetcher, { maxConcurrency: 6 })) { /* drain */ }
    expect(spy).not.toHaveBeenCalled();
  });
  it('bounds fetch concurrency to maxConcurrency', async () => {
    const shaOf = (s: string) => createHash('sha256').update(s).digest('hex');
    const slices = [0, 1, 2, 3, 4].map((i) => ({ id: `s${i}`, kind: 'block' as const, url: `u${i}`, format: 'otf' as const,
      sha256: shaOf(`A${i}`), bytes: 2, codepoints: [[1, 2]] }));
    const manifest5 = parseManifest({ version: 1, generated: '', families: { f: { displayName: 'F', slices } } });
    const plan5 = { families: [{ family: 'f', load: 'slices' as const, sliceIds: slices.map((s) => s.id) }] };
    const hooks = { activeMax: 0, active: 0 };
    const fetcher = makeFetcher(Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`u${i}`, `A${i}`])), hooks);
    const got = [];
    for await (const s of runEnsure(manifest5, plan5, createEnsureState(), fetcher, { maxConcurrency: 2 })) { got.push(s); }
    expect(hooks.activeMax).toBeLessThanOrEqual(2);
    expect(got.length).toBe(5);
  });
});
