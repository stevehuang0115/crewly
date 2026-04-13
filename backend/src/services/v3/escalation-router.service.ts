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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Status of a pending human escalation. */
export type EscalationStatus = 'pending' | 'resolved' | 'expired';

/** A persisted escalation record awaiting human resolution. */
export interface PendingEscalation {
  id: string;
  status: EscalationStatus;
  /** What triggered this escalation */
  source: 'alignment_request' | 'policy_rule' | 'tl_verification' | 'manual';
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
   * Notify human via Slack (best-effort).
   */
  private async notifyHuman(escalation: PendingEscalation): Promise<void> {
    try {
      const { getSlackOrchestratorBridge } = await import('../slack/slack-orchestrator-bridge.js');
      const bridge = getSlackOrchestratorBridge();
      if (bridge) {
        await bridge.sendNotification({
          type: 'alert',
          title: 'Human Decision Required',
          message: [
            escalation.summary,
            '',
            `Source: ${escalation.source}`,
            escalation.missionId ? `Mission: ${escalation.missionId}` : '',
            escalation.workItemId ? `WorkItem: ${escalation.workItemId}` : '',
            '',
            `Resolve via: POST /api/escalations/${escalation.id}/resolve`,
          ].filter(Boolean).join('\n'),
          urgency: 'high',
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      this.logger.debug('Slack notification failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
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
