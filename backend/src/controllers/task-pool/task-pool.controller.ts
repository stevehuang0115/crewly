/**
 * Task Pool Controller — HTTP handlers for Task Pool API
 *
 * Endpoints:
 * - GET  /api/task-pool       — list all claimable WorkItems
 * - POST /api/task-pool/claim — agent claims next available item
 * - POST /api/task-pool/release/:workItemId — release item back to pool
 * - GET  /api/task-pool/stats — pool statistics snapshot
 *
 * @module controllers/task-pool/task-pool.controller
 */

import type { Request, Response } from 'express';
import {
  TaskPoolService,
  WorkItemClaimedError,
  type PoolFilters,
} from '../../services/task-pool/task-pool.service.js';
import { TaskProjectionService } from '../../services/v3/task-projection.service.js';
import { ServiceContractGate } from '../../services/v3/service-contract-gate.service.js';
import { StorageService } from '../../services/core/storage.service.js';
import { GiveUpRecoveryService, type StopOutcome } from '../../services/task-pool/give-up/give-up-recovery.service.js';
import { computeGiveUpStats } from '../../services/task-pool/give-up/give-up-stats.js';
import type { TokenUsage } from '../../types/v3/task-record.types.js';
import {
  WORK_ITEM_TYPES,
  isValidWorkItemType,
  createWorkItem,
  validateCreateWorkItemInput,
  type CreateWorkItemInput,
  type WorkItem,
  ForbiddenTransitionError,
} from '../../types/v2/work-item.types.js';
import { formatError } from '../../utils/format-error.js';
import { TeamBudgetExceededError } from '../../services/budget/team-budget-gate.service.js';
import { LoggerService } from '../../services/core/logger.service.js';
import { ORCHESTRATOR_SESSION_NAME, PROJECT_TICKET_CONSTANTS, OPEN_ITEMS_CONSTANTS, PEOPLE_CONSTANTS, COMPLETION_EVIDENCE_CONSTANTS, TEAM_PAUSE_CONSTANTS } from '../../constants.js';
import { decideCompletion, resolveEvidenceEnforcementMode } from '../../services/task-pool/completion-evidence.service.js';
import { readAgentSessionHeader, resolveTransitionActor } from '../../utils/agent-caller.utils.js';
import { getTicketIntakeService } from '../../services/v3/ticket-intake.service.js';
import { ownerThreadHandover } from '../../services/orc/work-item-destination.js';
import { TlDelegationService } from '../../services/tl-delegation/tl-delegation.service.js';
import { isTicketNumberRef } from '../../types/v2/ticket.types.js';
import { ProjectTicketError } from '../../services/project-tickets/project-ticket.service.js';
import type { RoutedDelegation } from '../../services/project-tickets/project-ticket-workflow.service.js';
import { projectTicketWorkflow } from '../project-tickets/project-tickets.controller.js';
import { wakeRefusedClaimTarget } from '../../services/task-pool/claim-target-waker.js';
import { createHttpAssigneeWaker, type AssigneeWaker } from '../../services/project-tickets/ticket-assignee-waker.js';
import { getSessionBackendSync } from '../../services/session/index.js';
import { isInProcessRuntimeActive } from '../../services/agent/crewly-agent/in-process-runtime-registry.js';
import { getActingFor } from '../../services/people/acting-for.service.js';
import { pausedRefusalMessage, pausedTeamById, pausedTeamOfSession } from '../../services/team/team-pause.registry.js';
import { isOwnerCaller } from '../../middleware/caller-identity.middleware.js';

const logger = LoggerService.getInstance().createComponentLogger('TaskPoolController');

/**
 * Known virtual agent sessions that are NOT stored as team members in
 * teams.json but are legitimate dispatch targets. These mirror the virtual
 * members surfaced by `buildOrchestratorTeam` in the team controller.
 */
const VIRTUAL_AGENT_SESSIONS: ReadonlySet<string> = new Set([
  ORCHESTRATOR_SESSION_NAME, // 'crewly-orc'
  'crewly-orc-assistant',    // in-process shadow orchestrator (AI SDK runtime)
  'crewly-auditor',          // auditor agent
]);

/**
 * Validate that a WorkItem's `target` (when set) resolves to a real agent —
 * either a stored team member's session, or a known virtual agent
 * (orchestrator / its assistant / auditor).
 *
 * #615: an agent (Don) hallucinated non-existent teammates ("Leo"/"Noah")
 * and dispatched real WorkItems to fabricated session names that followed
 * the real `<team>-<name>-<uuid>` convention. Because the dispatch path
 * never validated the target, those WorkItems passed through silently and
 * orphaned in the pool forever — no session existed to claim them. This is
 * the system-side structural guard: a fabricated target is rejected at
 * enqueue time instead of polluting the pool.
 *
 * An ABSENT target is legitimate (an unassigned WorkItem that hybrid-wake
 * picks up), so it passes.
 *
 * @param target - The WorkItem target session name (may be undefined)
 * @returns null if the target is valid or absent, otherwise an error message
 */
async function validateTargetSession(target: string | undefined): Promise<string | null> {
  if (!target || typeof target !== 'string' || target.trim() === '') {
    return null; // unassigned WorkItem — allowed
  }
  if (VIRTUAL_AGENT_SESSIONS.has(target)) {
    return null;
  }
  const found = await StorageService.getInstance().findMemberBySessionName(target);
  if (found) {
    return null;
  }
  return (
    `target session "${target}" does not exist — no team member or known agent has this session. ` +
    `Dispatch only to sessions listed in your team context; do not invent session names.`
  );
}

/**
 * Maps service-layer errors to appropriate HTTP status codes and sends a JSON error response.
 *
 * @param res - Express response
 * @param error - The caught error
 */
function handleServiceError(res: Response, error: unknown): void {
  const message = formatError(error);
  if (error instanceof ForbiddenTransitionError) {
    // #813: legal edge, wrong caller (not the reviewer, missing identity, …).
    res.status(403).json({
      success: false,
      error: message,
      code: `transition_${error.reason}`,
      ...(error.reason === 'not_reviewer' || error.reason === 'missing_actor'
        ? { hint: 'Verdicts are checked against the caller\'s X-Agent-Session. Run the skill with CREWLY_SESSION_NAME=<your session> set; only the item\'s reviewer, the orchestrator after escalation, or the owner may verify it.' }
        : {}),
    });
    return;
  }
  if (message.includes('not found')) {
    res.status(404).json({ success: false, error: message });
  } else if (message.includes('status must be') || message.includes('Invalid')) {
    res.status(409).json({ success: false, error: message });
  } else {
    res.status(500).json({ success: false, error: message });
  }
}

/**
 * Get the TaskPoolService singleton.
 *
 * @returns TaskPoolService instance
 */
function getService(): TaskPoolService {
  return TaskPoolService.getInstance();
}

/** Give-up recovery (#841); built lazily over the pool singleton, injectable for tests. */
let giveUpRecovery: GiveUpRecoveryService | null = null;

/**
 * The give-up recovery service the worker stop endpoints go through (#841).
 *
 * @returns The service, created on first use over the TaskPoolService singleton
 */
function getGiveUp(): GiveUpRecoveryService {
  if (!giveUpRecovery) {
    giveUpRecovery = new GiveUpRecoveryService({
      pool: getService(),
      loadTeams: () => StorageService.getInstance().getTeams(),
    });
  }
  return giveUpRecovery;
}

/**
 * Replace the give-up recovery service (tests), or reset it with null.
 *
 * @param service - Service to use, or null to rebuild lazily
 */
export function setGiveUpRecoveryService(service: GiveUpRecoveryService | null): void {
  giveUpRecovery = service;
}

/**
 * Response fields describing what give-up recovery did, when it did anything.
 *
 * @param outcome - Recovery outcome
 * @returns `{ giveUp }` or nothing
 */
function giveUpFields(outcome: StopOutcome): Record<string, unknown> {
  return outcome.action === 'none' ? {} : { giveUp: outcome };
}

/**
 * Get the TaskProjectionService singleton (non-throwing).
 *
 * @returns TaskProjectionService instance or null if unavailable
 */
function getProjection(): TaskProjectionService | null {
  try {
    return TaskProjectionService.getInstance();
  } catch {
    return null;
  }
}

/**
 * Lazily instantiated gate. Stateless — one instance is reused for all requests.
 */
const contractGate = new ServiceContractGate();

/**
 * Check a request body for cross-team routing hints and apply the
 * {@link ServiceContractGate} when present. Opt-in: if the body doesn't
 * carry both `fromTeamId` and `toTeamId` the gate is skipped, preserving
 * backward compatibility with existing delegate flows.
 *
 * Accepted body shapes (either works):
 *   { fromTeamId, toTeamId, requestType }
 *   { metadata: { fromTeamId, toTeamId, requestType } }
 *
 * `requestType` defaults to the WorkItem's `title`/`description` when the
 * caller hasn't supplied a more specific phrase. An explicit boolean
 * `forceCrossTeam: true` bypasses the gate (used for declared emergencies —
 * still logged).
 *
 * @param body - Raw request body (already validated as an object)
 * @returns `null` when the request should proceed; otherwise a gate
 *          rejection decision ready to surface as 403.
 */
