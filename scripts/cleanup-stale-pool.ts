#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Bulk-DELETE stale WorkItems from the live Task Pool.
 *
 * P1 umbrella WI 1ffffb84-2cfb-4811-8670-3cc301bc332a, component (a).
 * Steve directive 2026-05-06: "过去的workitem就可以删掉不要了 那些都stale了"
 * → just delete past stale WIs, do NOT bother backfilling to status=done.
 *
 * Pre-fix audit count (verified by ORC 2026-05-06 ~01:30Z):
 *   total=214, byStatus = queued=95 / cancelled=89 / done_by_worker=22 /
 *                          blocked=2 / running=2 / failed=3 / done=1.
 * Most of those are stale residue from earlier sprints. This script
 * drains them in one pass.
 *
 * Stale rule (single clause):
 *   STALE iff createdAt < {STALE_CUTOFF} AND id NOT IN KEEP_LIST
 *
 * KEEP_LIST is derived dynamically (NOT hardcoded ids that rot) by:
 *   - Hardcoded umbrella ids (parked work the team still references).
 *   - Any WI with parentWorkItemId ∈ {umbrella ids}.
 *   - Any WI with parentRequestId == {umbrella request id}.
 *   - Any WI with createdAt >= STALE_CUTOFF (today's work).
 *
 * Dry-run-first protocol:
 *   - Default mode (no flag, or `--dry-run`): prints the count + sample
 *     of ids that WOULD be deleted, plus the KEEP_LIST surviving count.
 *     Makes ZERO network mutations.
 *   - `--apply`: actually issues DELETE /api/task-pool/:id for each
 *     stale id. Requires the dry-run to have been eyeballed first
 *     (Sam/Steve eyeball). Use `--force` to also delete WIs with active
 *     claims (revokes the claim).
 *
 * Exit codes:
 *   0  success
 *   1  dry-run with no stale items found (informational, not an error)
 *   2  apply mode failed (any DELETE returned non-2xx for non-claim
 *      reasons)
 *   3  invalid CLI args
 *
 * Usage:
 *   tsx scripts/cleanup-stale-pool.ts                # dry-run (default)
 *   tsx scripts/cleanup-stale-pool.ts --dry-run      # explicit dry-run
 *   tsx scripts/cleanup-stale-pool.ts --apply        # do the deletes
 *   tsx scripts/cleanup-stale-pool.ts --apply --force  # also delete claimed
 *   BACKEND_URL=http://host:port tsx scripts/cleanup-stale-pool.ts
 *   STALE_CUTOFF=2026-05-05T00:00:00Z tsx scripts/cleanup-stale-pool.ts
 *
 * @module scripts/cleanup-stale-pool
 */

// Issue #478: the lib's named exports are bundled inside `default` when
// tsx transpiles for this `"type": "module"` package — Node's strict ESM
// loader then refuses any named-import specifier (the symptom was
// SyntaxError "does not provide an export named 'DEFAULT_KEEP_IDS'").
// Workaround: import the namespace as default, then destructure at
// runtime. Types come from a separate `import type` line, which tsc /
// tsx erases entirely so the runtime resolution is unaffected.
import libDefault from '../backend/src/scripts/cleanup-stale-pool.lib.js';
import type {
  CleanupClassification,
  MinimalWorkItem,
} from '../backend/src/scripts/cleanup-stale-pool.lib.js';

const {
  classifyPoolForCleanup,
  DEFAULT_KEEP_IDS,
  DEFAULT_KEEP_PARENT_REQUEST_IDS,
} = libDefault as unknown as {
  classifyPoolForCleanup: typeof import('../backend/src/scripts/cleanup-stale-pool.lib.js').classifyPoolForCleanup;
  DEFAULT_KEEP_IDS: typeof import('../backend/src/scripts/cleanup-stale-pool.lib.js').DEFAULT_KEEP_IDS;
  DEFAULT_KEEP_PARENT_REQUEST_IDS: typeof import('../backend/src/scripts/cleanup-stale-pool.lib.js').DEFAULT_KEEP_PARENT_REQUEST_IDS;
};

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8787';
const STALE_CUTOFF = process.env.STALE_CUTOFF || '2026-05-06T00:00:00Z';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface CliFlags {
  apply: boolean;
  force: boolean;
  dryRun: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = { apply: false, force: false, dryRun: false };
  for (const a of argv) {
    if (a === '--apply') flags.apply = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${a}`);
      console.error(USAGE);
      process.exit(3);
    }
  }
  // Default mode is dry-run unless --apply is set.
  if (!flags.apply) flags.dryRun = true;
  return flags;
}

const USAGE = `Usage:
  tsx scripts/cleanup-stale-pool.ts            # dry-run (default)
  tsx scripts/cleanup-stale-pool.ts --apply    # delete stale WIs
  tsx scripts/cleanup-stale-pool.ts --apply --force  # also delete claimed

Env:
  BACKEND_URL   default http://localhost:8787
  STALE_CUTOFF  ISO8601 timestamp; default 2026-05-06T00:00:00Z`;

// ---------------------------------------------------------------------------
// HTTP helpers — Node 20+ global fetch, no extra deps.
// ---------------------------------------------------------------------------

async function fetchAllItems(): Promise<MinimalWorkItem[]> {
  const url = `${BACKEND_URL}/api/task-pool/items`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const body = await res.json() as { success: boolean; data?: MinimalWorkItem[]; error?: string };
  if (!body.success || !Array.isArray(body.data)) {
    throw new Error(`GET ${url} → ${body.error || 'unexpected response shape'}`);
  }
  return body.data;
}

interface DeleteResponse {
  success: boolean;
  removed?: boolean;
  reason?: string;
  code?: string;
  error?: string;
  workItemId?: string;
  claimedBy?: string;
}

async function deleteOne(id: string, force: boolean): Promise<DeleteResponse> {
  const qs = force ? '?force=1' : '';
  const url = `${BACKEND_URL}/api/task-pool/${id}${qs}`;
  const res = await fetch(url, { method: 'DELETE' });
  // Both 200 and 409 paths return a JSON body.
  return res.json() as Promise<DeleteResponse>;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));

  console.log('--- cleanup-stale-pool ---');
  console.log(`backend:       ${BACKEND_URL}`);
  console.log(`STALE_CUTOFF:  ${STALE_CUTOFF}`);
  console.log(`mode:          ${flags.apply ? 'APPLY' : 'DRY-RUN'}${flags.force ? ' (force)' : ''}`);
  console.log('');

  // 1. Pull every WorkItem.
  const all = await fetchAllItems();
  console.log(`fetched ${all.length} WorkItems from pool`);

  // 2. Classify into stale / kept using the pure library function (also
  //    used by the unit test — keeps the rule, sample logic, and KEEP
  //    derivation in one tested place).
  const classified: CleanupClassification = classifyPoolForCleanup(all, {
    cutoff: STALE_CUTOFF,
    keepIds: DEFAULT_KEEP_IDS,
    keepParentRequestIds: DEFAULT_KEEP_PARENT_REQUEST_IDS,
  });

  console.log(`stale:         ${classified.stale.length}`);
  console.log(`kept (today):  ${classified.keptToday.length}`);
  console.log(`kept (allow):  ${classified.keptByAllowlist.length}`);
  console.log('');

  if (classified.stale.length === 0) {
    console.log('No stale WorkItems — nothing to do.');
    return 1;
  }

  // 3. Print sample so reviewer can eyeball before --apply.
  console.log(`--- sample (up to 10 of ${classified.stale.length}) ---`);
  for (const wi of classified.stale.slice(0, 10)) {
    console.log(
      `  ${wi.id}  status=${wi.status}  target=${wi.target ?? '-'}  createdAt=${wi.createdAt}`,
    );
  }
  console.log('');

  if (flags.dryRun) {
    console.log('DRY-RUN: no deletions made. Re-run with --apply to commit.');
    return 0;
  }

  // 4. Apply mode — delete each stale WI in sequence.
  let successes = 0;
  let claimedSkips = 0;
  let failures = 0;
  for (const wi of classified.stale) {
    let resp: DeleteResponse;
    try {
      resp = await deleteOne(wi.id, flags.force);
    } catch (err) {
      console.error(`  network error on ${wi.id}: ${(err as Error).message}`);
      failures++;
      continue;
    }
    if (resp.success && resp.removed) {
      successes++;
    } else if (resp.success && !resp.removed && resp.reason === 'not_found') {
      // Already gone — count as success (idempotent).
      successes++;
    } else if (!resp.success && resp.code === 'work_item_claimed') {
      console.error(
        `  refused ${wi.id}: claimed by ${resp.claimedBy ?? '?'}; ` +
        `re-run with --force if you want to revoke and delete`,
      );
      claimedSkips++;
    } else {
      console.error(`  failed ${wi.id}: ${resp.error ?? 'unknown'}`);
      failures++;
    }
  }

  console.log('');
  console.log('--- apply summary ---');
  console.log(`deleted:       ${successes}`);
  console.log(`claim-skips:   ${claimedSkips}`);
  console.log(`failures:      ${failures}`);

  return failures > 0 ? 2 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('FATAL:', err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(2);
  });
