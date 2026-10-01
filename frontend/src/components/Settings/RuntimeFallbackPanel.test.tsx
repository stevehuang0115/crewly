/**
 * Tests for Settings → Runtimes → Fallback.
 *
 * @module components/Settings/RuntimeFallbackPanel.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RuntimeFallbackPanel } from './RuntimeFallbackPanel';
import { runtimeFallbackService, type RuntimeFallbackState } from '../../services/runtime-fallback.service';
import { apiService } from '../../services/api.service';

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

const svc = vi.mocked(runtimeFallbackService);
const api = vi.mocked(apiService);

function makeState(overrides: Partial<RuntimeFallbackState> = {}): RuntimeFallbackState {
  return {
    settings: {
      enabled: true,
      chain: ['claude-code', 'crewly-agent', 'antigravity-cli'],
      memberChains: {},
      orcFollows: true,
      crewlyAgentModel: 'deepseek/deepseek-chat',
      probeIntervalMinutes: 15,
    },
    runtimes: [
      { runtime: 'claude-code', label: 'Claude Code', selectable: true, exhausted: false },
      { runtime: 'codex-cli', label: 'Codex', selectable: false, reason: 'Not signed in', exhausted: false },
      { runtime: 'antigravity-cli', label: 'Antigravity', selectable: true, exhausted: false },
      { runtime: 'gemini-cli', label: 'Gemini CLI', selectable: false, reason: 'Retired (enterprise only)', exhausted: false },
      { runtime: 'opencode-cli', label: 'OpenCode', selectable: false, reason: "Crewly can't check its sign-in", exhausted: false },
      { runtime: 'crewly-agent', label: 'DeepSeek', selectable: true, exhausted: false },
    ],
    exhausted: [],
    overrides: [],
    ...overrides,
  };
}

describe('RuntimeFallbackPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getTeams.mockResolvedValue([
      { id: 't1', name: 'Core', members: [{ id: 'm1', name: 'Ella' }] },
    ] as never);
  });

  it('shows the order with each runtime status and offers only signed-in runtimes to add', async () => {
    svc.getState.mockResolvedValue(makeState({ settings: { ...makeState().settings, chain: ['claude-code', 'crewly-agent'] } }));
    render(<RuntimeFallbackPanel />);
    const chain = await screen.findByTestId('fallback-global-chain');
    expect(within(chain).getByText('Claude Code')).toBeInTheDocument();
    expect(within(chain).getByText('DeepSeek')).toBeInTheDocument();

    const add = screen.getByTestId('fallback-global-add') as HTMLSelectElement;
    const options = Array.from(add.options).map((o) => [o.textContent, o.disabled]);
    expect(options).toContainEqual(['Antigravity', false]);
    expect(options).toContainEqual(['Codex — Not signed in', true]);
    expect(options).toContainEqual(['Gemini CLI — Retired (enterprise only)', true]);
  });

  it('reorders, then saves the new order', async () => {
    svc.getState.mockResolvedValue(makeState());
    svc.updateSettings.mockImplementation(async (patch) => makeState({ settings: { ...makeState().settings, ...patch } }));
    render(<RuntimeFallbackPanel />);
    await screen.findByTestId('fallback-global-chain');
    expect(screen.getByTestId('runtime-fallback-save')).toBeDisabled();

    fireEvent.click(screen.getByLabelText('Move Antigravity up'));
    fireEvent.click(screen.getByTestId('runtime-fallback-save'));
    await waitFor(() =>
      expect(svc.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ chain: ['claude-code', 'antigravity-cli', 'crewly-agent'] })),
    );
  });

  it('turns the orchestrator rule off', async () => {
    svc.getState.mockResolvedValue(makeState());
    svc.updateSettings.mockImplementation(async (patch) => makeState({ settings: { ...makeState().settings, ...patch } }));
    render(<RuntimeFallbackPanel />);
    await screen.findByTestId('runtime-fallback-panel');
    fireEvent.click(screen.getByLabelText('The orchestrator switches too'));
    fireEvent.click(screen.getByTestId('runtime-fallback-save'));
    await waitFor(() => expect(svc.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ orcFollows: false })));
  });

  it('gives an agent its own order', async () => {
    svc.getState.mockResolvedValue(makeState());
    svc.updateSettings.mockImplementation(async (patch) => makeState({ settings: { ...makeState().settings, ...patch } }));
    render(<RuntimeFallbackPanel />);
    await screen.findByTestId('runtime-fallback-panel');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Ella (Core)' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Agent for its own order'), { target: { value: 'm1' } });
    fireEvent.click(screen.getByText('Give it its own order'));
    expect(screen.getByTestId('fallback-member-m1')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('runtime-fallback-save'));
    await waitFor(() =>
      expect(svc.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ memberChains: { m1: ['claude-code', 'crewly-agent', 'antigravity-cli'] } }),
      ),
    );
  });

  it('shows an exhausted runtime and the agents on a fallback', async () => {
    svc.getState.mockResolvedValue(
      makeState({
        exhausted: [{ runtime: 'claude-code', since: '2026-10-01T12:00:00Z', ruleId: 'claude.hit_your_limit', switched: ['dev-1'], switchedTo: ['crewly-agent'], notified: true }],
        overrides: [
          {
            sessionName: 'dev-1',
            runtime: 'crewly-agent',
            primary: 'claude-code',
            reason: 'usage_limit',
            since: '2026-10-01T12:00:00Z',
            badge: 'on DeepSeek (Claude limit)',
            runtimeLabel: 'DeepSeek',
            primaryLabel: 'Claude Code',
          },
        ],
      }),
    );
    render(<RuntimeFallbackPanel />);
    expect(await screen.findByTestId('runtime-fallback-exhausted')).toHaveTextContent('Claude Code is out of usage. 1 agent on DeepSeek until then.');
    expect(screen.getByTestId('runtime-fallback-overrides')).toHaveTextContent('dev-1 — on DeepSeek (Claude limit)');
  });

  it('runs a smoke test and shows the failing step and the screen', async () => {
    svc.getState.mockResolvedValue(makeState());
    svc.startSmokeTest.mockResolvedValue({ jobId: 'j1', runtime: 'antigravity-cli', state: 'running', startedAt: 'now' });
    svc.getSmokeTest.mockResolvedValue({
      jobId: 'j1',
      runtime: 'antigravity-cli',
      state: 'done',
      startedAt: 'now',
      result: {
        runtime: 'antigravity-cli',
        passed: false,
        failedStep: 'agent_ready',
        error: 'Antigravity needs its terms accepted once',
        steps: [],
        screen: 'Terms of Service & Data Use',
        durationMs: 9000,
      },
    });
    render(<RuntimeFallbackPanel smokePollMs={5} />);
    const row = await screen.findByTestId('runtime-test-antigravity-cli');
    fireEvent.click(within(row).getByText('Test'));
    const result = await screen.findByTestId('runtime-test-result-antigravity-cli');
    expect(result).toHaveTextContent('Failed at “agent ready”: Antigravity needs its terms accepted once');
    expect(result).toHaveTextContent('Terms of Service & Data Use');
    expect(svc.startSmokeTest).toHaveBeenCalledWith('antigravity-cli');
    // Runtimes that cannot run are not offered for a test.
    expect(screen.queryByTestId('runtime-test-codex-cli')).not.toBeInTheDocument();
  });

  it('shows a load error with a retry', async () => {
    svc.getState.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(makeState());
    render(<RuntimeFallbackPanel />);
    expect(await screen.findByText('boom')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    expect(await screen.findByTestId('runtime-fallback-panel')).toBeInTheDocument();
  });

  it('lets the owner re-add and test a runtime whose Terms were not accepted (that asks again)', async () => {
    svc.getState.mockResolvedValue(
      makeState({
        settings: { ...makeState().settings, chain: ['claude-code'] },
        runtimes: [
          { runtime: 'claude-code', label: 'Claude Code', selectable: true, exhausted: false },
          { runtime: 'antigravity-cli', label: 'Antigravity', selectable: false, termsBlocked: true, reason: "Terms not accepted: You chose Don't agree", exhausted: false },
        ],
      }),
    );
    render(<RuntimeFallbackPanel />);
    const option = await screen.findByRole('option', { name: /Antigravity — terms not accepted/ });
    expect(option).not.toBeDisabled();
    expect(screen.getByTestId('runtime-test-antigravity-cli')).toBeInTheDocument();
  });
});

