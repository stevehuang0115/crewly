/**
 * Tests for HarnessCard: badges and the install flow with polling.
 *
 * @module components/Harness/HarnessCard.test
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HarnessCard } from './HarnessCard';
import { harnessService } from '../../services/harness.service';
import { makeHarness } from '../../test/harness.fixtures';

vi.mock('../../services/harness.service', () => ({
  harnessService: {
    startInstall: vi.fn(),
    getInstallJob: vi.fn(),
  },
}));

const svc = vi.mocked(harnessService);

describe('HarnessCard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows installed version, update and login badges', () => {
    render(
      <HarnessCard
        harness={makeHarness({ version: '2.0.1', updateAvailable: true, latestVersion: '2.1.0', loginState: 'logged_out' })}
      />,
    );
    expect(screen.getByText('Installed v2.0.1')).toBeInTheDocument();
    expect(screen.getByText('Update available → v2.1.0')).toBeInTheDocument();
    expect(screen.getByText('Not signed in')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Update/ })).toBeInTheDocument();
  });

  it('shows not-installed state with an install button and no login badge', () => {
    render(<HarnessCard harness={makeHarness({ installed: false, version: null })} />);
    expect(screen.getByText('Not installed')).toBeInTheDocument();
    expect(screen.queryByText('Signed in')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Install/ })).toBeInTheDocument();
  });

  it('hides the button when installed and up to date', () => {
    render(<HarnessCard harness={makeHarness()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('selects via its radio', () => {
    const onSelect = vi.fn();
    render(<HarnessCard harness={makeHarness({ id: 'codex-cli' })} selectName="h" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('radio'));
    expect(onSelect).toHaveBeenCalledWith('codex-cli');
  });

  describe('install flow', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('streams the log while polling and explains a user-prefix install', async () => {
      svc.startInstall.mockResolvedValue('job-1');
      svc.getInstallJob
        .mockResolvedValueOnce({ state: 'running', log: 'npm install -g @openai/codex', usedUserPrefix: false })
        .mockResolvedValueOnce({ state: 'succeeded', log: 'npm install -g @openai/codex\nadded 1 package', usedUserPrefix: true });
      const onInstallFinished = vi.fn();
      render(
        <HarnessCard
          harness={makeHarness({ id: 'codex-cli', displayName: 'Codex', installed: false, version: null })}
          onInstallFinished={onInstallFinished}
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Install/ }));
      });
      expect(svc.startInstall).toHaveBeenCalledWith('codex-cli');
      expect(screen.getByTestId('install-log')).toBeInTheDocument();
      expect(screen.getByText('Installing…')).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.getByTestId('install-log').textContent).toContain('npm install -g @openai/codex');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.getByTestId('install-log').textContent).toContain('added 1 package');
      expect(screen.getByText(/Installed to your user folder/)).toBeInTheDocument();
      expect(onInstallFinished).toHaveBeenCalledWith(expect.objectContaining({ state: 'succeeded' }));
    });

    it('offers a retry when the install fails', async () => {
      svc.startInstall.mockResolvedValue('job-2');
      svc.getInstallJob.mockResolvedValueOnce({ state: 'failed', log: 'EACCES', usedUserPrefix: false });
      render(<HarnessCard harness={makeHarness({ installed: false, version: null })} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Install/ }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.getByText('Install failed')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry install' })).toBeInTheDocument();
    });
  });
});
