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

/**
 * Default polling interval (minutes) when no setting is configured.
 *
 * Mirrors `getDefaultSettings().general.autonomyTickIntervalMinutes` so a
 * settings load failure or a fresh boot before disk read still yields the
 * documented default behavior. Spec
 * 2026-05-06-task-management-v1-deprecation.md.
 */
const DEFAULT_POLLING_INTERVAL_MINUTES = 5;

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
   *
   * The polling cadence is read from
   * `settings.general.autonomyTickIntervalMinutes` (default 5 minutes).
   * A value of `0` disables polling entirely — autonomy then runs purely
   * on the `agent:idle` / `task:done` event path. The settings read is
   * non-blocking and failure-soft: any error falls back to the default.
   */
  async start(): Promise<void> {
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

    // Resolve polling cadence from user settings.
    const pollingIntervalMinutes = await this.resolvePollingIntervalMinutes();
    const pollingIntervalMs = pollingIntervalMinutes * 60_000;

    if (pollingIntervalMs > 0) {
      this.pollingTimer = setInterval(() => {
        this.pollIdleAgents().catch((err) => {
          this.logger.debug('Polling failed (non-fatal)', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, pollingIntervalMs);
    }

    // Startup recovery: check for queued tasks with offline target agents
    setTimeout(() => {
      this.recoverPendingTasks().catch((err) => {
        this.logger.warn('Pending task recovery failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 15_000); // Wait 15s for agents to register after startup

    this.logger.info('AgentAutoClaimService started', {
      pollingIntervalMinutes,
      pollingDisabled: pollingIntervalMs === 0,
      minScoreThreshold: MIN_SCORE_THRESHOLD,
    });
  }

  /**
   * Read `general.autonomyTickIntervalMinutes` from settings, falling back
   * to the default on any failure (file missing, parse error, validation
   * failure). Kept as a separate helper so `start()` stays simple and the
   * settings dependency can be swapped in tests.
   */
  private async resolvePollingIntervalMinutes(): Promise<number> {
    try {
      const { getSettingsService } = await import('../settings/settings.service.js');
      const settings = await getSettingsService().getSettings();
      const raw = settings.general?.autonomyTickIntervalMinutes;
      if (typeof raw === 'number' && raw >= 0) return raw;
    } catch (err) {
      this.logger.debug('Settings read failed — using autonomy tick default', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return DEFAULT_POLLING_INTERVAL_MINUTES;
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

    // Notify the worker. Without this, an auto-claimed WI sits in
    // `running` with the agent's session as `target` but the agent never
    // hears about it — manifesting as "Request created → WIs claimed →
    // nothing executes". Hand off to WorkItemDispatchSubscriber so the
    // [CREWLY-DISPATCH] write goes through the same idempotent path
    // queued-WIs already use.
    //
    // `result.workItem` carries the claim-time WI snapshot with `target`
    // already set, which is what `dispatchTo` expects.
    //
    // If dispatch fails here (transient HTTP error, agent restarting),
    // the WI is in `running` state — the dispatch subscriber's recovery
    // scan only re-checks `queued` items, so this path doesn't auto-recover.
    // The agent will pick it up the next time it polls (`get-my-tasks`)
    // or on its next idle tick (which retriggers AutoClaim, which sees
    // the existing claim and skips). Acceptable tradeoff for now.
    try {
      const { WorkItemDispatchSubscriber } = await import('./workitem-dispatch.subscriber.js');
      await WorkItemDispatchSubscriber.getInstance().dispatchTo(result.workItem);
    } catch (dispatchErr) {
      this.logger.warn('Post-claim dispatch failed — agent may not be notified', {
        workItemId: best.workItem.id,
        agentSessionName,
        error: dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr),
      });
    }

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
    const activeTargetedItems: typeof targetedItems = [];

    for (const wi of targetedItems) {
      if (!wi.target) continue;

      if (activeSessions.has(wi.target)) {
        // Agent is active — historically we skipped here on the assumption
        // that "an active agent will claim the task on its own". Empirically
        // (2026-05-06 dogfood) that assumption is broken: an agent that
        // returned from a session-history reload, or that is mid-thought
        // when the WI lands, never emits `agent:idle` and therefore never
        // triggers AutoClaim's pull path. Hand off to the dispatch
        // subscriber instead — it pushes a [CREWLY-DISPATCH] prompt to the
        // target session telling them to run poll-tasks.
        activeTargetedItems.push(wi);
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

    // Dispatch to active targets. Best-effort, non-fatal — the
    // WorkItemDispatchSubscriber will also rerun via its own startup
    // backfill ~10s after this returns, so a transient failure here
    // doesn't strand the WI.
    if (activeTargetedItems.length > 0) {
      try {
        const { WorkItemDispatchSubscriber } = await import('./workitem-dispatch.subscriber.js');
        const dispatcher = WorkItemDispatchSubscriber.getInstance();
        let dispatched = 0;
        for (const wi of activeTargetedItems) {
          if (await dispatcher.dispatchTo(wi)) dispatched += 1;
        }
        this.logger.info('Dispatched queued WIs to active target sessions', {
          attempted: activeTargetedItems.length,
          dispatched,
        });
      } catch (err) {
        this.logger.warn('Active-target dispatch failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Wake known offline agents via correct team member start endpoint
    for (const session of agentsToWake) {
      try {
        // Find team and member ID for this session
        const axios = (await import('axios')).default;
        const teamsResp = await axios.get('http://localhost:8787/api/teams');
        let teamId: string | null = null;
        let memberId: string | null = null;

        for (const team of teamsResp.data?.data ?? []) {
          const member = (team.members ?? []).find((m: { sessionName: string }) => m.sessionName === session);
          if (member) {
            teamId = team.id;
            memberId = member.id;
            break;
          }
        }

        if (teamId && memberId) {
          await axios.post(`http://localhost:8787/api/teams/${teamId}/members/${memberId}/start`);
          this.logger.info('Waking offline agent for pending tasks', { sessionName: session, teamId, memberId });
        } else {
          // Agent session exists in health map but not found in teams — treat as orphan
          orphanedItems.push(...targetedItems.filter((wi) => wi.target === session));
          this.logger.warn('Agent session in health map but not in teams', { sessionName: session });
        }
      } catch (err) {
        this.logger.warn('Failed to wake agent — will escalate to Orchestrator', {
          sessionName: session,
          error: err instanceof Error ? err.message : String(err),
        });
        // Wake failed → escalate these tasks too
        orphanedItems.push(...targetedItems.filter((wi) => wi.target === session));
      }
    }

    // Escalate orphaned tasks — notify Orchestrator via Slack (reliable delivery)
    if (orphanedItems.length > 0) {
      try {
        const orphanSummary = orphanedItems
          .map((wi) => `- "${wi.title.substring(0, 60)}" (target: ${wi.target})`)
          .join('\n');

        const message = [
          `[RECOVERY] ${orphanedItems.length} queued task(s) have target agents that no longer exist or could not be woken.`,
          '',
          orphanSummary,
          '',
          'Please re-assign via delegate-task or cancel if no longer needed.',
        ].join('\n');

        // Try Slack notification first (most reliable — goes directly to human)
        try {
          const { getSlackOrchestratorBridge } = await import('../slack/slack-orchestrator-bridge.js');
          const bridge = getSlackOrchestratorBridge();
          if (bridge) {
            await bridge.sendNotification({
              type: 'alert',
              title: 'Task Recovery: Orphaned Tasks Need Attention',
              message,
              urgency: 'high',
              timestamp: new Date().toISOString(),
            });
          }
        } catch {
          // Slack not available — fall through
        }

        // Also create a persistent escalation record for tracking
        try {
          const { EscalationRouterService } = await import('./escalation-router.service.js');
          const router = EscalationRouterService.getInstance();
          for (const wi of orphanedItems) {
            await router.routePolicyEscalation(
              { id: 'system', objective: 'Task Recovery', policy: {} } as any,
              { condition: 'scope_change', threshold: 0, escalateTo: 'user', action: 'notify' },
              {},
            );
          }
        } catch {
          // Best-effort
        }

        this.logger.info('Escalated orphaned tasks for human review', {
          count: orphanedItems.length,
          targets: [...new Set(orphanedItems.map((wi) => wi.target))],
        });
      } catch (err) {
        this.logger.warn('Failed to escalate orphaned tasks', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (agentsToWake.size > 0 || orphanedItems.length > 0 || activeTargetedItems.length > 0) {
      this.logger.info('Startup task recovery complete', {
        agentsWoken: agentsToWake.size,
        orphanedEscalated: orphanedItems.length,
        activeTargetsDispatched: activeTargetedItems.length,
        totalTargetedQueued: targetedItems.length,
      });
    }
  }
}
