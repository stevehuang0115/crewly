/**
 * Pure logic for cleanup-stale-pool — extracted into a library so the
 * stale-rule, KEEP_LIST derivation, and classification logic can be
 * exercised by a unit test without spinning up the live backend.
 *
 * The CLI (`cleanup-stale-pool.ts`) is a thin shell that fetches WIs
 * via HTTP and calls {@link classifyPoolForCleanup} on the result.
 *
 * @module scripts/cleanup-stale-pool.lib
 */

/**
 * The minimal WorkItem shape this library actually reads. Defined as a
 * narrow structural type so the library does not depend on the full
 * backend type graph (which would force the CLI to bundle backend
 * source). Production payloads from `/api/task-pool/items` carry many
 * more fields — they are passed through unchanged.
 */
export interface MinimalWorkItem {
  id: string;
  status: string;
  createdAt: string;
  target?: string;
  parentWorkItemId?: string;
  parentRequestId?: string;
  requestId?: string;
  // Pass-through unknown fields — the library doesn't read them.
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Defaults — KEEP_LIST seed set
// ---------------------------------------------------------------------------

/**
 * Hardcoded WI ids that must NEVER be deleted regardless of age.
 * These are ORC-parked umbrella WIs and audit-trail entries Steve
 * referenced as "keep-no-matter-what" in the dispatch.
 *
 * Children of these (via `parentWorkItemId`) are also kept — see
 * {@link classifyPoolForCleanup}.
 */
export const DEFAULT_KEEP_IDS: readonly string[] = Object.freeze([
  // Agent-improvement P0 umbrella (parked)
  'd5656813-1040-4610-9d02-63c2a4f3aad9',
  // Pool-claim umbrella itself (this WI's parent)
  '1ffffb84-2cfb-4811-8670-3cc301bc332a',
  // O1 observability WI (parked)
  '8c9f7abe-436f-4548-a4e9-ece25217f2e7',
  // Lifecycle umbrella (today)
  '72ca743a-3a66-4d0e-a6cf-1a861f849dbd',
  // Dogfood subscriber (done today, KEEP for audit trail)
  '745f7ba8-f88f-434d-a855-3279d348e15e',
  // F4 WI (done today)
  '2d1d15da-b2e6-4df9-9dc7-949c0e8770c8',
  // F8 WI (done today)
  '6465e00f-edb8-4f7f-819e-38c16a052142',
]);

/**
 * Parent Request ids whose child WIs must never be deleted regardless
 * of age. The pool-umbrella Request from Steve's directive sits here.
 */
export const DEFAULT_KEEP_PARENT_REQUEST_IDS: readonly string[] = Object.freeze([
  '322e7fd3-b2c5-4f34-8c88-6cc490757d23',
]);

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Inputs for {@link classifyPoolForCleanup}. */
export interface CleanupOptions {
  /**
   * ISO8601 cutoff. WorkItems with `createdAt` strictly before this
   * timestamp are stale candidates (subject to KEEP_LIST overrides).
   */
  cutoff: string;
  /** Hardcoded WI ids that must always survive. */
  keepIds?: readonly string[];
  /** Parent Request ids whose children must always survive. */
  keepParentRequestIds?: readonly string[];
}

/** Output of {@link classifyPoolForCleanup}. */
export interface CleanupClassification {
  /** WorkItems that should be deleted. */
  stale: MinimalWorkItem[];
  /** WorkItems retained because `createdAt >= cutoff` (today's work). */
  keptToday: MinimalWorkItem[];
  /** WorkItems retained because they hit the KEEP_LIST. */
  keptByAllowlist: MinimalWorkItem[];
}

/**
 * Apply the stale rule against an in-memory pool snapshot.
 *
 * Stale rule (single clause):
 *   STALE iff createdAt < cutoff AND id NOT IN dynamic KEEP_LIST
 *
 * Dynamic KEEP_LIST is the union of:
 *   1. Hardcoded ids (`opts.keepIds`).
 *   2. Any WI whose `parentWorkItemId` is in the hardcoded id set
 *      (umbrella sub-WIs).
 *   3. Any WI whose `parentRequestId` (or `requestId`) is in
 *      `opts.keepParentRequestIds`.
 *
 * Pure function — no I/O, no logging. The CLI handles printing and
 * HTTP. This separation lets the unit test pin the rule and KEEP-LIST
 * derivation without touching the network or filesystem.
 *
 * @param items - The full pool snapshot (typically from
 *   `GET /api/task-pool/items`).
 * @param opts - Cutoff + allow-list seed.
 * @returns A {@link CleanupClassification} bucketed into stale,
 *   kept-today, and kept-by-allowlist.
 */
export function classifyPoolForCleanup(
  items: readonly MinimalWorkItem[],
  opts: CleanupOptions,
): CleanupClassification {
  const keepIds = new Set(opts.keepIds ?? []);
  const keepParentRequestIds = new Set(opts.keepParentRequestIds ?? []);
  const cutoffMs = new Date(opts.cutoff).getTime();

  // Build the dynamic allow-list. First pass: anything matching the
  // seed sets directly. Second pass: parent-WI-membership (so children
  // of allow-listed umbrellas are also kept).
  const allowedIds = new Set<string>();
  for (const wi of items) {
    if (keepIds.has(wi.id)) {
      allowedIds.add(wi.id);
      continue;
    }
    const reqId = wi.parentRequestId ?? wi.requestId;
    if (reqId && keepParentRequestIds.has(reqId)) {
      allowedIds.add(wi.id);
    }
  }
  // Second pass: items whose parent is in the seed-keepIds (or
  // already-allowed via parent-request-membership) are kept too.
  // Simple fixpoint — bounded by pool size, so a single sweep
  // catches direct children; deeper trees would need a loop, but the
  // umbrella structure here is one level deep.
  for (const wi of items) {
    if (allowedIds.has(wi.id)) continue;
    if (wi.parentWorkItemId && (keepIds.has(wi.parentWorkItemId) || allowedIds.has(wi.parentWorkItemId))) {
      allowedIds.add(wi.id);
    }
  }

  const stale: MinimalWorkItem[] = [];
  const keptToday: MinimalWorkItem[] = [];
  const keptByAllowlist: MinimalWorkItem[] = [];

  for (const wi of items) {
    const createdMs = new Date(wi.createdAt).getTime();
    const isOld = Number.isFinite(createdMs) && createdMs < cutoffMs;
    if (allowedIds.has(wi.id)) {
      keptByAllowlist.push(wi);
    } else if (!isOld) {
      keptToday.push(wi);
    } else {
      stale.push(wi);
    }
  }

  return { stale, keptToday, keptByAllowlist };
}
