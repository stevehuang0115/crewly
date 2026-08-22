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
import type { TokenUsage } from '../../types/v3/task-record.types.js';
import {
  WORK_ITEM_TYPES,
  isValidWorkItemType,
  createWorkItem,
  validateCreateWorkItemInput,
  type CreateWorkItemInput,
  type WorkItem,
} from '../../types/v2/work-item.types.js';
import { formatError } from '../../utils/format-error.js';
import { LoggerService } from '../../services/core/logger.service.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';

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
export async function addItem(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body;

    if (!body || typeof body !== 'object') {
      res.status(400).json({ success: false, error: 'Request body must be a WorkItem object' });
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

    // ServiceContract gate — only runs when the body carries cross-team
    // routing hints. Rejects before the item is enqueued.
    const rejection = await maybeEnforceContract(workItem as unknown as Record<string, unknown>);
    if (rejection) {
      res.status(rejection.status).json(rejection.payload);
      return;
    }

    await getService().addToPool(workItem);

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

    res.status(201).json({
      success: true,
      message: `WorkItem ${workItem.id} added to pool`,
      data: { workItemId: workItem.id, id: workItem.id, status: workItem.status },
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

    const hasTarget = typeof workItemId === 'string' && workItemId.trim().length > 0;
    const result = hasTarget
      ? await getService().claimSpecificItem(agentId.trim(), workItemId.trim())
      : await getService().claimFromPool(agentId.trim(), filters);

    if (!result) {
      res.status(404).json({
        success: false,
        error: hasTarget
          ? `WorkItem ${workItemId} is not claimable by ${agentId.trim()} (not queued, already claimed, target mismatch, or agent not active)`
          : 'No available WorkItem matching filters',
      });
      return;
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
 * Any field beyond `summary` inside `result` (e.g. `prNumber`, `links`)
 * is preserved into `WorkItem.output` via spread merge, so downstream
 * verifiers can read the proof-of-work without digging through chat logs.
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

    // Persist the summary onto the WorkItem.output. This makes the proof of
    // work queryable via `GET /api/task-pool/items/:id` (Request detail
    // page), and downstream services that want to read what the worker
    // actually produced (verifier, reviewer, mission audit) don't have to
    // dig back through chat logs.
    try {
      const existing = await getService().findWorkItem(workItemId);
      const mergedOutput: Record<string, unknown> = {
        ...(existing?.output ?? {}),
        summary,
        // Preserve any caller-supplied result fields beyond `summary`
        // (e.g. `links`, `prNumber`) as-is.
        ...(result ?? {}),
      };
      await getService().setOutput(workItemId, mergedOutput);
    } catch (err) {
      logger.warn('Failed to persist completion summary onto WI.output (non-fatal)', {
        workItemId,
        error: formatError(err),
      });
    }

    await getService().completeItem(workItemId, result);

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

    res.json({ success: true, message: `WorkItem ${workItemId} completed` });
  } catch (error) {
    handleServiceError(res, error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/task-pool/block/:workItemId — Block a WorkItem
// ---------------------------------------------------------------------------

/**
 * Marks a WorkItem as blocked.
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

    await getService().updateItemStatus(workItemId, 'blocked');

    // V3.1: Project task blocked
    const projection = getProjection();
    if (projection) {
      const records = projection.listRecords({ workItemId });
      const record = records[0];
      if (record) {
        projection.markBlocked(record.id, agentId, reason).catch((err) => { logger.debug('TaskProjection update failed (non-fatal)', { error: formatError(err) }); });
      }
    }

    res.json({ success: true, message: `WorkItem ${workItemId} blocked` });
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

    await getService().failItem(workItemId, errorMsg || 'unknown error');

    // V3.1: Project task failure
    const projection = getProjection();
    if (projection) {
      const records = projection.listRecords({ workItemId });
      const record = records[0];
      if (record) {
        projection.markFailed(record.id, agentId, errorMsg).catch((err) => { logger.debug('TaskProjection update failed (non-fatal)', { error: formatError(err) }); });
      }
    }

    res.json({ success: true, message: `WorkItem ${workItemId} failed` });
  } catch (error) {
    handleServiceError(res, error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/task-pool/items/:workItemId/cancel — Cancel a queued/blocked WI
// ---------------------------------------------------------------------------

/**
 * Cleanly cancel a WorkItem that is `queued`, `blocked`, or `scheduled`
 * (i.e. has not been claimed yet). Closes the #609 gap where no
 * non-destructive API existed for retiring a stuck queued WI — the only
 * options were `complete` (requires running) or `DELETE ?force=1` (hard
 * delete with no audit trail).
 *
 * Request body: `{ "reason": "short human-readable why" }`
 *   `reason` is required. It's persisted on `cancelReason` and surfaces
 *   in the activity timeline so the cancellation isn't an opaque event.
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
    await getService().cancelQueued(workItemId, reason);
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
