/**
 * Cursor pagination helper for the over-fetch-one idiom: a query asks for
 * `limit + 1` rows, and this trims the extra sentinel row while reporting
 * whether a further page exists. `hasMore` is true exactly when the query
 * returned more than `limit` rows; `page` is then the first `limit` rows.
 */
export function trimPage<T>(
  rows: readonly T[],
  limit: number
): { page: readonly T[]; hasMore: boolean } {
  const hasMore = rows.length > limit;
  return { page: hasMore ? rows.slice(0, limit) : rows, hasMore };
}
