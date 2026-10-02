/**
 * Tests for MessageReplayService (#247)
 *
 * Verifies that pending user messages are correctly replayed after
 * orchestrator restarts. Chat history is read from the chat-v2 store
 * (`getChatV2Service()`), which is mocked here; channel/message DTOs are
 * converted to legacy shapes by the real `legacy-dto.utils` helpers.
 */

import { MessageReplayService } from './message-replay.service.js';
import type { MessageQueueService } from './message-queue.service.js';
import { ThreadStatusQueueService } from './thread-status-queue.service.js';
import type { ChatMessage } from '../../types/chat.types.js';
import type { ChatChannelDTO, ChatMessageDTO, ChatSenderType } from '../chat-v2/types.js';
import type { ThreadStatusEntry } from '../../types/thread-status.types.js';
import { MESSAGE_REPLAY_CONSTANTS } from '../../constants.js';

// jest.Mock safeReadJson
jest.mock('../../utils/file-io.utils.js', () => ({
  safeReadJson: jest.fn(),
}));

// jest.Mock LoggerService
jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
    }),
  },
}));

/** Mocked chat-v2 service surface used by MessageReplayService. */
const mockChatV2 = {
  listChannels: jest.fn(),
  countChannelMessages: jest.fn(),
  listMessages: jest.fn(),
};

// Mock the chat-v2 singleton so no SQLite store is opened
jest.mock('../chat-v2/chat-v2.singleton.js', () => ({
  getChatV2Service: () => mockChatV2,
}));

/**
 * Create a mock legacy ChatMessage for testing findUnrepliedUserMessages.
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
    ...overrides,
  } as ChatMessage;
}

/**
 * Create a mock chat-v2 message DTO, as returned by `ChatV2Service.listMessages`.
 *
 * @param senderType - chat-v2 sender type ('agent' maps to a legacy orchestrator reply)
 * @param content - Message body
 * @param msAgo - How many milliseconds before now the message was created
 * @param channelId - Channel (legacy conversation) ID
 * @param metadata - Optional message metadata
 * @returns A mock ChatMessageDTO
 */
function createV2Message(
  senderType: ChatSenderType,
  content: string,
  msAgo: number,
  channelId = 'conv-1',
  metadata?: Record<string, unknown>,
): ChatMessageDTO {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    channelId,
    seq: 0,
    senderType,
    senderId: senderType === 'user' ? 'Steve' : 'Crewly',
    content,
    contentType: 'text',
    createdAt: Date.now() - msAgo,
    attachments: [],
    mentions: [],
    metadata,
  };
}

/**
 * Create a mock chat-v2 channel DTO, as returned by `ChatV2Service.listChannels`.
 *
 * @param id - Channel ID (used as the legacy conversation ID)
 * @param archivedAt - Optional archive timestamp; archived channels are not scanned
 * @returns A mock ChatChannelDTO
 */
function createMockChannel(id: string, archivedAt: number | null = null): ChatChannelDTO {
  return {
    id,
    agentSession: 'crewly-orc',
    name: `Conversation ${id}`,
    createdAt: Date.now() - 600_000,
    archivedAt,
    agentPresence: { status: 'offline', lastSeenAt: null },
    type: 'dm',
  } as ChatChannelDTO;
}

/**
 * Configure `listMessages` to return the given messages for every channel.
 *
 * @param messages - Messages to return
 */
function mockMessages(messages: ChatMessageDTO[]): void {
  mockChatV2.listMessages.mockReturnValue({ messages, nextCursor: null, prevCursor: null, channelId: 'conv-1' });
}

