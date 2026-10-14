// FontWorker body: fetch + sha256 + woff2 decode, posts results with transferables.
import { serveJobs, type FetchJob, type FetchResult } from './fetcher';

self.onmessage = async (ev: MessageEvent<{ jobs: FetchJob[] }>) => {
  const results = await serveJobs(ev.data.jobs, async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer()));
  const transfer = results.filter((r) => r.ok).map((r) => (r as { bytes: Uint8Array }).bytes.buffer);
  (self as unknown as Worker).postMessage({ results }, transfer);
};
