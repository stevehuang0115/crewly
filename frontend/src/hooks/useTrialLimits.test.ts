/**
 * useTrialLimits Hook Tests
 *
 * Verifies escalation logic, localStorage counters, monthly reset,
 * dismiss behaviour, and openModal escalation.
 *
 * @module hooks/useTrialLimits.test
 */
import { renderHook, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ESCALATION_THRESHOLD, PAYWALL_STORAGE_PREFIX } from '../types/payment-wall.types.js';
import type { TrialLimitEvent } from '../types/payment-wall.types.js';
import { useTrialLimits } from './useTrialLimits.js';

/** Helper to build a standard limit event */
function makeEvent(overrides?: Partial<TrialLimitEvent>): TrialLimitEvent {
  return {
    limitType: 'limit:teams',
    current: 2,
    max: 2,
    plan: 'free',
    ...overrides,
  };
}

/** localStorage key used by the hook for hit counters */
function hitsKey(limitType: string): string {
  return `${PAYWALL_STORAGE_PREFIX}hits_${limitType}`;
}

/** sessionStorage key for dismissed banners */
const DISMISSED_KEY = `${PAYWALL_STORAGE_PREFIX}dismissed`;

describe('useTrialLimits', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Initial state ──────────────────────────────────────────────

  it('should start with default state: not visible, banner level, null event', () => {
    const { result } = renderHook(() => useTrialLimits());

    expect(result.current.isVisible).toBe(false);
    expect(result.current.escalationLevel).toBe('banner');
    expect(result.current.activeLimitEvent).toBeNull();
  });

  // ── handleLimitExceeded: banner on first call ──────────────────

  it('should show banner on the first handleLimitExceeded call', () => {
    const { result } = renderHook(() => useTrialLimits());
    const event = makeEvent();

    act(() => {
      result.current.handleLimitExceeded(event);
    });

    expect(result.current.isVisible).toBe(true);
    expect(result.current.escalationLevel).toBe('banner');
    expect(result.current.activeLimitEvent).toEqual(event);
  });

  it('should persist hit counter to localStorage', () => {
    const { result } = renderHook(() => useTrialLimits());

    act(() => {
      result.current.handleLimitExceeded(makeEvent());
    });

    const stored = JSON.parse(localStorage.getItem(hitsKey('limit:teams')) || '{}');
    expect(stored.count).toBe(1);
    expect(typeof stored.timestamp).toBe('number');
  });

  // ── handleLimitExceeded: banner through threshold ──────────────

  it('should stay at banner level for encounters up to ESCALATION_THRESHOLD', () => {
    const { result } = renderHook(() => useTrialLimits());
    const event = makeEvent();

    for (let i = 0; i < ESCALATION_THRESHOLD; i++) {
      act(() => {
        result.current.handleLimitExceeded(event);
      });
      expect(result.current.escalationLevel).toBe('banner');
    }

    const stored = JSON.parse(localStorage.getItem(hitsKey('limit:teams')) || '{}');
    expect(stored.count).toBe(ESCALATION_THRESHOLD);
  });

  // ── handleLimitExceeded: modal after threshold ─────────────────

  it('should escalate to modal after exceeding ESCALATION_THRESHOLD', () => {
    const { result } = renderHook(() => useTrialLimits());
    const event = makeEvent();

    // Hit threshold + 1 times
    for (let i = 0; i <= ESCALATION_THRESHOLD; i++) {
      act(() => {
        result.current.handleLimitExceeded(event);
      });
    }

    expect(result.current.escalationLevel).toBe('modal');
    expect(result.current.isVisible).toBe(true);
  });

  // ── dismiss ────────────────────────────────────────────────────

  it('should hide the wall when dismiss is called', () => {
    const { result } = renderHook(() => useTrialLimits());

    act(() => {
      result.current.handleLimitExceeded(makeEvent());
    });
    expect(result.current.isVisible).toBe(true);

    act(() => {
      result.current.dismiss();
    });
    expect(result.current.isVisible).toBe(false);
  });

  it('should keep activeLimitEvent after dismiss for re-trigger detection', () => {
    const { result } = renderHook(() => useTrialLimits());
    const event = makeEvent();

    act(() => {
      result.current.handleLimitExceeded(event);
    });
    act(() => {
      result.current.dismiss();
    });

    expect(result.current.activeLimitEvent).toEqual(event);
  });

  it('should add limit type to sessionStorage dismissed set on banner dismiss', () => {
    const { result } = renderHook(() => useTrialLimits());

    act(() => {
      result.current.handleLimitExceeded(makeEvent());
    });
    act(() => {
      result.current.dismiss();
    });

    const dismissed = JSON.parse(sessionStorage.getItem(DISMISSED_KEY) || '[]');
    expect(dismissed).toContain('limit:teams');
  });

  it('should NOT add to sessionStorage dismissed when escalation is modal', () => {
    const { result } = renderHook(() => useTrialLimits());
    const event = makeEvent();

    // Exceed threshold to reach modal level
    for (let i = 0; i <= ESCALATION_THRESHOLD; i++) {
      act(() => {
        result.current.handleLimitExceeded(event);
      });
    }
    expect(result.current.escalationLevel).toBe('modal');

    act(() => {
      result.current.dismiss();
    });

    const dismissed = JSON.parse(sessionStorage.getItem(DISMISSED_KEY) || '[]');
    expect(dismissed).not.toContain('limit:teams');
  });

  // ── Monthly reset ──────────────────────────────────────────────

  it('should reset counter when stored timestamp is older than 30 days', () => {
    const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000;

    // Pre-seed localStorage with an old counter above threshold
    const oldTimestamp = Date.now() - THIRTY_ONE_DAYS_MS;
    localStorage.setItem(
      hitsKey('limit:teams'),
      JSON.stringify({ count: ESCALATION_THRESHOLD + 5, timestamp: oldTimestamp }),
    );

    const { result } = renderHook(() => useTrialLimits());

    act(() => {
      result.current.handleLimitExceeded(makeEvent());
    });

    // Counter should have been reset to 0, then incremented to 1 => banner
    expect(result.current.escalationLevel).toBe('banner');

    const stored = JSON.parse(localStorage.getItem(hitsKey('limit:teams')) || '{}');
    expect(stored.count).toBe(1);
  });

  it('should NOT reset counter when timestamp is within 30 days', () => {
    // Pre-seed with a recent counter at threshold
    const recentTimestamp = Date.now() - 1000; // 1 second ago
    localStorage.setItem(
      hitsKey('limit:teams'),
      JSON.stringify({ count: ESCALATION_THRESHOLD, timestamp: recentTimestamp }),
    );

    const { result } = renderHook(() => useTrialLimits());

    act(() => {
      result.current.handleLimitExceeded(makeEvent());
    });

    // count = ESCALATION_THRESHOLD + 1 => modal
    expect(result.current.escalationLevel).toBe('modal');

    const stored = JSON.parse(localStorage.getItem(hitsKey('limit:teams')) || '{}');
    expect(stored.count).toBe(ESCALATION_THRESHOLD + 1);
  });

  // ── openModal ──────────────────────────────────────────────────

  it('should switch escalation to modal when openModal is called', () => {
    const { result } = renderHook(() => useTrialLimits());

    act(() => {
      result.current.handleLimitExceeded(makeEvent());
    });
    expect(result.current.escalationLevel).toBe('banner');

    act(() => {
      result.current.openModal();
    });
    expect(result.current.escalationLevel).toBe('modal');
  });

  // ── Independent tracking per limit type ────────────────────────

  it('should track different limit types independently', () => {
    const { result } = renderHook(() => useTrialLimits());

    const teamsEvent = makeEvent({ limitType: 'limit:teams' });
    const projectsEvent = makeEvent({ limitType: 'limit:projects' });

    // Hit teams threshold + 1 times to escalate
    for (let i = 0; i <= ESCALATION_THRESHOLD; i++) {
      act(() => {
        result.current.handleLimitExceeded(teamsEvent);
      });
    }
    expect(result.current.escalationLevel).toBe('modal');

    // Projects should still be at banner (first encounter)
    act(() => {
      result.current.handleLimitExceeded(projectsEvent);
    });
    expect(result.current.escalationLevel).toBe('banner');
    expect(result.current.activeLimitEvent?.limitType).toBe('limit:projects');

    // Verify separate counters in localStorage
    const teamsCounter = JSON.parse(localStorage.getItem(hitsKey('limit:teams')) || '{}');
    const projectsCounter = JSON.parse(localStorage.getItem(hitsKey('limit:projects')) || '{}');
    expect(teamsCounter.count).toBe(ESCALATION_THRESHOLD + 1);
    expect(projectsCounter.count).toBe(1);
  });

  // ── Corrupted localStorage handling ────────────────────────────

  it('should handle corrupted localStorage gracefully', () => {
    localStorage.setItem(hitsKey('limit:teams'), 'not-valid-json');

    const { result } = renderHook(() => useTrialLimits());

    act(() => {
      result.current.handleLimitExceeded(makeEvent());
    });

    // Should treat as count=0, increment to 1 => banner
    expect(result.current.escalationLevel).toBe('banner');
    expect(result.current.isVisible).toBe(true);
  });

  it('should handle corrupted sessionStorage gracefully on dismiss', () => {
    sessionStorage.setItem(DISMISSED_KEY, '{{{invalid');

    const { result } = renderHook(() => useTrialLimits());

    act(() => {
      result.current.handleLimitExceeded(makeEvent());
    });
    act(() => {
      result.current.dismiss();
    });

    // Should not throw; dismissed set is recreated
    const dismissed = JSON.parse(sessionStorage.getItem(DISMISSED_KEY) || '[]');
    expect(dismissed).toContain('limit:teams');
  });
});
