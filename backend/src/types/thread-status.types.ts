/**
 * Thread Status Types Module
 *
 * Type definitions for the Thread Status Queue system that tracks
 * the lifecycle of every inbound message thread across platforms.
 * On orchestrator restart, non-terminal threads are recovered and
 * re-enqueued for processing.
 *
 * @module types/thread-status
 */

import type { MessageSource } from '../constants.js';

// =============================================================================
// Status Types
// =============================================================================

/**
 * All possible states in the thread status lifecycle.
 *
 * - `enqueued` — Message received, queued for orchestrator
 * - `delivered` — Message written to orchestrator PTY
 * - `replied_completed` — Orchestrator replied, no further action needed
 * - `replied_waiting_actions` — Orchestrator replied but delegated work; needs follow-up
 * - `replied_to_follow_up` — Orchestrator replied asking for clarification
 * - `expired` — Thread timed out without reply
 * - `error` — Delivery or processing failed (retryable)
 */
export type ThreadStatus =
  | 'enqueued'
  | 'delivered'
  | 'replied_completed'
  | 'replied_waiting_actions'
  | 'replied_to_follow_up'
  | 'expired'
  | 'error';

/**
 * All valid thread status values as a tuple for runtime validation.
 */
export const THREAD_STATUS_VALUES = [
  'enqueued',
  'delivered',
  'replied_completed',
  'replied_waiting_actions',
  'replied_to_follow_up',
  'expired',
  'error',
] as const;

/**
 * Terminal statuses that require no further orchestrator action.
 * Used by getPendingThreads() to filter out completed threads.
 */
export const TERMINAL_STATUSES: readonly ThreadStatus[] = [
  'replied_completed',
  'replied_to_follow_up',
  'expired',
] as const;

/**
 * Valid reply statuses for the markReplied() method.
 */
export type ReplyStatus = 'replied_completed' | 'replied_waiting_actions' | 'replied_to_follow_up';

// =============================================================================
// Source Metadata
// =============================================================================

/**
 * Platform-specific metadata stored with each thread entry.
 * Used to re-enqueue messages on orchestrator restart.
 */
export interface ThreadSourceMetadata {
  /** Slack/GChat/Telegram channel identifier */
  channelId?: string;
  /** Slack thread timestamp */
  threadTs?: string;
  /** User who sent the message */
  userId?: string;
  /** Telegram/WhatsApp chat identifier */
  chatId?: string;
}

// =============================================================================
// Core Data Model
// =============================================================================

/**
 * A single thread status entry tracking one inbound message thread
 * from reception through delivery and reply.
 */
export interface ThreadStatusEntry {
  /** Unique ID (matches QueuedMessage.id or generated) */
  id: string;

  /** Source platform that originated the message */
  source: MessageSource;

  /** Platform-specific thread identifier (e.g. "C123:1707430000.001234" for Slack) */
  threadKey: string;

  /** The conversationId used in MessageQueueService */
  conversationId: string;

  /** Current status in the thread lifecycle */
  status: ThreadStatus;

  /** ISO timestamp when message was first received */
  receivedAt: string;

  /** ISO timestamp when message was delivered to orchestrator PTY */
  deliveredAt?: string;

  /** ISO timestamp when orchestrator replied */
  repliedAt?: string;

  /** ISO timestamp of last status update */
  updatedAt: string;

  /** Agent sessions that were delegated work from this thread */
  delegatedAgents?: string[];

  /** Brief summary of the user's message (first 200 chars) */
  messagePreview: string;

  /** Number of delivery retry attempts */
  retryCount: number;

  /** The QueuedMessage.id if still in message queue */
  queueMessageId?: string;

  /** Source metadata for re-enqueue on restart */
  sourceMetadata?: ThreadSourceMetadata;
}

// =============================================================================
// Persistence
// =============================================================================

/**
 * Version number for the persisted thread status queue format.
 * Increment when making breaking changes to the storage schema.
 */
export const PERSISTED_THREAD_STATUS_VERSION = 1;

/**
 * Shape of the persisted JSON file at ~/.crewly/thread-status-queue.json
 */
export interface PersistedThreadStatusState {
  /** Schema version for forward compatibility */
  version: number;

  /** All tracked thread entries */
  entries: ThreadStatusEntry[];

  /** ISO timestamp of last cleanup run */
  lastCleanupAt: string;
}

// =============================================================================
// Service Input Types
// =============================================================================

/**
 * Input for tracking a new inbound thread message.
 */
export interface TrackInboundInput {
  /** Source platform */
  source: MessageSource;

  /** Platform-specific thread identifier */
  threadKey: string;

  /** The conversationId used in MessageQueueService */
  conversationId: string;

  /** Brief summary of the user's message (first 200 chars) */
  messagePreview: string;

  /** The QueuedMessage.id if still in message queue */
  queueMessageId?: string;

  /** Source metadata for re-enqueue on restart */
  sourceMetadata?: ThreadSourceMetadata;
}

/**
 * Statistics snapshot for monitoring the thread status queue.
 */
export interface ThreadStatusStats {
  /** Total number of entries in the queue */
  total: number;

  /** Count of entries per status */
  byStatus: Record<ThreadStatus, number>;

  /** ISO timestamp of the oldest non-terminal entry, or null if none */
  oldestPending: string | null;
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Checks whether a value is a valid ThreadStatus string.
 *
 * @param value - Value to check
 * @returns True if value is a valid ThreadStatus
 */
export function isThreadStatus(value: unknown): value is ThreadStatus {
  return typeof value === 'string' && (THREAD_STATUS_VALUES as readonly string[]).includes(value);
}

/**
 * Checks whether a given ThreadStatus is terminal (no further action needed).
 *
 * @param status - The status to check
 * @returns True if the status is terminal
 */
export function isTerminalStatus(status: ThreadStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Checks whether a value is a valid ThreadStatusEntry.
 * Validates required fields and their types.
 *
 * @param value - Value to check
 * @returns True if value conforms to ThreadStatusEntry
 */
export function isThreadStatusEntry(value: unknown): value is ThreadStatusEntry {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.source === 'string' &&
    typeof obj.threadKey === 'string' &&
    typeof obj.conversationId === 'string' &&
    isThreadStatus(obj.status) &&
    typeof obj.receivedAt === 'string' &&
    typeof obj.updatedAt === 'string' &&
    typeof obj.messagePreview === 'string' &&
    typeof obj.retryCount === 'number'
  );
}

/**
 * Checks whether a value is a valid PersistedThreadStatusState.
 *
 * @param value - Value to check
 * @returns True if value conforms to PersistedThreadStatusState
 */
export function isPersistedThreadStatusState(value: unknown): value is PersistedThreadStatusState {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.version === 'number' &&
    Array.isArray(obj.entries) &&
    typeof obj.lastCleanupAt === 'string'
  );
}

/**
 * Checks whether a value is a valid ReplyStatus.
 *
 * @param value - Value to check
 * @returns True if value is a valid reply status
 */
export function isReplyStatus(value: unknown): value is ReplyStatus {
  return value === 'replied_completed' || value === 'replied_waiting_actions' || value === 'replied_to_follow_up';
}
