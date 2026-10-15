// Shared job logic + main-thread Worker client with graceful fallback.
import { decodeIfNeeded } from './decode';
import type { SliceFormat } from './manifest';

export interface FetchJob { url: string; sha256: string; format: SliceFormat; }
export type FetchResult = { url: string; ok: true; bytes: Uint8Array } | { url: string; ok: false; error: string };

export async function serveJobs(jobs: FetchJob[], fetchBytes: (url: string) => Promise<Uint8Array>): Promise<FetchResult[]> {
  return Promise.all(jobs.map(async (job): Promise<FetchResult> => {
    try {
      const raw = await fetchBytes(job.url);
      const hash = await crypto.subtle.digest('SHA-256', raw as unknown as ArrayBuffer);
      const hex = Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
      if (hex !== job.sha256) { return { url: job.url, ok: false, error: `sha256 mismatch: ${job.url}` }; }
      const bytes = await decodeIfNeeded(raw, job.format);
      return { url: job.url, ok: true, bytes };
    } catch (e) {
      return { url: job.url, ok: false, error: String(e) };
    }
  }));
}

export interface Fetcher { fetchBatch(jobs: FetchJob[]): Promise<FetchResult[]> }

/**
 * Stall deadline for one worker batch (ms), exported for tests. Some hosts
 * (rword app under vite dev) load the worker and accept the job but never
 * deliver a message OR error event — without a deadline the batch, and
 * runEnsure behind it, hangs forever.
 */
export const WORKER_BATCH_TIMEOUT_MS = 15_000;

/**
 * Worker-backed Fetcher (fetch + sha256 + woff2 decode off the main thread).
 * Serialization contract: callers must not overlap fetchBatch calls —
 * runEnsure awaits each batch before issuing the next, and the single
 * onmessage slot assumes exactly one outstanding batch.
 */
class WorkerFetcher implements Fetcher {
  private worker: Worker | null = null;
  fetchBatch(jobs: FetchJob[]): Promise<FetchResult[]> {
    // One postMessage round per batch; failure to construct Worker falls back.
    if (!this.worker) {
      try {
        this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      } catch {
        this.worker = null;
        return this.mainThread(jobs);
      }
    }
    const w = this.worker;
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (result: FetchResult[] | Promise<FetchResult[]>) => {
        if (settled) { return; }
        settled = true;
        if (timer !== undefined) { clearTimeout(timer); }
        resolve(result);
      };
      // Stall belt: same recovery shape as onerror below — terminate, drop the
      // worker, and serve the batch on the main thread.
      timer = setTimeout(() => {
        this.worker = null;
        w.terminate();
        settle(this.mainThread(jobs));
      }, WORKER_BATCH_TIMEOUT_MS);
      // Construction can succeed while loading fails later (404 on the script,
      // module resolution error, crash before the first postMessage): onmessage
      // then never fires, so onerror must settle the pending batch via the
      // main-thread fallback instead of leaving it — and runEnsure — hanging.
      w.onerror = () => {
        this.worker = null;
        w.terminate();
        settle(this.mainThread(jobs));
      };
      w.onmessage = (ev: MessageEvent<{ results: FetchResult[] }>) => { settle(ev.data.results); };
      w.postMessage({ jobs });
    });
  }
  private async mainThread(jobs: FetchJob[]): Promise<FetchResult[]> {
    return serveJobs(jobs, async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer()));
  }
}

export function createFetcher(): Fetcher { return new WorkerFetcher(); }
