/**
 * Message Replay Service
 *
 * Replays pending user messages after orchestrator restarts (#247).
 * When the orchestrator goes offline (backend restart, session crash, etc.),
 * user messages sent via Slack or Chat UI may be silently lost. This service
 * scans chat conversation history on startup for unreplied user messages
 * that arrived after the last queue persistence timestamp and re-enqueues
 * them so the orchestrator can process them.
 *
 * Flow:
 * 1. On startup, read `savedAt` from persisted queue state to determine
 *    when the backend last persisted state (proxy for "last alive" time).
 * 2. Scan all active chat conversations for user messages sent after `savedAt`.
 * 3. Filter out messages that already have an orchestrator/system reply after them.
 * 4. Filter out messages already pending in the restored queue (by conversationId+content).
 * 5. Enqueue surviving messages with a [REPLAYED] prefix.
 *
 * @module services/messaging/message-replay
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { MessageQueueService } from './message-queue.service.js';
import type { ChatService } from '../chat/chat.service.js';
import type { ChatMessage } from '../../types/chat.types.js';
import { MESSAGE_REPLAY_CONSTANTS, MESSAGE_SOURCES, type MessageSource } from '../../constants.js';
import { safeReadJson } from '../../utils/file-io.utils.js';
import path from 'path';

/**
 * Result of a replay scan, containing details about what was found and replayed.
 */
export interface ReplayResult {
  /** Number of unreplied messages found */
  foundCount: number;
  /** Number of messages actually replayed (after filtering duplicates) */
  replayedCount: number;
  /** Number skipped because they were already in the queue */
  skippedDuplicate: number;
  /** The savedAt timestamp used to determine offline start */
  offlineSince: string;
  /** Duration the backend was offline (ms) */
  offlineDurationMs: number;
}

/**
 * MessageReplayService scans chat history on startup and replays
 * unreplied user messages that arrived while the orchestrator was offline.
 *
 * @example
 * ```typescript
 * const replayService = new MessageReplayService(
 *   messageQueueService,
 *   chatService,
 *   '~/.crewly'
 * );
 * const result = await replayService.replayPendingMessages();
 * if (result.replayedCount > 0) {
 *   logger.info(`Replayed ${result.replayedCount} missed messages`);
 * }
 * ```
 */
export class MessageReplayService {
  private logger: ComponentLogger;
  private messageQueueService: MessageQueueService;
  private chatService: ChatService;
  private crewlyHome: string;

  /**
   * Create a new MessageReplayService.
   *
   * @param messageQueueService - The message queue to enqueue replayed messages into
   * @param chatService - The chat service to scan for unreplied messages
   * @param crewlyHome - Path to the crewly home directory (e.g. ~/.crewly)
   */
  constructor(
    messageQueueService: MessageQueueService,
    chatService: ChatService,
    crewlyHome: string
  ) {
    this.logger = LoggerService.getInstance().createComponentLogger('MessageReplay');
    this.messageQueueService = messageQueueService;
    this.chatService = chatService;
    this.crewlyHome = crewlyHome;
  }

