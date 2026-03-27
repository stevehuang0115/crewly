/**
 * Chat Highlights Service Tests
 *
 * Tests for the ChatHighlightsService including keyword detection,
 * filtering by timestamp, limiting results, type identification,
 * and sort ordering.
 *
 * @module services/chat/chat-highlights.service.test
 */

// Mock node-pty before any imports
jest.mock('node-pty', () => ({ spawn: jest.fn() }));

jest.mock('../../services/chat/chat.service.js', () => ({
  getChatService: () => mockChatService,
}));

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

import {
  ChatHighlightsService,
  getChatHighlightsService,
  resetChatHighlightsService,
} from './chat-highlights.service.js';

// =============================================================================
// Mocks
// =============================================================================

const mockChatService = {
  getConversations: jest.fn(),
  getMessages: jest.fn(),
};

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Create a minimal mock conversation for testing
 *
 * @param id - Conversation ID
 * @returns Mock conversation object
 */
function createMockConversation(id: string) {
  return {
    id,
    title: `Conversation ${id}`,
    createdAt: '2026-03-25T00:00:00.000Z',
    updatedAt: '2026-03-25T12:00:00.000Z',
    messageCount: 0,
    participantIds: [],
    isArchived: false,
    channelType: 'crewly_chat',
  };
}

/**
 * Create a minimal mock message for testing
 *
 * @param overrides - Fields to override on the default message
 * @returns Mock message object
 */
