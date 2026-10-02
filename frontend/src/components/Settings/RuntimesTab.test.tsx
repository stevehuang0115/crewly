/**
 * Tests for Settings › Runtimes.
 *
 * @module components/Settings/RuntimesTab.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RuntimesTab, harnessRowStatus, runtimeMeta } from './RuntimesTab';
import { harnessService } from '../../services/harness.service';
import { runtimeFallbackService, type RuntimeFallbackState } from '../../services/runtime-fallback.service';
import { apiService } from '../../services/api.service';
import { CODEX, makeHarness, makeOverview } from '../../test/harness.fixtures';

vi.mock('../../services/harness.service', () => ({
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

vi.mock('../../services/runtime-fallback.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/runtime-fallback.service')>()),
  runtimeFallbackService: {
    getState: vi.fn(),
    updateSettings: vi.fn(),
    startSmokeTest: vi.fn(),
    getSmokeTest: vi.fn(),
  },
}));

vi.mock('../../services/api.service', () => ({
  apiService: { getTeams: vi.fn() },
}));

vi.mock('./RuntimeTermsPanel', () => ({
  RuntimeTermsPanel: () => <div data-testid="runtime-terms-panel" />,
}));

const svc = vi.mocked(harnessService);
const fbSvc = vi.mocked(runtimeFallbackService);
const api = vi.mocked(apiService);

function fallbackState(overrides: Partial<RuntimeFallbackState> = {}): RuntimeFallbackState {
  return {
    settings: { enabled: true, chain: ['claude-code', 'crewly-agent'], memberChains: {}, orcFollows: true, crewlyAgentModel: 'deepseek/deepseek-chat', probeIntervalMinutes: 15 },
    runtimes: [
      { runtime: 'claude-code', label: 'Claude Code', selectable: true, exhausted: false },
      { runtime: 'codex-cli', label: 'Codex', selectable: false, reason: 'Not signed in', exhausted: false },
      { runtime: 'antigravity-cli', label: 'Antigravity', selectable: false, reason: 'Not installed', exhausted: false },
      { runtime: 'gemini-cli', label: 'Gemini CLI', selectable: false, reason: 'Retired (enterprise only)', exhausted: false },
      { runtime: 'opencode-cli', label: 'OpenCode', selectable: false, reason: "Crewly can't check its sign-in", exhausted: false },
      { runtime: 'crewly-agent', label: 'DeepSeek', selectable: true, exhausted: false },
    ],
    exhausted: [],
    overrides: [],
    ...overrides,
  };
}

const renderTab = () =>
  render(
    <MemoryRouter>
      <RuntimesTab smokePollMs={5} />
    </MemoryRouter>,
  );

describe('RuntimesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fbSvc.getState.mockResolvedValue(fallbackState());
    api.getTeams.mockResolvedValue([] as never);
  });

  it('shows one row per runtime with a status word, plus DeepSeek from the fallback list', async () => {
    svc.getStatus.mockResolvedValue(makeOverview());
    renderTab();
    await screen.findByTestId('harness-tab');

    expect(screen.getByTestId('runtime-status-claude-code')).toHaveTextContent('Ready');
    expect(screen.getByTestId('runtime-status-codex-cli')).toHaveTextContent('Sign-in needed');
    expect(screen.getByTestId('runtime-status-antigravity-cli')).toHaveTextContent('Not installed');
    // Gemini CLI is retired: not installed and not the orc harness, so not listed.
    expect(screen.queryByTestId('runtime-row-gemini-cli')).not.toBeInTheDocument();
    expect(await screen.findByTestId('runtime-row-crewly-agent')).toHaveTextContent('DeepSeek');
    // OpenCode can't be used here and is not in the order: left out.
    expect(screen.queryByTestId('runtime-row-opencode-cli')).not.toBeInTheDocument();
    // The orchestrator line.
    expect(screen.getByText(/The orchestrator runs on/)).toHaveTextContent('The orchestrator runs on Claude Code');
    expect(within(screen.getByTestId('runtime-row-claude-code')).getByText('Runs the orchestrator')).toBeInTheDocument();
  });

  it('one visible action per row: Sign in opens the sign-in card; Install starts an install with its log', async () => {
    svc.getStatus.mockResolvedValue(makeOverview());
    svc.startInstall.mockResolvedValue('job-1');
    svc.getInstallJob.mockResolvedValue({ state: 'running', log: 'npm install …', usedUserPrefix: false });
    renderTab();
    await screen.findByTestId('harness-tab');

    fireEvent.click(within(screen.getByTestId('runtime-row-codex-cli')).getByRole('button', { name: 'Sign in' }));
    expect(screen.getByTestId('harness-login-card-codex-cli')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(screen.getByTestId('runtime-row-antigravity-cli')).getByRole('button', { name: 'Install' }));
    });
    expect(svc.startInstall).toHaveBeenCalledWith('antigravity-cli');
    expect(within(screen.getByTestId('runtime-row-antigravity-cli')).getByTestId('install-log')).toBeInTheDocument();
  });

  it('"Sign in again" from the ⋯ menu opens the sign-in methods for a signed-in runtime', async () => {
    svc.getStatus.mockResolvedValue(makeOverview());
    renderTab();
    await screen.findByTestId('harness-tab');
    fireEvent.click(screen.getByRole('button', { name: 'More for Claude Code' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Sign in again/ }));
    const card = screen.getByTestId('harness-login-card-claude-code');
    // Straight to the methods, not the "Signed in. Sign in again" step.
    expect(within(card).queryByRole('button', { name: 'Sign in again' })).not.toBeInTheDocument();
  });

  it('⋯ Details shows the version and where the login came from', async () => {
    svc.getStatus.mockResolvedValue(makeOverview({ harnesses: [makeHarness({ version: '2.1.3', loginSource: 'Claude subscription' }), CODEX] }));
    renderTab();
    await screen.findByTestId('harness-tab');
    fireEvent.click(screen.getByRole('button', { name: 'More for Claude Code' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Details/ }));
    const details = screen.getByTestId('runtime-details-claude-code');
    expect(details).toHaveTextContent('2.1.3');
    expect(details).toHaveTextContent('Signed in via Claude subscription');
  });

  it('⋯ Test this runtime runs the smoke test and shows the result under the row', async () => {
    svc.getStatus.mockResolvedValue(makeOverview());
    fbSvc.startSmokeTest.mockResolvedValue({ jobId: 'j1', runtime: 'claude-code', state: 'running', startedAt: 'now' });
    fbSvc.getSmokeTest.mockResolvedValue({
      jobId: 'j1',
      runtime: 'claude-code',
      state: 'done',
      startedAt: 'now',
      result: { runtime: 'claude-code', passed: true, steps: [], durationMs: 42000 },
    });
    renderTab();
    await screen.findByTestId('runtime-row-crewly-agent');
    fireEvent.click(screen.getByRole('button', { name: 'More for Claude Code' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Test this runtime/ }));
    expect(await screen.findByTestId('runtime-row-test-claude-code')).toHaveTextContent('Claude Code passed in 42s');
    expect(fbSvc.startSmokeTest).toHaveBeenCalledWith('claude-code');
  });

  it('flags an exhausted runtime on its row with the reset and the agents moved', async () => {
    svc.getStatus.mockResolvedValue(makeOverview());
    fbSvc.getState.mockResolvedValue(
      fallbackState({
        exhausted: [{ runtime: 'claude-code', since: '2026-10-01T12:00:00Z', ruleId: 'r', switched: ['dev-1'], switchedTo: ['crewly-agent'], notified: true }],
        overrides: [
          { sessionName: 'dev-1', runtime: 'crewly-agent', primary: 'claude-code', reason: 'usage_limit', since: '', badge: 'on DeepSeek (Claude limit)', runtimeLabel: 'DeepSeek', primaryLabel: 'Claude Code' },
        ],
        runtimes: fallbackState().runtimes.map((r) => (r.runtime === 'claude-code' ? { ...r, exhausted: true } : r)),
      }),
    );
    renderTab();
    await waitFor(() => expect(screen.getByTestId('runtime-status-claude-code')).toHaveTextContent('Out of usage'));
    expect(screen.getByTestId('runtime-row-claude-code')).toHaveTextContent('1 agent on DeepSeek until then');
  });

  it('changes the orc harness from "Change" and saves it immediately', async () => {
    svc.getStatus.mockResolvedValue(makeOverview());
    svc.setOrcHarness.mockResolvedValue('codex-cli');
    renderTab();
    await screen.findByTestId('harness-tab');
    expect(screen.queryByTestId('orc-harness-picker')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await act(async () => {
      fireEvent.click(screen.getByDisplayValue('codex-cli'));
    });
    expect(svc.setOrcHarness).toHaveBeenCalledWith('codex-cli');
  });

  it('keeps an installed Gemini CLI, labelled "(enterprise only)"', async () => {
    const overview = makeOverview();
    overview.harnesses = overview.harnesses.map((h) => (h.id === 'gemini-cli' ? { ...h, installed: true, version: '0.61.0' } : h));
    svc.getStatus.mockResolvedValue(overview);
    renderTab();
    await screen.findByTestId('harness-tab');
    expect(within(screen.getByTestId('runtime-row-gemini-cli')).getByText('Gemini CLI (enterprise only)')).toBeInTheDocument();
  });

  it('puts terms, per-agent order, the orchestrator rule and the runtime test under Advanced', async () => {
    svc.getStatus.mockResolvedValue(makeOverview());
    renderTab();
    await screen.findByTestId('runtime-fallback-panel');
    const advanced = screen.getByTestId('runtimes-advanced');
    expect(within(advanced).getByRole('button', { name: /Advanced/ })).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(within(advanced).getByRole('button', { name: /Advanced/ }));
    expect(within(advanced).getByTestId('runtime-terms-panel')).toBeInTheDocument();
    expect(within(advanced).getByTestId('fallback-per-agent')).toBeInTheDocument();
    expect(within(advanced).getByLabelText('The orchestrator switches too')).toBeInTheDocument();
    expect(within(advanced).getByTestId('runtime-smoke-test')).toBeInTheDocument();
  });

  it('a change under Advanced can be saved there', async () => {
    svc.getStatus.mockResolvedValue(makeOverview());
    fbSvc.updateSettings.mockImplementation(async (patch) => fallbackState({ settings: { ...fallbackState().settings, ...patch } }));
    renderTab();
    await screen.findByTestId('runtime-fallback-panel');
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    expect(screen.queryByTestId('runtime-fallback-save-advanced')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('The orchestrator switches too'));
    fireEvent.click(screen.getByTestId('runtime-fallback-save-advanced'));
    await waitFor(() => expect(fbSvc.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ orcFollows: false })));
  });

  it('shows a load error with retry', async () => {
    svc.getStatus.mockRejectedValueOnce(new Error('backend down')).mockResolvedValueOnce(makeOverview());
    renderTab();
    expect(await screen.findByText('backend down')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    });
    expect(await screen.findByTestId('harness-tab')).toBeInTheDocument();
  });
});

describe('harnessRowStatus', () => {
  it('picks the most urgent word', () => {
    expect(harnessRowStatus(makeHarness({ installed: false }))).toEqual({ word: 'Not installed', tone: 'neutral' });
    expect(harnessRowStatus(makeHarness(), { runtime: 'claude-code', label: 'Claude Code', selectable: true, exhausted: true }).word).toBe('Out of usage');
    expect(harnessRowStatus(makeHarness({ loginState: 'logged_out' })).word).toBe('Sign-in needed');
    expect(harnessRowStatus(makeHarness({ updateAvailable: true })).word).toBe('Update available');
    expect(harnessRowStatus(makeHarness())).toEqual({ word: 'Ready', tone: 'success' });
  });
});

describe('runtimeMeta', () => {
  it('joins extra facts with the exhausted details', () => {
    expect(runtimeMeta('claude-code', null, ['Runs the orchestrator'])).toBe('Runs the orchestrator');
    expect(
      runtimeMeta('claude-code', { ...fallbackState(), exhausted: [{ runtime: 'claude-code', since: '', ruleId: 'r', switched: [], switchedTo: [], notified: true, noFallback: true }] }),
    ).toBe('No fallback runtime is available');
  });
});
