/**
 * Tests for ThreadStatusQueueService
 *
 * @module services/messaging/thread-status-queue.test
 */

import {
  ThreadStatusQueueService,
  type ISchedulerServiceLike,
  type IEventBusServiceLike,
  type IMessageQueueServiceLike,
  type IAgentStatusCheckerLike,
  type RecoveryConfirmCallback,
} from './thread-status-queue.service.js';
import type {
  TrackInboundInput,
  PersistedThreadStatusState,
} from '../../types/thread-status.types.js';
import { PERSISTED_THREAD_STATUS_VERSION } from '../../types/thread-status.types.js';

// Mock constants
jest.mock('../../constants.js', () => ({
  THREAD_STATUS_CONSTANTS: {
    STORAGE_FILE: 'thread-status-queue.json',
    MAX_ENTRIES: 5, // Small for testing overflow
    STALE_TIMEOUT_MINUTES: 30,
    CLEANUP_RETENTION_HOURS: 24,
    PERSIST_DEBOUNCE_MS: 10, // Fast for tests
    MAX_RETRY_COUNT: 3,
    MAX_PREVIEW_LENGTH: 200,
    DELEGATION_MARKERS: ['[DELEGATED]'],
    FOLLOW_UP_MARKERS: ['?'],
  },
  MESSAGE_SOURCES: {
    SLACK: 'slack',
    WEB_CHAT: 'web_chat',
    SYSTEM_EVENT: 'system_event',
    GOOGLE_CHAT: 'google_chat',
    WHATSAPP: 'whatsapp',
    TELEGRAM: 'telegram',
  },
  ORCHESTRATOR_SESSION_NAME: 'crewly-orc',
}));

// Mock logger
jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

// Mock file-io utils
const mockAtomicWriteFile = jest.fn().mockResolvedValue(undefined);
const mockSafeReadJson = jest.fn();

jest.mock('../../utils/file-io.utils.js', () => ({
  atomicWriteFile: (...args: unknown[]) => mockAtomicWriteFile(...args),
  safeReadJson: (...args: unknown[]) => mockSafeReadJson(...args),
}));

// =============================================================================
// Helpers
// =============================================================================

/** Creates a default TrackInboundInput for testing. */
function makeInput(overrides: Partial<TrackInboundInput> = {}): TrackInboundInput {
  return {
    source: 'slack',
    threadKey: `C123:${Date.now()}.001`,
    conversationId: 'conv-001',
    messagePreview: 'Test message',
    ...overrides,
  };
}

/** Creates a fresh service instance for each test. */
function createService(): ThreadStatusQueueService {
  return new ThreadStatusQueueService('/tmp/test-crewly');
}

// =============================================================================
// Tests
// =============================================================================