function createMockMessage(overrides: { id: string; content: string; timestamp: string; conversationId?: string; from?: { type: string; name?: string } }) {
  return {
    conversationId: 'conv-1',
    from: { type: 'orchestrator', name: 'Orchestrator' },
    contentType: 'text',
    status: 'delivered',
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('ChatHighlightsService', () => {
  let service: ChatHighlightsService;

  beforeEach(() => {
    resetChatHighlightsService();
    service = new ChatHighlightsService();
    mockChatService.getConversations.mockReset();
    mockChatService.getMessages.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Empty state
  // ---------------------------------------------------------------------------

  it('returns empty array when no conversations exist', async () => {
    mockChatService.getConversations.mockResolvedValue([]);

    const highlights = await service.getHighlights();

    expect(highlights).toEqual([]);
    expect(mockChatService.getConversations).toHaveBeenCalledTimes(1);
  });

  it('returns empty array when conversations have no matching messages', async () => {
    mockChatService.getConversations.mockResolvedValue([createMockConversation('conv-1')]);
    mockChatService.getMessages.mockResolvedValue([
      createMockMessage({
        id: 'msg-1',
        content: 'Hello, just a normal message',
        timestamp: '2026-03-25T10:00:00.000Z',
      }),
    ]);

    const highlights = await service.getHighlights();

    expect(highlights).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Keyword filtering
  // ---------------------------------------------------------------------------

  it('filters messages by keyword patterns', async () => {
    mockChatService.getConversations.mockResolvedValue([createMockConversation('conv-1')]);
    mockChatService.getMessages.mockResolvedValue([
      createMockMessage({
        id: 'msg-1',
        content: '[DECISION] Use PostgreSQL for the data layer',
        timestamp: '2026-03-25T10:00:00.000Z',
      }),
      createMockMessage({
        id: 'msg-2',
        content: 'Just a regular update message',
        timestamp: '2026-03-25T10:01:00.000Z',
      }),
      createMockMessage({
        id: 'msg-3',
        content: '[QUESTION] Should we add caching?',
        timestamp: '2026-03-25T10:02:00.000Z',
      }),
    ]);

    const highlights = await service.getHighlights();

    expect(highlights).toHaveLength(2);
    expect(highlights.map((h) => h.id)).toContain('msg-1');
    expect(highlights.map((h) => h.id)).toContain('msg-3');
    expect(highlights.map((h) => h.id)).not.toContain('msg-2');
  });

  // ---------------------------------------------------------------------------
  // Since parameter
  // ---------------------------------------------------------------------------

  it('respects since parameter by passing it as after filter', async () => {
    const sinceDate = '2026-03-25T08:00:00.000Z';
    mockChatService.getConversations.mockResolvedValue([createMockConversation('conv-1')]);
    mockChatService.getMessages.mockResolvedValue([]);

    await service.getHighlights({ since: sinceDate });

    expect(mockChatService.getMessages).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      after: sinceDate,
    });
  });

  it('does not pass after filter when since is not provided', async () => {
    mockChatService.getConversations.mockResolvedValue([createMockConversation('conv-1')]);
    mockChatService.getMessages.mockResolvedValue([]);

    await service.getHighlights();

    expect(mockChatService.getMessages).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      after: undefined,
    });
  });

  // ---------------------------------------------------------------------------
  // Limit parameter
  // ---------------------------------------------------------------------------

  it('respects limit parameter', async () => {
    mockChatService.getConversations.mockResolvedValue([createMockConversation('conv-1')]);
    mockChatService.getMessages.mockResolvedValue([
      createMockMessage({
        id: 'msg-1',
        content: '[DECISION] First decision',
        timestamp: '2026-03-25T10:00:00.000Z',
      }),
      createMockMessage({
        id: 'msg-2',
        content: '[DECISION] Second decision',
        timestamp: '2026-03-25T10:01:00.000Z',
      }),
      createMockMessage({
        id: 'msg-3',
        content: '[DECISION] Third decision',
        timestamp: '2026-03-25T10:02:00.000Z',
      }),
    ]);

    const highlights = await service.getHighlights({ limit: 2 });

    expect(highlights).toHaveLength(2);
  });

  it('uses default limit of 20 when not specified', async () => {
    mockChatService.getConversations.mockResolvedValue([createMockConversation('conv-1')]);

    const messages = Array.from({ length: 25 }, (_, i) =>
      createMockMessage({
        id: `msg-${i}`,
        content: `[DECISION] Decision number ${i}`,
        timestamp: new Date(Date.UTC(2026, 2, 25, 10, i)).toISOString(),
      })
    );
    mockChatService.getMessages.mockResolvedValue(messages);

    const highlights = await service.getHighlights();

    expect(highlights).toHaveLength(20);
  });

  // ---------------------------------------------------------------------------
  // Type identification
  // ---------------------------------------------------------------------------

  it('correctly identifies decision highlights', async () => {
    mockChatService.getConversations.mockResolvedValue([createMockConversation('conv-1')]);
    mockChatService.getMessages.mockResolvedValue([
      createMockMessage({
        id: 'msg-1',
        content: '[DECISION] Migrate to microservices',
        timestamp: '2026-03-25T10:00:00.000Z',
      }),
    ]);

    const highlights = await service.getHighlights();

    expect(highlights[0].type).toBe('decision');
  });

  it('correctly identifies question highlights', async () => {
    mockChatService.getConversations.mockResolvedValue([createMockConversation('conv-1')]);
    mockChatService.getMessages.mockResolvedValue([
      createMockMessage({
        id: 'msg-1',
        content: '[QUESTION] What is the deployment timeline?',
        timestamp: '2026-03-25T10:00:00.000Z',
      }),
    ]);

    const highlights = await service.getHighlights();

    expect(highlights[0].type).toBe('question');
  });

  it('correctly identifies tl_report highlights', async () => {
    mockChatService.getConversations.mockResolvedValue([createMockConversation('conv-1')]);
    mockChatService.getMessages.mockResolvedValue([
      createMockMessage({
        id: 'msg-1',
        content: '[TL_REPORT] Sprint 3 progress: 80% complete',
        timestamp: '2026-03-25T10:00:00.000Z',
      }),
    ]);

    const highlights = await service.getHighlights();

    expect(highlights[0].type).toBe('tl_report');
  });

  it('correctly identifies blocker highlights from [BLOCKER] tag', async () => {
    mockChatService.getConversations.mockResolvedValue([createMockConversation('conv-1')]);
    mockChatService.getMessages.mockResolvedValue([
      createMockMessage({
        id: 'msg-1',
        content: '[BLOCKER] Waiting for API credentials',
        timestamp: '2026-03-25T10:00:00.000Z',
      }),
    ]);

    const highlights = await service.getHighlights();

    expect(highlights[0].type).toBe('blocker');
  });

  it('correctly identifies blocker highlights from "blocked on" phrase', async () => {
    mockChatService.getConversations.mockResolvedValue([createMockConversation('conv-1')]);
    mockChatService.getMessages.mockResolvedValue([
      createMockMessage({
        id: 'msg-1',
        content: 'We are blocked on the database migration',
        timestamp: '2026-03-25T10:00:00.000Z',
      }),
    ]);

    const highlights = await service.getHighlights();

    expect(highlights[0].type).toBe('blocker');
  });

  it('correctly identifies task_completion highlights from "task completed"', async () => {
    mockChatService.getConversations.mockResolvedValue([createMockConversation('conv-1')]);
    mockChatService.getMessages.mockResolvedValue([
      createMockMessage({
        id: 'msg-1',
        content: 'The API endpoint task completed successfully',
        timestamp: '2026-03-25T10:00:00.000Z',
      }),
    ]);

    const highlights = await service.getHighlights();

    expect(highlights[0].type).toBe('task_completion');
  });

  it('correctly identifies task_completion highlights from "task done"', async () => {
    mockChatService.getConversations.mockResolvedValue([createMockConversation('conv-1')]);
    mockChatService.getMessages.mockResolvedValue([
      createMockMessage({
        id: 'msg-1',
        content: 'Database migration task done',
        timestamp: '2026-03-25T10:00:00.000Z',
      }),
    ]);

    const highlights = await service.getHighlights();

    expect(highlights[0].type).toBe('task_completion');
  });

  // ---------------------------------------------------------------------------
  // Sorting
  // ---------------------------------------------------------------------------

  it('sorts by timestamp descending (most recent first)', async () => {
    mockChatService.getConversations.mockResolvedValue([createMockConversation('conv-1')]);
    mockChatService.getMessages.mockResolvedValue([
      createMockMessage({
        id: 'msg-old',
        content: '[DECISION] Old decision',
        timestamp: '2026-03-25T08:00:00.000Z',
      }),
      createMockMessage({
        id: 'msg-new',
        content: '[DECISION] New decision',
        timestamp: '2026-03-25T12:00:00.000Z',
      }),
      createMockMessage({
        id: 'msg-mid',
        content: '[QUESTION] Middle question',
        timestamp: '2026-03-25T10:00:00.000Z',
      }),
    ]);

    const highlights = await service.getHighlights();

    expect(highlights[0].id).toBe('msg-new');
    expect(highlights[1].id).toBe('msg-mid');
    expect(highlights[2].id).toBe('msg-old');
  });

  // ---------------------------------------------------------------------------
  // Multi-conversation
  // ---------------------------------------------------------------------------

  it('aggregates highlights across multiple conversations', async () => {
    mockChatService.getConversations.mockResolvedValue([
      createMockConversation('conv-1'),
      createMockConversation('conv-2'),
    ]);
    mockChatService.getMessages
      .mockResolvedValueOnce([
        createMockMessage({
          id: 'msg-1',
          conversationId: 'conv-1',
          content: '[DECISION] From conv 1',
          timestamp: '2026-03-25T10:00:00.000Z',
        }),
      ])
      .mockResolvedValueOnce([
        createMockMessage({
          id: 'msg-2',
          conversationId: 'conv-2',
          content: '[QUESTION] From conv 2',
          timestamp: '2026-03-25T11:00:00.000Z',
        }),
      ]);

    const highlights = await service.getHighlights();

    expect(highlights).toHaveLength(2);
    expect(highlights[0].threadId).toBe('conv-2');
    expect(highlights[1].threadId).toBe('conv-1');
  });

  // ---------------------------------------------------------------------------
  // Author extraction
  // ---------------------------------------------------------------------------

  it('uses sender name as author when available', async () => {
    mockChatService.getConversations.mockResolvedValue([createMockConversation('conv-1')]);
    mockChatService.getMessages.mockResolvedValue([
      createMockMessage({
        id: 'msg-1',
        content: '[DECISION] Use Redis',
        timestamp: '2026-03-25T10:00:00.000Z',
        from: { type: 'agent', name: 'Sam' },
      }),
    ]);

    const highlights = await service.getHighlights();

    expect(highlights[0].author).toBe('Sam');
  });

  it('falls back to sender type when name is not available', async () => {
    mockChatService.getConversations.mockResolvedValue([createMockConversation('conv-1')]);
    mockChatService.getMessages.mockResolvedValue([
      createMockMessage({
        id: 'msg-1',
        content: '[DECISION] Use Redis',
        timestamp: '2026-03-25T10:00:00.000Z',
        from: { type: 'system' },
      }),
    ]);

    const highlights = await service.getHighlights();

    expect(highlights[0].author).toBe('system');
  });

  // ---------------------------------------------------------------------------
  // Singleton
  // ---------------------------------------------------------------------------

  it('getChatHighlightsService returns a singleton', () => {
    resetChatHighlightsService();
    const instance1 = getChatHighlightsService();
    const instance2 = getChatHighlightsService();
    expect(instance1).toBe(instance2);
  });

  it('resetChatHighlightsService clears the singleton', () => {
    const instance1 = getChatHighlightsService();
    resetChatHighlightsService();
    const instance2 = getChatHighlightsService();
    expect(instance1).not.toBe(instance2);
  });
});
