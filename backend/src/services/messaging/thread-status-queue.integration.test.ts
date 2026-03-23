/**
 * Thread Status Queue — Integration Tests
 *
 * Tests the full lifecycle: enqueue → deliver → reply → recovery
 * Verifies all wiring points work together correctly.
 *
 * @module services/messaging/thread-status-queue.integration.test
 */

import { ResponseRouterService } from './response-router.service.js';
import { ThreadStatusQueueService } from './thread-status-queue.service.js';
import type { QueuedMessage } from '../../types/messaging.types.js';
import type { ThreadStatusEntry } from '../../types/thread-status.types.js';

// Mock LoggerService
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

// Mock file I/O — no actual disk writes during tests
jest.mock('../../utils/file-io.utils.js', () => ({
  atomicWriteFile: jest.fn().mockResolvedValue(undefined),
  safeReadJson: jest.fn().mockResolvedValue({
    version: 1,
    entries: [],
    lastCleanupAt: new Date().toISOString(),
  }),
}));

describe('Thread Status Queue Integration', () => {
  let tsq: ThreadStatusQueueService;
  let responseRouter: ResponseRouterService;

  const CHANNEL_ID = 'C0123456';
  const THREAD_TS = '1707430000.001234';
  const THREAD_KEY = `${CHANNEL_ID}:${THREAD_TS}`;
  const CONVERSATION_ID = 'conv-abc-123';

  const createSlackMessage = (overrides: Partial<QueuedMessage> = {}): QueuedMessage => ({
    id: 'msg-1',
    content: 'Deploy the new feature',
    conversationId: CONVERSATION_ID,
    source: 'slack',
    status: 'completed',
    enqueuedAt: new Date().toISOString(),
    sourceMetadata: {
      channelId: CHANNEL_ID,
      threadTs: THREAD_TS,
      userId: 'U999',
    },
    ...overrides,
  });

  beforeEach(() => {
    ThreadStatusQueueService.resetInstance();
    tsq = ThreadStatusQueueService.getInstance();
    tsq.init('/tmp/test-crewly');

    responseRouter = new ResponseRouterService();
    responseRouter.setThreadStatusQueue(tsq);
  });

  afterEach(() => {
    tsq.destroy();
  });

  // ===========================================================================
  // Full Lifecycle
  // ===========================================================================

  describe('full lifecycle: enqueue → deliver → reply', () => {
    it('should transition through all states to replied_completed', () => {
      // 1. Track inbound
      const entry = tsq.trackInbound({
        source: 'slack',
        threadKey: THREAD_KEY,
        conversationId: CONVERSATION_ID,
        messagePreview: 'Deploy the new feature',
        sourceMetadata: { channelId: CHANNEL_ID, threadTs: THREAD_TS, userId: 'U999' },
      });

      expect(entry.status).toBe('enqueued');
      expect(entry.threadKey).toBe(THREAD_KEY);

      // 2. Mark delivered
      tsq.markDelivered(THREAD_KEY);
      const delivered = tsq.get(THREAD_KEY);
      expect(delivered?.status).toBe('delivered');
      expect(delivered?.deliveredAt).toBeDefined();

      // 3. Mark replied via ResponseRouter
      const message = createSlackMessage();
      responseRouter.routeResponse(message, 'Done! Feature deployed successfully.');

      const replied = tsq.get(THREAD_KEY);
      expect(replied?.status).toBe('replied_completed');
      expect(replied?.repliedAt).toBeDefined();
    });

    it('should detect delegation markers and set replied_waiting_actions', () => {
      tsq.trackInbound({
        source: 'slack',
        threadKey: THREAD_KEY,
        conversationId: CONVERSATION_ID,
        messagePreview: 'Fix the bug in authentication',
      });
      tsq.markDelivered(THREAD_KEY);

      const message = createSlackMessage();
      responseRouter.routeResponse(message, 'I have [DELEGATED] this to Sam for implementation.');

      const entry = tsq.get(THREAD_KEY);
      expect(entry?.status).toBe('replied_waiting_actions');
    });

    it('should detect follow-up question markers and set replied_to_follow_up', () => {
      tsq.trackInbound({
        source: 'slack',
        threadKey: THREAD_KEY,
        conversationId: CONVERSATION_ID,
        messagePreview: 'Update the API',
      });
      tsq.markDelivered(THREAD_KEY);

      const message = createSlackMessage();
      responseRouter.routeResponse(message, 'Which API endpoint should I update? Could you elaborate on the requirements?');

      const entry = tsq.get(THREAD_KEY);
      expect(entry?.status).toBe('replied_to_follow_up');
    });
  });

  // ===========================================================================
  // Delegation Completion
  // ===========================================================================

  describe('delegation completion flow', () => {
    it('should transition from replied_waiting_actions to replied_completed via markDelegationsComplete', () => {
      tsq.trackInbound({
        source: 'slack',
        threadKey: THREAD_KEY,
        conversationId: CONVERSATION_ID,
        messagePreview: 'Build the new dashboard',
      });
      tsq.markDelivered(THREAD_KEY);
      tsq.markReplied(THREAD_KEY, 'replied_waiting_actions');
      tsq.addDelegatedAgent(THREAD_KEY, 'agent-sam');

      expect(tsq.get(THREAD_KEY)?.delegatedAgents).toEqual(['agent-sam']);

      tsq.markDelegationsComplete(THREAD_KEY);
      expect(tsq.get(THREAD_KEY)?.status).toBe('replied_completed');
    });
  });

  // ===========================================================================
  // Recovery
  // ===========================================================================

  describe('startup recovery', () => {
    it('should return enqueued and delivered threads as pending', () => {
      // Create threads in various states
      tsq.trackInbound({
        source: 'slack',
        threadKey: 'ch1:ts1',
        conversationId: 'conv-1',
        messagePreview: 'Message 1 — still enqueued',
      });

      tsq.trackInbound({
        source: 'slack',
        threadKey: 'ch1:ts2',
        conversationId: 'conv-2',
        messagePreview: 'Message 2 — delivered',
      });
      tsq.markDelivered('ch1:ts2');

      tsq.trackInbound({
        source: 'slack',
        threadKey: 'ch1:ts3',
        conversationId: 'conv-3',
        messagePreview: 'Message 3 — completed',
      });
      tsq.markDelivered('ch1:ts3');
      tsq.markReplied('ch1:ts3', 'replied_completed');

      tsq.trackInbound({
        source: 'slack',
        threadKey: 'ch1:ts4',
        conversationId: 'conv-4',
        messagePreview: 'Message 4 — waiting actions',
      });
      tsq.markDelivered('ch1:ts4');
      tsq.markReplied('ch1:ts4', 'replied_waiting_actions');

      const pending = tsq.getPendingThreads();
      const pendingKeys = pending.map((e: ThreadStatusEntry) => e.threadKey).sort();

      // enqueued, delivered, and replied_waiting_actions are all non-terminal
      expect(pendingKeys).toEqual(['ch1:ts1', 'ch1:ts2', 'ch1:ts4']);

      // replied_completed is terminal — not included
      expect(pending.find((e: ThreadStatusEntry) => e.threadKey === 'ch1:ts3')).toBeUndefined();
    });

    it('should filter by status correctly', () => {
      tsq.trackInbound({
        source: 'slack',
        threadKey: 'ch1:ts1',
        conversationId: 'conv-1',
        messagePreview: 'Enqueued',
      });

      tsq.trackInbound({
        source: 'slack',
        threadKey: 'ch1:ts2',
        conversationId: 'conv-2',
        messagePreview: 'Delivered',
      });
      tsq.markDelivered('ch1:ts2');

      const enqueued = tsq.getByStatus('enqueued');
      expect(enqueued.length).toBe(1);
      expect(enqueued[0].threadKey).toBe('ch1:ts1');

      const delivered = tsq.getByStatus('delivered');
      expect(delivered.length).toBe(1);
      expect(delivered[0].threadKey).toBe('ch1:ts2');
    });
  });

  // ===========================================================================
  // ResponseRouter detectReplyStatus
  // ===========================================================================

  describe('detectReplyStatus', () => {
    it('should return replied_completed for empty response', () => {
      expect(responseRouter.detectReplyStatus('')).toBe('replied_completed');
    });

    it('should return replied_completed for normal response', () => {
      expect(responseRouter.detectReplyStatus('Task completed successfully.')).toBe('replied_completed');
    });

    it('should detect [DELEGATED] marker', () => {
      expect(responseRouter.detectReplyStatus('I have [DELEGATED] this task to Leo.')).toBe('replied_waiting_actions');
    });

    it('should detect [ASSIGNED] marker', () => {
      expect(responseRouter.detectReplyStatus('[ASSIGNED] to Sam for review.')).toBe('replied_waiting_actions');
    });

    it('should detect delegate-task marker', () => {
      expect(responseRouter.detectReplyStatus('Using delegate-task to assign this.')).toBe('replied_waiting_actions');
    });

    it('should detect "delegated to" marker (case-insensitive)', () => {
      expect(responseRouter.detectReplyStatus('Delegated to Sam for implementation.')).toBe('replied_waiting_actions');
    });

    it('should detect question mark as follow-up', () => {
      expect(responseRouter.detectReplyStatus('Which branch should I deploy?')).toBe('replied_to_follow_up');
    });

    it('should detect "could you" as follow-up', () => {
      expect(responseRouter.detectReplyStatus('Done with phase 1. Could you confirm the next step?')).toBe('replied_to_follow_up');
    });

    it('should prioritize delegation over follow-up', () => {
      // Contains both delegation and follow-up markers — delegation wins
      expect(responseRouter.detectReplyStatus('[DELEGATED] to Sam. Could you review?')).toBe('replied_waiting_actions');
    });
  });

  // ===========================================================================
  // Thread status not tracked (no threadKey) — graceful no-op
  // ===========================================================================

  describe('routeResponse without thread status queue', () => {
    it('should not throw when threadStatusQueue is not set', () => {
      const plainRouter = new ResponseRouterService();
      const message = createSlackMessage();
      expect(() => plainRouter.routeResponse(message, 'Response')).not.toThrow();
    });

    it('should not throw when response is empty (fire-and-forget)', () => {
      const message = createSlackMessage();
      // Empty response should not attempt to mark replied
      expect(() => responseRouter.routeResponse(message, '')).not.toThrow();
    });

    it('should not throw when message has no sourceMetadata', () => {
      const message = createSlackMessage({ sourceMetadata: undefined });
      expect(() => responseRouter.routeResponse(message, 'Response')).not.toThrow();
    });

    it('should not throw when channelId is missing', () => {
      const message = createSlackMessage({
        sourceMetadata: { userId: 'U999' }, // no channelId
      });
      expect(() => responseRouter.routeResponse(message, 'Response')).not.toThrow();
    });
  });

  // ===========================================================================
  // Expiry and Cleanup
  // ===========================================================================

  describe('expiry and cleanup', () => {
    it('should expire stale non-terminal threads', () => {
      // Create an entry and manually backdate its updatedAt
      tsq.trackInbound({
        source: 'slack',
        threadKey: THREAD_KEY,
        conversationId: CONVERSATION_ID,
        messagePreview: 'Old message',
      });

      const entry = tsq.get(THREAD_KEY)!;
      // Backdate to 31 minutes ago (stale timeout is 30 min)
      entry.updatedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();

      const expired = tsq.expireStale();
      expect(expired).toBe(1);
      expect(tsq.get(THREAD_KEY)?.status).toBe('expired');
    });

    it('should not expire terminal entries', () => {
      tsq.trackInbound({
        source: 'slack',
        threadKey: THREAD_KEY,
        conversationId: CONVERSATION_ID,
        messagePreview: 'Completed message',
      });
      tsq.markDelivered(THREAD_KEY);
      tsq.markReplied(THREAD_KEY, 'replied_completed');

      const entry = tsq.get(THREAD_KEY)!;
      entry.updatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      const expired = tsq.expireStale();
      expect(expired).toBe(0);
      expect(tsq.get(THREAD_KEY)?.status).toBe('replied_completed');
    });

    it('should clean up old terminal entries', () => {
      tsq.trackInbound({
        source: 'slack',
        threadKey: THREAD_KEY,
        conversationId: CONVERSATION_ID,
        messagePreview: 'Old completed message',
      });
      tsq.markDelivered(THREAD_KEY);
      tsq.markReplied(THREAD_KEY, 'replied_completed');

      const entry = tsq.get(THREAD_KEY)!;
      // Backdate to 25 hours ago (retention is 24 hours)
      entry.updatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

      const cleaned = tsq.cleanup();
      expect(cleaned).toBe(1);
      expect(tsq.get(THREAD_KEY)).toBeNull();
    });
  });

  // ===========================================================================
  // Stats
  // ===========================================================================

  describe('getStats', () => {
    it('should return accurate counts by status', () => {
      tsq.trackInbound({ source: 'slack', threadKey: 'a:1', conversationId: 'c1', messagePreview: 'm1' });
      tsq.trackInbound({ source: 'slack', threadKey: 'a:2', conversationId: 'c2', messagePreview: 'm2' });
      tsq.markDelivered('a:2');
      tsq.trackInbound({ source: 'slack', threadKey: 'a:3', conversationId: 'c3', messagePreview: 'm3' });
      tsq.markDelivered('a:3');
      tsq.markReplied('a:3', 'replied_completed');

      const stats = tsq.getStats();
      expect(stats.total).toBe(3);
      expect(stats.byStatus.enqueued).toBe(1);
      expect(stats.byStatus.delivered).toBe(1);
      expect(stats.byStatus.replied_completed).toBe(1);
      expect(stats.oldestPending).toBeDefined();
    });
  });
});
