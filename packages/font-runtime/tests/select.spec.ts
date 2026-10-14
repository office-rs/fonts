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
});
