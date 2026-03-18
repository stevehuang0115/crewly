/**
 * Queue Processor Service
 *
 * Processes messages from the queue one-at-a-time. Dequeues the next message,
 * delivers it to the orchestrator via AgentRegistrationService using a
 * fire-and-forget pattern. Responses are handled asynchronously by the
 * orchestrator through reply-* skills (reply-slack, reply-chat, reply-gchat).
 *
 * @module services/messaging/queue-processor
 */

import { EventEmitter } from 'events';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { MessageQueueService } from './message-queue.service.js';
import { ResponseRouterService } from './response-router.service.js';
import { AgentRegistrationService } from '../agent/agent-registration.service.js';
import { getChatService } from '../chat/chat.service.js';
import { getTerminalGateway } from '../../websocket/terminal.gateway.js';
import {
  MESSAGE_QUEUE_CONSTANTS,
  ORCHESTRATOR_SESSION_NAME,
  CHAT_ROUTING_CONSTANTS,
  EVENT_DELIVERY_CONSTANTS,
  RUNTIME_TYPES,
  ORCHESTRATOR_HEARTBEAT_CONSTANTS,
  MESSAGE_SOURCES,
  type RuntimeType,
} from '../../constants.js';
import { PtyActivityTrackerService } from '../agent/pty-activity-tracker.service.js';
import { StorageService } from '../core/storage.service.js';

/**
 * QueueProcessorService dequeues messages one-at-a-time and delivers them
 * to the target agent using a fire-and-forget pattern. Responses are handled
 * asynchronously by the orchestrator through reply-* skills.
 *
 * @example
 * ```typescript
 * const processor = new QueueProcessorService(
 *   queueService,
 *   responseRouter,
 *   agentRegistrationService
 * );
 * processor.start();
 * ```
 */
/** Time in milliseconds before a delivered message ID is purged from the dedup set */
const DEDUP_TTL_MS = 300_000; // 5 minutes

export class QueueProcessorService extends EventEmitter {
  private logger: ComponentLogger;
  private queueService: MessageQueueService;
  private responseRouter: ResponseRouterService;
  private agentRegistrationService: AgentRegistrationService;
  private running = false;
  private processing = false;
  private processNextTimeout: ReturnType<typeof setTimeout> | null = null;
  /** Set to true when an early-return path has already scheduled the next run. */
  private nextAlreadyScheduled = false;

  /**
   * Tracks message IDs that were successfully delivered to an agent.
   * Prevents duplicate delivery when the queue requeues a message that
   * the agent has already received and started processing.
   * Entries are purged after DEDUP_TTL_MS to prevent memory leaks.
   */
  private deliveredMessageIds: Map<string, number> = new Map();