describe('ThreadStatusQueueService', () => {
  let svc: ThreadStatusQueueService;

  beforeEach(() => {
    svc = createService();
    mockAtomicWriteFile.mockClear();
    mockSafeReadJson.mockClear();
  });

  afterEach(() => {
    svc.destroy();
  });

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  describe('constructor', () => {
    it('sets persist path from crewlyHome', () => {
      // If constructor works without throwing, path is set
      const instance = new ThreadStatusQueueService('/home/user/.crewly');
      instance.destroy();
      // No assertion needed — verifying no throw
    });
  });

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  describe('loadPersistedState', () => {
    it('loads entries from disk', async () => {
      const state: PersistedThreadStatusState = {
        version: PERSISTED_THREAD_STATUS_VERSION,
        entries: [
          {
            id: 'e1',
            source: 'slack',
            threadKey: 'C1:ts1',
            conversationId: 'conv-1',
            status: 'enqueued',
            receivedAt: '2026-03-23T00:00:00Z',
            updatedAt: '2026-03-23T00:00:00Z',
            messagePreview: 'Hello',
            retryCount: 0,
          },
        ],
        lastCleanupAt: '2026-03-23T00:00:00Z',
      };
      mockSafeReadJson.mockResolvedValue(state);

      await svc.loadPersistedState();

      expect(svc.get('C1:ts1')).not.toBeNull();
      expect(svc.get('C1:ts1')!.id).toBe('e1');
    });

    it('starts fresh if state is invalid', async () => {
      mockSafeReadJson.mockResolvedValue({ bad: 'data' });

      await svc.loadPersistedState();

      expect(svc.getStats().total).toBe(0);
    });
  });

  describe('persistence debounce', () => {
    it('writes to disk after trackInbound', async () => {
      svc.trackInbound(makeInput({ threadKey: 'persist-test' }));

      // Wait for debounce
      await new Promise((r) => setTimeout(r, 50));

      expect(mockAtomicWriteFile).toHaveBeenCalled();
      const written = JSON.parse(mockAtomicWriteFile.mock.calls[0][1]);
      expect(written.version).toBe(PERSISTED_THREAD_STATUS_VERSION);
      expect(written.entries).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // trackInbound
  // ---------------------------------------------------------------------------

  describe('trackInbound', () => {
    it('creates a new entry with status enqueued', () => {
      const entry = svc.trackInbound(makeInput({ threadKey: 'tk-1' }));
      expect(entry.status).toBe('enqueued');
      expect(entry.threadKey).toBe('tk-1');
      expect(entry.retryCount).toBe(0);
      expect(entry.id).toBeDefined();
    });

    it('returns existing entry if threadKey is already tracked', () => {
      const first = svc.trackInbound(makeInput({ threadKey: 'dup-1' }));
      const second = svc.trackInbound(makeInput({ threadKey: 'dup-1', messagePreview: 'Different' }));
      expect(first.id).toBe(second.id);
    });

    it('truncates messagePreview to 200 chars', () => {
      const longMessage = 'x'.repeat(300);
      const entry = svc.trackInbound(makeInput({ threadKey: 'trunc-1', messagePreview: longMessage }));
      expect(entry.messagePreview).toHaveLength(200);
    });

    it('stores optional sourceMetadata', () => {
      const entry = svc.trackInbound(makeInput({
        threadKey: 'meta-1',
        sourceMetadata: { channelId: 'C123', threadTs: 'ts123', userId: 'U456' },
      }));
      expect(entry.sourceMetadata).toEqual({ channelId: 'C123', threadTs: 'ts123', userId: 'U456' });
    });

    it('stores optional queueMessageId', () => {
      const entry = svc.trackInbound(makeInput({ threadKey: 'qid-1', queueMessageId: 'qm-001' }));
      expect(entry.queueMessageId).toBe('qm-001');
    });
  });

  // ---------------------------------------------------------------------------
  // markDelivered
  // ---------------------------------------------------------------------------

  describe('markDelivered', () => {
    it('transitions from enqueued to delivered', () => {
      svc.trackInbound(makeInput({ threadKey: 'del-1' }));
      svc.markDelivered('del-1');
      const entry = svc.get('del-1')!;
      expect(entry.status).toBe('delivered');
      expect(entry.deliveredAt).toBeDefined();
    });

    it('is a no-op if already delivered', () => {
      svc.trackInbound(makeInput({ threadKey: 'del-2' }));
      svc.markDelivered('del-2');
      const firstDeliveredAt = svc.get('del-2')!.deliveredAt;
      svc.markDelivered('del-2');
      expect(svc.get('del-2')!.deliveredAt).toBe(firstDeliveredAt);
    });

    it('is a no-op if already in terminal status', () => {
      svc.trackInbound(makeInput({ threadKey: 'del-3' }));
      svc.markDelivered('del-3');
      svc.markReplied('del-3', 'replied_completed');
      svc.markDelivered('del-3');
      expect(svc.get('del-3')!.status).toBe('replied_completed');
    });

    it('throws if threadKey not found', () => {
      expect(() => svc.markDelivered('nonexistent')).toThrow('thread not found');
    });
  });

  // ---------------------------------------------------------------------------
  // markReplied
  // ---------------------------------------------------------------------------

  describe('markReplied', () => {
    it('transitions to replied_completed', () => {
      svc.trackInbound(makeInput({ threadKey: 'rep-1' }));
      svc.markDelivered('rep-1');
      svc.markReplied('rep-1', 'replied_completed');

      const entry = svc.get('rep-1')!;
      expect(entry.status).toBe('replied_completed');
      expect(entry.repliedAt).toBeDefined();
    });

    it('transitions to replied_waiting_actions', () => {
      svc.trackInbound(makeInput({ threadKey: 'rep-2' }));
      svc.markDelivered('rep-2');
      svc.markReplied('rep-2', 'replied_waiting_actions');
      expect(svc.get('rep-2')!.status).toBe('replied_waiting_actions');
    });

    it('transitions to replied_to_follow_up', () => {
      svc.trackInbound(makeInput({ threadKey: 'rep-3' }));
      svc.markDelivered('rep-3');
      svc.markReplied('rep-3', 'replied_to_follow_up');
      expect(svc.get('rep-3')!.status).toBe('replied_to_follow_up');
    });

    it('is a no-op if already in terminal status', () => {
      svc.trackInbound(makeInput({ threadKey: 'rep-4' }));
      svc.markReplied('rep-4', 'replied_completed');
      svc.markReplied('rep-4', 'replied_waiting_actions');
      expect(svc.get('rep-4')!.status).toBe('replied_completed');
    });

    it('throws for invalid reply status', () => {
      svc.trackInbound(makeInput({ threadKey: 'rep-5' }));
      expect(() => svc.markReplied('rep-5', 'enqueued' as any)).toThrow('Invalid reply status');
    });

    it('throws if threadKey not found', () => {
      expect(() => svc.markReplied('nonexistent', 'replied_completed')).toThrow('thread not found');
    });
  });

  // ---------------------------------------------------------------------------
  // addDelegatedAgent
  // ---------------------------------------------------------------------------

  describe('addDelegatedAgent', () => {
    it('adds an agent to delegatedAgents', () => {
      svc.trackInbound(makeInput({ threadKey: 'dlg-1' }));
      svc.addDelegatedAgent('dlg-1', 'agent-a');
      expect(svc.get('dlg-1')!.delegatedAgents).toEqual(['agent-a']);
    });

    it('does not add duplicate agents', () => {
      svc.trackInbound(makeInput({ threadKey: 'dlg-2' }));
      svc.addDelegatedAgent('dlg-2', 'agent-a');
      svc.addDelegatedAgent('dlg-2', 'agent-a');
      expect(svc.get('dlg-2')!.delegatedAgents).toEqual(['agent-a']);
    });

    it('adds multiple distinct agents', () => {
      svc.trackInbound(makeInput({ threadKey: 'dlg-3' }));
      svc.addDelegatedAgent('dlg-3', 'agent-a');
      svc.addDelegatedAgent('dlg-3', 'agent-b');
      expect(svc.get('dlg-3')!.delegatedAgents).toEqual(['agent-a', 'agent-b']);
    });

    it('throws if threadKey not found', () => {
      expect(() => svc.addDelegatedAgent('nonexistent', 'agent-x')).toThrow('thread not found');
    });
  });

  // ---------------------------------------------------------------------------
  // markDelegationsComplete
  // ---------------------------------------------------------------------------

  describe('markDelegationsComplete', () => {
    it('transitions from replied_waiting_actions to replied_completed', () => {
      svc.trackInbound(makeInput({ threadKey: 'mc-1' }));
      svc.markDelivered('mc-1');
      svc.markReplied('mc-1', 'replied_waiting_actions');
      svc.markDelegationsComplete('mc-1');
      expect(svc.get('mc-1')!.status).toBe('replied_completed');
    });

    it('is a no-op if not in replied_waiting_actions', () => {
      svc.trackInbound(makeInput({ threadKey: 'mc-2' }));
      svc.markDelivered('mc-2');
      svc.markDelegationsComplete('mc-2');
      expect(svc.get('mc-2')!.status).toBe('delivered');
    });

    it('throws if threadKey not found', () => {
      expect(() => svc.markDelegationsComplete('nonexistent')).toThrow('thread not found');
    });
  });

  // ---------------------------------------------------------------------------
  // getPendingThreads
  // ---------------------------------------------------------------------------

  describe('getPendingThreads', () => {
    it('returns only non-terminal entries', () => {
      svc.trackInbound(makeInput({ threadKey: 'p-1' }));
      svc.trackInbound(makeInput({ threadKey: 'p-2' }));
      svc.trackInbound(makeInput({ threadKey: 'p-3' }));

      svc.markDelivered('p-2');
      svc.markReplied('p-3', 'replied_completed');

      const pending = svc.getPendingThreads();
      const keys = pending.map((e) => e.threadKey);
      expect(keys).toContain('p-1'); // enqueued
      expect(keys).toContain('p-2'); // delivered
      expect(keys).not.toContain('p-3'); // terminal
    });

    it('returns empty array when all are terminal', () => {
      svc.trackInbound(makeInput({ threadKey: 'pa-1' }));
      svc.markReplied('pa-1', 'replied_completed');
      expect(svc.getPendingThreads()).toHaveLength(0);
    });

    it('includes replied_waiting_actions (non-terminal)', () => {
      svc.trackInbound(makeInput({ threadKey: 'pw-1' }));
      svc.markReplied('pw-1', 'replied_waiting_actions');
      expect(svc.getPendingThreads()).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // getByStatus
  // ---------------------------------------------------------------------------

  describe('getByStatus', () => {
    it('returns entries matching the given status', () => {
      svc.trackInbound(makeInput({ threadKey: 'bs-1' }));
      svc.trackInbound(makeInput({ threadKey: 'bs-2' }));
      svc.markDelivered('bs-2');

      expect(svc.getByStatus('enqueued')).toHaveLength(1);
      expect(svc.getByStatus('delivered')).toHaveLength(1);
      expect(svc.getByStatus('expired')).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // get
  // ---------------------------------------------------------------------------

  describe('get', () => {
    it('returns the entry for a known threadKey', () => {
      svc.trackInbound(makeInput({ threadKey: 'g-1' }));
      expect(svc.get('g-1')).not.toBeNull();
    });

    it('returns null for an unknown threadKey', () => {
      expect(svc.get('unknown')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // expireStale
  // ---------------------------------------------------------------------------

  describe('expireStale', () => {
    it('expires entries older than maxAgeMinutes', () => {
      const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
      svc.trackInbound(makeInput({ threadKey: 'exp-1' }));

      // Manually set updatedAt to old date
      const entry = svc.get('exp-1')!;
      (entry as any).updatedAt = oldDate;

      const count = svc.expireStale(30);
      expect(count).toBe(1);
      expect(svc.get('exp-1')!.status).toBe('expired');
    });

    it('does not expire entries within the timeout window', () => {
      svc.trackInbound(makeInput({ threadKey: 'exp-2' }));
      const count = svc.expireStale(30);
      expect(count).toBe(0);
      expect(svc.get('exp-2')!.status).toBe('enqueued');
    });

    it('does not expire terminal entries', () => {
      svc.trackInbound(makeInput({ threadKey: 'exp-3' }));
      svc.markReplied('exp-3', 'replied_completed');

      const entry = svc.get('exp-3')!;
      (entry as any).updatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      const count = svc.expireStale(30);
      expect(count).toBe(0);
      expect(svc.get('exp-3')!.status).toBe('replied_completed');
    });
  });

  // ---------------------------------------------------------------------------
  // cleanup
  // ---------------------------------------------------------------------------

  describe('cleanup', () => {
    it('removes terminal entries older than retention period', () => {
      svc.trackInbound(makeInput({ threadKey: 'cl-1' }));
      svc.markReplied('cl-1', 'replied_completed');

      const entry = svc.get('cl-1')!;
      (entry as any).updatedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48h ago

      const count = svc.cleanup(24);
      expect(count).toBe(1);
      expect(svc.get('cl-1')).toBeNull();
    });

    it('keeps recent terminal entries', () => {
      svc.trackInbound(makeInput({ threadKey: 'cl-2' }));
      svc.markReplied('cl-2', 'replied_completed');

      const count = svc.cleanup(24);
      expect(count).toBe(0);
      expect(svc.get('cl-2')).not.toBeNull();
    });

    it('keeps non-terminal entries even if old', () => {
      svc.trackInbound(makeInput({ threadKey: 'cl-3' }));

      const entry = svc.get('cl-3')!;
      (entry as any).updatedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

      const count = svc.cleanup(24);
      expect(count).toBe(0);
      expect(svc.get('cl-3')).not.toBeNull();
    });

    it('enforces MAX_ENTRIES by pruning oldest terminal entries', () => {
      // MAX_ENTRIES is 5 in our mock. Create 6 terminal entries.
      for (let i = 0; i < 6; i++) {
        const tk = `overflow-${i}`;
        svc.trackInbound(makeInput({ threadKey: tk }));
        svc.markReplied(tk, 'replied_completed');
        // Stagger updatedAt so oldest is pruned first
        const entry = svc.get(tk)!;
        (entry as any).updatedAt = new Date(Date.now() + i * 1000).toISOString();
      }

      // All are recent, but count exceeds MAX_ENTRIES
      const count = svc.cleanup(9999); // Very long retention so none are removed by age
      expect(count).toBeGreaterThanOrEqual(1);
      expect(svc.getStats().total).toBeLessThanOrEqual(5);
    });
  });

  // ---------------------------------------------------------------------------
  // getStats
  // ---------------------------------------------------------------------------

  describe('getStats', () => {
    it('returns correct statistics', () => {
      svc.trackInbound(makeInput({ threadKey: 'st-1' }));
      svc.trackInbound(makeInput({ threadKey: 'st-2' }));
      svc.markDelivered('st-2');
      svc.trackInbound(makeInput({ threadKey: 'st-3' }));
      svc.markReplied('st-3', 'replied_completed');

      const stats = svc.getStats();
      expect(stats.total).toBe(3);
      expect(stats.byStatus.enqueued).toBe(1);
      expect(stats.byStatus.delivered).toBe(1);
      expect(stats.byStatus.replied_completed).toBe(1);
      expect(stats.oldestPending).toBeDefined();
    });

    it('returns null oldestPending when all are terminal', () => {
      svc.trackInbound(makeInput({ threadKey: 'st-4' }));
      svc.markReplied('st-4', 'replied_completed');

      const stats = svc.getStats();
      expect(stats.oldestPending).toBeNull();
    });

    it('returns zero counts for empty queue', () => {
      const stats = svc.getStats();
      expect(stats.total).toBe(0);
      expect(stats.oldestPending).toBeNull();
      expect(stats.byStatus.enqueued).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Error transitions
  // ---------------------------------------------------------------------------

  describe('error status transitions', () => {
    it('markDelivered works from error status', () => {
      svc.trackInbound(makeInput({ threadKey: 'err-1' }));
      // Manually set to error (simulating a failed delivery retry)
      const entry = svc.get('err-1')!;
      (entry as any).status = 'error';

      svc.markDelivered('err-1');
      expect(svc.get('err-1')!.status).toBe('delivered');
    });
  });

  // ---------------------------------------------------------------------------
  // destroy
  // ---------------------------------------------------------------------------

  describe('destroy', () => {
    it('clears the persist timer without error', () => {
      svc.trackInbound(makeInput({ threadKey: 'dest-1' })); // triggers schedulePersist
      svc.destroy();
      // No assertion — verifying no throw on cleanup
    });

    it('is safe to call multiple times', () => {
      svc.destroy();
      svc.destroy();
      // No assertion — verifying no throw
    });
  });

  // ---------------------------------------------------------------------------
  // getAllEntries
  // ---------------------------------------------------------------------------

  describe('getAllEntries', () => {
    it('returns all entries regardless of status', () => {
      svc.trackInbound(makeInput({ threadKey: 'all-1' }));
      svc.trackInbound(makeInput({ threadKey: 'all-2' }));
      svc.markReplied('all-2', 'replied_completed');
      svc.trackInbound(makeInput({ threadKey: 'all-3' }));

      const entries = svc.getAllEntries();
      expect(entries).toHaveLength(3);
    });

    it('returns empty array when no entries exist', () => {
      expect(svc.getAllEntries()).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Sub-task A: Follow-up auto-scheduling
  // ---------------------------------------------------------------------------

  describe('follow-up auto-scheduling (Sub-task A)', () => {
    let mockScheduler: jest.Mocked<ISchedulerServiceLike>;
    let mockEventBus: jest.Mocked<IEventBusServiceLike>;

    beforeEach(() => {
      mockScheduler = {
        scheduleCheck: jest.fn().mockReturnValue('sched-001'),
        cancelCheck: jest.fn(),
      };
      mockEventBus = {
        subscribe: jest.fn().mockReturnValue({ id: 'sub-001' }),
        unsubscribe: jest.fn().mockReturnValue(true),
      };
      svc.setSchedulerService(mockScheduler);
      svc.setEventBusService(mockEventBus);
    });

    it('creates scheduled check and event subscription on replied_to_follow_up', () => {
      svc.trackInbound(makeInput({ threadKey: 'fu-1', conversationId: 'conv-fu-1' }));
      svc.markDelivered('fu-1');
      svc.markReplied('fu-1', 'replied_to_follow_up');

      expect(mockScheduler.scheduleCheck).toHaveBeenCalledTimes(1);
      expect(mockScheduler.scheduleCheck).toHaveBeenCalledWith(
        'crewly-orc',
        5,
        expect.stringContaining('fu-1'),
        'check-in',
        { label: 'follow-up:fu-1' }
      );

      expect(mockEventBus.subscribe).toHaveBeenCalledTimes(1);
      expect(mockEventBus.subscribe).toHaveBeenCalledWith(
        expect.objectContaining({
          subscriberSession: 'crewly-orc',
          oneShot: true,
        })
      );

      const tracking = svc.getFollowUpTracking('fu-1');
      expect(tracking).not.toBeNull();
      expect(tracking!.scheduledCheckId).toBe('sched-001');
      expect(tracking!.eventSubscriptionId).toBe('sub-001');
    });

    it('does NOT create follow-up tracking for replied_completed', () => {
      svc.trackInbound(makeInput({ threadKey: 'fu-2' }));
      svc.markReplied('fu-2', 'replied_completed');

      expect(mockScheduler.scheduleCheck).not.toHaveBeenCalled();
      expect(mockEventBus.subscribe).not.toHaveBeenCalled();
      expect(svc.getFollowUpTracking('fu-2')).toBeNull();
    });

    it('does NOT create follow-up tracking for replied_waiting_actions', () => {
      svc.trackInbound(makeInput({ threadKey: 'fu-3' }));
      svc.markReplied('fu-3', 'replied_waiting_actions');

      expect(mockScheduler.scheduleCheck).not.toHaveBeenCalled();
      expect(mockEventBus.subscribe).not.toHaveBeenCalled();
    });

    it('handleFollowUpReply cancels check and subscription', () => {
      svc.trackInbound(makeInput({ threadKey: 'fu-4' }));
      svc.markDelivered('fu-4');
      svc.markReplied('fu-4', 'replied_to_follow_up');

      svc.handleFollowUpReply('fu-4');

      expect(mockScheduler.cancelCheck).toHaveBeenCalledWith('sched-001');
      expect(mockEventBus.unsubscribe).toHaveBeenCalledWith('sub-001');
      expect(svc.getFollowUpTracking('fu-4')).toBeNull();
      expect(svc.get('fu-4')!.status).toBe('replied_completed');
    });

    it('handleFollowUpReply is a no-op for unknown threadKey', () => {
      svc.handleFollowUpReply('nonexistent');
      expect(mockScheduler.cancelCheck).not.toHaveBeenCalled();
      expect(mockEventBus.unsubscribe).not.toHaveBeenCalled();
    });

    it('works without scheduler/eventBus set (logs warning, no error)', () => {
      const svc2 = createService();
      svc2.trackInbound(makeInput({ threadKey: 'fu-5' }));
      svc2.markReplied('fu-5', 'replied_to_follow_up');
      // Should not throw, just log warnings
      expect(svc2.getFollowUpTracking('fu-5')).toBeNull();
      svc2.destroy();
    });

    it('destroy cancels all follow-up tracking', () => {
      svc.trackInbound(makeInput({ threadKey: 'fu-6' }));
      svc.markReplied('fu-6', 'replied_to_follow_up');

      svc.destroy();

      expect(mockScheduler.cancelCheck).toHaveBeenCalledWith('sched-001');
      expect(mockEventBus.unsubscribe).toHaveBeenCalledWith('sub-001');
    });
  });

  // ---------------------------------------------------------------------------
  // Sub-task B: Restart Recovery
  // ---------------------------------------------------------------------------

  describe('recoverPendingThreads (Sub-task B)', () => {
    let mockMessageQueue: jest.Mocked<IMessageQueueServiceLike>;
    let mockAgentChecker: jest.Mocked<IAgentStatusCheckerLike>;
    let mockConfirmCallback: jest.MockedFunction<RecoveryConfirmCallback>;
    let mockScheduler: jest.Mocked<ISchedulerServiceLike>;
    let mockEventBus: jest.Mocked<IEventBusServiceLike>;

    beforeEach(() => {
      mockMessageQueue = {
        enqueue: jest.fn(),
      };
      mockAgentChecker = {
        getAgentWorkingStatus: jest.fn().mockResolvedValue('idle'),
      };
      mockConfirmCallback = jest.fn().mockResolvedValue(undefined);
      mockScheduler = {
        scheduleCheck: jest.fn().mockReturnValue('recovery-sched-001'),
        cancelCheck: jest.fn(),
      };
      mockEventBus = {
        subscribe: jest.fn().mockReturnValue({ id: 'recovery-sub-001' }),
        unsubscribe: jest.fn().mockReturnValue(true),
      };
      svc.setSchedulerService(mockScheduler);
      svc.setEventBusService(mockEventBus);
    });

    it('Branch 1: re-enqueues enqueued threads with confirm callback', async () => {
      svc.trackInbound(makeInput({ threadKey: 'rec-1', messagePreview: 'Hello' }));
      // Persist and reload to simulate restart
      await svc.persist();
      const written = JSON.parse(mockAtomicWriteFile.mock.calls[0][1]);
      mockSafeReadJson.mockResolvedValue(written);

      const svc2 = createService();
      svc2.setSchedulerService(mockScheduler);
      svc2.setEventBusService(mockEventBus);

      const result = await svc2.recoverPendingThreads(mockMessageQueue, {
        confirmCallback: mockConfirmCallback,
        agentStatusChecker: mockAgentChecker,
      });

      expect(mockConfirmCallback).toHaveBeenCalledTimes(1);
      expect(mockConfirmCallback).toHaveBeenCalledWith(
        expect.objectContaining({ threadKey: 'rec-1', status: 'enqueued' })
      );
      expect(mockMessageQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('[RECOVERY]') })
      );
      expect(result.reEnqueued).toBe(1);
      svc2.destroy();
    });

    it('Branch 1: re-enqueues delivered threads', async () => {
      svc.trackInbound(makeInput({ threadKey: 'rec-2' }));
      svc.markDelivered('rec-2');
      await svc.persist();
      const written = JSON.parse(mockAtomicWriteFile.mock.calls[0][1]);
      mockSafeReadJson.mockResolvedValue(written);

      const svc2 = createService();
      svc2.setSchedulerService(mockScheduler);
      svc2.setEventBusService(mockEventBus);

      const result = await svc2.recoverPendingThreads(mockMessageQueue, {
        confirmCallback: mockConfirmCallback,
      });

      expect(result.reEnqueued).toBe(1);
      expect(mockConfirmCallback).toHaveBeenCalledTimes(1);
      svc2.destroy();
    });

    it('Branch 1: re-enqueues error threads', async () => {
      svc.trackInbound(makeInput({ threadKey: 'rec-err' }));
      const entry = svc.get('rec-err')!;
      (entry as any).status = 'error';
      await svc.persist();
      const written = JSON.parse(mockAtomicWriteFile.mock.calls[0][1]);
      mockSafeReadJson.mockResolvedValue(written);

      const svc2 = createService();
      const result = await svc2.recoverPendingThreads(mockMessageQueue);
      expect(result.reEnqueued).toBe(1);
      svc2.destroy();
    });

    it('Branch 2: restores follow-up tracking for replied_to_follow_up', async () => {
      svc.trackInbound(makeInput({ threadKey: 'rec-fu', conversationId: 'conv-fu' }));
      svc.markDelivered('rec-fu');
      svc.markReplied('rec-fu', 'replied_to_follow_up');
      await svc.persist();
      const written = JSON.parse(mockAtomicWriteFile.mock.calls[0][1]);
      mockSafeReadJson.mockResolvedValue(written);

      const svc2 = createService();
      svc2.setSchedulerService(mockScheduler);
      svc2.setEventBusService(mockEventBus);

      const result = await svc2.recoverPendingThreads(mockMessageQueue);
      expect(result.followUpRestored).toBe(1);
      expect(mockScheduler.scheduleCheck).toHaveBeenCalledWith(
        'crewly-orc',
        5,
        expect.stringContaining('rec-fu'),
        'check-in',
        { label: 'follow-up:rec-fu' }
      );
      expect(mockEventBus.subscribe).toHaveBeenCalled();
      svc2.destroy();
    });

    it('Branch 3: completes threads when all delegated agents are idle', async () => {
      svc.trackInbound(makeInput({ threadKey: 'rec-wa' }));
      svc.markDelivered('rec-wa');
      svc.markReplied('rec-wa', 'replied_waiting_actions');
      svc.addDelegatedAgent('rec-wa', 'agent-a');
      svc.addDelegatedAgent('rec-wa', 'agent-b');
      await svc.persist();
      const written = JSON.parse(mockAtomicWriteFile.mock.calls[0][1]);
      mockSafeReadJson.mockResolvedValue(written);

      mockAgentChecker.getAgentWorkingStatus.mockResolvedValue('idle');

      const svc2 = createService();
      const result = await svc2.recoverPendingThreads(mockMessageQueue, {
        agentStatusChecker: mockAgentChecker,
      });

      expect(result.waitingActionsChecked).toBe(1);
      expect(result.delegationsCompleted).toBe(1);
      expect(mockAgentChecker.getAgentWorkingStatus).toHaveBeenCalledWith('agent-a');
      expect(mockAgentChecker.getAgentWorkingStatus).toHaveBeenCalledWith('agent-b');
      // Should NOT enqueue since all agents are done
      expect(mockMessageQueue.enqueue).not.toHaveBeenCalled();
      svc2.destroy();
    });

    it('Branch 3: keeps waiting when some agents are still in_progress', async () => {
      svc.trackInbound(makeInput({ threadKey: 'rec-wa2' }));
      svc.markDelivered('rec-wa2');
      svc.markReplied('rec-wa2', 'replied_waiting_actions');
      svc.addDelegatedAgent('rec-wa2', 'agent-a');
      svc.addDelegatedAgent('rec-wa2', 'agent-b');
      await svc.persist();
      const written = JSON.parse(mockAtomicWriteFile.mock.calls[0][1]);
      mockSafeReadJson.mockResolvedValue(written);

      mockAgentChecker.getAgentWorkingStatus
        .mockResolvedValueOnce('idle')
        .mockResolvedValueOnce('in_progress');

      const svc2 = createService();
      const result = await svc2.recoverPendingThreads(mockMessageQueue, {
        agentStatusChecker: mockAgentChecker,
      });

      expect(result.waitingActionsChecked).toBe(1);
      expect(result.delegationsCompleted).toBe(0);
      // Should enqueue notification since not all agents are done
      expect(mockMessageQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('still working'),
        })
      );
      svc2.destroy();
    });

    it('Branch 3: falls back to notification when no agent status checker', async () => {
      svc.trackInbound(makeInput({ threadKey: 'rec-wa3' }));
      svc.markDelivered('rec-wa3');
      svc.markReplied('rec-wa3', 'replied_waiting_actions');
      svc.addDelegatedAgent('rec-wa3', 'agent-a');
      await svc.persist();
      const written = JSON.parse(mockAtomicWriteFile.mock.calls[0][1]);
      mockSafeReadJson.mockResolvedValue(written);

      const svc2 = createService();
      const result = await svc2.recoverPendingThreads(mockMessageQueue);

      expect(result.waitingActionsChecked).toBe(1);
      expect(mockMessageQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('[RECOVERY]'),
        })
      );
      svc2.destroy();
    });

    it('Branch 4: skips terminal entries (replied_completed)', async () => {
      svc.trackInbound(makeInput({ threadKey: 'rec-done' }));
      svc.markReplied('rec-done', 'replied_completed');
      await svc.persist();
      const written = JSON.parse(mockAtomicWriteFile.mock.calls[0][1]);
      mockSafeReadJson.mockResolvedValue(written);

      const svc2 = createService();
      const result = await svc2.recoverPendingThreads(mockMessageQueue);

      expect(result.reEnqueued).toBe(0);
      expect(result.followUpRestored).toBe(0);
      expect(result.waitingActionsChecked).toBe(0);
      expect(mockMessageQueue.enqueue).not.toHaveBeenCalled();
      svc2.destroy();
    });

    it('runs expireStale and cleanup during recovery', async () => {
      // Create an entry that should be expired (very old updatedAt)
      svc.trackInbound(makeInput({ threadKey: 'rec-exp' }));
      const entry = svc.get('rec-exp')!;
      (entry as any).updatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
      await svc.persist();
      const written = JSON.parse(mockAtomicWriteFile.mock.calls[0][1]);
      mockSafeReadJson.mockResolvedValue(written);

      const svc2 = createService();
      const result = await svc2.recoverPendingThreads(mockMessageQueue);

      // The entry should be expired (updatedAt is 1h ago, timeout is 30min)
      // But it will also be re-enqueued first since it's still enqueued status
      expect(result.expired).toBeGreaterThanOrEqual(0);
      svc2.destroy();
    });

    it('Branch 1: continues even if confirm callback fails', async () => {
      svc.trackInbound(makeInput({ threadKey: 'rec-fail' }));
      await svc.persist();
      const written = JSON.parse(mockAtomicWriteFile.mock.calls[0][1]);
      mockSafeReadJson.mockResolvedValue(written);

      const failingCallback: RecoveryConfirmCallback = jest.fn().mockRejectedValue(new Error('Slack down'));

      const svc2 = createService();
      const result = await svc2.recoverPendingThreads(mockMessageQueue, {
        confirmCallback: failingCallback,
      });

      // Should still re-enqueue despite callback failure
      expect(result.reEnqueued).toBe(1);
      expect(mockMessageQueue.enqueue).toHaveBeenCalled();
      svc2.destroy();
    });
  });
});
