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
    expect(screen.getByText('登录 Claude Code')).toBeInTheDocument();
    expect(screen.getByTestId('login-start')).toHaveTextContent('用 Claude 订阅登录');

    fireEvent.click(screen.getByRole('radio', { name: '使用 API Key' }));
    expect(screen.getByTestId('api-key-form')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /console.anthropic.com/ })).toBeInTheDocument();
  });

  it('Codex: ChatGPT device login and OpenAI API key', () => {
    render(<HarnessLoginCard harness={CODEX} />);
    expect(screen.getByTestId('login-start')).toHaveTextContent('用 ChatGPT 账号登录');
    fireEvent.click(screen.getByRole('radio', { name: '使用 OpenAI API Key' }));
    expect(screen.getByLabelText('使用 OpenAI API Key')).toHaveAttribute('type', 'password');
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
    expect(screen.getByText('已登录')).toBeInTheDocument();
    expect(screen.getByText(/已通过 Claude Max 登录/)).toBeInTheDocument();
    expect(screen.queryByTestId('login-start')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /重新登录/ }));
    expect(screen.getByTestId('login-start')).toBeInTheDocument();
  });

  it('API key save reports the updated status', async () => {
    const updated = makeHarness({ loginState: 'logged_in', loginSource: 'API key' });
    svc.setApiKey.mockResolvedValue(updated);
    const onHarnessUpdated = vi.fn();
    render(<HarnessLoginCard harness={makeHarness({ loginState: 'logged_out' })} onHarnessUpdated={onHarnessUpdated} />);
    fireEvent.click(screen.getByRole('radio', { name: '使用 API Key' }));
    fireEvent.change(screen.getByLabelText('使用 API Key'), { target: { value: 'sk-ant-1' } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('api-key-form'));
    });
    expect(onHarnessUpdated).toHaveBeenCalledWith(updated);
  });

  it('Gemini: detect only, no login methods', () => {
    render(<HarnessLoginCard harness={{ ...GEMINI, installed: true }} />);
    expect(screen.getByText(/暂不支持在网页登录 Gemini CLI/)).toBeInTheDocument();
    expect(screen.queryByTestId('login-start')).not.toBeInTheDocument();
  });

  it('not installed: asks to install first', () => {
    render(<HarnessLoginCard harness={GEMINI} />);
    expect(screen.getByText(/请先安装 Gemini CLI/)).toBeInTheDocument();
  });
});
