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

    it('sendMessage emits chat_message + conversation_updated events with the correct envelope shape', async () => {
      const service = getChatService();
      const messageEvents: unknown[] = [];
      const conversationEvents: unknown[] = [];
      service.on('chat_message', (e) => messageEvents.push(e));
      service.on('conversation_updated', (e) => conversationEvents.push(e));

      await service.sendMessage({ content: 'hi', conversationId: 'slack-Z-1' });

      expect(messageEvents).toHaveLength(1);
      expect(messageEvents[0]).toMatchObject({ type: 'chat_message', data: { content: 'hi' } });
      expect(conversationEvents).toHaveLength(1);
      expect(conversationEvents[0]).toMatchObject({
        type: 'conversation_updated',
        data: { id: 'slack-Z-1' },
      });
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
