/**
 * Tests for HarnessLoginCard: method switching per harness.
 *
 * @module components/Harness/HarnessLoginCard.test
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HarnessLoginCard } from './HarnessLoginCard';
import { harnessService } from '../../services/harness.service';
import { makeHarness, CODEX, GEMINI } from '../../test/harness.fixtures';

vi.mock('../../services/harness.service', () => ({
  harnessService: {
    startLogin: vi.fn(),
    getLoginSession: vi.fn(),
    sendLoginInput: vi.fn(),
    cancelLogin: vi.fn().mockResolvedValue(null),
    setApiKey: vi.fn(),
  },
}));

const svc = vi.mocked(harnessService);

describe('HarnessLoginCard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Claude Code (logged out): subscription first, can switch to API key', () => {
    render(<HarnessLoginCard harness={makeHarness({ loginState: 'logged_out' })} />);
    expect(screen.getByText('Sign in to Claude Code')).toBeInTheDocument();
    expect(screen.getByTestId('login-start')).toHaveTextContent('Sign in with your Claude subscription');

    fireEvent.click(screen.getByRole('radio', { name: 'Use an API key' }));
    expect(screen.getByTestId('api-key-form')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /console.anthropic.com/ })).toBeInTheDocument();
  });

  it('Codex: ChatGPT device login and OpenAI API key', () => {
    render(<HarnessLoginCard harness={CODEX} />);
    expect(screen.getByTestId('login-start')).toHaveTextContent('Sign in with ChatGPT');
    fireEvent.click(screen.getByRole('radio', { name: 'Use an OpenAI API key' }));
    expect(screen.getByLabelText('Use an OpenAI API key')).toHaveAttribute('type', 'password');
  });

  it('starts the device method for Codex', async () => {
    svc.startLogin.mockResolvedValue({
      id: 's', harnessId: 'codex-cli', method: 'device', state: 'awaiting_user', url: null, userCode: 'AB12',
      needsInput: false, message: null, screen: null, startedAt: '', updatedAt: '',
    });
    render(<HarnessLoginCard harness={CODEX} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('login-start'));
    });
    expect(svc.startLogin).toHaveBeenCalledWith('codex-cli', 'device');
  });

  it('logged in: shows status and a re-login button that reveals the methods', () => {
    render(<HarnessLoginCard harness={makeHarness({ loginSource: 'Claude Max' })} />);
    expect(screen.getByText('Signed in')).toBeInTheDocument();
    expect(screen.getByText(/Signed in via Claude Max/)).toBeInTheDocument();
    expect(screen.queryByTestId('login-start')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Sign in again/ }));
    expect(screen.getByTestId('login-start')).toBeInTheDocument();
  });

  it('API key save reports the updated status', async () => {
    const updated = makeHarness({ loginState: 'logged_in', loginSource: 'API key' });
    svc.setApiKey.mockResolvedValue(updated);
    const onHarnessUpdated = vi.fn();
    render(<HarnessLoginCard harness={makeHarness({ loginState: 'logged_out' })} onHarnessUpdated={onHarnessUpdated} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Use an API key' }));
    fireEvent.change(screen.getByLabelText('Use an API key'), { target: { value: 'sk-ant-1' } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('api-key-form'));
    });
    expect(onHarnessUpdated).toHaveBeenCalledWith(updated);
  });

  it('Gemini: detect only, no login methods', () => {
    render(<HarnessLoginCard harness={{ ...GEMINI, installed: true }} />);
    expect(screen.getByText(/Browser sign-in isn't available for Gemini CLI yet/)).toBeInTheDocument();
    expect(screen.queryByTestId('login-start')).not.toBeInTheDocument();
  });

  it('not installed: asks to install first', () => {
    render(<HarnessLoginCard harness={GEMINI} />);
    expect(screen.getByText(/Install Gemini CLI first/)).toBeInTheDocument();
  });
});
