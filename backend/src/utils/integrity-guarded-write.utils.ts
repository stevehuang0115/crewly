/**
 * Integrity-Guarded Atomic Write Utilities
 *
 * Wraps {@link atomicWriteJson} with a write-time integrity invariant
 * (a "decrease-guard"): rejects suspicious writes that would persist a
 * collection that has shrunk too aggressively versus the on-disk state.
 *
 * **Why this exists**
 *
 * On 2026-05-03, a backend restart corrupted `~/.crewly/teams.json` and
 * every per-project `teams/{id}/config.json` to `teams: []`. Atomic writes
 * already covered the *transactional* side of the persistence layer, but
 * the gap was at the *semantic* level — any code path that emitted
 * `teams: []` (whether via race during shutdown, destructive migration, or
 * cache nuke + flush) would happily atomic-write the empty state and
 * overwrite the single-snapshot backup as well.
 *
 * This utility closes that gap by reading the existing on-disk count
 * before every aggregate write and aborting if the count would drop from
 * N>0 to 0 (or by an unacceptable percentage) without explicit operator
 * intent. Callers who legitimately want to clear a collection pass
 * `allowExplicitDelete: true`.
 *
 * **Design contract**
 *
 * - **Failure mode**: integrity violations throw {@link IntegrityViolationError}
 *   so the failure surfaces loudly instead of being silently swallowed.
 *   Callers that prefer "log + continue" semantics should wrap with their
 *   own try/catch.
 * - **First-ever write** (no prior file) is always allowed — `prevCount = 0`,
 *   no decrease.
 * - **Read failure**: if the prior file exists but cannot be read or parsed,
 *   the guard treats `prevCount` as `null` and proceeds with the write
 *   (a corrupted prior file should not block recovery).
 *
 * @module utils/integrity-guarded-write.utils
 */

import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { atomicWriteJson } from './file-io.utils.js';
import { LoggerService, type ComponentLogger } from '../services/core/logger.service.js';

/**
 * Default maximum decrease percentage (compared to prior on-disk count)
 * tolerated before the guard rejects a write.
 *
 * 50% means: if prior had N items, next must have at least ceil(N/2) items
 * unless `allowExplicitDelete: true` is set.
 */
const DEFAULT_MAX_DECREASE_PCT = 50;

/**
 * Logger lazily acquired so this module can be imported by tests that
 * mock the logger service before initialization.
 */
let logger: ComponentLogger | null = null;
function getLogger(): ComponentLogger {
  if (!logger) {
    logger = LoggerService.getInstance().createComponentLogger('IntegrityGuardedWrite');
  }
  return logger;
}

/**
 * Thrown when a guarded write is rejected because it would shrink the
 * persisted collection past the decrease threshold without explicit
 * operator opt-in.
 *
 * Carries diagnostic metadata (path, prevCount, nextCount, reason) for
 * structured logging and debugging.
 */
export class IntegrityViolationError extends Error {
  /** Absolute path of the file the rejected write targeted */
  readonly path: string;
  /** Item count read from the prior on-disk state */
  readonly prevCount: number;
  /** Item count of the rejected next state */
  readonly nextCount: number;
  /** Machine-readable reason code */
  readonly reason: 'collapse-to-empty' | 'decrease-exceeds-threshold';

  /**
   * @param message - Human-readable error message
   * @param details - Diagnostic metadata
   */
  constructor(
    message: string,
    details: { path: string; prevCount: number; nextCount: number; reason: IntegrityViolationError['reason'] },
  ) {
    super(message);
    this.name = 'IntegrityViolationError';
    this.path = details.path;
    this.prevCount = details.prevCount;
    this.nextCount = details.nextCount;
    this.reason = details.reason;
  }
}

/**
 * Options for {@link atomicWriteJsonWithGuard}.
 */
export interface IntegrityGuardOptions<T> {
  /**
   * Function that extracts the "item count" from a value (parsed prior
   * state or proposed next state). Defaults to `(d) => Array.isArray(d) ? d.length : 0`,
   * suitable for plain array-shaped collections.
   */
  countOf?: (data: T) => number;
  /**
   * Maximum allowed decrease as a percentage of the prior count.
   * Default 50 — i.e., next count must be ≥ ceil(prevCount / 2).
   * Pass 100 to allow any decrease (effectively only the
   * collapse-to-empty branch fires).
   */
  maxDecreasePct?: number;
  /**
   * If true, bypass the decrease and collapse-to-empty guards. Use this
   * for legitimate "clear all" or "delete N" operations where the caller
   * has confirmed operator intent.
   */
  allowExplicitDelete?: boolean;
}