  /** Timer for periodic cleanup of stale dedup entries */
  private dedupCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    queueService: MessageQueueService,
    responseRouter: ResponseRouterService,
    agentRegistrationService: AgentRegistrationService
  ) {
    super();
    this.logger = LoggerService.getInstance().createComponentLogger('QueueProcessor');
    this.queueService = queueService;
    this.responseRouter = responseRouter;
    this.agentRegistrationService = agentRegistrationService;
  }

  /**
   * Start the processor. Listens to queue 'enqueued' events and
   * triggers processing.
   */
  start(): void {
    if (this.running) return;

    this.running = true;
    this.queueService.on('enqueued', this.onMessageEnqueued);
    this.startDedupCleanup();
    this.logger.info('Queue processor started');

    // Process any messages already in the queue
    if (this.queueService.hasPending()) {
      this.scheduleProcessNext(0);
    }
  }

  /**
   * Stop the processor. Clears timers and removes listeners.
   */
  stop(): void {
    if (!this.running) return;

    this.running = false;
    this.queueService.removeListener('enqueued', this.onMessageEnqueued);

    if (this.processNextTimeout) {
      clearTimeout(this.processNextTimeout);
      this.processNextTimeout = null;
    }

    this.stopDedupCleanup();
    this.deliveredMessageIds.clear();

    this.logger.info('Queue processor stopped');
  }

  /**
   * Check if the processor is currently running.
   *
   * @returns True if running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Check if a message is currently being processed.
   *
   * @returns True if processing
   */
  isProcessingMessage(): boolean {
    return this.processing;
  }

  /**
   * Handler for queue 'enqueued' events. Triggers processing if idle.
   */
  private onMessageEnqueued = (): void => {
    if (!this.processing) {
      this.scheduleProcessNext(0);
    }
  };

  /**
   * Schedule the next message processing after a delay.
   *
   * @param delayMs - Delay in milliseconds before processing
   */
  private scheduleProcessNext(delayMs: number): void {
    if (this.processNextTimeout) {
      clearTimeout(this.processNextTimeout);
    }

    this.processNextTimeout = setTimeout(() => {
      this.processNextTimeout = null;
      this.processNext().catch((error) => {
        this.logger.error('Unhandled error in processNext', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, delayMs);
  }

  /**
   * Process the next message in the queue.
   * This is the core processing loop.
   */
  private async processNext(): Promise<void> {
    if (!this.running || this.processing) {
      return;
    }

    // Don't process messages until orchestrator has finished initialization.
    // 'started' means runtime is running but init prompt is still being processed.
    // Only deliver when 'active' (agent registered via register-self skill).
    const orchestratorInfo = await StorageService.getInstance().getOrchestratorStatus();
    const agentStatus = orchestratorInfo?.agentStatus;
    if (agentStatus !== 'active') {
      this.logger.debug('Orchestrator not active yet, deferring message delivery', {
        agentStatus: agentStatus || 'unknown',
      });
      this.scheduleProcessNext(EVENT_DELIVERY_CONSTANTS.AGENT_READY_POLL_INTERVAL);
      return;
    }

    const message = this.queueService.dequeue();
    if (!message) {
      return;
    }

    this.processing = true;

    // Keep the orchestrator's activity tracker alive while processing so the
    // heartbeat monitor doesn't falsely declare it idle and auto-restart it.
    // Interval is half the heartbeat request threshold to guarantee at least
    // one activity ping before the monitor considers the orchestrator idle.
    const KEEPALIVE_INTERVAL_MS = ORCHESTRATOR_HEARTBEAT_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS / 2;
    const keepaliveInterval = setInterval(() => {
      PtyActivityTrackerService.getInstance().recordApiActivity(ORCHESTRATOR_SESSION_NAME);
    }, KEEPALIVE_INTERVAL_MS);

    try {
      this.logger.info('Processing message', {
        messageId: message.id,
        source: message.source,
        conversationId: message.conversationId,
      });

      const isSystemEvent = message.source === MESSAGE_SOURCES.SYSTEM_EVENT;

      // Set active conversation ID for response routing (skip for system events)
      if (!isSystemEvent) {
        const terminalGateway = getTerminalGateway();
        if (terminalGateway) {
          terminalGateway.setActiveConversationId(message.conversationId);
        }
      }

      // Reuse the orchestrator status fetched above to determine runtime type
      // for prompt detection in waitForAgentReady. Without runtime-aware detection,
      // the generic PROMPT_STREAM regex can false-positive on markdown `> `
      // lines in Claude Code output, causing premature delivery attempts.
      const storedRuntimeType = orchestratorInfo?.runtimeType as RuntimeType | undefined;
      if (!storedRuntimeType) {
        this.logger.warn('No runtimeType stored for orchestrator, defaulting to CLAUDE_CODE', {
          messageId: message.id,
        });
      }
      const runtimeType: RuntimeType = storedRuntimeType || RUNTIME_TYPES.CLAUDE_CODE;

      // Determine if this is a user message (Slack/web chat) vs system event.
      // User messages and system events get shorter timeouts and force-delivery
      // to reduce delay. System events are fire-and-forget so force-delivery is
      // lower risk — prevents the 5×120s=10min retry loop that blocks notifications.
      const isUserMessage = message.source === MESSAGE_SOURCES.SLACK || message.source === MESSAGE_SOURCES.WEB_CHAT || message.source === MESSAGE_SOURCES.WHATSAPP || message.source === MESSAGE_SOURCES.GOOGLE_CHAT || message.source === MESSAGE_SOURCES.TELEGRAM;
      const readyTimeout = isUserMessage
        ? EVENT_DELIVERY_CONSTANTS.USER_MESSAGE_TIMEOUT
        : isSystemEvent
          ? EVENT_DELIVERY_CONSTANTS.SYSTEM_EVENT_TIMEOUT
          : EVENT_DELIVERY_CONSTANTS.AGENT_READY_TIMEOUT;

      // Resolve delivery target — system events may target non-orchestrator agents
      const deliveryTarget = message.targetSession || ORCHESTRATOR_SESSION_NAME;

      // Wait for target agent to be at prompt before attempting delivery.
      // After processing a previous message the agent may still be busy
      // (managing agents, running commands) before returning to the input prompt.
      const isReady = await this.agentRegistrationService.waitForAgentReady(
        deliveryTarget,
        readyTimeout,
        runtimeType
      );

      // Check if message was force-cancelled while waiting for agent readiness
      if (message.status === 'cancelled') {
        this.logger.info('Message was cancelled during processing, skipping delivery', {
          messageId: message.id,
        });
        clearInterval(keepaliveInterval);
        return;
      }

      if (!isReady) {
        // For user messages and system events: force-deliver immediately instead
        // of re-queuing to avoid the retry loop that causes multi-minute delays.
        // System events are fire-and-forget (no response expected), so force-delivery
        // is lower risk. The orchestrator will process input when it returns to prompt.
        const shouldForceDeliver =
          (isUserMessage && EVENT_DELIVERY_CONSTANTS.USER_MESSAGE_FORCE_DELIVER) ||
          (isSystemEvent && EVENT_DELIVERY_CONSTANTS.SYSTEM_EVENT_FORCE_DELIVER);
        if (shouldForceDeliver) {
          this.logger.warn('Agent not ready but force-delivering message to reduce delay', {
            messageId: message.id,
            source: message.source,
            timeoutMs: readyTimeout,
            isUserMessage,
            isSystemEvent,
          });
          // Fall through to delivery below — the message will be sent even though
          // the orchestrator may not be at prompt. This is acceptable because:
          // 1. The user expects a timely response (user messages)
          // 2. System events are fire-and-forget notifications
          // 3. The orchestrator will process the input when it returns to prompt
        } else {
          const currentRetries = message.retryCount || 0;
          const maxRetries = MESSAGE_QUEUE_CONSTANTS.MAX_REQUEUE_RETRIES;

          if (currentRetries >= maxRetries) {
            // Exceeded max retries — permanently fail the message
            const errorMsg = `Orchestrator not available after ${currentRetries} retries (~${Math.round(currentRetries * EVENT_DELIVERY_CONSTANTS.AGENT_READY_TIMEOUT / 60000)} minutes). The orchestrator may be busy or unresponsive.`;
            this.logger.error('Message exceeded max requeue retries, marking as failed', {
              messageId: message.id,
              retryCount: currentRetries,
              maxRetries,
            });

            this.queueService.markFailed(message.id, errorMsg);
            this.responseRouter.routeError(message, errorMsg);

            // Notify user in conversation
            if (message.source !== MESSAGE_SOURCES.SYSTEM_EVENT) {
              try {
                const chatService = getChatService();
                await chatService.addSystemMessage(
                  message.conversationId,
                  `Message delivery failed: ${errorMsg} Please try again later.`
                );
              } catch (sysErr) {
                this.logger.warn('Failed to send max-retry failure system message', {
                  error: sysErr instanceof Error ? sysErr.message : String(sysErr),
                });
              }
            }
            clearInterval(keepaliveInterval);
            return;
          }

          this.logger.warn('Agent not ready, re-queuing message for retry', {
            messageId: message.id,
            timeoutMs: readyTimeout,
            retryCount: currentRetries + 1,
            maxRetries,
          });

          // Re-enqueue the message so it gets retried instead of permanently failing
          this.queueService.requeue(message);

          // Use a longer delay before retrying to give the orchestrator more time.
          // Mark as already scheduled so the finally block doesn't overwrite with
          // a shorter INTER_MESSAGE_DELAY.
          this.scheduleProcessNext(EVENT_DELIVERY_CONSTANTS.AGENT_READY_POLL_INTERVAL);
          this.nextAlreadyScheduled = true;
          clearInterval(keepaliveInterval);
          return;
        }
      }

      // Batch system events: if the current message is a system event and more
      // are pending, combine up to MAX_SYSTEM_EVENT_BATCH into one delivery.
      // This reduces context window consumption on the orchestrator when many
      // events fire in quick succession (agent status changes, etc.).
      let batchedMessages: import('../../types/messaging.types.js').QueuedMessage[] = [];
      if (isSystemEvent) {
        const maxAdditional = MESSAGE_QUEUE_CONSTANTS.MAX_SYSTEM_EVENT_BATCH - 1;
        batchedMessages = this.queueService.dequeueSystemEventBatch(maxAdditional);
        if (batchedMessages.length > 0) {
          this.logger.info('Batched system events for delivery', {
            primaryId: message.id,
            batchSize: 1 + batchedMessages.length,
          });
        }
      }

      // Format message: system events use raw content, chat uses [CHAT:id] or [GCHAT:id] prefix
      let deliveryContent: string;
      if (isSystemEvent) {
        const allContents = [message.content, ...batchedMessages.map(m => m.content)];
        deliveryContent = allContents.join('\n');
      } else if (message.source === MESSAGE_SOURCES.GOOGLE_CHAT) {
        const prefix = CHAT_ROUTING_CONSTANTS.GOOGLE_CHAT_PREFIX;
        const threadId = message.sourceMetadata?.threadId as string | undefined;
        const threadSuffix = threadId ? ` thread=${threadId}` : '';
        deliveryContent = `[${prefix}:${message.conversationId}${threadSuffix}] ${message.content}`;
      } else {
        deliveryContent = `[${CHAT_ROUTING_CONSTANTS.MESSAGE_PREFIX}:${message.conversationId}] ${message.content}`;
      }

      // Inject [SLACK:channelId:threadTs] marker for Slack-sourced messages so
      // crewly-agent runtimes can auto-fill reply_slack with the correct thread.
      // Without this, in-process agents have no way to discover the originating
      // Slack channel/thread — they only see the [CHAT:conversationId] prefix.
      if (message.source === MESSAGE_SOURCES.SLACK && message.sourceMetadata?.channelId) {
        const channelId = message.sourceMetadata.channelId as string;
        const threadTs = message.sourceMetadata.threadTs as string | undefined;
        const slackMarker = threadTs
          ? `[SLACK:${channelId}:${threadTs}]`
          : `[SLACK:${channelId}]`;
        deliveryContent = `${deliveryContent} ${slackMarker}`;
      }

      // Route to the correct target session. System events may target
      // non-orchestrator agents (e.g. crewly-agent subscribers).
      const targetSession = message.targetSession || ORCHESTRATOR_SESSION_NAME;

      // Resolve runtime type for non-orchestrator targets
      let deliveryRuntimeType = runtimeType;
      if (targetSession !== ORCHESTRATOR_SESSION_NAME) {
        try {
          const memberResult = await StorageService.getInstance().findMemberBySessionName(targetSession);
          if (memberResult?.member?.runtimeType) {
            deliveryRuntimeType = memberResult.member.runtimeType as RuntimeType;
          }
        } catch {
          // Fall back to orchestrator's runtime type
        }
      }

      // Deduplication: skip delivery if this message was already successfully
      // delivered to the agent. This prevents duplicate responses when a message
      // is requeued after AGENT_BUSY — the agent received it but is still processing.
      if (this.deliveredMessageIds.has(message.id)) {
        this.logger.info('Skipping duplicate delivery for already-delivered message', {
          messageId: message.id,
          source: message.source,
          retryCount: message.retryCount || 0,
        });

        this.queueService.markCompleted(message.id, '');
        if (batchedMessages.length > 0) {
          this.queueService.markBatchCompleted(batchedMessages);
        }
        clearInterval(keepaliveInterval);
        return;
      }

      const deliveryResult = await this.agentRegistrationService.sendMessageToAgent(
        targetSession,
        deliveryContent,
        deliveryRuntimeType
      );

      // Record delivery timestamp for ACK detection
      message.deliveredAt = new Date().toISOString();

      if (!deliveryResult.success) {
        const errorMsg = deliveryResult.error || 'Failed to deliver message to orchestrator';

        // If agent is busy, the message was actually received by the agent process
        // (it just can't accept new messages right now). Mark it as delivered to
        // prevent duplicate processing if it gets requeued.
        const isAgentBusy = errorMsg.includes('[AGENT_BUSY]');
        if (isAgentBusy) {
          this.deliveredMessageIds.set(message.id, Date.now());
        }
        const currentRetries = message.retryCount || 0;

        if (isAgentBusy && currentRetries < MESSAGE_QUEUE_CONSTANTS.MAX_REQUEUE_RETRIES) {
          this.logger.info('Agent busy, re-queuing message for later delivery', {
            messageId: message.id,
            retryCount: currentRetries + 1,
            maxRetries: MESSAGE_QUEUE_CONSTANTS.MAX_REQUEUE_RETRIES,
          });

          this.queueService.requeue(message);
          // Also re-queue any batched system event messages
          for (const batchedMsg of batchedMessages) {
            this.queueService.requeue(batchedMsg);
          }

          this.scheduleProcessNext(EVENT_DELIVERY_CONSTANTS.AGENT_READY_POLL_INTERVAL);
          this.nextAlreadyScheduled = true;
          clearInterval(keepaliveInterval);
          return;
        }

        this.logger.warn('Message delivery failed', {
          messageId: message.id,
          error: errorMsg,
        });

        this.queueService.markFailed(message.id, errorMsg);
        // Also fail any batched system event messages
        if (batchedMessages.length > 0) {
          this.queueService.markBatchFailed(batchedMessages, errorMsg);
        }
        this.responseRouter.routeError(message, errorMsg);

        // Post a system message to the conversation so the user sees the error
        // (skip for system events — no user conversation to notify)
        if (!isSystemEvent) {
          try {
            const chatService = getChatService();
            await chatService.addSystemMessage(
              message.conversationId,
              `Failed to deliver message to orchestrator: ${errorMsg}. Please try again.`
            );
          } catch (sysErr) {
            this.logger.warn('Failed to send delivery-failure system message', {
              error: sysErr instanceof Error ? sysErr.message : String(sysErr),
            });
          }
        }

        return;
      }

      // Track successful delivery for deduplication before marking complete.
      this.deliveredMessageIds.set(message.id, Date.now());

      // Fire-and-forget: mark as completed immediately after delivery.
      // Responses are handled asynchronously by the orchestrator through
      // reply-* skills (reply-slack, reply-chat, reply-gchat).
      this.queueService.markCompleted(message.id, '');
      // Mark all batched system event messages as completed too
      if (batchedMessages.length > 0) {
        this.queueService.markBatchCompleted(batchedMessages);
      }

      // Resolve any pending source callbacks (e.g. slackResolve, googleChatResolve)
      // with empty response to unblock callers. The actual reply comes via reply-* skills.
      this.responseRouter.routeResponse(message, '');

      this.logger.info('Message delivered (fire-and-forget)', {
        messageId: message.id,
        source: message.source,
        batchSize: isSystemEvent ? 1 + batchedMessages.length : 1,
      });

      // Wait for target agent to finish post-delivery work before next message.
      // Skip for system events: they're fire-and-forget notifications.
      // The next processNext() iteration already calls waitForAgentReady before
      // delivery, so we don't need to block here for system events.
      if (!isSystemEvent) {
        await this.agentRegistrationService.waitForAgentReady(
          targetSession,
          EVENT_DELIVERY_CONSTANTS.AGENT_READY_TIMEOUT,
          deliveryRuntimeType
        );
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error('Error processing message', {
        messageId: message.id,
        error: errorMsg,
      });

      this.queueService.markFailed(message.id, errorMsg);
      this.responseRouter.routeError(message, errorMsg);
    } finally {
      clearInterval(keepaliveInterval);
      this.processing = false;
      if (this.nextAlreadyScheduled) {
        this.nextAlreadyScheduled = false;
      } else {
        this.scheduleNextIfPending();
      }
    }
  }

  /**
   * Schedule processing of the next message if there are pending messages.
   * Uses INTER_MESSAGE_DELAY to avoid overwhelming the orchestrator.
   */
  private scheduleNextIfPending(): void {
    if (this.running && this.queueService.hasPending()) {
      this.scheduleProcessNext(MESSAGE_QUEUE_CONSTANTS.INTER_MESSAGE_DELAY);
    }
  }

  /**
   * Start periodic cleanup of stale entries in the delivered message dedup set.
   * Runs every DEDUP_TTL_MS and removes entries older than DEDUP_TTL_MS.
   */
  private startDedupCleanup(): void {
    if (this.dedupCleanupTimer) return;
    this.dedupCleanupTimer = setInterval(() => {
      this.purgeStaleDedup();
    }, DEDUP_TTL_MS);
    if (this.dedupCleanupTimer.unref) {
      this.dedupCleanupTimer.unref();
    }
  }

  /**
   * Stop the periodic dedup cleanup timer.
   */
  private stopDedupCleanup(): void {
    if (this.dedupCleanupTimer) {
      clearInterval(this.dedupCleanupTimer);
      this.dedupCleanupTimer = null;
    }
  }

  /**
   * Remove entries from the dedup set that are older than DEDUP_TTL_MS.
   */
  private purgeStaleDedup(): void {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    let purged = 0;
    for (const [id, timestamp] of this.deliveredMessageIds) {
      if (timestamp < cutoff) {
        this.deliveredMessageIds.delete(id);
        purged++;
      }
    }
    if (purged > 0) {
      this.logger.debug('Purged stale dedup entries', { purged, remaining: this.deliveredMessageIds.size });
    }
  }

  /**
   * Get the number of tracked delivered message IDs (for testing).
   *
   * @returns Number of entries in the dedup set
   */
  getDeliveredMessageCount(): number {
    return this.deliveredMessageIds.size;
  }
}