  /**
   * Scan chat history for unreplied user messages and replay them into the queue.
   *
   * This method should be called once during startup, after the queue has been
   * restored from persisted state but before the orchestrator starts processing.
   *
   * @returns Result containing counts of found, replayed, and skipped messages
   */
  async replayPendingMessages(): Promise<ReplayResult> {
    const result: ReplayResult = {
      foundCount: 0,
      replayedCount: 0,
      skippedDuplicate: 0,
      offlineSince: '',
      offlineDurationMs: 0,
    };

    try {
      // Step 1: Determine when the backend went offline
      const savedAt = await this.getLastPersistedTimestamp();
      if (!savedAt) {
        this.logger.debug('No persisted queue state found, skipping replay');
        return result;
      }

      const offlineDurationMs = Date.now() - new Date(savedAt).getTime();
      result.offlineSince = savedAt;
      result.offlineDurationMs = offlineDurationMs;

      // Skip replay if the backend was only offline briefly
      if (offlineDurationMs < MESSAGE_REPLAY_CONSTANTS.MIN_OFFLINE_DURATION_MS) {
        this.logger.debug('Backend was offline for less than minimum duration, skipping replay', {
          offlineDurationMs,
          minDurationMs: MESSAGE_REPLAY_CONSTANTS.MIN_OFFLINE_DURATION_MS,
        });
        return result;
      }

      // Cap the replay window to avoid replaying ancient messages
      const replayWindowStart = new Date(
        Math.max(
          new Date(savedAt).getTime(),
          Date.now() - MESSAGE_REPLAY_CONSTANTS.MAX_REPLAY_WINDOW_MS
        )
      ).toISOString();

      this.logger.info('Scanning for unreplied messages since last persistence', {
        savedAt,
        offlineDurationMs,
        replayWindowStart,
      });

      // Step 2: Get all active conversations
      const conversations = await this.chatService.getConversations({
        includeArchived: false,
      });

      if (conversations.length === 0) {
        this.logger.debug('No active conversations found, skipping replay');
        return result;
      }

      // Step 3: Build set of content already in the restored queue to avoid duplicates
      const pendingMessages = this.messageQueueService.getPendingMessages();
      const pendingContentSet = new Set(
        pendingMessages.map((m) => `${m.conversationId}::${m.content}`)
      );

      // Step 4: Scan each conversation for unreplied user messages
      const unrepliedMessages: Array<{ conversationId: string; message: ChatMessage }> = [];

      for (const conversation of conversations) {
        const messages = await this.chatService.getMessages({
          conversationId: conversation.id,
          after: replayWindowStart,
          limit: 100,
        });

        // Find user messages that have no orchestrator reply after them
        const userMessages = this.findUnrepliedUserMessages(messages);
        for (const msg of userMessages) {
          unrepliedMessages.push({ conversationId: conversation.id, message: msg });
        }
      }

      result.foundCount = unrepliedMessages.length;

      if (unrepliedMessages.length === 0) {
        this.logger.debug('No unreplied messages found during replay scan');
        return result;
      }

      this.logger.info('Found unreplied messages to replay', {
        count: unrepliedMessages.length,
      });

      // Step 5: Enqueue unreplied messages (up to max replay count)
      const toReplay = unrepliedMessages.slice(0, MESSAGE_REPLAY_CONSTANTS.MAX_REPLAY_COUNT);

      for (const { conversationId, message } of toReplay) {
        const contentKey = `${conversationId}::${message.content}`;

        // Skip if already in the queue
        if (pendingContentSet.has(contentKey)) {
          result.skippedDuplicate++;
          continue;
        }

        // Determine the source based on conversation channel type or metadata
        const source = this.inferMessageSource(message);

        const replayContent = `${MESSAGE_REPLAY_CONSTANTS.REPLAY_PREFIX} ${message.content}`;

        try {
          this.messageQueueService.enqueue({
            content: replayContent,
            conversationId,
            source,
          });
          result.replayedCount++;
          pendingContentSet.add(contentKey); // Prevent re-adding in this cycle

          this.logger.debug('Replayed message', {
            messageId: message.id,
            conversationId,
            source,
            contentPreview: message.content.substring(0, 80),
          });
        } catch (enqueueErr) {
          this.logger.warn('Failed to enqueue replayed message', {
            messageId: message.id,
            error: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
          });
        }
      }

      if (result.replayedCount > 0) {
        this.logger.info('Message replay complete', {
          replayed: result.replayedCount,
          found: result.foundCount,
          skippedDuplicate: result.skippedDuplicate,
          offlineSince: savedAt,
        });
      }

      return result;
    } catch (error) {
      this.logger.error('Failed to replay pending messages', {
        error: error instanceof Error ? error.message : String(error),
      });
      return result;
    }
  }

  /**
   * Read the `savedAt` timestamp from the persisted queue state file.
   * This is the proxy for "when the backend was last alive."
   *
   * @returns ISO timestamp string or null if no persisted state exists
   */
  async getLastPersistedTimestamp(): Promise<string | null> {
    const persistPath = path.join(this.crewlyHome, 'queue', 'message-queue.json');
    const data = await safeReadJson<{ savedAt?: string } | null>(persistPath, null);

    if (!data || typeof data.savedAt !== 'string') {
      return null;
    }

    return data.savedAt;
  }

  /**
   * Find user messages in a sorted message list that have no orchestrator/system
   * reply after them. A message is considered "replied" if any message from the
   * orchestrator or system appears after it in the conversation.
   *
   * @param messages - Sorted messages (oldest first) from a single conversation
   * @returns Array of user messages with no subsequent reply
   */
  findUnrepliedUserMessages(messages: ChatMessage[]): ChatMessage[] {
    if (messages.length === 0) return [];

    // Find the last orchestrator/system reply timestamp
    let lastReplyTimestamp = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.from.type === 'orchestrator' || msg.from.type === 'system') {
        lastReplyTimestamp = msg.timestamp;
        break;
      }
    }

    // Return user messages that came after the last orchestrator reply
    return messages.filter(
      (msg) =>
        msg.from.type === 'user' &&
        msg.timestamp > lastReplyTimestamp
    );
  }

  /**
   * Infer the message source from the chat message metadata or content.
   * Falls back to 'web_chat' if the source cannot be determined.
   *
   * @param message - The chat message to analyze
   * @returns The message source string for queue enqueuing
   */
  private inferMessageSource(message: ChatMessage): MessageSource {
    // Check metadata for source hint
    const metadata = message.metadata;
    if (metadata && typeof metadata === 'object') {
      if ('source' in metadata) {
        const src = (metadata as Record<string, unknown>).source;
        // Validate it's a known message source
        const validSources = Object.values(MESSAGE_SOURCES) as string[];
        if (typeof src === 'string' && validSources.includes(src)) {
          return src as MessageSource;
        }
      }
    }

    // Default to web_chat
    return MESSAGE_SOURCES.WEB_CHAT;
  }
}
