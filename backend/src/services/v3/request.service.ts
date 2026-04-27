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
import { planTasksFromObjective, type PlannedTask } from './v3-data.service.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';

/** Directory name under .crewly for request storage. */
const REQUESTS_DIR = 'requests';

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

    const request = createRequest(input);
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
