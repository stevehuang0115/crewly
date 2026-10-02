/**
 * Messaging Types Module
 *
 * Type definitions for the centralized message queue system.
 * All chat and Slack messages are enqueued into a FIFO queue,
 * processed one-at-a-time, and responses are routed back to the
 * correct source (WebSocket for chat, thread reply for Slack).
 *
 * @module types/messaging
 */

import { MESSAGE_SOURCES, type MessageSource } from '../constants.js';

// Re-export for backwards compatibility
export { MESSAGE_SOURCES, type MessageSource };

// =============================================================================
// Enums and Constants
// =============================================================================

/**
 * Valid message source values as a tuple (for .includes() validation).
 * Derived from the canonical MESSAGE_SOURCES object in constants.ts.
 */
export const MESSAGE_SOURCE_VALUES = Object.values(MESSAGE_SOURCES) as readonly MessageSource[];

/**
 * Valid queue message statuses
 */
export const QUEUE_MESSAGE_STATUSES = ['pending', 'processing', 'completed', 'failed', 'cancelled'] as const;

// =============================================================================
// Type Definitions
// =============================================================================

// MessageSource type is re-exported from constants.ts above

/**
 * Status of a message in the queue
 */
export type QueueMessageStatus = (typeof QUEUE_MESSAGE_STATUSES)[number];

/**
 * Metadata specific to the source of a message.
 * For Slack messages, includes a resolve callback to unblock the Slack bridge.
 */
export interface SourceMetadata {
  /** Slack resolve callback to unblock the bridge's blocking promise */
  slackResolve?: (response: string) => void;

  /** Slack user ID */
  userId?: string;

  /**
   * Slack user id of the person who sent this very message (the person the
   * agent acts for, issue #968). `userId` is the thread starter.
   */
  actingForUserId?: string;

  /** Slack channel ID */
  channelId?: string;

  /** Additional source-specific metadata */
  [key: string]: unknown;
}

/**
 * Input for enqueuing a new message
 */
export interface EnqueueMessageInput {
  /** Message content */
  content: string;

  /** Conversation ID for routing */
  conversationId: string;

  /** Source of the message */
  source: MessageSource;

  /** Source-specific metadata */
  sourceMetadata?: SourceMetadata;

  /** Target agent session for delivery (defaults to orchestrator if omitted) */
  targetSession?: string;
}

/**
 * A message in the queue
 */
export interface QueuedMessage {
  /** Unique queue entry ID */
  id: string;

  /** Message content */
  content: string;

  /** Conversation ID for routing */
  conversationId: string;

  /** Source of the message */
  source: MessageSource;

  /** Current status in the queue */
  status: QueueMessageStatus;

  /** Source-specific metadata */
  sourceMetadata?: SourceMetadata;

  /** ISO timestamp when enqueued */
  enqueuedAt: string;

  /** ISO timestamp when processing started */
  processingStartedAt?: string;

  /** ISO timestamp when completed or failed */
  completedAt?: string;

  /** Error message if failed */
  error?: string;

  /** Response content from the orchestrator */
  response?: string;

  /** Number of times this message has been re-queued due to agent-not-ready */
  retryCount?: number;

  /** ISO timestamp when the message was delivered to the orchestrator terminal */
  deliveredAt?: string;

  /** Target agent session for delivery (defaults to orchestrator if omitted) */
  targetSession?: string;
}

/**
 * Queue status summary for monitoring
 */
export interface QueueStatus {
  /** Number of messages waiting */
  pendingCount: number;

  /** Whether a message is currently being processed */
  isProcessing: boolean;

  /** The message currently being processed, if any */
  currentMessage?: QueuedMessage;

  /** Total messages processed since startup */
  totalProcessed: number;

  /** Total messages that failed since startup */
  totalFailed: number;

  /** Number of completed messages in history */
  historyCount: number;
}

/**
 * Queue event types emitted by MessageQueueService
 */
export interface QueueEvents {
  /** Emitted when a message is enqueued */
  enqueued: QueuedMessage;

