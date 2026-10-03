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

import { getChatService, resetChatService, ConversationNotFoundError } from './chat.service.js';
import { resetChatV2Service, setChatV2ServiceForTesting } from '../chat-v2/chat-v2.singleton.js';
import { ChatV2Service } from '../chat-v2/chat-v2.service.js';
import { openChatDatabase } from '../chat-v2/sqlite/chat-db.js';
import { loadChatV2Config } from '../chat-v2/config.js';
import { MessageStore } from '../chat-v2/sqlite/message.store.js';
import type { ChatMessage } from '../../types/chat.types.js';

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
      // #1000: the newest tail, not the first two messages of the channel.
      expect(limited.map((m) => m.content)).toEqual(['msg-3', 'msg-4']);
    });

    it('getMessages falls back to 200 default when filter.limit is missing', async () => {
      const service = getChatService();
      await service.sendMessage({ content: 'x', conversationId: 'slack-A-DEFAULT' });
      // We can't reach 200 in a unit test, but we can assert that
      // omitting limit doesn't truncate small result sets.
      const result = await service.getMessages({ conversationId: 'slack-A-DEFAULT' });
      expect(result).toHaveLength(1);
    });

    // #1000: the old version of this test asserted ONE chat-v2 call with
    // `limit: 1000`, but chat-v2 silently caps a page at 100 rows, so that
    // "cap" really truncated to 100. The cap is now observed end-to-end:
    // 1005 rows, limit 10_000 → exactly the newest 1000.
    it('getMessages caps filter.limit at 1000 to prevent unbounded responses', async () => {
      const service = getChatService();
      for (let i = 0; i < 1005; i++) {
        await service.addSystemMessage('slack-A-CAP', `msg-${i}`);
      }
      const result = await service.getMessages({ conversationId: 'slack-A-CAP', limit: 10_000 });
      expect(result).toHaveLength(1000);
      expect(result[0].content).toBe('msg-5');
      expect(result[999].content).toBe('msg-1004');
    });

    // #1000: replaces "passes the resolved limit through to
    // chat-v2.listMessages", which locked the buggy single forward call
    // with `limit` > chat-v2's 100-row page cap. Every chat-v2 call must
    // now be a backward (newest-first) page within the store cap.
    it('getMessages reads chat-v2 newest-first in pages within the store cap', async () => {
      const service = getChatService();
      await service.sendMessage({ content: 'x', conversationId: 'slack-A-PASS' });
      const spy = jest.spyOn(chatV2, 'listMessages');

      await service.getMessages({ conversationId: 'slack-A-PASS', limit: 50 });
      await service.getMessages({ conversationId: 'slack-A-PASS' });
      await service.getMessages({ conversationId: 'slack-A-PASS', limit: 0 });
      expect(spy).toHaveBeenCalledTimes(3);
      for (const [args] of spy.mock.calls) {
        expect(args).toMatchObject({ channelId: 'slack-A-PASS', direction: 'backward' });
        expect(args.limit).toBeLessThanOrEqual(MessageStore.MAX_LIMIT);
      }

      spy.mockRestore();
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

    // Regression: the façade surfaced chat-v2's ChatError(channel_not_found)
    // instead of the legacy ConversationNotFoundError, so the chat
    // controller answered 500 instead of 404.
    it('rename/archive/unarchive of an unknown conversation throw ConversationNotFoundError', async () => {
      const service = getChatService();
      await expect(service.updateConversationTitle('nope', 't')).rejects.toBeInstanceOf(ConversationNotFoundError);
      await expect(service.archiveConversation('nope')).rejects.toBeInstanceOf(ConversationNotFoundError);
      await expect(service.unarchiveConversation('nope')).rejects.toBeInstanceOf(ConversationNotFoundError);
    });

    it('deleteConversation of an unknown conversation is a no-op', async () => {
      await expect(getChatService().deleteConversation('nope')).resolves.toBeUndefined();
    });
  });

  describe('legacy filters (regression: dropped by the Phase 6 façade)', () => {
    it('getMessages / getMessageCount honor senderType', async () => {
      const service = getChatService();
      await service.sendMessage({ content: 'from user', conversationId: 'slack-J-1' });
      await service.addAgentMessage('slack-J-1', 'from agent', { type: 'orchestrator', id: 'crewly-orc' });

      const users = await service.getMessages({ conversationId: 'slack-J-1', senderType: 'user' });
      expect(users.map((m) => m.content)).toEqual(['from user']);
      expect(await service.getMessageCount({ conversationId: 'slack-J-1', senderType: 'user' })).toBe(1);
      expect(await service.getMessageCount({ conversationId: 'slack-J-1' })).toBe(2);
    });

    it('getMessages returns [] for an unknown conversation', async () => {
      expect(await getChatService().getMessages({ conversationId: 'nope' })).toEqual([]);
    });

    it('getMessage finds a message by id only within its own conversation', async () => {
      const service = getChatService();
      const { message } = await service.sendMessage({ content: 'hi', conversationId: 'slack-K-1' });
      await service.sendMessage({ content: 'other', conversationId: 'slack-K-2' });

      const found = await service.getMessage('slack-K-1', message.id);
      expect(found?.content).toBe('hi');
      expect(await service.getMessage('slack-K-2', message.id)).toBeNull();
      expect(await service.getMessage('slack-K-1', 'no-such-id')).toBeNull();
    });

    it('getConversations honors includeArchived, search and limit', async () => {
      const service = getChatService();
      await service.createNewConversation('Project Discussion', 'web-conv-1');
      await service.createNewConversation('Bug Fixes', 'web-conv-2');
      await service.createNewConversation('Old Stuff', 'web-conv-3');
      await service.archiveConversation('web-conv-3');

      const active = await service.getConversations();
      expect(active.map((c) => c.id).sort()).toEqual(['web-conv-1', 'web-conv-2']);

      const all = await service.getConversations({ includeArchived: true });
      expect(all).toHaveLength(3);

      const searched = await service.getConversations({ search: 'PROJECT' });
      expect(searched.map((c) => c.title)).toEqual(['Project Discussion']);

      expect(await service.getConversations({ limit: 1 })).toHaveLength(1);
    });
  });

  describe('newest-first paging over large conversations (#1000)', () => {
    const CONV = 'slack-P-1';
    const TOTAL = 250;

    /**
     * Swap in a chat-v2 instance whose clock advances 1s per call so every
     * message gets a distinct, monotonically increasing timestamp.
     */
    beforeEach(() => {
      resetChatService();
      resetChatV2Service();
      let clock = Date.UTC(2026, 0, 1);
      chatV2 = new ChatV2Service({
        config: loadChatV2Config({}),
        db: openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true }),
        getPresence: () => ({ status: 'online', lastSeenAt: null }),
        now: () => (clock += 1000),
      });
      setChatV2ServiceForTesting(chatV2);
    });

    /**
     * Seed `TOTAL` messages `msg-0` … `msg-249`; even indices are user
     * messages, odd indices are orchestrator (agent) messages.
     */
    async function seed(): Promise<void> {
      const service = getChatService();
      for (let i = 0; i < TOTAL; i++) {
        if (i % 2 === 0) {
          await service.sendMessage({ content: `msg-${i}`, conversationId: CONV });
        } else {
          await service.addAgentMessage(CONV, `msg-${i}`, { type: 'orchestrator', id: 'crewly-orc' });
        }
      }
    }

    /** `msg-<from>` … `msg-<to - 1>`, optionally only every `step`-th. */
    function range(from: number, to: number, step = 1): string[] {
      const out: string[] = [];
      for (let i = from; i < to; i += step) out.push(`msg-${i}`);
      return out;
    }

    /** Message contents of a page. */
    function contents(messages: ChatMessage[]): string[] {
      return messages.map((m) => m.content);
    }

    it('default call returns the newest 200 (default page size) in chronological order', async () => {
      await seed();
      const page = await getChatService().getMessages({ conversationId: CONV });
      expect(contents(page)).toEqual(range(50, TOTAL));
    });

    it('a limit above the chat-v2 page cap (100) is served from several pages, not truncated', async () => {
      await seed();
      const page = await getChatService().getMessages({ conversationId: CONV, limit: 150 });
      expect(contents(page)).toEqual(range(100, TOTAL));
    });

    it('before=<timestamp> paging walks back to the first message without gaps or duplicates', async () => {
      await seed();
      const service = getChatService();
      let loaded = await service.getMessages({ conversationId: CONV, limit: 60 });
      let calls = 0;
      for (;;) {
        const before = loaded[0].timestamp;
        const filter = { conversationId: CONV, limit: 60, before };
        const [older, remaining] = await Promise.all([
          service.getMessages(filter),
          service.getMessageCount(filter),
        ]);
        // Count of everything before the anchor drives the UI's hasMore.
        expect(remaining).toBe(Number(loaded[0].content.slice('msg-'.length)));
        if (older.length === 0) break;
        loaded = [...older, ...loaded];
        calls++;
        expect(calls).toBeLessThan(10);
      }
      expect(contents(loaded)).toEqual(range(0, TOTAL));
      expect(new Set(loaded.map((m) => m.id)).size).toBe(TOTAL);
    });

    it('before=<message id> pages exactly the messages preceding that message', async () => {
      await seed();
      const service = getChatService();
      const newest = await service.getMessages({ conversationId: CONV, limit: 100 });
      expect(contents(newest)).toEqual(range(150, TOTAL));
      const older = await service.getMessages({ conversationId: CONV, limit: 100, before: newest[0].id });
      expect(contents(older)).toEqual(range(50, 150));
      const oldest = await service.getMessages({ conversationId: CONV, limit: 100, before: older[0].id });
      expect(contents(oldest)).toEqual(range(0, 50));
      expect(await service.getMessageCount({ conversationId: CONV, before: older[0].id })).toBe(50);
    });

    it('after=<timestamp|id> returns the newest matches after that point; before+after bounds a window', async () => {
      await seed();
      const service = getChatService();
      const all = await service.getMessages({ conversationId: CONV, limit: 1000 });
      expect(all).toHaveLength(TOTAL);
      const anchor = all[200];

      const afterTs = await service.getMessages({ conversationId: CONV, after: anchor.timestamp, limit: 20 });
      expect(contents(afterTs)).toEqual(range(230, TOTAL));
      expect(await service.getMessageCount({ conversationId: CONV, after: anchor.timestamp })).toBe(49);

      const afterId = await service.getMessages({ conversationId: CONV, after: anchor.id });
      expect(contents(afterId)).toEqual(range(201, TOTAL));

      const windowed = await service.getMessages({
        conversationId: CONV,
        after: all[10].timestamp,
        before: all[20].id,
      });
      expect(contents(windowed)).toEqual(range(11, 20));
    });

    it('senderType filter + before paging returns full pages of matches and reaches the first match', async () => {
      await seed();
      const service = getChatService();
      const first = await service.getMessages({ conversationId: CONV, senderType: 'user', limit: 50 });
      // Newest 50 USER messages — filtering does not shrink the page.
      expect(contents(first)).toEqual(range(150, TOTAL, 2));
      expect(await service.getMessageCount({ conversationId: CONV, senderType: 'user' })).toBe(125);

      let loaded = first;
      for (let guard = 0; guard < 10; guard++) {
        const older = await service.getMessages({
          conversationId: CONV,
          senderType: 'user',
          limit: 50,
          before: loaded[0].timestamp,
        });
        if (older.length === 0) break;
        loaded = [...older, ...loaded];
      }
      expect(contents(loaded)).toEqual(range(0, TOTAL, 2));

      const agents = await service.getMessages({
        conversationId: CONV,
        senderType: 'orchestrator',
        limit: 3,
        before: first[0].id,
      });
      expect(contents(agents)).toEqual(['msg-145', 'msg-147', 'msg-149']);
    });

    it('offset keeps the legacy oldest-first offset pagination across chat-v2 pages', async () => {
      await seed();
      const page = await getChatService().getMessages({ conversationId: CONV, offset: 95, limit: 10 });
      expect(contents(page)).toEqual(range(95, 105));
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
