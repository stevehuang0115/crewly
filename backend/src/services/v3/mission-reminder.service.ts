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
import { CronExpressionParser } from 'cron-parser';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { StorageService } from '../core/storage.service.js';
import { KRTrackingService } from './kr-tracking.service.js';
import { getSlackOrchestratorBridge } from '../slack/slack-orchestrator-bridge.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import type { Mission } from '../../types/v2/mission.types.js';
import type { MissionOKRSummary } from '../../types/v2/key-result.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { TERMINAL_WORK_ITEM_STATUSES } from '../../types/v2/work-item.types.js';
import { atomicWriteJson } from '../../utils/file-io.utils.js';
import { pickTeamLead } from '../../utils/team.utils.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum interval between reminders for the same mission (24 hours) */
const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Why this review cycle was scheduled. Surfaces on the review WorkItem's
 * `metadata.reviewReason` so the TL queue can render context-appropriate
 * UI (e.g. red badge on `off_track_kr`, neutral badge on
 * `scheduled_review`).
 */
export type ReviewReason =
  | 'scheduled_review'
  | 'off_track_kr'
  | 'no_active_work'
  | 'phase_complete';

/**
 * Statuses that *clear* a Mission's `pendingReviewWorkItemId` so the next
 * sweep tick can fire a new review. The set mirrors
 * {@link TERMINAL_WORK_ITEM_STATUSES} (`done`, `verified`, `cancelled`) but
 * adds two statuses that the canonical TERMINAL set excludes for valid
 * reasons elsewhere — yet which DO represent "exited the active queue" for
 * the V8 reentrancy-lock perspective:
 *
 * - `failed`: a failed review WI has terminated execution; not blocking next cadence.
 * - `rejected`: a TL-rejected review WI ({@link WorkItemStatus} reachable from
 *   the review path per work-item.types.ts) has likewise exited the queue.
 *   Without this, a single TL rejection of a review WI would silently freeze
 *   that mission's lock forever — exactly the V8 failure mode this lock
 *   exists to prevent (Arch N1 BLOCKING fix on PR #354).
 *
 * The reentrancy lock is sweep-time lazy: we don't subscribe to TRANS-1
 * events here, we just observe the WorkItem's current state on each sweep
 * and clear the lock when it's terminal.
 */
const PENDING_REVIEW_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  ...TERMINAL_WORK_ITEM_STATUSES,
  'failed',
  'rejected',
]);

function getMissionsDir(): string {
  return path.join(process.cwd(), '.crewly', 'missions');
}

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

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('MissionReminder');
    this.storageService = StorageService.getInstance();
    this.krTrackingService = KRTrackingService.getInstance();
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
  }> {
    const now = new Date();
    const missions = await this.loadAllActiveMissions();
    const result = {
      checked: 0,
      sent: 0,
      skipped: 0,
      reviewsCreated: 0,
      reviewsSkipped: 0,
    };

    this.logger.info('Starting Mission OKR reminder sweep', { count: missions.length });

    for (const mission of missions) {
      result.checked++;

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
   * the mission has no executionCadence configured (legacy missions).
   */
  private async maybeCreateReviewWorkItem(
    mission: Mission,
    summary: MissionOKRSummary | null,
    now: Date,
  ): Promise<'created' | 'skipped' | 'noop'> {
    const cadence = mission.policy?.executionCadence;
    if (!cadence?.reviewSchedule) return 'noop';

    const timezone = cadence.workHours?.timezone ?? DEFAULT_REVIEW_TIMEZONE;

    // -----------------------------------------------------------------
    // Reentrancy lock (Arch Veto V8).
    // Lazily clear the pending pointer when the previous review WI has
    // reached terminal status; otherwise short-circuit creation.
    // -----------------------------------------------------------------
    if (mission.pendingReviewWorkItemId) {
      const taskPool = TaskPoolService.getInstance();
      const pendingWI = await taskPool.findWorkItem(mission.pendingReviewWorkItemId);
      if (!pendingWI || PENDING_REVIEW_TERMINAL_STATUSES.has(pendingWI.status)) {
        // Pending WI is gone or terminal — clear and continue.
        mission.pendingReviewWorkItemId = undefined;
        await this.saveMission(mission);
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
      this.logger.warn('Mission has unparseable review cadence cron — skipping review WI', {
        missionId: mission.id,
        reviewSchedule: cadence.reviewSchedule,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'noop';
    }

    if (mission.lastReviewAt) {
      const lastReview = new Date(mission.lastReviewAt);
      if (lastReview.getTime() >= boundary.getTime()) {
        // Already reviewed within the current cadence cycle.
        return 'skipped';
      }
    }

    // -----------------------------------------------------------------
    // Build the deterministic review WorkItem.
    //
    // The id collapses to the date-form of the boundary so a sweep
    // replay within the same cycle hits the existing addToPool
    // dedup-by-id guard (V1 satisfied without a TaskPoolService change).
    // -----------------------------------------------------------------
    const cycleId = boundary.toISOString().slice(0, 10);
    const reviewWorkItemId = `${mission.id}:review:${cycleId}`;
    const reviewReason = this.inferReviewReason(mission, summary);
    const target = await this.resolveTeamLeadSession(mission);

    const reviewWorkItem: WorkItem = {
      id: reviewWorkItemId,
      type: 'review',
      owner: 'team_lead',
      target,
      title: `Mission review — ${mission.objective.slice(0, 60)}${mission.objective.length > 60 ? '…' : ''}`,
      description: `Cadence-driven review for mission ${mission.id}. Reason: ${reviewReason}.`,
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
      },
    };

    const taskPool = TaskPoolService.getInstance();
    await taskPool.addToPool(reviewWorkItem);

    // Persist the reentrancy lock + bookkeeping fields.
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
   * Load all missions with 'active' status.
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
          if (mission.status === 'active') {
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
   * Save a mission back to disk.
   */
  private async saveMission(mission: Mission): Promise<void> {
    const filePath = path.join(getMissionsDir(), `${mission.id}.json`);
    await atomicWriteJson(filePath, mission);
  }
}