  /** Emitted when a message starts processing */
  processing: QueuedMessage;

  /** Emitted when a message completes successfully */
  completed: QueuedMessage;

  /** Emitted when a message fails */
  failed: QueuedMessage;

  /** Emitted when queue status changes */
  statusUpdate: QueueStatus;
}

// =============================================================================
// Persistence Types
// =============================================================================

/** Current version of the persisted queue state format */
export const PERSISTED_QUEUE_VERSION = 1;

/**
 * A message stripped of non-serializable fields for disk persistence.
 * Function-valued sourceMetadata entries (like slackResolve) are removed.
 */
export interface PersistedMessage {
  /** Unique queue entry ID */
  id: string;

  /** Message content */
  content: string;

  /** Conversation ID for routing */
  conversationId: string;

  /** Source of the message */
  source: MessageSource;

  /** Current status in the queue */
  status: QueueMessageStatus;

  /** Serializable source-specific metadata (functions stripped) */
  sourceMetadata?: Record<string, string | number | boolean | null | undefined>;

  /** ISO timestamp when enqueued */
  enqueuedAt: string;

  /** ISO timestamp when processing started */
  processingStartedAt?: string;

  /** ISO timestamp when completed or failed */
  completedAt?: string;

  /** Error message if failed */
  error?: string;

  /** Response content from the orchestrator */
  response?: string;

  /** Number of times this message has been re-queued due to agent-not-ready */
  retryCount?: number;

  /** ISO timestamp when the message was delivered to the orchestrator terminal */
  deliveredAt?: string;
}

/**
 * Full persisted state of the message queue, written to disk after every mutation.
 */
export interface PersistedQueueState {
  /** Schema version for forward compatibility */
  version: typeof PERSISTED_QUEUE_VERSION;

  /** ISO timestamp of when this state was saved */
  savedAt: string;

  /** Pending messages in FIFO order */
  queue: PersistedMessage[];

  /** The message that was being processed at save time, if any */
  currentMessage: PersistedMessage | null;

  /** Completed/failed/cancelled message history (most recent first) */
  history: PersistedMessage[];

  /** Total messages processed since last counter reset */
  totalProcessed: number;

  /** Total messages that failed since last counter reset */
  totalFailed: number;
}

// =============================================================================
// Persistence Helpers
// =============================================================================

/**
 * Convert a QueuedMessage to a PersistedMessage by stripping function-valued
 * sourceMetadata entries (e.g. slackResolve callbacks that can't be serialized).
 *
 * @param msg - The queued message to convert
 * @returns A serializable PersistedMessage
 */
