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
import { SLA_TRACKER_ID_PATTERN } from './workitem-dispatch.subscriber.js';
import { CREWLY_CONSTANTS } from '../../constants.js';
import { resolveCurrentSession } from '../../utils/session-resolve.utils.js';
import { pickTeamLead } from '../../utils/team.utils.js';
import type { Team } from '../../types/index.js';
import { getLocalApiBaseUrl } from '../../utils/local-api-url.utils.js';

/**
 * The orchestrator's own session name. Used to short-circuit the wake +
 * escalation paths — those paths are agent-to-agent recovery; firing
 * them with the orc as both source and target creates a self-referential
 * loop ("ORC escalates to ORC", observed 2026-05-27).
 */
const ORCHESTRATOR_SESSION_NAME = CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME;

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

/** Candidates tried per idle event before giving up (one may be claimed by a racing agent). */
const MAX_CLAIM_ATTEMPTS = 5;

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

    // Get available unclaimed items, excluding SLA tracker WIs.
    // 2026-05-12 dogfood: AutoClaim happily claimed `respond_to_user`
    // tracker WIs for crewly-orc, then `WorkItemDispatchSubscriber.dispatchTo`
    // short-circuited on the SLA tracker id pattern — leaving the WI
    // stuck in `running` with no PTY delivery, SLA breaching at 5/10 min,
    // claim revoked, infinite re-claim loop. From the user's perspective:
    // "Slack request never progresses; orc never replies." Skip these
    // here so the trackers stay claimable only by the SLA resolve path.
    const availableItems = (await taskPool.getAvailableItems()).filter(
      (wi) => !SLA_TRACKER_ID_PATTERN.test(wi.id),
    );
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

    // Items this agent may take at all (a target set to someone else can
    // never be claimed — picking one used to end the attempt and starve the
    // agent), in the ticket policy's order (ticket loop Phase 3: own rejected
    // → own unblocked → queue rejected → P0..P3, one ticket per agent);
    // score breaks nothing but the threshold.
    const scoreOf = new Map(scored.map((s) => [s.workItem.id, s.score]));
    // Only work given to this agent. Unassigned work is routed to a decider
    // (lead → orchestrator) rather than taken by whoever is idle: Think Tank
    // spent hours on the product team's items that way (2026-09-24).
    const claimable = scored
      .map((s) => s.workItem)
      .filter((wi) => wi.target === agentSessionName);
    const ordered = await taskPool.orderClaimCandidates(agentSessionName, claimable);

    let result: Awaited<ReturnType<TaskPoolService['claimSpecificItem']>> = null;
    let best: { workItem: WorkItem; score: number } | null = null;
    for (const wi of ordered.slice(0, MAX_CLAIM_ATTEMPTS)) {
      result = await taskPool.claimSpecificItem(agentSessionName, wi.id);
      if (result) {
        best = { workItem: wi, score: scoreOf.get(wi.id) ?? 0 };
        break;
      }
      // Race: claimed by someone else between read and claim — try the next.
      this.logger.debug('Auto-claim race: item already claimed', { workItemId: wi.id, agentSessionName });
    }
    if (!result || !best) return null;

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
   * Re-point orphaned queued items at an agent that exists: the member's
   * current session (matched by member-id suffix), else the lead of the team
   * whose trigger created the item. The trigger is fixed too, so the next
   * fire is right from the start.
   *
   * @param orphans - Queued items whose target is unknown
   * @returns Item id → new target session, for the items that were placed
   */
  async healOrphans(orphans: readonly WorkItem[]): Promise<Map<string, string>> {
    const placed = new Map<string, string>();
    let teams: Team[] = [];
    try {
      const { StorageService } = await import('../core/storage.service.js');
      teams = await StorageService.getInstance().getTeams();
    } catch {
      return placed;
    }
    const taskPool = TaskPoolService.getInstance();
    const { TriggerEngine } = await import('./trigger-engine.service.js');
    const engine = (() => {
      try {
        return TriggerEngine.getInstance();
      } catch {
        return null;
      }
    })();
    for (const wi of orphans) {
      if (!wi.target) continue;
      let next: string | null = null;
      let reason = '';
      const resolved = resolveCurrentSession(wi.target, teams);
      if (resolved?.renamed) {
        next = resolved.sessionName;
        reason = 'renamed_member';
      } else if (wi.triggerId && engine) {
        const trigger = engine.get(wi.triggerId);
        const team = trigger?.teamId ? teams.find((t) => t.id === trigger.teamId) : undefined;
        const lead = team ? pickTeamLead(team) : null;
        if (lead?.sessionName) {
          next = lead.sessionName;
          reason = 'team_lead_of_trigger';
        }
      }
      if (!next) continue;
      const from = wi.target;
      const moved = await taskPool.retargetQueuedItem(wi.id, next, reason).catch(() => null);
      if (!moved) continue;
      placed.set(wi.id, next);
      // Fix the source only for a rename — a lead fallback is a stand-in.
      if (reason === 'renamed_member' && wi.triggerId && engine) {
        await engine.retargetWorkItemAction(wi.triggerId, next).catch(() => false);
      }
      this.logger.info('Orphaned task re-assigned without asking the owner', { workItemId: wi.id, from, to: next, reason });
    }
    return placed;
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

    // Find queued items with a specific target. Skip SLA tracker WIs —
    // they're not dispatchable work, so waking an offline agent for one
    // would just trap the WI in a re-claim loop (see the comment in
    // `tryAutoClaimForAgent` for the full bug shape).
    const targetedItems = availableItems.filter(
      (wi) => wi.target && !SLA_TRACKER_ID_PATTERN.test(wi.id),
    );
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
        const response = await axios.get(`${getLocalApiBaseUrl()}/api/teams`);
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
    let orphanedItems: typeof targetedItems = [];
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

    // Self-heal before asking anyone: a target that is "unknown" is usually a
    // member whose session name changed (rename), still identifiable by the
    // member-id suffix; failing that, the lead of the team the item's trigger
    // belongs to takes it. Only what cannot be placed goes to the owner
    // (2026-09-24: the daily metrics task was escalated every morning because
    // its trigger still named the member's old session).
    if (orphanedItems.length > 0) {
      const healed = await this.healOrphans(orphanedItems);
      orphanedItems = orphanedItems.filter((wi) => !healed.has(wi.id));
      for (const [, session] of healed) {
        if (activeSessions.has(session)) continue;
        agentsToWake.add(session);
      }
      if (healed.size > 0) {
        const { WorkItemDispatchSubscriber } = await import('./workitem-dispatch.subscriber.js');
        const dispatcher = WorkItemDispatchSubscriber.getInstance();
        for (const [id, session] of healed) {
          if (!activeSessions.has(session)) continue;
          const wi = await taskPool.findWorkItem(id);
          if (wi) await dispatcher.dispatchTo(wi).catch(() => false);
        }
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
      // The orchestrator manages its own lifecycle (heartbeat-respawn
      // from the service wrapper / supervisor) — it is NOT a regular
      // team-member and the `POST /api/teams/:teamId/members/:memberId/start`
      // endpoint returns 400 for it. Pre-fix, that 400 routed the WI into
      // `orphanedItems` and then the escalation path "Escalated to
      // Orchestrator" — but the orchestrator IS the orchestrator, so the
      // escalation closed the loop into itself ("ORC escalates to ORC",
      // observed 2026-05-27 22:29:06 / 23:22:28). Skip both the wake
      // attempt and the escalation; the orc's supervisor will respawn it
      // and the dispatch subscriber will re-deliver targeted WIs once
      // the session is back.
      if (session === ORCHESTRATOR_SESSION_NAME) {
        this.logger.debug(
          'Skipping wake for orchestrator session — supervisor handles its respawn',
          { sessionName: session, pendingWiCount: targetedItems.filter((wi) => wi.target === session).length },
        );
        continue;
      }
      try {
        // Find team and member ID for this session
        const axios = (await import('axios')).default;
        const teamsResp = await axios.get(`${getLocalApiBaseUrl()}/api/teams`);
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
          // Name the work this wake is for. A dormant team needs the owner's
          // approval to cold-launch — except for work a real schedule created
          // (the schedule IS the approval), which the start endpoint can only
          // verify when it is told which item the wake is for. Without this the
          // renamed-member heal above was refused for a daily cron (2026-09-24).
          const forSession = (await taskPool.getAvailableItems()).filter((wi) => wi.target === session);
          const reason = forSession.find((wi) => wi.triggerId) ?? forSession[0];
          await axios.post(
            `${getLocalApiBaseUrl()}/api/teams/${teamId}/members/${memberId}/start`,
            reason ? { workItemId: reason.id } : undefined,
          );
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

    // Belt-and-suspenders: a WI whose target IS the orchestrator must
    // never enter the escalation path — the path delivers via
    // [RECOVERY] alerts that route back to the orc, which is the same
    // session that "owns" the WI. Filter them out and log so ops sees
    // why no alert fired for orc-targeted tasks.
    const orcOrphans = orphanedItems.filter((wi) => wi.target === ORCHESTRATOR_SESSION_NAME);
    if (orcOrphans.length > 0) {
      this.logger.debug(
        'Dropping orchestrator-targeted items from escalation list (would create self-loop)',
        { count: orcOrphans.length, workItemIds: orcOrphans.map((wi) => wi.id) },
      );
    }
    orphanedItems = orphanedItems.filter((wi) => wi.target !== ORCHESTRATOR_SESSION_NAME);

    // Escalate orphaned tasks — notify Orchestrator via Slack (reliable delivery)
    if (orphanedItems.length > 0) {
      try {
        const orphanSummary = orphanedItems
          .map((wi) => `- "${wi.title.substring(0, 60)}" (target: ${wi.target})`)
          .join('\n');

        const message = [
          `[RECOVERY] ${orphanedItems.length} queued task(s) point at an agent that no longer exists or could not be started, and no current member or team lead could be found to take them over automatically.`,
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

        // Also create a persistent escalation record for tracking. Record
        // only — the Slack alert above is the notification; routing these
        // through the policy path sent a second, contentless one.
        try {
          const { EscalationRouterService } = await import('./escalation-router.service.js');
          const router = EscalationRouterService.getInstance();
          for (const wi of orphanedItems) {
            await router.recordOrphanedWorkItem({ id: wi.id, title: wi.title, target: wi.target });
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
