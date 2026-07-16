/**
 * Compute one row of the DP matrix from the previous row, given the current
 * row's first column (the edit distance from `longer[0..row]` to the empty
 * shorter string) and the code point of the row's character.
 */
function computeRow(
  previous: readonly number[],
  current: number[],
  shorter: string,
  longerCodePoint: number
): void {
  for (let col = 1; col <= shorter.length; col++) {
    /* v8 ignore next -- @preserve defensive `?? 0`: col-1 is always a valid index of `shorter` */
    const shorterCodePoint = shorter.codePointAt(col - 1) ?? 0;
    const cost = shorterCodePoint === longerCodePoint ? 0 : 1;
    /* v8 ignore start -- @preserve defensive `?? 0`: col and col-1 are always valid indices of the fully-populated rows */
    const deletion = (previous[col] ?? 0) + 1;
    const insertion = (current[col - 1] ?? 0) + 1;
    const substitution = (previous[col - 1] ?? 0) + cost;
    /* v8 ignore stop */
    current[col] = Math.min(deletion, insertion, substitution);
  }
}

/**
 * Levenshtein edit distance between two strings.
 *
 * Counts insertions, deletions, and substitutions; transpositions are two edits
 * (we are not Damerau–Levenshtein). Operates on UTF-16 code units; surrogate pairs
 * count as two units. Sufficient for model-id matching where inputs are ASCII.
 *
 * Implementation: two-row dynamic programming, O(min(a, b)) memory and O(a × b) time.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure `a` is the shorter string so the row buffer is the smaller dimension.
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];

  let previous: number[] = Array.from({ length: shorter.length + 1 }, (_, index) => index);
  let current: number[] = Array.from({ length: shorter.length + 1 }, () => 0);

  for (let row = 1; row <= longer.length; row++) {
    current[0] = row;
    /* v8 ignore next -- @preserve defensive `?? 0`: row-1 is always a valid index of `longer` */
    const longerCodePoint = longer.codePointAt(row - 1) ?? 0;
    computeRow(previous, current, shorter, longerCodePoint);
    [previous, current] = [current, previous];
  }

  /* v8 ignore next -- @preserve defensive `?? 0`: shorter.length is always a valid index of `previous` */
  return previous[shorter.length] ?? 0;
}