export function toPersistedMessage(msg: QueuedMessage): PersistedMessage {
  const persisted: PersistedMessage = {
    id: msg.id,
    content: msg.content,
    conversationId: msg.conversationId,
    source: msg.source,
    status: msg.status,
    enqueuedAt: msg.enqueuedAt,
  };

  if (msg.processingStartedAt !== undefined) {
    persisted.processingStartedAt = msg.processingStartedAt;
  }
  if (msg.completedAt !== undefined) {
    persisted.completedAt = msg.completedAt;
  }
  if (msg.error !== undefined) {
    persisted.error = msg.error;
  }
  if (msg.response !== undefined) {
    persisted.response = msg.response;
  }
  if (msg.retryCount !== undefined && msg.retryCount > 0) {
    persisted.retryCount = msg.retryCount;
  }
  if (msg.deliveredAt !== undefined) {
    persisted.deliveredAt = msg.deliveredAt;
  }

  if (msg.sourceMetadata) {
    const cleaned: Record<string, string | number | boolean | null | undefined> = {};
    let hasEntries = false;
    for (const [key, value] of Object.entries(msg.sourceMetadata)) {
      if (typeof value !== 'function') {
        cleaned[key] = value as string | number | boolean | null | undefined;
        hasEntries = true;
      }
    }
    if (hasEntries) {
      persisted.sourceMetadata = cleaned;
    }
  }

  return persisted;
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if a value is a valid message source
 *
 * @param value - Value to check
 * @returns True if value is a valid MessageSource
 */
export function isValidMessageSource(value: unknown): value is MessageSource {
  return typeof value === 'string' && MESSAGE_SOURCE_VALUES.includes(value as MessageSource);
}

/**
 * Check if a value is a valid queue message status
 *
 * @param value - Value to check
 * @returns True if value is a valid QueueMessageStatus
 */
export function isValidQueueMessageStatus(value: unknown): value is QueueMessageStatus {
  return typeof value === 'string' && QUEUE_MESSAGE_STATUSES.includes(value as QueueMessageStatus);
}

/**
 * Check if an object is a valid EnqueueMessageInput
 *
 * @param value - Value to check
 * @returns True if value is a valid EnqueueMessageInput
 */
export function isValidEnqueueMessageInput(value: unknown): value is EnqueueMessageInput {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const input = value as Record<string, unknown>;

  if (typeof input.content !== 'string' || input.content.trim().length === 0) {
    return false;
  }

  if (typeof input.conversationId !== 'string' || input.conversationId.trim().length === 0) {
    return false;
  }

  if (!isValidMessageSource(input.source)) {
    return false;
  }

  return true;
}

/**
 * Check if an object is a valid QueuedMessage
 *
 * @param value - Value to check
 * @returns True if value is a valid QueuedMessage
 */
export function isValidQueuedMessage(value: unknown): value is QueuedMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const msg = value as Record<string, unknown>;

  if (typeof msg.id !== 'string' || !msg.id) {
    return false;
  }

  if (typeof msg.content !== 'string') {
    return false;
  }

  if (typeof msg.conversationId !== 'string' || !msg.conversationId) {
    return false;
  }

  if (!isValidMessageSource(msg.source)) {
    return false;
  }

  if (!isValidQueueMessageStatus(msg.status)) {
    return false;
  }

  if (typeof msg.enqueuedAt !== 'string') {
    return false;
  }

  return true;
}

/**
 * Check if an object is a valid QueueStatus
 *
 * @param value - Value to check
 * @returns True if value is a valid QueueStatus
 */
export function isValidQueueStatus(value: unknown): value is QueueStatus {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const status = value as Record<string, unknown>;

  if (typeof status.pendingCount !== 'number' || status.pendingCount < 0) {
    return false;
  }

  if (typeof status.isProcessing !== 'boolean') {
    return false;
  }

  if (typeof status.totalProcessed !== 'number' || status.totalProcessed < 0) {
    return false;
  }

  if (typeof status.totalFailed !== 'number' || status.totalFailed < 0) {
    return false;
  }

  if (typeof status.historyCount !== 'number' || status.historyCount < 0) {
    return false;
  }

  return true;
}

/**
 * Check if an object is a valid PersistedQueueState for safe restoration.
 *
 * @param value - Value to check
 * @returns True if value is a valid PersistedQueueState
 */
export function isValidPersistedQueueState(value: unknown): value is PersistedQueueState {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const state = value as Record<string, unknown>;

  if (state.version !== PERSISTED_QUEUE_VERSION) {
    return false;
  }

  if (typeof state.savedAt !== 'string') {
    return false;
  }

  if (!Array.isArray(state.queue)) {
    return false;
  }

  // Validate each queued message
  for (const msg of state.queue) {
    if (!isValidQueuedMessage(msg)) {
      return false;
    }
  }

  // currentMessage can be null or a valid message
  if (state.currentMessage !== null && !isValidQueuedMessage(state.currentMessage)) {
    return false;
  }

  if (!Array.isArray(state.history)) {
    return false;
  }

  for (const msg of state.history) {
    if (!isValidQueuedMessage(msg)) {
      return false;
    }
  }

  if (typeof state.totalProcessed !== 'number' || state.totalProcessed < 0) {
    return false;
  }

  if (typeof state.totalFailed !== 'number' || state.totalFailed < 0) {
    return false;
  }

  return true;
}
