/**
 * Thread Status Types Tests
 *
 * Tests for type guards and constants defined in thread-status.types.ts.
 *
 * @module types/thread-status.test
 */

import {
  THREAD_STATUS_VALUES,
  TERMINAL_STATUSES,
  PERSISTED_THREAD_STATUS_VERSION,
  isThreadStatus,
  isTerminalStatus,
  isThreadStatusEntry,
  isPersistedThreadStatusState,
  isReplyStatus,
} from './thread-status.types.js';

// =============================================================================
// Constants
// =============================================================================

describe('THREAD_STATUS_VALUES', () => {
  it('contains all 7 expected statuses', () => {
    expect(THREAD_STATUS_VALUES).toHaveLength(7);
    expect(THREAD_STATUS_VALUES).toContain('enqueued');
    expect(THREAD_STATUS_VALUES).toContain('delivered');
    expect(THREAD_STATUS_VALUES).toContain('replied_completed');
    expect(THREAD_STATUS_VALUES).toContain('replied_waiting_actions');
    expect(THREAD_STATUS_VALUES).toContain('replied_to_follow_up');
    expect(THREAD_STATUS_VALUES).toContain('expired');
    expect(THREAD_STATUS_VALUES).toContain('error');
  });
});

describe('TERMINAL_STATUSES', () => {
  it('contains only terminal statuses', () => {
    expect(TERMINAL_STATUSES).toContain('replied_completed');
    expect(TERMINAL_STATUSES).toContain('expired');
  });

  it('does not contain non-terminal statuses', () => {
    expect(TERMINAL_STATUSES).not.toContain('enqueued');
    expect(TERMINAL_STATUSES).not.toContain('delivered');
    expect(TERMINAL_STATUSES).not.toContain('replied_waiting_actions');
    expect(TERMINAL_STATUSES).not.toContain('replied_to_follow_up');
    expect(TERMINAL_STATUSES).not.toContain('error');
  });
});

describe('PERSISTED_THREAD_STATUS_VERSION', () => {
  it('is version 1', () => {
    expect(PERSISTED_THREAD_STATUS_VERSION).toBe(1);
  });
});

// =============================================================================
// Type Guards
// =============================================================================

describe('isThreadStatus', () => {
  it('returns true for all valid statuses', () => {
    for (const status of THREAD_STATUS_VALUES) {
      expect(isThreadStatus(status)).toBe(true);
    }
  });

  it('returns false for invalid strings', () => {
    expect(isThreadStatus('pending')).toBe(false);
    expect(isThreadStatus('active')).toBe(false);
    expect(isThreadStatus('')).toBe(false);
  });

  it('returns false for non-string values', () => {
    expect(isThreadStatus(42)).toBe(false);
    expect(isThreadStatus(null)).toBe(false);
    expect(isThreadStatus(undefined)).toBe(false);
    expect(isThreadStatus(true)).toBe(false);
    expect(isThreadStatus({})).toBe(false);
  });
});

describe('isTerminalStatus', () => {
  it('returns true for terminal statuses', () => {
    expect(isTerminalStatus('replied_completed')).toBe(true);
    expect(isTerminalStatus('expired')).toBe(true);
  });

  it('returns false for non-terminal statuses', () => {
    expect(isTerminalStatus('enqueued')).toBe(false);
    expect(isTerminalStatus('delivered')).toBe(false);
    expect(isTerminalStatus('replied_waiting_actions')).toBe(false);
    expect(isTerminalStatus('replied_to_follow_up')).toBe(false);
    expect(isTerminalStatus('error')).toBe(false);
  });
});

describe('isReplyStatus', () => {
  it('returns true for valid reply statuses', () => {
    expect(isReplyStatus('replied_completed')).toBe(true);
    expect(isReplyStatus('replied_waiting_actions')).toBe(true);
    expect(isReplyStatus('replied_to_follow_up')).toBe(true);
  });

  it('returns false for non-reply statuses', () => {
    expect(isReplyStatus('enqueued')).toBe(false);
    expect(isReplyStatus('delivered')).toBe(false);
    expect(isReplyStatus('expired')).toBe(false);
    expect(isReplyStatus('error')).toBe(false);
  });

  it('returns false for non-string values', () => {
    expect(isReplyStatus(null)).toBe(false);
    expect(isReplyStatus(undefined)).toBe(false);
    expect(isReplyStatus(123)).toBe(false);
  });
});

describe('isThreadStatusEntry', () => {
  const validEntry = {
    id: 'msg-001',
    source: 'slack',
    threadKey: 'C123:1707430000.001',
    conversationId: 'conv-001',
    status: 'enqueued',
    receivedAt: '2026-03-23T00:00:00Z',
    updatedAt: '2026-03-23T00:00:00Z',
    messagePreview: 'Hello world',
    retryCount: 0,
  };

  it('returns true for a valid entry', () => {
    expect(isThreadStatusEntry(validEntry)).toBe(true);
  });

  it('returns true for a valid entry with optional fields', () => {
    expect(isThreadStatusEntry({
      ...validEntry,
      deliveredAt: '2026-03-23T00:01:00Z',
      repliedAt: '2026-03-23T00:02:00Z',
      delegatedAgents: ['agent-1'],
      queueMessageId: 'q-001',
      sourceMetadata: { channelId: 'C123', threadTs: '1707430000.001' },
    })).toBe(true);
  });

  it('returns false when missing required fields', () => {
    const { id: _id, ...noId } = validEntry;
    expect(isThreadStatusEntry(noId)).toBe(false);

    const { threadKey: _tk, ...noThreadKey } = validEntry;
    expect(isThreadStatusEntry(noThreadKey)).toBe(false);

    const { retryCount: _rc, ...noRetryCount } = validEntry;
    expect(isThreadStatusEntry(noRetryCount)).toBe(false);
  });

  it('returns false for invalid status', () => {
    expect(isThreadStatusEntry({ ...validEntry, status: 'invalid' })).toBe(false);
  });

  it('returns false for non-object values', () => {
    expect(isThreadStatusEntry(null)).toBe(false);
    expect(isThreadStatusEntry(undefined)).toBe(false);
    expect(isThreadStatusEntry('string')).toBe(false);
    expect(isThreadStatusEntry(42)).toBe(false);
  });

  it('returns false when retryCount is not a number', () => {
    expect(isThreadStatusEntry({ ...validEntry, retryCount: 'zero' })).toBe(false);
  });
});

describe('isPersistedThreadStatusState', () => {
  it('returns true for a valid persisted state', () => {
    expect(isPersistedThreadStatusState({
      version: 1,
      entries: [],
      lastCleanupAt: '2026-03-23T00:00:00Z',
    })).toBe(true);
  });

  it('returns true for state with entries', () => {
    expect(isPersistedThreadStatusState({
      version: 1,
      entries: [{ id: 'test' }],
      lastCleanupAt: '2026-03-23T00:00:00Z',
    })).toBe(true);
  });

  it('returns false when missing version', () => {
    expect(isPersistedThreadStatusState({
      entries: [],
      lastCleanupAt: '2026-03-23T00:00:00Z',
    })).toBe(false);
  });

  it('returns false when entries is not an array', () => {
    expect(isPersistedThreadStatusState({
      version: 1,
      entries: 'not-array',
      lastCleanupAt: '2026-03-23T00:00:00Z',
    })).toBe(false);
  });

  it('returns false for non-object values', () => {
    expect(isPersistedThreadStatusState(null)).toBe(false);
    expect(isPersistedThreadStatusState(undefined)).toBe(false);
    expect(isPersistedThreadStatusState(42)).toBe(false);
  });
});
