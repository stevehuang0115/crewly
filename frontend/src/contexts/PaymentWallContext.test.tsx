/**
 * PaymentWallContext Tests
 *
 * Verifies that the PaymentWallProvider correctly integrates
 * AuthContext and useTrialLimits to expose payment wall state,
 * including free-plan detection and no-op behaviour for paid users.
 *
 * @module contexts/PaymentWallContext.test
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { PaymentWallProvider, usePaymentWall } from './PaymentWallContext.js';
import type { TrialLimitEvent } from '../types/payment-wall.types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockHandleLimitExceeded = vi.fn();
const mockDismiss = vi.fn();
const mockOpenModal = vi.fn();

vi.mock('./AuthContext.js', () => ({
  useAuth: vi.fn(() => ({
    user: null,
    license: null,
    isAuthenticated: false,
  })),
}));

vi.mock('../hooks/useTrialLimits.js', () => ({
  useTrialLimits: vi.fn(() => ({
    handleLimitExceeded: mockHandleLimitExceeded,
    activeLimitEvent: null,
    escalationLevel: 'banner' as const,
    dismiss: mockDismiss,
    isVisible: false,
    openModal: mockOpenModal,
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
import { useAuth } from './AuthContext.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render the usePaymentWall hook inside a PaymentWallProvider.
 *
 * @returns renderHook result
 */
function renderPaymentWallHook() {
  return renderHook(() => usePaymentWall(), {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <PaymentWallProvider>{children}</PaymentWallProvider>
    ),
  });
}

/** Sample trial limit event for tests. */
const sampleEvent: TrialLimitEvent = {
  limitType: 'limit:teams',
  current: 2,
  max: 2,
  plan: 'free',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaymentWallContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Default values
  // -------------------------------------------------------------------------

  it('provides default context values', () => {
    const { result } = renderPaymentWallHook();

    expect(result.current.activeLimitEvent).toBeNull();
    expect(result.current.escalationLevel).toBe('banner');
    expect(result.current.isVisible).toBe(false);
    expect(typeof result.current.triggerPaymentWall).toBe('function');
    expect(typeof result.current.dismiss).toBe('function');
    expect(typeof result.current.openModal).toBe('function');
  });

  // -------------------------------------------------------------------------
  // triggerPaymentWall delegation
  // -------------------------------------------------------------------------

  it('triggerPaymentWall calls handleLimitExceeded when on free plan', () => {
    const { result } = renderPaymentWallHook();

    act(() => {
      result.current.triggerPaymentWall(sampleEvent);
    });

    expect(mockHandleLimitExceeded).toHaveBeenCalledOnce();
    expect(mockHandleLimitExceeded).toHaveBeenCalledWith(sampleEvent);
  });

  // -------------------------------------------------------------------------
  // isOnFreePlan — user is null
  // -------------------------------------------------------------------------

  it('isOnFreePlan is true when user is null', () => {
    (useAuth as Mock).mockReturnValue({
      user: null,
      license: null,
      isAuthenticated: false,
    });

    const { result } = renderPaymentWallHook();

    expect(result.current.isOnFreePlan).toBe(true);
  });

  // -------------------------------------------------------------------------
  // isOnFreePlan — license.plan is 'free'
  // -------------------------------------------------------------------------

  it('isOnFreePlan is true when license.plan is free', () => {
    (useAuth as Mock).mockReturnValue({
      user: { id: '1', email: 'a@b.com', displayName: 'A', plan: 'free', createdAt: '' },
      license: { plan: 'free', features: [], active: true },
      isAuthenticated: true,
    });

    const { result } = renderPaymentWallHook();

    expect(result.current.isOnFreePlan).toBe(true);
  });

  // -------------------------------------------------------------------------
  // isOnFreePlan — license.plan is 'pro'
  // -------------------------------------------------------------------------

  it('isOnFreePlan is false when license.plan is pro', () => {
    (useAuth as Mock).mockReturnValue({
      user: { id: '1', email: 'a@b.com', displayName: 'A', plan: 'pro', createdAt: '' },
      license: { plan: 'pro', features: ['unlimited_teams'], active: true },
      isAuthenticated: true,
    });

    const { result } = renderPaymentWallHook();

    expect(result.current.isOnFreePlan).toBe(false);
  });

  // -------------------------------------------------------------------------
  // No-op for paid users
  // -------------------------------------------------------------------------

  it('triggerPaymentWall is no-op when not on free plan', () => {
    (useAuth as Mock).mockReturnValue({
      user: { id: '1', email: 'a@b.com', displayName: 'A', plan: 'pro', createdAt: '' },
      license: { plan: 'pro', features: ['unlimited_teams'], active: true },
      isAuthenticated: true,
    });

    const { result } = renderPaymentWallHook();

    act(() => {
      result.current.triggerPaymentWall(sampleEvent);
    });

    expect(mockHandleLimitExceeded).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Hook throws outside provider
  // -------------------------------------------------------------------------

  it('usePaymentWall throws when used outside PaymentWallProvider', () => {
    expect(() => {
      renderHook(() => usePaymentWall());
    }).toThrow('usePaymentWall must be used within a PaymentWallProvider');
  });
});
