/**
 * Role-knowledge recall-eligibility helpers (M3 — Memory Importance,
 * Confidence, Evidence + lifecycle filtering).
 *
 * Implements the recall-eligibility rules from
 * `.crewly/specs/2026-05-03-memory-codebase-improvement-plan.md` §183-187:
 *
 * | Rule                                              | Effect                                  |
 * | ------------------------------------------------- | --------------------------------------- |
 * | importance ≥ 0.85 AND confidence ≥ 0.7            | Eligible for auto-inject into context   |
 * | confidence < 0.5                                  | NEVER auto-inject (explicit recall only)|
 * | supersededBy != null                              | Hidden from default recall (audit-only) |
 * | ttl < now                                         | Archived, hidden from recall            |
 * | shouldInjectByDefault === false                   | Hidden from default recall              |
 * | shouldInjectByDefault === true                    | Auto-inject (overrides derivation)      |
 *
 * The helpers are split from `memory.service.ts` so the live (singleton)
 * service and the agent-memory service can share one implementation.
 *
 * @module services/memory/role-knowledge-eligibility
 */

import type { RoleKnowledgeEntry } from '../../types/memory.types.js';

/**
 * Default importance value for legacy entries that pre-date M3.
 * Per spec §191: "existing entries get default importance=0.5".
 */
export const DEFAULT_IMPORTANCE = 0.5;

/**
 * Default confidence value for legacy entries that omit the field.
 * Per spec §191: default confidence=0.7.
 */
export const DEFAULT_CONFIDENCE = 0.7;

/**
 * Lower bound for "auto-inject eligible" entries.
 */
export const AUTO_INJECT_IMPORTANCE_MIN = 0.85;

/**
 * Confidence floor for auto-inject (cannot auto-inject below this).
 */
export const AUTO_INJECT_CONFIDENCE_MIN = 0.7;

/**
 * Hard cut-off — entries below this confidence are NEVER auto-injected,
 * regardless of importance or `shouldInjectByDefault` overrides.
 *
 * Per spec §185: "confidence < 0.5 → NEVER auto-inject (only show on
 * explicit recall)".
 */
export const NEVER_AUTO_INJECT_CONFIDENCE = 0.5;

/**
 * Check whether an entry has expired against the supplied "now".
 *
 * @param entry - Knowledge entry under evaluation
 * @param now - Reference instant (ISO string or Date). Defaults to Date.now().
 * @returns true when the entry's TTL has passed
 */
export function isExpired(
  entry: Pick<RoleKnowledgeEntry, 'ttl'>,
  now: Date = new Date(),
): boolean {
  if (!entry.ttl) return false;
  const ttlMs = Date.parse(entry.ttl);
  // Invalid ISO → treat as not expired (fail-soft) so a malformed entry
  // doesn't get silently disappeared.
  if (Number.isNaN(ttlMs)) return false;
  return ttlMs < now.getTime();
}

/**
 * Lazy-migrate a possibly-legacy entry to v3 shape **for read**.
 *
 * The migration is non-destructive — it returns a copy with M3 defaults
 * filled in:
 *
 * - `importance` → `DEFAULT_IMPORTANCE` when missing
 * - `confidence` → `DEFAULT_CONFIDENCE` when missing
 * - `evidence`   → `[learnedFrom]` when learnedFrom present, else `[]`
 * - `shouldInjectByDefault` left **undefined** so the eligibility
 *   predicate can fall back to the derived rule
 *
 * Callers that **persist** entries should write the v3 fields explicitly;
 * this helper deliberately does not write back.
 *
 * @param entry - Legacy or v3 entry to normalize for read
 * @returns Entry with v3 fields guaranteed (importance + confidence
 *          + evidence)
 *
 * @example
 * ```typescript
 * const view = lazyMigrateEntry(rawEntry);
 * if (isAutoInjectEligible(view)) prompt += view.content;
 * ```
 */
export function lazyMigrateEntry(entry: RoleKnowledgeEntry): RoleKnowledgeEntry {
  const evidence: string[] | undefined =
    entry.evidence !== undefined
      ? entry.evidence
      : entry.learnedFrom
        ? [entry.learnedFrom]
        : [];
  return {
    ...entry,
    importance: entry.importance ?? DEFAULT_IMPORTANCE,
    confidence: entry.confidence ?? DEFAULT_CONFIDENCE,
    evidence,
  };
}

/**
 * Check whether an entry is eligible to be auto-injected into agent
 * context by default.
 *
 * **Rule order (per spec §183-187):**
 * 1. Hidden if `superseded === true` or `supersededBy != null` — audit-only.
 * 2. Hidden if expired (`ttl < now`).
 * 3. Honored if `shouldInjectByDefault` is explicitly set:
 *    - `false` → NEVER auto-inject regardless of scores.
 *    - `true`  → auto-inject UNLESS confidence < 0.5 (the hard floor
 *               from §185).
 * 4. Otherwise derived: `importance >= 0.85 AND confidence >= 0.7`.
 *
 * @param entry - Knowledge entry under evaluation (does not need to be pre-migrated)
 * @param now - Reference instant for TTL evaluation. Defaults to Date.now().
 * @returns true when this entry should appear in default-recall results
 *
 * @example
 * ```typescript
 * const visible = entries.filter((e) => isAutoInjectEligible(e));
 * ```
 */
export function isAutoInjectEligible(
  entry: RoleKnowledgeEntry,
  now: Date = new Date(),
): boolean {
  // Step 1 — supersession.
  if (entry.superseded === true || entry.supersededBy) return false;

  // Step 2 — TTL.
  if (isExpired(entry, now)) return false;

  // Read-time normalization for the score gates below.
  const importance = entry.importance ?? DEFAULT_IMPORTANCE;
  const confidence = entry.confidence ?? DEFAULT_CONFIDENCE;

  // Step 3 — explicit override, but the < 0.5 confidence floor always wins.
  if (entry.shouldInjectByDefault === false) return false;
  if (entry.shouldInjectByDefault === true) {
    return confidence >= NEVER_AUTO_INJECT_CONFIDENCE;
  }

  // Step 4 — derived gate.
  return (
    importance >= AUTO_INJECT_IMPORTANCE_MIN &&
    confidence >= AUTO_INJECT_CONFIDENCE_MIN
  );
}

/**
 * Should this entry be **completely hidden** from default-recall?
 *
 * This is a strict superset of "not eligible for auto-inject" — entries
 * that are merely below the auto-inject score gate are still surfaced on
 * default recall (just not auto-injected into prompts), but entries that
 * are superseded or expired are not surfaced at all unless the caller
 * explicitly opts in.
 *
 * @param entry - Knowledge entry under evaluation
 * @param now - Reference instant for TTL evaluation. Defaults to Date.now().
 * @returns true when default recall should drop this entry
 */
export function isHiddenFromDefaultRecall(
  entry: RoleKnowledgeEntry,
  now: Date = new Date(),
): boolean {
  if (entry.superseded === true || entry.supersededBy) return true;
  if (isExpired(entry, now)) return true;
  return false;
}
