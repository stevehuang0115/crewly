/**
 * useOnboardingStatus — hook that exposes the orc's onboarding state.
 *
 * Returns the canonical `OnboardingStatus` payload Sam mirrors on
 * the backend B2 state machine. Single shape ⇒ single source of
 * truth ⇒ W2 swap from this stub to the live wire is a 1-line
 * change in this file, never at the call-site.
 *
 * Contract (locked with Sam, 2026-05-02):
 *
 *   type OnboardingStatus = {
 *     mode: 'normal' | 'onboarding' | 'escape-hatch';
 *     stage?: 'S2' | 'S3' | 'S4' | 'S5' | 'S6';
 *     loading: boolean;
 *     error?: string;
 *   };
 *
 *   function useOnboardingStatus(): OnboardingStatus;
 *
 * **W1 stub** resolution order:
 *   1. Test override (Vitest only, via `setOnboardingStatusForTests`).
 *   2. URL search-param `?onboarding=...` (1/true/onboarding,
 *      escape-hatch, normal). Optional `?stage=S3` carries through
 *      when mode is `onboarding`.
 *   3. Default: `{ mode: 'normal', loading: false }`.
 *
 * **W2+** swaps the stub body for a fetch / WebSocket subscription
 * to `/api/orchestrator/status` once Sam ships B2.
 *
 * Spec ref: §3.2 Trigger Mechanism (B1/B2/B3).
 *
 * @module components/Onboarding/v2-5/useOnboardingStatus
 */

import { useEffect, useState } from 'react';
import type {
  OnboardingMode,
  OnboardingStage,
  OnboardingStatus,
} from '../../../types/onboarding-blueprint.types';

// =============================================================================
// Test-only override
// =============================================================================

let testOverride: OnboardingStatus | null = null;

/**
 * Force the next `useOnboardingStatus()` call to return a specific
 * status. Vitest-only — production code must not call this.
 *
 * @param status - The status to return, or `null` to clear.
 *
 * @example
 * ```ts
 * setOnboardingStatusForTests({ mode: 'onboarding', stage: 'S3', loading: false });
 * render(<OnboardingGate>{...}</OnboardingGate>);
 * setOnboardingStatusForTests(null); // cleanup
 * ```
 */
export function setOnboardingStatusForTests(
  status: OnboardingStatus | null
): void {
  testOverride = status;
}

// =============================================================================
// URL-param resolver
// =============================================================================

const VALID_STAGES: readonly OnboardingStage[] = [
  'S2',
  'S3',
  'S4',
  'S5',
  'S6',
];

function parseStage(raw: string | null): OnboardingStage | undefined {
  if (raw == null) return undefined;
  const upper = raw.toUpperCase() as OnboardingStage;
  return (VALID_STAGES as readonly string[]).includes(upper) ? upper : undefined;
}

function parseMode(raw: string | null): OnboardingMode | null {
  if (raw == null) return null;
  const v = raw.toLowerCase();
  if (v === '1' || v === 'true' || v === 'onboarding') return 'onboarding';
  if (v === 'escape-hatch' || v === 'escape_hatch') return 'escape-hatch';
  if (v === '0' || v === 'false' || v === 'normal') return 'normal';
  return null;
}

/**
 * Read `?onboarding=...&stage=...` from the URL into a partial
 * status. Returns `null` when no `onboarding` param is present.
 */
function readStatusFromUrl(): OnboardingStatus | null {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const mode = parseMode(params.get('onboarding'));
    if (mode == null) return null;
    const stage = mode === 'onboarding' ? parseStage(params.get('stage')) : undefined;
    return {
      mode,
      stage,
      loading: false,
    };
  } catch {
    return null;
  }
}

// =============================================================================
// Hook
// =============================================================================

const DEFAULT_STATUS: OnboardingStatus = {
  mode: 'normal',
  loading: false,
};

/**
 * Read the current orchestrator onboarding status.
 *
 * @returns Current `OnboardingStatus`. Identical shape on stub and
 *   real wire so consumers don't change.
 *
 * @example
 * ```tsx
 * const { mode, stage } = useOnboardingStatus();
 * if (mode !== 'onboarding') return <ChatPanel />;
 * return <OnboardingShell stage={stage} ... />;
 * ```
 */
export function useOnboardingStatus(): OnboardingStatus {
  const [status, setStatus] = useState<OnboardingStatus>(() => {
    if (testOverride) return testOverride;
    return readStatusFromUrl() ?? DEFAULT_STATUS;
  });

  // Keep status reactive to test overrides set after the first
  // render. W1 only: the W2+ implementation will subscribe to the
  // `orchestrator_status_changed` WebSocket event here instead.
  useEffect(() => {
    if (testOverride && testOverride !== status) {
      setStatus(testOverride);
    }
  });

  return status;
}

export default useOnboardingStatus;
