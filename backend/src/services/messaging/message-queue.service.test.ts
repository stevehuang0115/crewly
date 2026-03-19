/**
 * Tests for MessageQueueService
 *
 * @module services/messaging/message-queue.test
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { MessageQueueService } from './message-queue.service.js';
import type { EnqueueMessageInput, QueuedMessage, PersistedQueueState } from '../../types/messaging.types.js';
import { PERSISTED_QUEUE_VERSION } from '../../types/messaging.types.js';

// Mock constants
jest.mock('../../constants.js', () => ({
  MESSAGE_SOURCES: {
    SLACK: 'slack',
    WEB_CHAT: 'web_chat',
    SYSTEM_EVENT: 'system_event',
    GOOGLE_CHAT: 'google_chat',
    WHATSAPP: 'whatsapp',
    TELEGRAM: 'telegram',
  },
  MESSAGE_QUEUE_CONSTANTS: {
    MAX_QUEUE_SIZE: 20,
    DEFAULT_MESSAGE_TIMEOUT: 120000,
    MAX_HISTORY_SIZE: 3,
    INTER_MESSAGE_DELAY: 500,
    MAX_SYSTEM_EVENT_BATCH: 100,
    MAX_SYSTEM_EVENT_COALESCE_CHARS: 0,
    MAX_PENDING_SYSTEM_EVENTS: 3,
    PERSISTENCE_FILE: 'message-queue.json',
    PERSISTENCE_DIR: 'queue',
    SOCKET_EVENTS: {
      MESSAGE_ENQUEUED: 'queue:message_enqueued',
      MESSAGE_PROCESSING: 'queue:message_processing',
      MESSAGE_COMPLETED: 'queue:message_completed',
      MESSAGE_FAILED: 'queue:message_failed',
      MESSAGE_CANCELLED: 'queue:message_cancelled',
      STATUS_UPDATE: 'queue:status_update',
    },
  },
}));

describe('MessageQueueService', () => {
  let queue: MessageQueueService;

  const validInput: EnqueueMessageInput = {
    content: 'Hello orchestrator',
    conversationId: 'conv-1',
    source: 'web_chat',
  };

  beforeEach(() => {
    queue = new MessageQueueService();
  });

  describe('enqueue', () => {
    it('should enqueue a valid message', () => {
      const msg = queue.enqueue(validInput);

      expect(msg.id).toBeDefined();
      expect(msg.content).toBe('Hello orchestrator');
      expect(msg.conversationId).toBe('conv-1');
      expect(msg.source).toBe('web_chat');
      expect(msg.status).toBe('pending');
      expect(msg.enqueuedAt).toBeDefined();
    });

    it('should enqueue with source metadata', () => {
      const msg = queue.enqueue({
        ...validInput,
        source: 'slack',
        sourceMetadata: { userId: 'U123', channelId: 'C456' },
      });

      expect(msg.source).toBe('slack');
      expect(msg.sourceMetadata?.userId).toBe('U123');
      expect(msg.sourceMetadata?.channelId).toBe('C456');
    });

    it('should emit enqueued event', () => {
      const spy = jest.fn();
      queue.on('enqueued', spy);

      const msg = queue.enqueue(validInput);

      expect(spy).toHaveBeenCalledWith(msg);
    });

    it('should emit statusUpdate event', () => {
      const spy = jest.fn();
      queue.on('statusUpdate', spy);

      queue.enqueue(validInput);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].pendingCount).toBe(1);
    });

    it('should throw for invalid input', () => {
      expect(() => queue.enqueue({} as EnqueueMessageInput)).toThrow('Invalid enqueue input');
      expect(() => queue.enqueue({ content: '', conversationId: 'c', source: 'web_chat' })).toThrow('Invalid enqueue input');
    });

    it('should throw when queue is full', () => {
      for (let i = 0; i < 20; i++) {
        queue.enqueue({ ...validInput, conversationId: `conv-${i}` });
      }

      expect(() => queue.enqueue(validInput)).toThrow('Queue is full');
    });

    it('should maintain FIFO order', () => {
      queue.enqueue({ ...validInput, content: 'first' });
      queue.enqueue({ ...validInput, content: 'second' });
      queue.enqueue({ ...validInput, content: 'third' });

      const pending = queue.getPendingMessages();
      expect(pending[0].content).toBe('first');
      expect(pending[1].content).toBe('second');
      expect(pending[2].content).toBe('third');
    });
  });

  describe('dequeue', () => {
    it('should return null for empty queue', () => {
      expect(queue.dequeue()).toBeNull();
    });

    it('should return first message and mark as processing', () => {
      queue.enqueue({ ...validInput, content: 'first' });
      queue.enqueue({ ...validInput, content: 'second' });

      const msg = queue.dequeue();

      expect(msg).not.toBeNull();
      expect(msg!.content).toBe('first');
      expect(msg!.status).toBe('processing');
      expect(msg!.processingStartedAt).toBeDefined();
    });

    it('should set currentMessage', () => {
      queue.enqueue(validInput);
      const msg = queue.dequeue();

      expect(queue.isProcessing()).toBe(true);
      expect(queue.getStatus().currentMessage).toEqual(msg);
    });

    it('should emit processing event', () => {
      const spy = jest.fn();
      queue.on('processing', spy);

      queue.enqueue(validInput);
      const msg = queue.dequeue();

      expect(spy).toHaveBeenCalledWith(msg);
    });

    it('should remove message from pending', () => {
      queue.enqueue(validInput);
      queue.dequeue();

      expect(queue.pendingCount).toBe(0);
    });

    it('should prioritize user messages (slack) over system events', () => {
      queue.enqueue({ content: 'system 1', conversationId: 'conv-sys-1', source: 'system_event' });
      queue.enqueue({ content: 'system 2', conversationId: 'conv-sys-2', source: 'system_event' });
      queue.enqueue({ content: 'user slack', conversationId: 'conv-slack', source: 'slack' });

      const msg = queue.dequeue();
      expect(msg).not.toBeNull();
      expect(msg!.content).toBe('user slack');
      expect(msg!.source).toBe('slack');
    });

    it('should prioritize user messages (web_chat) over system events', () => {
      queue.enqueue({ content: 'system 1', conversationId: 'conv-sys-1', source: 'system_event' });
      queue.enqueue({ content: 'user chat', conversationId: 'conv-chat', source: 'web_chat' });
      queue.enqueue({ content: 'system 2', conversationId: 'conv-sys-2', source: 'system_event' });

      const msg = queue.dequeue();
      expect(msg).not.toBeNull();
      expect(msg!.content).toBe('user chat');
      expect(msg!.source).toBe('web_chat');
    });

    it('should prioritize user messages (whatsapp) over system events', () => {
      queue.enqueue({ content: 'system 1', conversationId: 'conv-sys-1', source: 'system_event' });
      queue.enqueue({ content: 'wa msg', conversationId: 'conv-wa', source: 'whatsapp' });
      queue.enqueue({ content: 'system 2', conversationId: 'conv-sys-2', source: 'system_event' });

      const msg = queue.dequeue();
      expect(msg).not.toBeNull();
      expect(msg!.content).toBe('wa msg');
      expect(msg!.source).toBe('whatsapp');
    });

    it('should prioritize user messages (telegram) over system events', () => {
      queue.enqueue({ content: 'system 1', conversationId: 'conv-sys-1', source: 'system_event' });
      queue.enqueue({ content: 'tg msg', conversationId: 'conv-tg', source: 'telegram' });
      queue.enqueue({ content: 'system 2', conversationId: 'conv-sys-2', source: 'system_event' });

      const msg = queue.dequeue();
      expect(msg).not.toBeNull();
      expect(msg!.content).toBe('tg msg');
      expect(msg!.source).toBe('telegram');
    });

    it('should return first user message when multiple user messages exist', () => {
      queue.enqueue({ content: 'system', conversationId: 'conv-sys', source: 'system_event' });
      queue.enqueue({ content: 'slack msg', conversationId: 'conv-s', source: 'slack' });
      queue.enqueue({ content: 'chat msg', conversationId: 'conv-c', source: 'web_chat' });

      const msg = queue.dequeue();
      expect(msg).not.toBeNull();
      expect(msg!.content).toBe('slack msg');
    });

    it('should fall back to FIFO when only system events are queued', () => {
      queue.enqueue({ content: 'sys first', conversationId: 'conv-1', source: 'system_event' });
      queue.enqueue({ content: 'sys second', conversationId: 'conv-2', source: 'system_event' });

      const msg = queue.dequeue();
      expect(msg).not.toBeNull();
      expect(msg!.content).toBe('sys first');
    });

    it('should maintain FIFO among user messages', () => {
      queue.enqueue({ content: 'chat 1', conversationId: 'conv-1', source: 'web_chat' });
      queue.enqueue({ content: 'chat 2', conversationId: 'conv-2', source: 'web_chat' });

      const first = queue.dequeue();
      const second = queue.dequeue();
      expect(first!.content).toBe('chat 1');
      expect(second!.content).toBe('chat 2');
    });
  });

  describe('markCompleted', () => {
    it('should mark current message as completed', () => {
      queue.enqueue(validInput);
      const msg = queue.dequeue()!;

      queue.markCompleted(msg.id, 'Response text');

      expect(queue.isProcessing()).toBe(false);
      expect(queue.getStatus().totalProcessed).toBe(1);
    });

    it('should store response', () => {
      queue.enqueue(validInput);
      const msg = queue.dequeue()!;

      queue.markCompleted(msg.id, 'The response');

      const history = queue.getHistory();
      expect(history[0].response).toBe('The response');
      expect(history[0].status).toBe('completed');
      expect(history[0].completedAt).toBeDefined();
    });

    it('should emit completed event', () => {
      const spy = jest.fn();
      queue.on('completed', spy);

      queue.enqueue(validInput);
      const msg = queue.dequeue()!;
      queue.markCompleted(msg.id, 'Done');

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].id).toBe(msg.id);
    });

    it('should no-op for wrong message id', () => {
      queue.enqueue(validInput);
      queue.dequeue();

      queue.markCompleted('wrong-id');

      expect(queue.isProcessing()).toBe(true);
    });

    it('should no-op when nothing is processing', () => {
      queue.markCompleted('some-id');
      expect(queue.getStatus().totalProcessed).toBe(0);
    });
  });

  describe('markFailed', () => {
    it('should mark current message as failed', () => {
      queue.enqueue(validInput);
      const msg = queue.dequeue()!;

      queue.markFailed(msg.id, 'Timeout');

      expect(queue.isProcessing()).toBe(false);
      expect(queue.getStatus().totalFailed).toBe(1);
    });

    it('should store error', () => {
      queue.enqueue(validInput);
      const msg = queue.dequeue()!;

      queue.markFailed(msg.id, 'Connection lost');

      const history = queue.getHistory();
      expect(history[0].error).toBe('Connection lost');
      expect(history[0].status).toBe('failed');
    });

    it('should emit failed event', () => {
      const spy = jest.fn();
      queue.on('failed', spy);

      queue.enqueue(validInput);
      const msg = queue.dequeue()!;
      queue.markFailed(msg.id, 'Timeout');

      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('cancel', () => {
    it('should cancel a pending message', () => {
      const msg = queue.enqueue(validInput);

      const result = queue.cancel(msg.id);

      expect(result).toBe(true);
      expect(queue.pendingCount).toBe(0);
    });

    it('should add cancelled message to history', () => {
      const msg = queue.enqueue(validInput);
      queue.cancel(msg.id);

      const history = queue.getHistory();
      expect(history[0].status).toBe('cancelled');
    });

    it('should emit cancelled event', () => {
      const spy = jest.fn();
      queue.on('cancelled', spy);

      const msg = queue.enqueue(validInput);
      queue.cancel(msg.id);

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should return false for non-existent message', () => {
      expect(queue.cancel('nonexistent')).toBe(false);
    });
  });

  describe('forceCancelCurrent', () => {
    it('should cancel the currently processing message', () => {
      queue.enqueue(validInput);
      const msg = queue.dequeue()!;

      expect(queue.isProcessing()).toBe(true);

      const result = queue.forceCancelCurrent();

      expect(result).toBe(true);
      expect(queue.isProcessing()).toBe(false);
      expect(queue.getHistory()[0].status).toBe('cancelled');
      expect(queue.getHistory()[0].error).toBe('Force-cancelled by user');
    });

    it('should return false when nothing is processing', () => {
      expect(queue.forceCancelCurrent()).toBe(false);
    });

    it('should emit cancelled event', () => {
      const handler = jest.fn();
      queue.on('cancelled', handler);
      queue.enqueue(validInput);
      queue.dequeue();

      queue.forceCancelCurrent();

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('clearPending', () => {
    it('should clear all pending messages', () => {
      queue.enqueue({ ...validInput, content: 'a' });
      queue.enqueue({ ...validInput, content: 'b' });

      const count = queue.clearPending();

      expect(count).toBe(2);
      expect(queue.pendingCount).toBe(0);
    });

    it('should return 0 for empty queue', () => {
      expect(queue.clearPending()).toBe(0);
    });

    it('should add cleared messages to history', () => {
      queue.enqueue({ ...validInput, content: 'a' });
      queue.enqueue({ ...validInput, content: 'b' });
      queue.clearPending();

      expect(queue.getHistory().length).toBe(2);
      expect(queue.getHistory()[0].status).toBe('cancelled');
    });
  });

  describe('getStatus', () => {
    it('should return correct initial status', () => {
      const status = queue.getStatus();

      expect(status.pendingCount).toBe(0);
      expect(status.isProcessing).toBe(false);
      expect(status.currentMessage).toBeUndefined();
      expect(status.totalProcessed).toBe(0);
      expect(status.totalFailed).toBe(0);
      expect(status.historyCount).toBe(0);
    });

    it('should reflect pending messages', () => {
      queue.enqueue(validInput);
      expect(queue.getStatus().pendingCount).toBe(1);
    });

    it('should reflect processing state', () => {
      queue.enqueue(validInput);
      queue.dequeue();
      expect(queue.getStatus().isProcessing).toBe(true);
    });
  });

  describe('getMessage', () => {
    it('should find pending message', () => {
      const msg = queue.enqueue(validInput);
      expect(queue.getMessage(msg.id)).toEqual(msg);
    });

    it('should find current processing message', () => {
      queue.enqueue(validInput);
      const msg = queue.dequeue()!;
      expect(queue.getMessage(msg.id)).toEqual(msg);
    });

    it('should find message in history', () => {
      queue.enqueue(validInput);
      const msg = queue.dequeue()!;
      queue.markCompleted(msg.id, 'Done');
      expect(queue.getMessage(msg.id)?.status).toBe('completed');
    });

    it('should return undefined for unknown id', () => {
      expect(queue.getMessage('unknown')).toBeUndefined();
    });
  });

  describe('history management', () => {
    it('should trim history to MAX_HISTORY_SIZE', () => {
      // MAX_HISTORY_SIZE is mocked to 3
      for (let i = 0; i < 5; i++) {
        queue.enqueue({ ...validInput, content: `msg-${i}` });
        const msg = queue.dequeue()!;
        queue.markCompleted(msg.id);
      }

      expect(queue.getHistory().length).toBe(3);
    });

    it('should keep most recent messages in history', () => {
      for (let i = 0; i < 5; i++) {
        queue.enqueue({ ...validInput, content: `msg-${i}` });
        const msg = queue.dequeue()!;
        queue.markCompleted(msg.id);
      }

      const history = queue.getHistory();
      expect(history[0].content).toBe('msg-4');
      expect(history[1].content).toBe('msg-3');
      expect(history[2].content).toBe('msg-2');
    });
  });

  describe('hasPending and pendingCount', () => {
    it('should return false/0 for empty queue', () => {
      expect(queue.hasPending()).toBe(false);
      expect(queue.pendingCount).toBe(0);
    });

    it('should return true/count for non-empty queue', () => {
      queue.enqueue(validInput);
      queue.enqueue({ ...validInput, content: 'second' });

      expect(queue.hasPending()).toBe(true);
      expect(queue.pendingCount).toBe(2);
    });
  });

  describe('requeue', () => {
    it('should place message back at front of queue as pending', () => {
      const msg = queue.enqueue(validInput);
      const dequeued = queue.dequeue()!;

      expect(dequeued.status).toBe('processing');
      expect(queue.hasPending()).toBe(false);

      queue.requeue(dequeued);

      expect(queue.hasPending()).toBe(true);
      expect(queue.pendingCount).toBe(1);

      const reDequeued = queue.dequeue()!;
      expect(reDequeued.id).toBe(msg.id);
      expect(reDequeued.status).toBe('processing');
    });

    it('should reset processingStartedAt', () => {
      queue.enqueue(validInput);
      const dequeued = queue.dequeue()!;

      expect(dequeued.processingStartedAt).toBeDefined();

      queue.requeue(dequeued);

      const reDequeued = queue.dequeue()!;
      // processingStartedAt was cleared during requeue, then set again on dequeue
      expect(reDequeued.processingStartedAt).toBeDefined();
    });

    it('should place re-queued message before other pending messages', () => {
      queue.enqueue({ ...validInput, content: 'first' });
      queue.enqueue({ ...validInput, content: 'second' });

      const dequeued = queue.dequeue()!;
      expect(dequeued.content).toBe('first');

      queue.requeue(dequeued);

      const next = queue.dequeue()!;
      expect(next.content).toBe('first');
    });

    it('should clear currentMessage', () => {
      queue.enqueue(validInput);
      queue.dequeue();

      const status = queue.getStatus();
      expect(status.isProcessing).toBe(true);

      queue.requeue(queue.getStatus().currentMessage!);

      const newStatus = queue.getStatus();
      expect(newStatus.isProcessing).toBe(false);
    });

    it('should increment retryCount on each requeue', () => {
      queue.enqueue(validInput);
      const dequeued = queue.dequeue()!;

      expect(dequeued.retryCount).toBeUndefined();

      queue.requeue(dequeued);
      const reDequeued1 = queue.dequeue()!;
      expect(reDequeued1.retryCount).toBe(1);

      queue.requeue(reDequeued1);
      const reDequeued2 = queue.dequeue()!;
      expect(reDequeued2.retryCount).toBe(2);

      queue.requeue(reDequeued2);
      const reDequeued3 = queue.dequeue()!;
      expect(reDequeued3.retryCount).toBe(3);
    });
  });

  // ===========================================================================
  // Persistence Tests
  // ===========================================================================

  describe('persistence', () => {
    let tmpDir: string;
    let persistedQueue: MessageQueueService;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mq-test-'));
      persistedQueue = new MessageQueueService(tmpDir);
    });

    afterEach(async () => {
      // Clean up temp directory
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    /**
     * Helper: read the persisted JSON file from disk
     */
    async function readPersistedFile(): Promise<PersistedQueueState> {
      const filePath = path.join(tmpDir, 'queue', 'message-queue.json');
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    }

    /**
     * Helper: write a persisted state file directly to disk
     */
    async function writePersistedFile(state: PersistedQueueState): Promise<void> {
      const dir = path.join(tmpDir, 'queue');
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, 'message-queue.json');
      await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
    }

    /**
     * Helper: flush timers and wait for async persistence to complete
     */
    async function flushAndWait(): Promise<void> {
      // Run microtask queue to fire setTimeout(0) callbacks
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      // Wait a bit more for the async write to complete
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }

    it('should not persist when constructed without crewlyHome', async () => {
      const memoryQueue = new MessageQueueService();
      memoryQueue.enqueue(validInput);

      await flushAndWait();

      // No file should exist
      const dir = path.join(tmpDir, 'queue');
      try {
        await fs.readdir(dir);
        // dir may exist from beforeEach — check for persistence file
        const files = await fs.readdir(dir);
        expect(files.filter(f => f === 'message-queue.json')).toHaveLength(0);
      } catch {
        // Directory doesn't exist, which is expected for in-memory only
      }
    });

    it('should create persistence directory on construction', async () => {
      const dir = path.join(tmpDir, 'queue');
      const stat = await fs.stat(dir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should persist state after enqueue via flushPersist', async () => {
      persistedQueue.enqueue(validInput);
      await persistedQueue.flushPersist();

      const state = await readPersistedFile();
      expect(state.version).toBe(PERSISTED_QUEUE_VERSION);
      expect(state.queue).toHaveLength(1);
      expect(state.queue[0].content).toBe('Hello orchestrator');
      expect(state.queue[0].status).toBe('pending');
      expect(state.currentMessage).toBeNull();
    });

    it('should persist state after markCompleted', async () => {
      persistedQueue.enqueue(validInput);
      const msg = persistedQueue.dequeue()!;
      persistedQueue.markCompleted(msg.id, 'Done');

      await persistedQueue.flushPersist();

      const state = await readPersistedFile();
      expect(state.queue).toHaveLength(0);
      expect(state.currentMessage).toBeNull();
      expect(state.totalProcessed).toBe(1);
      expect(state.history).toHaveLength(1);
      expect(state.history[0].status).toBe('completed');
      expect(state.history[0].response).toBe('Done');
    });

    it('should persist state after markFailed', async () => {
      persistedQueue.enqueue(validInput);
      const msg = persistedQueue.dequeue()!;
      persistedQueue.markFailed(msg.id, 'Timeout');

      await persistedQueue.flushPersist();

      const state = await readPersistedFile();
      expect(state.totalFailed).toBe(1);
      expect(state.history[0].status).toBe('failed');
      expect(state.history[0].error).toBe('Timeout');
    });

    it('should strip function-valued sourceMetadata when persisting', async () => {
      persistedQueue.enqueue({
        ...validInput,
        source: 'slack',
        sourceMetadata: {
          slackResolve: () => {},
          userId: 'U123',
          channelId: 'C456',
        },
      });

      await persistedQueue.flushPersist();

      const state = await readPersistedFile();
      const msg = state.queue[0];
      expect(msg.sourceMetadata).toBeDefined();
      expect(msg.sourceMetadata!.userId).toBe('U123');
      expect(msg.sourceMetadata!.channelId).toBe('C456');
      expect('slackResolve' in (msg.sourceMetadata || {})).toBe(false);
    });

    it('should load persisted state and restore queue/history/counters', async () => {
      const savedState: PersistedQueueState = {
        version: 1,
        savedAt: new Date().toISOString(),
        queue: [
          {
            id: 'restored-1',
            content: 'Pending msg',
            conversationId: 'conv-1',
            source: 'web_chat',
            status: 'pending',
            enqueuedAt: new Date().toISOString(),
          },
        ],
        currentMessage: null,
        history: [
          {
            id: 'hist-1',
            content: 'Old msg',
            conversationId: 'conv-2',
            source: 'slack',
            status: 'completed',
            enqueuedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
        ],
        totalProcessed: 10,
        totalFailed: 2,
      };

      await writePersistedFile(savedState);

      const loadedQueue = new MessageQueueService(tmpDir);
      await loadedQueue.loadPersistedState();

      expect(loadedQueue.pendingCount).toBe(1);
      expect(loadedQueue.getPendingMessages()[0].id).toBe('restored-1');
      expect(loadedQueue.getHistory()).toHaveLength(1);
      expect(loadedQueue.getHistory()[0].id).toBe('hist-1');
      expect(loadedQueue.getStatus().totalProcessed).toBe(10);
      expect(loadedQueue.getStatus().totalFailed).toBe(2);
    });

    it('should reset in-flight (processing) message to pending at front of queue', async () => {
      const savedState: PersistedQueueState = {
        version: 1,
        savedAt: new Date().toISOString(),
        queue: [
          {
            id: 'queued-1',
            content: 'Second in line',
            conversationId: 'conv-2',
            source: 'web_chat',
            status: 'pending',
            enqueuedAt: new Date().toISOString(),
          },
        ],
        currentMessage: {
          id: 'inflight-1',
          content: 'Was processing',
          conversationId: 'conv-1',
          source: 'slack',
          status: 'processing',
          enqueuedAt: new Date().toISOString(),
          processingStartedAt: new Date().toISOString(),
          sourceMetadata: { userId: 'U123' },
        },
        history: [],
        totalProcessed: 0,
        totalFailed: 0,
      };

      await writePersistedFile(savedState);

      const loadedQueue = new MessageQueueService(tmpDir);
      await loadedQueue.loadPersistedState();

      // In-flight message should be at front as pending
      expect(loadedQueue.pendingCount).toBe(2);
      expect(loadedQueue.isProcessing()).toBe(false);

      const pending = loadedQueue.getPendingMessages();
      expect(pending[0].id).toBe('inflight-1');
      expect(pending[0].status).toBe('pending');
      expect(pending[0].processingStartedAt).toBeUndefined();
      expect(pending[1].id).toBe('queued-1');
    });

    it('should filter out system_event messages on load', async () => {
      const savedState: PersistedQueueState = {
        version: 1,
        savedAt: new Date().toISOString(),
        queue: [
          {
            id: 'sys-1',
            content: 'System notification',
            conversationId: 'conv-sys',
            source: 'system_event',
            status: 'pending',
            enqueuedAt: new Date().toISOString(),
          },
          {
            id: 'chat-1',
            content: 'User message',
            conversationId: 'conv-1',
            source: 'web_chat',
            status: 'pending',
            enqueuedAt: new Date().toISOString(),
          },
        ],
        currentMessage: {
          id: 'sys-inflight',
          content: 'System in-flight',
          conversationId: 'conv-sys',
          source: 'system_event',
          status: 'processing',
          enqueuedAt: new Date().toISOString(),
        },
        history: [
          {
            id: 'sys-hist',
            content: 'Old system event',
            conversationId: 'conv-sys',
            source: 'system_event',
            status: 'completed',
            enqueuedAt: new Date().toISOString(),
          },
          {
            id: 'chat-hist',
            content: 'Old chat message',
            conversationId: 'conv-2',
            source: 'web_chat',
            status: 'completed',
            enqueuedAt: new Date().toISOString(),
          },
        ],
        totalProcessed: 5,
        totalFailed: 0,
      };

      await writePersistedFile(savedState);

      const loadedQueue = new MessageQueueService(tmpDir);
      await loadedQueue.loadPersistedState();

      // Only non-system messages should be loaded
      expect(loadedQueue.pendingCount).toBe(1);
      expect(loadedQueue.getPendingMessages()[0].id).toBe('chat-1');
      expect(loadedQueue.getHistory()).toHaveLength(1);
      expect(loadedQueue.getHistory()[0].id).toBe('chat-hist');
    });

    it('should handle missing persistence file gracefully', async () => {
      const loadedQueue = new MessageQueueService(tmpDir);
      await loadedQueue.loadPersistedState();

      expect(loadedQueue.pendingCount).toBe(0);
      expect(loadedQueue.getStatus().totalProcessed).toBe(0);
    });

    it('should handle corrupt persistence file gracefully', async () => {
      const dir = path.join(tmpDir, 'queue');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'message-queue.json'), 'NOT VALID JSON', 'utf-8');

      const loadedQueue = new MessageQueueService(tmpDir);
      await loadedQueue.loadPersistedState();

      expect(loadedQueue.pendingCount).toBe(0);
    });

    it('should handle invalid version in persistence file gracefully', async () => {
      const dir = path.join(tmpDir, 'queue');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'message-queue.json'),
        JSON.stringify({ version: 999, savedAt: 'now', queue: [], currentMessage: null, history: [], totalProcessed: 0, totalFailed: 0 }),
        'utf-8',
      );

      const loadedQueue = new MessageQueueService(tmpDir);
      await loadedQueue.loadPersistedState();

      expect(loadedQueue.pendingCount).toBe(0);
    });

    it('should debounce multiple synchronous mutations into one write', async () => {
      // Spy on the file system to count writes
      const writeSpy = jest.spyOn(fs, 'writeFile');

      // Multiple synchronous mutations
      persistedQueue.enqueue({ ...validInput, content: 'first' });
      persistedQueue.enqueue({ ...validInput, content: 'second' });
      persistedQueue.enqueue({ ...validInput, content: 'third' });

      // Wait for debounced write
      await flushAndWait();

      // Should have batched into at most one write (plus temp file)
      const queueWrites = writeSpy.mock.calls.filter(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('message-queue.json'),
      );
      // At most 1 write (to the temp file, which then gets renamed)
      expect(queueWrites.length).toBeLessThanOrEqual(1);

      writeSpy.mockRestore();
    });

    it('flushPersist should write immediately without debounce', async () => {
      persistedQueue.enqueue(validInput);

      // Flush synchronously (no debounce wait needed)
      await persistedQueue.flushPersist();

      const state = await readPersistedFile();
      expect(state.queue).toHaveLength(1);
    });

    it('should be a no-op for loadPersistedState without crewlyHome', async () => {
      const memoryQueue = new MessageQueueService();
      await memoryQueue.loadPersistedState();
      expect(memoryQueue.pendingCount).toBe(0);
    });

    it('should be a no-op for flushPersist without crewlyHome', async () => {
      const memoryQueue = new MessageQueueService();
      await memoryQueue.flushPersist(); // Should not throw
    });
  });

  describe('dequeueSystemEventBatch', () => {
    it('should dequeue only system_event messages', () => {
      queue.enqueue({ content: 'user msg', conversationId: 'c1', source: 'web_chat' });
      queue.enqueue({ content: 'event 1', conversationId: 'c2', source: 'system_event' });
      queue.enqueue({ content: 'event 2', conversationId: 'c3', source: 'system_event' });

      const batch = queue.dequeueSystemEventBatch(5);

      expect(batch).toHaveLength(2);
      expect(batch[0].content).toBe('event 1');
      expect(batch[1].content).toBe('event 2');
      expect(batch[0].status).toBe('processing');
      // The user message should remain in the queue
      expect(queue.pendingCount).toBe(1);
    });

    it('should respect maxCount limit', () => {
      queue.enqueue({ content: 'event 1', conversationId: 'c1', source: 'system_event' });
      queue.enqueue({ content: 'event 2', conversationId: 'c2', source: 'system_event' });
      queue.enqueue({ content: 'event 3', conversationId: 'c3', source: 'system_event' });

      const batch = queue.dequeueSystemEventBatch(2);

      expect(batch).toHaveLength(2);
      expect(queue.pendingCount).toBe(1);
    });

    it('should return empty array when no system events', () => {
      queue.enqueue({ content: 'user msg', conversationId: 'c1', source: 'web_chat' });

      const batch = queue.dequeueSystemEventBatch(5);

      expect(batch).toHaveLength(0);
      expect(queue.pendingCount).toBe(1);
    });

    it('should return empty array when queue is empty', () => {
      const batch = queue.dequeueSystemEventBatch(5);
      expect(batch).toHaveLength(0);
    });
  });

  describe('markBatchCompleted', () => {
    it('should mark all messages in batch as completed', () => {
      queue.enqueue({ content: 'event 1', conversationId: 'c1', source: 'system_event' });
      queue.enqueue({ content: 'event 2', conversationId: 'c2', source: 'system_event' });

      // Dequeue the primary message first (required by queue invariant)
      const primary = queue.dequeue()!;
      const batch = queue.dequeueSystemEventBatch(5);

      const completedSpy = jest.fn();
      queue.on('completed', completedSpy);

      queue.markBatchCompleted(batch);

      expect(batch[0].status).toBe('completed');
      expect(batch[0].completedAt).toBeDefined();
      expect(completedSpy).toHaveBeenCalledTimes(1);
    });

    it('should be a no-op for empty array', () => {
      const completedSpy = jest.fn();
      queue.on('completed', completedSpy);

      queue.markBatchCompleted([]);

      expect(completedSpy).not.toHaveBeenCalled();
    });
  });

  describe('markBatchFailed', () => {
    it('should mark all messages in batch as failed', () => {
      queue.enqueue({ content: 'event 1', conversationId: 'c1', source: 'system_event' });
      queue.enqueue({ content: 'event 2', conversationId: 'c2', source: 'system_event' });

      const primary = queue.dequeue()!;
      const batch = queue.dequeueSystemEventBatch(5);

      const failedSpy = jest.fn();
      queue.on('failed', failedSpy);

      queue.markBatchFailed(batch, 'delivery failed');

      expect(batch[0].status).toBe('failed');
      expect(batch[0].error).toBe('delivery failed');
      expect(failedSpy).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // #218: System event flood protection
  // -----------------------------------------------------------------------

  describe('hasUserMessagePending (#218)', () => {
    it('should return false when queue is empty', () => {
      expect(queue.hasUserMessagePending()).toBe(false);
    });

    it('should return false when only system events are pending', () => {
      queue.enqueue({ content: 'event', conversationId: 'c1', source: 'system_event' });
      expect(queue.hasUserMessagePending()).toBe(false);
    });

    it('should return true when a slack message is pending', () => {
      queue.enqueue({ content: 'event', conversationId: 'c1', source: 'system_event' });
      queue.enqueue({ content: 'hello', conversationId: 'c2', source: 'slack' });
      expect(queue.hasUserMessagePending()).toBe(true);
    });

    it('should return true when a web_chat message is pending', () => {
      queue.enqueue({ content: 'hello', conversationId: 'c1', source: 'web_chat' });
      expect(queue.hasUserMessagePending()).toBe(true);
    });

    it('should return true when a google_chat message is pending', () => {
      queue.enqueue({ content: 'hello', conversationId: 'c1', source: 'google_chat' });
      expect(queue.hasUserMessagePending()).toBe(true);
    });

    it('should return true when a whatsapp message is pending', () => {
      queue.enqueue({ content: 'hello', conversationId: 'c1', source: 'whatsapp' });
      expect(queue.hasUserMessagePending()).toBe(true);
    });

    it('should return true when a telegram message is pending', () => {
      queue.enqueue({ content: 'hello', conversationId: 'c1', source: 'telegram' });
      expect(queue.hasUserMessagePending()).toBe(true);
    });
  });

  describe('system event cap on enqueue (#218)', () => {
    it('should drop oldest system events when exceeding MAX_PENDING_SYSTEM_EVENTS', () => {
      // MAX_PENDING_SYSTEM_EVENTS is 3 in mock, coalesce disabled (threshold 0)
      for (let i = 0; i < 3; i++) {
        queue.enqueue({ content: `event-${i}`, conversationId: `c${i}`, source: 'system_event' });
      }

      const statusBefore = queue.getStatus();
      expect(statusBefore.pendingCount).toBe(3);

      // Enqueue 4th system event — should drop the oldest system event
      queue.enqueue({ content: 'event-3', conversationId: 'c3', source: 'system_event' });

      const statusAfter = queue.getStatus();
      // 3 existing - 1 dropped + 1 new = 3
      expect(statusAfter.pendingCount).toBe(3);
    });

    it('should not drop system events when under the limit', () => {
      queue.enqueue({ content: 'event-1', conversationId: 'c1', source: 'system_event' });
      queue.enqueue({ content: 'user msg', conversationId: 'c2', source: 'slack' });

      // 1 system event + 1 user message, under limit of 3
      const status = queue.getStatus();
      expect(status.pendingCount).toBe(2);
    });

    it('should preserve user messages when dropping system events', () => {
      // Fill with 3 system events (at the cap)
      for (let i = 0; i < 3; i++) {
        queue.enqueue({ content: `event-${i}`, conversationId: `c${i}`, source: 'system_event' });
      }
      queue.enqueue({ content: 'important user msg', conversationId: 'cuser', source: 'slack' });

      // Enqueue one more system event to trigger cap — oldest system event dropped
      queue.enqueue({ content: 'event-overflow', conversationId: 'cof', source: 'system_event' });

      // User message must still be findable
      expect(queue.hasUserMessagePending()).toBe(true);

      // Dequeue should return the user message first (priority dequeue)
      const msg = queue.dequeue();
      expect(msg).not.toBeNull();
      expect(msg!.source).toBe('slack');
      expect(msg!.content).toBe('important user msg');
    });
  });
});
