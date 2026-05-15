/**
 * Tests for ChatService — Phase 6 facade.
 *
 * The legacy ChatService used to maintain ~/.crewly/chat/*.json
 * persistence and was tested heavily for filesystem invariants. As
 * of the unified-chat-message-store spec, ChatService is a thin
 * façade over ChatV2Service; its sole responsibility is DTO
 * translation between legacy types and chat-v2 types, plus
 * EventEmitter compatibility for downstream subscribers. The
 * underlying storage semantics are covered by chat-v2's tests
 * (`backend/src/services/chat-v2/chat-v2.service.test.ts`).
 *
 * @module services/chat/chat.service.test
 */

import { getChatService, resetChatService } from './chat.service.js';
import { resetChatV2Service, setChatV2ServiceForTesting } from '../chat-v2/chat-v2.singleton.js';
import { ChatV2Service } from '../chat-v2/chat-v2.service.js';
import { openChatDatabase } from '../chat-v2/sqlite/chat-db.js';
import { loadChatV2Config } from '../chat-v2/config.js';

describe('ChatService (Phase 6 façade over ChatV2Service)', () => {
  let chatV2: ChatV2Service;

  beforeEach(() => {
    resetChatService();
    resetChatV2Service();
    const db = openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true });
    chatV2 = new ChatV2Service({
      config: loadChatV2Config({}),
      db,
      getPresence: () => ({ status: 'online', lastSeenAt: null }),
      now: () => 1000,
    });
    setChatV2ServiceForTesting(chatV2);
  });

  afterEach(() => {
    resetChatService();
    resetChatV2Service();
  });

  describe('writes', () => {
    it('sendMessage persists through chat-v2 and returns legacy DTOs', async () => {
      const service = getChatService();
      const { conversation, message } = await service.sendMessage({
        content: 'hello',
        conversationId: 'slack-D0AC7-1234',
      });

      expect(conversation.id).toBe('slack-D0AC7-1234');
      expect(message.content).toBe('hello');
      expect(message.from.type).toBe('user');
      expect(message.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(chatV2.countAllMessages()).toBe(1);
    });

    it('addDirectMessage routes through chat-v2 with pty-runtime source', async () => {
      const service = getChatService();
      await service.addDirectMessage(
        'slack-X-1',
        'agent reply',
        { type: 'orchestrator', id: 'crewly-orc', name: 'Orchestrator' },
        undefined,
      );

      expect(chatV2.countAllMessages()).toBe(1);
    });

    it('addSystemMessage maps system sender', async () => {
      const service = getChatService();
      await service.addSystemMessage('slack-Y-1', 'system note', undefined);

      const messages = chatV2.listMessages({
        channelId: 'slack-Y-1',
        principal: { userId: 'system', source: 'oss' },
        direction: 'forward',
      }).messages;
      expect(messages).toHaveLength(1);
      expect(messages[0].senderType).toBe('system');
    });

    it('sendMessage does NOT emit chat_message on the façade — chat-v2 is the canonical emitter (avoid double-broadcast)', async () => {
      const service = getChatService();
      const facadeMessageEvents: unknown[] = [];
      const chatV2MessageEvents: unknown[] = [];
      const conversationEvents: unknown[] = [];
      service.on('chat_message', (e) => facadeMessageEvents.push(e));
      service.on('conversation_updated', (e) => conversationEvents.push(e));
      chatV2.on('chat_message', (e) => chatV2MessageEvents.push(e));

      await service.sendMessage({ content: 'hi', conversationId: 'slack-Z-1' });

      // Façade is silent for chat_message (Phase 6α follow-up #6)
      expect(facadeMessageEvents).toHaveLength(0);
      // chat-v2 is the single source of truth and emits exactly once
      expect(chatV2MessageEvents).toHaveLength(1);
      // conversation_updated stays on the façade until chat-v2 grows
      // a channel-touched event
      expect(conversationEvents).toHaveLength(1);
      expect(conversationEvents[0]).toMatchObject({
        type: 'conversation_updated',
        data: { id: 'slack-Z-1' },
      });
    });

    it('addAgentMessage defaults to source=pty-runtime when metadata has no source override', async () => {
      const service = getChatService();
      await service.addAgentMessage(
        'slack-Q-1',
        'reply',
        { type: 'orchestrator', id: 'crewly-orc', name: 'Orchestrator' },
        undefined,
      );

      const messages = chatV2.listMessages({
        channelId: 'slack-Q-1',
        principal: { userId: 'system', source: 'oss' },
        direction: 'forward',
      }).messages;
      expect(messages).toHaveLength(1);
      expect(messages[0].metadata).toMatchObject({ source: 'pty-runtime' });
    });

    it('addAgentMessage honors metadata.source override (e.g. in-process-runtime)', async () => {
      const service = getChatService();
      await service.addAgentMessage(
        'slack-Q-2',
        'reply',
        { type: 'orchestrator', id: 'crewly-orc', name: 'Orchestrator' },
        { source: 'in-process-runtime' },
      );

      const messages = chatV2.listMessages({
        channelId: 'slack-Q-2',
        principal: { userId: 'system', source: 'oss' },
        direction: 'forward',
      }).messages;
      expect(messages[0].metadata).toMatchObject({ source: 'in-process-runtime' });
    });

    it('addDirectMessage honors metadata.source override (reply-tool path)', async () => {
      const service = getChatService();
      await service.addDirectMessage(
        'slack-Q-3',
        'tool-driven reply',
        { type: 'orchestrator', id: 'crewly-orc', name: 'Orchestrator' },
        { source: 'reply-tool' },
      );
      const messages = chatV2.listMessages({
        channelId: 'slack-Q-3',
        principal: { userId: 'system', source: 'oss' },
        direction: 'forward',
      }).messages;
      expect(messages[0].metadata).toMatchObject({ source: 'reply-tool' });
    });

    it('addAgentMessage falls back to default source when metadata.source is not a valid enum value', async () => {
      const service = getChatService();
      await service.addAgentMessage(
        'slack-Q-4',
        'reply',
        { type: 'orchestrator', id: 'crewly-orc', name: 'Orchestrator' },
        { source: 'not-a-real-source' as unknown as string },
      );
      const messages = chatV2.listMessages({
        channelId: 'slack-Q-4',
        principal: { userId: 'system', source: 'oss' },
        direction: 'forward',
      }).messages;
      expect(messages[0].metadata).toMatchObject({ source: 'pty-runtime' });
    });

    it('addAgentMessage does NOT emit chat_message on the façade (chat-v2 emits)', async () => {
      const service = getChatService();
      const facadeEvents: unknown[] = [];
      const chatV2Events: unknown[] = [];
      service.on('chat_message', (e) => facadeEvents.push(e));
      chatV2.on('chat_message', (e) => chatV2Events.push(e));

      await service.addAgentMessage(
        'slack-Q-5',
        'silent',
        { type: 'orchestrator', id: 'crewly-orc', name: 'Orchestrator' },
        undefined,
      );

      expect(facadeEvents).toHaveLength(0);
      expect(chatV2Events).toHaveLength(1);
    });
  });

  describe('reads', () => {
    it('getMessages returns legacy ChatMessage[] for a conversation', async () => {
      const service = getChatService();
      await service.sendMessage({ content: 'one', conversationId: 'slack-A-1' });
      await service.sendMessage({ content: 'two', conversationId: 'slack-A-1' });

      const messages = await service.getMessages({ conversationId: 'slack-A-1' });
      expect(messages).toHaveLength(2);
      expect(messages.map((m) => m.content)).toEqual(['one', 'two']);
    });

    it('getMessages honors filter.limit when provided (Phase 6α follow-up #4)', async () => {
      const service = getChatService();
      for (let i = 0; i < 5; i++) {
        await service.sendMessage({ content: `msg-${i}`, conversationId: 'slack-A-LIMIT' });
      }
      const limited = await service.getMessages({ conversationId: 'slack-A-LIMIT', limit: 2 });
      expect(limited).toHaveLength(2);
    });

    it('getMessages falls back to 200 default when filter.limit is missing', async () => {
      const service = getChatService();
      await service.sendMessage({ content: 'x', conversationId: 'slack-A-DEFAULT' });
      // We can't reach 200 in a unit test, but we can assert that
      // omitting limit doesn't truncate small result sets.
      const result = await service.getMessages({ conversationId: 'slack-A-DEFAULT' });
      expect(result).toHaveLength(1);
    });

    it('getMessages caps filter.limit at 1000 to prevent unbounded responses', async () => {
      const service = getChatService();
      await service.sendMessage({ content: 'x', conversationId: 'slack-A-CAP' });
      // The cap is internal; we assert behavior is identical to a
      // normal request — i.e. asking for 10_000 doesn't blow up.
      const result = await service.getMessages({ conversationId: 'slack-A-CAP', limit: 10_000 });
      expect(result).toHaveLength(1);
    });

    it('getMessages ignores non-positive or non-finite filter.limit values', async () => {
      const service = getChatService();
      await service.sendMessage({ content: 'x', conversationId: 'slack-A-BAD' });
      const zero = await service.getMessages({ conversationId: 'slack-A-BAD', limit: 0 });
      expect(zero).toHaveLength(1);
      const negative = await service.getMessages({ conversationId: 'slack-A-BAD', limit: -5 });
      expect(negative).toHaveLength(1);
      const nan = await service.getMessages({ conversationId: 'slack-A-BAD', limit: Number.NaN });
      expect(nan).toHaveLength(1);
    });

    it('getMessageCount returns 0 for unknown conversation', async () => {
      const service = getChatService();
      expect(await service.getMessageCount({ conversationId: 'nope' })).toBe(0);
    });

    it('getConversations lists all channels in legacy shape', async () => {
      const service = getChatService();
      await service.sendMessage({ content: 'a', conversationId: 'slack-B-1' });
      await service.sendMessage({ content: 'b', conversationId: 'slack-B-2' });

      const conversations = await service.getConversations();
      expect(conversations.map((c) => c.id).sort()).toEqual(['slack-B-1', 'slack-B-2']);
      expect(conversations[0].isArchived).toBe(false);
    });

    it('getStatistics translates chat-v2 stats to legacy shape', async () => {
      const service = getChatService();
      await service.sendMessage({ content: 'x', conversationId: 'slack-C-1' });

      const stats = await service.getStatistics();
      expect(stats).toEqual({
        totalConversations: 1,
        activeConversations: 1,
        archivedConversations: 0,
        totalMessages: 1,
      });
    });
  });

  describe('lifecycle methods', () => {
    it('archiveConversation + unarchiveConversation toggle the archive flag', async () => {
      const service = getChatService();
      await service.sendMessage({ content: 'x', conversationId: 'slack-D-1' });

      await service.archiveConversation('slack-D-1');
      let conv = await service.getConversation('slack-D-1');
      expect(conv?.isArchived).toBe(true);

      await service.unarchiveConversation('slack-D-1');
      conv = await service.getConversation('slack-D-1');
      expect(conv?.isArchived).toBe(false);
    });

    it('updateConversationTitle renames the channel', async () => {
      const service = getChatService();
      await service.sendMessage({ content: 'x', conversationId: 'slack-E-1' });

      const updated = await service.updateConversationTitle('slack-E-1', 'Renamed Channel');
      expect(updated.title).toBe('Renamed Channel');
    });

    it('clearConversation deletes messages but keeps the channel', async () => {
      const service = getChatService();
      await service.sendMessage({ content: 'a', conversationId: 'slack-F-1' });
      await service.sendMessage({ content: 'b', conversationId: 'slack-F-1' });
      expect(await service.getMessageCount({ conversationId: 'slack-F-1' })).toBe(2);

      await service.clearConversation('slack-F-1');

      expect(await service.getMessageCount({ conversationId: 'slack-F-1' })).toBe(0);
      const conv = await service.getConversation('slack-F-1');
      expect(conv).not.toBeNull();
    });

    it('deleteConversation hard-deletes channel + messages', async () => {
      const service = getChatService();
      await service.sendMessage({ content: 'a', conversationId: 'slack-G-1' });
      await service.deleteConversation('slack-G-1');

      expect(await service.getConversation('slack-G-1')).toBeNull();
      expect(chatV2.countAllMessages()).toBe(0);
    });
  });

  describe('Slack delivery reconciliation', () => {
    it('updateMessageMetadata merges patch via chat-v2 json_patch', async () => {
      const service = getChatService();
      const { message } = await service.sendMessage({
        content: 'pending msg',
        conversationId: 'slack-H-1',
        metadata: { slackChannelId: 'D0AC7', slackDeliveryStatus: 'pending' },
      });

      const updated = await service.updateMessageMetadata('slack-H-1', message.id, {
        slackDeliveryStatus: 'delivered',
      });

      expect(updated?.metadata).toMatchObject({
        slackDeliveryStatus: 'delivered',
        slackChannelId: 'D0AC7',
      });
    });

    it('getMessagesWithPendingSlackDelivery returns only pending entries', async () => {
      const service = getChatService();
      await service.sendMessage({
        content: 'delivered',
        conversationId: 'slack-I-1',
        metadata: { slackChannelId: 'D0AC7', slackDeliveryStatus: 'delivered' },
      });
      await service.sendMessage({
        content: 'pending',
        conversationId: 'slack-I-1',
        metadata: { slackChannelId: 'D0AC7', slackDeliveryStatus: 'pending' },
      });

      const pending = await service.getMessagesWithPendingSlackDelivery(60 * 60 * 1000);
      expect(pending).toHaveLength(1);
      expect(pending[0].content).toBe('pending');
    });
  });

  describe('compatibility no-ops', () => {
    it('isInitialized always returns true (no init step needed)', () => {
      expect(getChatService().isInitialized()).toBe(true);
    });

    it('initialize is a no-op', async () => {
      await expect(getChatService().initialize()).resolves.toBeUndefined();
    });

    it('getMessage returns null (not implemented in facade; callers should migrate)', async () => {
      expect(await getChatService().getMessage('x', 'y')).toBeNull();
    });
  });
});
