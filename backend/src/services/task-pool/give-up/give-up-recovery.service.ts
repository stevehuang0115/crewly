/**
 * Give-up recovery (#841).
 *
 * The worker-facing stop endpoints (complete, block, fail) go through here.
 * Each stop is classified ({@link classifyStop}):
 *
 * - `retry` (a feasibility give-up, no human needed): a NEW WorkItem goes back
 *   to the same worker, carrying the attempt log and an instruction to pick a
 *   materially different approach. Bounded per ROOT WorkItem: a retry inherits
 *   the root, so it never starts its own count. After `giveUpMaxRetries`
 *   (team policy, default 2) the next stop, even another "impossible",
 *   produces ONE review WorkItem for the team lead with the full history.
 * - `escalate` / `none`: today's behaviour is unchanged; the stop is only
 *   recorded on the WorkItem (`metadata.stop`) for the metrics.
 *
 * Nothing verified or terminal is reopened. The stopped item is closed with
 * edges the transition table already permits: a failed item gets a
 * `succeeded_by` disposition (so the reconciler does not also requeue it in
 * place), and a blocked item is cancelled as superseded. A completion that is
 * a give-up is recorded as `failed` instead of `done_by_worker`, so the lead
 * gets no verify ping per attempt.
 *
 * @module services/task-pool/give-up/give-up-recovery.service
 */

