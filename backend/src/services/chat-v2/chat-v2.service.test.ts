/**
 * Tests for ChatV2Service — wire of stores + authorization + DTO mapping.
 *
 * @module services/chat-v2/chat-v2.service.test
 */

import { ChatV2Service } from './chat-v2.service.js';
import { openChatDatabase, type ChatDatabase } from './sqlite/chat-db.js';
import { loadChatV2Config } from './config.js';
import { ChatError, type ChatPrincipal } from './types.js';

describe('ChatV2Service', () => {
  let db: ChatDatabase;
  let service: ChatV2Service;

  const owner: ChatPrincipal = { userId: 'user-a', source: 'oss' };
  const otherUser: ChatPrincipal = { userId: 'user-b', source: 'oss' };
  const agentPrincipal: ChatPrincipal = {
    userId: 'agent-principal', // distinct so we can see agent path vs owner path
    agentSession: 'sess-a',
    source: 'oss',
  };

  beforeEach(() => {
    db = openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true });
    service = new ChatV2Service({
      config: loadChatV2Config({}),
      db,
      getPresence: () => ({ status: 'online', lastSeenAt: 1234 }),
      now: () => 1000,
    });
  });

  afterEach(() => {
    service.close();
  });

  function createSam() {
    return service.createChannel({
      agentSession: 'sess-a',
      name: 'Sam backend',
      principal: owner,
    });
  }

  // -------------------------------------------------------------------------
  // createChannel
  // -------------------------------------------------------------------------

  describe('createChannel', () => {
    it('creates a channel owned by the caller, ignoring any client-supplied owner', () => {
      const dto = createSam();
      expect(dto.agentSession).toBe('sess-a');
      expect(dto.name).toBe('Sam backend');
      expect(dto.agentPresence.status).toBe('online');
      expect(dto.agentPresence.lastSeenAt).toBe(1234);
    });

    it.each([
      ['', 'name is required'],
      ['   ', 'name is required'],
    ])('rejects blank name %s', (name, errMsg) => {
      expect(() =>
        service.createChannel({ agentSession: 'sess-a', name, principal: owner }),
      ).toThrow(errMsg);
    });

    it('rejects names > config.maxChannelNameChars', () => {
      const long = 'a'.repeat(200);
      expect(() =>
        service.createChannel({ agentSession: 'sess-a', name: long, principal: owner }),
      ).toThrow(/exceeds/);
    });

    it('rejects empty agentSession', () => {
      expect(() =>
        service.createChannel({ agentSession: '   ', name: 'x', principal: owner }),
      ).toThrow(/agentSession is required/);
    });

    it('rejects a second active channel for the same agent (1:1 binding)', () => {
      createSam();
      try {
        service.createChannel({
          agentSession: 'sess-a',
          name: 'Dup',
          principal: owner,
        });
        fail('expected ChatError');
      } catch (err) {
        expect(err).toBeInstanceOf(ChatError);
        expect((err as ChatError).code).toBe('agent_already_bound');
        expect((err as ChatError).httpStatus).toBe(409);
      }
    });
  });

  // -------------------------------------------------------------------------
  // listChannels / getChannel / archiveChannel
  // -------------------------------------------------------------------------

  describe('listChannels', () => {
    it('returns only channels owned by the caller', () => {
      createSam();
      service.createChannel({
        agentSession: 'sess-b',
        name: 'Other owner',
        principal: otherUser,
      });
      expect(service.listChannels({ principal: owner })).toHaveLength(1);
      expect(service.listChannels({ principal: otherUser })).toHaveLength(1);
    });
  });

  describe('getChannel', () => {
    it('returns 404-style error when the caller does not own it', () => {
      const ch = createSam();
      try {
        service.getChannel(ch.id, otherUser);
        fail('expected ChatError');
      } catch (err) {
        expect(err).toBeInstanceOf(ChatError);
        expect((err as ChatError).code).toBe('channel_not_found');
        expect((err as ChatError).httpStatus).toBe(404);
      }
    });

    it('returns the DTO to the owner', () => {
      const ch = createSam();
      const dto = service.getChannel(ch.id, owner);
      expect(dto.id).toBe(ch.id);
    });
  });

  describe('archiveChannel', () => {
    it('archives a channel the caller owns', () => {
      const ch = createSam();
      expect(service.archiveChannel(ch.id, owner)).toBe(true);
      expect(service.archiveChannel(ch.id, owner)).toBe(false);
    });

    it('refuses non-owners', () => {
      const ch = createSam();
      expect(() => service.archiveChannel(ch.id, otherUser)).toThrow(ChatError);
    });
  });

  // -------------------------------------------------------------------------
  // sendMessage
  // -------------------------------------------------------------------------

  describe('sendMessage', () => {
    it('persists a user message with server-assigned sender fields', () => {
      const ch = createSam();
      const msg = service.sendMessage({
        channelId: ch.id,
        principal: owner,
        content: 'hello',
      });
      expect(msg.senderType).toBe('user');
      expect(msg.senderId).toBe(owner.userId);
      expect(msg.seq).toBe(1);
      expect(msg.contentType).toBe('markdown');
    });

    it('persists an agent message when the bound agent calls', () => {
      const ch = createSam();
      const msg = service.sendMessage({
        channelId: ch.id,
        principal: agentPrincipal,
        content: 'agent here',
      });
      expect(msg.senderType).toBe('agent');
      expect(msg.senderId).toBe('sess-a');
    });

    it('rejects messages exceeding the byte cap with payload_too_large', () => {
      const ch = createSam();
      const oversize = 'a'.repeat(40000);
      try {
        service.sendMessage({ channelId: ch.id, principal: owner, content: oversize });
        fail('expected ChatError');
      } catch (err) {
        expect(err).toBeInstanceOf(ChatError);
        expect((err as ChatError).code).toBe('payload_too_large');
        expect((err as ChatError).httpStatus).toBe(413);
      }
    });

    it('rejects empty content', () => {
      const ch = createSam();
      expect(() =>
        service.sendMessage({ channelId: ch.id, principal: owner, content: '' }),
      ).toThrow(/content is required/);
    });

    it('rejects unknown contentType', () => {
      const ch = createSam();
      expect(() =>
        service.sendMessage({
          channelId: ch.id,
          principal: owner,
          content: 'x',
          contentType: 'binary' as never,
        }),
      ).toThrow(/unknown contentType/);
    });

    it('forbids a user from posting system_note', () => {
      const ch = createSam();
      expect(() =>
        service.sendMessage({
          channelId: ch.id,
          principal: owner,
          content: 'admin-ish',
          contentType: 'system_note',
        }),
      ).toThrow(/system_note/);
    });

    it('404s for unknown channel id', () => {
      try {
        service.sendMessage({ channelId: 'missing', principal: owner, content: 'x' });
        fail('expected ChatError');
      } catch (err) {
        expect((err as ChatError).code).toBe('channel_not_found');
      }
    });

    it('forbids non-owner non-agent from posting', () => {
      const ch = createSam();
      try {
        service.sendMessage({ channelId: ch.id, principal: otherUser, content: 'hi' });
        fail('expected ChatError');
      } catch (err) {
        // Not found (rather than 403) to avoid leaking channel existence.
        expect((err as ChatError).code).toBe('channel_not_found');
      }
    });

    it('refuses sends into an archived channel', () => {
      const ch = createSam();
      service.archiveChannel(ch.id, owner);
      try {
        service.sendMessage({ channelId: ch.id, principal: owner, content: 'x' });
        fail('expected ChatError');
      } catch (err) {
        expect((err as ChatError).code).toBe('channel_archived');
      }
    });

    it('dedupes on clientMessageId', () => {
      const ch = createSam();
      const a = service.sendMessage({
        channelId: ch.id,
        principal: owner,
        content: 'x',
        clientMessageId: 'cmid-1',
      });
      const b = service.sendMessage({
        channelId: ch.id,
        principal: owner,
        content: 'x-DIFFERENT',
        clientMessageId: 'cmid-1',
      });
      expect(a.id).toBe(b.id);
      expect(a.seq).toBe(b.seq);
    });
  });

  // -------------------------------------------------------------------------
  // listMessages
  // -------------------------------------------------------------------------

  describe('listMessages', () => {
    it('pages newest-first with cursor continuation', () => {
      const ch = createSam();
      for (let i = 0; i < 7; i++) {
        service.sendMessage({ channelId: ch.id, principal: owner, content: `m${i}` });
      }
      const first = service.listMessages({
        channelId: ch.id,
        principal: owner,
        limit: 3,
      });
      expect(first.messages.map((m) => m.content)).toEqual(['m6', 'm5', 'm4']);
      const second = service.listMessages({
        channelId: ch.id,
        principal: owner,
        limit: 3,
        cursor: first.nextCursor,
      });
      expect(second.messages.map((m) => m.content)).toEqual(['m3', 'm2', 'm1']);
    });

    it('refuses listing a channel the caller doesn\'t own', () => {
      const ch = createSam();
      service.sendMessage({ channelId: ch.id, principal: owner, content: 'x' });
      expect(() =>
        service.listMessages({ channelId: ch.id, principal: otherUser }),
      ).toThrow(ChatError);
    });
  });
});
