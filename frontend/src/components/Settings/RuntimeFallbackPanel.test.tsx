/**
 * Tests for Settings › Runtimes › Fallback pieces, rendered together on one
 * shared draft the way the Runtimes tab uses them.
 *
 * @module components/Settings/RuntimeFallbackPanel.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FallbackOrderSection,
  OrcFollowsToggle,
  PerAgentOrderSection,
  RuntimeSmokeTest,
  formatResetTime,
} from './RuntimeFallbackPanel';
import { useRuntimeFallback } from '../../hooks/useRuntimeFallback';
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

/** The fallback pieces on one draft, plus the load error with Retry. */
const RuntimeFallbackPanel: React.FC<{ smokePollMs?: number }> = ({ smokePollMs }) => {
  const fb = useRuntimeFallback(smokePollMs);
  if (!fb.state) return fb.error ? <button type="button" onClick={() => void fb.load()}>{fb.error} Retry</button> : null;
  return (
    <>
      <FallbackOrderSection fb={fb} />
      <PerAgentOrderSection fb={fb} />
      <OrcFollowsToggle fb={fb} />
      <RuntimeSmokeTest fb={fb} />
    </>
  );
};

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
    const select = (await screen.findByLabelText('Runtime to test')) as HTMLSelectElement;
    // Runtimes that cannot run are not offered for a test.
    expect(Array.from(select.options).map((o) => o.value)).not.toContain('codex-cli');
    fireEvent.change(select, { target: { value: 'antigravity-cli' } });
    fireEvent.click(screen.getByTestId('runtime-test-button'));
    const result = await screen.findByTestId('runtime-test-result-antigravity-cli');
    expect(result).toHaveTextContent('Failed at “agent ready”: Antigravity needs its terms accepted once');
    expect(result).toHaveTextContent('Terms of Service & Data Use');
    expect(svc.startSmokeTest).toHaveBeenCalledWith('antigravity-cli');
  });

  it('shows a load error with a retry', async () => {
    svc.getState.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(makeState());
    render(<RuntimeFallbackPanel />);
    fireEvent.click(await screen.findByText(/boom/));
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
    const select = screen.getByLabelText('Runtime to test') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toContain('antigravity-cli');
  });
});

describe('formatResetTime', () => {
  it('shows only the time for today and the date otherwise', () => {
    const now = new Date();
    now.setHours(15, 0, 0, 0);
    expect(formatResetTime(now.toISOString())).toBe('3:00 PM');
    expect(formatResetTime('2020-10-06T09:00:00')).toMatch(/^Oct 6, 9:00 AM$/);
  });
});
