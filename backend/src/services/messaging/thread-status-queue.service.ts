/**
 * Thread Status Queue Service
 *
 * Tracks the lifecycle of every inbound message thread across platforms
 * (Slack, GChat, Telegram, etc.). On orchestrator restart, non-terminal
 * threads are recovered and re-enqueued so no user messages are silently dropped.
 *
 * Persistence is debounced and written to ~/.crewly/thread-status-queue.json
 * using atomic file I/O to prevent corruption.
 *
 * @module services/messaging/thread-status-queue
 */

import { randomUUID } from 'crypto';
import path from 'path';
import { THREAD_STATUS_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { atomicWriteFile, safeReadJson } from '../../utils/file-io.utils.js';
import {
  PERSISTED_THREAD_STATUS_VERSION,
  isPersistedThreadStatusState,
  isTerminalStatus,
  isReplyStatus,
} from '../../types/thread-status.types.js';
import type {
  ThreadStatus,
  ThreadStatusEntry,
  TrackInboundInput,
  ThreadStatusStats,
  PersistedThreadStatusState,
  ReplyStatus,
} from '../../types/thread-status.types.js';

/**
 * Service that maintains a persistent queue of thread statuses.
 * Constructed with a crewly home directory path for disk persistence.
 *
 * Lifecycle: enqueued → delivered → replied_* (terminal or waiting_actions)
 *
 * @example
 * ```typescript
 * const svc = new ThreadStatusQueueService('/home/user/.crewly');
 * await svc.loadPersistedState();
 *
 * const entry = svc.trackInbound({
 *   source: 'slack',
 *   threadKey: 'C123:170743.001',
 *   conversationId: 'conv-1',
 *   messagePreview: 'Deploy the new feature',
 * });
 *
 * svc.markDelivered('C123:170743.001');
 * svc.markReplied('C123:170743.001', 'replied_completed');
 * ```
 */
export class ThreadStatusQueueService {
  /** Singleton instance */
  private static instance: ThreadStatusQueueService;

  /** Logger for this service */
  private logger: ComponentLogger = LoggerService.getInstance().createComponentLogger('ThreadStatusQueueService');

  /** All tracked thread entries, keyed by threadKey for O(1) lookup */
  private entries: Map<string, ThreadStatusEntry> = new Map();

  /** Path to the persistence file, or null if init() has not been called */
  private persistPath: string | null = null;

  /** Debounce timer for batching persistence writes */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  /** ISO timestamp of last cleanup run */
  private lastCleanupAt: string = new Date().toISOString();

  /**
   * Creates a new ThreadStatusQueueService.
   * Use getInstance() for singleton access, or construct directly for testing.
   *
   * @param crewlyHome - Optional crewly home directory path for immediate initialization
   */
  constructor(crewlyHome?: string) {
    if (crewlyHome) {
      this.persistPath = path.join(crewlyHome, THREAD_STATUS_CONSTANTS.STORAGE_FILE);
      this.logger.info('Initialized', { persistPath: this.persistPath });
    }
  }

  /**
   * Returns the singleton instance of ThreadStatusQueueService.
   * Call init() after this to set the persistence path.
   *
   * @returns The singleton instance
   */
  static getInstance(): ThreadStatusQueueService {
    if (!ThreadStatusQueueService.instance) {
      ThreadStatusQueueService.instance = new ThreadStatusQueueService();
    }
    return ThreadStatusQueueService.instance;
  }

  /**
   * Resets the singleton instance. For testing only.
   */
  static resetInstance(): void {
    if (ThreadStatusQueueService.instance) {
      ThreadStatusQueueService.instance.destroy();
    }
    ThreadStatusQueueService.instance = undefined as unknown as ThreadStatusQueueService;
  }

  /**
   * Loads persisted state from disk.
   * If the file doesn't exist or is corrupted, starts with an empty queue.
   */
  async loadPersistedState(): Promise<void> {
    if (!this.persistPath) {
      this.logger.warn('loadPersistedState called before init — skipping');
      return;
    }

    const defaultState: PersistedThreadStatusState = {
      version: PERSISTED_THREAD_STATUS_VERSION,
      entries: [],
      lastCleanupAt: new Date().toISOString(),
    };

    const state = await safeReadJson<PersistedThreadStatusState>(
      this.persistPath,
      defaultState,
      this.logger,
    );

    if (!isPersistedThreadStatusState(state)) {
      this.logger.warn('Invalid persisted state, starting fresh');
      return;
    }

    this.entries.clear();
    for (const entry of state.entries) {
      this.entries.set(entry.threadKey, entry);
    }
    this.lastCleanupAt = state.lastCleanupAt;

    this.logger.info('Loaded persisted state', {
      entryCount: this.entries.size,
      lastCleanupAt: this.lastCleanupAt,
    });
  }

  /**
   * Records a new inbound thread message with status `enqueued`.
   * If a thread with the same threadKey already exists, the existing entry is returned.
   *
   * @param input - Inbound message details
   * @returns The created (or existing) ThreadStatusEntry
   */
  trackInbound(input: TrackInboundInput): ThreadStatusEntry {
    const existing = this.entries.get(input.threadKey);
    if (existing) {
      this.logger.debug('Thread already tracked, returning existing', { threadKey: input.threadKey });
      return existing;
    }

    const now = new Date().toISOString();
    const entry: ThreadStatusEntry = {
      id: randomUUID(),
      source: input.source,
      threadKey: input.threadKey,
      conversationId: input.conversationId,
      status: 'enqueued',
      receivedAt: now,
      updatedAt: now,
      messagePreview: input.messagePreview.slice(0, THREAD_STATUS_CONSTANTS.MAX_PREVIEW_LENGTH),
      retryCount: 0,
      queueMessageId: input.queueMessageId,
      sourceMetadata: input.sourceMetadata,
    };

    this.entries.set(input.threadKey, entry);
    this.schedulePersist();

    this.logger.info('Tracked inbound thread', {
      threadKey: input.threadKey,
      source: input.source,
      conversationId: input.conversationId,
    });

    return entry;
  }

  /**
   * Transitions a thread from `enqueued` (or `error`) to `delivered`.
   * No-op if thread is already in a terminal or later status.
   *
   * @param threadKey - Platform-specific thread identifier
   * @throws Error if threadKey is not found
   */
  markDelivered(threadKey: string): void {
    const entry = this.getOrThrow(threadKey, 'markDelivered');
    if (isTerminalStatus(entry.status) || entry.status === 'delivered') {
      return;
    }

    const now = new Date().toISOString();
    entry.status = 'delivered';
    entry.deliveredAt = now;
    entry.updatedAt = now;
    this.schedulePersist();

    this.logger.info('Marked delivered', { threadKey });
  }

  /**
   * Transitions a thread to one of the replied_* statuses.
   * Sets the repliedAt timestamp.
   *
   * @param threadKey - Platform-specific thread identifier
   * @param status - One of: replied_completed, replied_waiting_actions, replied_to_follow_up
   * @throws Error if threadKey is not found or status is not a valid reply status
   */
  markReplied(threadKey: string, status: ReplyStatus): void {
    if (!isReplyStatus(status)) {
      throw new Error(`Invalid reply status: ${status}`);
    }

    const entry = this.getOrThrow(threadKey, 'markReplied');
    if (isTerminalStatus(entry.status)) {
      return;
    }

    const now = new Date().toISOString();
    entry.status = status;
    entry.repliedAt = now;
    entry.updatedAt = now;
    this.schedulePersist();

    this.logger.info('Marked replied', { threadKey, status });
  }

  /**
   * Records that an agent was delegated work from this thread.
   *
   * @param threadKey - Platform-specific thread identifier
   * @param agentSession - Session name of the delegated agent
   * @throws Error if threadKey is not found
   */
  addDelegatedAgent(threadKey: string, agentSession: string): void {
    const entry = this.getOrThrow(threadKey, 'addDelegatedAgent');

    if (!entry.delegatedAgents) {
      entry.delegatedAgents = [];
    }

    if (!entry.delegatedAgents.includes(agentSession)) {
      entry.delegatedAgents.push(agentSession);
      entry.updatedAt = new Date().toISOString();
      this.schedulePersist();

      this.logger.info('Added delegated agent', { threadKey, agentSession });
    }
  }

  /**
   * Transitions a `replied_waiting_actions` thread to `replied_completed`
   * when all delegated agents have finished their work.
   *
   * @param threadKey - Platform-specific thread identifier
   * @throws Error if threadKey is not found
   */
  markDelegationsComplete(threadKey: string): void {
    const entry = this.getOrThrow(threadKey, 'markDelegationsComplete');
    if (entry.status !== 'replied_waiting_actions') {
      return;
    }

    entry.status = 'replied_completed';
    entry.updatedAt = new Date().toISOString();
    this.schedulePersist();

    this.logger.info('Marked delegations complete', { threadKey });
  }

  /**
   * Returns all entries not in a terminal status. Used for restart recovery.
   *
   * @returns Array of non-terminal ThreadStatusEntry objects
   */
  getPendingThreads(): ThreadStatusEntry[] {
    const pending: ThreadStatusEntry[] = [];
    for (const entry of this.entries.values()) {
      if (!isTerminalStatus(entry.status)) {
        pending.push(entry);
      }
    }
    return pending;
  }

  /**
   * Returns all entries matching the given status.
   *
   * @param status - The ThreadStatus to filter by
   * @returns Array of matching ThreadStatusEntry objects
   */
  getByStatus(status: ThreadStatus): ThreadStatusEntry[] {
    const results: ThreadStatusEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.status === status) {
        results.push(entry);
      }
    }
    return results;
  }

  /**
   * Retrieves a specific entry by threadKey.
   *
   * @param threadKey - Platform-specific thread identifier
   * @returns The entry, or null if not found
   */
  get(threadKey: string): ThreadStatusEntry | null {
    return this.entries.get(threadKey) ?? null;
  }

  /**
   * Expires entries that have been in a non-terminal status longer than maxAgeMinutes.
   * Transitions them to `expired`.
   *
   * @param maxAgeMinutes - Maximum age in minutes (defaults to STALE_TIMEOUT_MINUTES)
   * @returns Number of entries expired
   */
  expireStale(maxAgeMinutes: number = THREAD_STATUS_CONSTANTS.STALE_TIMEOUT_MINUTES): number {
    const cutoff = Date.now() - maxAgeMinutes * 60 * 1000;
    let count = 0;

    for (const entry of this.entries.values()) {
      if (isTerminalStatus(entry.status)) continue;

      const updatedTime = new Date(entry.updatedAt).getTime();
      if (updatedTime < cutoff) {
        entry.status = 'expired';
        entry.updatedAt = new Date().toISOString();
        count++;
      }
    }

    if (count > 0) {
      this.schedulePersist();
      this.logger.info('Expired stale threads', { count, maxAgeMinutes });
    }

    return count;
  }

  /**
   * Removes terminal entries older than retentionHours.
   * Also enforces MAX_ENTRIES by pruning oldest terminal entries first.
   *
   * @param retentionHours - Hours to retain terminal entries (defaults to CLEANUP_RETENTION_HOURS)
   * @returns Number of entries removed
   */
  cleanup(retentionHours: number = THREAD_STATUS_CONSTANTS.CLEANUP_RETENTION_HOURS): number {
    const cutoff = Date.now() - retentionHours * 60 * 60 * 1000;
    let count = 0;

    // Remove terminal entries older than retention period
    for (const [key, entry] of this.entries) {
      if (isTerminalStatus(entry.status)) {
        const updatedTime = new Date(entry.updatedAt).getTime();
        if (updatedTime < cutoff) {
          this.entries.delete(key);
          count++;
        }
      }
    }

    // Enforce MAX_ENTRIES: prune oldest terminal entries first
    if (this.entries.size > THREAD_STATUS_CONSTANTS.MAX_ENTRIES) {
      const terminalEntries = Array.from(this.entries.entries())
        .filter(([, e]) => isTerminalStatus(e.status))
        .sort(([, a], [, b]) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());

      for (const [key] of terminalEntries) {
        if (this.entries.size <= THREAD_STATUS_CONSTANTS.MAX_ENTRIES) break;
        this.entries.delete(key);
        count++;
      }
    }

    if (count > 0) {
      this.lastCleanupAt = new Date().toISOString();
      this.schedulePersist();
      this.logger.info('Cleaned up entries', { removed: count, remaining: this.entries.size });
    }

    return count;
  }

  /**
   * Returns statistics for monitoring the thread status queue.
   *
   * @returns Stats snapshot including total, per-status counts, and oldest pending timestamp
   */
  getStats(): ThreadStatusStats {
    const byStatus: Record<ThreadStatus, number> = {
      enqueued: 0,
      delivered: 0,
      replied_completed: 0,
      replied_waiting_actions: 0,
      replied_to_follow_up: 0,
      expired: 0,
      error: 0,
    };

    let oldestPending: string | null = null;

    for (const entry of this.entries.values()) {
      byStatus[entry.status]++;

      if (!isTerminalStatus(entry.status)) {
        if (oldestPending === null || entry.receivedAt < oldestPending) {
          oldestPending = entry.receivedAt;
        }
      }
    }

    return {
      total: this.entries.size,
      byStatus,
      oldestPending,
    };
  }

  /**
   * Initializes the service with a crewly home directory for persistence.
   * Must be called before loadPersistedState() when using getInstance().
   *
   * @param crewlyHome - Absolute path to the crewly home directory (e.g. ~/.crewly)
   */
  init(crewlyHome: string): void {
    this.persistPath = path.join(crewlyHome, THREAD_STATUS_CONSTANTS.STORAGE_FILE);
    this.logger.info('Initialized', { persistPath: this.persistPath });
  }

  /**
   * Public convenience method: optionally re-inits the persist path,
   * then loads persisted state from disk.
   *
   * @param crewlyHome - Optional crewly home directory to re-initialize with
   */
  async load(crewlyHome?: string): Promise<void> {
    if (crewlyHome) {
      this.init(crewlyHome);
    }
    await this.loadPersistedState();
  }

  /**
   * Immediately flushes the current state to disk. Call during graceful shutdown
   * to ensure no in-memory mutations are lost.
   */
  async persist(): Promise<void> {
    // Cancel any debounced write — we flush synchronously
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persistToDisk();
  }

  /**
   * Cleans up timers. Call on shutdown.
   */
  destroy(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Retrieves an entry by threadKey or throws an error with a descriptive message.
   *
   * @param threadKey - Platform-specific thread identifier
   * @param caller - Name of the calling method (for error messages)
   * @returns The found entry
   * @throws Error if entry is not found
   */
  private getOrThrow(threadKey: string, caller: string): ThreadStatusEntry {
    const entry = this.entries.get(threadKey);
    if (!entry) {
      throw new Error(`${caller}: thread not found — threadKey=${threadKey}`);
    }
    return entry;
  }

  /**
   * Schedules a debounced persistence write to disk.
   * Multiple mutations within PERSIST_DEBOUNCE_MS are batched into a single write.
   */
  private schedulePersist(): void {
    if (!this.persistPath) return;

    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistToDisk().catch((err) => {
        this.logger.warn('Failed to persist thread status queue', { error: String(err) });
      });
    }, THREAD_STATUS_CONSTANTS.PERSIST_DEBOUNCE_MS);
  }

  /**
   * Writes the current queue state to disk atomically.
   */
  private async persistToDisk(): Promise<void> {
    if (!this.persistPath) {
      this.logger.warn('persistToDisk called before init — skipping');
      return;
    }

    const state: PersistedThreadStatusState = {
      version: PERSISTED_THREAD_STATUS_VERSION,
      entries: Array.from(this.entries.values()),
      lastCleanupAt: this.lastCleanupAt,
    };

    await atomicWriteFile(this.persistPath, JSON.stringify(state, null, 2));
    this.logger.debug('Persisted to disk', { entryCount: state.entries.length });
  }
}
