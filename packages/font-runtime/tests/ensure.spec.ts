import { describe, expect, it, vi } from 'vitest';
import { createEnsureState, runEnsure } from '../src/ensure';
import type { Fetcher, FetchJob } from '../src/ensure';
import type { FontLoadError } from '../src/errors';
import { parseManifest } from '../src/manifest';
import { createHash } from 'node:crypto';

// Build a manifest whose single slice's sha256 matches the literal bytes "ABC".
const sha = createHash('sha256').update('ABC').digest('hex');
const manifest = parseManifest({ version: 1, generated: '', families: { f: { displayName: 'F',
  slices: [{ id: 's0', kind: 'block', url: 'u0', format: 'otf', sha256: sha, bytes: 3, codepoints: [[1, 2]] }] } } });
const plan = { families: [{ family: 'f', load: 'slices' as const, sliceIds: ['s0'] }] };

function makeFetcher(map: Record<string, string | Error>, hooks: { activeMax: number; active: number } = { activeMax: 0, active: 0 }) {
  return {
    async fetchBatch(jobs: FetchJob[]): Promise<Array<{ job: FetchJob; ok: true; bytes: Uint8Array } | { job: FetchJob; ok: false; error: string }>> {
      hooks.active += jobs.length;
      hooks.activeMax = Math.max(hooks.activeMax, hooks.active);
      const out = [];
      for (const job of jobs) {
        const v = map[job.url];
        if (v instanceof Error) { out.push({ job, ok: false as const, error: v.message }); }
        else { out.push({ job, ok: true as const, bytes: new TextEncoder().encode(v) }); }
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
  it('sha256 mismatch is a failure', async () => {
    const state = createEnsureState();
    const fetcher = makeFetcher({ u0: 'XXX' });
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
});
