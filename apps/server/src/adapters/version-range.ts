/**
 * The CLI versions an adapter was tested with (P11-04, P11-05): a range like `>=0.166 <0.200`
 * (space-separated comparators, all of which must hold; `>=`, `>`, `<=`, `<`, `=`). A version
 * outside it is a preflight *warning*, never an error: an untested CLI may still work.
 */

function parts(version: string): number[] | undefined {
  const m = /(\d+(?:\.\d+)*)/.exec(version);
  return m ? m[1]!.split('.').map(Number) : undefined;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The first `x.y.z` in a CLI's version output (`codex-cli 0.166.0` → `0.166.0`). */
export function versionOf(output: string): string | undefined {
  return /(\d+\.\d+(?:\.\d+)*)/.exec(output)?.[1];
}

/** Whether `version` satisfies every comparator of `range`; a version that does not parse fails. */
export function versionInRange(version: string, range: string): boolean {
  const v = parts(version);
  if (!v) return false;
  return range
    .trim()
    .split(/\s+/)
    .every((comparator) => {
      const m = /^(>=|<=|>|<|=)?(\d+(?:\.\d+)*)$/.exec(comparator);
      if (!m) return false;
      const d = compare(v, parts(m[2]!)!);
      switch (m[1] ?? '=') {
        case '>=':
          return d >= 0;
        case '>':
          return d > 0;
        case '<=':
          return d <= 0;
        case '<':
          return d < 0;
        default:
          return d === 0;
      }
    });
}
