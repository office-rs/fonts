import { describe, expect, it } from 'vitest';
import { IntervalSet } from '../src/coverage';
import { selectInitial } from '../src/select';
import type { FontManifest } from '../src/manifest';

// Two families: a sliced CJK family (2 common + 2 block slices + full) and a whole Latin family.
function fixture(): FontManifest {
  const slice = (id: string, kind: 'common' | 'block', preload: boolean, bytes: number, cps: [number, number][]) =>
    ({ id, kind, preload, url: `x/${id}.woff2`, format: 'woff2' as const, sha256: 'a'.repeat(64), bytes, codepoints: cps });
  return { version: 1, generated: '', families: {
    notosanscjksc: { displayName: 'Noto Sans CJK SC', full: { url: 'x/full.woff2', format: 'woff2', sha256: 'a'.repeat(64), bytes: 400 },
      slices: [ slice('common-0', 'common', true, 100, [[19968, 19970]]),
                slice('common-1', 'common', true, 100, [[20000, 20002]]),
                slice('blk-0', 'block', false, 100, [[30000, 30255]]),
                slice('blk-1', 'block', false, 100, [[31000, 31255]]) ] },
    notosans: { displayName: 'Noto Sans', whole: { url: 'x/latin.woff2', format: 'woff2', sha256: 'a'.repeat(64), bytes: 50 } },
  } };
}

describe('selectInitial', () => {
  it('selects covering slices + preload commons for referenced family, whole for defaults', () => {
    const plan = selectInitial(fixture(), [19968, 30010], ['Noto Sans CJK SC'], { preloadCommon: true });
    const cjk = plan.families.find((f) => f.family === 'notosanscjksc')!;
    expect(cjk.load).toBe('slices');
    expect(cjk.sliceIds.sort()).toEqual(['blk-0', 'common-0', 'common-1']);
    const latin = plan.families.find((f) => f.family === 'notosans')!;
    expect(latin.load).toBe('whole');
  });
  it('preloadCommon=false drops preload-only slices', () => {
    const plan = selectInitial(fixture(), [19968], [], { preloadCommon: false });
    const cjk = plan.families.find((f) => f.family === 'notosanscjksc')!;
    expect(cjk.sliceIds).toEqual(['common-0']);   // covering only
  });
  it('unreferenced non-default sliced family is not selected', () => {
    const m = fixture();
    m.families.serif = { displayName: 'Noto Serif CJK SC', slices: [] };
    const plan = selectInitial(m, [19968], [], { preloadCommon: true });
    expect(plan.families.some((f) => f.family === 'serif')).toBe(false);
  });
  it('preloadCommon=true activates unreferenced families carrying preload slices (self-sliced hosts)', () => {
    // A host's own sliced manifest (e.g. commercial fonts) merges families the
    // document never references; their `preload: true` common slices must load
    // for blank documents too, not just the hard-coded Noto defaults.
    const m = fixture();
    m.families.simsun = { displayName: 'SimSun',
      full: { url: 'x/sim-full.woff2', format: 'woff2', sha256: 'a'.repeat(64), bytes: 900 },
      slices: [ ({ id: 'common-0', kind: 'common', preload: true, url: 'x/sim-common-0.woff2', format: 'woff2' as const, sha256: 'a'.repeat(64), bytes: 90, codepoints: [[19968, 19970]] }) ] };
    const plan = selectInitial(m, [], [], { preloadCommon: true });
    const simsun = plan.families.find((f) => f.family === 'simsun')!;
    expect(simsun.load).toBe('slices');
    expect(simsun.sliceIds).toEqual(['common-0']);
    // And with preloadCommon=false the family stays inactive (covering only).
    const off = selectInitial(m, [], [], { preloadCommon: false });
    expect(off.families.some((f) => f.family === 'simsun')).toBe(false);
  });
  it('short-circuits to full when selected bytes exceed 80% of full', () => {
    const plan = selectInitial(fixture(), [19968, 20000, 30000, 31000], ['Noto Sans CJK SC'], { preloadCommon: true });
    // 4 slices x100 = 400 > 320 (80% of 400) → full
    expect(plan.families.find((f) => f.family === 'notosanscjksc')!.load).toBe('full');
  });
});

describe('IntervalSet', () => {
  it('contains and addRanges', () => {
    const s = IntervalSet.ofRanges([[1, 3]]);
    expect(s.contains(2)).toBe(true);
    expect(s.contains(4)).toBe(false);
    s.addRanges([[5, 6]]);
    expect(s.contains(5)).toBe(true);
  });
  it('merges overlapping ranges so contains stays sound', () => {
    const s = IntervalSet.ofRanges([[1, 1000], [5, 10], [20, 30]]);
    expect(s.contains(500)).toBe(true);
    expect(s.contains(2)).toBe(true);
    expect(s.contains(1001)).toBe(false);
  });
  it('merges adjacent ranges and handles out-of-order adds', () => {
    const s = IntervalSet.ofRanges([[4, 6]]);
    s.addRanges([[1, 3]]);          // adjacent -> merges to [1,6]
    expect(s.contains(3)).toBe(true);
    expect(s.contains(4)).toBe(true);
    expect(s.contains(6)).toBe(true);
    expect(s.contains(7)).toBe(false);
  });
  it('probes inclusive endpoints', () => {
    const s = IntervalSet.ofRanges([[1, 3]]);
    expect(s.contains(1)).toBe(true);
    expect(s.contains(3)).toBe(true);
    expect(s.contains(0)).toBe(false);
    expect(s.contains(4)).toBe(false);
  });
});
