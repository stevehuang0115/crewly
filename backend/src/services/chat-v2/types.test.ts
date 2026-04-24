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
  CHAT_ERROR_CODES,
  ChatError,
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
