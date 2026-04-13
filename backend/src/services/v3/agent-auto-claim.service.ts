/**
 * Agent Auto-Claim Service
 *
 * Automatically assigns work to idle agents. When an agent finishes a task
 * and goes idle, this service finds the best available WorkItem and claims
 * it for the agent — creating a continuous execution loop.
 *
 * Trigger sources:
 * - EventBus `agent:idle` events (primary, event-driven)
 * - EventBus `task:done` events (claim next for completing agent)
 * - Polling every 60s (backup, catches missed events)
 *
 * Complements Hybrid Wake (no conflict):
 * - Hybrid Wake = "unclaimed tasks find dormant agents" (push)
 * - AutoClaim = "idle agents find unclaimed tasks" (pull)
 *
 * @module services/v3/agent-auto-claim.service
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { computeAgentScore, type AgentHealth } from '../reconciler/reconcile-rules.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Polling interval for scanning idle agents (ms) */
const POLLING_INTERVAL_MS = 60_000;

/** Minimum score threshold — don't auto-claim poor matches */
const MIN_SCORE_THRESHOLD = 15;

/** Per-agent debounce window to avoid rapid re-trigger (ms) */
const DEBOUNCE_MS = 3_000;

/** Service identifier for logging */
const SERVICE_NAME = 'AgentAutoClaim';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AgentAutoClaimService {
  private static instance: AgentAutoClaimService | null = null;

  private readonly logger: ComponentLogger;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private eventBusService: { on: (event: string, handler: (...args: unknown[]) => void) => void } | null = null;
  private agentHealthProvider: (() => Promise<Map<string, AgentHealth>>) | null = null;
  private lastClaimAttempt = new Map<string, number>(); // agentId → timestamp

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger(SERVICE_NAME);
  }

  public static getInstance(): AgentAutoClaimService {
    if (!AgentAutoClaimService.instance) {
      AgentAutoClaimService.instance = new AgentAutoClaimService();
    }
    return AgentAutoClaimService.instance;
  }

  public static resetInstance(): void {
    AgentAutoClaimService.instance = null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Initialize with EventBus and agent health data source.
   *
   * @param eventBusService - EventBusService for subscribing to agent events
   * @param agentHealthProvider - Function that returns the current agent health map
   */
  initialize(
    eventBusService: { on: (event: string, handler: (...args: unknown[]) => void) => void },
    agentHealthProvider?: () => Promise<Map<string, AgentHealth>>,
  ): void {
    this.eventBusService = eventBusService;
    this.agentHealthProvider = agentHealthProvider ?? null;
  }

  /**
   * Start listening for events and polling.
   */
  start(): void {
    if (!this.eventBusService) {
      this.logger.warn('Cannot start — EventBusService not initialized');
      return;
    }

    // Listen for all published events, filter internally
    this.eventBusService.on('event_published', (payload: unknown) => {
      const event = payload as { eventType?: string; sessionName?: string };
      if (!event?.eventType || !event?.sessionName) return;

      if (event.eventType === 'agent:idle' || event.eventType === 'task:done') {
        this.onAgentIdleOrTaskDone(event.sessionName);
      }
    });

    // Polling backup
    this.pollingTimer = setInterval(() => {
      this.pollIdleAgents().catch((err) => {
        this.logger.debug('Polling failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, POLLING_INTERVAL_MS);

    // Startup recovery: check for queued tasks with offline target agents
    setTimeout(() => {
      this.recoverPendingTasks().catch((err) => {
        this.logger.debug('Pending task recovery failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 15_000); // Wait 15s for agents to register after startup

    this.logger.info('AgentAutoClaimService started', {
      pollingIntervalMs: POLLING_INTERVAL_MS,
      minScoreThreshold: MIN_SCORE_THRESHOLD,
    });
  }

  /**
   * Stop polling and clean up.
   */
  stop(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    this.logger.info('AgentAutoClaimService stopped');
  }

  // ---------------------------------------------------------------------------
  // Core Logic
  // ---------------------------------------------------------------------------

  /**
   * Handle an agent:idle or task:done event.
   * Debounces per agent to avoid rapid re-trigger.
   *
   * @param agentSessionName - The agent that went idle or completed a task
   */
  private onAgentIdleOrTaskDone(agentSessionName: string): void {
    const now = Date.now();
    const lastAttempt = this.lastClaimAttempt.get(agentSessionName) ?? 0;

    if (now - lastAttempt < DEBOUNCE_MS) return;

    this.lastClaimAttempt.set(agentSessionName, now);

    // Fire-and-forget — auto-claim must never block the event loop
    this.tryAutoClaimForAgent(agentSessionName).catch((err) => {
      this.logger.debug('Auto-claim attempt failed (non-fatal)', {
        agentSessionName,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Find the best available WorkItem for a given agent and claim it.
   *
   * Steps:
   * 1. Get available items from TaskPool
   * 2. Get agent health info
   * 3. Score each item for this agent using computeAgentScore()
   * 4. Claim the highest-scoring item above the threshold
   *
   * @param agentSessionName - Agent to find work for
   * @returns The claim result, or null if nothing suitable
   */
  async tryAutoClaimForAgent(agentSessionName: string): Promise<{ workItemId: string; score: number } | null> {
    const taskPool = TaskPoolService.getInstance();

    // Get available unclaimed items
    const availableItems = await taskPool.getAvailableItems();
    if (availableItems.length === 0) return null;

    // Build agent health info for scoring
    const agentHealth = await this.getAgentHealth(agentSessionName);
    if (!agentHealth) return null;

    // Score each available item for this agent
    const scored: Array<{ workItem: WorkItem; score: number }> = [];
    const now = Date.now();

    for (const wi of availableItems) {
      const waitTimeMs = now - new Date(wi.createdAt).getTime();
      const breakdown = computeAgentScore(wi, agentHealth, waitTimeMs);
      const score = breakdown.skillMatch + breakdown.urgency + breakdown.contextFamiliarity - breakdown.loadPenalty;

      if (score >= MIN_SCORE_THRESHOLD) {
        scored.push({ workItem: wi, score });
      }
    }

    if (scored.length === 0) return null;

    // Sort by score descending, pick best
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    // Claim the specific item
    const result = await taskPool.claimSpecificItem(agentSessionName, best.workItem.id);
    if (!result) {
      // Race condition: item was claimed by someone else
      this.logger.debug('Auto-claim race: item already claimed', {
        workItemId: best.workItem.id,
        agentSessionName,
      });
      return null;
    }

    this.logger.info('Auto-claimed WorkItem for idle agent', {
      workItemId: best.workItem.id,
      agentSessionName,
      score: best.score,
      title: best.workItem.title,
    });

    return { workItemId: best.workItem.id, score: best.score };
  }

  /**
   * Scan all idle agents and try auto-claiming for each.
   * Polling backup for when events are missed.
   */
  private async pollIdleAgents(): Promise<void> {
    if (!this.agentHealthProvider) return;

    const healthMap = await this.agentHealthProvider();
    const idleAgents: string[] = [];

    for (const [sessionName, health] of healthMap) {
      if (health.status === 'active' && (health.activeWorkItemCount ?? 0) === 0) {
        idleAgents.push(sessionName);
      }
    }

    if (idleAgents.length === 0) return;

    for (const agentId of idleAgents) {
      await this.tryAutoClaimForAgent(agentId).catch(() => {
        // Individual failures are non-fatal
      });
    }
  }

  /**
   * Build AgentHealth info for a specific agent.
   *
   * @param sessionName - Agent session name
   * @returns AgentHealth or null if agent not found
   */
  private async getAgentHealth(sessionName: string): Promise<AgentHealth | null> {
    if (this.agentHealthProvider) {
      const healthMap = await this.agentHealthProvider();
      return healthMap.get(sessionName) ?? null;
    }

    // Fallback: return a basic AgentHealth with just the session name
    return {
      sessionName,
      status: 'active',
    };
  }

  // ---------------------------------------------------------------------------
  // Startup Recovery — handle queued tasks with offline target agents
  // ---------------------------------------------------------------------------

  /**
   * On startup, check for queued tasks whose target agents are offline.
   * For each:
   * - If agent exists in teams.json → attempt to wake via start-agent API
   * - If agent does NOT exist → escalate to Orchestrator for human confirmation
   */
  private async recoverPendingTasks(): Promise<void> {
    const taskPool = TaskPoolService.getInstance();
    const availableItems = await taskPool.getAvailableItems();

    // Find queued items with a specific target
    const targetedItems = availableItems.filter((wi) => wi.target);
    if (targetedItems.length === 0) return;

    // Get all known agent sessions from teams
    const knownSessions = new Set<string>();
    const activeSessions = new Set<string>();

    if (this.agentHealthProvider) {
      const healthMap = await this.agentHealthProvider();
      for (const [session, health] of healthMap) {
        knownSessions.add(session);
        if (health.status === 'active' || health.status === 'started') {
          activeSessions.add(session);
        }
      }
    } else {
      // Fallback: load teams from API
      try {
        const axios = (await import('axios')).default;
        const response = await axios.get('http://localhost:8787/api/teams');
        for (const team of response.data?.data ?? []) {
          for (const member of team.members ?? []) {
            knownSessions.add(member.sessionName);
            if (member.agentStatus === 'active' || member.agentStatus === 'starting') {
              activeSessions.add(member.sessionName);
            }
          }
        }
      } catch {
        return; // Can't determine agent status, skip recovery
      }
    }

    const agentsToWake = new Set<string>();
    const orphanedItems: typeof targetedItems = [];

    for (const wi of targetedItems) {
      if (!wi.target) continue;

      if (activeSessions.has(wi.target)) {
        // Agent is active — it should claim the task normally
        continue;
      }

      if (knownSessions.has(wi.target)) {
        // Agent exists but is offline → needs to be woken
        agentsToWake.add(wi.target);
      } else {
        // Agent doesn't exist in any team → orphaned task
        orphanedItems.push(wi);
      }
    }

    // Wake known offline agents
    for (const session of agentsToWake) {
      try {
        const axios = (await import('axios')).default;
        await axios.post('http://localhost:8787/api/agents/start', {
          sessionName: session,
        });
        this.logger.info('Waking offline agent for pending tasks', { sessionName: session });
      } catch (err) {
        this.logger.debug('Failed to wake agent (non-fatal)', {
          sessionName: session,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Escalate orphaned tasks to Orchestrator for human confirmation
    if (orphanedItems.length > 0) {
      try {
        const { MessageQueueService } = await import('../messaging/message-queue.service.js');
        const mq = new MessageQueueService(process.cwd());

        const orphanSummary = orphanedItems
          .map((wi) => `- "${wi.title.substring(0, 60)}" (target: ${wi.target})`)
          .join('\n');

        mq.enqueue({
          content: [
            `[RECOVERY] ${orphanedItems.length} queued task(s) have target agents that no longer exist in any team.`,
            '',
            'These tasks may have been assigned before a restart to agents that have since been removed:',
            orphanSummary,
            '',
            'Please review and either:',
            '1. Re-assign these tasks to active agents via delegate-task',
            '2. Cancel them if no longer needed',
          ].join('\n'),
          conversationId: `recovery-orphaned-tasks-${Date.now()}`,
          source: 'system_event',
          sourceMetadata: { type: 'task-recovery', orphanCount: orphanedItems.length },
        });

        this.logger.info('Escalated orphaned tasks to Orchestrator', {
          count: orphanedItems.length,
          targets: [...new Set(orphanedItems.map((wi) => wi.target))],
        });
      } catch (err) {
        this.logger.debug('Failed to escalate orphaned tasks (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (agentsToWake.size > 0 || orphanedItems.length > 0) {
      this.logger.info('Startup task recovery complete', {
        agentsWoken: agentsToWake.size,
        orphanedEscalated: orphanedItems.length,
        totalTargetedQueued: targetedItems.length,
      });
    }
  }
}
