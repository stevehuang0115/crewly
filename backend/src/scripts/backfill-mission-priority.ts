/**
 * Backfill Mission Priority
 *
 * Scans `<cwd>/.crewly/missions/*.json` and writes `priority: 'medium'`
 * onto any mission file that is missing the field. Idempotent:
 * files that already have a priority are untouched.
 *
 * Usage (manual):
 * ```sh
 * npx tsx backend/src/scripts/backfill-mission-priority.ts
 * ```
 *
 * The default priority (`medium`) is a deliberate neutral fallback — callers
 * that care can update individual missions afterwards through the API.
 *
 * @module scripts/backfill-mission-priority
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import type { Mission, MissionPriority } from '../types/v2/mission.types.js';
import { atomicWriteJson } from '../utils/file-io.utils.js';

/** Default priority assigned when a mission is missing the field. */
export const BACKFILL_DEFAULT_PRIORITY: MissionPriority = 'medium';

/** Result returned by {@link backfillMissionPriority} for observability. */
export interface BackfillResult {
  /** Total mission files inspected (includes files that failed to parse). */
  scanned: number;
  /** Mission files that were rewritten with a priority. */
  updated: string[];
  /** Mission files that already had a priority and were left alone. */
  skipped: string[];
  /** File paths that failed to parse or were missing a valid `id`. */
  failed: string[];
}

/**
 * Runs the backfill against the given missions directory.
 *
 * @param missionsDir - Absolute path to `.crewly/missions`
 * @returns Counts and the list of touched mission IDs
 *
 * @example
 * ```ts
 * const result = await backfillMissionPriority('/project/.crewly/missions');
 * console.log(`Updated ${result.updated.length} missions`);
 * ```
 */
export async function backfillMissionPriority(missionsDir: string): Promise<BackfillResult> {
  const result: BackfillResult = { scanned: 0, updated: [], skipped: [], failed: [] };

  let entries: string[] = [];
  try {
    entries = (await fs.readdir(missionsDir)).filter(f => f.endsWith('.json'));
  } catch {
    return result;
  }

  for (const file of entries) {
    const fullPath = path.join(missionsDir, file);
    result.scanned += 1;

    let mission: Mission;
    try {
      const raw = await fs.readFile(fullPath, 'utf-8');
      mission = JSON.parse(raw) as Mission;
    } catch {
      result.failed.push(fullPath);
      continue;
    }

    if (!mission.id || typeof mission.id !== 'string') {
      // Valid JSON but no usable id — track so the caller can investigate.
      result.failed.push(fullPath);
      continue;
    }

    if (mission.priority) {
      result.skipped.push(mission.id);
      continue;
    }

    const patched: Mission = { ...mission, priority: BACKFILL_DEFAULT_PRIORITY };
    // atomicWriteJson writes to a tmp file and renames — crash-safe.
    await atomicWriteJson(fullPath, patched);
    result.updated.push(mission.id);
  }

  return result;
}

/**
 * CLI entry point — resolves the missions directory relative to CWD
 * and logs a summary. Safe to invoke repeatedly.
 */
async function main(): Promise<void> {
  const missionsDir = path.join(process.cwd(), '.crewly', 'missions');
  const result = await backfillMissionPriority(missionsDir);
  // eslint-disable-next-line no-console
  console.log(
    `[backfill] scanned=${result.scanned} updated=${result.updated.length} skipped=${result.skipped.length} failed=${result.failed.length}`,
  );
  if (result.updated.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[backfill] updated ids: ${result.updated.join(', ')}`);
  }
  if (result.failed.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[backfill] failed to process: ${result.failed.join(', ')}`);
  }
}

// Execute only when run directly (not when imported by tests).
const isDirectRun =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  process.argv[1].endsWith('backfill-mission-priority.ts');

if (isDirectRun) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[backfill] failed:', err);
    process.exitCode = 1;
  });
}
