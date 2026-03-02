/**
 * Message Queue Service
 *
 * FIFO queue for sequential message processing with optional disk persistence.
 * All chat and Slack messages are enqueued here, processed one-at-a-time,
 * and responses are routed back to the correct source.
 *
 * When an crewlyHome path is provided, the queue state is persisted to
 * `~/.crewly/queue/message-queue.json` after every mutation so that
 * pending messages survive backend restarts.
 *
 * @module services/messaging/message-queue
 */

import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { MESSAGE_QUEUE_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { atomicWriteFile, safeReadJson } from '../../utils/file-io.utils.js';
import type {
  QueuedMessage,
  EnqueueMessageInput,
  QueueStatus,
  PersistedQueueState,
} from '../../types/messaging.types.js';
import {
  isValidEnqueueMessageInput,
  isValidPersistedQueueState,
  toPersistedMessage,
  PERSISTED_QUEUE_VERSION,
} from '../../types/messaging.types.js';

/**
 * MessageQueueService manages a FIFO queue of messages destined for
 * the orchestrator. It provides enqueue/dequeue operations, status
 * tracking, and EventEmitter-based notifications for queue state changes.
 *
 * When constructed with an crewlyHome path, the queue is persisted to
 * disk after every state change and restored on startup via loadPersistedState().
 *
 * @example
 * ```typescript
 * // Without persistence (tests, legacy)
 * const queue = new MessageQueueService();
 *
 * // With persistence
 * const queue = new MessageQueueService('~/.crewly');
 * await queue.loadPersistedState();
 * ```
 */
export class MessageQueueService extends EventEmitter {
  /** Logger for this service */
  private logger: ComponentLogger = LoggerService.getInstance().createComponentLogger('MessageQueueService');

  /** Pending messages waiting to be processed (FIFO) */
  private queue: QueuedMessage[] = [];

  /** Completed/failed message history (most recent first) */
  private history: QueuedMessage[] = [];

  /** Total messages processed since startup */
  private totalProcessed = 0;

  /** Total messages that failed since startup */
  private totalFailed = 0;

  /** The message currently being processed */
  private currentMessage: QueuedMessage | null = null;

  /** Path to the persistence directory, or null if persistence is disabled */
  private persistDir: string | null = null;

  /** Full path to the persistence file */
  private persistPath: string | null = null;

  /** Debounce timer for batching persistence writes */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  /** Promise for the currently in-flight persistence write */
  private persistPromise: Promise<void> | null = null;

  /**
   * Create a new MessageQueueService.
   *
   * @param crewlyHome - Path to the crewly home directory (e.g. ~/.crewly).
   *   When provided, enables disk persistence. When omitted, the queue is in-memory only.
   */
  constructor(crewlyHome?: string) {
    super();

    if (crewlyHome) {
      this.persistDir = path.join(crewlyHome, MESSAGE_QUEUE_CONSTANTS.PERSISTENCE_DIR);
      this.persistPath = path.join(this.persistDir, MESSAGE_QUEUE_CONSTANTS.PERSISTENCE_FILE);

      if (!existsSync(this.persistDir)) {
        mkdirSync(this.persistDir, { recursive: true });
      }
    }
  }

  /**
   * Load persisted queue state from disk on startup.
   * If the file is missing, corrupt, or has the wrong version, starts empty.
   * In-flight messages (status === 'processing') are reset to pending and
   * placed at the front of the queue. System event messages are filtered out
   * since they are ephemeral and stale after restart.
   */
  async loadPersistedState(): Promise<void> {
    if (!this.persistPath) {
      return;
    }

    const data = await safeReadJson<unknown>(this.persistPath, null);

    if (!data || !isValidPersistedQueueState(data)) {
      return;
    }

    // Restore counters
    this.totalProcessed = data.totalProcessed;
    this.totalFailed = data.totalFailed;

    // Restore history, filtering out system events
    this.history = data.history.filter((m) => m.source !== 'system_event');

    // Build restored queue: if there was an in-flight message, prepend it as pending
    const restoredQueue: QueuedMessage[] = [];

    if (data.currentMessage) {
      const msg = data.currentMessage as QueuedMessage;
      msg.status = 'pending';
      msg.processingStartedAt = undefined;
      if (msg.source !== 'system_event') {
        restoredQueue.push(msg);
      }
    }

    for (const msg of data.queue) {
      if (msg.source !== 'system_event') {
        restoredQueue.push(msg as QueuedMessage);
      }
    }

    this.queue = restoredQueue;
    this.currentMessage = null;
  }

  /**
   * Flush any pending persistence write immediately.
   * Call this during shutdown to ensure the latest state is saved.
   */
  async flushPersist(): Promise<void> {
    if (!this.persistPath) {
      return;
    }

    // Cancel any pending debounced write
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    // Wait for any in-flight write to finish
    if (this.persistPromise) {
      await this.persistPromise;
    }

    // Write current state immediately
    await this.persistState();
  }

  /**
   * Enqueue a new message for processing.
   *
   * @param input - The message to enqueue
   * @returns The created QueuedMessage
   * @throws Error if input is invalid or queue is full
   */
  enqueue(input: EnqueueMessageInput): QueuedMessage {
    if (!isValidEnqueueMessageInput(input)) {
      throw new Error('Invalid enqueue input: content, conversationId, and source are required');
    }

    if (this.queue.length >= MESSAGE_QUEUE_CONSTANTS.MAX_QUEUE_SIZE) {
      throw new Error(`Queue is full (max ${MESSAGE_QUEUE_CONSTANTS.MAX_QUEUE_SIZE} messages)`);
    }

    // Coalesce bursty system events into a single pending message so the
    // orchestrator processes one combined notification instead of many singles.
    if (input.source === 'system_event') {
      const lastPendingSystemEvent = [...this.queue]
        .reverse()
        .find((m) => m.source === 'system_event');

      if (lastPendingSystemEvent) {
        const mergedContent = `${lastPendingSystemEvent.content}\n${input.content}`;
        if (mergedContent.length <= MESSAGE_QUEUE_CONSTANTS.MAX_SYSTEM_EVENT_COALESCE_CHARS) {
          lastPendingSystemEvent.content = mergedContent;
          this.emit('enqueued', lastPendingSystemEvent);
          this.emitStatusUpdate();
          this.schedulePersist();
          return lastPendingSystemEvent;
        }
      }
    }

    const message: QueuedMessage = {
      id: crypto.randomUUID(),
      content: input.content,
      conversationId: input.conversationId,
      source: input.source,
      status: 'pending',
      sourceMetadata: input.sourceMetadata,
      enqueuedAt: new Date().toISOString(),
    };

    this.queue.push(message);
    this.emit('enqueued', message);
    this.emitStatusUpdate();
    this.schedulePersist();

    return message;
  }

  /**
   * Dequeue the next pending message for processing.
   * Prioritizes user messages (slack, web_chat) over system events so that
   * real user conversations are never blocked behind internal notifications.
   * Returns null if the queue is empty.
   *
   * @returns The next QueuedMessage or null
   */
  dequeue(): QueuedMessage | null {
    if (this.queue.length === 0) {
      return null;
    }

    // Prioritize user messages over system events
    const userIdx = this.queue.findIndex(
      (m) => m.source === 'slack' || m.source === 'web_chat' || m.source === 'whatsapp'
    );
    const idx = userIdx >= 0 ? userIdx : 0;
    const [message] = this.queue.splice(idx, 1);
    message.status = 'processing';
    message.processingStartedAt = new Date().toISOString();
    this.currentMessage = message;

    this.emit('processing', message);
    this.emitStatusUpdate();
    this.schedulePersist();

    return message;
  }

  /**
   * Dequeue additional pending system_event messages (up to maxCount).
   * Used by the queue processor to batch multiple system events into a
   * single delivery, reducing context consumption on the orchestrator.
   *
   * Does NOT set currentMessage — the caller is responsible for marking
   * all returned messages as completed/failed.
   *
   * @param maxCount - Maximum additional system events to dequeue
   * @returns Array of dequeued system event messages
   */
  dequeueSystemEventBatch(maxCount: number): QueuedMessage[] {
    const batch: QueuedMessage[] = [];
    let found = 0;

    for (let i = 0; i < this.queue.length && found < maxCount; ) {
      if (this.queue[i].source === 'system_event') {
        const [msg] = this.queue.splice(i, 1);
        msg.status = 'processing';
        msg.processingStartedAt = new Date().toISOString();
        batch.push(msg);
        found++;
      } else {
        i++;
      }
    }

    if (batch.length > 0) {
      this.emitStatusUpdate();
      this.schedulePersist();
    }

    return batch;
  }

  /**
   * Re-queue a message that was dequeued but could not be delivered.
   * Resets the message status to pending and places it back at the front
   * of the queue so it will be the next message processed.
   *
   * @param message - The message to re-queue
   */
  requeue(message: QueuedMessage): void {
    // If the message was force-cancelled while being processed, do not re-add it
    if (message.status === 'cancelled') {
      this.currentMessage = null;
      this.emitStatusUpdate();
      this.schedulePersist();
      return;
    }
    message.status = 'pending';
    message.processingStartedAt = undefined;
    message.retryCount = (message.retryCount || 0) + 1;
    this.queue.unshift(message);
    this.currentMessage = null;
    this.emitStatusUpdate();
    this.schedulePersist();
  }

  /**
   * Mark a message as completed with optional response.
   *
   * @param messageId - ID of the message to mark complete
   * @param response - Optional response content from orchestrator
   */
  markCompleted(messageId: string, response?: string): void {
    if (!this.currentMessage || this.currentMessage.id !== messageId) {
      return;
    }

    this.currentMessage.status = 'completed';
    this.currentMessage.completedAt = new Date().toISOString();
    if (response !== undefined) {
      this.currentMessage.response = response;
    }

    this.totalProcessed++;
    this.addToHistory(this.currentMessage);
    const completed = this.currentMessage;
    this.currentMessage = null;

    this.emit('completed', completed);
    this.emitStatusUpdate();
    this.schedulePersist();
  }

  /**
   * Mark a batch of messages as completed.
   * Used for system event batching where multiple messages are dequeued
   * via dequeueSystemEventBatch() and delivered together.
   *
   * @param messages - Array of messages to mark as completed
   */
  markBatchCompleted(messages: QueuedMessage[]): void {
    const now = new Date().toISOString();
    for (const msg of messages) {
      msg.status = 'completed';
      msg.completedAt = now;
      msg.response = '';
      this.totalProcessed++;
      this.addToHistory(msg);
      this.emit('completed', msg);
    }
    if (messages.length > 0) {
      this.emitStatusUpdate();
      this.schedulePersist();
    }
  }

  /**
   * Mark a batch of messages as failed.
   * Used for system event batching when delivery of the combined batch fails.
   *
   * @param messages - Array of messages to mark as failed
   * @param error - Error message describing the failure
   */
  markBatchFailed(messages: QueuedMessage[], error: string): void {
    const now = new Date().toISOString();
    for (const msg of messages) {
      msg.status = 'failed';
      msg.completedAt = now;
      msg.error = error;
      this.totalFailed++;
      this.addToHistory(msg);
      this.emit('failed', msg);
    }
    if (messages.length > 0) {
      this.emitStatusUpdate();
      this.schedulePersist();
    }
  }

  /**
   * Mark a message as failed with an error.
   *
   * @param messageId - ID of the message to mark as failed
   * @param error - Error message describing the failure
   */
  markFailed(messageId: string, error: string): void {
    if (!this.currentMessage || this.currentMessage.id !== messageId) {
      return;
    }

    this.currentMessage.status = 'failed';
    this.currentMessage.completedAt = new Date().toISOString();
    this.currentMessage.error = error;

    this.totalFailed++;
    this.addToHistory(this.currentMessage);
    const failed = this.currentMessage;
    this.currentMessage = null;

    this.emit('failed', failed);
    this.emitStatusUpdate();
    this.schedulePersist();
  }

  /**
   * Cancel a pending message by ID.
   * Only messages with status 'pending' can be cancelled.
   *
   * @param messageId - ID of the message to cancel
   * @returns True if the message was found and cancelled
   */
  cancel(messageId: string): boolean {
    const index = this.queue.findIndex((m) => m.id === messageId);
    if (index === -1) {
      return false;
    }

    const [cancelled] = this.queue.splice(index, 1);
    cancelled.status = 'cancelled';
    cancelled.completedAt = new Date().toISOString();
    this.addToHistory(cancelled);

    this.emit('cancelled', cancelled);
    this.emitStatusUpdate();
    this.schedulePersist();

    return true;
  }

  /**
   * Force-cancel the currently processing message.
   * Use this to unstick a message that is stuck in 'processing' state.
   *
   * @returns True if there was a processing message to cancel
   */
  forceCancelCurrent(): boolean {
    if (!this.currentMessage) {
      return false;
    }

    this.currentMessage.status = 'cancelled';
    this.currentMessage.completedAt = new Date().toISOString();
    this.currentMessage.error = 'Force-cancelled by user';

    this.addToHistory(this.currentMessage);
    const cancelled = this.currentMessage;
    this.currentMessage = null;

    this.emit('cancelled', cancelled);
    this.emitStatusUpdate();
    this.schedulePersist();

    return true;
  }

  /**
   * Clear all pending messages from the queue.
   *
   * @returns Number of messages cleared
   */
  clearPending(): number {
    const count = this.queue.length;
    const cleared = this.queue.splice(0);

    for (const msg of cleared) {
      msg.status = 'cancelled';
      msg.completedAt = new Date().toISOString();
      this.addToHistory(msg);
    }

    if (count > 0) {
      this.emitStatusUpdate();
      this.schedulePersist();
    }

    return count;
  }

  /**
   * Get the current queue status summary.
   *
   * @returns QueueStatus object
   */
  getStatus(): QueueStatus {
    return {
      pendingCount: this.queue.length,
      isProcessing: this.currentMessage !== null,
      currentMessage: this.currentMessage ?? undefined,
      totalProcessed: this.totalProcessed,
      totalFailed: this.totalFailed,
      historyCount: this.history.length,
    };
  }

  /**
   * Get all pending messages in the queue (read-only copies).
   *
   * @returns Array of pending QueuedMessage objects
   */
  getPendingMessages(): QueuedMessage[] {
    return [...this.queue];
  }

  /**
   * Get the message history (completed/failed/cancelled).
   *
   * @returns Array of historical QueuedMessage objects (most recent first)
   */
  getHistory(): QueuedMessage[] {
    return [...this.history];
  }

  /**
   * Get a specific message by ID from queue, current, or history.
   *
   * @param messageId - ID of the message to find
   * @returns The QueuedMessage or undefined
   */
  getMessage(messageId: string): QueuedMessage | undefined {
    if (this.currentMessage?.id === messageId) {
      return this.currentMessage;
    }

    const pending = this.queue.find((m) => m.id === messageId);
    if (pending) {
      return pending;
    }

    return this.history.find((m) => m.id === messageId);
  }

  /**
   * Check if the queue has pending messages.
   *
   * @returns True if there are pending messages
   */
  hasPending(): boolean {
    return this.queue.length > 0;
  }

  /**
   * Check if a message is currently being processed.
   *
   * @returns True if processing
   */
  isProcessing(): boolean {
    return this.currentMessage !== null;
  }

  /**
   * Get the number of pending messages.
   *
   * @returns Pending message count
   */
  get pendingCount(): number {
    return this.queue.length;
  }

  /**
   * Add a completed/failed message to history, maintaining max size.
   *
   * @param message - Message to add to history
   */
  private addToHistory(message: QueuedMessage): void {
    this.history.unshift(message);

    if (this.history.length > MESSAGE_QUEUE_CONSTANTS.MAX_HISTORY_SIZE) {
      this.history.length = MESSAGE_QUEUE_CONSTANTS.MAX_HISTORY_SIZE;
    }
  }

  /**
   * Emit a status update event with the current queue status.
   */
  private emitStatusUpdate(): void {
    this.emit('statusUpdate', this.getStatus());
  }

  /**
   * Schedule a debounced persistence write. Uses a 50ms debounce to batch
   * multiple rapid mutations into a single disk write.
   * No-op when persistence is disabled.
   */
  private schedulePersist(): void {
    if (!this.persistPath) {
      return;
    }

    if (this.persistTimer !== null) {
      return; // Already scheduled
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistPromise = this.persistState().finally(() => {
        this.persistPromise = null;
      });
    }, 50);
  }

  /**
   * Write current queue state to disk using atomic temp-file-then-rename.
   * Errors are caught and logged to avoid disrupting queue operations.
   */
  private async persistState(): Promise<void> {
    if (!this.persistPath || !this.persistDir) {
      return;
    }

    const state: PersistedQueueState = {
      version: PERSISTED_QUEUE_VERSION,
      savedAt: new Date().toISOString(),
      queue: this.queue.map(toPersistedMessage),
      currentMessage: this.currentMessage ? toPersistedMessage(this.currentMessage) : null,
      history: this.history.map(toPersistedMessage),
      totalProcessed: this.totalProcessed,
      totalFailed: this.totalFailed,
    };

    const content = JSON.stringify(state, null, 2);

    try {
      await atomicWriteFile(this.persistPath, content);
    } catch (error) {
      this.logger.warn('Failed to persist queue state', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
