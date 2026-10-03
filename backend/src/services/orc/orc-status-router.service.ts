/**
 * Carries out {@link planOrcStatusRoute}: wakes the orchestrator, hands a
 * report to the sender's lead, records it, or holds it for the 30-minute
 * digest (specs/2026-10-01-orc-status-wakes.md).
 *
 * @module services/orc/orc-status-router.service
 */

import { MESSAGE_SOURCES, ORC_WAKE_CONSTANTS } from '../../constants.js';
import type { EnqueueMessageInput } from '../../types/messaging.types.js';
import type { Team } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { pickTeamLead } from '../../utils/team.utils.js';
import { leadAbove } from '../task-pool/untargeted-router.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { findStatusWorkItem, planOrcStatusRoute, type OrcStatusRoute } from './orc-status-routing.js';
import { OrcWakeCounter } from './orc-wake-counter.js';
import { isOrchestratorSender } from './orc-delivery-enforcer.service.js';

/** Collaborators (all injectable for tests). */
export interface OrcStatusRouterDeps {
  /** Queue a message (orchestrator, or `targetSession` for a lead) */
  enqueue: ((input: EnqueueMessageInput) => unknown) | null;
  /** Task pool items */
  poolItems(): Promise<WorkItem[]>;
  /** Every team */
  teams(): Promise<Team[]>;
  /** Orchestrator check */
  isOrchestrator(name: string): boolean;
  /** Clock */
  now(): number;
  /** Hourly counter */
  counter: OrcWakeCounter;
}

/** One status report to route. */
export interface OrcStatusReport {
  /** Report text */
  content: string;
  /** Reporting agent session */
  sender: string;
  /** Conversation the report was filed under (orchestrator turns keep it) */
  conversationId: string;
  /** Work item the report named, if any */
  workItemId?: string;
  /** The owner is waiting on the orchestrator to deliver this */
  deliveryOwed: boolean;
  /** The text as the orchestrator should see it (clipped) */
  orcText: string;
}

/** A report held for the next digest. */
interface DigestEntry {
  sender: string;
  text: string;
  actionable: boolean;
  at: number;
}

/**
 * Session of a team member (permanent agent id first, like the pool).
 *
 * @param m - Member
 * @returns Session name
 */
function sessionOf(m: { agentId?: string; sessionName?: string } | null | undefined): string | undefined {
  return m?.agentId || m?.sessionName || undefined;
}

/** Routes agent status reports; one per process. */
export class OrcStatusRouterService {
  private static instance: OrcStatusRouterService | null = null;
  private readonly logger: ComponentLogger;
  private digest: DigestEntry[] = [];
  private digestTimer: NodeJS.Timeout | null = null;

  /**
   * @param deps - Collaborators
   */
  constructor(private readonly deps: OrcStatusRouterDeps) {
    this.logger = LoggerService.getInstance().createComponentLogger('OrcStatusRouter');
  }

  /** The process-wide router, with the real collaborators. */
  static getInstance(): OrcStatusRouterService {
    if (!OrcStatusRouterService.instance) {
      OrcStatusRouterService.instance = new OrcStatusRouterService(defaultDeps());
    }
    return OrcStatusRouterService.instance;
  }

  /**
   * Replace the singleton (tests, boot wiring).
   *
   * @param router - The router, or null to drop it
   */
  static setInstance(router: OrcStatusRouterService | null): void {
    OrcStatusRouterService.instance?.stop();
    OrcStatusRouterService.instance = router;
  }

  /**
   * Wire the message queue and start the hourly counter log.
   *
   * @param enqueue - MessageQueueService.enqueue (bound), or null to unwire
   */
  setEnqueue(enqueue: ((input: EnqueueMessageInput) => unknown) | null): void {
    this.deps.enqueue = enqueue;
    if (enqueue) this.deps.counter.start();
  }

  /** Stop timers (pending digest entries are dropped). */
  stop(): void {
    if (this.digestTimer) clearTimeout(this.digestTimer);
    this.digestTimer = null;
  }

