/**
 * Tests for MessageReplayService (#247)
 *
 * Verifies that pending user messages are correctly replayed after
 * orchestrator restarts.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { MessageReplayService, type ReplayResult } from './message-replay.service.js';
import type { MessageQueueService } from './message-queue.service.js';
import type { ChatService } from '../chat/chat.service.js';
import type { ChatMessage, ChatConversation } from '../../types/chat.types.js';
import { MESSAGE_REPLAY_CONSTANTS } from '../../constants.js';

// Mock safeReadJson
vi.mock('../../utils/file-io.utils.js', () => ({
  safeReadJson: vi.fn(),
}));

// Mock LoggerService
vi.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    }),
  },
}));

/**
 * Create a mock ChatMessage for testing.
 *
 * @param overrides - Fields to override
 * @returns A mock ChatMessage
 */
function createMockMessage(overrides: Partial<ChatMessage> & { from: ChatMessage['from']; timestamp: string }): ChatMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    conversationId: 'conv-1',
    content: 'Test message',
    contentType: 'text',
    status: 'sent',
    timestamp: overrides.timestamp,
    from: overrides.from,
    ...overrides,
  } as ChatMessage;
}

/**
 * Create a mock ChatConversation for testing.
 *
 * @param id - Conversation ID
 * @returns A mock ChatConversation
 */
