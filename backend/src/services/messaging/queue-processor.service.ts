/**
 * Queue Processor Service
 *
 * Processes messages from the queue one-at-a-time. Dequeues the next message,
 * delivers it to the orchestrator via AgentRegistrationService, waits for
 * the response via ChatService events, and routes the response back.
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
import type { ChatMessage } from '../../types/chat.types.js';

/**
 * QueueProcessorService dequeues messages one-at-a-time, delivers them
 * to the orchestrator, waits for a response, and routes it back.
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
      PtyActivityTrackerService.getInstance().recordActivity(ORCHESTRATOR_SESSION_NAME);
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
      const isUserMessage = message.source === MESSAGE_SOURCES.SLACK || message.source === MESSAGE_SOURCES.WEB_CHAT || message.source === MESSAGE_SOURCES.WHATSAPP;
      const readyTimeout = isUserMessage
        ? EVENT_DELIVERY_CONSTANTS.USER_MESSAGE_TIMEOUT
        : isSystemEvent
          ? EVENT_DELIVERY_CONSTANTS.SYSTEM_EVENT_TIMEOUT
          : EVENT_DELIVERY_CONSTANTS.AGENT_READY_TIMEOUT;

      // Wait for orchestrator to be at prompt before attempting delivery.
      // After processing a previous message the orchestrator may still be busy
      // (managing agents, running commands) before returning to the input prompt.
      const isReady = await this.agentRegistrationService.waitForAgentReady(
        ORCHESTRATOR_SESSION_NAME,
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

      // Format message: system events use raw content, chat uses [CHAT:id] prefix
      let deliveryContent: string;
      if (isSystemEvent) {
        const allContents = [message.content, ...batchedMessages.map(m => m.content)];
        deliveryContent = allContents.join('\n');
      } else {
        deliveryContent = `[${CHAT_ROUTING_CONSTANTS.MESSAGE_PREFIX}:${message.conversationId}] ${message.content}`;
      }

      const deliveryResult = await this.agentRegistrationService.sendMessageToAgent(
        ORCHESTRATOR_SESSION_NAME,
        deliveryContent,
        runtimeType
      );

      // Record delivery timestamp for ACK detection
      message.deliveredAt = new Date().toISOString();

      if (!deliveryResult.success) {
        const errorMsg = deliveryResult.error || 'Failed to deliver message to orchestrator';

        // If agent is busy (actively processing), re-queue instead of permanently failing.
        // This allows the message to be retried once the agent returns to prompt.
        const isAgentBusy = errorMsg.includes('[AGENT_BUSY]');
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

      if (isSystemEvent) {
        // Fire-and-forget: no response expected for system events
        this.queueService.markCompleted(message.id, '');
        // Mark all batched messages as completed too
        if (batchedMessages.length > 0) {
          this.queueService.markBatchCompleted(batchedMessages);
        }

        this.logger.info('System event delivered successfully', {
          messageId: message.id,
          batchSize: 1 + batchedMessages.length,
        });
      } else {
        // Wait for orchestrator response
        const response = await this.waitForResponse(
          message.conversationId,
          MESSAGE_QUEUE_CONSTANTS.DEFAULT_MESSAGE_TIMEOUT
        );

        this.queueService.markCompleted(message.id, response);
        this.responseRouter.routeResponse(message, response);

        this.logger.info('Message processed successfully', {
          messageId: message.id,
          responseLength: response.length,
        });
      }

      // Wait for orchestrator to finish all post-response work before next message.
      // The orchestrator may continue managing agents or running commands after
      // emitting its chat response.
      // Skip for system events: they're fire-and-forget with no response expected.
      // The next processNext() iteration already calls waitForAgentReady before
      // delivery, so we don't need to block here. Skipping this avoids the 120s
      // wait that prevents user [CHAT] messages from being processed promptly.
      if (!isSystemEvent) {
        await this.agentRegistrationService.waitForAgentReady(
          ORCHESTRATOR_SESSION_NAME,
          EVENT_DELIVERY_CONSTANTS.AGENT_READY_TIMEOUT,
          runtimeType
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
   * Wait for an orchestrator response on a given conversation.
   * Listens to ChatService 'message' events for matching orchestrator messages.
   *
   * Includes an early ACK check: if the orchestrator terminal produces zero
   * output within ACK_TIMEOUT (15s) of delivery, the context is likely
   * exhausted and we resolve immediately with an actionable error message
   * instead of waiting the full timeout.
   *
   * NOTE: This method intentionally resolves (not rejects) with error messages
   * for timeout/unresponsive cases. The caller marks the message as "completed"
   * with the error text as the response, so the user sees the error in their
   * conversation rather than having it silently swallowed by a catch block.
   *
   * @param conversationId - Conversation to monitor
   * @param timeoutMs - Timeout in milliseconds
   * @returns Response content
   */
  private waitForResponse(conversationId: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve) => {
      const chatService = getChatService();

      const onMessage = (chatMessage: ChatMessage): void => {
        if (
          chatMessage.conversationId === conversationId &&
          chatMessage.from.type === 'orchestrator'
        ) {
          cleanup();
          resolve(chatMessage.content);
        }
      };

      const timeoutId = setTimeout(() => {
        cleanup();
        resolve('The orchestrator is taking longer than expected. Please try again.');
      }, timeoutMs);

      // Early ACK check: if no terminal output within ACK_TIMEOUT after
      // delivery, the orchestrator is likely context-exhausted.
      const ackTimeoutId = setTimeout(() => {
        const tracker = PtyActivityTrackerService.getInstance();
        const idleMs = tracker.getIdleTimeMs(ORCHESTRATOR_SESSION_NAME);
        if (idleMs >= MESSAGE_QUEUE_CONSTANTS.ACK_TIMEOUT) {
          this.logger.warn('No orchestrator output within ACK window, likely context exhausted', {
            conversationId,
            idleMs,
            ackTimeout: MESSAGE_QUEUE_CONSTANTS.ACK_TIMEOUT,
          });
          cleanup();
          resolve(
            'The orchestrator appears to be unresponsive (no output detected). ' +
            'Its context may be exhausted. Please restart the orchestrator and try again.'
          );
        }
      }, MESSAGE_QUEUE_CONSTANTS.ACK_TIMEOUT);

      // Progress timer: emit "still working" updates during long operations.
      // First fires at 90s, then every 60s thereafter.
      let progressIntervalId: ReturnType<typeof setInterval> | undefined;
      let cleaned = false;

      const startProgressInterval = (): void => {
        if (cleaned) return;
        progressIntervalId = setInterval(() => {
          const tracker = PtyActivityTrackerService.getInstance();
          const idleMs = tracker.getIdleTimeMs(ORCHESTRATOR_SESSION_NAME);
          // Only emit progress if the orchestrator is still producing output
          if (idleMs < MESSAGE_QUEUE_CONSTANTS.PROGRESS_INTERVAL_MS) {
            chatService.emitProgress(conversationId, 'Processing... (still working)');
          }
        }, MESSAGE_QUEUE_CONSTANTS.PROGRESS_INTERVAL_MS);
      };

      const progressStartId = setTimeout(startProgressInterval, MESSAGE_QUEUE_CONSTANTS.PROGRESS_INITIAL_MS);

      const cleanup = (): void => {
        cleaned = true;
        clearTimeout(timeoutId);
        clearTimeout(ackTimeoutId);
        clearTimeout(progressStartId);
        if (progressIntervalId) clearInterval(progressIntervalId);
        chatService.removeListener('message', onMessage);
      };

      chatService.on('message', onMessage);
    });
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
}