export async function maybeEnforceContract(
  body: Record<string, unknown>,
): Promise<
  | null
  | { status: number; payload: Record<string, unknown> }
> {
  const metaSrc = (body.metadata && typeof body.metadata === 'object'
    ? (body.metadata as Record<string, unknown>)
    : body) as Record<string, unknown>;

  const fromTeamId =
    typeof body.fromTeamId === 'string' ? body.fromTeamId : (metaSrc.fromTeamId as string | undefined);
  const toTeamId =
    typeof body.toTeamId === 'string' ? body.toTeamId : (metaSrc.toTeamId as string | undefined);

  // No cross-team hints → same-process, same-team work or legacy callers.
  if (!fromTeamId || !toTeamId) return null;
  if (fromTeamId === toTeamId) return null;

  // Emergency override — still logged by the logger below so we can audit.
  if (body.forceCrossTeam === true || metaSrc.forceCrossTeam === true) {
    logger.warn('ServiceContract gate bypassed via forceCrossTeam', {
      fromTeamId,
      toTeamId,
      title: body.title,
    });
    return null;
  }

  const requestType =
    (typeof body.requestType === 'string' && body.requestType) ||
    (typeof metaSrc.requestType === 'string' && metaSrc.requestType) ||
    (typeof body.title === 'string' && body.title) ||
    (typeof body.description === 'string' && body.description) ||
    '';

  const storage = StorageService.getInstance();
  const teams = await storage.getTeams();
  const toTeam = teams.find((t) => t.id === toTeamId);

  const decision = contractGate.check({ fromTeamId, toTeam, requestType });

  if (decision.outcome === 'accept') {
    logger.info('ServiceContract gate accepted', {
      fromTeamId,
      toTeamId,
      matchedRule: decision.matchedRule,
    });
    return null;
  }

  logger.warn('ServiceContract gate rejected cross-team request', {
    fromTeamId,
    toTeamId,
    requestType,
    reason: decision.reason,
    matchedRule: decision.matchedRule,
  });
  return {
    status: 403,
    payload: {
      success: false,
      error: decision.message,
      gate: {
        outcome: 'reject',
        reason: decision.reason,
        matchedRule: decision.matchedRule,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// POST /api/task-pool/add — Add a WorkItem to the pool
// ---------------------------------------------------------------------------

/**
 * Replace a `TKT-123` style `requestId` in a task-pool body with the ticket's
 * id, in place.
 *
 * @param body - Request body (mutated)
 * @returns An error message when the reference names no ticket, else null
 */
async function normalizeTicketRequestId(body: Record<string, unknown>): Promise<string | null> {
  const ref = body.requestId;
  if (typeof ref !== 'string' || !isTicketNumberRef(ref)) return null;
  const ticket = await getTicketIntakeService()?.resolve(ref);
  if (!ticket) return `No ticket ${ref.trim().toUpperCase()} — pass the ticket id from the [TICKET:…] line`;
  body.requestId = ticket.id;
  return null;
}

/**
 * Take the project ticket id (`delegate-task --ticket`) off a task-pool body,
 * so it never lands on the WorkItem as a stray field.
 *
 * @param body - Request body (mutated)
 * @returns The ticket id, or undefined
 */
function takeProjectTicketId(body: Record<string, unknown>): string | undefined {
  const key = PROJECT_TICKET_CONSTANTS.DELEGATION_TICKET_BODY_KEY;
  const raw = body[key];
  delete body[key];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/**
 * Display name of a team member by session (falls back to the session).
 *
 * @param session - Agent session
 * @returns Name
 */
async function memberNameOf(session: string): Promise<string> {
  try {
    const teams = await StorageService.getInstance().getTeams();
    for (const t of teams) {
      const m = (t.members ?? []).find((x) => x.sessionName === session || x.agentId === session);
      if (m?.name) return m.name;
    }
  } catch {
    // The session name is a fine fallback.
  }
  return session;
}

/**
 * The delegator of a WorkItem: the X-Agent-Session header, else the
 * `metadata.delegatedBy` a delegating skill stamps.
 *
 * @param req - Request
 * @param wi - WorkItem being added
 * @returns Session name, or undefined (owner / unknown)
 */
function delegatorOf(req: Request, wi: WorkItem): string | undefined {
  const header = readAgentSessionHeader(req);
  if (header) return header;
  const stamped = wi.metadata?.[PROJECT_TICKET_CONSTANTS.DELEGATION_CALLER_METADATA_KEY];
  return typeof stamped === 'string' && stamped.trim() ? stamped.trim() : undefined;
}

/**
 * Adds a WorkItem to the Task Pool.
 *
 * HTTP entry point for the V3 pull-mode task path. Used by delegate-task
 * and other orchestration shell skills to queue execution-ready WorkItems.
 *
 * Accepts two body shapes:
 *
 * 1. **Minimal `CreateWorkItemInput`** (preferred) — `{type, owner, title,
 *    target?, description?, briefMarkdown?, priority?, requestId?, ...}`.
 *    The server fills `id` (uuid), `status` (`'queued'` or `'blocked'`
 *    if `dependsOn` set), `createdAt`, `retryCount=0`, `maxRetries`,
 *    `inputTokens=0`, `outputTokens=0`, `cost=0`.
 *
 * 2. **Legacy full `WorkItem`** — body carries `id` AND `status` AND
 *    `createdAt`. The server passes through unchanged (subject to the
 *    same shape validation as before). Preserved for callers that
 *    construct WIs locally with deterministic ids (e.g. break-down-request,
 *    decomposition pipelines that need to record id-references upfront).
 *
 * **Why both shapes.** 2026-05-12 dogfood: orc-side `delegate-task` shell
 * skill and 3 sibling skills (`agent/core/create-task`,
 * `team-leader/decompose-goal`, `team-leader/delegate-task`) all send
 * the minimal shape. They were silently 400'd by the strict validator
 * because they omit `id` / `status` / `createdAt` / `retryCount` etc.
 * Result: every orc delegation failed — `task-pool/add` returned
 * `WorkItem.id is required and must be a string`, the skill exited 1,
 * the orc thought it had delegated but no WI ever entered the pool.
 *
 * Fix the endpoint, not 4 skills — the canonical creation primitive
 * `createWorkItem(input)` already exists for internal callers; the
 * HTTP surface should expose the same shape.
 *
 * @param req - Express request with WorkItem body
 * @param res - Express response
 */
/**
 * Refuse work an agent hands to a paused team (specs/2026-10-04-team-pause.md):
 * a target session on a paused team, or `metadata.teamId` naming one. The
 * owner may still queue work for it; a paused team's own (owner-started)
 * member may act for itself.
 *
 * @param req - Request
 * @param res - Response
 * @param target - Target session, if any
 * @param teamId - Team id the work names, if any
 * @returns True when refused (409 written)
 */
function rejectPausedTarget(req: Request, res: Response, target: string | null | undefined, teamId?: unknown): boolean {
  if (isOwnerCaller(req)) return false;
  const paused = pausedTeamOfSession(target) ?? (typeof teamId === 'string' ? pausedTeamById(teamId) : null);
  if (!paused) return false;
  const caller = readAgentSessionHeader(req);
  if (caller && paused.sessions.includes(caller)) return false;
  logger.info('Refused work for a paused team', { target, teamId, team: paused.teamName, caller });
  res.status(409).json({
    success: false,
    error: pausedRefusalMessage(paused, { callerIsOrc: caller === ORCHESTRATOR_SESSION_NAME }),
    code: TEAM_PAUSE_CONSTANTS.ERROR_CODE,
    ...(paused.issueRepo ? { issueRepo: paused.issueRepo } : {}),
  });
  return true;
}

export async function addItem(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body;

    if (!body || typeof body !== 'object') {
      res.status(400).json({ success: false, error: 'Request body must be a WorkItem object' });
      return;
    }

    // Project tickets §11: `delegate-task --ticket <ID>`.
    const projectTicketId = takeProjectTicketId(body as Record<string, unknown>);

    // Ticket loop: skills may pass the displayed `TKT-123` as --request-id.
    const ticketRefError = await normalizeTicketRequestId(body as Record<string, unknown>);
    if (ticketRefError) {
      res.status(400).json({ success: false, error: ticketRefError, code: 'unknown_ticket' });
      return;
    }

    const isLegacyFullShape =
      typeof body.id === 'string' &&
      typeof body.status === 'string' &&
      typeof body.createdAt === 'string';

    let workItem: WorkItem;

    if (isLegacyFullShape) {
      // Legacy path — body already carries a complete WorkItem. Validate
      // and pass through. This preserves backward compat for skills
      // that construct the full shape locally and want their
      // client-side id to win.
      const validationErrors = await validateLegacyFullWorkItem(body);
      if (validationErrors.length > 0) {
        res.status(400).json({ success: false, errors: validationErrors });
        return;
      }
      workItem = body as WorkItem;
    } else {
      // Minimal-input path — body is a CreateWorkItemInput. Validate
      // the lighter shape and let `createWorkItem` build the full WI
      // with server-generated id, timestamps, and defaults.
      const inputErrors = validateCreateWorkItemInput(body as CreateWorkItemInput);
      if (inputErrors.length > 0) {
        res.status(400).json({ success: false, errors: inputErrors });
        return;
      }
      workItem = createWorkItem(body as CreateWorkItemInput);

      // The minimal-shape path still needs the duplicate / per-Request-cap
      // guards from the legacy validator. Run them against the freshly
      // built WI (id is now present and unique-by-uuid, so the duplicate
      // check is effectively a per-Request-cap check on its own).
      const postBuildErrors = await checkPoolInvariants(workItem);
      if (postBuildErrors.length > 0) {
        res.status(400).json({ success: false, errors: postBuildErrors });
        return;
      }
    }

    // Issue #968: the item is done for the person its creator acts for (the
    // owner from the dashboard). Whatever the body said is ignored.
    workItem = { ...workItem, actingFor: actingForOfCreator(req) };

    // #615: reject WorkItems addressed to a fabricated/non-existent target
    // session before they enqueue and orphan in the pool. Runs for both body
    // shapes (the workItem is fully built by this point).
    const targetError = await validateTargetSession(workItem.target);
    if (targetError) {
      logger.warn('Rejected WorkItem with non-existent target session (#615)', {
        target: workItem.target,
        workItemId: workItem.id,
        type: workItem.type,
      });
      res.status(400).json({ success: false, error: targetError, code: 'unknown_target_session' });
      return;
    }

    // A paused team takes no work from agents (specs/2026-10-04-team-pause.md).
    if (rejectPausedTarget(req, res, workItem.target, workItem.metadata?.teamId)) return;

    // ServiceContract gate — only runs when the body carries cross-team
    // routing hints. Rejects before the item is enqueued.
    const rejection = await maybeEnforceContract(workItem as unknown as Record<string, unknown>);
    if (rejection) {
      res.status(rejection.status).json(rejection.payload);
      return;
    }

    // Project tickets §11: delegating project work to a teammate goes through
    // a project ticket — the named one, or one created for it. The workflow
    // then adds the WorkItem itself (under the ticket folder lock).
    const addOptions = { creatorSession: readAgentSessionHeader(req) };
    let routed: RoutedDelegation | null = null;
    try {
      routed = await projectTicketWorkflow().routeDelegation({
        workItem,
        callerSession: delegatorOf(req, workItem),
        ticketId: projectTicketId,
        addOptions,
      });
    } catch (err) {
      if (err instanceof ProjectTicketError) {
        res.status(err.status).json({ success: false, error: err.message, code: PROJECT_TICKET_CONSTANTS.DELEGATION_REFUSED_CODE });
        return;
      }
      throw err;
    }

    // Ticket loop §3: an item created by an agent without --request-id is
    // linked to the ticket of that agent's current turn, when there is one.
    if (routed) workItem = routed.workItem;
    else await getService().addToPool(workItem, addOptions);

    // V3.1: Project WorkItem entry as a TaskRecord
    const projection = getProjection();
    if (projection) {
      projection.createRecord({
        title: workItem.title || `WorkItem ${workItem.id}`,
        type: workItem.type === 'delegate' ? 'delegation' : 'self_execution',
        ownerAgent: workItem.target || workItem.owner || 'system',
        requestId: workItem.requestId,
        workItemId: workItem.id,
        triggerId: workItem.triggerId,
      }).catch((err) => { logger.debug('TaskRecord creation failed (non-fatal)', { error: formatError(err) }); });
    }

    // crewly#1083: a delegation from an owner Slack thread — the member is
    // told to answer the owner there itself; a delegation soon after an
    // execution nudge counts as following it.
    const delegator = delegatorOf(req, workItem);
    const ownerThread = delegator && workItem.target && workItem.target !== delegator
      ? ownerThreadHandover(workItem, await memberNameOf(delegator))
      : null;
    if (workItem.type === 'delegate') TlDelegationService.getInstance().recordDelegation(delegator, workItem.target);

    res.status(201).json({
      success: true,
      message: `WorkItem ${workItem.id} added to pool`,
      data: {
        workItemId: workItem.id,
        id: workItem.id,
        status: workItem.status,
        ...(ownerThread ? { ownerThread } : {}),
        ...(routed
          ? {
              projectTicket: {
                id: routed.ticket.id,
                status: routed.ticket.status,
                projectPath: routed.project.path,
                project: routed.project.name,
                created: routed.createdTicket,
              },
            }
          : {}),
      },
    });
  } catch (error) {
    handleServiceError(res, error);
  }
}

// ---------------------------------------------------------------------------
// GET /api/task-pool — List available WorkItems
// ---------------------------------------------------------------------------

/**
 * Returns all claimable (queued, unclaimed) WorkItems in the pool.
 *
 * Supports optional query filters:
 * - types: comma-separated WorkItemType values
 * - owner: WorkItemOwner value
 * - target: target agent session name
 * - missionId: filter by mission
 *
 * @param req - Express request
 * @param res - Express response
 */
export async function listAvailable(req: Request, res: Response): Promise<void> {
  try {
    const filters = parseQueryFilters(req);
    const items = await getService().getAvailableItems(filters);
    res.json({ success: true, data: items, count: items.length });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/task-pool/claim — Claim a WorkItem
// ---------------------------------------------------------------------------

/** Starts the target of a refused targeted claim (tests replace it). */
let claimTargetWaker: AssigneeWaker = createHttpAssigneeWaker();

/**
 * Replace the waker used for refused targeted claims (tests).
 *
 * @param waker - The waker, or null to restore the HTTP default
 */
export function setClaimTargetWaker(waker: AssigneeWaker | null): void {
  claimTargetWaker = waker ?? createHttpAssigneeWaker();
}

/**
 * Agent claims a WorkItem from the pool.
 *
 * Two modes:
 * - **Next-available (FIFO)** — omit `workItemId`. Claims the next queued
 *   item matching `filters` for the agent.
 * - **Targeted** — pass `workItemId`. Claims that specific queued item
 *   (#679: previously impossible — the endpoint only ever handed out the
 *   next-available item, so a specific stuck `queued` WI could not be
 *   targeted for claim, forcing operators to repeatedly claim-and-release
 *   to drain it). The service-layer `claimSpecificItem` still enforces the
 *   agent-liveness and target-respect gates, so a targeted claim of a WI
 *   owned by a different agent (or for a dead session) is refused.
 *
 * Request body:
 * ```json
 * {
 *   "agentId": "crewly-product-leo-member-n",
 *   "workItemId": "wi-123",                       // optional — targeted claim
 *   "filters": { "types": ["delegate"], "owner": "agent" }  // ignored if workItemId set
 * }
 * ```
 *
 * @param req - Express request with agentId (and optional workItemId) in body
 * @param res - Express response with claimed item and claim, or 404
 */
export async function claimItem(req: Request, res: Response): Promise<void> {
  try {
    const { agentId, workItemId, filters } = req.body as {
      agentId?: string;
      workItemId?: string;
      filters?: PoolFilters;
    };

    if (!agentId || typeof agentId !== 'string' || !agentId.trim()) {
      res.status(400).json({ success: false, error: 'agentId is required' });
      return;
    }

    // Claiming on behalf of a paused team's member (specs/2026-10-04-team-pause.md).
    if (rejectPausedTarget(req, res, agentId.trim())) return;

    const hasTarget = typeof workItemId === 'string' && workItemId.trim().length > 0;
    const result = hasTarget
      ? await getService().claimSpecificItem(agentId.trim(), workItemId.trim())
      : await getService().claimFromPool(agentId.trim(), filters);

    if (!result && hasTarget) {
      // The target is down: start it for this item instead of only refusing (#929).
      const wake = await wakeRefusedClaimTarget(
        { agentId: agentId.trim(), workItemId: workItemId.trim(), callerSession: readAgentSessionHeader(req) },
        {
          findWorkItem: (id) => getService().findWorkItem(id),
          sessionLive: (session) => {
            try {
              return (getSessionBackendSync()?.sessionExists(session) ?? false) || isInProcessRuntimeActive(session);
            } catch {
              return false;
            }
          },
          findMember: (session) => StorageService.getInstance().findMemberBySessionName(session),
          wake: claimTargetWaker,
        },
      ).catch((err) => {
        logger.warn('Could not start the target of a refused claim', { agentId, workItemId, error: formatError(err) });
        return null;
      });
      if (wake) {
        logger.info('Targeted claim refused because the agent is not running — starting it', {
          agentId: agentId.trim(),
          workItemId: workItemId.trim(),
          outcome: wake.outcome,
          code: wake.code,
        });
        const started = wake.outcome === 'started';
        res.status(started ? 202 : 409).json({
          success: false,
          waking: started,
          error: started
            ? `${agentId.trim()} is not running. It is being started; WorkItem ${workItemId.trim()} stays queued and is delivered when the agent is ready.`
            : `${agentId.trim()} is not running and could not be started: ${wake.detail ?? wake.code ?? 'unknown reason'}. WorkItem ${workItemId.trim()} stays queued.`,
          ...(wake.code ? { code: wake.code } : {}),
        });
        return;
      }
    }

    if (!result) {
      res.status(404).json({
        success: false,
        error: hasTarget
          ? `WorkItem ${workItemId} is not claimable by ${agentId.trim()} (not queued, already claimed, target mismatch, or agent not active)`
          : 'No available WorkItem matching filters',
      });
      return;
    }

    // Issue #968: the claimer now acts for the person the item is done for.
    if (result.workItem.actingFor) {
      try {
        getActingFor().record(agentId.trim(), result.workItem.actingFor, 'agent');
      } catch {
        /* best effort */
      }
    }

    // V3.1: Project task assignment
    const projection = getProjection();
    if (projection) {
      const workItem = result.workItem;
      const records = projection.listRecords({ workItemId: workItem.id });
      const record = records[0];
      if (record) {
        projection.markStarted(record.id, agentId.trim()).catch((err) => { logger.debug('TaskProjection update failed (non-fatal)', { error: formatError(err) }); });
      }
    }

    res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof TeamBudgetExceededError) {
      res.status(429).json({
        success: false,
        error: error.message,
        reason: error.reason,
        usage: error.check.usage,
      });
      return;
    }
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/task-pool/release/:workItemId — Release a WorkItem
// ---------------------------------------------------------------------------

/**
 * Releases a claimed WorkItem back to the pool.
 *
 * The item keeps its `target` by default — a release ends an attempt, it
 * does not revoke an assignment. Pass `unassign: true` to also return the
 * item to the unassigned pool, for the case where the caller genuinely
 * means "someone else should take this".
 *
 * Request body:
 * ```json
 * { "reason": "agent busy", "unassign": false }
 * ```
 *
 * @param req - Express request with workItemId param
 * @param res - Express response
 */
export async function releaseItem(req: Request, res: Response): Promise<void> {
  try {
    const { workItemId } = req.params;
    const { reason, unassign } = req.body as { reason?: string; unassign?: boolean };

    if (!workItemId) {
      res.status(400).json({ success: false, error: 'workItemId param is required' });
      return;
    }

    const releaseReason = reason || 'released via API';
    await getService().releaseBack(workItemId, releaseReason, {
      unassign: unassign === true,
    });

    res.json({ success: true, message: `WorkItem ${workItemId} released back to pool` });
  } catch (error) {
    handleServiceError(res, error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/task-pool/complete/:workItemId — Complete a WorkItem
// ---------------------------------------------------------------------------

/**
 * Marks a running WorkItem as completed ('done').
 *
 * ## Canonical body shape (STRICT)
 *
 * ```json
 * {
 *   "agentId": "crewly-product-leo-member-n",
 *   "result": { "summary": "what I produced …", "prNumber": 525, "...": "..." },
 *   "tokenUsage": { "inputTokens": 0, "outputTokens": 0, "totalCost": 0 }
 * }
 * ```
 *
 * Validation rules (in order — first failure short-circuits):
 * 1. `workItemId` URL param — required (path; never empty).
 * 2. `agentId` body field — required, non-empty string. Identifies the
 *    completing agent for token attribution and audit trail.
 * 3. `result.summary` body field — required, non-empty string after trim.
 *    Enforces the Request Contract's Done Definition: workers report
 *    what they produced (artifact, decision, verified result), not just
 *    "done".
 *
 * 4. `result.evidence` (#873) — the evidence contract, checked by
 *    `decideCompletion` (services/task-pool/completion-evidence.service.ts):
 *    - malformed → 400 `evidence_malformed` naming the bad entry;
 *    - top-level `evidence` (outside `result`) → 400 `evidence_misplaced`;
 *    - any `{type:'blocked', step, reason}` → NOT done: recorded as blocked
 *      exactly like `POST /task-pool/block/:id`, 200 `{recordedAs:'blocked'}`;
 *    - a `command` with non-zero `exitCode` → 400 `evidence_command_failed`;
 *    - an `artifact` local path that does not exist (relative paths resolve
 *      against the WorkItem's worktree, then `metadata.projectPath`) → 400;
 *    - missing/empty → `warn` mode (default this release): accepted with a
 *      `warning` field; `enforce` mode (`CREWLY_EVIDENCE_MODE=enforce`): 400
 *      `evidence_required`. A review item's verdict completion is exempt.
 *
 * Any field beyond `summary` inside `result` (e.g. `prNumber`, `links`,
 * `evidence`) is preserved into `WorkItem.output` via spread merge, so
 * downstream verifiers can read the proof-of-work without digging through
 * chat logs.
 *
 * ## Hygiene #4 (PR ?) — strict-shape lock
 *
 * Prior to Hygiene #4, three skill callers (`config/skills/agent/core/{
 * report-status,complete-task}/execute.sh`, `config/skills/orchestrator/
 * complete-task/execute.sh`) and two TS callers (`tool-registry.ts`
 * §complete_task + §report_status auto-complete) emitted top-level
 * `{summary}` instead of the canonical `{agentId, result:{summary}}`.
 * That shape failed both validators (missing agentId + result.summary),
 * forcing every worker into a direct-curl workaround that Quinn
 * surfaced on the #499 verify-WI dogfood.
 *
 * Decision (locked T+9min on Hygiene #4 by Quinn): keep the controller
 * STRICT — fix all 5 callsites in the same PR rather than ship a
 * backward-compat resolver. Rationale: all 5 callers are in-tree, OSS
 * is the only consumer (Crewly Pro extends via Plugin System and does
 * NOT fork core skill or task-pool callers per workspace CLAUDE.md),
 * and a compat layer would add permanent ambiguity for zero downstream
 * benefit.
 *
 * @param req - Express request with `workItemId` param + canonical body
 * @param res - Express response
 */
export async function completeItem(req: Request, res: Response): Promise<void> {
  try {
    const { workItemId } = req.params;
    const { agentId, tokenUsage, result } = req.body as {
      agentId?: string;
      tokenUsage?: TokenUsage;
      result?: Record<string, unknown>;
    };

    if (!workItemId) {
      res.status(400).json({ success: false, error: 'workItemId param is required' });
      return;
    }
    if (!agentId) {
      res.status(400).json({ success: false, error: 'agentId is required' });
      return;
    }

    // Require a non-empty `summary` string in the body. 2026-05-08 dogfood:
    // Sam and Leo both marked WIs `done_by_worker` with empty output —
    // workers were claiming completion without producing artifacts.
    // Pool stored these as terminal-success but with `output=null,
    // notes=null` (fake completion). The Done Definition in the Request
    // Contract requires "what artifact/result must be produced". Enforce
    // it at the API boundary so the proof of work lands with the
    // transition, not as an afterthought.
    //
    // Hygiene #4 (2026-05-09): callers MUST emit the canonical body shape
    // `{agentId, result:{summary}}` — see the JSDoc on this handler for
    // the contract. Top-level `{summary}` returns a 400 here.
    const summary = typeof result?.summary === 'string' ? result.summary.trim() : '';
    if (summary.length === 0) {
      res.status(400).json({
        success: false,
        error:
          `complete requires a non-empty 'summary' string in body.result. ` +
          `Workers must report what they produced (artifact, decision, verified result) — ` +
          `not just mark "done". This enforces the Request Contract Done Definition.`,
        code: 'complete_requires_summary',
      });
      return;
    }

    // #873: the evidence block lives in body.result (it is persisted with the
    // rest of the result onto WorkItem.output). A top-level `evidence` would
    // otherwise be silently ignored — the Hygiene #4 failure mode — so name it.
    if ((req.body as Record<string, unknown>)['evidence'] !== undefined) {
      res.status(400).json({
        success: false,
        error: `'evidence' must be inside body.result, not at the top level. ${COMPLETION_EVIDENCE_CONSTANTS.SHAPE_HINT}`,
        code: COMPLETION_EVIDENCE_CONSTANTS.CODES.MISPLACED,
      });
      return;
    }

    const existing = await getService().findWorkItem(workItemId).catch(() => null);

    // #873: evidence contract. Decided before anything is written, so a
    // rejected completion leaves the WorkItem exactly as it was.
    const evidenceMode = resolveEvidenceEnforcementMode();
    const decision = await decideCompletion(result?.['evidence'], existing, {
      mode: evidenceMode,
      // A review item's verdict is its deliverable.
      exemptFromMissing: typeof result?.['verdict'] === 'string',
    });
    if (decision.action === 'reject') {
      logger.info('complete: rejected by the evidence contract', { workItemId, agentId, code: decision.code });
      res.status(decision.status).json({ success: false, error: decision.error, code: decision.code });
      return;
    }
    const warningFields: Record<string, unknown> = decision.action === 'complete' && decision.warning
      ? { warning: decision.warning, evidenceMode }
      : {};
    if (decision.action === 'complete' && decision.warning) {
      logger.warn('complete: WorkItem completed without evidence (warn mode)', { workItemId, agentId });
    }

    // Persist the summary onto the WorkItem.output. This makes the proof of
    // work queryable via `GET /api/task-pool/items/:id` (Request detail
    // page), and downstream services that want to read what the worker
    // actually produced (verifier, reviewer, mission audit) don't have to
    // dig back through chat logs.
    try {
      const mergedOutput: Record<string, unknown> = {
        ...(existing?.output ?? {}),
        summary,
        // Preserve any caller-supplied result fields beyond `summary`
        // (e.g. `links`, `prNumber`) as-is.
        ...(result ?? {}),
        // The validated evidence (only known fields), replacing the raw value.
        ...(decision.evidence ? { evidence: decision.evidence } : {}),
      };
      await getService().setOutput(workItemId, mergedOutput);
    } catch (err) {
      logger.warn('Failed to persist completion summary onto WI.output (non-fatal)', {
        workItemId,
        error: formatError(err),
      });
    }

    // #873: a `blocked` evidence entry means the worker did not finish. Record
    // it as blocked through the same path as POST /task-pool/block, never done.
    if (decision.action === 'block') {
      const blockOutcome = await recordBlocked(workItemId, agentId, decision.reason);
      res.json({
        success: true,
        recordedAs: 'blocked',
        message: `WorkItem ${workItemId} recorded as BLOCKED, not done: ${decision.reason}`,
        ...giveUpFields(blockOutcome),
      });
      return;
    }

    // #813: the actor is resolved from the request's session header, not from
    // the body's agentId — the body is whatever the caller chose to write.
    const actor = resolveTransitionActor(req, 'POST /task-pool/complete');
    if (actor.session && actor.session !== agentId) {
      logger.warn('complete: body agentId differs from X-Agent-Session; using the session', {
        workItemId,
        agentId,
        session: actor.session,
      });
    }
    // #841: a completion whose outcome is a give-up (no delivery) is recorded
    // as failed and retried with a different approach; others go through
    // pool.completeItem with the resolved actor (#813) exactly as before —
    // GiveUpRecoveryService.complete() makes that call itself when the
    // completion is not a give-up.
    // An owner-promise follow-up is held (blocked): its agent closes it as
    // already delivered instead of going through running -> done_by_worker.
    const followUp = await getService().findWorkItem(workItemId).catch(() => null);
    const followUpKey = OPEN_ITEMS_CONSTANTS.FOLLOW_UP_METADATA_KEY;
    if (followUp && followUp.status === 'blocked' && (followUp.metadata ?? {})[followUpKey] !== undefined) {
      const { OpenItemsService } = await import('../../services/open-items/open-items.service.js');
      const closed = await OpenItemsService.getInstance()?.closeByAgent(workItemId, actor.session ?? agentId, summary);
      if (closed) {
        res.json({ success: true, message: `Follow-up ${workItemId} closed as delivered`, ...warningFields });
        return;
      }
    }
    const outcome = await getGiveUp().complete(workItemId, result, actor);
    if (outcome.action === 'retry_queued' || outcome.action === 'escalated_to_lead') {
      res.json({
        success: true,
        message: outcome.action === 'retry_queued'
          ? `WorkItem ${workItemId} recorded as a give-up; retry ${outcome.retryWorkItemId} queued with a different approach`
          : `WorkItem ${workItemId} recorded as a give-up; retries used up, escalated to the lead as ${outcome.reviewWorkItemId}`,
        ...giveUpFields(outcome),
        ...warningFields,
      });
      return;
    }

    // V3.1: Project task completion
    const projection = getProjection();
    if (projection) {
      const records = projection.listRecords({ workItemId });
      const record = records[0];
      if (record) {
        projection.markDone(record.id, agentId, tokenUsage).catch((err) => {
          logger.debug('TaskRecord markDone failed (non-fatal)', { error: formatError(err) });
        });
        // Roll up token usage to Request
        if (tokenUsage && record.requestId) {
          rollUpTokensToRequest(record.requestId, tokenUsage);
        }
      }
    }

    // NOTE: Request status cascade is handled by V3DataService.onTaskCompleted
    // via the EventBus — no duplicate cascade needed here.

    res.json({ success: true, message: `WorkItem ${workItemId} completed`, ...giveUpFields(outcome), ...warningFields });
  } catch (error) {
    handleServiceError(res, error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/task-pool/block/:workItemId — Block a WorkItem
// ---------------------------------------------------------------------------

/**
 * Record a running WorkItem as blocked, with every side effect of an explicit
 * block: the claim is released, the item stays `blocked` until unblocked
 * (POST /task-pool/release/:id — the reconciler does not re-queue it), the
 * give-up recovery classifies the stop, `task:blocked` is published and the
 * project task record is marked blocked.
 *
 * Shared by `POST /task-pool/block/:id` and a completion whose evidence
 * carries a `blocked` entry (#873), so both behave identically.
 *
 * @param workItemId - The running WorkItem
 * @param agentId - Who blocked it
 * @param reason - Why (optional)
 * @returns What the give-up recovery did with the stop
 * @throws When the WorkItem is missing or not `running` (mapped to 404 / 409)
 */
async function recordBlocked(workItemId: string, agentId: string, reason: string | undefined): Promise<StopOutcome> {
  const outcome = await getGiveUp().block(workItemId, { agentId, reason });

  // V3.1: Project task blocked
  const projection = getProjection();
  if (projection) {
    const records = projection.listRecords({ workItemId });
    const record = records[0];
    if (record) {
      projection.markBlocked(record.id, agentId, reason).catch((err) => { logger.debug('TaskProjection update failed (non-fatal)', { error: formatError(err) }); });
    }
  }
  return outcome;
}

/**
 * Marks a running WorkItem as explicitly blocked.
 *
 * The claim is released (freeing the agent's claim slot) and the item stays
 * `blocked` — never re-queued or re-dispatched by the reconciler — until it
 * is unblocked via `POST /api/task-pool/release/:workItemId`, which puts it
 * back to `queued` for the same target.
 *
 * Request body:
 * ```json
 * { "agentId": "crewly-product-leo-member-n", "reason": "waiting for X" }
 * ```
 *
 * @param req - Express request with workItemId param
 * @param res - Express response
 */
export async function blockItem(req: Request, res: Response): Promise<void> {
  try {
    const { workItemId } = req.params;
    const { agentId, reason } = req.body as { agentId?: string; reason?: string };

    if (!workItemId) {
      res.status(400).json({ success: false, error: 'workItemId param is required' });
      return;
    }
    if (!agentId) {
      res.status(400).json({ success: false, error: 'agentId is required' });
      return;
    }

    const outcome = await recordBlocked(workItemId, agentId, reason);

    res.json({ success: true, message: `WorkItem ${workItemId} blocked`, ...giveUpFields(outcome) });
  } catch (error) {
    // Use the shared mapper rather than an inline not-found/500 split.
    // `updateItemStatus` throws "Invalid status transition ..." when the item
    // is not `running` (WORK_ITEM_TRANSITIONS allows `blocked` only from
    // `running`). That is a CLIENT error — the caller asked for something the
    // state machine forbids — and the inline catch reported it as a 500, so
    // retry logic treated a permanent failure as transient and hammered it.
    // handleServiceError maps `Invalid` to 409 Conflict, which is what a
    // state-machine conflict is.
    handleServiceError(res, error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/task-pool/fail/:workItemId — Fail a WorkItem
// ---------------------------------------------------------------------------

/**
 * Marks a running WorkItem as failed.
 *
 * Request body:
 * ```json
 * { "agentId": "crewly-product-leo-member-n", "error": "something went wrong" }
 * ```
 *
 * @param req - Express request with workItemId param
 * @param res - Express response
 */
export async function failItemHandler(req: Request, res: Response): Promise<void> {
  try {
    const { workItemId } = req.params;
    const { agentId, error: errorMsg } = req.body as { agentId?: string; error?: string };

    if (!workItemId) {
      res.status(400).json({ success: false, error: 'workItemId param is required' });
      return;
    }
    if (!agentId) {
      res.status(400).json({ success: false, error: 'agentId is required' });
      return;
    }

    const outcome = await getGiveUp().fail(workItemId, errorMsg || 'unknown error');

    // V3.1: Project task failure
    const projection = getProjection();
    if (projection) {
      const records = projection.listRecords({ workItemId });
      const record = records[0];
      if (record) {
        projection.markFailed(record.id, agentId, errorMsg).catch((err) => { logger.debug('TaskProjection update failed (non-fatal)', { error: formatError(err) }); });
      }
    }

    res.json({ success: true, message: `WorkItem ${workItemId} failed`, ...giveUpFields(outcome) });
  } catch (error) {
    handleServiceError(res, error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/task-pool/items/:workItemId/cancel — Cancel a queued/blocked WI
// ---------------------------------------------------------------------------

/**
 * POST /api/task-pool/items/:workItemId/verdict — record a review verdict.
 *
 * Body: `{ "verdict": "verified" | "rejected", "comment"?: string }`.
 *
 * The caller is resolved from the request (`X-Agent-Session`, or the owner's
 * dashboard marker) — never from the body (#813). An agent session acts as a
 * reviewer and is accepted only when it is the item's reviewer of record; the
 * orchestrator only once the review was escalated to it (or when no reviewer
 * is recorded); the owner always. Anyone else gets 403.
 *
 * Responses:
 *   - 200 `{ success: true, data: WorkItem }`
 *   - 400 invalid verdict
 *   - 403 `{ code: 'transition_not_reviewer' | 'transition_self_review' | … }`
 *   - 404 WorkItem not found
 *   - 409 item is not `done_by_worker`
 *
 * @param req - Express request with `workItemId` param and verdict body
 * @param res - Express response
 */
export async function renderVerdict(req: Request, res: Response): Promise<void> {
  try {
    const { workItemId } = req.params;
    const { verdict, comment } = (req.body ?? {}) as { verdict?: unknown; comment?: unknown };
    if (verdict !== 'verified' && verdict !== 'rejected') {
      res.status(400).json({ success: false, error: "verdict must be 'verified' or 'rejected'" });
      return;
    }
    const caller = resolveTransitionActor(req, 'POST /task-pool/items/:id/verdict');
    // An agent session here is acting as a reviewer, not as the worker.
    const actor = caller.role === 'agent' ? { ...caller, role: 'team_lead' as const } : caller;
    const updated = await getService().verifyItem(
      workItemId,
      actor,
      verdict,
      typeof comment === 'string' && comment.trim() ? comment.trim() : undefined,
    );
    res.json({ success: true, data: updated });
  } catch (error) {
    handleServiceError(res, error);
  }
}

/**
 * Cleanly cancel a WorkItem that is `queued`, `blocked`, or `scheduled`
 * (i.e. has not been claimed yet). Closes the #609 gap where no
 * non-destructive API existed for retiring a stuck queued WI — the only
 * options were `complete` (requires running) or `DELETE ?force=1` (hard
 * delete with no audit trail).
 *
 * Request body: `{ "reason": "short human-readable why", "supersededBy"?: "<wiId>" | ["<wiId>", …] }`
 *   `reason` is required. It's persisted on `cancelReason` and surfaces
 *   in the activity timeline so the cancellation isn't an opaque event.
 *   `supersededBy` names the WorkItem(s) that now carry this work (a
 *   duplicate / re-routed item). It is stamped on `metadata.supersededBy`
 *   so the Request's completion check follows the replacement.
 *
 * Responses:
 *   - 200 `{ success: true, workItemId, cancelledFrom }`
 *   - 400 `{ success: false, error: 'reason is required' }`
 *   - 400 `{ success: false, error: 'WorkItem status must be queued|blocked|scheduled', currentStatus }`
 *   - 404 `{ success: false, error: 'WorkItem not found' }`
 */
export async function cancelQueuedItem(req: Request, res: Response): Promise<void> {
  try {
    const { workItemId } = req.params;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!workItemId) {
      res.status(400).json({ success: false, error: 'workItemId param is required' });
      return;
    }
    if (!reason) {
      res
        .status(400)
        .json({ success: false, error: 'reason is required (string, non-empty)' });
      return;
    }
    const before = await getService().findWorkItem(workItemId);
    if (!before) {
      res.status(404).json({ success: false, error: 'WorkItem not found' });
      return;
    }
    // Snapshot the pre-cancel status BEFORE calling the service —
    // transitionStatus mutates the pool's cached object in place, so
    // `before.status` will read as `'cancelled'` after the await
    // otherwise (caught live 2026-05-28).
    const cancelledFrom = before.status;
    const rawSuccessor: unknown = req.body?.supersededBy;
    const supersededBy = (Array.isArray(rawSuccessor) ? rawSuccessor : [rawSuccessor])
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim());
    // Who cancelled it (crewly#1015 §10): an owner promise whose follow-up
    // another agent cancels is told to the owner.
    const actor = resolveTransitionActor(req, 'POST /task-pool/items/:id/cancel');
    await getService().cancelQueued(workItemId, reason, { supersededBy, ...(actor.session ? { cancelledBy: actor.session } : {}) });
    res.json({
      success: true,
      workItemId,
      cancelledFrom,
      reason,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // The service throws a friendly message for wrong-state cases;
    // surface it as 400 so callers can branch.
    if (/status must be 'queued', 'blocked', or 'scheduled'/.test(msg)) {
      res.status(400).json({ success: false, error: msg });
      return;
    }
    handleServiceError(res, error);
  }
}

// ---------------------------------------------------------------------------
// GET /api/task-pool/stats — Pool statistics
// ---------------------------------------------------------------------------

/**
 * Returns pool statistics: total, claimed, available, avg wait time, breakdowns.
 *
 * @param req - Express request
 * @param res - Express response with PoolSnapshot
 */
export async function getStats(req: Request, res: Response): Promise<void> {
  try {
    const stats = await getService().getPoolStatus();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/task-pool/heartbeat — Agent heartbeat for active claim
// ---------------------------------------------------------------------------

/**
 * Processes a heartbeat from an agent for their active claim.
 *
 * Request body:
 * ```json
 * { "claimId": "uuid", "agentId": "crewly-product-leo-member-n" }
 * ```
 *
 * @param req - Express request with claimId and agentId in body
 * @param res - Express response
 */
export async function heartbeat(req: Request, res: Response): Promise<void> {
  try {
    const { claimId, agentId } = req.body as {
      claimId?: string;
      agentId?: string;
    };

    if (!claimId || !agentId) {
      res.status(400).json({
        success: false,
        error: 'claimId and agentId are required',
      });
      return;
    }

    const result = await getService().heartbeat(claimId, agentId);

    if (!result.success) {
      res.status(409).json({ success: false, error: result.reason });
      return;
    }

    res.json({ success: true, data: { claim: result.claim } });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/task-pool/extend-lease — Extend lease on a claim
// ---------------------------------------------------------------------------

/**
 * Extends the lease duration for an active claim.
 *
 * Request body:
 * ```json
 * { "claimId": "uuid", "agentId": "crewly-product-leo-member-n" }
 * ```
 *
 * @param req - Express request with claimId and agentId in body
 * @param res - Express response
 */
export async function extendLease(req: Request, res: Response): Promise<void> {
  try {
    const { claimId, agentId } = req.body as {
      claimId?: string;
      agentId?: string;
    };

    if (!claimId || !agentId) {
      res.status(400).json({
        success: false,
        error: 'claimId and agentId are required',
      });
      return;
    }

    const result = await getService().extendLease(claimId, agentId);

    if (!result.success) {
      res.status(409).json({ success: false, error: result.reason });
      return;
    }

    res.json({ success: true, data: { claim: result.claim } });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// GET /api/task-pool/claims/expired — Scan for expired claims
// ---------------------------------------------------------------------------

/**
 * Scans for claims with expired leases. Returns two lists:
 * - expiring: lease expired, within grace period
 * - graceExceeded: past grace period, should be revoked
 *
 * Used by the Reconciler and for debugging.
 *
 * @param req - Express request
 * @param res - Express response
 */
export async function scanExpired(req: Request, res: Response): Promise<void> {
  try {
    const summary = await getService().scanExpiredClaims();
    res.json({
      success: true,
      data: {
        expiring: summary.expiring,
        graceExceeded: summary.graceExceeded,
        expiringCount: summary.expiring.length,
        graceExceededCount: summary.graceExceeded.length,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/task-pool/revoke/:claimId — Revoke a claim and release work item
// ---------------------------------------------------------------------------

/**
 * Revokes a claim and releases the work item back to the pool.
 * Typically called by the Reconciler when grace period is exceeded.
 *
 * Request body:
 * ```json
 * { "reason": "grace period exceeded" }
 * ```
 *
 * @param req - Express request with claimId param
 * @param res - Express response
 */
export async function revokeAndRelease(req: Request, res: Response): Promise<void> {
  try {
    const { claimId } = req.params;
    const { reason } = req.body as { reason?: string };

    if (!claimId) {
      res.status(400).json({ success: false, error: 'claimId param is required' });
      return;
    }

    const revokeReason = reason || 'revoked via API';
    await getService().revokeAndRelease(claimId, revokeReason);

    res.json({ success: true, message: `Claim ${claimId} revoked and work item released` });
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes('not found')) {
      res.status(404).json({ success: false, error: message });
    } else {
      res.status(500).json({ success: false, error: message });
    }
  }
}

// ---------------------------------------------------------------------------
// GET /api/task-pool/items — enumerate ALL items regardless of status
// ---------------------------------------------------------------------------

/**
 * Returns WorkItems currently in the pool — including cancelled,
 * done_by_worker, failed, etc. — so admin / cleanup tooling can audit the
 * full state without filtering by claimability.
 *
 * Distinct from `/api/task-pool` (and its `/all` alias) which return ONLY
 * the available subset (queued + unclaimed). The existing alias was
 * naming-confusing for cleanup workflows; rather than rename and break
 * downstream consumers, this endpoint adds the audit-shaped surface that
 * the bulk-DELETE script needs.
 *
 * Optional query filters (#679): callers may narrow by `status` (a single
 * value or comma-separated list) and/or `target` (exact session match).
 * These were previously IGNORED — the endpoint always returned every item.
 * The `complete-task` skill resolves the WorkItem to complete via
 * `GET /api/task-pool/items?status=running&target=<session>` and takes the
 * first result; with no server-side filtering it received an arbitrary item
 * (another agent's WI, or an already-terminal one), so the worker's
 * completion landed on the WRONG WorkItem and was rejected with 409 —
 * leaving the worker unable to close its own task. Honoring the filters
 * makes that resolution correct (and returns an empty list when the session
 * has no matching item, instead of a misleading first-of-everything).
 *
 * Response: `{ success: true, data: WorkItem[], count }`.
 *
 * @param req - Express request (optional `?status=`, `?target=` query)
 * @param res - Express response
 */
export async function listAllItems(req: Request, res: Response): Promise<void> {
  try {
    let items = await getService().getAllItems();

    const statusParam = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    if (statusParam) {
      const allowed = new Set(
        statusParam.split(',').map(s => s.trim()).filter(Boolean),
      );
      if (allowed.size > 0) {
        items = items.filter(wi => allowed.has(wi.status));
      }
    }

    const targetParam = typeof req.query.target === 'string' ? req.query.target.trim() : '';
    if (targetParam) {
      items = items.filter(wi => wi.target === targetParam);
    }

    res.json({ success: true, data: items, count: items.length });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/task-pool/:workItemId — bulk-DELETE entry point
// (P1 1ffffb84 component a, Steve directive 2026-05-06)
// ---------------------------------------------------------------------------

/**
 * Removes a WorkItem from the pool entirely. Powers the bulk-cleanup
 * script and any future operator workflow that needs to drop stale or
 * misplanned items.
 *
 * Request:
 *   DELETE /api/task-pool/:workItemId[?force=1]
 *
 * Response shapes:
 *   - 200 `{ success: true, removed: true,  workItem: WorkItem,  hadActiveClaim }`
 *   - 200 `{ success: true, removed: false, reason: 'not_found' }`
 *     (idempotent — repeated calls on a missing id do not error)
 *   - 409 `{ success: false, error: '...', code: 'work_item_claimed',
 *           workItemId, claimId, claimedBy }`
 *     (active claim + no force; pass `?force=1` to override)
 *   - 400 `{ success: false, error: 'workItemId param is required' }`
 *
 * @param req - Express request with `workItemId` route param and
 *   optional `?force=1` query flag.
 * @param res - Express response
 */
export async function deleteItem(req: Request, res: Response): Promise<void> {
  try {
    const { workItemId } = req.params;
    if (!workItemId) {
      res.status(400).json({ success: false, error: 'workItemId param is required' });
      return;
    }
    const force = req.query.force === '1' || req.query.force === 'true';
    const result = await getService().removeFromPool(workItemId, { force });
    res.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof WorkItemClaimedError) {
      res.status(409).json({
        success: false,
        error: error.message,
        code: 'work_item_claimed',
        workItemId: error.workItemId,
        claimId: error.claimId,
        claimedBy: error.claimedBy,
      });
      return;
    }
    res.status(500).json({ success: false, error: formatError(error) });
  }
}

// ---------------------------------------------------------------------------
// V3-only single-item endpoints (replaces v1 task-management surface)
// (spec/2026-05-06-task-management-v1-deprecation.md — Phase B)
// ---------------------------------------------------------------------------

/**
 * Fetches a single WorkItem by id.
 *
 * Replaces `POST /task-management/read-task` and `POST /task-management/get-output`.
 * Both v1 endpoints walked the project's `.crewly/tasks/` filesystem to load
 * the `.md` body and `<id>.output.json`. With v1 retired, the entire
 * task body, brief, and worker output live on the WorkItem itself —
 * one fetch returns everything.
 *
 * @param req - Express request, `:workItemId` route param
 * @param res - 200 `{ success, data: WorkItem }` | 404 if not found
 */
export async function getItem(req: Request, res: Response): Promise<void> {
  try {
    const { workItemId } = req.params;
    if (!workItemId) {
      res.status(400).json({ success: false, error: 'workItemId param is required' });
      return;
    }
    const wi = await getService().findWorkItem(workItemId);
    if (!wi) {
      res.status(404).json({ success: false, error: `WorkItem not found: ${workItemId}` });
      return;
    }
    res.json({ success: true, data: wi });
  } catch (error) {
    res.status(500).json({ success: false, error: formatError(error) });
  }
}

/**
 * Stores worker-supplied structured output on a WorkItem.
 *
 * Replaces v1's `<taskId>.output.json` filesystem write. The TL
 * `verify-output` skill reads this back via `GET /api/task-pool/items/:id`.
 *
 * Body: `{ output: Record<string, unknown> }` — output may be any JSON shape;
 * the schema is task-specific.
 *
 * @param req - Express request, `:workItemId` route param + body.output
 * @param res - 200 `{ success, data: WorkItem }` | 404 | 400
 */
export async function setItemOutput(req: Request, res: Response): Promise<void> {
  try {
    const { workItemId } = req.params;
    if (!workItemId) {
      res.status(400).json({ success: false, error: 'workItemId param is required' });
      return;
    }
    const output = (req.body?.output ?? req.body) as Record<string, unknown> | undefined;
    if (!output || typeof output !== 'object') {
      res.status(400).json({ success: false, error: 'body.output (object) is required' });
      return;
    }
    const updated = await getService().setOutput(workItemId, output);
    if (!updated) {
      res.status(404).json({ success: false, error: `WorkItem not found: ${workItemId}` });
      return;
    }
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: formatError(error) });
  }
}

/**
 * Reassigns a WorkItem to a different agent.
 *
 * Replaces `POST /task-management/handoff` (which moved the `.md` file
 * between agent task directories). With v1 retired, handoff is a single
 * `target` field flip on the WorkItem plus an audit-trail note.
 *
 * Body: `{ newTarget: string, fromAgent?: string, reason?: string }`.
 *
 * @param req - Express request
 * @param res - 200 `{ success, data: WorkItem }` | 404 | 400 | 409 (terminal)
 */
export async function handoffItem(req: Request, res: Response): Promise<void> {
  try {
    const { workItemId } = req.params;
    if (!workItemId) {
      res.status(400).json({ success: false, error: 'workItemId param is required' });
      return;
    }
    const newTarget = String(req.body?.newTarget ?? req.body?.toAgent ?? '').trim();
    const fromAgent = String(req.body?.fromAgent ?? req.body?.from ?? 'unknown').trim();
    const reason = String(req.body?.reason ?? '').trim();
    if (!newTarget) {
      res.status(400).json({ success: false, error: 'body.newTarget is required' });
      return;
    }
    if (rejectPausedTarget(req, res, newTarget)) return;
    const updated = await getService().handoff(workItemId, newTarget, fromAgent, reason);
    if (!updated) {
      res.status(404).json({ success: false, error: `WorkItem not found: ${workItemId}` });
      return;
    }
    res.json({ success: true, data: updated });
  } catch (error) {
    const message = formatError(error);
    if (message.includes('terminal state')) {
      res.status(409).json({ success: false, error: message });
      return;
    }
    res.status(500).json({ success: false, error: message });
  }
}

/**
 * Appends a working-state note to a WorkItem.
 *
 * Replaces `POST /task-management/sync` and `POST /task-management/save-working-notes`,
 * both of which appended progress lines to the `.md` task body. With v1
 * retired, notes accumulate under `WorkItem.metadata.notes[]`.
 *
 * Body: `{ author: string, note: string }`.
 *
 * @param req - Express request
 * @param res - 200 `{ success, data: WorkItem }` | 404 | 400
 */
export async function appendItemNote(req: Request, res: Response): Promise<void> {
  try {
    const { workItemId } = req.params;
    if (!workItemId) {
      res.status(400).json({ success: false, error: 'workItemId param is required' });
      return;
    }
    const author = String(req.body?.author ?? req.body?.sessionName ?? 'unknown').trim();
    const note = String(req.body?.note ?? req.body?.notes ?? '').trim();
    if (!note) {
      res.status(400).json({ success: false, error: 'body.note is required' });
      return;
    }
    const updated = await getService().appendNote(workItemId, author, note);
    if (!updated) {
      res.status(404).json({ success: false, error: `WorkItem not found: ${workItemId}` });
      return;
    }
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: formatError(error) });
  }
}

/** Inclusive lower bound of an auditor quality score. */
const QUALITY_SCORE_MIN = 0;

/** Inclusive upper bound of an auditor quality score. */
const QUALITY_SCORE_MAX = 100;

/** Scorer recorded when the caller does not identify itself. */
const DEFAULT_SCORED_BY = 'auditor';

/**
 * Records an auditor quality score on a WorkItem.
 *
 * Serves `POST /api/tasks/score`, the route the auditor `score-task` skill
 * has always posted to (it previously did not exist). Mirrors the v1
 * `Task.qualityScore` field on the WorkItem as
 * `metadata.qualityScore` / `metadata.qualityScoredBy` / `metadata.qualityScoredAt`.
 *
 * Body: `{ taskId | workItemId: string, qualityScore: number (0–100), scoredBy?: string }`.
 *
 * @param req - Express request with the score body
 * @param res - 200 `{ success, data: WorkItem }` | 400 invalid input | 404 unknown item
 */
export async function scoreItem(req: Request, res: Response): Promise<void> {
  try {
    const workItemId = String(req.body?.taskId ?? req.body?.workItemId ?? '').trim();
    if (!workItemId) {
      res.status(400).json({ success: false, error: 'body.taskId (or workItemId) is required' });
      return;
    }
    const qualityScore = req.body?.qualityScore;
    if (
      typeof qualityScore !== 'number' ||
      !Number.isFinite(qualityScore) ||
      qualityScore < QUALITY_SCORE_MIN ||
      qualityScore > QUALITY_SCORE_MAX
    ) {
      res.status(400).json({
        success: false,
        error: `body.qualityScore must be a number between ${QUALITY_SCORE_MIN} and ${QUALITY_SCORE_MAX}`,
      });
      return;
    }
    const scoredBy = String(req.body?.scoredBy ?? req.body?.sessionName ?? DEFAULT_SCORED_BY).trim() || DEFAULT_SCORED_BY;

    const updated = await getService().scoreItem(workItemId, qualityScore, scoredBy);
    if (!updated) {
      res.status(404).json({ success: false, error: `WorkItem not found: ${workItemId}` });
      return;
    }
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: formatError(error) });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Max WorkItems allowed per Request in a single planning pass. */
const MAX_WORK_ITEMS_PER_REQUEST = 20;

/**
 * Validate a body that claims to be a fully-formed WorkItem (legacy path).
 * Returns a list of validation error strings (empty = valid).
 *
 * Checks:
 * 1. Schema: required fields present, type is valid
 * 2. Pool invariants: per-request cap, duplicate-id
 *
 * The minimal-input path (`CreateWorkItemInput`) bypasses this — see
 * {@link validateCreateWorkItemInput} for that shape's checks.
 *
 * @param workItem - The WorkItem to validate
 * @returns Array of error strings
 */
async function validateLegacyFullWorkItem(workItem: Record<string, unknown>): Promise<string[]> {
  const errors: string[] = [];

  // 1. Schema Check
  if (!workItem.id || typeof workItem.id !== 'string') {
    errors.push('WorkItem.id is required and must be a string');
  }
  if (!workItem.title || typeof workItem.title !== 'string') {
    errors.push('WorkItem.title is required');
  }
  if (!workItem.type || typeof workItem.type !== 'string') {
    errors.push('WorkItem.type is required');
  } else if (!isValidWorkItemType(workItem.type)) {
    errors.push(`WorkItem.type "${workItem.type}" is invalid; must be one of: ${WORK_ITEM_TYPES.join(', ')}`);
  }
  if (!workItem.owner || typeof workItem.owner !== 'string') {
    errors.push('WorkItem.owner is required');
  }

  if (errors.length > 0) return errors; // Bail out early on schema errors

  // 2. Pool invariants
  const invariantErrors = await checkPoolInvariants({
    id: workItem.id as string,
    requestId: workItem.requestId as string | undefined,
  });
  return invariantErrors;
}

/**
 * Pool-level invariant checks that run for BOTH the legacy full-shape
 * path and the minimal-input path. Split out from
 * {@link validateLegacyFullWorkItem} so the minimal path (which has
 * already passed `validateCreateWorkItemInput`) can reuse them after
 * `createWorkItem` generates the id.
 *
 * Invariants:
 * - Per-`requestId` cap: no more than `MAX_WORK_ITEMS_PER_REQUEST` active
 *   WIs share the same parent Request. Guards against runaway recursive
 *   decomposition.
 * - Duplicate-id: a WI with this id must not already exist in the pool.
 *
 * @param wi - `{id, requestId?}` minimum surface needed for the checks
 * @returns Array of error strings (empty = invariants hold)
 */
async function checkPoolInvariants(wi: { id: string; requestId?: string }): Promise<string[]> {
  const errors: string[] = [];
  try {
    const svc = getService();
    const allItems = await svc.getAllItems();

    let duplicate: typeof allItems[number] | undefined;
    let sameRequestActiveCount = 0;
    for (const existing of allItems) {
      if (!duplicate && existing.id === wi.id) {
        duplicate = existing;
      }
      if (
        wi.requestId &&
        existing.requestId === wi.requestId &&
        existing.status !== 'done' &&
        existing.status !== 'cancelled'
      ) {
        sameRequestActiveCount += 1;
      }
    }

    if (duplicate) {
      errors.push(`WorkItem.id "${wi.id}" already exists in pool (status: ${duplicate.status})`);
    }

    if (wi.requestId && sameRequestActiveCount >= MAX_WORK_ITEMS_PER_REQUEST) {
      errors.push(
        `Request ${wi.requestId} already has ${sameRequestActiveCount} active WorkItems (max ${MAX_WORK_ITEMS_PER_REQUEST}). Possible infinite decomposition loop.`,
      );
    }
  } catch (err) {
    logger.debug('WorkItem invariant check failed (non-fatal)', { error: formatError(err) });
  }
  return errors;
}

/**
 * Asynchronously rolls up token usage from a completed TaskRecord to its parent Request.
 * Non-blocking — errors are swallowed to avoid slowing down API responses.
 *
 * @param requestId - The parent Request ID
 * @param tokenUsage - Token usage to roll up
 */
function rollUpTokensToRequest(
  requestId: string,
  tokenUsage: TokenUsage,
): void {
  setImmediate(async () => {
    try {
      const { RequestService } = await import('../../services/v3/request.service.js');
      const requestService = RequestService.getInstance();
      const request = await requestService.getById(requestId);
      if (!request) return;

      await requestService.update(requestId, {
        totalInputTokens: (request.totalInputTokens || 0) + (tokenUsage.promptTokens || 0),
        totalOutputTokens: (request.totalOutputTokens || 0) + (tokenUsage.completionTokens || 0),
        totalCost: (request.totalCost || 0) + (tokenUsage.estimatedCostUsd || 0),
      });

      // Cascade up to Mission if this Request belongs to one
      if (request.missionId && tokenUsage.estimatedCostUsd) {
        rollUpTokensToMission(request.missionId, tokenUsage);
      }
    } catch (err) {
      logger.debug('Token roll-up to Request failed (non-fatal)', { requestId, error: formatError(err) });
    }
  });
}

/**
 * Asynchronously rolls up token usage from a Request to its parent Mission.
 * Errors are swallowed — this must never block agent-facing operations.
 *
 * @param missionId - The parent Mission ID
 * @param tokenUsage - Token counts to accumulate
 */
function rollUpTokensToMission(missionId: string, tokenUsage: TokenUsage): void {
  setImmediate(async () => {
    try {
      const { _loadMission, _saveMission } = await import('../mission/mission-policy.controller.js');
      const mission = await _loadMission(missionId);
      if (!mission) return;
      mission.totalInputTokens = (mission.totalInputTokens || 0) + (tokenUsage.promptTokens || 0);
      mission.totalOutputTokens = (mission.totalOutputTokens || 0) + (tokenUsage.completionTokens || 0);
      mission.totalCost = (mission.totalCost || 0) + (tokenUsage.estimatedCostUsd || 0);
      mission.updatedAt = new Date().toISOString();
      await _saveMission(mission);
    } catch (err) {
      logger.debug('Token roll-up to Mission failed (non-fatal)', { missionId, error: formatError(err) });
    }
  });
}

/**
 * Parses optional filter query parameters into a PoolFilters object.
 *
 * @param req - Express request
 * @returns Parsed filters, or undefined if none provided
 */
function parseQueryFilters(req: Request): PoolFilters | undefined {
  const { types, owner, target, missionId } = req.query;

  const hasAny = types || owner || target || missionId;
  if (!hasAny) return undefined;

  const filters: PoolFilters = {};

  if (typeof types === 'string' && types.trim()) {
    filters.types = types.split(',').map((t) => t.trim()) as PoolFilters['types'];
  }
  if (typeof owner === 'string' && owner.trim()) {
    filters.owner = owner.trim() as PoolFilters['owner'];
  }
  if (typeof target === 'string' && target.trim()) {
    filters.target = target.trim();
  }
  if (typeof missionId === 'string' && missionId.trim()) {
    filters.missionId = missionId.trim();
  }

  return filters;
}

// ---------------------------------------------------------------------------
// GET /api/task-pool/give-up-stats — Give-up metrics per team (#841)
// ---------------------------------------------------------------------------

/**
 * Give-up count, retries and retry success rate per team (#841).
 *
 * Query: `teamId` (optional) to return one team.
 *
 * @param req - Express request
 * @param res - Express response
 */
export async function getGiveUpStats(req: Request, res: Response): Promise<void> {
  try {
    const teamId = typeof req.query.teamId === 'string' && req.query.teamId ? req.query.teamId : undefined;
    const [items, teams] = await Promise.all([
      getService().getAllItems(),
      StorageService.getInstance().getTeams(),
    ]);
    res.json({ success: true, data: computeGiveUpStats(items, teams, teamId) });
  } catch (error) {
    handleServiceError(res, error);
  }
}

/**
 * The person a new WorkItem is done for: whoever the creating agent acts
 * for, or the owner for a request with no agent session (issue #968).
 *
 * @param req - The add request
 * @returns Person id
 */
export function actingForOfCreator(req: Pick<Request, 'headers'>): string {
  try {
    return getActingFor().actorFor(readAgentSessionHeader(req)).id;
  } catch {
    return PEOPLE_CONSTANTS.OWNER_ID;
  }
}
