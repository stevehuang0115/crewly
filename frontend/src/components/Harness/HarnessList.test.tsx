/**
 * Tests for HarnessList: status list rendering.
 *
 * @module components/Harness/HarnessList.test
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { HarnessList } from './HarnessList';
import { makeHarness, CODEX, GEMINI } from '../../test/harness.fixtures';

vi.mock('../../services/harness.service', () => ({
  harnessService: { startInstall: vi.fn(), getInstallJob: vi.fn() },
}));

describe('HarnessList', () => {
  const harnesses = [makeHarness(), CODEX, GEMINI];

  it('renders a card per harness with its status', () => {
    render(<HarnessList harnesses={harnesses} />);
    const claude = screen.getByTestId('harness-card-claude-code');
    expect(within(claude).getByText('Claude Code')).toBeInTheDocument();
    expect(within(claude).getByText('已登录')).toBeInTheDocument();
    expect(within(screen.getByTestId('harness-card-codex-cli')).getByText('未登录')).toBeInTheDocument();
    expect(within(screen.getByTestId('harness-card-gemini-cli')).getByText('未安装 / Not installed')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('supports radio selection when onSelect is given', () => {
    const onSelect = vi.fn();
    render(<HarnessList harnesses={harnesses} selectedId="claude-code" onSelect={onSelect} />);
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(3);
    expect(radios[0].checked).toBe(true);
    fireEvent.click(radios[1]);
    expect(onSelect).toHaveBeenCalledWith('codex-cli');
  });

  it('warns about missing system tools with the install hint', () => {
    render(
      <HarnessList
        harnesses={harnesses}
        systemTools={[
          { id: 'jq', installed: false, installHint: 'brew install jq' },
          { id: 'git', installed: true, installHint: 'x' },
        ]}
      />,
    );
    expect(screen.getByText(/Missing jq/)).toBeInTheDocument();
    expect(screen.getByText('brew install jq')).toBeInTheDocument();
    expect(screen.queryByText(/Missing git/)).not.toBeInTheDocument();
  });
});
