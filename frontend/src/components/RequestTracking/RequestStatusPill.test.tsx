// @vitest-environment jsdom
/**
 * Tests for RequestStatusPill component
 *
 * Verifies the Dark/Calm palette mapping per Ava's V3 design report:
 *   active                → amber + pulse on the dot only
 *   blocked               → red
 *   waiting_confirmation  → indigo / violet accent
 *   done                  → green
 *
 * @module components/RequestTracking/RequestStatusPill.test
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RequestStatusPill } from './RequestStatusPill';
import type { RequestStatus } from './request-tracking.types';

/** Map of status → Tailwind tone token expected in the pill's class list. */
const EXPECTED_TONE: Record<RequestStatus, string> = {
  active: 'amber',
  blocked: 'red',
  waiting_confirmation: 'indigo',
  done: 'green',
};

describe('RequestStatusPill', () => {
  it.each(Object.entries(EXPECTED_TONE) as Array<[RequestStatus, string]>)(
    'renders the %s status with the %s tone',
    (status, tone) => {
      render(<RequestStatusPill status={status} />);
      const pill = screen.getByTestId(`request-status-pill-${status}`);
      expect(pill.className).toContain(`text-${tone}`);
      expect(pill.className).toContain(`bg-${tone}`);
      expect(pill.className).toContain(`border-${tone}`);
    },
  );

  it('renders the canonical label by default', () => {
    render(<RequestStatusPill status="waiting_confirmation" />);
    expect(screen.getByText('Waiting Confirmation')).toBeDefined();
  });

  it('honours a custom label override', () => {
    render(<RequestStatusPill status="active" label="Running" />);
    expect(screen.getByText('Running')).toBeDefined();
  });

  it('only animates the dot for active status (subtle pulse)', () => {
    render(<RequestStatusPill status="active" />);
    const pill = screen.getByTestId('request-status-pill-active');
    // Pill itself must NOT pulse (Ava: "not the whole row")
    expect(pill.className).not.toContain('animate-pulse');
    // The dot child MUST pulse
    const dot = pill.querySelector('span[aria-hidden="true"]') as HTMLElement | null;
    expect(dot).not.toBeNull();
    expect(dot!.className).toContain('animate-pulse');
  });

  it('does NOT animate the dot for non-active statuses', () => {
    for (const status of ['blocked', 'waiting_confirmation', 'done'] as const) {
      const { unmount } = render(<RequestStatusPill status={status} />);
      const pill = screen.getByTestId(`request-status-pill-${status}`);
      const dot = pill.querySelector('span[aria-hidden="true"]') as HTMLElement | null;
      expect(dot).not.toBeNull();
      expect(dot!.className).not.toContain('animate-pulse');
      unmount();
    }
  });
});
