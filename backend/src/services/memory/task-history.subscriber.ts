/**
 * Task History Subscriber
 *
 * Listens on the in-process EventBus for `task:done_by_worker`,
 * `task:rejected`, and `task:cancelled` and writes a {@link
 * TaskHistoryEntry} into the originating project's `ProjectMemory`.
 *
 * This is the load-bearing write path behind "who in my team has done
 * X?" — the orchestrator queries the resulting ledger via
 * `recall_memory({ capability: '<canonical-cap>' })` before delegating
 * external-access work.
 *
 * @module services/memory/task-history.subscriber
 */

import {
  EventBusService,
  type InProcessUnsubscribe,
} from '../event-bus/event-bus.service.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { IProjectMemoryService } from './project-memory.service.js';
import {
  TaskHistoryEntry,
  TaskOutcome,
} from '../../types/memory.types.js';
import {
  AgentEvent,
  EventType,
} from '../../types/event-bus.types.js';
import { LoggerService } from '../core/logger.service.js';
import {
  CapabilityInferenceService,
  inferCapabilities,
} from './capability-inference.js';

/** Event types we record. Symmetric across success/failure/cancellation. */
const RECORDED_EVENT_TYPES: readonly EventType[] = [
  'task:done_by_worker' as EventType,
  'task:rejected' as EventType,
  'task:cancelled' as EventType,
] as const;

/**
 * Map task pool event types → TaskOutcome. Done-by-worker is the
 * success path; rejected is verifier-driven failure; cancelled is
 * lifecycle abandonment (which we record as `partial` so the
 * capability-index can still surface "the agent attempted this kind
 * of work" without misleading on success rates).
 */
function eventTypeToOutcome(eventType: string): TaskOutcome {
  switch (eventType) {
    case 'task:done_by_worker':
      return 'success';
    case 'task:rejected':
      return 'failure';
    case 'task:cancelled':
      return 'partial';
    default:
      return 'partial';
  }
}

export interface TaskHistorySubscriberDeps {
  /** Bus to listen on */
  eventBus: EventBusService;
  /** Memory service that owns the ledger */
  projectMemoryService: IProjectMemoryService;
  /** Pool service used to resolve the WorkItem from id (description, type, etc.) */
  taskPoolService: TaskPoolService;
  /** Optional override for capability inference (tests pass a stub) */
  capabilityInference?: CapabilityInferenceService;
  /**
   * Optional override for the project path resolver. Production uses the
   * WorkItem's `metadata.projectPath`; tests can substitute a fixed path.
   */
  resolveProjectPath?: (event: AgentEvent) => string | null;
}

export class TaskHistorySubscriber {
  private readonly logger = LoggerService.getInstance().createComponentLogger(
    'TaskHistorySubscriber',
  );
  private readonly eventBus: EventBusService;
  private readonly projectMemory: IProjectMemoryService;
  private readonly taskPool: TaskPoolService;
  private readonly inference: CapabilityInferenceService;
  private readonly resolveProjectPath: (event: AgentEvent) => string | null;
  private unsubscribeFn: InProcessUnsubscribe | null = null;

  constructor(deps: TaskHistorySubscriberDeps) {
    this.eventBus = deps.eventBus;
    this.projectMemory = deps.projectMemoryService;
    this.taskPool = deps.taskPoolService;
    this.inference = deps.capabilityInference ?? { infer: inferCapabilities };
    this.resolveProjectPath = deps.resolveProjectPath ?? defaultResolveProjectPath;
  }

  /**
   * Attach the in-process handler. Returns a detach function. Idempotent —
   * calling start() twice without intervening stop() returns the first
   * detach function (the second start is a no-op).
   */
  start(): InProcessUnsubscribe {
    if (this.unsubscribeFn) {
      this.logger.debug('start() called while already attached — returning existing detach');
      return this.unsubscribeFn;
    }
    this.unsubscribeFn = this.eventBus.onInProcess(
      [...RECORDED_EVENT_TYPES],
      (event) => this.handle(event),
    );
    this.logger.info('TaskHistorySubscriber attached', {
      types: RECORDED_EVENT_TYPES,
    });
    return this.unsubscribeFn;
  }

