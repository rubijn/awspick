/**
 * Small subsequence matcher, sized for one list of ~100 rows.
 *
 * Scores a candidate against a query with bonuses for prefix matches, word
 * boundaries (`-` and `_` count) and consecutive runs, so `prod` ranks
 * `acme-prod-…` above `…-preprod-…`, and `2222` still finds a profile by
 * account number. Multi-term queries require every term to match.
 */

const isBoundary = (char: string | undefined): boolean =>
  char === undefined || char === '-' || char === '_' || char === '.' || char === '/' || char === ' ';

/** Higher is better. `null` means "no match". */
export function scoreOne(query: string, candidate: string): number | null {
  if (query === '') return 0;
  const needle = query.toLowerCase();
  const haystack = candidate.toLowerCase();

  let score = 0;
  let from = 0;
  let previousIndex = -2;

  for (let i = 0; i < needle.length; i += 1) {
    const char = needle[i] as string;
    const at = haystack.indexOf(char, from);
    if (at === -1) return null;

    if (at === 0) score += 12; // start of the string
    else if (isBoundary(haystack[at - 1])) score += 8; // start of a word
    if (at === previousIndex + 1) score += 6; // consecutive run
    score -= Math.min(at - from, 6); // distance penalty, capped

    previousIndex = at;
    from = at + 1;
  }

  // Prefer tighter candidates when scores tie: `jb` should beat `jb-presign`.
  score -= Math.min(Math.floor(candidate.length / 8), 6);
  if (haystack === needle) score += 40;
  else if (haystack.startsWith(needle)) score += 16;
  return score;
}

/**
 * Score a whitespace-separated query against several fields (name, account,
 * role). Every term must hit at least one field; the best field wins per term.
 */
export function scoreFields(query: string, fields: ReadonlyArray<string | undefined>): number | null {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;

  let total = 0;
  for (const term of terms) {
    let best: number | null = null;
    for (const field of fields) {
      if (!field) continue;
      const score = scoreOne(term, field);
      if (score !== null && (best === null || score > best)) best = score;
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}
