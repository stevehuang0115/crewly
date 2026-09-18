/**
 * TL Auto-Verify Service
 *
 * Automatically triggers Team Leader verification when a worker's task completes.
 * Listens to EventBus for task:done/task:completed events, looks up the worker's
 * TL via team hierarchy, and sends the TL a message to run verify-output with
 * the pre-approved checklist.
 *
 * Only activates for hierarchical teams with a defined TL.
 *
 * @module services/v3/tl-auto-verify.service
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TeamMemberInfo {
  id: string;
  sessionName: string;
  role: string;
  parentMemberId?: string;
  hierarchyLevel?: number;
}

interface TeamInfo {
  id: string;
  name: string;
  hierarchical?: boolean;
  members: TeamMemberInfo[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Service identifier for logs and the X-Agent-Session caller header. */
const SERVICE_NAME = 'TLAutoVerify';

/** Loopback API base (same one workitem-dispatch.subscriber.ts uses). */
const API_BASE = 'http://localhost:8787';

/** Timeout for the direct terminal write to the TL session. */
const TL_WRITE_TIMEOUT_MS = 5_000;

/** How the verify instruction reached the TL. */
type DeliveryPath = 'tl-terminal' | 'orchestrator-queue';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TLAutoVerifyService {
  private static instance: TLAutoVerifyService | null = null;
  private readonly logger: ComponentLogger;
  private eventBusService: { on: (event: string, handler: (...args: unknown[]) => void) => void } | null = null;
  private teamsProvider: (() => Promise<TeamInfo[]>) | null = null;

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('TLAutoVerify');
  }

  public static getInstance(): TLAutoVerifyService {
    if (!TLAutoVerifyService.instance) {
      TLAutoVerifyService.instance = new TLAutoVerifyService();
    }
    return TLAutoVerifyService.instance;
  }

  public static resetInstance(): void {
    TLAutoVerifyService.instance = null;
  }

  /**
   * Initialize with EventBus and team data source.
   */
  initialize(
    eventBusService: { on: (event: string, handler: (...args: unknown[]) => void) => void },
    teamsProvider?: () => Promise<TeamInfo[]>,
  ): void {
    this.eventBusService = eventBusService;
    this.teamsProvider = teamsProvider ?? null;
  }

  /**
   * Start listening for task completion events.
   */
  start(): void {
    if (!this.eventBusService) {
      this.logger.warn('Cannot start — EventBusService not initialized');
      return;
    }

    this.eventBusService.on('event_published', (payload: unknown) => {
      const event = payload as {
        eventType?: string;
        sessionName?: string;
        teamId?: string;
        taskId?: string;
      };
      if (!event?.eventType || !event?.sessionName) return;

      if (event.eventType === 'task:done' || event.eventType === 'task:completed') {
        this.onWorkerTaskCompleted(event.sessionName, event.teamId, event.taskId).catch((err) => {
          this.logger.debug('Auto-verify trigger failed (non-fatal)', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    });

    this.logger.info('TLAutoVerifyService started — worker task completions will trigger TL verification');
  }

  /**
   * Handle a worker's task completion. Finds the worker's TL and sends
   * a verification request.
   *
   * @param workerSessionName - The worker agent that completed the task
   * @param teamId - The team ID (if available from event)
   * @param taskId - The task ID (if available)
   */
  private async onWorkerTaskCompleted(
    workerSessionName: string,
    teamId?: string,
    taskId?: string,
  ): Promise<void> {
    // Find the worker's team and TL
    const tlInfo = await this.findTeamLeaderForWorker(workerSessionName, teamId);
    if (!tlInfo) {
      this.logger.debug('No TL found for worker — skipping auto-verify', { workerSessionName });
      return;
    }

    try {
      const verifyInstruction = [
        `[AUTO-VERIFY] Worker ${workerSessionName} has completed a task.`,
        taskId ? `Task ID: ${taskId}` : '',
        '',
        'Please verify the output using the pre-approved checklist:',
        '```bash',
        `bash config/skills/team-leader/verify-output/execute.sh '${JSON.stringify({
          taskId: taskId || workerSessionName,
          workerId: workerSessionName,
          teamId: tlInfo.teamId,
          projectPath: process.cwd(),
        })}'`,
        '```',
        '',
        'If verification passes, report results via aggregate-results.',
        'If verification fails, use handle-failure to retry or reassign.',
      ].filter(Boolean).join('\n');

      const deliveredVia = await this.deliverToTeamLeader(
        tlInfo.tlSessionName,
        verifyInstruction,
        workerSessionName,
        taskId,
      );

      this.logger.info('TL auto-verify triggered', {
        workerSession: workerSessionName,
        tlSession: tlInfo.tlSessionName,
        teamId: tlInfo.teamId,
        taskId,
        deliveredVia,
      });
    } catch (err) {
      this.logger.debug('Failed to send verify request to TL (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Deliver the verify instruction to the TL.
   *
   * The MessageQueueService is a FIFO destined for the orchestrator only (it
   * has no recipient field), so enqueuing there for a non-orchestrator TL
   * sends the instruction to the wrong agent. When the TL is a regular agent
   * session we write straight to its terminal the same way
   * `workitem-dispatch.subscriber.ts` does, and only fall back to the
   * orchestrator queue when that write fails (session offline/unknown).
   *
   * @param tlSessionName - Resolved TL session name
   * @param verifyInstruction - Message text to deliver
   * @param workerSessionName - Worker whose task completed (for queue metadata)
   * @param taskId - Task id (for queue metadata)
   * @returns Which path actually carried the message
   */
  private async deliverToTeamLeader(
    tlSessionName: string,
    verifyInstruction: string,
    workerSessionName: string,
    taskId?: string,
  ): Promise<DeliveryPath> {
    if (tlSessionName !== ORCHESTRATOR_SESSION_NAME) {
      try {
        const axios = (await import('axios')).default;
        await axios.post(
          `${API_BASE}/api/terminal/${encodeURIComponent(tlSessionName)}/write`,
          { data: verifyInstruction, mode: 'message' },
          {
            headers: { 'X-Agent-Session': SERVICE_NAME },
            timeout: TL_WRITE_TIMEOUT_MS,
          },
        );
        return 'tl-terminal';
      } catch (err) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        this.logger.warn('Direct TL terminal write failed — falling back to orchestrator queue', {
          tlSession: tlSessionName,
          status: status ?? 'no-response',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const { MessageQueueService } = await import('../messaging/message-queue.service.js');
    const mqService = new MessageQueueService(process.cwd());
    mqService.enqueue({
      content: verifyInstruction,
      conversationId: `auto-verify-${taskId || workerSessionName}-${Date.now()}`,
      source: 'system_event',
      sourceMetadata: {
        type: 'auto-verify',
        workerSession: workerSessionName,
        tlSession: tlSessionName,
        taskId,
      },
    });
    return 'orchestrator-queue';
  }

  /**
   * Find the Team Leader for a given worker by looking up team hierarchy.
   *
   * @param workerSessionName - Worker's agent session name
   * @param teamId - Optional team ID hint from the event
   * @returns TL info or null if no hierarchical TL exists
   */
  private async findTeamLeaderForWorker(
    workerSessionName: string,
    teamId?: string,
  ): Promise<{ tlSessionName: string; tlMemberId: string; teamId: string } | null> {
    let teams: TeamInfo[] = [];

    if (this.teamsProvider) {
      teams = await this.teamsProvider();
    } else {
      // Fallback: load from API
      try {
        const axios = (await import('axios')).default;
        const response = await axios.get('http://localhost:8787/api/teams');
        teams = response.data?.data ?? [];
      } catch {
        return null;
      }
    }

    // Find the team containing this worker
    for (const team of teams) {
      if (!team.hierarchical) continue;
      if (teamId && team.id !== teamId) continue;

      const worker = team.members.find((m) => m.sessionName === workerSessionName);
      if (!worker) continue;

      // Find the worker's parent (TL)
      if (!worker.parentMemberId) continue;

      const tl = team.members.find((m) => m.id === worker.parentMemberId);
      if (!tl) continue;

      return {
        tlSessionName: tl.sessionName,
        tlMemberId: tl.id,
        teamId: team.id,
      };
    }

    return null;
  }
}
