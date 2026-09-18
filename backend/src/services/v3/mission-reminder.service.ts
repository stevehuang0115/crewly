/**
 * Mission Reminder Service
 *
 * Scans active Missions and sends proactive Slack reminders to KR owners
 * if their metrics are 'off_track' or 'at_risk'.
 *
 * Features:
 * - Periodic sweep of all active missions
 * - KR-level status evaluation via KRTrackingService
 * - Intelligent owner resolution (Mission owner -> Team Lead)
 * - Proactive Slack delivery via SlackOrchestratorBridge
 * - Rate limiting to prevent reminder fatigue (lastReminderAt tracking)
 *
 * @module services/v3/mission-reminder.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { getMissionsDir } from './mission-paths.js';
import { CronExpressionParser } from 'cron-parser';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { StorageService } from '../core/storage.service.js';
import { KRTrackingService } from './kr-tracking.service.js';
import { OKRReviewService } from './okr-review.service.js';
import { MissionPeriodService } from './mission-period.service.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';
import { getSlackOrchestratorBridge } from '../slack/slack-orchestrator-bridge.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { isMissionExecutable, type Mission } from '../../types/v2/mission.types.js';
import type { KeyResult, MissionOKRSummary, OKRReviewResult } from '../../types/v2/key-result.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { SLA_TERMINAL_WORK_ITEM_STATUSES } from '../../types/v2/work-item.types.js';
import { atomicWriteJson } from '../../utils/file-io.utils.js';
import { pickTeamLead } from '../../utils/team.utils.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import type { ReviewReason } from '../../types/review-reason.types.js';

// Re-export so existing import paths
// (`from '.../mission-reminder.service'`) keep working unchanged. The
// canonical declaration moved to `types/review-reason.types.ts` once
// BRIDGE-1 became a second producer of review WorkItems and needed to
// add `max_retries_exceeded` / `task_blocked` to the vocabulary.
export type { ReviewReason };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum interval between reminders for the same mission (24 hours) */
const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Consecutive sweeps a mission must show no active WorkItem AND no fresh
 * KR measurement before it is flagged stale (`mission:stale` published,
 * `staleCycles` bumped). Two sweeps ≈ two hours on the production timer.
 */
const STALE_SWEEP_THRESHOLD = 2;

/** Bounded size of the per-day `mission:stale` publish dedup set. */
const STALE_DEDUP_CAPACITY = 1000;

/**
 * Statuses that *clear* a Mission's `pendingReviewWorkItemId` so the next
 * sweep tick can fire a new review. Aliases the canonical
 * {@link SLA_TERMINAL_WORK_ITEM_STATUSES} (work-item.types.ts) per Arch's
 * N2 hoist on PR #357 — single source of truth for the broader 5-element
 * "exited active queue" set previously redeclared inline.
 *
 * Members (`done`, `verified`, `cancelled`, `failed`, `rejected`) cover both
 * the strict-terminal set and the SLA-terminal additions:
 *
 * - `done` / `verified` / `cancelled` — strictly terminal in the state
 *   machine sense.
 * - `failed`: a failed review WI has terminated execution; not blocking
 *   next cadence.
 * - `rejected`: a TL-rejected review WI has likewise exited the queue.
 *   Without this, a single TL rejection would silently freeze the mission's
 *   reentrancy lock forever — exactly the V8 failure mode this lock exists
 *   to prevent (Arch N1 BLOCKING fix on PR #354).
 *
 * The reentrancy lock is sweep-time lazy: we don't subscribe to TRANS-1
 * events here, we just observe the WorkItem's current state on each sweep
 * and clear the lock when it's in any of the SLA-terminal states.
 */
const PENDING_REVIEW_TERMINAL_STATUSES: ReadonlySet<string> =
  SLA_TERMINAL_WORK_ITEM_STATUSES;

/**
 * Default timezone used when a mission's `policy.executionCadence.workHours`
 * does not specify one. UTC keeps the dedup key globally consistent across
 * deployments — overriding to a local TZ would only matter if we surfaced
 * the cycleId to humans.
 */
