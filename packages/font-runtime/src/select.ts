import type { FontManifest, FontSliceRef } from './manifest';

export interface FamilyPlan { family: string; load: 'slices' | 'full' | 'whole'; sliceIds: string[]; }
export interface FontSlicePlan { families: FamilyPlan[]; }

// Families always active even when the document references nothing (spec 8.3).
const DEFAULT_FAMILY_KEYS = ['notosans', 'notosanscjksc'];
const FULL_SHORT_CIRCUIT = 0.8;

export function selectInitial(
  manifest: FontManifest, codepoints: number[], families: string[], opts: { preloadCommon: boolean },
): FontSlicePlan {
  const byName = new Map<string, string>();
  for (const [key, fam] of Object.entries(manifest.families)) { byName.set(fam.displayName, key); }
  const active = new Set<string>(DEFAULT_FAMILY_KEYS);
  for (const name of families) { const key = byName.get(name); if (key) { active.add(key); } }
  const plans: FamilyPlan[] = [];
  for (const key of active) {
    const fam = manifest.families[key];
    if (!fam) { continue; }
    if (fam.whole && !fam.slices) { plans.push({ family: key, load: 'whole', sliceIds: [] }); continue; }
    if (!fam.slices || !fam.full) { continue; }
    const selected = fam.slices.filter((s) =>
      s.codepoints.some(([lo, hi]) => codepoints.some((cp) => cp >= lo && cp <= hi))
      || (opts.preloadCommon && s.preload === true));
    const bytes = selected.reduce((n, s) => n + s.bytes, 0);
    if (bytes > fam.full.bytes * FULL_SHORT_CIRCUIT) {
      plans.push({ family: key, load: 'full', sliceIds: [] });   // spec 7.1 short-circuit
    } else {
      plans.push({ family: key, load: 'slices', sliceIds: selected.map(sliceId) });
    }
  }
  return { families: plans };
}

function sliceId(s: FontSliceRef): string { return s.id; }
