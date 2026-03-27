/**
 * Chat Highlights Service
 *
 * Extracts important messages from chat conversations by scanning for
 * keyword markers such as [DECISION], [QUESTION], [TL_REPORT], [BLOCKER],
 * and task completion phrases. Provides a quick summary view of key
 * conversation events.
 *
 * @module services/chat/chat-highlights.service
 */

import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { getChatService } from '../../services/chat/chat.service.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Type of highlight extracted from a chat message
 */
export type ChatHighlightType =
  | 'decision'
  | 'question'
  | 'task_completion'
  | 'tl_report'
  | 'blocker';

/**
 * A highlighted chat message representing a key conversation event
 */
export interface ChatHighlight {
  /** Unique identifier for the highlight */
  id: string;

  /** ISO timestamp of the original message */
  timestamp: string;

  /** Category of the highlight */
  type: ChatHighlightType;

  /** Summary content extracted from the message */
  summary: string;

  /** Name of the message author */
  author: string;

  /** ID of the conversation thread */
  threadId: string;
}

/**
 * Options for retrieving highlights
 */
export interface GetHighlightsOptions {
  /** ISO timestamp to filter highlights after this time */
  since?: string;

  /** Maximum number of highlights to return (default: 20) */
  limit?: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Default maximum number of highlights returned */
const DEFAULT_HIGHLIGHTS_LIMIT = 20;

/**
 * Keyword patterns used to identify highlight-worthy messages.
 * Each entry maps a regex pattern to the corresponding highlight type.
 */
const HIGHLIGHT_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  type: ChatHighlightType;
}> = [
  { pattern: /\[DECISION\]/i, type: 'decision' },
  { pattern: /\[QUESTION\]/i, type: 'question' },
  { pattern: /\[TL_REPORT\]/i, type: 'tl_report' },
  { pattern: /\[BLOCKER\]/i, type: 'blocker' },
  { pattern: /blocked on/i, type: 'blocker' },
  { pattern: /task completed/i, type: 'task_completion' },
  { pattern: /task done/i, type: 'task_completion' },
];

// =============================================================================
// Service
// =============================================================================

/**
 * Service for extracting important highlights from chat conversations.
 *
 * Scans all active conversations for messages containing specific keyword
 * markers and returns them as a sorted list of highlights, enabling users
 * to quickly review key decisions, questions, blockers, and completions.
 *
 * @example
 * ```typescript
 * const service = getChatHighlightsService();
 * const highlights = await service.getHighlights({ limit: 10 });
 * console.log(highlights); // [{ id, timestamp, type, summary, author, threadId }]
 * ```
 */
export class ChatHighlightsService {
  private readonly logger: ComponentLogger;

  /**
   * Create a new ChatHighlightsService instance
   */
  constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('ChatHighlightsService');
  }

  /**
   * Retrieve highlights from all chat conversations.
   *
   * Iterates over all active conversations, fetches messages (optionally
   * filtered by a `since` timestamp), and identifies messages containing
   * highlight keywords. Results are sorted by timestamp descending (most
   * recent first) and limited to the specified count.
   *
   * @param options - Filtering and pagination options
   * @returns Array of chat highlights sorted by timestamp descending
   *
   * @example
   * ```typescript
   * const highlights = await service.getHighlights({
   *   since: '2026-03-25T00:00:00.000Z',
   *   limit: 5,
   * });
   * ```
   */
  async getHighlights(options: GetHighlightsOptions = {}): Promise<ChatHighlight[]> {
    const { since, limit = DEFAULT_HIGHLIGHTS_LIMIT } = options;

    const chatService = getChatService();
    const conversations = await chatService.getConversations();

    const highlights: ChatHighlight[] = [];

    for (const conversation of conversations) {
      const messages = await chatService.getMessages({
        conversationId: conversation.id,
        after: since,
      });

      for (const message of messages) {
        const matchedType = this.detectHighlightType(message.content);
        if (matchedType) {
          highlights.push({
            id: message.id,
            timestamp: message.timestamp,
            type: matchedType,
            summary: message.content,
            author: message.from.name ?? message.from.type,
            threadId: conversation.id,
          });
        }
      }
    }

    // Sort by timestamp descending (most recent first)
    highlights.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    this.logger.debug('Extracted highlights', {
      total: highlights.length,
      returned: Math.min(highlights.length, limit),
      since: since ?? 'all',
    });

    return highlights.slice(0, limit);
  }

  /**
   * Detect the highlight type from message content by matching against
   * known keyword patterns.
   *
   * @param content - Message content to scan
   * @returns The matched highlight type, or null if no pattern matches
   */
  private detectHighlightType(content: string): ChatHighlightType | null {
    for (const { pattern, type } of HIGHLIGHT_PATTERNS) {
      if (pattern.test(content)) {
        return type;
      }
    }
    return null;
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let chatHighlightsServiceInstance: ChatHighlightsService | null = null;

/**
 * Get the singleton ChatHighlightsService instance
 *
 * @returns The ChatHighlightsService instance
 */
export function getChatHighlightsService(): ChatHighlightsService {
  if (!chatHighlightsServiceInstance) {
    chatHighlightsServiceInstance = new ChatHighlightsService();
  }
  return chatHighlightsServiceInstance;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetChatHighlightsService(): void {
  chatHighlightsServiceInstance = null;
}
