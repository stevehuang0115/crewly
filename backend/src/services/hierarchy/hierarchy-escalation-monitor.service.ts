/**
 * Hierarchy Escalation Monitor
 *
 * Runtime wiring for {@link HierarchyEscalationService}, which documents
 * the "TL unresponsive → bypass to the orchestrator" rule but had no
 * consumers: nothing recorded TL responses, nothing checked the timeout,
 * nothing routed the bypass.
 *
 * The signal we have today for "a worker escalated to their TL" is the
 * verification handoff: `task:done_by_worker` puts a WorkItem in the TL's
 * court, and `task:verified` / `task:rejected` is the TL's response. So:
 *
 *   - `task:done_by_worker`   → remember `{ workItemId, workerSession, since }`
 *   - `task:verified|rejected` → forget it; `recordTLResponse(tlSession)`
 *   - every {@link DEFAULT_SWEEP_INTERVAL_MS}: for each pending handoff
 *     older than {@link DEFAULT_TL_ACK_TIMEOUT_MS} whose WI is still
 *     `done_by_worker`, resolve the worker's TL from the team hierarchy,
 *     call `handleTLUnresponsive` (publishes `hierarchy:escalation`) and
 *     enqueue an `[ESCALATION]` system event to the orchestrator — once
 *     per WorkItem.
 *
 * What is still missing for a fuller implementation: an explicit
 * "TL acknowledged" signal distinct from the verdict (a TL who has *seen*
 * the item but is still reviewing looks identical to one who is gone),
 * and inclusion of non-verification escalations (a worker's free-text
 * report-status escalation does not produce a WorkItem the monitor can
 * track).
 *
 * @module services/hierarchy/hierarchy-escalation-monitor.service
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { StorageService } from '../core/storage.service.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { HierarchyEscalationService } from './hierarchy-escalation.service.js';
import type { EventBusService, InProcessUnsubscribe } from '../event-bus/event-bus.service.js';
import type { AgentEvent, EventType } from '../../types/event-bus.types.js';
import type { Team, TeamMember } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { pickTeamLead } from '../../utils/team.utils.js';
import { formatError } from '../../utils/format-error.js';
import { MESSAGE_SOURCES, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long a TL may sit on a worker's handoff before the bypass fires. */
export const DEFAULT_TL_ACK_TIMEOUT_MS = 15 * 60 * 1000;

/** Cadence of the pending-handoff sweep. */
export const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Conversation id stamped on the orchestrator-bound bypass message. */
export const HIERARCHY_ESCALATION_CONVERSATION_ID = 'system_hierarchy_escalation';

/** Envelope prefix for the bypass message. */
export const HIERARCHY_ESCALATION_ENVELOPE_PREFIX = '[ESCALATION]';

/** Bounded size of the escalated-WI dedup list. */
const ESCALATED_DEDUP_CAPACITY = 1000;

/** WorkItem status meaning "waiting on the TL". */
const AWAITING_TL_STATUS = 'done_by_worker';

/** Events that open a pending handoff. */
const OPEN_EVENTS: readonly EventType[] = ['task:done_by_worker'] as const;

/** Events that close a pending handoff (the TL responded). */
const CLOSE_EVENTS: readonly EventType[] = ['task:verified', 'task:rejected', 'task:cancelled'] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal pool surface. */
export interface HierarchyMonitorTaskPool {
  findWorkItem(id: string): Promise<WorkItem | null | undefined>;
}

/** Minimal queue surface. */
export interface HierarchyMonitorMessageQueue {
  enqueue(input: {
    content: string;
    conversationId: string;
    source: typeof MESSAGE_SOURCES.SYSTEM_EVENT;
    targetSession?: string;
    sourceMetadata?: Record<string, unknown>;
  }): unknown;
}

