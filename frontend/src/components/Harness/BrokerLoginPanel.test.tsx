/**
 * Tests for BrokerLoginPanel: subscription (paste step), device code,
 * failure + retry and the unrecognised-screen fallback.
 *
 * @module components/Harness/BrokerLoginPanel.test
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrokerLoginPanel } from './BrokerLoginPanel';
import { harnessService } from '../../services/harness.service';
import { makeSession } from '../../test/harness.fixtures';

vi.mock('../../services/harness.service', () => ({
  harnessService: {
    startLogin: vi.fn(),
    getLoginSession: vi.fn(),
    sendLoginInput: vi.fn(),
    cancelLogin: vi.fn(),
  },
}));

const svc = vi.mocked(harnessService);

/**
 * Click the start button and flush the start request.
 */
async function clickStart(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('login-start'));
  });
}

/**
 * Advance one login poll interval.
 */
async function tick(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
}

describe('BrokerLoginPanel', () => {
  const openSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    svc.cancelLogin.mockResolvedValue(null);
    vi.stubGlobal('open', openSpy);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('subscription: opens the auth page, takes the pasted code, verifies, succeeds', async () => {
    const url = 'https://claude.ai/oauth/authorize?code=true';
    svc.startLogin.mockResolvedValue(makeSession({ state: 'starting' }));
    svc.getLoginSession
      .mockResolvedValueOnce(makeSession({ url, needsInput: true }))
      .mockResolvedValueOnce(makeSession({ state: 'succeeded' }));
    svc.sendLoginInput.mockResolvedValue(makeSession({ state: 'verifying' }));
    const onSucceeded = vi.fn();

    render(<BrokerLoginPanel harnessId="claude-code" method="subscription" label="用 Claude 订阅登录" onSucceeded={onSucceeded} />);
    expect(screen.getByTestId('login-start')).toHaveTextContent('用 Claude 订阅登录');
    await clickStart();
    expect(svc.startLogin).toHaveBeenCalledWith('claude-code', 'subscription');
    expect(screen.getByText('正在启动登录…')).toBeInTheDocument();

    await tick();
    fireEvent.click(screen.getByTestId('login-open-url'));
    expect(openSpy).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer');

    const input = screen.getByLabelText('把页面上给你的代码粘贴到这里') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc#def' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /提交/ }));
    });
    expect(svc.sendLoginInput).toHaveBeenCalledWith('sess-1', 'abc#def');
    expect(screen.getByText('正在验证…')).toBeInTheDocument();

    await tick();
    expect(screen.getByText('登录成功 / Signed in')).toBeInTheDocument();
    expect(onSucceeded).toHaveBeenCalledTimes(1);
  });

  it('device: shows the code large with copy and no input field, then polls to success', async () => {
    svc.startLogin.mockResolvedValue(
      makeSession({ harnessId: 'codex-cli', method: 'device', url: 'https://auth.openai.com/codex/device', userCode: 'WXYZ-1234' }),
    );
    svc.getLoginSession
      .mockResolvedValueOnce(makeSession({ harnessId: 'codex-cli', method: 'device', url: 'https://auth.openai.com/codex/device', userCode: 'WXYZ-1234' }))
      .mockResolvedValueOnce(makeSession({ harnessId: 'codex-cli', method: 'device', state: 'succeeded' }));

    render(<BrokerLoginPanel harnessId="codex-cli" method="device" label="用 ChatGPT 账号登录" />);
    await clickStart();
    expect(svc.startLogin).toHaveBeenCalledWith('codex-cli', 'device');
    expect(screen.getByText('WXYZ-1234')).toBeInTheDocument();
    expect(screen.getByTestId('copy-button')).toBeInTheDocument();
    expect(screen.getByText('在打开的页面输入这个验证码，完成后这里会自动继续')).toBeInTheDocument();
    expect(screen.getByTestId('login-open-url')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    await tick();
    await tick();
    expect(screen.getByText('登录成功 / Signed in')).toBeInTheDocument();
  });

  it('does not render a link for an unsafe URL', async () => {
    svc.startLogin.mockResolvedValue(makeSession({ url: 'javascript:alert(1)', userCode: 'C0DE' }));
    render(<BrokerLoginPanel harnessId="claude-code" method="subscription" label="go" />);
    await clickStart();
    expect(screen.queryByTestId('login-open-url')).not.toBeInTheDocument();
  });

  it.each(['failed', 'timed_out'] as const)('%s: shows the message and retries', async (state) => {
    svc.startLogin
      .mockResolvedValueOnce(makeSession({ state, message: 'Login window closed' }))
      .mockResolvedValueOnce(makeSession({ state: 'starting', id: 'sess-2' }));
    render(<BrokerLoginPanel harnessId="claude-code" method="subscription" label="go" />);
    await clickStart();
    expect(screen.getByText('Login window closed')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    });
    expect(svc.startLogin).toHaveBeenCalledTimes(2);
    expect(screen.getByText('正在启动登录…')).toBeInTheDocument();
  });

  it('unrecognised screen: shows the raw terminal text and sends raw input', async () => {
    svc.startLogin.mockResolvedValue(makeSession({ screen: 'Select login method:\n 1. Claude account\n 2. Console' }));
    svc.sendLoginInput.mockResolvedValue(null);
    render(<BrokerLoginPanel harnessId="claude-code" method="subscription" label="go" />);
    await clickStart();

    expect(screen.getByText('终端内容')).toBeInTheDocument();
    expect(screen.getByTestId('login-screen')).toHaveTextContent('Select login method:');
    const input = screen.getByLabelText('发送到终端 / Send to terminal') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
    });
    expect(svc.sendLoginInput).toHaveBeenCalledWith('sess-1', '1');
    expect(input.value).toBe('');
  });

  it('cancels a live session and on unmount', async () => {
    svc.startLogin.mockResolvedValue(makeSession({ url: 'https://x.test' }));
    const { unmount } = render(<BrokerLoginPanel harnessId="claude-code" method="subscription" label="go" />);
    await clickStart();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /取消/ }));
    });
    expect(svc.cancelLogin).toHaveBeenCalledWith('sess-1');
    expect(screen.getByText('已取消')).toBeInTheDocument();
    unmount();
    // Already terminal: no second cancel on unmount.
    expect(svc.cancelLogin).toHaveBeenCalledTimes(1);
  });

  it('cancels a still-live session when unmounted', async () => {
    svc.startLogin.mockResolvedValue(makeSession({ url: 'https://x.test' }));
    const { unmount } = render(<BrokerLoginPanel harnessId="claude-code" method="subscription" label="go" />);
    await clickStart();
    unmount();
    expect(svc.cancelLogin).toHaveBeenCalledWith('sess-1');
  });

  it('shows a start error', async () => {
    svc.startLogin.mockRejectedValue(new Error('claude not installed'));
    render(<BrokerLoginPanel harnessId="claude-code" method="subscription" label="go" />);
    await clickStart();
    expect(screen.getByText('claude not installed')).toBeInTheDocument();
  });
});
