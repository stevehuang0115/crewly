/**
 * Tests for the first-run Setup page.
 *
 * @module pages/Setup.test
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Setup } from './Setup';
import { harnessService } from '../services/harness.service';
import { makeHarness, makeOverview, CODEX, GEMINI } from '../test/harness.fixtures';
import { SETUP_SKIP_STORAGE_KEY } from '../constants/harness.constants';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('../services/harness.service', () => ({
  harnessService: {
    getStatus: vi.fn(),
    setOrcHarness: vi.fn(),
    startInstall: vi.fn(),
    getInstallJob: vi.fn(),
    startLogin: vi.fn(),
    getLoginSession: vi.fn(),
    sendLoginInput: vi.fn(),
    cancelLogin: vi.fn().mockResolvedValue(null),
    setApiKey: vi.fn(),
  },
}));

const svc = vi.mocked(harnessService);

/**
 * Click a button by accessible name inside act.
 *
 * @param name - Button name
 */
async function click(name: string | RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

describe('Setup page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('pre-selects Claude Code and walks harness → orc → login → done', async () => {
    svc.getStatus.mockResolvedValue(
      makeOverview({ orcHarness: null, harnesses: [makeHarness({ loginState: 'logged_out' }), CODEX, GEMINI] }),
    );
    svc.setOrcHarness.mockResolvedValue('claude-code');
    render(<Setup />);

    expect(await screen.findByText('选择并安装编程助手')).toBeInTheDocument();
    expect(screen.getByTestId('step-indicator')).toBeInTheDocument();
    const claudeRadio = screen.getAllByRole('radio').find((r) => (r as HTMLInputElement).value === 'claude-code') as HTMLInputElement;
    expect(claudeRadio.checked).toBe(true);

    await click('下一步');
    expect(screen.getByText('Orc 用哪个编程助手？')).toBeInTheDocument();
    expect((screen.getByDisplayValue('claude-code') as HTMLInputElement).checked).toBe(true);

    await click('下一步');
    expect(svc.setOrcHarness).toHaveBeenCalledWith('claude-code');
    expect(screen.getByTestId('harness-login-card-claude-code')).toBeInTheDocument();
    expect(screen.getByTestId('login-start')).toHaveTextContent('用 Claude 订阅登录');

    await click('稍后登录');
    expect(screen.getByTestId('setup-done')).toBeInTheDocument();
    await click('进入 Crewly');
    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('carries the step-1 selection into the orc choice and skips the save when unchanged', async () => {
    svc.getStatus.mockResolvedValue(makeOverview({ orcHarness: null }));
    svc.setOrcHarness.mockResolvedValue('codex-cli');
    render(<Setup />);
    await screen.findByText('选择并安装编程助手');
    fireEvent.click(screen.getAllByRole('radio').find((r) => (r as HTMLInputElement).value === 'codex-cli')!);
    await click('下一步');
    expect((screen.getByDisplayValue('codex-cli') as HTMLInputElement).checked).toBe(true);
    await click('下一步');
    expect(svc.setOrcHarness).toHaveBeenCalledWith('codex-cli');
    expect(screen.getByTestId('harness-login-card-codex-cli')).toBeInTheDocument();
    expect(screen.getByTestId('login-start')).toHaveTextContent('用 ChatGPT 账号登录');
  });

  it('does not re-save an unchanged orc harness and shows 下一步 when logged in', async () => {
    svc.getStatus.mockResolvedValue(makeOverview({ orcHarness: 'claude-code' }));
    render(<Setup />);
    await screen.findByText('选择并安装编程助手');
    await click('下一步');
    await click('下一步');
    expect(svc.setOrcHarness).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /下一步/ })).toBeInTheDocument();
  });

  it('blocks step 1 until a harness is installed', async () => {
    svc.getStatus.mockResolvedValue(
      makeOverview({ orcHarness: null, harnesses: [makeHarness({ installed: false, version: null }), GEMINI] }),
    );
    render(<Setup />);
    await screen.findByText('选择并安装编程助手');
    expect(screen.getByRole('button', { name: /下一步/ })).toBeDisabled();
  });

  it('stays on the orc step when saving fails', async () => {
    svc.getStatus.mockResolvedValue(makeOverview({ orcHarness: null }));
    svc.setOrcHarness.mockRejectedValue(new Error('config is read-only'));
    render(<Setup />);
    await screen.findByText('选择并安装编程助手');
    await click('下一步');
    await click('下一步');
    expect(screen.getByText('config is read-only')).toBeInTheDocument();
    expect(screen.getByText('Orc 用哪个编程助手？')).toBeInTheDocument();
  });

  it('"Skip for now" sets the skip flag and leaves', async () => {
    svc.getStatus.mockResolvedValue(makeOverview({ orcHarness: null }));
    render(<Setup />);
    await screen.findByText('选择并安装编程助手');
    fireEvent.click(screen.getByTestId('setup-skip'));
    expect(window.localStorage.getItem(SETUP_SKIP_STORAGE_KEY)).toBe('1');
    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('shows a load error with retry', async () => {
    svc.getStatus.mockRejectedValueOnce(new Error('backend down')).mockResolvedValueOnce(makeOverview());
    render(<Setup />);
    expect(await screen.findByText('backend down')).toBeInTheDocument();
    await click(/重试/);
    expect(await screen.findByText('选择并安装编程助手')).toBeInTheDocument();
  });
});
