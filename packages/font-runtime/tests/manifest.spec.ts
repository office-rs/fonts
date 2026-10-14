import { describe, expect, it } from 'vitest';
import { mergeManifests, parseManifest } from '../src/manifest';

const ok = {
  version: 1, generated: '2026-10-14T00:00:00Z',
  families: {
    notosanscjksc: {
      displayName: 'Noto Sans CJK SC',
      slices: [{ id: 'common-0', kind: 'common', preload: true, url: 'notosanscjksc/common-0.woff2',
                 format: 'woff2', sha256: 'a'.repeat(64), bytes: 100, codepoints: [[19968, 19970]] }],
    },
  },
};

describe('parseManifest', () => {
  it('accepts a valid manifest', () => {
    expect(parseManifest(ok).families.notosanscjksc.displayName).toBe('Noto Sans CJK SC');
  });
  it('rejects unknown schema version', () => {
    expect(() => parseManifest({ ...ok, version: 2 })).toThrow(/version/);
  });
  it('rejects descending codepoint ranges', () => {
    const bad = structuredClone(ok);
    bad.families.notosanscjksc.slices![0].codepoints = [[200, 100]];
    expect(() => parseManifest(bad)).toThrow(/codepoint/);
  });
});

describe('mergeManifests', () => {
  it('merges disjoint family keys', () => {
    const other = structuredClone(ok);
    other.families = { myfont: { displayName: 'My Font', slices: [] } };
    const merged = mergeManifests([parseManifest(ok), parseManifest(other)]);
    expect(Object.keys(merged.families).sort()).toEqual(['myfont', 'notosanscjksc']);
  });
  it('throws on duplicate family key', () => {
    expect(() => mergeManifests([parseManifest(ok), parseManifest(ok)])).toThrow(/conflict/);
  });
});
