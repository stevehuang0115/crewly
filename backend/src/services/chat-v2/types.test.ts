/**
 * Tests for Chat V2 type helpers / validators.
 *
 * Values-only modules (interfaces aren't runtime) — we exercise the
 * exported tuples and the ChatError class.
 *
 * @module services/chat-v2/types.test
 */

import {
  CHAT_SENDER_TYPES,
  CHAT_CONTENT_TYPES,
  CHAT_CHANNEL_TYPES,
  CHAT_MENTION_KINDS,
  CHAT_ERROR_CODES,
  ChatError,
} from './types.js';
import type {
  ChatChannelRow,
  ChatMessageRow,
  ChatChannelDTO,
  ChatMessageDTO,
  CreateChannelInput,
  SendMessageInput,
} from './types.js';

describe('chat-v2/types', () => {
  describe('CHAT_SENDER_TYPES', () => {
    it('contains exactly the three allowed sender types', () => {
      expect([...CHAT_SENDER_TYPES].sort()).toEqual(['agent', 'system', 'user']);
    });

    it('is treated as readonly — sender tuple is immutable at the type level', () => {
      // Runtime check: the array reference exists and is non-empty.
      expect(CHAT_SENDER_TYPES.length).toBe(3);
    });
  });

  describe('CHAT_CONTENT_TYPES', () => {
    it('contains exactly the four allowed content types', () => {
      expect([...CHAT_CONTENT_TYPES].sort()).toEqual([
        'image_ref',
        'markdown',
        'system_note',
        'text',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Phase B Slack-like team-chat additions (SEALED design 2026-04-25)
  // -------------------------------------------------------------------------

  describe('CHAT_CHANNEL_TYPES', () => {
    it('contains exactly the two channel types — dm + channel', () => {
      expect([...CHAT_CHANNEL_TYPES].sort()).toEqual(['channel', 'dm']);
    });
  });

  describe('CHAT_MENTION_KINDS', () => {
    it('contains exactly the two mention kinds — team + agent', () => {
      expect([...CHAT_MENTION_KINDS].sort()).toEqual(['agent', 'team']);
    });
  });

  describe('Phase B row shapes — type-only contract checks', () => {
    it.todo('TODO: ChatChannelRow accepts type/team_id/project_id/target_member_id');
    it.todo('TODO: ChatMessageRow accepts mentions JSON string + thread_id');
    it.todo('TODO: ChatChannelDTO requires type field; teamId/projectId/targetMemberId optional');
    it.todo('TODO: ChatMessageDTO requires mentions array (never null on wire); threadId optional');
    it.todo('TODO: CreateChannelInput type defaults to dm; channel requires teamId at service-layer validation');
    it.todo('TODO: SendMessageInput accepts optional mentions[] + threadId');

    // Compile-time-only contract assertions: these never run, but the
    // types must shape-match for the file to compile. If a future
    // refactor breaks the contract, tsc fails the build before tests
    // even start.
    it('Phase B types compile — contract preserved', () => {
      const _channelRow: ChatChannelRow = {
        id: 'c-1',
        agent_session: '',
        owner_user_id: 'u-1',
        name: '#general',
        purpose: null,
        created_at: 0,
        archived_at: null,
        last_message_at: null,
        type: 'channel',
        team_id: 't-1',
        project_id: null,
        target_member_id: null,
      };
      const _msgRow: ChatMessageRow = {
        id: 'm-1',
        channel_id: 'c-1',
        seq: 1,
        sender_type: 'user',
        sender_id: 'u-1',
        content: 'hi @team',
        content_type: 'text',
        created_at: 0,
        metadata: null,
        mentions: '["t-1"]',
        thread_id: null,
      };
      const _channelDto: ChatChannelDTO = {
        id: 'c-1',
        agentSession: '',
        name: '#general',
        createdAt: 0,
        agentPresence: { status: 'offline', lastSeenAt: null },
        type: 'channel',
        teamId: 't-1',
      };
      const _msgDto: ChatMessageDTO = {
        id: 'm-1',
        channelId: 'c-1',
        seq: 1,
        senderType: 'user',
        senderId: 'u-1',
        content: 'hi @team',
        contentType: 'text',
        createdAt: 0,
        attachments: [],
        mentions: ['t-1'],
      };
      const _createInput: CreateChannelInput = {
        name: '#general',
        type: 'channel',
        teamId: 't-1',
      };
      const _sendInput: SendMessageInput = {
        content: 'hi @team',
        mentions: ['t-1'],
      };
      // Variables exist solely for type-checking; assert truthy to satisfy lint.
      expect(_channelRow.type).toBe('channel');
      expect(_msgRow.thread_id).toBeNull();
      expect(_channelDto.type).toBe('channel');
      expect(_msgDto.mentions).toEqual(['t-1']);
      expect(_createInput.type).toBe('channel');
      expect(_sendInput.mentions).toEqual(['t-1']);
    });
  });

  describe('CHAT_ERROR_CODES', () => {
    it('exposes stable string codes the chat-ui package can switch on', () => {
      expect(CHAT_ERROR_CODES.VALIDATION).toBe('validation_error');
      expect(CHAT_ERROR_CODES.AGENT_ALREADY_BOUND).toBe('agent_already_bound');
      expect(CHAT_ERROR_CODES.INVALID_CURSOR).toBe('invalid_cursor');
    });
  });

  describe('ChatError', () => {
    it('captures code, httpStatus, message, and details', () => {
      const err = new ChatError('validation_error', 400, 'bad input', { field: 'name' });
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('ChatError');
      expect(err.code).toBe('validation_error');
      expect(err.httpStatus).toBe(400);
      expect(err.message).toBe('bad input');
      expect(err.details).toEqual({ field: 'name' });
    });

    it('allows details to be undefined', () => {
      const err = new ChatError('not_found', 404, 'missing');
      expect(err.details).toBeUndefined();
    });

    it('serializes message via standard Error machinery', () => {
      const err = new ChatError('forbidden', 403, 'no access');
      expect(String(err)).toContain('no access');
    });
  });
});
