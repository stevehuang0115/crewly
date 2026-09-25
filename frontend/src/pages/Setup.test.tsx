/**
 * Tests for the first-run Setup page.
 *
 * @module pages/Setup.test
 */

import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Setup, initialStepFromQuery, resolveTaskTarget, STEP } from './Setup';
import { harnessService } from '../services/harness.service';
import { makeHarness, makeOverview, CODEX, GEMINI } from '../test/harness.fixtures';
import { SETUP_SKIP_STORAGE_KEY } from '../constants/harness.constants';
import { onboardingChecklistService } from '../services/onboarding-checklist.service';
import { makeChecklist, STARTERS } from '../test/onboarding.fixtures';

const mockNavigate = vi.fn();
let mockSearchParams = new URLSearchParams('');
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [mockSearchParams],
}));

vi.mock('../services/onboarding-checklist.service', () => ({
  onboardingChecklistService: {
    getChecklist: vi.fn(),
    setDismissed: vi.fn(),
    getStarters: vi.fn(),
    createStarterTeam: vi.fn(),
    sendFirstTask: vi.fn(),
    connectCloud: vi.fn(),
    getSlackInstallUrl: vi.fn(),
    refreshSlack: vi.fn(),
  },
}));

const onboarding = vi.mocked(onboardingChecklistService);

