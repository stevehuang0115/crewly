/**
 * Request Service — CRUD operations for V3 Request entities
 *
 * Requests represent user-level goals. They are stored as JSON files
 * in `{projectPath}/.crewly/requests/{id}.json`.
 *
 * @module services/v3/request.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { LoggerService } from '../core/logger.service.js';
import { ensureDir, atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import {
  type Request,
  type CreateRequestInput,
  type UpdateRequestInput,
  type RequestStatus,
  isRequest,
  isValidRequestTransition,
  validateCreateRequestInput,
  createRequest,
} from '../../types/v2/index.js';
import {
  type WorkItem,
  TERMINAL_WORK_ITEM_STATUSES,
} from '../../types/v2/work-item.types.js';
import { classifyIntent, planTasksFromObjective, type PlannedTask } from './v3-data.service.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';

/** Directory name under .crewly for request storage. */
const REQUESTS_DIR = 'requests';

// ---------------------------------------------------------------------------
// P1 Bug C — Request → done lifecycle gate (Pool umbrella WI 72ca743a)
// ---------------------------------------------------------------------------

/**
 * Duck-typed interface RequestService uses to query child WorkItem
 * states for the {@link RequestService.update} → done gate.
 *
 * Defined as an interface (not a TaskPoolService import) so request.service
 * does NOT acquire a static dependency on task-pool.service. The dependency
 * direction stays one-way: TaskPool → Request (via Bug B's
 * `IRequestWorkItemLinker`), Request → TaskPool only via this duck-typed
 * setter (Bug C). This breaks the otherwise-circular type graph that would
 * form if either side imported the other concretely.
 *
 * Tests pass a fake; production wires the real TaskPoolService instance via
 * {@link RequestService.setTaskPoolService}.
 *
 * P1 Bug C (Pool umbrella WI 72ca743a-3a66-4d0e-a6cf-1a861f849dbd, sub-WI
 *           72ca743a Bug C): the F9 fixture closed a Request to status=done
 * with a non-terminal child WI in the pool. The gate fetches each child by
 * id and refuses the transition if any child is in a non-terminal state.
 */
export interface IWorkItemQueryable {
  /**
   * Look up a WorkItem by id. Returns `null` if no item has that id —
   * mirrors {@link TaskPoolService.findWorkItem}'s null-fallthrough idiom.
   *
   * @param workItemId - WorkItem id to look up
   * @returns The WorkItem, or `null` if no item has that id
   */
  findWorkItem(workItemId: string): Promise<WorkItem | null>;
}

/**
 * Structured error thrown when {@link RequestService.update} refuses to
 * transition a Request to `done` because at least one of its child
 * WorkItems is still in a non-terminal state.
 *
 * Distinct error class (not a generic `Error`) so callers can branch on
 * `instanceof RequestStillHasOpenChildrenError` and surface a meaningful
 * message — Slack bridge, REST consumers, audit, all want to differentiate
 * "still has open children" from generic transition-validation errors.
 *
 * The structured payload exposes `requestId`, `openChildIds`, and
 * `openChildCount` so consumers can render actionable messages without
 * re-querying the pool.
 */
export class RequestStillHasOpenChildrenError extends Error {
  /** The Request id that was refused. */
  public readonly requestId: string;
  /** WorkItem ids of children that are still in non-terminal status. */
  public readonly openChildIds: readonly string[];
  /** Convenience: openChildIds.length, included for log/format symmetry. */
  public readonly openChildCount: number;

  constructor(args: { requestId: string; openChildIds: readonly string[] }) {
    const count = args.openChildIds.length;
    super(
      `Request '${args.requestId}' cannot transition to 'done': ` +
      `${count} child WorkItem${count === 1 ? '' : 's'} still in non-terminal ` +
      `state (${args.openChildIds.join(', ')}). Terminal WI statuses are: ` +
      `${[...TERMINAL_WORK_ITEM_STATUSES].join(', ')}.`,
    );
    this.name = 'RequestStillHasOpenChildrenError';
    this.requestId = args.requestId;
    this.openChildIds = args.openChildIds;
    this.openChildCount = count;
    // Restore prototype chain — required when extending Error in TS targets
    // older than ES2015 to keep `instanceof` working through transpilation.
    Object.setPrototypeOf(this, RequestStillHasOpenChildrenError.prototype);
  }
}

/**
 * Module-level event bus reference, wired from `backend/src/index.ts` via
 * {@link setRequestServiceEventBus}. RequestService uses this to publish
 * `request:created` events for INBOUND-1 without forming a static cycle
 * with EventBusService at module load.
 *
 * Tests can swap or clear via the same setter.
 */
