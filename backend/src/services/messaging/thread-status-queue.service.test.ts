/**
 * Tests for ThreadStatusQueueService
 *
 * @module services/messaging/thread-status-queue.test
 */

import { ThreadStatusQueueService } from './thread-status-queue.service.js';
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
});
