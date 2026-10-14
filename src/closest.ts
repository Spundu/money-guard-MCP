// "Did you mean ...?" for a name that matched nothing: a CSV column, or a column in money_columns or
// ignore_columns. The candidates can come from a hostile file (a CSV header of 5,000 columns of 5,000
// characters each), so the work is bounded: each distance is computed once, on at most the first
// COMPARE_MAX characters, over at most CANDIDATES_MAX candidates.

const COMPARE_MAX = 64;
const CANDIDATES_MAX = 5000;

/** Levenshtein distance between two short strings. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cur = row[j] ?? 0;
      row[j] = Math.min(cur + 1, (row[j - 1] ?? 0) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length] ?? 0;
}

/**
 * The candidate closest to `name`, ignoring letter case, if it is close enough to be a likely typo
 * (within 2 edits, or a third of the name's length); otherwise undefined. Ties go to the first.
 */
export function closest(name: string, candidates: Iterable<string>): string | undefined {
  const target = name.slice(0, COMPARE_MAX).toLowerCase();
  const limit = Math.max(2, Math.floor(target.length / 3));
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  let seen = 0;
  for (const candidate of candidates) {
    if (seen++ >= CANDIDATES_MAX) break;
    const d = distance(candidate.slice(0, COMPARE_MAX).toLowerCase(), target);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
      if (d === 0) break;
    }
  }
  return bestDistance <= limit ? best : undefined;
}
