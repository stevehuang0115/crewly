/**
 * Escalation Router Service
 *
 * Routes escalations to the appropriate target:
 * - target === 'team_lead' → Send message to TL agent via MessageQueue
 * - target === 'human' → Send Slack notification to user + pause task + create pending record
 *
 * Also handles MissionPolicy escalation rules (cost_exceeded, failure_count, etc.)
 * by routing `escalateTo: 'user'` to human and `escalateTo: 'orchestrator'` to agent.
 *
 * Pending human escalations are stored in `.crewly/escalations/` and resolved
 * via POST /api/escalations/:id/resolve.
 *
 * @module services/v3/escalation-router.service
 */

import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { ensureDir, atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import type { AlignmentRequest } from '../../types/v2/work-item.types.js';
import type { EscalationRule, Mission } from '../../types/v2/mission.types.js';
import { getAgentBehaviorLogService } from '../observability/agent-behavior-log.singleton.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Status of a pending human escalation. */
export type EscalationStatus = 'pending' | 'resolved' | 'expired';

/**
 * Minimal WorkItem shape `escalateFailedWorkItem` needs. Defined locally
 * (rather than importing the full WorkItem type) to keep this service's
 * dependency surface narrow — escalation only reads, never writes,
 * fields it doesn't recognise.
 */
export interface WorkItemForEscalation {
  id: string;
  title: string;
  type: string;
  target?: string | null;
  retryCount: number;
  maxRetries: number;
  error?: string | null;
  requestId?: string | null;
  missionId?: string | null;
  parentWorkItemId?: string | null;
  priority?: string | null;
}

/** A persisted escalation record awaiting human resolution. */
export interface PendingEscalation {
  id: string;
  status: EscalationStatus;
  /** What triggered this escalation */
  source: 'alignment_request' | 'policy_rule' | 'tl_verification' | 'manual' | 'workitem_failed';
  /** Who needs to resolve it */
  target: 'human' | 'team_lead' | 'orchestrator';
  /** The escalation content */
  summary: string;
  details: Record<string, unknown>;
  /** Related IDs */
  workItemId?: string;
  missionId?: string;
  taskId?: string;
  /** Who raised it */
  raisedBy: string;
  raisedAt: string;
  /** Resolution (filled when resolved) */
  resolvedAt?: string;
  resolvedBy?: string;
  resolution?: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class EscalationRouterService {
  private static instance: EscalationRouterService | null = null;

  private readonly logger: ComponentLogger;
  private readonly escalationsDir: string;

  private constructor(projectPath: string) {
    this.logger = LoggerService.getInstance().createComponentLogger('EscalationRouter');
    this.escalationsDir = path.join(projectPath, '.crewly', 'escalations');
  }

  public static getInstance(projectPath?: string): EscalationRouterService {
    if (!EscalationRouterService.instance) {
      const p = projectPath || process.cwd();
      EscalationRouterService.instance = new EscalationRouterService(p);
    }
    return EscalationRouterService.instance;
  }

  public static resetInstance(): void {
    EscalationRouterService.instance = null;
  }

  // ---------------------------------------------------------------------------
  // Route: AlignmentRequest from Worker
  // ---------------------------------------------------------------------------

  /**
   * Route a worker's AlignmentRequest to the correct target.
   *
   * @param request - The structured alignment request from the worker
   * @param workItemId - The WorkItem being escalated
   * @param workerSession - Worker's session name
   * @returns The escalation ID if routed to human, null if handled by agent
   */
  async routeAlignmentRequest(
    request: AlignmentRequest,
    workItemId: string,
    workerSession: string,
  ): Promise<string | null> {
    // F14: record `agent.escalation` at the canonical worker→{TL,human}
    // entry point. Best-effort — never blocks the escalation flow. Why
    // this site: it is the single chokepoint every structured worker
    // alignment request flows through (target='team_lead' or 'human').
    // The `escalate` skill / send-message-with-action paths converge
    // here. Recording earlier (e.g. inside the skill bash) loses the
    // structured `target`/`reason` shape; recording later (inside
    // notifyHuman / notifyAgent) misses the handled-by-agent branch
    // when target='team_lead' returns null.
    try {
      getAgentBehaviorLogService()?.record({
        type: 'agent.escalation',
        escalatingAgent: workerSession,
        escalatedTo: request.target,
        reason: request.reason,
        taskId: workItemId,
        details: {
          discoveredIssue: request.discoveredIssue,
          decisionNeeded: request.decisionNeeded,
        },
      });
      // F14 ask_human boundary: when an agent escalates to a human
      // (Steve), this IS an `agent.action` with actionType='ask_human'.
      // We record both events so digests can compute (a) raw escalation
      // counts and (b) per-agent ask_human rates as a subset.
      if (request.target === 'human') {
        getAgentBehaviorLogService()?.record({
          type: 'agent.action',
          agent: workerSession,
          actionType: 'ask_human',
          taskId: workItemId,
          details: {
            reason: request.reason,
            workItemId,
          },
        });
      }
    } catch {
      /* observability is best-effort */
    }

    if (request.target === 'human') {
      // Create persistent record + notify human
      const escalation = await this.createPendingEscalation({
        source: 'alignment_request',
        target: 'human',
        summary: `Worker ${workerSession} escalated: ${request.discoveredIssue}`,
        details: {
          currentTask: request.currentTask,
          reason: request.reason,
          whyCannotExecute: request.whyCannotExecute,
          options: request.options,
          recommendation: request.recommendation,
          decisionNeeded: request.decisionNeeded,
        },
        workItemId,
        raisedBy: workerSession,
      });

      // Notify via Slack
      await this.notifyHuman(escalation);

      // Pause the work item
      await this.pauseWorkItem(workItemId);

      this.logger.info('Escalation routed to human', {
        escalationId: escalation.id,
        workItemId,
        reason: request.reason,
      });

      return escalation.id;
    }

    // target === 'team_lead' → route to TL agent
    await this.notifyAgent(request, workItemId, workerSession);

    this.logger.info('Escalation routed to team lead agent', {
      workItemId,
      reason: request.reason,
    });

    return null;
  }

  // ---------------------------------------------------------------------------
  // Route: MissionPolicy EscalationRule
  // ---------------------------------------------------------------------------

  /**
   * Route a MissionPolicy escalation rule trigger.
   *
   * @param mission - The Mission that triggered the rule
   * @param rule - The escalation rule that fired
   * @param context - Current context values (cost, time, failures)
   */
  async routePolicyEscalation(
    mission: Mission,
    rule: EscalationRule,
    context: Record<string, number>,
  ): Promise<string | null> {
    if (rule.escalateTo === 'user') {
      const escalation = await this.createPendingEscalation({
        source: 'policy_rule',
        target: 'human',
        summary: `Mission "${mission.objective}" triggered ${rule.condition} (threshold: ${rule.threshold})`,
        details: {
          condition: rule.condition,
          threshold: rule.threshold,
          currentValue: context[rule.condition] ?? 0,
          action: rule.action,
        },
        missionId: mission.id,
        raisedBy: 'system',
      });

      await this.notifyHuman(escalation);

      // Execute the escalation action
      if (rule.action === 'pause' || rule.action === 'block') {
        try {
          const { MissionExecutorService } = await import('./mission-executor.service.js');
          await MissionExecutorService.getInstance().pauseMission(mission.id);
        } catch {
          // Non-fatal
        }
      }

      return escalation.id;
    }

    // escalateTo === 'orchestrator' or 'team_lead' → route to agent
    this.logger.info('Policy escalation routed to agent', {
      missionId: mission.id,
      escalateTo: rule.escalateTo,
      condition: rule.condition,
    });

    return null;
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve a pending human escalation.
   *
   * @param escalationId - The escalation to resolve
   * @param resolution - What the human decided
   * @param resolvedBy - Who resolved it (user ID or name)
   * @returns The updated escalation, or null if not found
   */
  async resolve(
    escalationId: string,
    resolution: string,
    resolvedBy: string,
  ): Promise<PendingEscalation | null> {
    const escalation = await this.loadEscalation(escalationId);
    if (!escalation) return null;

    escalation.status = 'resolved';
    escalation.resolvedAt = new Date().toISOString();
    escalation.resolvedBy = resolvedBy;
    escalation.resolution = resolution;

    await this.saveEscalation(escalation);

    // Resume paused work item if applicable
    if (escalation.workItemId) {
      await this.resumeWorkItem(escalation.workItemId);
    }

    this.logger.info('Escalation resolved', {
      escalationId,
      resolvedBy,
      workItemId: escalation.workItemId,
    });

    return escalation;
  }

  /**
   * Escalate a WorkItem that exhausted its retry budget to the
   * orchestrator. The orchestrator receives a structured message via
   * the same MessageQueue used by `target='team_lead'` escalations,
   * decides whether to (a) surface to the user, (b) replan, (c) hand
   * off to a different agent. Also persists a `PendingEscalation`
   * record for the dashboard / API.
   *
   * Called from `V3DataService.onTaskFailed` once `retryCount >=
   * maxRetries`. Best-effort — exceptions are caught and logged so a
   * messaging blip doesn't strand the upstream failure handler.
   *
   * @param wi      - The failed WorkItem (post-`failItem`, with retryCount
   *                  and maxRetries reflecting the exhausted budget)
   * @param reason  - Final failure reason (same string written to wi.error)
   * @returns The persisted escalation id, or null on persistence failure
   */
  async escalateFailedWorkItem(wi: WorkItemForEscalation, reason: string): Promise<string | null> {
    const escalationId = uuidv4();
    const escalation: PendingEscalation = {
      id: escalationId,
      status: 'pending',
      source: 'workitem_failed',
      target: 'orchestrator',
      summary: `WorkItem "${wi.title}" failed after ${wi.maxRetries} retries`,
      details: {
        workItemId: wi.id,
        title: wi.title,
        type: wi.type,
        target: wi.target ?? null,
        retryCount: wi.retryCount,
        maxRetries: wi.maxRetries,
        lastError: wi.error ?? reason,
        requestId: wi.requestId ?? null,
        missionId: wi.missionId ?? null,
        priority: wi.priority ?? null,
      },
      workItemId: wi.id,
      missionId: wi.missionId ?? undefined,
      taskId: wi.parentWorkItemId ?? undefined,
      raisedBy: wi.target ?? 'system',
      raisedAt: new Date().toISOString(),
    };

    try {
      await this.saveEscalation(escalation);
    } catch (err) {
      this.logger.warn('Failed to persist workitem_failed escalation (non-fatal)', {
        workItemId: wi.id,
        error: err instanceof Error ? err.message : String(err),
      });
      // Continue — even if persistence fails the orc message below
      // still has value (orc will surface to user).
    }

    // Build the orc-facing message. Designed to be self-contained so orc
    // can act without going back to the activity log to reconstruct
    // context. Sanitization is REQUIRED because `wi.title` flows from
    // user-derived Slack/Request text and `wi.error` from worker output
    // — both can contain newlines, ANSI escapes, or strings that would
    // collide with the [CHAT:] / [NOTIFY:] markers ORC parses in its
    // own outbound message protocol. We:
    //   - strip ANSI escape codes
    //   - flatten newlines so a multi-line error can't open a fake
    //     marker line
    //   - defuse the four ORC-recognized marker prefixes by inserting
    //     a zero-width space — visible to neither ORC nor humans, but
    //     prevents the marker from parsing
    //   - hard-cap each user-derived field so a giant stack trace
    //     can't blow past ORC's context budget
    const sanitize = (raw: string, maxLen: number): string =>
      String(raw)
        .replace(/\[[0-9;]*m/g, '') // strip ANSI color escapes
        .replace(/[\r\n]+/g, ' ')         // flatten newlines
        .replace(/\[(CHAT|NOTIFY|EVENT|ESCALATION)/gi, '[​$1') // defuse markers
        .slice(0, maxLen);

    const safeTitle = sanitize(wi.title, 200);
    const safeError = sanitize(wi.error ?? reason, 2_000);

    const lines = [
      `[ESCALATION] WorkItem failed after ${wi.maxRetries} retries — your decision needed.`,
      '',
      `WorkItem: ${wi.id} "${safeTitle}"`,
      `Type:     ${wi.type}`,
      `Target:   ${wi.target ?? '(unassigned)'}`,
      `Attempts: ${wi.retryCount} / ${wi.maxRetries}`,
      '',
      `Last error: ${safeError}`,
      '',
      `Parent Request: ${wi.requestId ?? '(none)'}`,
      `Parent Mission: ${wi.missionId ?? '(none)'}`,
      '',
      'Suggested actions (per Escalation SOP in your prompt):',
      '  (a) Surface to the user with the failure reason + concrete options',
      '  (b) Replan: break the task differently and re-delegate',
      '  (c) Hand off to a different agent better suited to the task',
      '  (d) Cancel with a "blocked — needs spec clarification" note',
      '',
      `Escalation id: ${escalationId}`,
    ];

    try {
      const { MessageQueueService } = await import('../messaging/message-queue.service.js');
      const mq = new MessageQueueService(process.cwd());
      mq.enqueue({
        content: lines.join('\n'),
        conversationId: `escalation-${wi.id}-${Date.now()}`,
        source: 'system_event',
        sourceMetadata: {
          type: 'escalation',
          subtype: 'workitem_failed',
          workItemId: wi.id,
          escalationId,
        },
      });
      this.logger.info('Routed workitem_failed escalation to ORC via MessageQueue', {
        workItemId: wi.id,
        escalationId,
      });
    } catch (err) {
      this.logger.warn('Failed to enqueue workitem_failed message for ORC (non-fatal)', {
        workItemId: wi.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return escalationId;
  }

  /**
   * Deliver the FINAL deliverable judgment to the orchestrator when a Request
   * completes — every child WorkItem was verified (P2 acceptance gate), so the
   * whole deliverable is assembled and per-piece accepted. Asks the orc (the
   * top-level TL) to do the holistic check the per-piece verification cannot:
   * does the ASSEMBLED result meet the original goal and is it actually usable?
   * Accept to close, or reopen with concrete gaps (which re-delegates rework).
   *
   * Best-effort — enqueues a self-contained orc message; never throws.
   *
   * @param request - The completed Request (id + goal/title for the summary).
   * @param childItems - Its child WorkItems (title + status, for the summary).
   * @returns Resolves when the message is enqueued (or silently on failure).
   */
  async requestFinalDeliverableReview(
    request: { id: string; title?: string; description?: string; objective?: string },
    childItems: Array<{ title: string; status: string }>,
  ): Promise<void> {
    const total = childItems.length;
    const verified = childItems.filter((c) => c.status === 'verified' || c.status === 'done').length;

    const sanitize = (raw: string, maxLen: number): string =>
      String(raw)
        .replace(/\[[0-9;]*m/g, '')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\[(CHAT|NOTIFY|EVENT|ESCALATION)/gi, '[​$1')
        .slice(0, maxLen);

    const goal = sanitize(request.objective ?? request.title ?? request.description ?? '(unspecified)', 300);
    const itemLines = childItems.slice(0, 20).map((c) => `  • [${c.status}] ${sanitize(c.title, 120)}`);

    const lines = [
      '[ESCALATION] Deliverable complete — your final verdict needed.',
      '',
      `Request: ${request.id}`,
      `Goal:    ${goal}`,
      `Pieces:  ${verified}/${total} work items verified`,
      '',
      'Completed work items:',
      ...itemLines,
      ...(total > 20 ? [`  … and ${total - 20} more`] : []),
      '',
      'Every piece passed TL verification. Now do the FINAL holistic check the',
      'per-piece checks cannot: does the ASSEMBLED deliverable meet the original',
      'goal and is it actually usable end-to-end?',
      '  (a) If yes → accept and close; report the result to the user.',
      '  (b) If it falls short → reopen with the specific gaps; the team reworks.',
    ];

    try {
      const { MessageQueueService } = await import('../messaging/message-queue.service.js');
      const mq = new MessageQueueService(process.cwd());
      mq.enqueue({
        content: lines.join('\n'),
        conversationId: `final-review-${request.id}-${Date.now()}`,
        source: 'system_event',
        sourceMetadata: {
          type: 'escalation',
          subtype: 'final_deliverable_review',
          requestId: request.id,
        },
      });
      this.logger.info('Routed final deliverable review to ORC via MessageQueue', {
        requestId: request.id,
        verified,
        total,
      });
    } catch (err) {
      this.logger.warn('Failed to enqueue final deliverable review for ORC (non-fatal)', {
        requestId: request.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Escalate a WorkItem whose worker reported done but whose Team Leader has
   * NOT verified it within the deadline (verification-enforcement, P1).
   *
   * Asks the orchestrator to render an EXPLICIT verdict — verify/accept
   * (→ verified) or reject (→ rejected → the existing rework loop) — so
   * unverified work is never silently auto-accepted by the 24h TTL fallback
   * (`pickTTLExpiryTarget('done_by_worker') → 'verified'`). Mirrors
   * {@link escalateFailedWorkItem}: persists a `tl_verification` escalation
   * targeted at the orchestrator and enqueues a self-contained orc-facing
   * message. Best-effort — persistence/message failures are logged, not
   * thrown, so the reconciler pass never strands on it.
   *
   * @param wi - The unverified WorkItem (only read).
   * @param awaitingMs - How long it has awaited verification (for the message).
   * @returns The escalation id, or null on a hard failure.
   */
  async escalateUnverifiedWorkItem(
    wi: WorkItemForEscalation,
    awaitingMs: number,
  ): Promise<string | null> {
    const escalationId = uuidv4();
    const awaitingH = Math.max(1, Math.round(awaitingMs / 3_600_000));
    const escalation: PendingEscalation = {
      id: escalationId,
      status: 'pending',
      source: 'tl_verification',
      target: 'orchestrator',
      summary: `WorkItem "${wi.title}" awaiting TL verification for ~${awaitingH}h — your verdict needed`,
      details: {
        workItemId: wi.id,
        title: wi.title,
        type: wi.type,
        target: wi.target ?? null,
        awaitingMs,
        requestId: wi.requestId ?? null,
        missionId: wi.missionId ?? null,
      },
      workItemId: wi.id,
      missionId: wi.missionId ?? undefined,
      taskId: wi.parentWorkItemId ?? undefined,
      raisedBy: 'reconciler',
      raisedAt: new Date().toISOString(),
    };

    try {
      await this.saveEscalation(escalation);
    } catch (err) {
      this.logger.warn('Failed to persist tl_verification escalation (non-fatal)', {
        workItemId: wi.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const sanitize = (raw: string, maxLen: number): string =>
      String(raw)
        .replace(/\[[0-9;]*m/g, '')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\[(CHAT|NOTIFY|EVENT|ESCALATION)/gi, '[​$1')
        .slice(0, maxLen);
    const safeTitle = sanitize(wi.title, 200);

    const lines = [
      `[ESCALATION] WorkItem awaiting verification for ~${awaitingH}h — your verdict needed.`,
      '',
      'The worker reported this done, but the Team Leader has not verified it.',
      'Do NOT let it pass unverified — render an explicit verdict:',
      '',
      `WorkItem: ${wi.id} "${safeTitle}"`,
      `Type:     ${wi.type}`,
      `Target:   ${wi.target ?? '(unassigned)'}`,
      '',
      `Parent Request: ${wi.requestId ?? '(none)'}`,
      `Parent Mission: ${wi.missionId ?? '(none)'}`,
      '',
      'Actions:',
      '  (a) Verify against the acceptance criteria (yourself or via the TL) → accept',
      '  (b) If it falls short, reject with concrete fix instructions → the team reworks it',
      '',
      `Escalation id: ${escalationId}`,
    ];

    try {
      const { MessageQueueService } = await import('../messaging/message-queue.service.js');
      const mq = new MessageQueueService(process.cwd());
      mq.enqueue({
        content: lines.join('\n'),
        conversationId: `verify-escalation-${wi.id}-${Date.now()}`,
        source: 'system_event',
        sourceMetadata: {
          type: 'escalation',
          subtype: 'tl_verification',
          workItemId: wi.id,
          escalationId,
        },
      });
      this.logger.info('Routed tl_verification escalation to ORC via MessageQueue', {
        workItemId: wi.id,
        escalationId,
      });
    } catch (err) {
      this.logger.warn('Failed to enqueue tl_verification message for ORC (non-fatal)', {
        workItemId: wi.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return escalationId;
  }

  /**
   * List all pending escalations.
   */
  async listPending(): Promise<PendingEscalation[]> {
    try {
      await ensureDir(this.escalationsDir);
      const fs = await import('fs/promises');
      const files = await fs.readdir(this.escalationsDir);
      const escalations: PendingEscalation[] = [];

      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const data = await safeReadJson<PendingEscalation>(
          path.join(this.escalationsDir, f),
          null as unknown as PendingEscalation,
        );
        if (data && data.status === 'pending') {
          escalations.push(data);
        }
      }

      return escalations.sort(
        (a, b) => new Date(b.raisedAt).getTime() - new Date(a.raisedAt).getTime(),
      );
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private async createPendingEscalation(input: {
    source: PendingEscalation['source'];
    target: PendingEscalation['target'];
    summary: string;
    details: Record<string, unknown>;
    workItemId?: string;
    missionId?: string;
    taskId?: string;
    raisedBy: string;
  }): Promise<PendingEscalation> {
    const escalation: PendingEscalation = {
      id: uuidv4(),
      status: 'pending',
      ...input,
      raisedAt: new Date().toISOString(),
    };

    await this.saveEscalation(escalation);
    return escalation;
  }

  private async saveEscalation(escalation: PendingEscalation): Promise<void> {
    await ensureDir(this.escalationsDir);
    await atomicWriteJson(
      path.join(this.escalationsDir, `${escalation.id}.json`),
      escalation,
    );
  }

  private async loadEscalation(id: string): Promise<PendingEscalation | null> {
    return safeReadJson<PendingEscalation>(
      path.join(this.escalationsDir, `${id}.json`),
      null as unknown as PendingEscalation,
    );
  }

  // ---------------------------------------------------------------------------
  // Notification
  // ---------------------------------------------------------------------------

  /**
   * Notify human via the same channel the original request came from.
   * Falls back to Slack → Chat UI if source channel can't be determined.
   */
  private async notifyHuman(escalation: PendingEscalation): Promise<void> {
    const message = [
      escalation.summary,
      '',
      `Source: ${escalation.source}`,
      escalation.missionId ? `Mission: ${escalation.missionId}` : '',
      escalation.workItemId ? `WorkItem: ${escalation.workItemId}` : '',
      '',
      `Resolve via: POST /api/escalations/${escalation.id}/resolve`,
    ].filter(Boolean).join('\n');

    // Determine source channel from the escalation's associated WorkItem/Request
    const sourceChannel = await this.resolveSourceChannel(escalation);

    let notified = false;

    // Route to the original channel
    if (sourceChannel === 'slack' || !sourceChannel) {
      try {
        const { getSlackOrchestratorBridge } = await import('../slack/slack-orchestrator-bridge.js');
        const bridge = getSlackOrchestratorBridge();
        if (bridge) {
          await bridge.sendNotification({
            type: 'alert',
            title: 'Human Decision Required',
            message,
            urgency: 'high',
            timestamp: new Date().toISOString(),
          });
          notified = true;
        }
      } catch {
        // Slack not available
      }
    }

    // Google Chat and Telegram: use the messaging adapter pattern
    if (sourceChannel === 'google_chat' || sourceChannel === 'telegram') {
      try {
        // Route via the Slack bridge's sendNotification which handles multi-channel
        // For now, fall through to Slack as the bridge handles routing
        const { getSlackOrchestratorBridge } = await import('../slack/slack-orchestrator-bridge.js');
        const bridge = getSlackOrchestratorBridge();
        if (bridge) {
          await bridge.sendNotification({
            type: 'alert',
            title: `Human Decision Required (via ${sourceChannel})`,
            message,
            urgency: 'high',
            timestamp: new Date().toISOString(),
          });
          notified = true;
        }
      } catch {
        // Channel not available
      }
    }

    if (!notified) {
      this.logger.warn('Could not notify human via any channel', {
        escalationId: escalation.id,
        sourceChannel,
      });
    }
  }

  /**
   * Resolve the source channel for an escalation by tracing back to the
   * original Request/ChatMessage that started the work.
   */
  private async resolveSourceChannel(escalation: PendingEscalation): Promise<string | null> {
    if (!escalation.workItemId) return null;

    try {
      const taskPool = (await import('../task-pool/task-pool.service.js')).TaskPoolService.getInstance();
      const allItems = await taskPool.getAllItems();
      const wi = allItems.find((w) => w.id === escalation.workItemId);
      if (!wi?.requestId) return null;

      // Load the Request to find its source conversation
      const { RequestService } = await import('./request.service.js');
      const request = await RequestService.getInstance().getById(wi.requestId);
      if (!request?.sourceConversationItemId) return null;

      // Infer channel from conversation ID pattern
      const { inferChannelTypeFromConversationId } = await import('../../types/chat.types.js');
      return inferChannelTypeFromConversationId(request.sourceConversationItemId) ?? null;
    } catch {
      return null; // Can't determine — will fallback to default
    }
  }

  /**
   * Notify TL agent via message queue (for team_lead-targeted escalations).
   */
  private async notifyAgent(
    request: AlignmentRequest,
    workItemId: string,
    workerSession: string,
  ): Promise<void> {
    try {
      const { MessageQueueService } = await import('../messaging/message-queue.service.js');
      const mq = new MessageQueueService(process.cwd());

      mq.enqueue({
        content: [
          `[ESCALATION] Worker ${workerSession} needs alignment on task.`,
          '',
          `Issue: ${request.discoveredIssue}`,
          `Reason: ${request.reason}`,
          `Decision needed: ${request.decisionNeeded}`,
          '',
          `Options:`,
          ...request.options.map((o, i) => `  ${i + 1}. ${o.description} (impact: ${o.impact})`),
          '',
          `Worker recommends: ${request.recommendation}`,
        ].join('\n'),
        conversationId: `escalation-${workItemId}-${Date.now()}`,
        source: 'system_event',
        sourceMetadata: { type: 'escalation', workItemId, workerSession },
      });
    } catch (err) {
      this.logger.debug('Agent notification failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // WorkItem pause/resume helpers
  // ---------------------------------------------------------------------------

  private async pauseWorkItem(workItemId: string): Promise<void> {
    try {
      const taskPool = (await import('../task-pool/task-pool.service.js')).TaskPoolService.getInstance();
      await taskPool.updateItemStatus(workItemId, 'blocked');
    } catch {
      // Non-fatal
    }
  }

  private async resumeWorkItem(workItemId: string): Promise<void> {
    try {
      const taskPool = (await import('../task-pool/task-pool.service.js')).TaskPoolService.getInstance();
      await taskPool.updateItemStatus(workItemId, 'queued');
    } catch {
      // Non-fatal
    }
  }
}
