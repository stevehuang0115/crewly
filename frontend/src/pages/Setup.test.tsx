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
import { bundleService } from '../services/bundle.service';
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

vi.mock('../services/bundle.service', () => ({
  BundleRequestError: class extends Error {},
  bundleService: { getBundle: vi.fn(), apply: vi.fn(), getJob: vi.fn() },
}));

const bundles = vi.mocked(bundleService);

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

    expect(await screen.findByText('Pick and install a coding harness')).toBeInTheDocument();
    expect(screen.getByTestId('step-indicator')).toBeInTheDocument();
    const claudeRadio = screen.getAllByRole('radio').find((r) => (r as HTMLInputElement).value === 'claude-code') as HTMLInputElement;
    expect(claudeRadio.checked).toBe(true);

    await click('Next');
    expect(screen.getByText('Which harness should the Orc use?')).toBeInTheDocument();
    expect((screen.getByDisplayValue('claude-code') as HTMLInputElement).checked).toBe(true);

    await click('Next');
    expect(svc.setOrcHarness).toHaveBeenCalledWith('claude-code');
    expect(screen.getByTestId('harness-login-card-claude-code')).toBeInTheDocument();
    expect(screen.getByTestId('login-start')).toHaveTextContent('Sign in with your Claude subscription');

    await click('Sign in later');
    expect(await screen.findByTestId('starter-team-step')).toBeInTheDocument();
    expect(screen.getByText('Create your first team')).toBeInTheDocument();
    await click('Skip'); // team
    expect(screen.getByText('Give your team its first task')).toBeInTheDocument();
    await click('Skip'); // first task
    expect(screen.getByText('Connect Crewly Cloud')).toBeInTheDocument();
    await click('Skip'); // cloud
    expect(screen.getByText('Connect Slack')).toBeInTheDocument();
    await click('Skip'); // slack
    expect(screen.getByTestId('setup-done')).toBeInTheDocument();
    expect(screen.getByTestId('setup-done-checklist')).toHaveTextContent('Sign in to a coding harness');
    await click('Open Crewly');
    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('carries the step-1 selection into the orc choice and skips the save when unchanged', async () => {
    svc.getStatus.mockResolvedValue(makeOverview({ orcHarness: null }));
    svc.setOrcHarness.mockResolvedValue('codex-cli');
    render(<Setup />);
    await screen.findByText('Pick and install a coding harness');
    fireEvent.click(screen.getAllByRole('radio').find((r) => (r as HTMLInputElement).value === 'codex-cli') as HTMLElement);
    await click('Next');
    expect((screen.getByDisplayValue('codex-cli') as HTMLInputElement).checked).toBe(true);
    await click('Next');
    expect(svc.setOrcHarness).toHaveBeenCalledWith('codex-cli');
    expect(screen.getByTestId('harness-login-card-codex-cli')).toBeInTheDocument();
    expect(screen.getByTestId('login-start')).toHaveTextContent('Sign in with ChatGPT');
  });

  it('does not re-save an unchanged orc harness and shows Next when logged in', async () => {
    svc.getStatus.mockResolvedValue(makeOverview({ orcHarness: 'claude-code' }));
    render(<Setup />);
    await screen.findByText('Pick and install a coding harness');
    await click('Next');
    await click('Next');
    expect(svc.setOrcHarness).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Next/ })).toBeInTheDocument();
  });

  it('blocks step 1 until a harness is installed', async () => {
    svc.getStatus.mockResolvedValue(
      makeOverview({ orcHarness: null, harnesses: [makeHarness({ installed: false, version: null }), GEMINI] }),
    );
    render(<Setup />);
    await screen.findByText('Pick and install a coding harness');
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled();
  });

  it('stays on the orc step when saving fails', async () => {
    svc.getStatus.mockResolvedValue(makeOverview({ orcHarness: null }));
    svc.setOrcHarness.mockRejectedValue(new Error('config is read-only'));
    render(<Setup />);
    await screen.findByText('Pick and install a coding harness');
    await click('Next');
    await click('Next');
    expect(screen.getByText('config is read-only')).toBeInTheDocument();
    expect(screen.getByText('Which harness should the Orc use?')).toBeInTheDocument();
  });

  it('"Skip for now" sets the skip flag and leaves', async () => {
    svc.getStatus.mockResolvedValue(makeOverview({ orcHarness: null }));
    render(<Setup />);
    await screen.findByText('Pick and install a coding harness');
    fireEvent.click(screen.getByTestId('setup-skip'));
    expect(window.localStorage.getItem(SETUP_SKIP_STORAGE_KEY)).toBe('1');
    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('shows a load error with retry', async () => {
    svc.getStatus.mockRejectedValueOnce(new Error('backend down')).mockResolvedValueOnce(makeOverview());
    render(<Setup />);
    expect(await screen.findByText('backend down')).toBeInTheDocument();
    await click(/Retry/);
    expect(await screen.findByText('Pick and install a coding harness')).toBeInTheDocument();
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
    expect(screen.getByText('Give your team its first task')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: STARTERS[0].suggestions[0] }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('first-task-send'));
    });
    expect(onboarding.sendFirstTask).toHaveBeenCalledWith(STARTERS[0].suggestions[0], 't1');
    await click('Next');
    expect(screen.getByText('Connect Crewly Cloud')).toBeInTheDocument();
  });

  it('deploys a solution bundle from the team step; the first-task step says the first week is planned', async () => {
    mockSearchParams = new URLSearchParams('step=team');
    svc.getStatus.mockResolvedValue(makeOverview({ orcHarness: 'claude-code' }));
    onboarding.getStarters.mockResolvedValue([
      ...STARTERS,
      { id: 'smb-marketing-team', kind: 'bundle', name: 'SMB', label: '小老板营销团队', tagline: 't', description: 'd', recommended: false, members: [{ name: 'Ava', role: 'team-leader' }], suggestions: [] },
    ]);
    bundles.getBundle.mockResolvedValue({
      bundle: {
        id: 'smb-marketing-team', name: 'SMB', label: '小老板营销团队', tagline: 't', description: 'd', status: 'ready', tier: 'pro',
        recommendedRuntime: 'crewly-agent', serverTier: 'entry', memberCount: 1, questionCount: 1, ownerSummary: '每天简报', ownerDoes: [],
        runtime: { recommended: 'crewly-agent' }, server: { tier: 'entry' },
        questions: [{ id: 'business_name', label: '公司叫什么？', type: 'text', required: true }],
        teams: [{ key: 'main', name: 'x', members: [{ name: 'Ava', role: 'team-leader', title: '负责人' }] }],
        skills: [], connectors: [], schedules: [], firstWeek: [], channels: [],
      },
      deployment: null,
    });
    bundles.apply.mockResolvedValue({
      templateId: 'smb-marketing-team', jobId: 'j', status: 'done', runtime: 'claude-code',
      teams: [{ key: 'main', teamId: 'smb-marketing-team', name: '小周咖啡 营销团队' }],
      steps: [{ id: 'team', label: '建团队', status: 'done' }], connectors: [], firstWeek: [],
    });
    render(<Setup />);

    fireEvent.click(await screen.findByTestId('starter-smb-marketing-team'));
    fireEvent.click(screen.getByTestId('starter-create'));
    fireEvent.change(await screen.findByLabelText(/公司叫什么/), { target: { value: '小周咖啡' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('bundle-deploy'));
    });
    expect(bundles.apply).toHaveBeenCalledWith('smb-marketing-team', { business_name: '小周咖啡' });
    await act(async () => {
      fireEvent.click(screen.getByTestId('bundle-finish'));
    });
    expect(screen.getByText('Give your team its first task')).toBeInTheDocument();
    expect(screen.getByTestId('setup-bundle-first-week')).toBeInTheDocument();
    expect(onboarding.createStarterTeam).not.toHaveBeenCalled();
  });

  it('?step=cloud opens the Cloud step without waiting for the harness status', async () => {
    mockSearchParams = new URLSearchParams('step=cloud');
    svc.getStatus.mockImplementation(() => new Promise(() => {}));
    render(<Setup />);
    expect(await screen.findByTestId('cloud-connect-step')).toBeInTheDocument();
    // Device pairing leads the step: the owner approves from a phone.
    expect(await screen.findByTestId('cloud-pairing-code')).toHaveTextContent('ABCD-2345');
    expect(screen.getByTestId('setup-step-counter')).toHaveTextContent('Step 6/8 · Cloud');
  });

  it('shows a Cloud sign-in error carried back by the callback page', async () => {
    mockSearchParams = new URLSearchParams('step=cloud&error=access_denied');
    svc.getStatus.mockResolvedValue(makeOverview());
    render(<Setup />);
    expect(await screen.findByText(/Sign-in didn't finish \(access_denied\)/)).toBeInTheDocument();
  });

  it('shows a checklist load error with retry on the Cloud step', async () => {
    mockSearchParams = new URLSearchParams('step=cloud');
    onboarding.getChecklist.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(makeChecklist(['harness']));
    svc.getStatus.mockResolvedValue(makeOverview());
    render(<Setup />);
    expect(await screen.findByText("Couldn't load the setup checklist.")).toBeInTheDocument();
    await click('Retry');
    expect(await screen.findByTestId('cloud-connect-step')).toBeInTheDocument();
  });

  it('the Slack step sends the owner to the Cloud step first', async () => {
    mockSearchParams = new URLSearchParams('step=slack');
    svc.getStatus.mockResolvedValue(makeOverview());
    render(<Setup />);
    await screen.findByTestId('slack-needs-cloud');
    await click('Connect Crewly Cloud');
    expect(screen.getByTestId('cloud-connect-step')).toBeInTheDocument();
  });

  it('?step=first_task addresses the existing team with its starter examples', async () => {
    mockSearchParams = new URLSearchParams('step=first_task');
    onboarding.getChecklist.mockResolvedValue(makeChecklist(['harness', 'team']));
    svc.getStatus.mockResolvedValue(makeOverview());
    render(<Setup />);
    await waitFor(() => expect(screen.getByText(/For "Personal Assistant"/)).toBeInTheDocument());
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
