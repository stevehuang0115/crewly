/**
 * PendingLoginsBanner Tests
 *
 * @module components/PendingLoginsBanner.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PendingLoginsBanner, pendingLoginsKey, pendingSessionLabel, usePendingLoginsItem } from './PendingLoginsBanner';
import { SIGN_IN_CONSTANTS } from '../constants/sign-in.constants';
import { markHarnessLoggedIn } from '../utils/harness-login-marks';

vi.mock('../hooks/usePendingLogins', () => ({
  usePendingLogins: vi.fn(() => ({ pending: [], isLoading: true, refresh: vi.fn() })),
}));

vi.mock('../services/harness.service', () => ({
  harnessService: { getStatus: vi.fn() },
}));

import { usePendingLogins } from '../hooks/usePendingLogins';
import { harnessService } from '../services/harness.service';

/**
 * Harness overview with one harness in the given login state.
 *
 * @param loginState - codex-cli login state
 * @returns Overview-shaped object
 */
function overview(loginState: 'logged_in' | 'logged_out' | 'unknown') {
  return { harnesses: [{ id: 'codex-cli', loginState }], orcHarness: 'codex-cli' } as never;
}

const orc = {
  sessionName: 'crewly-orc',
  runtimeType: 'codex-cli',
  url: 'https://auth.openai.com/device',
  code: 'FBVZ-MJHKK',
  detectedAt: '2026-09-18T10:00:00.000Z',
  notifiedAt: null,
};
const dev = { ...orc, sessionName: 'crewly-dev-1', code: 'ABCD-EFGH' };

describe('PendingLoginsBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.mocked(harnessService.getStatus).mockResolvedValue(overview('logged_out'));
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
    expect(screen.getByText('Orchestrator (crewly-orc)')).toBeInTheDocument();
    expect(screen.getByText('crewly-dev-1')).toBeInTheDocument();

    const chips = screen.getAllByRole('button', { name: /sign-in needed/i });
    expect(chips).toHaveLength(2);
    fireEvent.click(chips[1]);
    expect(screen.getByTestId('sign-in-code')).toHaveTextContent('ABCD-EFGH');
    expect(screen.getByTestId('sign-in-url')).toHaveAttribute('href', orc.url);
    // Codex can also be signed in from here, without the agent's terminal.
    expect(screen.getByTestId('sign-in-broker')).toBeInTheDocument();
  });

  it('a Claude agent flagged with no URL (the Air, 2026-09-30) gets a tappable in-place sign-in, not "check the terminal"', () => {
    const air = { ...orc, runtimeType: 'claude-code', url: null, code: null };
    vi.mocked(usePendingLogins).mockReturnValue({ pending: [air], isLoading: false, refresh: vi.fn() });
    render(<PendingLoginsBanner />);
    fireEvent.click(screen.getByRole('button', { name: /sign-in needed/i }));
    expect(screen.getByTestId('login-start')).toHaveTextContent('Sign in to Claude Code from here');
    expect(screen.queryByText(/check the agent/i)).not.toBeInTheDocument();
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

  it('keeps a dismissal across remounts until the pending set changes', () => {
    vi.mocked(usePendingLogins).mockReturnValue({ pending: [orc], isLoading: false, refresh: vi.fn() });
    const { unmount } = render(<PendingLoginsBanner />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss sign-in banner/i }));
    unmount();
    expect(window.localStorage.getItem(SIGN_IN_CONSTANTS.DISMISSED_STORAGE_KEY)).toBe(pendingLoginsKey([orc]));

    render(<PendingLoginsBanner />);
    expect(screen.queryByTestId('pending-logins-banner')).not.toBeInTheDocument();
  });

  it('is an in-flow block, not a viewport-wide fixed overlay', () => {
    vi.mocked(usePendingLogins).mockReturnValue({ pending: [orc], isLoading: false, refresh: vi.fn() });
    render(<PendingLoginsBanner />);
    const banner = screen.getByTestId('pending-logins-banner');
    expect(banner.className).not.toMatch(/\bfixed\b/);
    expect(banner.className).not.toMatch(/inset-x-0/);
    expect(banner.className).not.toMatch(/backdrop-blur/);
  });

  it('hides a sign-in once its harness finished a login after it was detected', async () => {
    vi.mocked(usePendingLogins).mockReturnValue({ pending: [orc, dev], isLoading: false, refresh: vi.fn() });
    vi.mocked(harnessService.getStatus).mockResolvedValue(overview('logged_in'));
    markHarnessLoggedIn('codex-cli', new Date('2026-09-18T10:05:00.000Z'));
    const devOther = { ...dev, runtimeType: 'claude-code' };
    vi.mocked(usePendingLogins).mockReturnValue({ pending: [orc, devOther], isLoading: false, refresh: vi.fn() });

    render(<PendingLoginsBanner />);
    await waitFor(() => expect(screen.queryByText('Orchestrator (crewly-orc)')).not.toBeInTheDocument());
    expect(screen.getByText('crewly-dev-1')).toBeInTheDocument();
  });

  it('keeps showing a sign-in when the harness only *reads* logged in (e.g. expired token)', async () => {
    vi.mocked(harnessService.getStatus).mockResolvedValue(overview('logged_in'));
    vi.mocked(usePendingLogins).mockReturnValue({ pending: [orc], isLoading: false, refresh: vi.fn() });
    render(<PendingLoginsBanner />);
    await waitFor(() => expect(harnessService.getStatus).toHaveBeenCalled());
    expect(screen.getByTestId('pending-logins-banner')).toBeInTheDocument();
  });

  it('re-checks harness status on focus and clears itself after a logged-out → logged-in transition', async () => {
    const refresh = vi.fn();
    vi.mocked(usePendingLogins).mockReturnValue({ pending: [orc], isLoading: false, refresh });
    render(<PendingLoginsBanner />);
    await waitFor(() => expect(harnessService.getStatus).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('pending-logins-banner')).toBeInTheDocument();

    vi.mocked(harnessService.getStatus).mockResolvedValue(overview('logged_in'));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(screen.queryByTestId('pending-logins-banner')).not.toBeInTheDocument());
    // The pending list is re-fetched straight away too.
    expect(refresh).toHaveBeenCalled();
  });

  it('keeps its sign-in chips visible in a collapsed status bar (never folded behind "+N more")', () => {
    vi.mocked(usePendingLogins).mockReturnValue({ pending: [orc], isLoading: false, refresh: vi.fn() });
    let item: ReturnType<typeof usePendingLoginsItem> = null;
    const Probe = () => {
      item = usePendingLoginsItem();
      return null;
    };
    render(<Probe />);
    expect(item).not.toBeNull();
    expect((item as { alwaysVisible?: boolean } | null)?.alwaysVisible).toBe(true);
  });

  it('labels the orchestrator session', () => {
    expect(pendingSessionLabel('crewly-orc')).toBe('Orchestrator (crewly-orc)');
    expect(pendingSessionLabel('crewly-dev-1')).toBe('crewly-dev-1');
  });

  describe('pendingLoginsKey', () => {
    it('is order-independent and sensitive to url/code changes', () => {
      expect(pendingLoginsKey([orc, dev])).toBe(pendingLoginsKey([dev, orc]));
      expect(pendingLoginsKey([orc])).not.toBe(pendingLoginsKey([{ ...orc, code: 'ZZZZ-ZZZZ' }]));
      expect(pendingLoginsKey([])).toBe('');
    });
  });
});
