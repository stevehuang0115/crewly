/**
 * Daily spot check of verified work (crewly#1315).
 *
 * Once a WorkItem is `verified`, nothing looked at it again: the evidence
 * check only confirmed an artifact existed at completion time. This service
 * samples a few verified items from the last day and re-checks that every
 * artifact they named still exists. It never mutates a WorkItem.
 *
 * - Runs once per local day (state file under CREWLY_HOME remembers the day
 *   and the result, so a restart does not re-run or re-report it).
 * - The result is one line, "N re-checked, M discrepancies", in the evening
 *   ticket digest the owner already reads — zero is stated, not omitted.
 * - A discrepancy also goes to the owner at once through the owner-alert
 *   notifier, with the WorkItem id and the missing artifact.
 *
 * Phase 1: artifacts only. Re-running `command` entries marked replayable is
 * a later phase.
 *
 * @module services/task-pool/verified-spot-check.service
 */
import { VERIFIED_SPOT_CHECK_CONSTANTS } from '../../constants.js';
import type { ComponentLogger } from '../core/logger.service.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { validateCompletionEvidence } from '../../types/v2/completion-evidence.types.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import { localDateKey } from '../project-tickets/ticket-autopilot-decision.js';
import { recheckArtifacts, type ArtifactDiscrepancy } from './completion-evidence.service.js';

const C = VERIFIED_SPOT_CHECK_CONSTANTS;

/** One sampled WorkItem whose artifact is no longer where it was. */
export interface SpotCheckDiscrepancy extends ArtifactDiscrepancy {
  workItemId: string;
  title: string;
}

/** The outcome of one run. */
export interface SpotCheckResult {
  /** When the run happened (ISO) */
  at: string;
  /** Verified items completed within the window that named an artifact */
  candidates: number;
  /** How many of them were re-checked */
  sampled: number;
  discrepancies: SpotCheckDiscrepancy[];
}

/** Persisted between runs. */
interface SpotCheckState {
  /** Local day of the last run (YYYY-MM-DD) */
  lastRunDate?: string;
  lastResult?: SpotCheckResult;
}

/** Hooks the service needs; tests pass fakes. */
export interface VerifiedSpotCheckDeps {
  /** Every WorkItem in the pool */
  getItems: () => Promise<WorkItem[]>;
  /** One plain notice to the owner; resolves true when delivered */
  notifyOwner: (notice: { title: string; message: string; urgent: boolean }) => Promise<boolean>;
  /** State file (under CREWLY_HOME) */
  stateFile: string;
  /** Re-check one WorkItem's artifacts (defaults to the evidence service's check) */
  recheck?: (workItem: WorkItem) => Promise<ArtifactDiscrepancy[]>;
  now?: () => Date;
  logger?: ComponentLogger;
}

/**
 * Whether a WorkItem is a candidate: verified, completed within the window,
 * and naming at least one artifact in its evidence.
 *
 * @param wi - The WorkItem
 * @param nowMs - Clock
 * @param windowMs - How far back a completion may be
 * @returns True for a candidate
 */
export function isSpotCheckCandidate(wi: WorkItem, nowMs: number, windowMs: number): boolean {
  if (wi.status !== 'verified') return false;
  const completed = Date.parse(wi.completedAt ?? '');
  if (Number.isNaN(completed) || nowMs - completed > windowMs || completed > nowMs) return false;
  const v = validateCompletionEvidence(wi.output?.['evidence']);
  return v.ok && v.evidence.some((e) => e.type === 'artifact');
}

/**
 * Pick the items to re-check: all candidates when there are few, otherwise
 * an even spread over the window (newest first) so one busy hour does not
 * take every slot. Deterministic — the same pool gives the same sample.
 *
 * @param items - The pool
 * @param nowMs - Clock
 * @param options - Window and sample size
 * @returns The candidates and the sample drawn from them
 */
export function sampleVerified(
  items: readonly WorkItem[],
  nowMs: number,
  options: { windowMs: number; sampleSize: number } = { windowMs: C.WINDOW_MS, sampleSize: C.SAMPLE_SIZE },
): { candidates: WorkItem[]; sample: WorkItem[] } {
  const candidates = items
    .filter((wi) => isSpotCheckCandidate(wi, nowMs, options.windowMs))
    .sort((a, b) => Date.parse(b.completedAt ?? '') - Date.parse(a.completedAt ?? '') || a.id.localeCompare(b.id));
  if (candidates.length <= options.sampleSize || options.sampleSize <= 0) {
    return { candidates, sample: options.sampleSize <= 0 ? [] : candidates };
  }
  const step = candidates.length / options.sampleSize;
  const sample: WorkItem[] = [];
  for (let i = 0; i < options.sampleSize; i++) {
    const wi = candidates[Math.floor(i * step)];
    if (wi) sample.push(wi);
  }
  return { candidates, sample };
}

/**
 * The one line the owner reads, with the discrepancies listed under it when
 * there are any. Zero is stated.
 *
 * @param result - A run's result
 * @returns Markdown lines
 */
export function spotCheckLine(result: SpotCheckResult): string {
  const n = result.discrepancies.length;
  const head = `Spot check: ${result.sampled} verified item(s) from the last day re-checked, ${n} discrepanc${n === 1 ? 'y' : 'ies'}`;
  if (n === 0) return head;
  const rows = result.discrepancies
    .slice(0, C.MAX_LISTED_DISCREPANCIES)
    .map((d) => `- ${d.workItemId} "${d.title.slice(0, C.TITLE_MAX_CHARS)}": ${d.problem}`);
  if (n > rows.length) rows.push(`- … and ${n - rows.length} more`);
  return [head, ...rows].join('\n');
}