/** Injectable dependencies. */
export interface HierarchyEscalationMonitorDependencies {
  eventBus: EventBusService;
  messageQueue: HierarchyMonitorMessageQueue;
  taskPool?: HierarchyMonitorTaskPool;
  getTeams?: () => Promise<Team[]>;
  escalation?: HierarchyEscalationService;
  logger?: ComponentLogger;
  now?: () => Date;
  /** Override the TL acknowledgement timeout (ms). */
  ackTimeoutMs?: number;
  /** Override the sweep cadence (ms). `0` disables the timer (tests call `sweep()`). */
  sweepIntervalMs?: number;
}

/** A worker→TL handoff awaiting the TL's verdict. */
interface PendingHandoff {
  workItemId: string;
  workerSession: string;
  since: number;
}

/** Outcome of one sweep. */
export interface HierarchySweepResult {
  pending: number;
  escalated: string[];
  cleared: string[];
}

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

/**
 * Tracks worker→TL handoffs and bypasses an unresponsive TL. See module docs.
 */
export class HierarchyEscalationMonitor {
  private readonly eventBus: EventBusService;
  private readonly messageQueue: HierarchyMonitorMessageQueue;
  private readonly taskPool: HierarchyMonitorTaskPool;
  private readonly getTeams: () => Promise<Team[]>;
  private readonly escalation: HierarchyEscalationService;
  private readonly logger: ComponentLogger;
  private readonly now: () => Date;
  private readonly ackTimeoutMs: number;
  private readonly sweepIntervalMs: number;
  private readonly pending = new Map<string, PendingHandoff>();
  private readonly escalated: string[] = [];
  private unsubscribers: InProcessUnsubscribe[] = [];
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private readonly pendingDispatches: Set<Promise<void>> = new Set();

  constructor(deps: HierarchyEscalationMonitorDependencies) {
    this.eventBus = deps.eventBus;
    this.messageQueue = deps.messageQueue;
    this.taskPool = deps.taskPool ?? TaskPoolService.getInstance();
    this.getTeams = deps.getTeams ?? (() => StorageService.getInstance().getTeams());
    this.escalation = deps.escalation ?? HierarchyEscalationService.getInstance();
    this.logger =
      deps.logger ??
      LoggerService.getInstance().createComponentLogger('HierarchyEscalationMonitor');
    this.now = deps.now ?? (() => new Date());
    this.ackTimeoutMs = deps.ackTimeoutMs ?? DEFAULT_TL_ACK_TIMEOUT_MS;
    this.sweepIntervalMs = deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  }

  /**
   * Production wiring helper.
   *
   * @param eventBus - Live event bus
   * @param messageQueue - Orchestrator message queue
   * @returns A monitor ready to `start()`
   */
  static boot(eventBus: EventBusService, messageQueue: HierarchyMonitorMessageQueue): HierarchyEscalationMonitor {
    return new HierarchyEscalationMonitor({ eventBus, messageQueue });
  }