vi.mock('../services/cloud-device-pairing.service', () => ({
  cloudDevicePairingService: {
    start: vi.fn().mockResolvedValue({
      state: 'pending',
      userCode: 'ABCD-2345',
      verificationUrl: 'https://crewlyai.com/cloud/pair?code=ABCD-2345',
    }),
    status: vi.fn().mockResolvedValue({ state: 'pending' }),
    cancel: vi.fn(),
  },
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
    mockSearchParams = new URLSearchParams('');
    onboarding.getChecklist.mockResolvedValue(makeChecklist(['harness']));
    onboarding.getStarters.mockResolvedValue(STARTERS);
    onboarding.refreshSlack.mockResolvedValue({ connected: false, cloudConnected: false });
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
    expect(await screen.findByTestId('starter-team-step')).toBeInTheDocument();
    expect(screen.getByText('建第一个团队')).toBeInTheDocument();
    await click('跳过'); // team
    expect(screen.getByText('派第一件事')).toBeInTheDocument();
    await click('跳过'); // first task
    expect(screen.getByText('连接 Crewly Cloud')).toBeInTheDocument();
    await click('跳过'); // cloud
    expect(screen.getByText('连接 Slack')).toBeInTheDocument();
    await click('跳过'); // slack
    expect(screen.getByTestId('setup-done')).toBeInTheDocument();
    expect(screen.getByTestId('setup-done-checklist')).toHaveTextContent('登录编程助手');
    await click('进入 Crewly');
    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('carries the step-1 selection into the orc choice and skips the save when unchanged', async () => {
    svc.getStatus.mockResolvedValue(makeOverview({ orcHarness: null }));
    svc.setOrcHarness.mockResolvedValue('codex-cli');
    render(<Setup />);
    await screen.findByText('选择并安装编程助手');
    fireEvent.click(screen.getAllByRole('radio').find((r) => (r as HTMLInputElement).value === 'codex-cli') as HTMLElement);
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

  // -------------------------------------------------------------------------
  // Phase 3: team → first task → Cloud → Slack
  // -------------------------------------------------------------------------

  it('creates the recommended team, then sends a suggested first task to it', async () => {
    mockSearchParams = new URLSearchParams('step=team');
    svc.getStatus.mockResolvedValue(makeOverview({ orcHarness: 'claude-code' }));
    onboarding.createStarterTeam.mockResolvedValue({
      starterId: 'personal-assistant-team',
      team: { id: 't1', name: 'Personal Assistant', members: [] },
      created: true,
    });
    onboarding.sendFirstTask.mockResolvedValue({ forwarded: true, queued: false, conversationId: 'c1', teamId: 't1', sentAt: 'now', message: null });
    render(<Setup />);

    await screen.findByTestId('starter-personal-assistant-team');
    await act(async () => {
      fireEvent.click(screen.getByTestId('starter-create'));
    });
    expect(onboarding.createStarterTeam).toHaveBeenCalledWith('personal-assistant-team');
    expect(screen.getByText('派第一件事')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: STARTERS[0].suggestions[0] }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('first-task-send'));
    });
    expect(onboarding.sendFirstTask).toHaveBeenCalledWith(STARTERS[0].suggestions[0], 't1');
    await click('下一步');
    expect(screen.getByText('连接 Crewly Cloud')).toBeInTheDocument();
  });

  it('?step=cloud opens the Cloud step without waiting for the harness status', async () => {
    mockSearchParams = new URLSearchParams('step=cloud');
    svc.getStatus.mockImplementation(() => new Promise(() => {}));
    render(<Setup />);
    expect(await screen.findByTestId('cloud-connect-step')).toBeInTheDocument();
    // Device pairing leads the step: the owner approves from a phone.
    expect(await screen.findByTestId('cloud-pairing-code')).toHaveTextContent('ABCD-2345');
    expect(screen.getByTestId('setup-step-counter')).toHaveTextContent('第 6/8 步 · Cloud');
  });

  it('shows a Cloud sign-in error carried back by the callback page', async () => {
    mockSearchParams = new URLSearchParams('step=cloud&error=access_denied');
    svc.getStatus.mockResolvedValue(makeOverview());
    render(<Setup />);
    expect(await screen.findByText(/登录没有完成（access_denied）/)).toBeInTheDocument();
  });

  it('shows a checklist load error with retry on the Cloud step', async () => {
    mockSearchParams = new URLSearchParams('step=cloud');
    onboarding.getChecklist.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(makeChecklist(['harness']));
    svc.getStatus.mockResolvedValue(makeOverview());
    render(<Setup />);
    expect(await screen.findByText('无法读取设置清单。')).toBeInTheDocument();
    await click('重试');
    expect(await screen.findByTestId('cloud-connect-step')).toBeInTheDocument();
  });

  it('the Slack step sends the owner to the Cloud step first', async () => {
    mockSearchParams = new URLSearchParams('step=slack');
    svc.getStatus.mockResolvedValue(makeOverview());
    render(<Setup />);
    await screen.findByTestId('slack-needs-cloud');
    await click('去连接 Crewly Cloud');
    expect(screen.getByTestId('cloud-connect-step')).toBeInTheDocument();
  });

  it('?step=first_task addresses the existing team with its starter examples', async () => {
    mockSearchParams = new URLSearchParams('step=first_task');
    onboarding.getChecklist.mockResolvedValue(makeChecklist(['harness', 'team']));
    svc.getStatus.mockResolvedValue(makeOverview());
    render(<Setup />);
    await waitFor(() => expect(screen.getByText(/交给「Personal Assistant」/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: STARTERS[0].suggestions[2] })).toBeInTheDocument();
  });
});

describe('Setup helpers', () => {
  it('initialStepFromQuery maps checklist ids to steps', () => {
    expect(initialStepFromQuery('team')).toBe(STEP.TEAM);
    expect(initialStepFromQuery('first_task')).toBe(STEP.TASK);
    expect(initialStepFromQuery('cloud')).toBe(STEP.CLOUD);
    expect(initialStepFromQuery('slack')).toBe(STEP.SLACK);
    expect(initialStepFromQuery('harness')).toBe(STEP.HARNESS);
    expect(initialStepFromQuery('bogus')).toBe(STEP.HARNESS);
    expect(initialStepFromQuery(null)).toBe(STEP.HARNESS);
  });

  it('resolveTaskTarget uses the first team and its starter, else Blank', () => {
    expect(resolveTaskTarget(makeChecklist(['team']), STARTERS)).toEqual({
      teamId: 't1',
      teamName: 'Personal Assistant',
      suggestions: STARTERS[0].suggestions,
    });
    expect(resolveTaskTarget(makeChecklist([]), STARTERS)).toEqual({ teamId: null, teamName: null, suggestions: STARTERS[2].suggestions });
    expect(resolveTaskTarget(null, [])).toEqual({ teamId: null, teamName: null, suggestions: [] });
  });
});
