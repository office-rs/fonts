import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createFetcher, serveJobs, WORKER_BATCH_TIMEOUT_MS } from '../src/fetcher';
import { createHash } from 'node:crypto';

const woff2 = new Uint8Array(readFileSync('test-data/abc.woff2'));
const sha = createHash('sha256').update(woff2).digest('hex');

describe('serveJobs', () => {
  it('fetches, hash-checks, decodes woff2', async () => {
    const results = await serveJobs([{ url: 'http://x/abc.woff2', sha256: sha, format: 'woff2' }],
      async (url) => { expect(url).toContain('abc.woff2'); return woff2.slice(); });
    expect(results[0].ok).toBe(true);
    if (results[0].ok) { expect(results[0].bytes[1]).toBe(0x01); }   // decoded TTF magic
  });
  it('wrong sha256 yields failure', async () => {
    const results = await serveJobs([{ url: 'u', sha256: '0'.repeat(64), format: 'otf' }],
      async () => new Uint8Array([9]));
    expect(results[0].ok).toBe(false);
  });
  it('falls back to main thread when the worker fails asynchronously', async () => {
    // A Worker stub whose construction succeeds but whose script "fails to
    // load": postMessage dispatches an async error event and never a message.
    let latest: { terminated: boolean } | null = null;
    class FakeFailingWorker {
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: ErrorEvent) => void) | null = null;
      terminated = false;
      constructor(_scriptUrl: URL, _opts?: unknown) { latest = this; }
      postMessage(_msg: unknown): void {
        queueMicrotask(() => this.onerror?.({} as ErrorEvent));
      }
      terminate(): void { this.terminated = true; }
    }
    vi.stubGlobal('Worker', FakeFailingWorker);
    vi.stubGlobal('fetch', (async () => ({ arrayBuffer: async () => woff2.slice().buffer })) as unknown as typeof fetch);
    try {
      const results = await createFetcher().fetchBatch([{ url: 'http://x/abc.woff2', sha256: sha, format: 'woff2' }]);
      expect(results[0].ok).toBe(true);
      if (results[0].ok) { expect(results[0].bytes[1]).toBe(0x01); }   // served (and decoded) by the fallback
      expect(latest?.terminated).toBe(true);   // the broken worker was torn down, not reused
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('WorkerFetcher stall belt', () => {
  it('a silent worker batch (no message, no error) times out and recovers on the main thread', async () => {
    // The rword-under-vite-dev hang class: the worker constructs and accepts
    // the job, but neither onmessage nor onerror ever fires. Without a
    // deadline the batch — and runEnsure behind it — hangs forever.
    vi.useFakeTimers();
    let latest: SilentWorker | null = null;
    class SilentWorker {
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: ErrorEvent) => void) | null = null;
      terminated = false;
      constructor(_scriptUrl: URL, _opts?: unknown) { latest = this; }
      postMessage(_msg: unknown): void { /* silence — the stall */ }
      terminate(): void { this.terminated = true; }
    }
    vi.stubGlobal('Worker', SilentWorker);
    vi.stubGlobal('fetch', (async () => ({ arrayBuffer: async () => woff2.slice().buffer })) as unknown as typeof fetch);
    try {
      const batch = createFetcher().fetchBatch([{ url: 'http://x/abc.woff2', sha256: sha, format: 'woff2' }]);
      vi.advanceTimersByTime(WORKER_BATCH_TIMEOUT_MS + 1);   // deadline passes → stall belt fires (worker torn down, fallback started)
      // Fake timers have done their job (the deadline). The recovery chain
      // still needs real loop turns — crypto.subtle.digest resolves off a
      // libuv thread AND woff2-encoder's wrapper yields through a real
      // setTimeout(0) before each wasm call — so restore real timers and let
      // the fallback settle naturally.
      vi.useRealTimers();
      const results = await batch;   // recovered via the main-thread path
      expect(results[0].ok).toBe(true);
      if (results[0].ok) { expect(results[0].bytes[1]).toBe(0x01); }   // fetched + decoded by the fallback
      expect(latest?.terminated).toBe(true);                 // the stalled worker was torn down, not reused
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
  it('a healthy worker batch does not hit the stall timeout', async () => {
    vi.useFakeTimers();
    let latest: ReplyWorker | null = null;
    class ReplyWorker {
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: ErrorEvent) => void) | null = null;
      terminated = false;
      constructor(_scriptUrl: URL, _opts?: unknown) { latest = this; }
      postMessage(_msg: unknown): void {
        queueMicrotask(() => this.onmessage?.({ data: { results: [
          { url: 'http://x/abc.woff2', ok: true, bytes: woff2.slice() },
        ] } } as MessageEvent));
      }
      terminate(): void { this.terminated = true; }
    }
    const fetched: string[] = [];
    vi.stubGlobal('Worker', ReplyWorker);
    vi.stubGlobal('fetch', (async (u: string) => {
      fetched.push(u);   // must stay empty: the worker served this batch
      return { arrayBuffer: async () => woff2.slice().buffer };
    }) as unknown as typeof fetch);
    try {
      const results = await createFetcher().fetchBatch([{ url: 'http://x/abc.woff2', sha256: sha, format: 'woff2' }]);
      expect(results[0].ok).toBe(true);
      expect(fetched).toEqual([]);                           // worker path, no fallback
      await vi.advanceTimersByTimeAsync(WORKER_BATCH_TIMEOUT_MS + 1);   // well past the deadline
      expect(latest?.terminated).toBe(false);                // timeout was cleared; worker stays for reuse
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