let injectedEventBus: EventBusService | null = null;

/**
 * Wire the EventBusService that {@link RequestService} should publish
 * lifecycle events to. Called once from the backend boot path before any
 * Request creation can fire.
 *
 * @param bus - The live EventBusService, or null to clear (tests)
 */
export function setRequestServiceEventBus(bus: EventBusService | null): void {
  injectedEventBus = bus;
}

/**
 * Service for managing Request entities on disk.
 *
 * Uses singleton pattern for consistent state across the backend.
 * All persistence is file-based (one JSON file per Request).
 *
 * @example
 * ```typescript
 * const service = RequestService.getInstance('/path/to/project');
 * const req = await service.create({ title: 'Deploy staging', ... });
 * ```
 */
export class RequestService {
  private static instance: RequestService | null = null;

  private readonly logger = LoggerService.getInstance().createComponentLogger('RequestService');
  private readonly requestsDir: string;

  /**
   * Optional TaskPool reference used by the {@link update} → done gate
   * to verify that all child WorkItems are in terminal state before the
   * Request itself can close. Wired via {@link setTaskPoolService} from
   * the backend boot path (P1 Bug C — Pool umbrella WI 72ca743a).
   *
   * When `null`, the gate degrades gracefully — closure proceeds with a
   * warning log. This preserves backward compatibility for tests and
   * boot orderings that happen to call `update` before the wiring step.
   * Production paths always wire the dependency before any user-facing
   * Request close request can land.
   */
  private taskPoolService: IWorkItemQueryable | null = null;

  /**
   * Creates a new RequestService.
   *
   * @param projectPath - Absolute path to the project root
   */
  private constructor(private readonly projectPath: string) {
    this.requestsDir = path.join(projectPath, '.crewly', REQUESTS_DIR);
  }

  /**
   * Gets the singleton instance.
   *
   * @param projectPath - Absolute path to the project root
   * @returns The singleton RequestService instance
   */
  public static getInstance(projectPath?: string): RequestService {
    if (!RequestService.instance) {
      const resolvedPath = projectPath || process.env.CREWLY_PROJECT_PATH || process.cwd();
      RequestService.instance = new RequestService(resolvedPath);
    }
    return RequestService.instance;
  }

  /**
   * Resets the singleton instance. For test isolation only.
   */
  public static resetInstance(): void {
    RequestService.instance = null;
  }

  /**
   * Wire the TaskPool-queryable used by the Request → done gate
   * (P1 Bug C — Pool umbrella WI 72ca743a).
   *
   * Called from the backend boot path after both services exist. Mirrors
   * Bug B's {@link TaskPoolService.setRequestService} — same setter shape,
   * idempotent, accepts `null` to clear in tests. Keeps the dependency
   * direction Request → TaskPool one-way and duck-typed, so neither
   * service needs a static import of the other.
   *
   * @param svc - The TaskPoolService instance (or any object satisfying
   *   {@link IWorkItemQueryable}), or null to clear.
   */
  public setTaskPoolService(svc: IWorkItemQueryable | null): void {
    this.taskPoolService = svc;
  }

  // ---------------------------------------------------------------------------
  // File helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns the file path for a request JSON file.
   *
   * @param requestId - The request ID
   * @returns Absolute path to the request JSON file
   */
  private getFilePath(requestId: string): string {
    return path.join(this.requestsDir, `${requestId}.json`);
  }

  /**
   * Loads a single Request from disk.
   *
   * @param requestId - The request ID
   * @returns The Request or null if not found
   */
  private async load(requestId: string): Promise<Request | null> {
    const data = await safeReadJson<Request | null>(this.getFilePath(requestId), null);
    if (!data || !isRequest(data)) return null;
    return data;
  }

