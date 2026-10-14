import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { serveJobs } from '../src/fetcher';
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
});
