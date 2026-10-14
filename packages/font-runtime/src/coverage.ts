// Inclusive codepoint interval set with binary-search lookup.
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
