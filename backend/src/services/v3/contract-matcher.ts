/**
 * Contract-rule matching predicate shared by the service contract gate and
 * any caller that wants to pre-filter requests against a team's accepts /
 * avoids list.
 *
 * Keeping the predicate in one module guarantees gate decisions and skill-side
 * filtering can't drift — both paths call the same `matchRule`.
 */

/**
 * Case-insensitive substring match. Accepts either direction — a rule
 * matches if either string contains the other. This tolerates both tightly
 * scoped rules (`"bugfix"`) and verbose request phrasing (`"urgent frontend
 * bugfix in checkout"`).
 *
 * @param requestType - The incoming request phrase to classify.
 * @param rules - The team's accepts/avoids list.
 * @returns The first rule that matched, or `null` when no rule applies.
 */
export function matchRule(
  requestType: string,
  rules: readonly string[],
): string | null {
  const needle = requestType.trim().toLowerCase();
  if (!needle) return null;
  for (const rule of rules) {
    const hay = rule.trim().toLowerCase();
    if (!hay) continue;
    if (needle.includes(hay) || hay.includes(needle)) {
      return rule;
    }
  }
  return null;
}