  /**
   * Route one report.
   *
   * @param report - The report
   * @returns What was done
   */
  async route(report: OrcStatusReport): Promise<OrcStatusRoute> {
    const now = this.deps.now();
    const [items, teams] = await Promise.all([
      this.deps.poolItems().catch(() => [] as WorkItem[]),
      this.deps.teams().catch(() => [] as Team[]),
    ]);
    const workItem = findStatusWorkItem(items, report.sender, report.workItemId, now);
    const lead = leadAbove(report.sender, teams);
    const senderIsLead = teams.some((t) => (t.members ?? []).some((m) => sessionOf(m) === report.sender || m.sessionName === report.sender) && sessionOf(pickTeamLead(t)) === report.sender);
    const route = planOrcStatusRoute({
      content: report.content,
      sender: report.sender,
      workItem,
      lead,
      senderIsLead,
      deliveryOwed: report.deliveryOwed,
      isOrchestrator: this.deps.isOrchestrator,
    });

    const logCtx = { sender: report.sender, workItemId: workItem?.id, preview: report.content.slice(0, 80) };
    switch (route.action) {
      case 'record':
        this.logger.info('Agent status recorded — orchestrator not woken', { ...logCtx, reason: route.reason });
        break;
      case 'orc':
        if (this.enqueue({ content: `Agent status: ${report.orcText}`, conversationId: report.conversationId, source: MESSAGE_SOURCES.SYSTEM_EVENT, sourceMetadata: { [ORC_WAKE_CONSTANTS.WAKE_CATEGORY_KEY]: route.category, authorAgentSession: report.sender } })) {
          this.deps.counter.noteRouted(route.category);
        }
        this.logger.info('Agent status routed to orchestrator', { ...logCtx, category: route.category, reason: route.reason });
        break;
      case 'team-lead': {
        const sent = this.enqueue({
          content: `Status from ${report.sender} (reports to you): ${report.orcText}`,
          conversationId: ORC_WAKE_CONSTANTS.TEAM_LEAD_CONVERSATION_ID,
          source: MESSAGE_SOURCES.SYSTEM_EVENT,
          targetSession: route.lead,
          // The turn continues the reporting agent's work: it acts for that agent's person (issue #968).
          sourceMetadata: { kind: 'agent-status', sender: report.sender, authorAgentSession: report.sender, ...(workItem ? { workItemId: workItem.id } : {}) },
        });
        this.logger.info(sent ? 'Agent status routed to its team lead' : 'Agent status could not be queued for its team lead', { ...logCtx, lead: route.lead, reason: route.reason });
        break;
      }
      case 'digest':
        this.addToDigest({ sender: report.sender, text: report.content, actionable: route.actionable, at: now });
        this.logger.info('Agent status held for the orchestrator digest', { ...logCtx, actionable: route.actionable, reason: route.reason });
        break;
    }
    return route;
  }

  /**
   * Hold a report for the digest; the first entry opens a window that
   * closes {@link ORC_WAKE_CONSTANTS.DIGEST_INTERVAL_MS} later, so digests
   * go out at most that often.
   *
   * @param entry - The report
   */
  private addToDigest(entry: DigestEntry): void {
    this.digest.push(entry);
    if (this.digestTimer) return;
    this.digestTimer = setTimeout(() => {
      this.digestTimer = null;
      this.flushDigest();
    }, ORC_WAKE_CONSTANTS.DIGEST_INTERVAL_MS);
    this.digestTimer.unref?.();
  }

  /** Entries waiting for the next digest (copy). */
  pendingDigest(): ReadonlyArray<Readonly<DigestEntry>> {
    return [...this.digest];
  }

  /**
   * Close the digest window: send one orchestrator turn when any entry is
   * actionable, otherwise drop them all.
   *
   * @returns The digest text, or null when nothing was sent
   */
  flushDigest(): string | null {
    const entries = this.digest;
    this.digest = [];
    if (this.digestTimer) clearTimeout(this.digestTimer);
    this.digestTimer = null;
    const actionable = entries.filter((e) => e.actionable);
    if (actionable.length === 0) {
      if (entries.length > 0) this.logger.info('Status digest dropped — nothing for the orchestrator to act on', { reports: entries.length });
      return null;
    }
    const max = ORC_WAKE_CONSTANTS.DIGEST_MAX_LINES;
    const lines = actionable.slice(0, max).map((e) => `- ${e.sender}: ${clipLine(e.text)}`);
    const more = actionable.length - lines.length;
    const recorded = entries.length - actionable.length;
    const text = [
      `[STATUS DIGEST] ${actionable.length} agent report(s) since the last digest that may need you:`,
      ...lines,
      ...(more > 0 ? [`- …and ${more} more`] : []),
      ...(recorded > 0 ? [`(${recorded} other report(s) were recorded for their team leads; nothing to do.)`] : []),
    ].join('\n');
    if (this.enqueue({ content: text, conversationId: ORC_WAKE_CONSTANTS.DIGEST_CONVERSATION_ID, source: MESSAGE_SOURCES.SYSTEM_EVENT, sourceMetadata: { [ORC_WAKE_CONSTANTS.WAKE_CATEGORY_KEY]: 'digest' } })) {
      this.deps.counter.noteRouted('digest');
    }
    this.logger.info('Status digest sent to the orchestrator', { actionable: actionable.length, recorded });
    return text;
  }

  /**
   * Queue a message; false when there is no queue or it refused.
   *
   * @param input - Message
   * @returns Whether it was queued
   */
  private enqueue(input: EnqueueMessageInput): boolean {
    if (!this.deps.enqueue) return false;
    try {
      this.deps.enqueue(input);
      return true;
    } catch (err) {
      this.logger.warn('Could not queue agent status', { error: err instanceof Error ? err.message : String(err), target: input.targetSession ?? 'orchestrator' });
      return false;
    }
  }
}

/**
 * One digest line: first line of the report, clipped.
 *
 * @param text - Report
 * @returns Line
 */
function clipLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const max = ORC_WAKE_CONSTANTS.DIGEST_LINE_CHARS;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The real collaborators (lazy imports keep the module light).
 *
 * @returns Deps
 */
function defaultDeps(): OrcStatusRouterDeps {
  return {
    enqueue: null,
    poolItems: async () => {
      const { TaskPoolService } = await import('../task-pool/task-pool.service.js');
      return TaskPoolService.getInstance().getAllItems();
    },
    teams: async () => {
      const { StorageService } = await import('../core/storage.service.js');
      return StorageService.getInstance().getTeams();
    },
    isOrchestrator: (name) => isOrchestratorSender(name),
    now: () => Date.now(),
    counter: OrcWakeCounter.getInstance(),
  };
}
