/**
 * Tests for the Settings → Harness tab.
 *
 * @module components/Settings/HarnessTab.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HarnessTab } from './HarnessTab';
import { harnessService } from '../../services/harness.service';
import { makeOverview } from '../../test/harness.fixtures';

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

const svc = vi.mocked(harnessService);

describe('HarnessTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the list, the orc choice and a login card per installed harness (orc first)', async () => {
    svc.getStatus.mockResolvedValue(makeOverview({ orcHarness: 'codex-cli' }));
    render(<HarnessTab />);
    await screen.findByTestId('harness-tab');

    expect(screen.getByTestId('harness-card-claude-code')).toBeInTheDocument();
    expect(screen.getByTestId('harness-card-antigravity-cli')).toBeInTheDocument();
    // Gemini CLI is retired: not installed and not the orc harness, so not listed.
    expect(screen.queryByTestId('harness-card-gemini-cli')).not.toBeInTheDocument();
    expect((screen.getByDisplayValue('codex-cli') as HTMLInputElement).checked).toBe(true);

    const cards = screen.getAllByTestId(/^harness-login-card-/);
    expect(cards.map((c) => c.dataset.testid)).toEqual(['harness-login-card-codex-cli', 'harness-login-card-claude-code']);
  });

  it('keeps an installed Gemini CLI, labelled "(enterprise only)"', async () => {
    const overview = makeOverview();
    overview.harnesses = overview.harnesses.map((h) => (h.id === 'gemini-cli' ? { ...h, installed: true, version: '0.61.0' } : h));
    svc.getStatus.mockResolvedValue(overview);
    render(<HarnessTab />);
    await screen.findByTestId('harness-tab');

    expect(within(screen.getByTestId('harness-card-gemini-cli')).getByText('Gemini CLI (enterprise only)')).toBeInTheDocument();
    // Offered for the orchestrator only when it already is the orchestrator's harness.
    expect(screen.queryByDisplayValue('gemini-cli')).not.toBeInTheDocument();
  });

  it('lists Gemini CLI when the orchestrator runs on it', async () => {
    svc.getStatus.mockResolvedValue(makeOverview({ orcHarness: 'gemini-cli' }));
    render(<HarnessTab />);
    await screen.findByTestId('harness-tab');
    expect(screen.getByTestId('harness-card-gemini-cli')).toBeInTheDocument();
  });

  it('saves a new orc harness immediately', async () => {
    svc.getStatus.mockResolvedValue(makeOverview());
    svc.setOrcHarness.mockResolvedValue('codex-cli');
    render(<HarnessTab />);
    await screen.findByTestId('harness-tab');
    await act(async () => {
      fireEvent.click(screen.getByDisplayValue('codex-cli'));
    });
    expect(svc.setOrcHarness).toHaveBeenCalledWith('codex-cli');
    await waitFor(() => expect((screen.getByDisplayValue('codex-cli') as HTMLInputElement).checked).toBe(true));
  });

  it('shows a load error with retry', async () => {
    svc.getStatus.mockRejectedValueOnce(new Error('backend down')).mockResolvedValueOnce(makeOverview());
    render(<HarnessTab />);
    expect(await screen.findByText('backend down')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    });
    expect(await screen.findByTestId('harness-tab')).toBeInTheDocument();
  });
});
