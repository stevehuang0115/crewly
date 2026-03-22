/**
 * Payment Wall — Test Suite
 *
 * Tests for PaymentWallBanner, PaymentWallModal, PaymentWall composite,
 * and escalation/localStorage utilities.
 *
 * @module components/PaymentWall/PaymentWall.test
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PaymentWallBanner,
  PaymentWallModal,
  PaymentWall,
  getEncounterCount,
  incrementEncounterCount,
  getEscalationLevel,
  isBannerDismissedThisSession,
  dismissBannerForSession,
} from './PaymentWall';
import type { TrialLimitEvent } from '../../types/payment-wall.types';
import { PAYWALL_STORAGE_PREFIX, ESCALATION_THRESHOLD } from '../../types/payment-wall.types';

// ========================= Test Fixtures =========================

const mockTeamsEvent: TrialLimitEvent = {
  limitType: 'limit:teams',
  current: 2,
  max: 2,
  plan: 'free',
};

const mockProjectsEvent: TrialLimitEvent = {
  limitType: 'limit:projects',
  current: 3,
  max: 3,
  plan: 'free',
};

// ========================= Storage Setup =========================

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

// ========================= PaymentWallBanner Tests =========================

describe('PaymentWallBanner', () => {
  it('renders with correct copy for teams limit', () => {
    render(
      <PaymentWallBanner
        event={mockTeamsEvent}
        onUpgrade={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByTestId('payment-wall-banner')).toBeInTheDocument();
    expect(screen.getByText(/free plan limit of 2 teams/i)).toBeInTheDocument();
  });

  it('renders with correct copy for projects limit', () => {
    render(
      <PaymentWallBanner
        event={mockProjectsEvent}
        onUpgrade={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText(/3 projects on the free plan/i)).toBeInTheDocument();
  });

  it('calls onUpgrade when Upgrade button is clicked', () => {
    const onUpgrade = vi.fn();
    render(
      <PaymentWallBanner
        event={mockTeamsEvent}
        onUpgrade={onUpgrade}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('banner-upgrade-btn'));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });

  it('calls onDismiss when dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    render(
      <PaymentWallBanner
        event={mockTeamsEvent}
        onUpgrade={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(screen.getByTestId('banner-dismiss-btn'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('has correct accessibility attributes', () => {
    render(
      <PaymentWallBanner
        event={mockTeamsEvent}
        onUpgrade={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const banner = screen.getByTestId('payment-wall-banner');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByLabelText('Dismiss upgrade banner')).toBeInTheDocument();
  });
});

// ========================= PaymentWallModal Tests =========================

describe('PaymentWallModal', () => {
  it('renders when isOpen is true', () => {
    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={vi.fn()}
        onUpgrade={vi.fn()}
      />,
    );

    expect(screen.getByText('Unlock the Full Crewly')).toBeInTheDocument();
    expect(screen.getByText(/free plan limit for teams/i)).toBeInTheDocument();
  });

  it('does not render when isOpen is false', () => {
    render(
      <PaymentWallModal
        isOpen={false}
        event={mockTeamsEvent}
        onClose={vi.fn()}
        onUpgrade={vi.fn()}
      />,
    );

    expect(screen.queryByText('Unlock the Full Crewly')).not.toBeInTheDocument();
  });

  it('shows usage progress bar with correct values', () => {
    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={vi.fn()}
        onUpgrade={vi.fn()}
      />,
    );

    expect(screen.getByText('2/2 teams')).toBeInTheDocument();
    const progressBar = screen.getByRole('progressbar');
    expect(progressBar).toHaveAttribute('aria-valuenow', '2');
    expect(progressBar).toHaveAttribute('aria-valuemax', '2');
  });

  it('shows both Free and Pro plan cards', () => {
    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={vi.fn()}
        onUpgrade={vi.fn()}
      />,
    );

    expect(screen.getByTestId('plan-card-free')).toBeInTheDocument();
    expect(screen.getByTestId('plan-card-pro')).toBeInTheDocument();
  });

  it('shows "Popular" badge on Pro card', () => {
    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={vi.fn()}
        onUpgrade={vi.fn()}
      />,
    );

    const proCard = screen.getByTestId('plan-card-pro');
    expect(within(proCard).getByText('Popular')).toBeInTheDocument();
  });

  it('defaults to monthly billing', () => {
    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={vi.fn()}
        onUpgrade={vi.fn()}
      />,
    );

    expect(screen.getByText('$29')).toBeInTheDocument();
    expect(screen.queryByText(/Save/)).not.toBeInTheDocument();
  });

  it('toggles to yearly billing and shows savings', () => {
    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={vi.fn()}
        onUpgrade={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('billing-yearly'));
    expect(screen.getByText('$24')).toBeInTheDocument();
    expect(screen.getByText(/Save 17%/)).toBeInTheDocument();
  });

  it('calls onUpgrade with monthly interval by default', () => {
    const onUpgrade = vi.fn();
    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={vi.fn()}
        onUpgrade={onUpgrade}
      />,
    );

    fireEvent.click(screen.getByTestId('upgrade-now-btn'));
    expect(onUpgrade).toHaveBeenCalledWith('monthly');
  });

  it('calls onUpgrade with yearly interval after toggle', () => {
    const onUpgrade = vi.fn();
    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={vi.fn()}
        onUpgrade={onUpgrade}
      />,
    );

    fireEvent.click(screen.getByTestId('billing-yearly'));
    fireEvent.click(screen.getByTestId('upgrade-now-btn'));
    expect(onUpgrade).toHaveBeenCalledWith('yearly');
  });

  it('calls onClose when Maybe Later is clicked', () => {
    const onClose = vi.fn();
    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={onClose}
        onUpgrade={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('maybe-later-btn'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows enterprise contact link', () => {
    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={vi.fn()}
        onUpgrade={vi.fn()}
      />,
    );

    expect(screen.getByText(/Need Enterprise/)).toBeInTheDocument();
    expect(screen.getByText(/Contact us/)).toBeInTheDocument();
  });
});

// ========================= Escalation Logic Tests =========================

describe('Escalation utilities', () => {
  describe('getEncounterCount', () => {
    it('returns 0 for unseen limit type', () => {
      expect(getEncounterCount('limit:teams')).toBe(0);
    });

    it('returns stored count', () => {
      const key = `${PAYWALL_STORAGE_PREFIX}hits_limit:teams`;
      localStorage.setItem(key, JSON.stringify({ count: 3, timestamp: Date.now() }));
      expect(getEncounterCount('limit:teams')).toBe(3);
    });

    it('resets count after 30 days', () => {
      const key = `${PAYWALL_STORAGE_PREFIX}hits_limit:teams`;
      const oldTimestamp = Date.now() - 31 * 24 * 60 * 60 * 1000;
      localStorage.setItem(key, JSON.stringify({ count: 5, timestamp: oldTimestamp }));
      expect(getEncounterCount('limit:teams')).toBe(0);
    });

    it('returns 0 for malformed data', () => {
      const key = `${PAYWALL_STORAGE_PREFIX}hits_limit:teams`;
      localStorage.setItem(key, 'not-json');
      expect(getEncounterCount('limit:teams')).toBe(0);
    });
  });

  describe('incrementEncounterCount', () => {
    it('increments from 0 to 1', () => {
      expect(incrementEncounterCount('limit:teams')).toBe(1);
      expect(getEncounterCount('limit:teams')).toBe(1);
    });

    it('increments existing count', () => {
      incrementEncounterCount('limit:teams');
      incrementEncounterCount('limit:teams');
      expect(getEncounterCount('limit:teams')).toBe(2);
    });
  });

  describe('getEscalationLevel', () => {
    it('returns banner for 0 encounters', () => {
      expect(getEscalationLevel('limit:teams')).toBe('banner');
    });

    it('returns banner for encounters <= threshold', () => {
      for (let i = 0; i < ESCALATION_THRESHOLD; i++) {
        incrementEncounterCount('limit:teams');
      }
      expect(getEscalationLevel('limit:teams')).toBe('banner');
    });

    it('returns modal for encounters > threshold', () => {
      for (let i = 0; i <= ESCALATION_THRESHOLD; i++) {
        incrementEncounterCount('limit:teams');
      }
      expect(getEscalationLevel('limit:teams')).toBe('modal');
    });
  });

  describe('Session dismissal', () => {
    it('returns false for undismissed limit type', () => {
      expect(isBannerDismissedThisSession('limit:teams')).toBe(false);
    });

    it('returns true after dismissal', () => {
      dismissBannerForSession('limit:teams');
      expect(isBannerDismissedThisSession('limit:teams')).toBe(true);
    });

    it('tracks different limit types independently', () => {
      dismissBannerForSession('limit:teams');
      expect(isBannerDismissedThisSession('limit:teams')).toBe(true);
      expect(isBannerDismissedThisSession('limit:projects')).toBe(false);
    });
  });
});

// ========================= Composite PaymentWall Tests =========================

describe('PaymentWall (composite)', () => {
  it('renders nothing when event is null', () => {
    const { container } = render(
      <PaymentWall event={null} onUpgrade={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders banner on first encounter', () => {
    render(
      <PaymentWall
        event={mockTeamsEvent}
        onUpgrade={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByTestId('payment-wall-banner')).toBeInTheDocument();
  });

  it('escalates to modal when Upgrade is clicked on banner', () => {
    render(
      <PaymentWall
        event={mockTeamsEvent}
        onUpgrade={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('banner-upgrade-btn'));
    expect(screen.getByText('Unlock the Full Crewly')).toBeInTheDocument();
  });

  it('renders modal directly when encounter count exceeds threshold', () => {
    for (let i = 0; i <= ESCALATION_THRESHOLD; i++) {
      incrementEncounterCount('limit:teams');
    }

    render(
      <PaymentWall
        event={mockTeamsEvent}
        onUpgrade={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('Unlock the Full Crewly')).toBeInTheDocument();
  });

  it('calls onDismiss when banner is dismissed', () => {
    const onDismiss = vi.fn();
    render(
      <PaymentWall
        event={mockTeamsEvent}
        onUpgrade={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(screen.getByTestId('banner-dismiss-btn'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('calls onDismiss when modal Maybe Later is clicked', () => {
    for (let i = 0; i <= ESCALATION_THRESHOLD; i++) {
      incrementEncounterCount('limit:teams');
    }

    const onDismiss = vi.fn();
    render(
      <PaymentWall
        event={mockTeamsEvent}
        onUpgrade={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(screen.getByTestId('maybe-later-btn'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
