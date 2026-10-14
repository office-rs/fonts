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

class WorkerFetcher implements Fetcher {
  private worker: Worker | null = null;
  private pending = new Map<string, Promise<FetchResult[]>>();
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
      w.onmessage = (ev: MessageEvent<{ results: FetchResult[] }>) => { resolve(ev.data.results); };
      w.postMessage({ jobs });
    });
  }
  private async mainThread(jobs: FetchJob[]): Promise<FetchResult[]> {
    return serveJobs(jobs, async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer()));
  }
}

export function createFetcher(): Fetcher { return new WorkerFetcher(); }