import { GIVE_UP_RECOVERY_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../../../constants.js';
import type { Team } from '../../../types/index.js';
import type { TransitionActorInput, WorkItem } from '../../../types/v2/work-item.types.js';
import { pickTeamLead } from '../../../utils/team.utils.js';
import { LoggerService, type ComponentLogger } from '../../core/logger.service.js';
import { classifyStop, type StopCategory, type StopDecision, type StopSource, type StopVerdict } from './stop-classifier.js';

const C = GIVE_UP_RECOVERY_CONSTANTS;

/** The stop recorded on a WorkItem (`metadata.stop`). */
export interface RecordedStop {
  source: StopSource;
  decision: StopDecision;
  category: StopCategory;
  rules: string[];
  reason: string;
  at: string;
}

/** One entry of the attempt log. */
export interface GiveUpAttempt {
  workItemId: string;
  source: StopSource;
  category: StopCategory;
  reason: string;
  at: string;
}

/** The attempt log carried on retries and the escalation (`metadata.giveUp`). */
export interface GiveUpMeta {
  rootWorkItemId: string;
  /** Root's own parent, so retries sit beside the root (a cascade-cancel of a stopped attempt can never reach them). */
  rootParentWorkItemId?: string;
  rootTitle: string;
  rootDescription?: string;
  /** 1-based attempt number of this retry (absent on the root). */
  attempt?: number;
  maxRetries: number;
  attempts: GiveUpAttempt[];
}

/** What handling a stop did. */
export interface StopOutcome {
  verdict: StopVerdict;
  action: 'retry_queued' | 'escalated_to_lead' | 'recorded' | 'none';
  retryWorkItemId?: string;
  reviewWorkItemId?: string;
  attempt?: number;
  maxRetries?: number;
}

/** The pool operations this service needs (a subset of TaskPoolService). */
export interface GiveUpPool {
  findWorkItem(id: string): Promise<WorkItem | null>;
  // #813: actor is required on the real TaskPoolService.completeItem — a
  // review item's completion must be able to tell its reviewer from anyone
  // else. This service is one of that method's callers (the non-give-up
  // path), so it takes the same required actor and passes it straight
  // through.
  completeItem(id: string, result: Record<string, unknown> | undefined, actor: TransitionActorInput): Promise<void>;
  blockItem(id: string, options: { agentId: string; reason?: string }): Promise<void>;
  failItem(id: string, error: string): Promise<void>;
  addToPool(wi: WorkItem): Promise<void>;
  transitionStatus(
    id: string,
    status: 'cancelled',
    actor: 'system',
    mutator?: (wi: WorkItem) => void,
    reason?: string,
  ): Promise<WorkItem | null>;
  disposeFailedWorkItem(
    id: string,
    options: { reason: string; actor?: 'system'; successorWorkItemId?: string },
  ): Promise<unknown>;
  mergeItemMetadata(id: string, patch: Record<string, unknown>): Promise<WorkItem | null>;
}

/** Dependencies. */
export interface GiveUpRecoveryDeps {
  pool: GiveUpPool;
  loadTeams: () => Promise<Team[]>;
  now?: () => Date;
  logger?: ComponentLogger;
}

/**
 * The text a completion carries (its summary), for classification.
 *
 * @param result - Completion payload from the worker
 * @returns The summary text, or '' when there is none
 */
export function completionText(result: Record<string, unknown> | undefined): string {
  if (!result) return '';
  const s = result['summary'] ?? result['result'] ?? result['message'];
  return typeof s === 'string' ? s : '';
}

/**
 * Handles worker stops and turns feasibility give-ups into bounded retries.
 */
export class GiveUpRecoveryService {
  private readonly pool: GiveUpPool;
  private readonly loadTeams: () => Promise<Team[]>;
  private readonly now: () => Date;
  private readonly logger: ComponentLogger;

  /**
   * @param deps - Pool, team loader, clock and logger
   */
  constructor(deps: GiveUpRecoveryDeps) {
    this.pool = deps.pool;
    this.loadTeams = deps.loadTeams;
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('GiveUpRecovery');
  }

  /**
   * A worker completes an item. A completion whose outcome is a give-up (and
   * that shows no delivery) is recorded as failed and retried; any other
   * completion goes through exactly as before.
   *
   * @param workItemId - The running item
   * @param result - The worker's completion payload
   * @param actor - Who is completing it (#813: required by pool.completeItem;
   *   forwarded on the non-give-up path exactly as the caller resolved it)
   * @returns What was done
   */
  async complete(workItemId: string, result: Record<string, unknown> | undefined, actor: TransitionActorInput): Promise<StopOutcome> {
    const text = completionText(result);
    const verdict = classifyStop(text, 'complete');
    const before = await this.pool.findWorkItem(workItemId);
    // Convert only when retries are on for this worker's team: with the
    // feature off (giveUpMaxRetries 0) a completion stays exactly as today.
    // Also off for the orchestrator (isExcludedFromGiveUp): it is a
    // singleton control-plane process, not a bounded-retry worker, and has
    // no team lead of its own to escalate a review to.
    const enabled =
      verdict.decision === 'retry' && before !== null && !isExcludedFromGiveUp(before) &&
      maxRetriesFor(teamOf(await this.loadTeams().catch(() => [] as Team[]), before.target)) > 0;
    if (!enabled) {
      await this.pool.completeItem(workItemId, result, actor);
      if (verdict.decision !== 'none') await this.record(workItemId, 'complete', verdict, text);
      return { verdict, action: verdict.decision === 'none' ? 'none' : 'recorded' };
    }
    await this.pool.failItem(workItemId, text);
    return this.afterStop(before, workItemId, 'complete', verdict, text);
  }

  /**
   * A worker blocks an item.
   *
   * @param workItemId - The running item
   * @param options - Who blocked it and why
   * @returns What was done
   */
  async block(workItemId: string, options: { agentId: string; reason?: string }): Promise<StopOutcome> {
    const before = await this.pool.findWorkItem(workItemId);
    await this.pool.blockItem(workItemId, options);
    const text = options.reason ?? '';
    return this.afterStop(before, workItemId, 'block', classifyStop(text, 'block'), text);
  }

  /**
   * A worker fails an item.
   *
   * @param workItemId - The running item
   * @param error - The failure text
   * @returns What was done
   */
  async fail(workItemId: string, error: string): Promise<StopOutcome> {
    const before = await this.pool.findWorkItem(workItemId);
    await this.pool.failItem(workItemId, error);
    return this.afterStop(before, workItemId, 'fail', classifyStop(error, 'fail'), error);
  }

  /**
   * Record the stop, then retry or escalate when the verdict says so.
   *
   * @param before - The item as it was before the stop (for its brief and log)
   * @param workItemId - The stopped item
   * @param source - Stop path
   * @param verdict - Classification
   * @param text - Stop text
   * @returns What was done
   */
  private async afterStop(
    before: WorkItem | null,
    workItemId: string,
    source: StopSource,
    verdict: StopVerdict,
    text: string,
  ): Promise<StopOutcome> {
    await this.record(workItemId, source, verdict, text);
    if (verdict.decision !== 'retry' || !before) return { verdict, action: 'recorded' };

    // The escalation review this service itself creates (buildReview) carries
    // the give-up meta and an id derived from `rootWorkItemId`. If the lead
    // blocks or fails THAT review with give-up wording, re-running this same
    // logic on it would rebuild a review with the identical id (addToPool
    // then silently skips it as a duplicate) and closeStopped(id, id) would
    // try to cancel the escalation as superseded by itself. A give-up review
    // has done its job once it reaches a human; it is never itself retried
    // or re-escalated. The orchestrator is excluded for the same reason
    // `complete()` excludes it above (see isExcludedFromGiveUp).
    if (isExcludedFromGiveUp(before)) {
      this.logger.debug('Give-up handling skipped: item is excluded (a give-up escalation, or targets the orchestrator)', {
        workItemId, type: before.type, target: before.target, reviewReason: before.metadata?.['reviewReason'],
      });
      return { verdict, action: 'recorded' };
    }

    try {
      const teams = await this.loadTeams().catch(() => [] as Team[]);
      const team = teamOf(teams, before.target);
      const maxRetries = maxRetriesFor(team);
      if (maxRetries <= 0) return { verdict, action: 'recorded', maxRetries };

      const prior = giveUpMetaOf(before);
      const attempts: GiveUpAttempt[] = [
        ...(prior?.attempts ?? []),
        { workItemId, source, category: verdict.category, reason: clip(text), at: this.now().toISOString() },
      ];
      const meta: GiveUpMeta = {
        rootWorkItemId: prior?.rootWorkItemId ?? before.id,
        rootParentWorkItemId: prior ? prior.rootParentWorkItemId : before.parentWorkItemId,
        rootTitle: prior?.rootTitle ?? before.title,
        rootDescription: prior ? prior.rootDescription : before.description,
        maxRetries,
        attempts,
      };

      if (attempts.length <= maxRetries) {
        const retry = this.buildRetry(before, meta, attempts.length);
        await this.pool.addToPool(retry);
        await this.closeStopped(workItemId, retry.id, `give-up retry ${attempts.length}/${maxRetries}`);
        this.logger.info('Give-up: retry with a different approach queued', {
          workItemId, retryWorkItemId: retry.id, attempt: attempts.length, maxRetries, rootWorkItemId: meta.rootWorkItemId,
        });
        return { verdict, action: 'retry_queued', retryWorkItemId: retry.id, attempt: attempts.length, maxRetries };
      }

      const review = this.buildReview(before, meta, team);
      await this.pool.addToPool(review);
      await this.closeStopped(workItemId, review.id, `gave up after ${maxRetries} retries — escalated to the lead`);
      this.logger.info('Give-up: retries exhausted, one escalation to the lead', {
        workItemId, reviewWorkItemId: review.id, target: review.target, attempts: attempts.length,
      });
      return { verdict, action: 'escalated_to_lead', reviewWorkItemId: review.id, attempt: attempts.length, maxRetries };
    } catch (err) {
      // The stop itself already happened; a recovery glitch must not undo it.
      this.logger.error('Give-up recovery failed after the stop was recorded', {
        workItemId, error: err instanceof Error ? err.message : String(err),
      });
      return { verdict, action: 'recorded' };
    }
  }

  /**
   * Write `metadata.stop` on the stopped item. Best-effort: never throws.
   *
   * @param workItemId - Item
   * @param source - Stop path
   * @param verdict - Classification
   * @param text - Stop text
   */
  private async record(workItemId: string, source: StopSource, verdict: StopVerdict, text: string): Promise<void> {
    const stop: RecordedStop = {
      source, decision: verdict.decision, category: verdict.category, rules: verdict.rules,
      reason: clip(text), at: this.now().toISOString(),
    };
    try {
      await this.pool.mergeItemMetadata(workItemId, { [C.STOP_METADATA_KEY]: stop });
    } catch (err) {
      // Best-effort: the stop already happened; failing to annotate it must
      // not turn a successful block/fail/complete into an API error.
      this.logger.warn('Could not record the stop classification (non-fatal)', {
        workItemId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Hand the stopped item's work to its successor with edges the table permits.
   *
   * @param workItemId - Stopped item (now failed or blocked)
   * @param successorId - Retry or review item
   * @param reason - Audit text
   */
  private async closeStopped(workItemId: string, successorId: string, reason: string): Promise<void> {
    const current = await this.pool.findWorkItem(workItemId);
    if (!current) return;
    if (current.status === 'failed') {
      await this.pool.disposeFailedWorkItem(workItemId, { reason, actor: 'system', successorWorkItemId: successorId });
    } else if (current.status === 'blocked') {
      await this.pool.transitionStatus(workItemId, 'cancelled', 'system', undefined, `superseded by ${successorId}: ${reason}`);
    }
  }

  /**
   * The retry WorkItem.
   *
   * DELIBERATE CHOICE (#843): its id's `:giveup:N` infix is NOT added to
   * `FRESH_TASK_CONVERSATION_CONSTANTS.ROOT_SUFFIX_MARKERS`, so dispatching
   * it starts a fresh conversation rather than continuing the one that just
   * gave up. Reasoning: the whole point of a retry is a materially
   * DIFFERENT approach (see the instruction below), and the full attempt
   * log is already written into this WorkItem's own description — nothing
   * is lost by a clean slate, and a warm conversation risks anchoring the
   * agent on the reasoning that just failed.
   *
   * @param stopped - The item that gave up
   * @param meta - Attempt log so far
   * @param attempt - This retry's number
   * @returns A queued WorkItem for the same worker
   */
  private buildRetry(stopped: WorkItem, meta: GiveUpMeta, attempt: number): WorkItem {
    const id = `${meta.rootWorkItemId}${C.RETRY_ID_INFIX}${attempt}`;
    const instruction = [
      `## Retry ${attempt}/${meta.maxRetries}: try a materially different approach`,
      '',
      'A previous attempt stopped, saying the task could not be done. Before you start:',
      '1. List every approach already tried (below, and any you know of) and why each failed.',
      '2. Pick one that is materially different, not a variation of those.',
      '3. If what blocks you needs a human (permissions or credentials, copyright or legal, money, an owner decision or scope change, safety, a destructive or external action, personal data, or a broken environment), block the task and say which. Do not work around it.',
      '',
      '### Attempts so far',
      ...meta.attempts.map((a, i) => `${i + 1}. \`${a.workItemId}\` (${a.source}, ${a.at}): ${a.reason}`),
    ].join('\n');
    return {
      id,
      type: stopped.type,
      owner: stopped.owner,
      target: stopped.target,
      title: `Retry ${attempt}/${meta.maxRetries} (different approach): ${meta.rootTitle}`,
      description: `${meta.rootDescription ?? ''}\n\n${instruction}`.trim(),
      status: 'queued',
      createdAt: this.now().toISOString(),
      retryCount: 0,
      maxRetries: stopped.maxRetries,
      requestId: stopped.requestId,
      missionId: stopped.missionId,
      parentWorkItemId: meta.rootParentWorkItemId,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      metadata: {
        ...(stopped.metadata?.['teamId'] ? { teamId: stopped.metadata['teamId'] } : {}),
        // The retry answers where the stopped attempt would have (origin chain).
        ...(stopped.metadata?.['origin'] ? { origin: stopped.metadata['origin'] } : {}),
        idempotencyKey: id,
        [C.GIVE_UP_METADATA_KEY]: { ...meta, attempt },
      },
    } as WorkItem;
  }

  /**
   * The single escalation to the team lead.
   *
   * @param stopped - The last item that gave up
   * @param meta - Full attempt log
   * @param team - The worker's team, if known
   * @returns A queued review WorkItem for the lead
   */
  private buildReview(stopped: WorkItem, meta: GiveUpMeta, team: Team | null): WorkItem {
    const id = `${meta.rootWorkItemId}${C.REVIEW_ID_SUFFIX}`;
    const lead = team ? pickTeamLead(team) : null;
    const target = lead?.sessionName && lead.sessionName !== stopped.target ? lead.sessionName : ORCHESTRATOR_SESSION_NAME;
    const history = meta.attempts.map((a, i) => `${i + 1}. \`${a.workItemId}\` (${a.source}, ${a.at}): ${a.reason}`).join('\n');
    return {
      id,
      type: 'review',
      owner: 'team_lead',
      target,
      title: `Gave up after ${meta.maxRetries} retries: ${meta.rootTitle}`,
      description: [
        `\`${stopped.target ?? 'the worker'}\` stopped on this task ${meta.attempts.length} times, each time saying it could not be done, including ${meta.maxRetries} retries with a different approach.`,
        'Decide: re-scope, reassign, give more context, or cancel.',
        '',
        '### Attempts',
        history,
        '',
        '### Original brief',
        meta.rootDescription ?? '(none)',
      ].join('\n'),
      status: 'queued',
      createdAt: this.now().toISOString(),
      retryCount: 0,
      maxRetries: stopped.maxRetries,
      requestId: stopped.requestId,
      missionId: stopped.missionId,
      parentWorkItemId: meta.rootParentWorkItemId,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      metadata: {
        ...(stopped.metadata?.['teamId'] ? { teamId: stopped.metadata['teamId'] } : {}),
        idempotencyKey: id,
        reviewReason: 'gave_up',
        sourceWorkItemId: meta.rootWorkItemId,
        [C.GIVE_UP_METADATA_KEY]: meta,
      },
    } as WorkItem;
  }
}

/**
 * The attempt log on a WorkItem, if it is a give-up retry.
 *
 * @param wi - WorkItem
 * @returns Its `metadata.giveUp`, or null
 */
export function giveUpMetaOf(wi: WorkItem): GiveUpMeta | null {
  const m = wi.metadata?.[C.GIVE_UP_METADATA_KEY] as GiveUpMeta | undefined;
  return m && typeof m.rootWorkItemId === 'string' && Array.isArray(m.attempts) ? m : null;
}

/**
 * Whether a stopped WorkItem is excluded from give-up handling entirely: it
 * is never retried, never escalated — only recorded, exactly like feature-off.
 *
 * Two cases:
 * - It targets the orchestrator: a singleton control-plane process, not a
 *   bounded-retry worker. `teamOf()` finds no team for it (the orchestrator
 *   is not a team member), so `maxRetriesFor(null)` would otherwise fall
 *   through to the team-less default (2) and give it retries and a review
 *   escalation it has no team lead to receive.
 * - It IS a give-up escalation review (buildReview's own output, `type:
 *   'review'` with `metadata.reviewReason === 'gave_up'`): if the lead
 *   blocks or fails THAT review with give-up wording, this service must not
 *   process it again (see the comment at the call site in `afterStop`).
 *
 * @param wi - The stopped WorkItem
 * @returns True when give-up handling must not apply
 */
export function isExcludedFromGiveUp(wi: WorkItem): boolean {
  return wi.target === ORCHESTRATOR_SESSION_NAME || wi.type === 'review' || wi.metadata?.['reviewReason'] === 'gave_up';
}

/**
 * The team a worker session belongs to.
 *
 * @param teams - All teams
 * @param session - Worker session
 * @returns The team, or null
 */
export function teamOf(teams: Team[], session: string | undefined): Team | null {
  if (!session) return null;
  return teams.find((t) => (t.members ?? []).some((m) => m.sessionName === session)) ?? null;
}

/**
 * Give-up retries allowed for a team.
 *
 * @param team - The worker's team, or null
 * @returns `recoveryPolicy.giveUpMaxRetries` when set to a non-negative integer, else the default
 */
export function maxRetriesFor(team: Team | null): number {
  const n = team?.recoveryPolicy?.giveUpMaxRetries;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : C.DEFAULT_MAX_RETRIES;
}

/**
 * Clip stop text for storage.
 *
 * @param text - Stop text
 * @returns At most MAX_REASON_CHARS characters
 */
function clip(text: string): string {
  return text.length > C.MAX_REASON_CHARS ? `${text.slice(0, C.MAX_REASON_CHARS)}…` : text;
}
