// Inclusive codepoint interval set with binary-search lookup.
// Invariant: ranges stay sorted by start and pairwise disjoint — addRanges
// coalesces overlapping or adjacent (next.lo <= cur.hi + 1) ranges so the
// binary search in contains remains sound.
export class IntervalSet {
  private ranges: [number, number][] = [];
  static ofRanges(rs: readonly [number, number][]): IntervalSet {
    const s = new IntervalSet();
    s.addRanges(rs);
    return s;
  }
  addRanges(rs: readonly [number, number][]): void {
    this.ranges.push(...rs.map((r) => [r[0], r[1]] as [number, number]));
    this.ranges.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const r of this.ranges) {
      const cur = merged[merged.length - 1];
      if (cur && r[0] <= cur[1] + 1) {
        if (r[1] > cur[1]) { cur[1] = r[1]; }
      } else {
        merged.push([r[0], r[1]]);
      }
    }
    this.ranges = merged;
  }
  contains(cp: number): boolean {
    let lo = 0, hi = this.ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = this.ranges[mid];
      if (cp < r[0]) { hi = mid - 1; } else if (cp > r[1]) { lo = mid + 1; } else { return true; }
    }
    return false;
  }
}