  /**
   * Saves a Request to disk atomically.
   *
   * @param request - The Request to persist
   */
  private async save(request: Request): Promise<void> {
    await ensureDir(this.requestsDir);
    await atomicWriteJson(this.getFilePath(request.id), request);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Creates a new Request.
   *
   * Publishes a `request:created` event after successful save so the
   * INBOUND-1 SLA subscriber (and any other in-process listener) can react
   * to inbound user goals. Event publication is best-effort — a failure to
   * publish does NOT roll back the persisted Request, but is logged.
   *
   * @param input - Creation input
   * @returns The created Request
   * @throws Error if validation fails
   */
  public async create(input: CreateRequestInput): Promise<Request> {
    const errors = validateCreateRequestInput(input);
    if (errors.length > 0) {
      throw new Error(`Invalid CreateRequestInput: ${errors.join('; ')}`);
    }

    // Auto-classify intent when caller didn't pass explicit values.
    // Without this fallback, every Request from a non-classifying caller
    // landed as L1+other and was silently skipped by the auto-decompose
    // subscriber — Slack/chat ingress paths hit this, and the entire
    // Request → WorkItem pipeline became a no-op for inbound user
    // messages. Explicit caller values still win (an agent that
    // computed L2+code_change at the source keeps that classification).
    const needsClassify = input.intentLevel === undefined || input.intentCategory === undefined;
    const classified = needsClassify ? classifyIntent(input.description) : null;
    const enriched: CreateRequestInput = classified
      ? {
          ...input,
          intentLevel: input.intentLevel ?? classified.intentLevel,
          intentCategory: input.intentCategory ?? classified.intentCategory,
        }
      : input;

    const request = createRequest(enriched);
    await this.save(request);
    this.logger.debug('Request created', { id: request.id, title: request.title });

    // INBOUND-1: emit `request:created` for the SLA subscriber. The bus is
    // wired via {@link setRequestServiceEventBus} from the backend boot
    // path; if it was never wired (some test setups) the event is silently
    // skipped — Request persistence is already complete and must not be
    // rolled back.
    this.publishCreatedEvent(request);

    return request;
  }

  /**
   * Publish the `request:created` event. Synchronous best-effort — failures
   * are logged but do not propagate to the caller (Request persistence is
   * already complete and must not be rolled back).
   *
   * @param request - The Request that was just persisted
   */
  private publishCreatedEvent(request: Request): void {
    if (!injectedEventBus) return;
    try {
      injectedEventBus.publish({
        id: `request:created:${request.id}`,
        type: 'request:created',
        timestamp: request.createdAt,
        // Request is not team-scoped at this layer; tags carry the source.
        teamId: '',
        teamName: '',
        memberId: '',
        memberName: '',
        sessionName: '',
        previousValue: '',
        newValue: request.status,
        // 'taskStatus' is the closest existing ChangedField for a Request
        // lifecycle signal. Adding 'requestStatus' would touch 23 unrelated
        // call sites; the request:created event itself is the canonical hook.
        // TODO(autonomy_v2): add 'requestStatus' to ChangedField when chat-v2
        // ingress (INBOUND-2) lands and we revisit the enum-narrowing decision.
        // Filed as Arch N4 on PR #357.
        changedField: 'taskStatus',
        requestId: request.id,
        missionId: request.missionId,
      });
    } catch (err) {
      this.logger.warn('Failed to publish request:created event', {
        requestId: request.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Gets a Request by ID.
   *
   * @param id - Request ID
   * @returns The Request or null
   */
  public async getById(id: string): Promise<Request | null> {
    return this.load(id);
  }

  /**
   * Lists all Requests.
   *
   * @returns Array of all Requests, sorted by createdAt descending
   */
  public async listAll(): Promise<Request[]> {
    await ensureDir(this.requestsDir);

    let files: string[];
    try {
      files = await fs.readdir(this.requestsDir);
    } catch {
      return [];
    }

    const jsonFiles = files.filter((f) => f.endsWith('.json'));
    const requests: Request[] = [];

    for (const file of jsonFiles) {
      const filePath = path.join(this.requestsDir, file);
      const data = await safeReadJson<Request | null>(filePath, null);
      if (data && isRequest(data)) {
        requests.push(data);
      }
    }

    requests.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    return requests;
  }

  /**
   * Updates a Request with partial fields.
   *
   * @param id - Request ID
   * @param updates - Fields to update
   * @returns The updated Request
   * @throws Error if not found or invalid transition
   */
  public async update(id: string, updates: UpdateRequestInput): Promise<Request> {
    const request = await this.load(id);
    if (!request) {
      throw new Error(`Request not found: ${id}`);
    }

    // Validate status transition if status is being updated
    if (updates.status && updates.status !== request.status) {
      if (!isValidRequestTransition(request.status, updates.status)) {
        throw new Error(
          `Invalid status transition: ${request.status} -> ${updates.status}`,
        );
      }

      // P1 Bug C (Pool umbrella WI 72ca743a) — child WorkItem terminal-state
      // gate. Refuse Request → done if any child WI in workItemIds[] is in a
      // non-terminal state. F9 fixture symptom: Request closed to done with a
      // queued child WI still in the pool. Bug B (#467, merged 8bf58a11) made
      // workItemIds[] authoritative on every addToPool, so the gate operates
      // on reliable data.
      //
      // Only `done` is gated. `cancelled` is intentionally NOT gated — a
      // user / TL may cancel a Request while children are mid-flight; the
      // cancellation cascade (orphaned children) is a separate concern owned
      // by a future work item.
      //
      // The gate degrades gracefully when `taskPoolService` is null (test or
      // unwired boot order): a warning is logged and the transition proceeds
      // with the original (pre-fix) behavior. Production wiring runs before
      // any user-facing close path.
      if (updates.status === 'done' && request.workItemIds.length > 0) {
        await this.assertAllChildrenTerminal(request);
      }

      request.status = updates.status;
      if (updates.status === 'done' || updates.status === 'cancelled') {
        request.completedAt = new Date().toISOString();
      }
    }

    // Apply other updates
    if (updates.title !== undefined) request.title = updates.title;
    if (updates.description !== undefined) request.description = updates.description;
    if (updates.priority !== undefined) request.priority = updates.priority;
    if (updates.requiresConfirmation !== undefined) request.requiresConfirmation = updates.requiresConfirmation;
    if (updates.confirmationReason !== undefined) request.confirmationReason = updates.confirmationReason;
    if (updates.missionId !== undefined) request.missionId = updates.missionId;
    if (updates.projectTaskId !== undefined) request.projectTaskId = updates.projectTaskId;
    if (updates.result !== undefined) request.result = updates.result;
    if (updates.tags !== undefined) request.tags = updates.tags;
    if (updates.totalInputTokens !== undefined) request.totalInputTokens = updates.totalInputTokens;
    if (updates.totalOutputTokens !== undefined) request.totalOutputTokens = updates.totalOutputTokens;
    if (updates.totalCost !== undefined) request.totalCost = updates.totalCost;
    if (updates.ownerAgent !== undefined) request.ownerAgent = updates.ownerAgent;

    request.updatedAt = new Date().toISOString();
    await this.save(request);
    this.logger.debug('Request updated', { id, status: request.status });
    return request;
  }

  /**
   * P1 Bug C gate helper — verify that every WorkItem id in
   * `request.workItemIds[]` resolves to a WorkItem in terminal state.
   *
   * Throws {@link RequestStillHasOpenChildrenError} when at least one child
   * is non-terminal. Missing children (returned `null` by
   * {@link IWorkItemQueryable.findWorkItem}) are treated as **terminal /
   * harmless** — a deleted-or-purged WI does not block its parent's
   * closure. This matches the option-a "graceful degrade" stance ORC took
   * on historical orphan WIs and avoids a deadlock between data-cleanup
   * jobs and lifecycle gates.
   *
   * Semantics: non-terminal = anything not in
   * {@link TERMINAL_WORK_ITEM_STATUSES} (`done`, `verified`, `cancelled`).
   * `failed` and `rejected` are treated as non-terminal because the WI
   * state-machine in {@link WORK_ITEM_TRANSITIONS} explicitly allows them
   * to re-enter `queued` — work the user requested is not actually
   * complete.
   *
   * @param request - The Request whose children to verify
   * @throws {@link RequestStillHasOpenChildrenError} when any child is
   *   non-terminal.
   */
  private async assertAllChildrenTerminal(request: Request): Promise<void> {
    if (!this.taskPoolService) {
      // Graceful degrade — preserve pre-fix behavior when the gate hasn't
      // been wired yet (test scaffold, unusual boot order). Production
      // boot wires the dependency before any user-facing close path.
      this.logger.warn(
        'Request → done lifecycle gate skipped: taskPoolService not wired',
        { requestId: request.id, childCount: request.workItemIds.length },
      );
      return;
    }

    const queryable = this.taskPoolService;
    const children = await Promise.all(
      request.workItemIds.map((id) => queryable.findWorkItem(id)),
    );

    const openChildIds: string[] = [];
    for (let i = 0; i < children.length; i++) {
      const wi = children[i];
      if (wi !== null && !TERMINAL_WORK_ITEM_STATUSES.has(wi.status)) {
        openChildIds.push(wi.id);
      }
    }

    if (openChildIds.length > 0) {
      this.logger.info('Request → done refused: open child WorkItems', {
        requestId: request.id,
        openChildCount: openChildIds.length,
        openChildIds,
      });
      throw new RequestStillHasOpenChildrenError({
        requestId: request.id,
        openChildIds,
      });
    }
  }

  /**
   * Deletes a Request from disk. Used for purging old completed Requests.
   *
   * @param id - The Request ID to delete
   */
  public async delete(id: string): Promise<void> {
    const filePath = this.getFilePath(id);
    try {
      await fs.unlink(filePath);
      this.logger.debug('Request deleted', { id });
    } catch {
      // File may not exist — ignore
    }
  }

  /**
   * Adds a WorkItem ID to a Request's workItemIds array.
   *
   * @param requestId - The Request ID
   * @param workItemId - The WorkItem ID to link
   * @returns The updated Request, or null if Request not found
   */
  public async linkWorkItem(requestId: string, workItemId: string): Promise<Request | null> {
    const request = await this.load(requestId);
    if (!request) return null;

    if (!request.workItemIds.includes(workItemId)) {
      request.workItemIds.push(workItemId);
      request.updatedAt = new Date().toISOString();
      await this.save(request);
      this.logger.debug('WorkItem linked to Request', { requestId, workItemId });
    }

    return request;
  }

  /**
   * Finds a Request by its source conversation item ID.
   * Used for deduplication — avoids creating duplicate Requests for the same message.
   *
   * @param sourceConversationItemId - The conversation item ID
   * @returns The matching Request, or null
   */
  public async findBySourceConversationItemId(sourceConversationItemId: string): Promise<Request | null> {
    const all = await this.listAll();
    return all.find((r) => r.sourceConversationItemId === sourceConversationItemId) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Planning — Request → Task Decomposition
  // ---------------------------------------------------------------------------

  /**
   * Decomposes a user message into a proposed list of ProjectTasks.
   *
   * This is the "TodoWrite-style" planning phase: given a raw user message,
   * it classifies the intent and returns structured tasks that can be
   * reviewed, approved, and then executed.
   *
   * Currently uses keyword-based decomposition (same logic as Mission
   * decomposition in V3DataService). Can be upgraded to AI-based planning
   * in the future without changing the API contract.
   *
   * @param message - The raw user message text
   * @param options - Optional planning configuration
   * @returns A RequestPlan with proposed tasks and metadata
   *
   * @example
   * ```typescript
   * const plan = await requestService.plan('Build a new auth system');
   * // plan.tasks → [{ title: 'Design...', ... }, { title: 'Implement...', ... }, ...]
   * ```
   */
  public async plan(message: string, options?: PlanOptions): Promise<RequestPlan> {
    if (!message || message.trim().length < 2) {
      return {
        message,
        tasks: [],
        reasoning: 'Message too short to decompose into tasks.',
        strategy: 'none',
      };
    }

    const trimmed = message.trim();
    const tasks = planTasksFromObjective(trimmed);

    // Determine which strategy was selected (English + Chinese keywords)
    const lower = trimmed.toLowerCase();
    let strategy: PlanStrategy;
    if (/\b(build|create|implement|add|feature|develop|write|ship)\b/.test(lower) || /创建|实现|添加|开发|编写|搭建|新增/.test(trimmed)) {
      strategy = 'build';
    } else if (/\b(fix|debug|resolve|repair|patch|broken|bug|error|crash)\b/.test(lower) || /修复|修|调试|解决|修补|bug|报错|崩溃/.test(trimmed)) {
      strategy = 'fix';
    } else {
      strategy = 'generic';
    }

    this.logger.debug('Request planned', {
      messageLength: trimmed.length,
      strategy,
      taskCount: tasks.length,
    });

    return {
      message: trimmed,
      tasks,
      reasoning: `Decomposed using "${strategy}" strategy into ${tasks.length} tasks.`,
      strategy,
    };
  }
}

// ---------------------------------------------------------------------------
// Plan Types
// ---------------------------------------------------------------------------

/**
 * Strategy used for task decomposition.
 */
export type PlanStrategy = 'build' | 'fix' | 'generic' | 'none';

/**
 * Optional configuration for the plan method.
 */
export interface PlanOptions {
  /** Maximum number of tasks to generate */
  maxTasks?: number;
  /** Preferred priority for generated tasks */
  defaultPriority?: 'high' | 'medium' | 'low';
}

/**
 * Result of planning a user request into tasks.
 */
export interface RequestPlan {
  /** The original user message */
  message: string;
  /** Proposed tasks derived from the message */
  tasks: PlannedTask[];
  /** Human-readable explanation of the decomposition */
  reasoning: string;
  /** Which planning strategy was applied */
  strategy: PlanStrategy;
}
