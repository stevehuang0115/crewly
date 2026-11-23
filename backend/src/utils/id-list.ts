/**
 * Short, capped lists of ids for one-line summaries.
 *
 * @module utils/id-list
 */

/**
 * Sort ids the way a person reads them: `CREW-2` before `CREW-10`.
 *
 * @param ids - Ids (duplicates are dropped)
 * @returns A new sorted array
 */
export function sortIdsNaturally(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/**
 * Render ids as `A, B, C`, or `A, B, +N more` past `max`.
 *
 * The listed ids plus the "+N more" always add up to the number of ids given,
 * so a count printed next to the list can be checked against it.
 *
 * @param ids - Ids, already in the order to show
 * @param max - Most ids to name (at least 1)
 * @returns The text ('' for no ids)
 *
 * @example
 * ```typescript
 * formatIdList(['CREW-1', 'CREW-2', 'CREW-3'], 2); // 'CREW-1, CREW-2, +1 more'
 * ```
 */
export function formatIdList(ids: readonly string[], max: number): string {
  const limit = Math.max(1, Math.floor(max));
  if (ids.length <= limit) return ids.join(', ');
  return `${ids.slice(0, limit).join(', ')}, +${ids.length - limit} more`;
}
