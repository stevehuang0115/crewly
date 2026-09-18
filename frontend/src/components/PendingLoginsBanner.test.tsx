/**
 * PendingLoginsBanner Tests
 *
 * @module components/PendingLoginsBanner.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PendingLoginsBanner, pendingLoginsKey } from './PendingLoginsBanner';

vi.mock('../hooks/usePendingLogins', () => ({
  usePendingLogins: vi.fn(() => ({ pending: [], isLoading: true, refresh: vi.fn() })),
}));

import { usePendingLogins } from '../hooks/usePendingLogins';

const orc = {
  sessionName: 'crewly-orc',
  runtimeType: 'codex',
  url: 'https://auth.openai.com/device',
  code: 'FBVZ-MJHKK',
  detectedAt: '2026-09-18T10:00:00.000Z',
  notifiedAt: null,
};
const dev = { ...orc, sessionName: 'crewly-dev-1', code: 'ABCD-EFGH' };

describe('PendingLoginsBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing while loading or when nothing is pending', () => {
    vi.mocked(usePendingLogins).mockReturnValue({ pending: [], isLoading: true, refresh: vi.fn() });
    const { container, rerender } = render(<PendingLoginsBanner />);
    expect(container.firstChild).toBeNull();

    vi.mocked(usePendingLogins).mockReturnValue({ pending: [], isLoading: false, refresh: vi.fn() });
    rerender(<PendingLoginsBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('lists every pending session with a chip exposing its URL and code', () => {
    vi.mocked(usePendingLogins).mockReturnValue({ pending: [orc, dev], isLoading: false, refresh: vi.fn() });
    render(<PendingLoginsBanner />);

    expect(screen.getByTestId('pending-logins-banner')).toHaveTextContent('2 agents need you to sign in');
    expect(screen.getByText('crewly-orc')).toBeInTheDocument();
    expect(screen.getByText('crewly-dev-1')).toBeInTheDocument();

    const chips = screen.getAllByRole('button', { name: /sign-in needed/i });
    expect(chips).toHaveLength(2);
    fireEvent.click(chips[1]);
    expect(screen.getByTestId('sign-in-code')).toHaveTextContent('ABCD-EFGH');
    expect(screen.getByTestId('sign-in-url')).toHaveAttribute('href', orc.url);
  });

  it('uses singular wording for one pending session', () => {
    vi.mocked(usePendingLogins).mockReturnValue({ pending: [orc], isLoading: false, refresh: vi.fn() });
    render(<PendingLoginsBanner />);
    expect(screen.getByTestId('pending-logins-banner')).toHaveTextContent('1 agent needs you to sign in');
  });

  it('can be dismissed, and reappears when a new sign-in shows up', () => {
    vi.mocked(usePendingLogins).mockReturnValue({ pending: [orc], isLoading: false, refresh: vi.fn() });
    const { rerender } = render(<PendingLoginsBanner />);

    fireEvent.click(screen.getByRole('button', { name: /dismiss sign-in banner/i }));
    expect(screen.queryByTestId('pending-logins-banner')).not.toBeInTheDocument();

    // Same set re-polled → stays dismissed.
    vi.mocked(usePendingLogins).mockReturnValue({ pending: [{ ...orc }], isLoading: false, refresh: vi.fn() });
    rerender(<PendingLoginsBanner />);
    expect(screen.queryByTestId('pending-logins-banner')).not.toBeInTheDocument();

    // A second session appears → banner returns.
    vi.mocked(usePendingLogins).mockReturnValue({ pending: [orc, dev], isLoading: false, refresh: vi.fn() });
    rerender(<PendingLoginsBanner />);
    expect(screen.getByTestId('pending-logins-banner')).toBeInTheDocument();
  });

  describe('pendingLoginsKey', () => {
    it('is order-independent and sensitive to url/code changes', () => {
      expect(pendingLoginsKey([orc, dev])).toBe(pendingLoginsKey([dev, orc]));
      expect(pendingLoginsKey([orc])).not.toBe(pendingLoginsKey([{ ...orc, code: 'ZZZZ-ZZZZ' }]));
      expect(pendingLoginsKey([])).toBe('');
    });
  });
});