  /**
   * Detach the handler. Safe to call multiple times.
   */
  stop(): void {
    if (this.unsubscribeFn) {
      this.unsubscribeFn();
      this.unsubscribeFn = null;
      this.logger.info('TaskHistorySubscriber detached');
    }
  }

  /**
   * Handle one event. Public for unit testing — production flow goes
   * through the bus.
   */
  async handle(event: AgentEvent): Promise<void> {
    try {
      const workItemId = event.workItemId;
      if (!workItemId) {
        this.logger.debug('Event has no workItemId — skipping', {
          eventId: event.id,
          type: event.type,
        });
        return;
      }

      const workItem = await this.taskPool.findWorkItem(workItemId);
      if (!workItem) {
        this.logger.debug('WorkItem not found in pool — skipping', { workItemId });
        return;
      }

      const projectPath = this.resolveProjectPath(event);
      if (!projectPath) {
        this.logger.debug('No projectPath resolvable — skipping', {
          workItemId,
          eventId: event.id,
        });
        return;
      }

      const sessionName =
        event.sessionName ||
        (workItem.target as string | undefined) ||
        (workItem.owner as string | undefined) ||
        '';
      if (!sessionName) {
        this.logger.debug('No session attributable — skipping', { workItemId });
        return;
      }

      const role = (workItem.metadata?.['role'] as string | undefined) ?? 'unknown';
      const teamId =
        (workItem.metadata?.['teamId'] as string | undefined) ||
        event.teamId ||
        undefined;

      const description =
        (workItem.title as string | undefined) ||
        (workItem.briefMarkdown as string | undefined)?.slice(0, 200) ||
        '(no description)';

      // Cast through unknown: WorkItem is a richer typed shape, but the
      // helpers only need free-form metadata access. Avoids importing
      // WorkItem's type just to widen it.
      const workItemAsRecord = workItem as unknown as Record<string, unknown>;
      const toolsUsed = extractToolsUsed(workItemAsRecord);
      const capabilities = this.inference.infer(toolsUsed, workItemAsRecord);

      const entry: TaskHistoryEntry = {
        id: `th-${workItemId}`,
        completedAt: event.timestamp || new Date().toISOString(),
        agent: { sessionName, role, teamId },
        task: {
          description,
          outcome: eventTypeToOutcome(event.type as string),
        },
        capabilities,
        toolsUsed,
        taskId: workItemId,
      };

      await this.projectMemory.addTaskHistory(projectPath, entry);
      this.logger.info('Task history recorded', {
        workItemId,
        sessionName,
        outcome: entry.task.outcome,
        capCount: capabilities.length,
      });
    } catch (err) {
      // Subscribers MUST swallow exceptions — a memory-write failure
      // cannot back out the upstream task completion.
      this.logger.warn('Failed to record task history (non-fatal)', {
        eventId: event.id,
        eventType: event.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Default resolver: lift `metadata.projectPath` off the WorkItem. The
 * subscriber prefers the event's own projectPath if present, then falls
 * back to the WorkItem's. Returns null when neither is set.
 *
 * Exported for unit testing.
 */
export function defaultResolveProjectPath(event: AgentEvent): string | null {
  // AgentEvent doesn't have a typed projectPath field, but task-pool
  // events sometimes ride one as a free-form attribute. Be defensive.
  const eventPath = (event as unknown as Record<string, unknown>)['projectPath'];
  if (typeof eventPath === 'string' && eventPath.length > 0) {
    return eventPath;
  }
  return null;
}

/**
 * Extract the tool names invoked during the task from the WorkItem's
 * metadata. Tries `metadata.toolsUsed` (canonical), `metadata.tools`
 * (legacy), and an empty list as a last resort.
 *
 * Exported for unit testing.
 */
export function extractToolsUsed(workItem: Record<string, unknown>): string[] {
  const metadata = workItem['metadata'] as Record<string, unknown> | undefined;
  if (!metadata) return [];
  const canonical = metadata['toolsUsed'];
  if (Array.isArray(canonical)) {
    return canonical.filter((t): t is string => typeof t === 'string');
  }
  const legacy = metadata['tools'];
  if (Array.isArray(legacy)) {
    return legacy.filter((t): t is string => typeof t === 'string');
  }
  return [];
}