const DEFAULT_REVIEW_TIMEZONE = 'UTC';

/**
 * Whether to create a `type: 'review'` WorkItem on every cadence boundary
 * in addition to the existing Slack reminder. Controlled by env so ops
 * can turn the loop off independently of the reminder DM if a downstream
 * pipeline (BRIDGE-1, LEARN-1) regresses.
 *
 * Env:
 *   `CREWLY_REVIEW_WI_ENABLED=false` — disables review WI creation
 *   anything else (or unset) — review WI creation enabled (default)
 */
function isReviewWorkItemEnabled(): boolean {
  return process.env['CREWLY_REVIEW_WI_ENABLED'] !== 'false';
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Service for sending proactive reminders for off-track OKRs.
 */
export class MissionReminderService {
  private static instance: MissionReminderService | null = null;
  private readonly logger: ComponentLogger;
  private readonly storageService: StorageService;
  private readonly krTrackingService: KRTrackingService;
  /**
   * Cached TaskPoolService singleton (Arch NTH-4 on PR #354).
   * Resolved lazily on first access via {@link getTaskPool} and reused
   * across every sweep × mission call site for the lifetime of this
   * MissionReminderService instance. Tests that need to swap the
   * underlying TaskPool must call {@link resetInstance} to also discard
   * this cached reference.
   */
  private taskPool: TaskPoolService | null = null;

  /**
   * Counter of cron-parse failures observed across all sweeps (Arch NTH-3
   * on PR #354). Bumped each time {@link CronExpressionParser.parse}
   * throws on a mission's `reviewSchedule`. Exposed via
   * {@link cronParseFailureCount} for tests + (future) Prom metric.
   */
  private cronParseFailures = 0;

  /**
   * Optional EventBus for `mission:stale` publication. Wired from the
   * backend boot path via {@link setEventBusService}; when absent the
   * stale detection still bumps `staleCycles` but publishes nothing.
   */
  private eventBus: EventBusService | null = null;

  /**
   * Consecutive idle sweeps per mission (no active WI + no KR measurement
   * since the previous sweep). In-memory by design — a restart simply
   * restarts the count, and the per-day publish id keeps the downstream
   * review WI idempotent regardless.
   */
  private readonly idleSweeps = new Map<string, number>();

  /** Wall-clock of the previous sweep (for "measurement since last sweep"). */
  private lastSweepAt: Date | null = null;

  /** `<missionId>:stale:<YYYY-MM-DD>` ids already published (FIFO-bounded). */
  private readonly publishedStale: string[] = [];

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('MissionReminder');
    this.storageService = StorageService.getInstance();
    this.krTrackingService = KRTrackingService.getInstance();
  }

  /**
   * Total number of cron-parse failures observed since this service
   * instance was constructed. Read by tests (asserting the warn-log path
   * also bumps the counter) and intended as the source for a future
   * Prometheus gauge (sister F4 follow-up filed on the OKR Mission
   * Reminder spec).
   */
  public get cronParseFailureCount(): number {
    return this.cronParseFailures;
  }

  /**
   * Cached TaskPoolService accessor. Resolves the singleton on first call
   * and reuses it thereafter. Allows test harnesses to reset the cache
   * via {@link resetInstance}, which clears both the
   * MissionReminderService singleton and any private references it holds.
   */
  private getTaskPool(): TaskPoolService {
    if (!this.taskPool) {
      this.taskPool = TaskPoolService.getInstance();
    }
    return this.taskPool;
  }

  static getInstance(): MissionReminderService {
    if (!MissionReminderService.instance) {
      MissionReminderService.instance = new MissionReminderService();
    }
    return MissionReminderService.instance;
  }

  static resetInstance(): void {
    MissionReminderService.instance = null;
  }

  /**
   * Wire the EventBus used to publish `mission:stale`. Idempotent; pass
   * `null` to disable publication (tests / CLI).
   *
   * @param bus - The live EventBusService, or null
   */
  setEventBusService(bus: EventBusService | null): void {
    this.eventBus = bus;
  }

  /**
   * Run a full sweep of all active missions, sending Slack OKR reminders
   * AND (per REVIEW-1, Phase E pre-beta) creating cadence-driven review
   * WorkItems that wake the Team Lead.
   *
   * The two outputs are intentionally additive — the Slack DM keeps the
   * legacy 24h-cooldown path, and the review WorkItem is created when
   * the mission's `policy.executionCadence.reviewSchedule` cron has
   * fired since the last `lastReviewAt`. The DM and the WI may both
   * fire on the same sweep tick — one is a notification, the other is
   * a queue item the TL can act on. Idempotency is guaranteed by the
   * deterministic WorkItem id (`<missionId>:review:<cycleId>`) which
   * the existing `addToPool` dedup-by-id catches; reentrancy is
   * guaranteed by `mission.pendingReviewWorkItemId` (Arch Veto V8).
   *
   * @param force - If true, ignores the REMINDER_COOLDOWN_MS for the
   *   Slack DM path (does NOT bypass the review-WI cadence/lock — that
   *   would defeat the deterministic-id contract).
   * @returns Summary of actions taken
   */
  async runSweep(force: boolean = false): Promise<{
    checked: number;
    sent: number;
    skipped: number;
    reviewsCreated: number;
    reviewsSkipped: number;
    /** Cadence boundaries where the deterministic review said `continue` — no WI raised. */
    reviewsAutoContinued: number;
    /** Missions flagged stale this sweep (`mission:stale` published, staleCycles bumped). */
    staleFlagged: number;
  }> {
    const now = new Date();
    const previousSweepAt = this.lastSweepAt;
    this.lastSweepAt = now;

    // Period lifecycle first: a paused mission whose period just started
    // becomes active and is then picked up by loadAllActiveMissions below.
    await this.reconcilePeriods(now);

    const missions = await this.loadAllActiveMissions();
    const result = {
      checked: 0,
      sent: 0,
      skipped: 0,
      reviewsCreated: 0,
      reviewsSkipped: 0,
      reviewsAutoContinued: 0,
      staleFlagged: 0,
    };

    this.logger.info('Starting Mission OKR reminder sweep', { count: missions.length });

    // One pool read per sweep for the stale detector (not per mission).
    let poolItems: WorkItem[] | null = null;
    if (missions.length > 0) {
      try {
        poolItems = await this.getTaskPool().getAllItems();
      } catch (err) {
        this.logger.warn('Stale detection skipped — pool unavailable', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    for (const mission of missions) {
      result.checked++;

      // -------------------------------------------------------------------
      // Stale detection: no active WorkItem AND no KR measurement since the
      // previous sweep, for STALE_SWEEP_THRESHOLD consecutive sweeps.
      // -------------------------------------------------------------------
      if (poolItems) {
        try {
          const flagged = await this.detectStale(mission, poolItems, previousSweepAt, now);
          if (flagged) result.staleFlagged++;
        } catch (err) {
          this.logger.warn('Stale detection failed for mission', {
            missionId: mission.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      let summary: MissionOKRSummary | null = null;
      try {
        // Get OKR progress summary — needed for both the reminder DM
        // and the reviewReason inference on the review WorkItem.
        summary = await this.krTrackingService.computeMissionOKRProgress(mission.id);
      } catch (err) {
        this.logger.error('Failed to compute mission OKR progress', {
          missionId: mission.id,
          error: err instanceof Error ? err.message : String(err),
        });
        // Don't `continue` — the review-WI path doesn't strictly need
        // the summary (it falls back to `scheduled_review`). Slack
        // path will be skipped by the off-track/at-risk filter below.
      }

      // -------------------------------------------------------------------
      // Slack OKR reminder path (existing — 24h cooldown).
      // -------------------------------------------------------------------
      const reminderEligible =
        force || !mission.lastReminderAt ||
        now.getTime() - new Date(mission.lastReminderAt).getTime() >= REMINDER_COOLDOWN_MS;

      if (reminderEligible && summary && (summary.offTrack > 0 || summary.atRisk > 0)) {
        try {
          const sent = await this.sendReminder(mission, summary);
          if (sent) {
            result.sent++;
            mission.lastReminderAt = now.toISOString();
            await this.saveMission(mission);
          }
        } catch (err) {
          this.logger.error('Failed to send mission reminder', {
            missionId: mission.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else if (!reminderEligible) {
        result.skipped++;
      }

      // -------------------------------------------------------------------
      // REVIEW-1: cadence-driven review WorkItem creation.
      //
      // The DM above is a notification; this is a queue item the TL must
      // explicitly act on. Both can fire on the same sweep tick.
      // -------------------------------------------------------------------
      if (isReviewWorkItemEnabled()) {
        try {
          const created = await this.maybeCreateReviewWorkItem(mission, summary, now);
          if (created === 'created') result.reviewsCreated++;
          else if (created === 'skipped') result.reviewsSkipped++;
          else if (created === 'auto_continued') result.reviewsAutoContinued++;
        } catch (err) {
          this.logger.error('Failed to create mission review WorkItem', {
            missionId: mission.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    this.logger.info('Mission OKR reminder sweep complete', result);
    return result;
  }

  /**
   * Result of {@link maybeCreateReviewWorkItem} — `'created'` when a new
   * review WorkItem was added to the pool, `'skipped'` when the
   * reentrancy lock or cadence boundary blocked creation, `'noop'` when
   * the mission has no executionCadence configured (legacy missions),
   * `'auto_continued'` when the cadence boundary fired but the
   * deterministic OKR review recommended `continue` with no off-track KR
   * — the review is persisted on the mission and NO WorkItem is raised.
   */
  private async maybeCreateReviewWorkItem(
    mission: Mission,
    summary: MissionOKRSummary | null,
    now: Date,
  ): Promise<'created' | 'skipped' | 'noop' | 'auto_continued'> {
    const cadence = mission.policy?.executionCadence;
    if (!cadence?.reviewSchedule) return 'noop';

    const timezone = cadence.workHours?.timezone ?? DEFAULT_REVIEW_TIMEZONE;

    // -----------------------------------------------------------------
    // Reentrancy lock (Arch Veto V8).
    // Lazily clear the pending pointer when the previous review WI has
    // reached terminal status; otherwise short-circuit creation.
    //
    // NTH-2 (Arch on PR #354): defer the saveMission for the lock-clear
    // until we know whether a new review WI will be created in the same
    // sweep tick. If yes, both writes (clear + new id) collapse to one
    // saveMission at the end of the success path. If no (skipped /
    // noop), we still need to persist the cleared lock — handled in the
    // exit branches below.
    // -----------------------------------------------------------------
    let pendingLockCleared = false;
    if (mission.pendingReviewWorkItemId) {
      const pendingWI = await this.getTaskPool().findWorkItem(mission.pendingReviewWorkItemId);
      if (!pendingWI || PENDING_REVIEW_TERMINAL_STATUSES.has(pendingWI.status)) {
        // Pending WI is gone or terminal — clear in memory; persist on exit.
        mission.pendingReviewWorkItemId = undefined;
        pendingLockCleared = true;
      } else {
        return 'skipped';
      }
    }

    // -----------------------------------------------------------------
    // Cadence boundary check.
    // The most recent cron-tick <= now defines the current cycle. If
    // `lastReviewAt` is at or after that boundary, we already covered
    // this cycle and the next sweep tick will roll into the next one.
    // -----------------------------------------------------------------
    let boundary: Date;
    try {
      const interval = CronExpressionParser.parse(cadence.reviewSchedule, {
        currentDate: now,
        tz: timezone,
      });
      boundary = interval.prev().toDate();
    } catch (err) {
      // NTH-3 (Arch on PR #354): bump the cron-parse failure counter so
      // ops can see how often this fires + which missions are affected.
      // The warn-log already carried mission id + cron + error message.
      this.cronParseFailures += 1;
      this.logger.warn('Mission has unparseable review cadence cron — skipping review WI', {
        missionId: mission.id,
        reviewSchedule: cadence.reviewSchedule,
        error: err instanceof Error ? err.message : String(err),
        totalCronParseFailures: this.cronParseFailures,
      });
      // Persist the cleared reentrancy lock if we cleared it earlier in
      // this method but are now bailing out of WI creation — the
      // mission's in-memory state would otherwise leak the cleared
      // pointer to the next sweep without disk-backed durability.
      if (pendingLockCleared) {
        await this.saveMission(mission);
      }
      return 'noop';
    }

    if (mission.lastReviewAt) {
      const lastReview = new Date(mission.lastReviewAt);
      if (lastReview.getTime() >= boundary.getTime()) {
        // Already reviewed within the current cadence cycle.
        // NTH-2: persist any deferred lock-clear before bailing.
        if (pendingLockCleared) {
          await this.saveMission(mission);
        }
        return 'skipped';
      }
    }

    // -----------------------------------------------------------------
    // Cadence boundary fired. Run the deterministic OKR review FIRST
    // (aggregate → recommendation, no LLM) so the loop actually closes
    // on the clock instead of only when someone POSTs /okr-review.
    // `executeReview` persists lastReviewSummary / staleCycles /
    // lastReviewAt on disk; we fold those back into our in-memory copy
    // so the single saveMission below does not clobber them.
    // -----------------------------------------------------------------
    const review = await this.runDeterministicReview(mission);

    const cycleId = boundary.toISOString().slice(0, 10);
    const offTrack = (summary?.offTrack ?? 0) > 0 || (review?.okrSummary.offTrack ?? 0) > 0;

    if (review && review.recommendation === 'continue' && !offTrack) {
      // Healthy on the clock: nothing for the TL to decide. Persist the
      // bookkeeping (lastReviewAt from the review, any cleared lock) and
      // move on without waking anyone.
      mission.lastReviewAt = review.reviewedAt;
      await this.saveMission(mission);
      this.logger.info('Mission cadence review: continue — no review WorkItem raised', {
        missionId: mission.id,
        cycleId,
        progress: review.okrSummary.overallProgress,
        staleCycles: mission.staleCycles ?? 0,
      });
      return 'auto_continued';
    }

    // -----------------------------------------------------------------
    // Build the deterministic review WorkItem.
    //
    // The id collapses to the date-form of the boundary so a sweep
    // replay within the same cycle hits the existing addToPool
    // dedup-by-id guard (V1 satisfied without a TaskPoolService change).
    // -----------------------------------------------------------------
    const reviewWorkItemId = `${mission.id}:review:${cycleId}`;
    const reviewReason = this.inferReviewReason(mission, summary ?? review?.okrSummary ?? null);
    const target = await this.resolveTeamLeadSession(mission);
    const recommendationLine = review
      ? ` Recommendation: ${review.recommendation} (${review.action}) — ` +
        `progress ${review.okrSummary.overallProgress}%, ` +
        `${review.okrSummary.achieved}/${review.okrSummary.totalKRs} KRs achieved, ` +
        `${review.okrSummary.offTrack} off-track, ${review.okrSummary.atRisk} at-risk, ` +
        `staleCycles=${mission.staleCycles ?? 0}.`
      : '';

    const reviewWorkItem: WorkItem = {
      id: reviewWorkItemId,
      type: 'review',
      owner: 'team_lead',
      target,
      title: `Mission review — ${mission.objective.slice(0, 60)}${mission.objective.length > 60 ? '…' : ''}`,
      description: `Cadence-driven review for mission ${mission.id}. Reason: ${reviewReason}.${recommendationLine}`,
      status: 'queued',
      createdAt: now.toISOString(),
      retryCount: 0,
      maxRetries: 0, // V2 N/A for review WIs — no auto-retry policy
      missionId: mission.id,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      metadata: {
        idempotencyKey: reviewWorkItemId, // V1 — same as id, surfaces in audit logs
        requiresVerification: false,      // F-H — review WIs do NOT loop back to TL self-verify
        reviewReason,
        reviewCycleId: cycleId,
        cadenceSchedule: cadence.reviewSchedule,
        ...(review
          ? {
              recommendation: review.recommendation,
              reviewAction: review.action,
              okrProgress: review.okrSummary.overallProgress,
              okrOffTrack: review.okrSummary.offTrack,
              okrAtRisk: review.okrSummary.atRisk,
              staleCycles: mission.staleCycles ?? 0,
            }
          : {}),
      },
    };

    await this.getTaskPool().addToPool(reviewWorkItem);

    // Persist the reentrancy lock + bookkeeping fields.
    // NTH-2: this is the canonical single saveMission per sweep tick —
    // any earlier in-memory lock-clear collapses into this write.
    mission.pendingReviewWorkItemId = reviewWorkItemId;
    mission.lastReviewAt = now.toISOString();
    await this.saveMission(mission);

    this.logger.info('Mission review WorkItem created', {
      missionId: mission.id,
      workItemId: reviewWorkItemId,
      reviewReason,
      target,
      cycleId,
    });

    return 'created';
  }

  /**
   * Run {@link MissionPeriodService.reconcile} so period-bound missions
   * auto-activate / get flagged at period end. Previously nothing called
   * reconcile(), so periods never advanced on their own. Failure-soft.
   */
  private async reconcilePeriods(now: Date): Promise<void> {
    try {
      const outcome = await MissionPeriodService.getInstance().reconcile(now);
      if (outcome.activated.length > 0 || outcome.endOfPeriod.length > 0) {
        this.logger.info('Mission periods reconciled', outcome);
      }
    } catch (err) {
      this.logger.warn('Mission period reconcile failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Stale detector. A mission is "idle" this sweep when it has no
   * non-terminal WorkItem in the pool AND no KR measurement recorded since
   * the previous sweep. After {@link STALE_SWEEP_THRESHOLD} consecutive
   * idle sweeps the mission's `staleCycles` is bumped, persisted, and a
   * `mission:stale` event is published with the idempotent id
   * `<missionId>:stale:<YYYY-MM-DD>` (once per mission per UTC day). The
   * bridge turns that into a `no_active_work` review WorkItem.
   *
   * @returns `true` when the mission was flagged stale on this sweep
   */
  private async detectStale(
    mission: Mission,
    poolItems: WorkItem[],
    previousSweepAt: Date | null,
    now: Date,
  ): Promise<boolean> {
    const hasActiveWork = poolItems.some(
      (wi) => wi.missionId === mission.id && !SLA_TERMINAL_WORK_ITEM_STATUSES.has(wi.status),
    );
    const krs = await this.krTrackingService.listByMission(mission.id);
    const measuredSinceLastSweep =
      previousSweepAt !== null && this.hasMeasurementSince(krs, previousSweepAt);

    if (hasActiveWork || measuredSinceLastSweep) {
      this.idleSweeps.delete(mission.id);
      return false;
    }

    const idle = (this.idleSweeps.get(mission.id) ?? 0) + 1;
    this.idleSweeps.set(mission.id, idle);
    if (idle < STALE_SWEEP_THRESHOLD) return false;

    const day = now.toISOString().slice(0, 10);
    const eventId = `${mission.id}:stale:${day}`;
    if (this.publishedStale.includes(eventId)) return false;
    this.publishedStale.push(eventId);
    if (this.publishedStale.length > STALE_DEDUP_CAPACITY) this.publishedStale.shift();

    mission.staleCycles = (mission.staleCycles ?? 0) + 1;
    await this.saveMission(mission);

    if (this.eventBus) {
      this.eventBus.publish({
        id: eventId,
        type: 'mission:stale',
        timestamp: now.toISOString(),
        teamId: mission.ownerTeamId,
        teamName: '',
        memberId: '',
        memberName: '',
        sessionName: '',
        previousValue: String(mission.staleCycles - 1),
        newValue: String(mission.staleCycles),
        changedField: 'taskStatus',
        missionId: mission.id,
      });
    }

    this.logger.info('Mission flagged stale', {
      missionId: mission.id,
      idleSweeps: idle,
      staleCycles: mission.staleCycles,
      published: this.eventBus !== null,
    });
    return true;
  }

  /** Whether any KR carries a measurement taken at/after `since`. */
  private hasMeasurementSince(krs: KeyResult[], since: Date): boolean {
    const sinceMs = since.getTime();
    return krs.some((kr) =>
      (kr.measurements ?? []).some((m) => new Date(m.measuredAt).getTime() >= sinceMs),
    );
  }

  /**
   * Run {@link OKRReviewService.executeReview} for a mission at its cadence
   * boundary and fold the persisted bookkeeping (`lastReviewSummary`,
   * `staleCycles`, `lastReviewAt`) back into the caller's in-memory copy.
   *
   * Failure-soft: any error is logged and `null` is returned so the sweep
   * falls back to the legacy behaviour (create the review WI with an
   * inferred reason) rather than dropping the cadence tick.
   *
   * @param mission - In-memory mission (mutated with the persisted fields)
   * @returns The review result, or `null` if the review could not run
   */
  private async runDeterministicReview(mission: Mission): Promise<OKRReviewResult | null> {
    try {
      const review = await OKRReviewService.getInstance().executeReview(mission.id);
      const persisted = await this.loadMission(mission.id);
      if (persisted) {
        mission.lastReviewSummary = persisted.lastReviewSummary;
        mission.staleCycles = persisted.staleCycles;
        mission.lastReviewAt = persisted.lastReviewAt;
      }
      return review;
    } catch (err) {
      this.logger.warn('Deterministic OKR review failed at cadence boundary — falling back to review WI', {
        missionId: mission.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Pick the {@link ReviewReason} for this sweep tick.
   *
   * Precedence (most-actionable-first):
   *   1. `off_track_kr`     — at least one KR is reported off-track.
   *   2. `no_active_work`   — the mission has no active project tasks.
   *   3. `phase_complete`   — the mission has advanced phases since
   *                            the last review (heuristic — uses
   *                            `currentPhase` if both this sweep's
   *                            inferred phase and the previous one are
   *                            recorded; otherwise skipped).
   *   4. `scheduled_review` — default; cadence boundary fired.
   *
   * Conservative on `phase_complete`: we only emit it when the
   * previous review (`lastReviewSummary`) and the current `currentPhase`
   * actually disagree — REVIEW-1 doesn't reach into the phase machine
   * to invent state.
   */
  private inferReviewReason(
    mission: Mission,
    summary: MissionOKRSummary | null,
  ): ReviewReason {
    if (summary && summary.offTrack > 0) return 'off_track_kr';
    if (!mission.activeProjectTaskIds || mission.activeProjectTaskIds.length === 0) {
      return 'no_active_work';
    }
    if (
      typeof mission.currentPhase === 'number' &&
      mission.lastReviewSummary &&
      !mission.lastReviewSummary.includes(`phase=${mission.currentPhase}`)
    ) {
      return 'phase_complete';
    }
    return 'scheduled_review';
  }

  /**
   * Resolve the session name to wake when a review WorkItem fires.
   *
   * Order:
   *   1. The mission's explicit owner (`mission.ownerId`)
   *   2. The team lead resolved via the canonical {@link pickTeamLead}
   *      cascade (same path as Slack reminder owner resolution)
   *   3. The orchestrator session as last-resort wake target so a
   *      review never gets dropped on the floor.
   *
   * @param mission - The mission whose review WI is being created
   * @returns Session name string
   */
  private async resolveTeamLeadSession(mission: Mission): Promise<string> {
    if (mission.ownerId) {
      const member = await this.storageService.getMemberById(mission.ownerId);
      if (member?.sessionName) return member.sessionName;
    }
    const teams = await this.storageService.getTeams();
    const team = teams.find((t) => t.id === mission.ownerTeamId);
    if (team) {
      const lead = pickTeamLead(team);
      if (lead?.sessionName) return lead.sessionName;
    }
    return ORCHESTRATOR_SESSION_NAME;
  }

  /**
   * Send a Slack reminder for a specific mission.
   */
  private async sendReminder(mission: Mission, summary: MissionOKRSummary): Promise<boolean> {
    const bridge = getSlackOrchestratorBridge();
    if (!bridge) {
      this.logger.warn('SlackOrchestratorBridge not available, cannot send reminder');
      return false;
    }

    // Resolve owner name for @mention
    const ownerName = await this.resolveOwnerName(mission);
    const urgency = summary.offTrack > 0 ? 'high' : 'normal';

    const message = this.formatReminderMessage(mission, summary, ownerName);

    try {
      await bridge.sendNotification({
        type: 'okr_reminder',
        title: `OKR Alert: ${mission.objective.slice(0, 50)}${mission.objective.length > 50 ? '...' : ''}`,
        message,
        urgency,
        timestamp: new Date().toISOString(),
        metadata: {
          missionId: mission.id,
          offTrack: summary.offTrack,
          atRisk: summary.atRisk,
        },
      });
      return true;
    } catch (err) {
      this.logger.error('Failed to send Slack notification', {
        missionId: mission.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Format the reminder message text.
   */
  private formatReminderMessage(mission: Mission, summary: MissionOKRSummary, ownerName: string): string {
    const statusLine = summary.offTrack > 0
      ? `🚨 *${summary.offTrack} Key Results are OFF TRACK*`
      : `⚠️ *${summary.atRisk} Key Results are AT RISK*`;

    return `Hello ${ownerName},

${statusLine} for Mission: "${mission.objective}"

Progress: ${Math.round(summary.overallProgress)}%
Total KRs: ${summary.totalKRs}
Achieved: ${summary.achieved}
On Track: ${summary.onTrack}
At Risk: ${summary.atRisk}
Off Track: ${summary.offTrack}

Please review the current strategy and adjust as needed.
cc: @${ORCHESTRATOR_SESSION_NAME}`;
  }

  /**
   * Resolve a human-readable name for the mission owner.
   */
  private async resolveOwnerName(mission: Mission): Promise<string> {
    // 1. Try explicit ownerId
    if (mission.ownerId) {
      const member = await this.storageService.getMemberById(mission.ownerId);
      if (member) return member.name;
    }

    // 2. Fallback to Team Lead of ownerTeamId via the canonical 4-rule
    //    cascade in `utils/team.utils.pickTeamLead` — same resolver used
    //    by chat-v2 mention dispatch so behavior cannot drift.
    const teams = await this.storageService.getTeams();
    const team = teams.find((t) => t.id === mission.ownerTeamId);
    if (team) {
      const leader = pickTeamLead(team);
      if (leader) return leader.name;
      return team.name;
    }

    return 'Team Lead';
  }

  /**
   * Load all executable missions — `status: 'active'` AND approved (or
   * legacy, no approval metadata). A cascade child still awaiting its
   * owner's approval is skipped so it is neither reminded about nor handed
   * review WorkItems before anyone said yes. See {@link isMissionExecutable}.
   */
  private async loadAllActiveMissions(): Promise<Mission[]> {
    const dir = getMissionsDir();
    try {
      const files = await fs.readdir(dir);
      const missions: Mission[] = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(dir, file), 'utf-8');
          const mission = JSON.parse(raw) as Mission;
          if (isMissionExecutable(mission)) {
            missions.push(mission);
          }
        } catch {
          // Skip corrupt files
        }
      }
      return missions;
    } catch {
      return [];
    }
  }

  /**
   * Load a single mission from disk (null when missing/corrupt).
   */
  private async loadMission(missionId: string): Promise<Mission | null> {
    try {
      const raw = await fs.readFile(path.join(getMissionsDir(), `${missionId}.json`), 'utf-8');
      return JSON.parse(raw) as Mission;
    } catch {
      return null;
    }
  }

  /**
   * Save a mission back to disk.
   */
  private async saveMission(mission: Mission): Promise<void> {
    const filePath = path.join(getMissionsDir(), `${mission.id}.json`);
    await atomicWriteJson(filePath, mission);
  }
}
