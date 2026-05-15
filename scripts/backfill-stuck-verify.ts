#!/usr/bin/env tsx
/**
 * One-shot backfill for two pre-#553 stall shapes:
 *
 * Shape A (default mode):
 *   - Source WorkItem at `done_by_worker` (worker finished)
 *   - Verify WorkItem (`metadata.verifyOf === source.id`) at `done` (TL verified)
 *   - Source never moved to `verified`, so dependents stay `blocked` forever.
 *   - Fix: flip source to `verified`. PR #553 prevents this going forward.
 *
 * Shape B (`--stale-cleanup`):
 *   - Source WorkItem at `done_by_worker` for >2 hours, AND
 *     - either no verify WI ever got created, OR
 *     - the verify WI is in `cancelled` (SLA timeout, queue-stale, etc.)
 *   - These will never reach `verified` through normal flow. The work was
 *     done; nobody will review it. Mark as `cancelled` with a clear reason
 *     so the UI/heartbeat sweep stops listing them as "in flight".
 *   - State-machine note: `done_by_worker → cancelled` is NOT a legal edge
 *     (matrix only allows → verified/rejected). The script bypasses
 *     transitionStatus by editing pool.json directly while the server is
 *     stopped — acceptable for one-shot offline cleanup.
 *
 * **Operates directly on `pool.json`** because the running server caches
 * pool data in memory (`PoolStorage.load` short-circuits on a populated
 * `this.cache`). Editing pool.json without bouncing the server is
 * therefore ineffective. The script:
 *   1. Requires the server to be stopped (warns and exits if reachable).
 *   2. Atomically rewrites pool.json (temp + fsync + rename).
 *   3. Caller restarts the server afterwards.
 *
 * Usage:
 *   crewly service stop
 *   tsx scripts/backfill-stuck-verify.ts                       # dry-run shape A
 *   tsx scripts/backfill-stuck-verify.ts --apply               # apply shape A
 *   tsx scripts/backfill-stuck-verify.ts --stale-cleanup       # dry-run shape B
 *   tsx scripts/backfill-stuck-verify.ts --stale-cleanup --apply
 *   crewly service start
 *
 * @module scripts/backfill-stuck-verify
 */

/* eslint-disable no-console */

