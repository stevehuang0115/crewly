/**
 * Tracks consecutive failed harness wakes per agent session and decides when
 * the reconciler should restart the session (CREW-150).
 *
 * Only REAL failures count. A wake the provider turned away on purpose
 * (redeliver backoff, approval-gate refusal, memory-pressure skip) is
 * `'skipped'` and neither counts nor resets the streak. A delivered wake
 * resets it.
 *
 * @module services/reconciler/wake-failure-tracker
 */

/** Result of one wake attempt as seen by the tracker. */
export type WakeAttemptOutcome = 'ok' | 'failed' | 'skipped';

/** What the reconciler should do after recording an attempt. */
export type WakeFailureDecision =
  | { action: 'none' }
  | { action: 'restart'; failures: number };

/**
 * Parses a positive integer env override, falling back to the default.
 *
 * @param name - Environment variable name
 * @param fallback - Value used when unset or invalid
 * @returns The configured value
 */
function positiveEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** Consecutive failed wakes before a restart. Override: CREWLY_WAKE_FAILURES_BEFORE_RESTART. */
export const WAKE_FAILURES_BEFORE_RESTART = positiveEnv('CREWLY_WAKE_FAILURES_BEFORE_RESTART', 3);

/** Minimum gap between auto-restarts of one session (30 min). Override: CREWLY_WAKE_RESTART_COOLDOWN_MS. */
export const WAKE_RESTART_COOLDOWN_MS = positiveEnv('CREWLY_WAKE_RESTART_COOLDOWN_MS', 30 * 60 * 1000);

/** Options for {@link WakeFailureTracker}. */
export interface WakeFailureTrackerOptions {
  /** Failures before a restart (default {@link WAKE_FAILURES_BEFORE_RESTART}) */
  threshold?: number;
  /** Cooldown between restarts in ms (default {@link WAKE_RESTART_COOLDOWN_MS}) */
  cooldownMs?: number;
  /** Clock, for tests */
  now?: () => number;
}

/**
 * Per-session consecutive-failure counter with a restart cooldown.
 */
export class WakeFailureTracker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly failures = new Map<string, number>();
  private readonly lastRestartAt = new Map<string, number>();
  /** Sessions whose last auto-restart failed: no more auto-restarts until a wake is delivered. */
  private readonly restartFailed = new Set<string>();

  /**
   * @param options - Threshold, cooldown and clock overrides
   */
  constructor(options: WakeFailureTrackerOptions = {}) {
    this.threshold = options.threshold ?? WAKE_FAILURES_BEFORE_RESTART;
    this.cooldownMs = options.cooldownMs ?? WAKE_RESTART_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Marks the last auto-restart of a session as failed, which stops further
   * auto-restarts of it until a wake to it is delivered (`'ok'`).
   *
   * @param session - Agent session name
   */
  markRestartFailed(session: string): void {
    this.restartFailed.add(session);
  }

  /**
   * Records one wake attempt and returns what to do.
   *
   * A restart is requested when the streak reaches the threshold and the
   * session was not restarted within the cooldown. The streak resets on a
   * restart request, so a failed restart is not retried until the cooldown
   * has passed AND the threshold is reached again.
   *
   * @param session - Agent session name
   * @param outcome - Result of the wake attempt
   * @returns The decision for this attempt
   */
  record(session: string, outcome: WakeAttemptOutcome): WakeFailureDecision {
    if (outcome === 'skipped') return { action: 'none' };
    if (outcome === 'ok') {
      this.failures.delete(session);
      this.restartFailed.delete(session);
      return { action: 'none' };
    }
    const count = (this.failures.get(session) ?? 0) + 1;
    this.failures.set(session, count);
    if (count < this.threshold) return { action: 'none' };
    // A failed restart is final until a wake is delivered (AC2: no restart loops).
    if (this.restartFailed.has(session)) return { action: 'none' };

    const last = this.lastRestartAt.get(session);
    if (last !== undefined && this.now() - last < this.cooldownMs) {
      return { action: 'none' };
    }
    this.lastRestartAt.set(session, this.now());
    this.failures.delete(session);
    return { action: 'restart', failures: count };
  }
}

/**
 * Result of an automatic restart: it worked, it was not attempted or failed
 * before the stop (the agent is still running as before), or the stop worked
 * and the start did not (the agent is now STOPPED).
 */
export type RestartOutcome = 'restarted' | 'not_restarted' | 'stopped_not_started';

/**
 * Builds the single message the team leader gets after an auto-restart.
 *
 * @param session - Agent session
 * @param failures - Consecutive failed wakes that triggered it
 * @param outcome - What the restart did
 * @returns The notice text
 */
export function formatWakeRestartNotice(session: string, failures: number, outcome: RestartOutcome): string {
  const head = `[RECONCILER] ${session}: ${failures} consecutive wakes failed.`;
  if (outcome === 'restarted') return `${head} The session was restarted automatically and the restart worked.`;
  if (outcome === 'stopped_not_started') {
    return `${head} An automatic restart stopped the session but could NOT start it again: the agent is now STOPPED. No more auto-restarts for it; please start it by hand.`;
  }
  return `${head} An automatic restart was attempted and FAILED before stopping: the agent is still running as before. No further auto-restart until a wake to it is delivered; please restart it by hand if it is stuck.`;
}