/**
 * Atomically write a JSON file, rejecting writes that would shrink an
 * existing collection past the decrease threshold without explicit opt-in.
 *
 * **Behavior**:
 * 1. If the destination file does not exist → first-ever write → proceed.
 * 2. If the prior file exists but cannot be read/parsed → log warning,
 *    proceed (corrupted prior should not block recovery).
 * 3. If `prevCount > 0 && nextCount === 0 && !allowExplicitDelete`
 *    → throw {@link IntegrityViolationError} with `reason: 'collapse-to-empty'`.
 * 4. If `nextCount < prevCount * (1 - maxDecreasePct/100) && !allowExplicitDelete`
 *    → throw {@link IntegrityViolationError} with `reason: 'decrease-exceeds-threshold'`.
 * 5. Otherwise → call {@link atomicWriteJson}.
 *
 * @param filePath - Destination JSON file path
 * @param next - Value to serialize and write
 * @param opts - Guard configuration
 * @throws {IntegrityViolationError} if the guard rejects the write
 * @throws The underlying fs error if the atomic write itself fails
 *
 * @example
 * ```typescript
 * await atomicWriteJsonWithGuard(teamsPath, teams, {
 *   countOf: (t) => t.length,
 *   maxDecreasePct: 50,
 * });
 * ```
 */
export async function atomicWriteJsonWithGuard<T>(
  filePath: string,
  next: T,
  opts: IntegrityGuardOptions<T> = {},
): Promise<void> {
  const countOf = opts.countOf ?? defaultCountOf;
  const maxDecreasePct = opts.maxDecreasePct ?? DEFAULT_MAX_DECREASE_PCT;
  const allowExplicitDelete = opts.allowExplicitDelete ?? false;

  const nextCount = countOf(next);
  const prevCount = await readPriorCount(filePath, countOf);

  if (prevCount === null) {
    // No prior file or unreadable — proceed without guard.
    await atomicWriteJson(filePath, next);
    return;
  }

  if (!allowExplicitDelete) {
    // Branch 3: collapse-to-empty
    if (prevCount > 0 && nextCount === 0) {
      const message =
        `Refusing to write empty collection: prior had ${prevCount} item(s), next would have 0. ` +
        `If this is intentional, pass allowExplicitDelete: true. Path: ${filePath}`;
      getLogger().error('integrity:write-rejected', {
        path: filePath,
        prevCount,
        nextCount,
        reason: 'collapse-to-empty',
        stack: new Error('decrease-guard trace').stack,
      });
      throw new IntegrityViolationError(message, {
        path: filePath,
        prevCount,
        nextCount,
        reason: 'collapse-to-empty',
      });
    }

    // Branch 4: decrease exceeds threshold
    if (prevCount > 0 && maxDecreasePct < 100) {
      const minAllowed = Math.ceil(prevCount * (1 - maxDecreasePct / 100));
      if (nextCount < minAllowed) {
        const message =
          `Refusing to write shrunken collection: prior had ${prevCount} item(s), next would have ` +
          `${nextCount} (below ${maxDecreasePct}%-decrease threshold of ${minAllowed}). ` +
          `If this is intentional, pass allowExplicitDelete: true. Path: ${filePath}`;
        getLogger().error('integrity:write-rejected', {
          path: filePath,
          prevCount,
          nextCount,
          maxDecreasePct,
          minAllowed,
          reason: 'decrease-exceeds-threshold',
          stack: new Error('decrease-guard trace').stack,
        });
        throw new IntegrityViolationError(message, {
          path: filePath,
          prevCount,
          nextCount,
          reason: 'decrease-exceeds-threshold',
        });
      }
    }
  }

  // Guard passed (or bypassed). Proceed with the atomic write.
  await atomicWriteJson(filePath, next);
}

/**
 * Default countOf implementation: returns array length, or 0 for non-arrays.
 *
 * @param data - Parsed prior state or proposed next state
 * @returns Item count
 */
function defaultCountOf<T>(data: T): number {
  return Array.isArray(data) ? data.length : 0;
}

/**
 * Read the prior on-disk JSON file and apply countOf.
 *
 * @param filePath - File to read
 * @param countOf - Counter function
 * @returns The prior count, or null if the file does not exist or cannot be parsed
 */
async function readPriorCount<T>(filePath: string, countOf: (d: T) => number): Promise<number | null> {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as T;
    return countOf(parsed);
  } catch (error) {
    getLogger().warn('integrity:prior-read-failed', {
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