describe('MessageReplayService', () => {
  let service: MessageReplayService;
  let mockQueue: {
    getPendingMessages: jest.Mock;
    enqueue: jest.Mock;
  };
  let mockThreadStatusQueue: {
    getByConversationId: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockQueue = {
      getPendingMessages: jest.fn().mockReturnValue([]),
      enqueue: jest.fn().mockReturnValue({ id: 'q-1' }),
    };

    mockChatV2.listChannels.mockReset().mockReturnValue([]);
    mockChatV2.countChannelMessages.mockReset().mockReturnValue(0);
    mockChatV2.listMessages.mockReset();
    mockMessages([]);

    mockThreadStatusQueue = {
      getByConversationId: jest.fn().mockReturnValue(null),
    };
    jest
      .spyOn(ThreadStatusQueueService, 'getInstance')
      .mockReturnValue(mockThreadStatusQueue as unknown as ThreadStatusQueueService);

    service = new MessageReplayService(
      mockQueue as unknown as MessageQueueService,
      '/tmp/test-crewly'
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('replayPendingMessages', () => {
    it('should skip replay when no persisted state exists', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      (safeReadJson as jest.Mock).mockResolvedValue(null);

      const result = await service.replayPendingMessages();

      expect(result.replayedCount).toBe(0);
      expect(result.foundCount).toBe(0);
      expect(mockChatV2.listChannels).not.toHaveBeenCalled();
    });

    it('should skip replay when offline duration is below minimum threshold', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      // Set savedAt to 5 seconds ago (below MIN_OFFLINE_DURATION_MS)
      (safeReadJson as jest.Mock).mockResolvedValue({
        savedAt: new Date(Date.now() - 5000).toISOString(),
      });

      const result = await service.replayPendingMessages();

      expect(result.replayedCount).toBe(0);
      expect(result.offlineDurationMs).toBeLessThan(MESSAGE_REPLAY_CONSTANTS.MIN_OFFLINE_DURATION_MS);
      expect(mockChatV2.listChannels).not.toHaveBeenCalled();
    });

    it('should find and replay unreplied user messages', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      const savedAt = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
      (safeReadJson as jest.Mock).mockResolvedValue({ savedAt });

      mockChatV2.listChannels.mockReturnValue([createMockChannel('conv-1')]);
      mockMessages([createV2Message('user', 'Hello, I need help', 60_000)]);

      const result = await service.replayPendingMessages();

      expect(result.foundCount).toBe(1);
      expect(result.replayedCount).toBe(1);
      expect(mockQueue.enqueue).toHaveBeenCalledWith({
        content: `${MESSAGE_REPLAY_CONSTANTS.REPLAY_PREFIX} Hello, I need help`,
        conversationId: 'conv-1',
        source: 'web_chat',
      });
      expect(mockChatV2.listMessages).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: 'conv-1', direction: 'forward' })
      );
    });

    it('should not replay messages that already have an orchestrator reply', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      const savedAt = new Date(Date.now() - 120_000).toISOString();
      (safeReadJson as jest.Mock).mockResolvedValue({ savedAt });

      mockChatV2.listChannels.mockReturnValue([createMockChannel('conv-1')]);
      mockMessages([
        createV2Message('user', 'First question', 90_000),
        createV2Message('agent', 'Answer to first question', 60_000),
      ]);

      const result = await service.replayPendingMessages();

      expect(result.foundCount).toBe(0);
      expect(result.replayedCount).toBe(0);
      expect(mockQueue.enqueue).not.toHaveBeenCalled();
    });

    it('should replay only messages after the last orchestrator reply', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      const savedAt = new Date(Date.now() - 300_000).toISOString();
      (safeReadJson as jest.Mock).mockResolvedValue({ savedAt });

      mockChatV2.listChannels.mockReturnValue([createMockChannel('conv-1')]);
      mockMessages([
        createV2Message('user', 'First question', 240_000),
        createV2Message('agent', 'Answer', 200_000),
        createV2Message('user', 'Follow-up question', 120_000),
        createV2Message('user', 'Another question', 60_000),
      ]);

      const result = await service.replayPendingMessages();

      expect(result.foundCount).toBe(2);
      expect(result.replayedCount).toBe(2);
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(2);
    });

    it('should skip messages already in the restored queue', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      const savedAt = new Date(Date.now() - 120_000).toISOString();
      (safeReadJson as jest.Mock).mockResolvedValue({ savedAt });

      mockChatV2.listChannels.mockReturnValue([createMockChannel('conv-1')]);
      mockMessages([createV2Message('user', 'Already queued message', 60_000)]);

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
      (safeReadJson as jest.Mock).mockResolvedValue({ savedAt });

      mockChatV2.listChannels.mockReturnValue([createMockChannel('conv-1')]);

      // Create more messages than MAX_REPLAY_COUNT
      mockMessages(
        Array.from({ length: MESSAGE_REPLAY_CONSTANTS.MAX_REPLAY_COUNT + 10 }, (_, i) =>
          createV2Message('user', `Message ${i}`, 60_000 - i * 100)
        )
      );

      const result = await service.replayPendingMessages();

      expect(result.foundCount).toBe(MESSAGE_REPLAY_CONSTANTS.MAX_REPLAY_COUNT + 10);
      expect(result.replayedCount).toBe(MESSAGE_REPLAY_CONSTANTS.MAX_REPLAY_COUNT);
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(MESSAGE_REPLAY_CONSTANTS.MAX_REPLAY_COUNT);
    });

    it('should scan multiple conversations', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      const savedAt = new Date(Date.now() - 120_000).toISOString();
      (safeReadJson as jest.Mock).mockResolvedValue({ savedAt });

      mockChatV2.listChannels.mockReturnValue([
        createMockChannel('conv-1'),
        createMockChannel('conv-2'),
      ]);

      mockChatV2.listMessages
        .mockReturnValueOnce({
          messages: [createV2Message('user', 'Message in conv-1', 60_000, 'conv-1')],
          nextCursor: null,
          prevCursor: null,
          channelId: 'conv-1',
        })
        .mockReturnValueOnce({
          messages: [createV2Message('user', 'Message in conv-2', 30_000, 'conv-2')],
          nextCursor: null,
          prevCursor: null,
          channelId: 'conv-2',
        });

      const result = await service.replayPendingMessages();

      expect(result.foundCount).toBe(2);
      expect(result.replayedCount).toBe(2);
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(2);
      expect(mockQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conv-1' }));
      expect(mockQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conv-2' }));
    });

    it('should not scan archived conversations', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      const savedAt = new Date(Date.now() - 120_000).toISOString();
      (safeReadJson as jest.Mock).mockResolvedValue({ savedAt });

      mockChatV2.listChannels.mockReturnValue([createMockChannel('conv-archived', Date.now() - 1000)]);
      mockMessages([createV2Message('user', 'Message in archived channel', 60_000, 'conv-archived')]);

      const result = await service.replayPendingMessages();

      expect(result.foundCount).toBe(0);
      expect(mockChatV2.listMessages).not.toHaveBeenCalled();
      expect(mockQueue.enqueue).not.toHaveBeenCalled();
    });

    it('should ignore messages created before the replay window start', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      const savedAt = new Date(Date.now() - 120_000).toISOString();
      (safeReadJson as jest.Mock).mockResolvedValue({ savedAt });

      mockChatV2.listChannels.mockReturnValue([createMockChannel('conv-1')]);
      mockMessages([
        // Sent before the backend went offline — the orchestrator already saw it
        createV2Message('user', 'Old message', 600_000),
        createV2Message('user', 'Missed message', 60_000),
      ]);

      const result = await service.replayPendingMessages();

      expect(result.foundCount).toBe(1);
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(mockQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ content: `${MESSAGE_REPLAY_CONSTANTS.REPLAY_PREFIX} Missed message` })
      );
    });

    it('should skip conversations whose thread is already in a terminal status', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      const savedAt = new Date(Date.now() - 120_000).toISOString();
      (safeReadJson as jest.Mock).mockResolvedValue({ savedAt });

      mockChatV2.listChannels.mockReturnValue([createMockChannel('conv-1')]);
      mockMessages([createV2Message('user', 'Already handled', 60_000)]);
      mockThreadStatusQueue.getByConversationId.mockReturnValue({
        conversationId: 'conv-1',
        threadKey: 'C123:1707430000.001234',
        status: 'replied_completed',
      } as ThreadStatusEntry);

      const result = await service.replayPendingMessages();

      expect(mockThreadStatusQueue.getByConversationId).toHaveBeenCalledWith('conv-1');
      expect(result.foundCount).toBe(1);
      expect(result.skippedDuplicate).toBe(1);
      expect(result.replayedCount).toBe(0);
      expect(mockQueue.enqueue).not.toHaveBeenCalled();
    });

    it('should infer source from message metadata', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      const savedAt = new Date(Date.now() - 120_000).toISOString();
      (safeReadJson as jest.Mock).mockResolvedValue({ savedAt });

      mockChatV2.listChannels.mockReturnValue([createMockChannel('conv-1')]);
      mockMessages([createV2Message('user', 'Slack message', 60_000, 'conv-1', { source: 'slack' })]);

      await service.replayPendingMessages();

      expect(mockQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'slack' })
      );
    });

    it('should handle enqueue errors gracefully', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      const savedAt = new Date(Date.now() - 120_000).toISOString();
      (safeReadJson as jest.Mock).mockResolvedValue({ savedAt });

      mockChatV2.listChannels.mockReturnValue([createMockChannel('conv-1')]);
      mockMessages([createV2Message('user', 'Message 1', 60_000)]);

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
      (safeReadJson as jest.Mock).mockResolvedValue({ savedAt });

      mockChatV2.listChannels.mockImplementation(() => {
        throw new Error('Storage error');
      });

      const result = await service.replayPendingMessages();

      // Should not crash, just return empty result
      expect(result.replayedCount).toBe(0);
    });

    it('should not replay system messages', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      const savedAt = new Date(Date.now() - 120_000).toISOString();
      (safeReadJson as jest.Mock).mockResolvedValue({ savedAt });

      mockChatV2.listChannels.mockReturnValue([createMockChannel('conv-1')]);
      mockMessages([createV2Message('system', 'System notification', 60_000)]);

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
      (safeReadJson as jest.Mock).mockResolvedValue({ savedAt });

      const result = await service.getLastPersistedTimestamp();
      expect(result).toBe(savedAt);
    });

    it('should return null when no persisted state exists', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      (safeReadJson as jest.Mock).mockResolvedValue(null);

      const result = await service.getLastPersistedTimestamp();
      expect(result).toBeNull();
    });

    it('should return null when savedAt is not a string', async () => {
      const { safeReadJson } = await import('../../utils/file-io.utils.js');
      (safeReadJson as jest.Mock).mockResolvedValue({ savedAt: 123 });

      const result = await service.getLastPersistedTimestamp();
      expect(result).toBeNull();
    });
  });
});