function createMockConversation(id: string): ChatConversation {
  return {
    id,
    title: `Conversation ${id}`,
    participantIds: ['user-1'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: 0,
    isArchived: false,
  } as ChatConversation;
}

describe('MessageReplayService', () => {
  let service: MessageReplayService;
  let mockQueue: {
    getPendingMessages: Mock;
    enqueue: Mock;
  };
  let mockChatService: {
    getConversations: Mock;
    getMessages: Mock;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockQueue = {
      getPendingMessages: vi.fn().mockReturnValue([]),
      enqueue: vi.fn().mockReturnValue({ id: 'q-1' }),
    };

    mockChatService = {
      getConversations: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue([]),
    };

    service = new MessageReplayService(
      mockQueue as unknown as MessageQueueService,
      mockChatService as unknown as ChatService,
      '/tmp/test-crewly'
    );
  });

  describe('replayPendingMessages', () => {
    it('should skip replay when no persisted state exists', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      (safeReadJson as Mock).mockResolvedValue(null);

      const result = await service.replayPendingMessages();

      expect(result.replayedCount).toBe(0);
      expect(result.foundCount).toBe(0);
      expect(mockChatService.getConversations).not.toHaveBeenCalled();
    });

    it('should skip replay when offline duration is below minimum threshold', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      // Set savedAt to 5 seconds ago (below MIN_OFFLINE_DURATION_MS)
      (safeReadJson as Mock).mockResolvedValue({
        savedAt: new Date(Date.now() - 5000).toISOString(),
      });

      const result = await service.replayPendingMessages();

      expect(result.replayedCount).toBe(0);
      expect(result.offlineDurationMs).toBeLessThan(MESSAGE_REPLAY_CONSTANTS.MIN_OFFLINE_DURATION_MS);
      expect(mockChatService.getConversations).not.toHaveBeenCalled();
    });

    it('should find and replay unreplied user messages', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      const savedAt = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
      (safeReadJson as Mock).mockResolvedValue({ savedAt });

      const conversation = createMockConversation('conv-1');
      mockChatService.getConversations.mockResolvedValue([conversation]);

      const userMessage = createMockMessage({
        from: { type: 'user', name: 'Steve' },
        content: 'Hello, I need help',
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        conversationId: 'conv-1',
      });
      mockChatService.getMessages.mockResolvedValue([userMessage]);

      const result = await service.replayPendingMessages();

      expect(result.foundCount).toBe(1);
      expect(result.replayedCount).toBe(1);
      expect(mockQueue.enqueue).toHaveBeenCalledWith({
        content: `${MESSAGE_REPLAY_CONSTANTS.REPLAY_PREFIX} Hello, I need help`,
        conversationId: 'conv-1',
        source: 'web_chat',
      });
    });

    it('should not replay messages that already have an orchestrator reply', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      const savedAt = new Date(Date.now() - 120_000).toISOString();
      (safeReadJson as Mock).mockResolvedValue({ savedAt });

      mockChatService.getConversations.mockResolvedValue([createMockConversation('conv-1')]);

      const t1 = new Date(Date.now() - 90_000).toISOString();
      const t2 = new Date(Date.now() - 60_000).toISOString();
      mockChatService.getMessages.mockResolvedValue([
        createMockMessage({
          from: { type: 'user', name: 'Steve' },
          content: 'First question',
          timestamp: t1,
          conversationId: 'conv-1',
        }),
        createMockMessage({
          from: { type: 'orchestrator', name: 'Crewly' },
          content: 'Answer to first question',
          timestamp: t2,
          conversationId: 'conv-1',
        }),
      ]);

      const result = await service.replayPendingMessages();

      expect(result.foundCount).toBe(0);
      expect(result.replayedCount).toBe(0);
      expect(mockQueue.enqueue).not.toHaveBeenCalled();
    });

    it('should replay only messages after the last orchestrator reply', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      const savedAt = new Date(Date.now() - 300_000).toISOString();
      (safeReadJson as Mock).mockResolvedValue({ savedAt });

      mockChatService.getConversations.mockResolvedValue([createMockConversation('conv-1')]);

      const t1 = new Date(Date.now() - 240_000).toISOString();
      const t2 = new Date(Date.now() - 200_000).toISOString();
      const t3 = new Date(Date.now() - 120_000).toISOString();
      const t4 = new Date(Date.now() - 60_000).toISOString();
      mockChatService.getMessages.mockResolvedValue([
        createMockMessage({
          from: { type: 'user', name: 'Steve' },
          content: 'First question',
          timestamp: t1,
          conversationId: 'conv-1',
        }),
        createMockMessage({
          from: { type: 'orchestrator', name: 'Crewly' },
          content: 'Answer',
          timestamp: t2,
          conversationId: 'conv-1',
        }),
        createMockMessage({
          from: { type: 'user', name: 'Steve' },
          content: 'Follow-up question',
          timestamp: t3,
          conversationId: 'conv-1',
        }),
        createMockMessage({
          from: { type: 'user', name: 'Steve' },
          content: 'Another question',
          timestamp: t4,
          conversationId: 'conv-1',
        }),
      ]);

      const result = await service.replayPendingMessages();

      expect(result.foundCount).toBe(2);
      expect(result.replayedCount).toBe(2);
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(2);
    });

    it('should skip messages already in the restored queue', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      const savedAt = new Date(Date.now() - 120_000).toISOString();
      (safeReadJson as Mock).mockResolvedValue({ savedAt });

      mockChatService.getConversations.mockResolvedValue([createMockConversation('conv-1')]);

      const userMessage = createMockMessage({
        from: { type: 'user', name: 'Steve' },
        content: 'Already queued message',
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        conversationId: 'conv-1',
      });
      mockChatService.getMessages.mockResolvedValue([userMessage]);

      // Simulate this message already being in the restored queue
      mockQueue.getPendingMessages.mockReturnValue([
        { conversationId: 'conv-1', content: 'Already queued message' },
      ]);

      const result = await service.replayPendingMessages();

      expect(result.foundCount).toBe(1);
      expect(result.skippedDuplicate).toBe(1);
      expect(result.replayedCount).toBe(0);
      expect(mockQueue.enqueue).not.toHaveBeenCalled();
    });

    it('should respect MAX_REPLAY_COUNT limit', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      const savedAt = new Date(Date.now() - 120_000).toISOString();
      (safeReadJson as Mock).mockResolvedValue({ savedAt });

      mockChatService.getConversations.mockResolvedValue([createMockConversation('conv-1')]);

      // Create more messages than MAX_REPLAY_COUNT
      const messages = Array.from({ length: MESSAGE_REPLAY_CONSTANTS.MAX_REPLAY_COUNT + 10 }, (_, i) =>
        createMockMessage({
          from: { type: 'user', name: 'Steve' },
          content: `Message ${i}`,
          timestamp: new Date(Date.now() - (60_000 - i * 100)).toISOString(),
          conversationId: 'conv-1',
        })
      );
      mockChatService.getMessages.mockResolvedValue(messages);

      const result = await service.replayPendingMessages();

      expect(result.foundCount).toBe(MESSAGE_REPLAY_CONSTANTS.MAX_REPLAY_COUNT + 10);
      expect(result.replayedCount).toBe(MESSAGE_REPLAY_CONSTANTS.MAX_REPLAY_COUNT);
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(MESSAGE_REPLAY_CONSTANTS.MAX_REPLAY_COUNT);
    });

    it('should scan multiple conversations', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      const savedAt = new Date(Date.now() - 120_000).toISOString();
      (safeReadJson as Mock).mockResolvedValue({ savedAt });

      mockChatService.getConversations.mockResolvedValue([
        createMockConversation('conv-1'),
        createMockConversation('conv-2'),
      ]);

      mockChatService.getMessages
        .mockResolvedValueOnce([
          createMockMessage({
            from: { type: 'user', name: 'Steve' },
            content: 'Message in conv-1',
            timestamp: new Date(Date.now() - 60_000).toISOString(),
            conversationId: 'conv-1',
          }),
        ])
        .mockResolvedValueOnce([
          createMockMessage({
            from: { type: 'user', name: 'Steve' },
            content: 'Message in conv-2',
            timestamp: new Date(Date.now() - 30_000).toISOString(),
            conversationId: 'conv-2',
          }),
        ]);

      const result = await service.replayPendingMessages();

      expect(result.foundCount).toBe(2);
      expect(result.replayedCount).toBe(2);
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(2);
    });

    it('should infer source from message metadata', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      const savedAt = new Date(Date.now() - 120_000).toISOString();
      (safeReadJson as Mock).mockResolvedValue({ savedAt });

      mockChatService.getConversations.mockResolvedValue([createMockConversation('conv-1')]);

      const slackMessage = createMockMessage({
        from: { type: 'user', name: 'Steve' },
        content: 'Slack message',
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        conversationId: 'conv-1',
        metadata: { source: 'slack' },
      });
      mockChatService.getMessages.mockResolvedValue([slackMessage]);

      await service.replayPendingMessages();

      expect(mockQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'slack' })
      );
    });

    it('should handle enqueue errors gracefully', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      const savedAt = new Date(Date.now() - 120_000).toISOString();
      (safeReadJson as Mock).mockResolvedValue({ savedAt });

      mockChatService.getConversations.mockResolvedValue([createMockConversation('conv-1')]);
      mockChatService.getMessages.mockResolvedValue([
        createMockMessage({
          from: { type: 'user', name: 'Steve' },
          content: 'Message 1',
          timestamp: new Date(Date.now() - 60_000).toISOString(),
          conversationId: 'conv-1',
        }),
      ]);

      mockQueue.enqueue.mockImplementation(() => {
        throw new Error('Queue full');
      });

      const result = await service.replayPendingMessages();

      // Should not crash, just skip the failed message
      expect(result.foundCount).toBe(1);
      expect(result.replayedCount).toBe(0);
    });

    it('should handle chat service errors gracefully', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      const savedAt = new Date(Date.now() - 120_000).toISOString();
      (safeReadJson as Mock).mockResolvedValue({ savedAt });

      mockChatService.getConversations.mockRejectedValue(new Error('Storage error'));

      const result = await service.replayPendingMessages();

      // Should not crash, just return empty result
      expect(result.replayedCount).toBe(0);
    });

    it('should not replay system messages', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      const savedAt = new Date(Date.now() - 120_000).toISOString();
      (safeReadJson as Mock).mockResolvedValue({ savedAt });

      mockChatService.getConversations.mockResolvedValue([createMockConversation('conv-1')]);
      mockChatService.getMessages.mockResolvedValue([
        createMockMessage({
          from: { type: 'system', name: 'System' },
          content: 'System notification',
          timestamp: new Date(Date.now() - 60_000).toISOString(),
          conversationId: 'conv-1',
        }),
      ]);

      const result = await service.replayPendingMessages();

      expect(result.foundCount).toBe(0);
      expect(result.replayedCount).toBe(0);
    });
  });

  describe('findUnrepliedUserMessages', () => {
    it('should return empty array for empty messages', () => {
      const result = service.findUnrepliedUserMessages([]);
      expect(result).toEqual([]);
    });

    it('should return all user messages when no orchestrator reply exists', () => {
      const messages: ChatMessage[] = [
        createMockMessage({
          from: { type: 'user', name: 'Steve' },
          content: 'Hello',
          timestamp: '2026-01-01T00:00:00Z',
        }),
        createMockMessage({
          from: { type: 'user', name: 'Steve' },
          content: 'Anyone there?',
          timestamp: '2026-01-01T00:01:00Z',
        }),
      ];

      const result = service.findUnrepliedUserMessages(messages);
      expect(result).toHaveLength(2);
    });

    it('should return only user messages after the last orchestrator reply', () => {
      const messages: ChatMessage[] = [
        createMockMessage({
          from: { type: 'user', name: 'Steve' },
          content: 'Q1',
          timestamp: '2026-01-01T00:00:00Z',
        }),
        createMockMessage({
          from: { type: 'orchestrator', name: 'Crewly' },
          content: 'A1',
          timestamp: '2026-01-01T00:01:00Z',
        }),
        createMockMessage({
          from: { type: 'user', name: 'Steve' },
          content: 'Q2 (unreplied)',
          timestamp: '2026-01-01T00:02:00Z',
        }),
      ];

      const result = service.findUnrepliedUserMessages(messages);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('Q2 (unreplied)');
    });

    it('should return empty when last message is from orchestrator', () => {
      const messages: ChatMessage[] = [
        createMockMessage({
          from: { type: 'user', name: 'Steve' },
          content: 'Q1',
          timestamp: '2026-01-01T00:00:00Z',
        }),
        createMockMessage({
          from: { type: 'orchestrator', name: 'Crewly' },
          content: 'A1',
          timestamp: '2026-01-01T00:01:00Z',
        }),
      ];

      const result = service.findUnrepliedUserMessages(messages);
      expect(result).toHaveLength(0);
    });

    it('should treat system messages as replies', () => {
      const messages: ChatMessage[] = [
        createMockMessage({
          from: { type: 'user', name: 'Steve' },
          content: 'Q1',
          timestamp: '2026-01-01T00:00:00Z',
        }),
        createMockMessage({
          from: { type: 'system', name: 'System' },
          content: 'Orchestrator is processing...',
          timestamp: '2026-01-01T00:01:00Z',
        }),
      ];

      const result = service.findUnrepliedUserMessages(messages);
      expect(result).toHaveLength(0);
    });
  });

  describe('getLastPersistedTimestamp', () => {
    it('should return savedAt from persisted state', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      const savedAt = '2026-03-21T12:00:00.000Z';
      (safeReadJson as Mock).mockResolvedValue({ savedAt });

      const result = await service.getLastPersistedTimestamp();
      expect(result).toBe(savedAt);
    });

    it('should return null when no persisted state exists', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      (safeReadJson as Mock).mockResolvedValue(null);

      const result = await service.getLastPersistedTimestamp();
      expect(result).toBeNull();
    });

    it('should return null when savedAt is not a string', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      (safeReadJson as Mock).mockResolvedValue({ savedAt: 123 });

      const result = await service.getLastPersistedTimestamp();
      expect(result).toBeNull();
    });
  });
});
