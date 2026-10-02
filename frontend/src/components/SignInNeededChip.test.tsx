/**
 * SignInNeededChip Tests
 *
 * @module components/SignInNeededChip.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SignInNeededChip, brokerLoginFor } from './SignInNeededChip';
import { harnessService } from '../services/harness.service';

vi.mock('../services/harness.service', () => ({
  harnessService: {
    startLogin: vi.fn(),
    getLoginSession: vi.fn(),
    sendLoginInput: vi.fn(),
    cancelLogin: vi.fn().mockResolvedValue(null),
  },
}));

const mockClipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
Object.assign(navigator, { clipboard: mockClipboard });

const loginRequired = {
  url: 'https://auth.openai.com/device',
  code: 'FBVZ-MJHKK',
  detectedAt: '2026-09-18T10:00:00.000Z',
};

describe('SignInNeededChip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the chip label and keeps the panel closed by default', () => {
    render(<SignInNeededChip loginRequired={loginRequired} />);
    expect(screen.getByRole('button', { name: /sign-in needed/i })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens a panel with the URL as a link and the device code', () => {
    render(<SignInNeededChip loginRequired={loginRequired} agentLabel="Orchestrator" />);
    fireEvent.click(screen.getByRole('button', { name: /sign-in needed/i }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Orchestrator needs you to sign in');
    const link = screen.getByTestId('sign-in-url');
    expect(link).toHaveAttribute('href', loginRequired.url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByTestId('sign-in-code')).toHaveTextContent('FBVZ-MJHKK');
  });

  it('copies the device code to the clipboard and shows feedback', async () => {
    render(<SignInNeededChip loginRequired={loginRequired} />);
    fireEvent.click(screen.getByRole('button', { name: /sign-in needed/i }));
    fireEvent.click(screen.getByRole('button', { name: /copy code to clipboard/i }));

    await waitFor(() => expect(mockClipboard.writeText).toHaveBeenCalledWith('FBVZ-MJHKK'));
    await waitFor(() => expect(screen.getByRole('button', { name: /code copied/i })).toBeInTheDocument());
  });

  it('on a plain-HTTP origin, copies via execCommand; if that fails too, asks for a manual copy', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true, writable: true });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true, writable: true });
    try {
      render(<SignInNeededChip loginRequired={loginRequired} />);
      fireEvent.click(screen.getByRole('button', { name: /sign-in needed/i }));
      fireEvent.click(screen.getByRole('button', { name: /copy code to clipboard/i }));
      await waitFor(() => expect(screen.getByText('Copied')).toBeInTheDocument());
      expect(mockClipboard.writeText).not.toHaveBeenCalled();
      expect(execCommand).toHaveBeenCalledWith('copy');

      execCommand.mockReturnValue(false);
      fireEvent.click(screen.getByRole('button', { name: /code copied/i }));
      await waitFor(() => expect(screen.getByText('Select and copy manually')).toBeInTheDocument());
    } finally {
      Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true, writable: true });
    }
  });

  it('selects the whole code when it is tapped', () => {
    render(<SignInNeededChip loginRequired={loginRequired} />);
    fireEvent.click(screen.getByRole('button', { name: /sign-in needed/i }));
    const code = screen.getByTestId('sign-in-code');
    expect(code.className).toMatch(/select-all/);
    fireEvent.click(code);
    expect(window.getSelection()?.toString()).toBe('FBVZ-MJHKK');
  });

  it('explains when no URL or code was captured', () => {
    render(<SignInNeededChip loginRequired={{ url: null, code: null, detectedAt: 'not-a-date' }} />);
    fireEvent.click(screen.getByRole('button', { name: /sign-in needed/i }));
    expect(screen.getByText(/No login URL was captured/)).toBeInTheDocument();
    expect(screen.getByText(/No device code/)).toBeInTheDocument();
    expect(screen.queryByText(/Detected/)).not.toBeInTheDocument();
  });

  it('closes on Escape and on outside click, and does not bubble clicks to the parent', () => {
    const onParentClick = vi.fn();
    render(
      <div onClick={onParentClick}>
        <SignInNeededChip loginRequired={loginRequired} />
        <span>outside</span>
      </div>,
    );
    const chip = screen.getByRole('button', { name: /sign-in needed/i });

    fireEvent.click(chip);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onParentClick).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(chip);
    fireEvent.mouseDown(screen.getByText('outside'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  describe('in-place sign-in for runtimes Crewly can log in (phone-friendly, no terminal)', () => {
    const claudeSession = {
      id: 'login-1',
      harnessId: 'claude-code' as const,
      method: 'subscription' as const,
      state: 'awaiting_user' as const,
      url: 'https://claude.com/cai/oauth/authorize?code=true&state=x',
      userCode: null,
      needsInput: true,
      message: null,
      screen: null,
      startedAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2026-09-30T00:00:00.000Z',
    };

    it('maps runtimes to the broker login', () => {
      expect(brokerLoginFor('claude-code')).toMatchObject({ harnessId: 'claude-code', method: 'subscription' });
      expect(brokerLoginFor('codex-cli')).toMatchObject({ harnessId: 'codex-cli', method: 'device' });
      expect(brokerLoginFor('gemini-cli')).toBeNull();
      expect(brokerLoginFor(null)).toBeNull();
    });

    it('Claude (no URL captured — the case on the Air): starts the brokered login, shows the link, sends the pasted code', async () => {
      vi.mocked(harnessService.startLogin).mockResolvedValue(claudeSession);
      vi.mocked(harnessService.getLoginSession).mockResolvedValue(claudeSession);
      vi.mocked(harnessService.sendLoginInput).mockResolvedValue({ ...claudeSession, state: 'verifying', needsInput: false });
      render(
        <SignInNeededChip
          loginRequired={{ url: null, code: null, detectedAt: '2026-09-30T00:00:00.000Z' }}
          agentLabel="Orchestrator (crewly-orc)"
          runtimeType="claude-code"
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /sign-in needed/i }));
      expect(screen.queryByText(/check the agent's terminal/i)).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('login-start'));
      await waitFor(() => expect(harnessService.startLogin).toHaveBeenCalledWith('claude-code', 'subscription'));
      expect(await screen.findByTestId('login-open-url')).toBeInTheDocument();
      expect(screen.getByText(claudeSession.url)).toBeInTheDocument();
      const input = screen.getByRole('textbox');
      fireEvent.change(input, { target: { value: 'the-code#state-123' } });
      fireEvent.submit(input.closest('form') as HTMLFormElement);
      await waitFor(() => expect(harnessService.sendLoginInput).toHaveBeenCalledWith('login-1', 'the-code#state-123'));
    });

    it('closing the panel does not cancel a login the backend is running (the Slack re-login may own it)', async () => {
      vi.mocked(harnessService.startLogin).mockResolvedValue(claudeSession);
      vi.mocked(harnessService.getLoginSession).mockResolvedValue(claudeSession);
      render(
        <div>
          <span>outside</span>
          <SignInNeededChip loginRequired={{ url: null, code: null, detectedAt: 'x' }} runtimeType="claude-code" />
        </div>,
      );
      fireEvent.click(screen.getByRole('button', { name: /sign-in needed/i }));
      fireEvent.click(screen.getByTestId('login-start'));
      await waitFor(() => expect(harnessService.startLogin).toHaveBeenCalled());
      await screen.findByTestId('login-open-url');
      fireEvent.mouseDown(screen.getByText('outside'));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(harnessService.cancelLogin).not.toHaveBeenCalled();
    });

    it('Codex with a device code on the agent screen: keeps the code and offers the brokered sign-in too', () => {
      render(<SignInNeededChip loginRequired={loginRequired} runtimeType="codex-cli" />);
      fireEvent.click(screen.getByRole('button', { name: /sign-in needed/i }));
      expect(screen.getByTestId('sign-in-code')).toHaveTextContent('FBVZ-MJHKK');
      expect(screen.getByTestId('sign-in-broker')).toHaveTextContent(/Or let Crewly run the sign-in/);
    });
  });
});
