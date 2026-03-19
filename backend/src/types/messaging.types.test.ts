/**
 * Tests for Messaging Types Module
 *
 * @module types/messaging.test
 */

import {
  MESSAGE_SOURCES,
  MESSAGE_SOURCE_VALUES,
  QUEUE_MESSAGE_STATUSES,
  PERSISTED_QUEUE_VERSION,
  isValidMessageSource,
  isValidQueueMessageStatus,
  isValidEnqueueMessageInput,
  isValidQueuedMessage,
  isValidQueueStatus,
  isValidPersistedQueueState,
  toPersistedMessage,
} from './messaging.types.js';
import type {
  MessageSource,
  QueueMessageStatus,
  EnqueueMessageInput,
  QueuedMessage,
  QueueStatus,
} from './messaging.types.js';

describe('Messaging Types', () => {
  describe('Constants', () => {
    it('should have correct message sources', () => {
      expect(MESSAGE_SOURCES).toEqual({ SLACK: 'slack', WEB_CHAT: 'web_chat', SYSTEM_EVENT: 'system_event', WHATSAPP: 'whatsapp', GOOGLE_CHAT: 'google_chat', TELEGRAM: 'telegram' });
      expect(MESSAGE_SOURCE_VALUES).toEqual(expect.arrayContaining(['web_chat', 'slack', 'system_event', 'whatsapp', 'google_chat', 'telegram']));
      expect(MESSAGE_SOURCE_VALUES).toHaveLength(6);
    });

    it('should have correct queue message statuses', () => {
      expect(QUEUE_MESSAGE_STATUSES).toEqual([
        'pending', 'processing', 'completed', 'failed', 'cancelled',
      ]);
    });

    it('should have persisted queue version equal to 1', () => {
      expect(PERSISTED_QUEUE_VERSION).toBe(1);
    });
  });

  describe('isValidMessageSource', () => {
    it('should return true for valid sources', () => {
      expect(isValidMessageSource('web_chat')).toBe(true);
      expect(isValidMessageSource('slack')).toBe(true);
    });

    it('should return false for invalid sources', () => {
      expect(isValidMessageSource('email')).toBe(false);
      expect(isValidMessageSource('')).toBe(false);
      expect(isValidMessageSource(null)).toBe(false);
      expect(isValidMessageSource(undefined)).toBe(false);
      expect(isValidMessageSource(123)).toBe(false);
    });
  });

  describe('isValidQueueMessageStatus', () => {
    it('should return true for valid statuses', () => {
      expect(isValidQueueMessageStatus('pending')).toBe(true);
      expect(isValidQueueMessageStatus('processing')).toBe(true);
      expect(isValidQueueMessageStatus('completed')).toBe(true);
      expect(isValidQueueMessageStatus('failed')).toBe(true);
      expect(isValidQueueMessageStatus('cancelled')).toBe(true);
    });

    it('should return false for invalid statuses', () => {
      expect(isValidQueueMessageStatus('queued')).toBe(false);
      expect(isValidQueueMessageStatus('')).toBe(false);
      expect(isValidQueueMessageStatus(null)).toBe(false);
      expect(isValidQueueMessageStatus(undefined)).toBe(false);
      expect(isValidQueueMessageStatus(42)).toBe(false);
    });
  });

  describe('isValidEnqueueMessageInput', () => {
    const validInput: EnqueueMessageInput = {
      content: 'Hello',
      conversationId: 'conv-1',
      source: 'web_chat',
    };

    it('should return true for valid input', () => {
      expect(isValidEnqueueMessageInput(validInput)).toBe(true);
    });

    it('should return true for valid input with sourceMetadata', () => {
      expect(isValidEnqueueMessageInput({
        ...validInput,
        sourceMetadata: { userId: 'user-1' },
      })).toBe(true);
    });

    it('should return false for null or non-object', () => {
      expect(isValidEnqueueMessageInput(null)).toBe(false);
      expect(isValidEnqueueMessageInput(undefined)).toBe(false);
      expect(isValidEnqueueMessageInput('string')).toBe(false);
      expect(isValidEnqueueMessageInput(123)).toBe(false);
    });

    it('should return false for empty content', () => {
      expect(isValidEnqueueMessageInput({ ...validInput, content: '' })).toBe(false);
      expect(isValidEnqueueMessageInput({ ...validInput, content: '   ' })).toBe(false);
    });

    it('should return false for non-string content', () => {
      expect(isValidEnqueueMessageInput({ ...validInput, content: 123 })).toBe(false);
    });

    it('should return false for empty conversationId', () => {
      expect(isValidEnqueueMessageInput({ ...validInput, conversationId: '' })).toBe(false);
      expect(isValidEnqueueMessageInput({ ...validInput, conversationId: '  ' })).toBe(false);
    });

    it('should return false for invalid source', () => {
      expect(isValidEnqueueMessageInput({ ...validInput, source: 'email' })).toBe(false);
    });
  });

  describe('isValidQueuedMessage', () => {
    const validMessage: QueuedMessage = {
      id: 'msg-1',
      content: 'Hello',
      conversationId: 'conv-1',
      source: 'web_chat',
      status: 'pending',
      enqueuedAt: new Date().toISOString(),
    };

    it('should return true for valid message', () => {
      expect(isValidQueuedMessage(validMessage)).toBe(true);
    });

    it('should return true for valid message with optional fields', () => {
      expect(isValidQueuedMessage({
        ...validMessage,
        processingStartedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: 'some error',
        response: 'some response',
        sourceMetadata: { slackResolve: () => {} },
      })).toBe(true);
    });

    it('should return false for null or non-object', () => {
      expect(isValidQueuedMessage(null)).toBe(false);
      expect(isValidQueuedMessage(undefined)).toBe(false);
      expect(isValidQueuedMessage('string')).toBe(false);
    });

    it('should return false for missing id', () => {
      expect(isValidQueuedMessage({ ...validMessage, id: '' })).toBe(false);
      expect(isValidQueuedMessage({ ...validMessage, id: 123 })).toBe(false);
    });

    it('should return false for missing conversationId', () => {
      expect(isValidQueuedMessage({ ...validMessage, conversationId: '' })).toBe(false);
    });

    it('should return false for invalid source', () => {
      expect(isValidQueuedMessage({ ...validMessage, source: 'email' })).toBe(false);
    });

    it('should return false for invalid status', () => {
      expect(isValidQueuedMessage({ ...validMessage, status: 'unknown' })).toBe(false);
    });

    it('should return false for missing enqueuedAt', () => {
      expect(isValidQueuedMessage({ ...validMessage, enqueuedAt: 123 })).toBe(false);
    });
  });

  describe('isValidQueueStatus', () => {
    const validStatus: QueueStatus = {
      pendingCount: 0,
      isProcessing: false,
      totalProcessed: 0,
      totalFailed: 0,
      historyCount: 0,
    };

    it('should return true for valid status', () => {
      expect(isValidQueueStatus(validStatus)).toBe(true);
    });

    it('should return true for valid status with currentMessage', () => {
      expect(isValidQueueStatus({
        ...validStatus,
        currentMessage: {
          id: 'msg-1',
          content: 'Hello',
          conversationId: 'conv-1',
          source: 'web_chat' as MessageSource,
          status: 'processing' as QueueMessageStatus,
          enqueuedAt: new Date().toISOString(),
        },
      })).toBe(true);
    });

    it('should return false for null or non-object', () => {
      expect(isValidQueueStatus(null)).toBe(false);
      expect(isValidQueueStatus(undefined)).toBe(false);
      expect(isValidQueueStatus('string')).toBe(false);
    });

    it('should return false for negative pendingCount', () => {
      expect(isValidQueueStatus({ ...validStatus, pendingCount: -1 })).toBe(false);
    });

    it('should return false for non-boolean isProcessing', () => {
      expect(isValidQueueStatus({ ...validStatus, isProcessing: 'yes' })).toBe(false);
    });

    it('should return false for negative totalProcessed', () => {
      expect(isValidQueueStatus({ ...validStatus, totalProcessed: -1 })).toBe(false);
    });

    it('should return false for negative totalFailed', () => {
      expect(isValidQueueStatus({ ...validStatus, totalFailed: -1 })).toBe(false);
    });

    it('should return false for non-number historyCount', () => {
      expect(isValidQueueStatus({ ...validStatus, historyCount: 'zero' })).toBe(false);
    });
  });

  describe('toPersistedMessage', () => {
    const baseMessage: QueuedMessage = {
      id: 'msg-1',
      content: 'Hello',
      conversationId: 'conv-1',
      source: 'web_chat',
      status: 'pending',
      enqueuedAt: '2026-02-08T00:00:00.000Z',
    };

    it('should copy all scalar fields', () => {
      const msg: QueuedMessage = {
        ...baseMessage,
        status: 'completed',
        processingStartedAt: '2026-02-08T00:00:01.000Z',
        completedAt: '2026-02-08T00:00:02.000Z',
        error: 'some error',
        response: 'some response',
      };

      const persisted = toPersistedMessage(msg);

      expect(persisted.id).toBe('msg-1');
      expect(persisted.content).toBe('Hello');
      expect(persisted.conversationId).toBe('conv-1');
      expect(persisted.source).toBe('web_chat');
      expect(persisted.status).toBe('completed');
      expect(persisted.enqueuedAt).toBe('2026-02-08T00:00:00.000Z');
      expect(persisted.processingStartedAt).toBe('2026-02-08T00:00:01.000Z');
      expect(persisted.completedAt).toBe('2026-02-08T00:00:02.000Z');
      expect(persisted.error).toBe('some error');
      expect(persisted.response).toBe('some response');
    });

    it('should strip function-valued sourceMetadata entries', () => {
      const msg: QueuedMessage = {
        ...baseMessage,
        sourceMetadata: {
          slackResolve: () => {},
          userId: 'U123',
          channelId: 'C456',
        },
      };

      const persisted = toPersistedMessage(msg);

      expect(persisted.sourceMetadata).toBeDefined();
      expect(persisted.sourceMetadata!.userId).toBe('U123');
      expect(persisted.sourceMetadata!.channelId).toBe('C456');
      expect('slackResolve' in persisted.sourceMetadata!).toBe(false);
    });

    it('should omit sourceMetadata entirely when all entries are functions', () => {
      const msg: QueuedMessage = {
        ...baseMessage,
        sourceMetadata: {
          slackResolve: () => {},
        },
      };

      const persisted = toPersistedMessage(msg);

      expect(persisted.sourceMetadata).toBeUndefined();
    });

    it('should omit sourceMetadata when not present', () => {
      const persisted = toPersistedMessage(baseMessage);

      expect(persisted.sourceMetadata).toBeUndefined();
    });

    it('should omit optional fields when undefined', () => {
      const persisted = toPersistedMessage(baseMessage);

      expect(persisted.processingStartedAt).toBeUndefined();
      expect(persisted.completedAt).toBeUndefined();
      expect(persisted.error).toBeUndefined();
      expect(persisted.response).toBeUndefined();
    });
  });

  describe('isValidPersistedQueueState', () => {
    const validMessage = {
      id: 'msg-1',
      content: 'Hello',
      conversationId: 'conv-1',
      source: 'web_chat',
      status: 'pending',
      enqueuedAt: '2026-02-08T00:00:00.000Z',
    };

    const validState = {
      version: 1,
      savedAt: '2026-02-08T00:00:00.000Z',
      queue: [validMessage],
      currentMessage: null,
      history: [],
      totalProcessed: 5,
      totalFailed: 1,
    };

    it('should return true for valid state', () => {
      expect(isValidPersistedQueueState(validState)).toBe(true);
    });

    it('should return true for valid state with currentMessage', () => {
      expect(isValidPersistedQueueState({
        ...validState,
        currentMessage: { ...validMessage, status: 'processing' },
      })).toBe(true);
    });

    it('should return true for empty queue and history', () => {
      expect(isValidPersistedQueueState({
        ...validState,
        queue: [],
        history: [],
      })).toBe(true);
    });

    it('should return false for null or non-object', () => {
      expect(isValidPersistedQueueState(null)).toBe(false);
      expect(isValidPersistedQueueState(undefined)).toBe(false);
      expect(isValidPersistedQueueState('string')).toBe(false);
    });

    it('should return false for wrong version', () => {
      expect(isValidPersistedQueueState({ ...validState, version: 2 })).toBe(false);
      expect(isValidPersistedQueueState({ ...validState, version: 0 })).toBe(false);
    });

    it('should return false for missing savedAt', () => {
      expect(isValidPersistedQueueState({ ...validState, savedAt: 123 })).toBe(false);
    });

    it('should return false for non-array queue', () => {
      expect(isValidPersistedQueueState({ ...validState, queue: 'not-array' })).toBe(false);
    });

    it('should return false for invalid message in queue', () => {
      expect(isValidPersistedQueueState({
        ...validState,
        queue: [{ id: '', content: 'x', conversationId: 'c', source: 'web_chat', status: 'pending', enqueuedAt: 'now' }],
      })).toBe(false);
    });

    it('should return false for invalid currentMessage', () => {
      expect(isValidPersistedQueueState({
        ...validState,
        currentMessage: { invalid: true },
      })).toBe(false);
    });

    it('should return false for non-array history', () => {
      expect(isValidPersistedQueueState({ ...validState, history: 'not-array' })).toBe(false);
    });

    it('should return false for invalid message in history', () => {
      expect(isValidPersistedQueueState({
        ...validState,
        history: [{ id: 'x', content: 'x', conversationId: 'c', source: 'bad-source', status: 'completed', enqueuedAt: 'now' }],
      })).toBe(false);
    });

    it('should return false for negative totalProcessed', () => {
      expect(isValidPersistedQueueState({ ...validState, totalProcessed: -1 })).toBe(false);
    });

    it('should return false for negative totalFailed', () => {
      expect(isValidPersistedQueueState({ ...validState, totalFailed: -1 })).toBe(false);
    });
  });
});
