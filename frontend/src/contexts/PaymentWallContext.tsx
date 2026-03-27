/**
 * Payment Wall Context
 *
 * Provides global payment wall state and trigger function.
 * Wraps the app so any component can trigger the payment wall
 * when the backend returns a 402 LIMIT_EXCEEDED response.
 *
 * The context delegates limit-event handling to the useTrialLimits
 * hook and reads the user's plan from AuthContext to determine
 * whether upgrade prompts should be shown.
 *
 * @module contexts/PaymentWallContext
 */

import React, { createContext, useContext, useCallback, useMemo } from 'react';
import { useAuth } from './AuthContext.js';
import { useTrialLimits } from '../hooks/useTrialLimits.js';
import type { TrialLimitEvent, EscalationLevel } from '../types/payment-wall.types.js';

// ---------------------------------------------------------------------------
// Context value type
// ---------------------------------------------------------------------------

/** Shape of the value exposed by PaymentWallContext. */
export interface PaymentWallContextValue {
  /** Trigger the payment wall with a limit event */
  triggerPaymentWall: (event: TrialLimitEvent) => void;
  /** Whether user is on free plan (shows upgrade prompts) */
  isOnFreePlan: boolean;
  /** Current active limit event */
  activeLimitEvent: TrialLimitEvent | null;
  /** Current escalation level */
  escalationLevel: EscalationLevel;
  /** Whether the wall is visible */
  isVisible: boolean;
  /** Dismiss the current wall */
  dismiss: () => void;
  /** Open the modal directly */
  openModal: () => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const PaymentWallContext = createContext<PaymentWallContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Props for PaymentWallProvider. */
export interface PaymentWallProviderProps {
  children: React.ReactNode;
}

/**
 * Provides payment wall state and actions to the component tree.
 *
 * Combines AuthContext (plan detection) with useTrialLimits (limit
 * event handling and escalation logic). When the user is NOT on
 * the free plan, triggerPaymentWall becomes a no-op so paid users
 * are never interrupted.
 *
 * @param props - Provider props containing children
 * @returns PaymentWallProvider component wrapping children
 *
 * @example
 * ```tsx
 * <AuthProvider>
 *   <PaymentWallProvider>
 *     <App />
 *   </PaymentWallProvider>
 * </AuthProvider>
 * ```
 */
export const PaymentWallProvider: React.FC<PaymentWallProviderProps> = ({ children }) => {
  const { user, license } = useAuth();
  const {
    handleLimitExceeded,
    activeLimitEvent,
    escalationLevel,
    dismiss,
    isVisible,
    openModal,
  } = useTrialLimits();

  /** Whether the current user should see upgrade prompts. */
  const isOnFreePlan = useMemo<boolean>(() => {
    if (user === null) return true;
    return license?.plan === 'free';
  }, [user, license]);

  /**
   * Trigger the payment wall for a given limit event.
   *
   * No-op when the user is on a paid plan, since paid users
   * should never see the payment wall.
   *
   * @param event - The trial limit event from the backend
   */
  const triggerPaymentWall = useCallback(
    (event: TrialLimitEvent): void => {
      if (!isOnFreePlan) return;
      handleLimitExceeded(event);
    },
    [isOnFreePlan, handleLimitExceeded],
  );

  const value = useMemo<PaymentWallContextValue>(
    () => ({
      triggerPaymentWall,
      isOnFreePlan,
      activeLimitEvent,
      escalationLevel,
      isVisible,
      dismiss,
      openModal,
    }),
    [triggerPaymentWall, isOnFreePlan, activeLimitEvent, escalationLevel, isVisible, dismiss, openModal],
  );

  return (
    <PaymentWallContext.Provider value={value}>
      {children}
    </PaymentWallContext.Provider>
  );
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Hook for accessing payment wall state and actions.
 *
 * Must be used within a PaymentWallProvider.
 *
 * @returns Payment wall context value
 * @throws Error if used outside PaymentWallProvider
 *
 * @example
 * ```tsx
 * const { triggerPaymentWall, isOnFreePlan, isVisible } = usePaymentWall();
 * ```
 */
export function usePaymentWall(): PaymentWallContextValue {
  const ctx = useContext(PaymentWallContext);
  if (!ctx) {
    throw new Error('usePaymentWall must be used within a PaymentWallProvider');
  }
  return ctx;
}