/**
 * Re-check a sample of verified WorkItems. Pure apart from the file checks
 * `recheck` performs.
 *
 * @param items - The pool
 * @param now - Clock
 * @param recheck - Re-checks one WorkItem's artifacts
 * @param options - Window and sample size
 * @returns The run's result
 */
export async function runSpotCheck(
  items: readonly WorkItem[],
  now: Date,
  recheck: (workItem: WorkItem) => Promise<ArtifactDiscrepancy[]>,
  options: { windowMs: number; sampleSize: number } = { windowMs: C.WINDOW_MS, sampleSize: C.SAMPLE_SIZE },
): Promise<SpotCheckResult> {
  const { candidates, sample } = sampleVerified(items, now.getTime(), options);
  const discrepancies: SpotCheckDiscrepancy[] = [];
  for (const wi of sample) {
    const problems = await recheck(wi).catch((err: unknown) => [
      { artifact: '(all)', problem: `re-check failed: ${err instanceof Error ? err.message : String(err)}` },
    ]);
    for (const p of problems) discrepancies.push({ workItemId: wi.id, title: wi.title ?? '', ...p });
  }
  return { at: now.toISOString(), candidates: candidates.length, sampled: sample.length, discrepancies };
}

/**
 * Runs the spot check once a day and keeps the latest result for the digest.
 */
export class VerifiedSpotCheckService {
  private static instance: VerifiedSpotCheckService | null = null;

  private readonly deps: VerifiedSpotCheckDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private state: SpotCheckState | null = null;
  private running: Promise<SpotCheckResult | null> | null = null;

  /**
   * @param deps - Hooks
   */
  constructor(deps: VerifiedSpotCheckDeps) {
    this.deps = deps;
  }

  /** @returns The process-wide instance, if one was set */
  static getInstance(): VerifiedSpotCheckService | null {
    return VerifiedSpotCheckService.instance;
  }

  /**
   * Set (or clear) the process-wide instance.
   *
   * @param service - The instance
   */
  static setInstance(service: VerifiedSpotCheckService | null): void {
    VerifiedSpotCheckService.instance = service;
  }

  /**
   * Start the daily loop: a first check after the boot delay, then every
   * {@link VERIFIED_SPOT_CHECK_CONSTANTS.CHECK_INTERVAL_MS} it asks whether
   * today's run is still owed.
   */
  start(): void {
    if (this.timer) return;
    this.bootTimer = setTimeout(() => void this.runIfDue(), C.BOOT_DELAY_MS);
    this.timer = setInterval(() => void this.runIfDue(), C.CHECK_INTERVAL_MS);
  }

  /** Stop the loop. */
  stop(): void {
    if (this.bootTimer) clearTimeout(this.bootTimer);
    if (this.timer) clearInterval(this.timer);
    this.bootTimer = null;
    this.timer = null;
  }

  /**
   * Run today's check unless it already ran today.
   *
   * @returns The result, or null when today's run was already done
   */
  async runIfDue(): Promise<SpotCheckResult | null> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        const state = await this.loadState();
        const today = localDateKey(this.now());
        if (state.lastRunDate === today) return null;
        return await this.runOnce();
      } catch (err) {
        this.deps.logger?.warn('Verified spot check failed', { error: err instanceof Error ? err.message : String(err) });
        return null;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /**
   * Run the check now, record it as today's run, and tell the owner about
   * any discrepancy.
   *
   * @returns The result
   */
  async runOnce(): Promise<SpotCheckResult> {
    const now = this.now();
    const items = await this.deps.getItems();
    const result = await runSpotCheck(items, now, this.deps.recheck ?? ((wi) => recheckArtifacts(wi)));
    const state = await this.loadState();
    state.lastRunDate = localDateKey(now);
    state.lastResult = result;
    await this.saveState();
    this.deps.logger?.info('Verified spot check ran', {
      candidates: result.candidates,
      sampled: result.sampled,
      discrepancies: result.discrepancies.length,
    });
    if (result.discrepancies.length > 0) {
      await this.deps.notifyOwner({ title: C.OWNER_ALERT_TITLE, message: spotCheckLine(result), urgent: false }).catch(() => false);
    }
    return result;
  }

  /** @returns The latest result, or null before the first run */
  async latest(): Promise<SpotCheckResult | null> {
    return (await this.loadState()).lastResult ?? null;
  }

  /**
   * The digest line for a given day: today's result as one line, or null
   * when no run happened that day (the digest then says nothing about it).
   *
   * @param now - Clock
   * @returns The line, or null
   */
  async digestLine(now: Date): Promise<string | null> {
    const state = await this.loadState();
    if (!state.lastResult || state.lastRunDate !== localDateKey(now)) return null;
    return spotCheckLine(state.lastResult);
  }

  /** @returns The clock */
  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** @returns The state, read once */
  private async loadState(): Promise<SpotCheckState> {
    if (this.state) return this.state;
    const raw = await safeReadJson<SpotCheckState>(this.deps.stateFile, {});
    this.state = {
      ...(typeof raw.lastRunDate === 'string' ? { lastRunDate: raw.lastRunDate } : {}),
      ...(raw.lastResult && typeof raw.lastResult === 'object' ? { lastResult: raw.lastResult } : {}),
    };
    return this.state;
  }

  /** Persist the state; a failure is logged, never thrown. */
  private async saveState(): Promise<void> {
    if (!this.state) return;
    try {
      await atomicWriteJson(this.deps.stateFile, this.state);
    } catch (err) {
      this.deps.logger?.warn('Could not save verified spot check state', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
