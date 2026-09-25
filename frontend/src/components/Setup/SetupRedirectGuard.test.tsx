/**
 * Tests for the first-run redirect guard, including the skip flag.
 *
 * @module components/Setup/SetupRedirectGuard.test
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SetupRedirectGuard } from './SetupRedirectGuard';
import { harnessService } from '../../services/harness.service';
import { makeHarness, makeOverview } from '../../test/harness.fixtures';
import { SETUP_SKIP_STORAGE_KEY } from '../../constants/harness.constants';
import type { HarnessOverview } from '../../types/harness.types';

vi.mock('../../services/harness.service', () => ({
  harnessService: { getStatus: vi.fn() },
}));

const svc = vi.mocked(harnessService);

/**
 * Render the guard at a path with page markers.
 *
 * @param path - Initial path
 */
function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SetupRedirectGuard />
      <Routes>
        <Route path="/" element={<div>Dashboard Page</div>} />
        <Route path="/settings" element={<div>Settings Page</div>} />
        <Route path="/setup" element={<div>Setup Page</div>} />
        <Route path="/auth" element={<div>Auth Page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Let the status promise settle. */
async function settle(): Promise<void> {
  await waitFor(() => expect(svc.getStatus).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
}

describe('SetupRedirectGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  const cases: Array<[string, HarnessOverview]> = [
    ['no orc harness', makeOverview({ orcHarness: null })],
    ['orc harness not installed', makeOverview({ harnesses: [makeHarness({ installed: false })] })],
    ['orc harness logged out', makeOverview({ harnesses: [makeHarness({ loginState: 'logged_out' })] })],
  ];

  it.each(cases)('redirects to /setup when %s', async (_label, overview) => {
    svc.getStatus.mockResolvedValue(overview);
    renderAt('/');
    expect(await screen.findByText('Setup Page')).toBeInTheDocument();
  });

  it('stays put when the orc harness is ready', async () => {
    svc.getStatus.mockResolvedValue(makeOverview());
    renderAt('/settings');
    await settle();
    expect(screen.getByText('Settings Page')).toBeInTheDocument();
  });

  it('stays put when the login state is unknown', async () => {
    svc.getStatus.mockResolvedValue(makeOverview({ harnesses: [makeHarness({ loginState: 'unknown' })] }));
    renderAt('/');
    await settle();
    expect(screen.getByText('Dashboard Page')).toBeInTheDocument();
  });

  it('does not redirect (or even fetch) when the skip flag is set', async () => {
    window.localStorage.setItem(SETUP_SKIP_STORAGE_KEY, '1');
    svc.getStatus.mockResolvedValue(makeOverview({ orcHarness: null }));
    renderAt('/');
    await new Promise((r) => setTimeout(r, 0));
    expect(svc.getStatus).not.toHaveBeenCalled();
    expect(screen.getByText('Dashboard Page')).toBeInTheDocument();
  });

  it('never fires from /setup or /auth', async () => {
    svc.getStatus.mockResolvedValue(makeOverview({ orcHarness: null }));
    renderAt('/auth');
    await new Promise((r) => setTimeout(r, 0));
    expect(svc.getStatus).not.toHaveBeenCalled();
    expect(screen.getByText('Auth Page')).toBeInTheDocument();
  });

  it('does not block the app when the status request fails', async () => {
    svc.getStatus.mockRejectedValue(new Error('401'));
    renderAt('/');
    await settle();
    expect(screen.getByText('Dashboard Page')).toBeInTheDocument();
  });

  it('treats unavailable storage as not skipped', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    svc.getStatus.mockResolvedValue(makeOverview({ orcHarness: null }));
    renderAt('/');
    expect(await screen.findByText('Setup Page')).toBeInTheDocument();
    spy.mockRestore();
  });
});