  /** Subscribe + arm the sweep timer. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.escalation.setEventBus(this.eventBus);
    this.escalation.setUnresponsiveTimeout(this.ackTimeoutMs);

    for (const type of OPEN_EVENTS) {
      this.unsubscribers.push(this.eventBus.onInProcess(type, (e) => this.safeDispatch(e, this.onOpen)));
    }
    for (const type of CLOSE_EVENTS) {
      this.unsubscribers.push(this.eventBus.onInProcess(type, (e) => this.safeDispatch(e, this.onClose)));
    }

    if (this.sweepIntervalMs > 0) {
      this.timer = setInterval(() => {
        this.sweep().catch((err) => {
          this.logger.warn('Hierarchy escalation sweep failed', { error: formatError(err) });
        });
      }, this.sweepIntervalMs);
      this.timer.unref?.();
    }
    this.logger.info('HierarchyEscalationMonitor started', {
      ackTimeoutMs: this.ackTimeoutMs,
      sweepIntervalMs: this.sweepIntervalMs,
    });
  }

  /** Detach subscriptions and stop the timer. Idempotent. */
  stop(): void {
    for (const u of this.unsubscribers) {
      try {
        u();
      } catch (err) {
        this.logger.warn('HierarchyEscalationMonitor unsubscribe threw', { error: formatError(err) });
      }
    }
    this.unsubscribers = [];
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  /** Await in-flight event handlers. Test affordance. */
  async flushPending(): Promise<void> {
    while (this.pendingDispatches.size > 0) {
      await Promise.allSettled(Array.from(this.pendingDispatches));
    }
  }

  /** Number of handoffs currently awaiting a TL verdict. */
  get pendingCount(): number {
    return this.pending.size;
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  private safeDispatch(event: AgentEvent, handler: (event: AgentEvent) => Promise<void>): Promise<void> {
    const promise = (async () => {
      try {
        await handler(event);
      } catch (err) {
        this.logger.warn('HierarchyEscalationMonitor handler threw — swallowed', {
          eventType: event.type,
          eventId: event.id,
          error: formatError(err),
        });
      }
    })();
    this.pendingDispatches.add(promise);
    promise.finally(() => this.pendingDispatches.delete(promise));
    return promise;
  }

  /** `task:done_by_worker` — open a pending handoff keyed on the WI. */
  private onOpen = async (event: AgentEvent): Promise<void> => {
    if (!event.workItemId) return;
    const wi = await this.taskPool.findWorkItem(event.workItemId);
    if (!wi || !wi.target) return;
    this.pending.set(wi.id, {
      workItemId: wi.id,
      workerSession: wi.target,
      since: this.now().getTime(),
    });
  };

  /** `task:verified|rejected|cancelled` — the TL (or system) responded. */
  private onClose = async (event: AgentEvent): Promise<void> => {
    if (!event.workItemId) return;
    const handoff = this.pending.get(event.workItemId);
    this.pending.delete(event.workItemId);
    if (!handoff || event.type === 'task:cancelled') return;
    const resolved = await this.resolveChain(handoff.workerSession);
    if (resolved?.teamLead) {
      this.escalation.recordTLResponse(resolved.teamLead.sessionName);
    }
  };

  // -------------------------------------------------------------------------
  // Sweep
  // -------------------------------------------------------------------------

  /**
   * Escalate every pending handoff older than the ack timeout whose WI is
   * still waiting on the TL. Safe to call directly (tests, ops).
   *
   * @returns Summary of what happened
   */
  async sweep(): Promise<HierarchySweepResult> {
    const nowMs = this.now().getTime();
    const result: HierarchySweepResult = { pending: this.pending.size, escalated: [], cleared: [] };

    for (const handoff of Array.from(this.pending.values())) {
      if (nowMs - handoff.since < this.ackTimeoutMs) continue;

      const wi = await this.taskPool.findWorkItem(handoff.workItemId);
      if (!wi || wi.status !== AWAITING_TL_STATUS) {
        // Resolved out-of-band (or gone) — nothing to escalate.
        this.pending.delete(handoff.workItemId);
        result.cleared.push(handoff.workItemId);
        continue;
      }

      if (this.escalated.includes(handoff.workItemId)) {
        this.pending.delete(handoff.workItemId);
        continue;
      }

      try {
        await this.escalate(handoff, wi);
        result.escalated.push(handoff.workItemId);
      } catch (err) {
        this.logger.warn('Hierarchy escalation failed for handoff', {
          workItemId: handoff.workItemId,
          error: formatError(err),
        });
      } finally {
        this.pending.delete(handoff.workItemId);
      }
    }
    return result;
  }

  /** Fire the documented bypass for one stale handoff. */
  private async escalate(handoff: PendingHandoff, wi: WorkItem): Promise<void> {
    this.rememberEscalated(handoff.workItemId);
    const chain = await this.resolveChain(handoff.workerSession);
    const waitedMin = Math.round((this.now().getTime() - handoff.since) / 60_000);
    const message =
      `Team lead has not acted on "${wi.title}" (${wi.id}) submitted by ${handoff.workerSession} ` +
      `${waitedMin} min ago — bypassing to the orchestrator.`;

    let target: string = ORCHESTRATOR_SESSION_NAME;
    if (chain?.teamLead && chain.worker) {
      const routed = this.escalation.handleTLUnresponsive(
        chain.teamLead.sessionName,
        chain.worker,
        chain.team.members,
        wi.id,
        message,
        { teamId: chain.team.id, teamName: chain.team.name },
      );
      // The service routes to the TL's parent when one exists and publishes
      // `hierarchy:escalation` itself. A TL at the top of its team's tree
      // (the common shape) has no parent inside the team, so the service
      // returns null without publishing — the orchestrator is the documented
      // fallback and we publish the event here so subscribers still see it.
      if (routed?.target.sessionName) {
        target = routed.target.sessionName;
      } else {
        this.publishBypassEvent(chain.team, chain.worker, chain.teamLead, wi.id);
      }
    }

    this.messageQueue.enqueue({
      content: `${HIERARCHY_ESCALATION_ENVELOPE_PREFIX} ${message}`,
      conversationId: HIERARCHY_ESCALATION_CONVERSATION_ID,
      source: MESSAGE_SOURCES.SYSTEM_EVENT,
      targetSession: target,
      sourceMetadata: {
        workItemId: wi.id,
        workerSession: handoff.workerSession,
        teamLeadSession: chain?.teamLead?.sessionName,
        teamId: chain?.team.id,
        reason: 'tl_unresponsive',
      },
    });

    this.logger.info('Hierarchy escalation: TL unresponsive — bypassed', {
      workItemId: wi.id,
      workerSession: handoff.workerSession,
      teamLeadSession: chain?.teamLead?.sessionName,
      target,
    });
  }

  /** Publish `hierarchy:escalation` for the TL-at-root case (target = orchestrator). */
  private publishBypassEvent(team: Team, worker: TeamMember, teamLead: TeamMember, taskId: string): void {
    try {
      this.eventBus.publish({
        id: `hierarchy:escalation:${taskId}`,
        type: 'hierarchy:escalation',
        timestamp: this.now().toISOString(),
        teamId: team.id,
        teamName: team.name,
        memberId: worker.id,
        memberName: worker.name,
        sessionName: worker.sessionName,
        previousValue: teamLead.sessionName,
        newValue: ORCHESTRATOR_SESSION_NAME,
        changedField: 'hierarchyAction',
        taskId,
        hierarchyLevel: worker.hierarchyLevel,
        parentMemberId: worker.parentMemberId,
      });
    } catch (err) {
      this.logger.warn('hierarchy:escalation publish threw', { taskId, error: formatError(err) });
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve a worker session to its team, member record and team lead. The
   * TL is the worker's `parentMemberId` when set, else the team's canonical
   * lead via {@link pickTeamLead}. Returns `null` when the session is not a
   * team member.
   */
  private async resolveChain(
    workerSession: string,
  ): Promise<{ team: Team; worker: TeamMember; teamLead: TeamMember | null } | null> {
    let teams: Team[];
    try {
      teams = await this.getTeams();
    } catch (err) {
      this.logger.warn('Team lookup failed during hierarchy escalation', { error: formatError(err) });
      return null;
    }
    for (const team of teams) {
      const worker = team.members.find((m) => m.sessionName === workerSession);
      if (!worker) continue;
      const parent = worker.parentMemberId
        ? (team.members.find((m) => m.id === worker.parentMemberId) ?? null)
        : null;
      const teamLead = parent ?? pickTeamLead(team);
      // A worker who IS the lead has nobody above them inside the team.
      return { team, worker, teamLead: teamLead && teamLead.id !== worker.id ? teamLead : null };
    }
    return null;
  }

  private rememberEscalated(workItemId: string): void {
    this.escalated.push(workItemId);
    if (this.escalated.length > ESCALATED_DEDUP_CAPACITY) this.escalated.shift();
  }
}