import { readFile, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const POOL_PATH =
  process.env.POOL_PATH ?? join(homedir(), '.crewly', 'task-pool', 'pool.json');
const API_BASE = process.env.CREWLY_API_URL ?? 'http://localhost:8787';

interface WorkItem {
  id: string;
  status: string;
  metadata?: Record<string, unknown>;
  title?: string;
  type?: string;
  completedAt?: string;
}

interface PoolData {
  workItems: WorkItem[];
  claims: unknown[];
  lastUpdatedAt?: string;
}

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Stale threshold for the cleanup mode — done_by_worker WIs older than this
 *  with a cancelled/missing verify WI are abandoned, no review will happen. */
const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

async function main(): Promise<number> {
  const apply = process.argv.includes('--apply');
  const cleanup = process.argv.includes('--stale-cleanup');
  const mode = cleanup ? 'stale-cleanup' : 'verify-propagation';
  console.log(
    `[backfill-stuck-verify] mode=${mode} action=${apply ? 'apply' : 'dry-run'} pool=${POOL_PATH}`,
  );

  if (apply && (await isServerRunning())) {
    console.error(
      `\nERROR: server appears to be running at ${API_BASE}/health.\n` +
        `The server caches pool data in memory; writing pool.json while it's\n` +
        `running will be overwritten on next flush. Stop the service first:\n` +
        `  crewly service stop\n` +
        `then re-run this script.`,
    );
    return 1;
  }

  const raw = await readFile(POOL_PATH, 'utf-8');
  const data = JSON.parse(raw) as PoolData;
  console.log(`Loaded ${data.workItems.length} WorkItems`);

  const sourceByDoneByWorker = new Map<string, WorkItem>();
  for (const w of data.workItems) {
    if (w.status === 'done_by_worker') sourceByDoneByWorker.set(w.id, w);
  }
  console.log(`Sources in done_by_worker: ${sourceByDoneByWorker.size}`);

  // Index every verify WI by its source id (whatever its status).
  const verifyBySource = new Map<string, WorkItem>();
  for (const w of data.workItems) {
    const verifyOf =
      w.metadata && typeof w.metadata.verifyOf === 'string'
        ? (w.metadata.verifyOf as string)
        : undefined;
    if (verifyOf) verifyBySource.set(verifyOf, w);
  }

  if (cleanup) {
    return await runStaleCleanup({ data, sourceByDoneByWorker, verifyBySource, apply });
  }
  return await runVerifyPropagation({ data, sourceByDoneByWorker, verifyBySource, apply });
}

/** Shape A — flip stuck `done_by_worker` sources to `verified` when their
 *  verify WI is already `done`. */
async function runVerifyPropagation(args: {
  data: PoolData;
  sourceByDoneByWorker: Map<string, WorkItem>;
  verifyBySource: Map<string, WorkItem>;
  apply: boolean;
}): Promise<number> {
  const { data, sourceByDoneByWorker, verifyBySource, apply } = args;
  const stuckPairs: Array<{ source: WorkItem; verifyId: string }> = [];
  for (const [sourceId, source] of sourceByDoneByWorker) {
    const verify = verifyBySource.get(sourceId);
    if (!verify) continue;
    if (verify.status !== 'done') continue;
    stuckPairs.push({ source, verifyId: verify.id });
  }

  console.log(`\nStuck pairs (verify=done, source=done_by_worker): ${stuckPairs.length}`);
  for (const { source, verifyId } of stuckPairs) {
    const title = (source.title ?? '').slice(0, 70);
    console.log(`  source=${source.id}  verify=${verifyId}  ${title}`);
  }

  if (stuckPairs.length === 0) {
    console.log('\nNothing to backfill.');
    return 0;
  }

  if (!apply) {
    console.log('\n(dry-run — re-run with --apply to push these to verified)');
    return 0;
  }

  const now = new Date().toISOString();
  for (const { source } of stuckPairs) {
    source.status = 'verified';
    if (!source.completedAt) source.completedAt = now;
  }
  data.lastUpdatedAt = now;
  await writePool(data);

  console.log(`\nDone: ${stuckPairs.length} sources flipped to verified.`);
  console.log(`Restart the service to pick up the change:`);
  console.log(`  crewly service start`);
  console.log(
    `\nThe reconciler will then re-evaluate dependents on its next tick and unblock\n` +
      `any Execute/Review WIs that were waiting on these sources.`,
  );
  return 0;
}

/** Shape B — mark stale `done_by_worker` WIs as `cancelled` when their
 *  verify WI is `cancelled` or never got created. These will never reach
 *  `verified` through normal flow, so they sit in the UI forever as
 *  "in flight". */
async function runStaleCleanup(args: {
  data: PoolData;
  sourceByDoneByWorker: Map<string, WorkItem>;
  verifyBySource: Map<string, WorkItem>;
  apply: boolean;
}): Promise<number> {
  const { data, sourceByDoneByWorker, verifyBySource, apply } = args;
  const nowMs = Date.now();

  const stalePairs: Array<{ source: WorkItem; verify: WorkItem | undefined; ageH: number }> = [];
  for (const [sourceId, source] of sourceByDoneByWorker) {
    const verify = verifyBySource.get(sourceId);
    // Cleanup target: verify missing OR cancelled. (verify=done is shape A,
    // verify=queued/running means a review is still pending — leave alone.)
    const isCleanupCandidate =
      !verify || verify.status === 'cancelled';
    if (!isCleanupCandidate) continue;

    // Age gate — only touch items older than the stale threshold so we
    // don't race active work.
    const createdMs = source.createdAt ? Date.parse(source.createdAt) : nowMs;
    const ageMs = nowMs - createdMs;
    if (ageMs < STALE_THRESHOLD_MS) continue;

    stalePairs.push({ source, verify, ageH: Math.round(ageMs / 3_600_000) });
  }

  console.log(
    `\nStale pairs (done_by_worker >${STALE_THRESHOLD_MS / 3_600_000}h, verify cancelled/missing): ${stalePairs.length}`,
  );
  for (const { source, verify, ageH } of stalePairs) {
    const title = (source.title ?? '').slice(0, 60);
    const verifyStatus = verify ? verify.status : '<no verify WI>';
    console.log(`  ${ageH}h  verify=${verifyStatus}  ${source.id}  ${title}`);
  }

  if (stalePairs.length === 0) {
    console.log('\nNothing to clean up.');
    return 0;
  }

  if (!apply) {
    console.log('\n(dry-run — re-run with --stale-cleanup --apply to mark as cancelled)');
    return 0;
  }

  const now = new Date().toISOString();
  for (const { source, verify } of stalePairs) {
    source.status = 'cancelled';
    const reason = verify
      ? `Backfill: verify WI cancelled (id=${verify.id}), source abandoned pre-PR#553`
      : 'Backfill: verify WI never created, source abandoned pre-PR#553';
    (source as WorkItem & { cancelReason?: string }).cancelReason = reason;
    // Note: matches the historical convention — cancelled WIs do NOT carry
    // completedAt (see task-pool.service.ts:1751). Leave any prior
    // completedAt as-is (rare on done_by_worker but harmless if present).
  }
  data.lastUpdatedAt = now;
  await writePool(data);

  console.log(`\nDone: ${stalePairs.length} sources marked as cancelled.`);
  console.log(`Restart the service to pick up the change:`);
  console.log(`  crewly service start`);
  return 0;
}

async function writePool(data: PoolData): Promise<void> {
  const tmpPath = `${POOL_PATH}.backfill.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await rename(tmpPath, POOL_PATH);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(2);
  });
