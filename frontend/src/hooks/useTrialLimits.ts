/**
 * useTrialLimits Hook
 *
 * Manages payment wall escalation logic using localStorage counters.
 * Tracks encounter counts per limit type and determines whether to show
 * a banner (soft, 1-3 encounters) or modal (escalated, 4+).
 * Counters reset monthly.
 *
 * @module hooks/useTrialLimits
 */
import { useState, useCallback } from 'react';

import {
  type TrialLimitEvent,
  type EscalationLevel,
  type LimitType,
  PAYWALL_STORAGE_PREFIX,
  ESCALATION_THRESHOLD,
} from '../types/payment-wall.types.js';

/** localStorage key for per-limitType hit counters */
const HITS_KEY_PREFIX = `${PAYWALL_STORAGE_PREFIX}hits_`;

/** sessionStorage key for dismissed banner limit types */
const DISMISSED_SESSION_KEY = `${PAYWALL_STORAGE_PREFIX}dismissed`;

/** 30 days in milliseconds */
const MONTHLY_RESET_MS = 30 * 24 * 60 * 60 * 1000;

/** Shape of the stored hit counter value */
interface StoredHitCounter {
  /** Number of times this limit has been encountered */
  count: number;
  /** Timestamp (ms since epoch) of the first encounter in the current window */
  timestamp: number;
}

/** Return type of the useTrialLimits hook */
export interface UseTrialLimitsReturn {
  /** Process a limit-exceeded event and determine escalation */
  handleLimitExceeded: (event: TrialLimitEvent) => void;
  /** The currently active limit event, or null if none */
  activeLimitEvent: TrialLimitEvent | null;
  /** Current escalation level: banner (soft) or modal (hard) */
  escalationLevel: EscalationLevel;
  /** Dismiss the current wall (hides UI, records dismissal for banners) */
  dismiss: () => void;
  /** Manually escalate to modal (e.g. user clicks "Upgrade" on banner) */
  openModal: () => void;
  /** Whether the payment wall UI should be visible */
  isVisible: boolean;
}

/**
 * Build the localStorage key for a given limit type's hit counter.
 *
 * @param limitType - The limit type identifier
 * @returns The full localStorage key string
 */
function hitsKey(limitType: LimitType): string {
  return `${HITS_KEY_PREFIX}${limitType}`;
}

/**
 * Read the hit counter for a limit type from localStorage.
 * Returns a zeroed counter if the key is missing or corrupt.
 *
 * @param limitType - The limit type to look up
 * @returns The stored counter or a fresh one
 */
function readHitCounter(limitType: LimitType): StoredHitCounter {
  try {
    const raw = localStorage.getItem(hitsKey(limitType));
    if (!raw) return { count: 0, timestamp: Date.now() };
    const parsed: StoredHitCounter = JSON.parse(raw);
    if (typeof parsed.count !== 'number' || typeof parsed.timestamp !== 'number') {
      return { count: 0, timestamp: Date.now() };
    }
    return parsed;
  } catch {
    return { count: 0, timestamp: Date.now() };
  }
}

/**
 * Write the hit counter for a limit type to localStorage.
 *
 * @param limitType - The limit type to store
 * @param counter - The counter value to persist
 */
function writeHitCounter(limitType: LimitType, counter: StoredHitCounter): void {
  localStorage.setItem(hitsKey(limitType), JSON.stringify(counter));
}

/**
 * Read the set of dismissed limit types from sessionStorage.
 *
 * @returns Set of limit types the user has dismissed this session
 */
function readDismissed(): Set<string> {
  try {
    const raw = sessionStorage.getItem(DISMISSED_SESSION_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

/**
 * Add a limit type to the dismissed set in sessionStorage.
 *
 * @param limitType - The limit type to mark as dismissed
 */
function writeDismissed(limitType: LimitType): void {
  const dismissed = readDismissed();
  dismissed.add(limitType);
  sessionStorage.setItem(DISMISSED_SESSION_KEY, JSON.stringify([...dismissed]));
}

/**
 * Determine escalation level based on encounter count.
 *
 * @param count - Number of times the limit has been encountered
 * @returns 'banner' for 1-ESCALATION_THRESHOLD, 'modal' for above
 */
function resolveEscalation(count: number): EscalationLevel {
  return count > ESCALATION_THRESHOLD ? 'modal' : 'banner';
}

/**
 * Hook for managing payment wall trial limit escalation.
 *
 * Tracks per-limit-type encounter counts in localStorage with a 30-day
 * rolling window. Encounters 1 through ESCALATION_THRESHOLD show a
 * dismissible banner; beyond that threshold, a modal is shown.
 *
 * @returns Trial limit state and control functions
 *
 * @example
 * ```tsx
 * const { handleLimitExceeded, isVisible, escalationLevel, dismiss, openModal } = useTrialLimits();
 *
 * // When a 402 response is received:
 * handleLimitExceeded({ limitType: 'limit:teams', current: 2, max: 2, plan: 'free' });
 *
 * // Render conditionally:
 * if (isVisible && escalationLevel === 'banner') return <PaywallBanner />;
 * if (isVisible && escalationLevel === 'modal') return <PaywallModal />;
 * ```
 */
export function useTrialLimits(): UseTrialLimitsReturn {
  const [activeLimitEvent, setActiveLimitEvent] = useState<TrialLimitEvent | null>(null);
  const [escalationLevel, setEscalationLevel] = useState<EscalationLevel>('banner');
  const [isVisible, setIsVisible] = useState(false);

  /**
   * Handle a limit-exceeded event from the backend.
   * Increments the encounter counter (with monthly reset) and sets
   * the appropriate escalation level.
   *
   * @param event - The trial limit event payload
   */
  const handleLimitExceeded = useCallback((event: TrialLimitEvent): void => {
    const counter = readHitCounter(event.limitType);
    const now = Date.now();

    // Reset counter if older than 30 days
    if (now - counter.timestamp > MONTHLY_RESET_MS) {
      counter.count = 0;
      counter.timestamp = now;
    }

    counter.count += 1;
    writeHitCounter(event.limitType, counter);

    const level = resolveEscalation(counter.count);
    setActiveLimitEvent(event);
    setEscalationLevel(level);
    setIsVisible(true);
  }, []);

  /**
   * Dismiss the currently visible payment wall.
   * Hides the UI and, for banner-level dismissals, records the limit type
   * in sessionStorage so it is not re-shown in the same session.
   */
  const dismiss = useCallback((): void => {
    setIsVisible(false);
    if (activeLimitEvent && escalationLevel === 'banner') {
      writeDismissed(activeLimitEvent.limitType);
    }
  }, [activeLimitEvent, escalationLevel]);

  /**
   * Manually escalate to the modal level.
   * Used when the user clicks "Upgrade" on a banner.
   */
  const openModal = useCallback((): void => {
    setEscalationLevel('modal');
  }, []);

  return {
    handleLimitExceeded,
    activeLimitEvent,
    escalationLevel,
    dismiss,
    openModal,
    isVisible,
  };
}
