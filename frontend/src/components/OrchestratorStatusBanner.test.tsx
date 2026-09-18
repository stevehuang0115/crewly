/**
 * OrchestratorStatusBanner Tests
 *
 * @module components/OrchestratorStatusBanner.test
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { OrchestratorStatusBanner } from './OrchestratorStatusBanner';

const mockRefresh = vi.fn();

vi.mock('../hooks/useOrchestratorStatus', () => ({
  useOrchestratorStatus: vi.fn(() => ({
    status: null,
    isLoading: true,
    error: null,
    refresh: mockRefresh,
  })),
}));

import { useOrchestratorStatus } from '../hooks/useOrchestratorStatus';

describe('OrchestratorStatusBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should not render while loading', () => {
    vi.mocked(useOrchestratorStatus).mockReturnValue({
      status: null,
      isLoading: true,
      error: null,
      refresh: mockRefresh,
    });

    render(<OrchestratorStatusBanner />);
    expect(screen.queryByText('Orchestrator Not Running')).not.toBeInTheDocument();
  });

  it('should not render when orchestrator is active', () => {
    vi.mocked(useOrchestratorStatus).mockReturnValue({
      status: { isActive: true, agentStatus: 'active', message: 'Active', offlineMessage: null },
      isLoading: false,
      error: null,
      refresh: mockRefresh,
    });

    render(<OrchestratorStatusBanner />);
    expect(screen.queryByText('Orchestrator Not Running')).not.toBeInTheDocument();
  });

  it('should render error banner when orchestrator is inactive', () => {
    vi.mocked(useOrchestratorStatus).mockReturnValue({
      status: { isActive: false, agentStatus: 'inactive', message: 'Inactive', offlineMessage: 'Offline' },
      isLoading: false,
      error: null,
      refresh: mockRefresh,
    });

    render(<OrchestratorStatusBanner />);
    expect(screen.getByText('Orchestrator Not Running')).toBeInTheDocument();
  });

  it('should render initializing banner when orchestrator is starting', () => {
    vi.mocked(useOrchestratorStatus).mockReturnValue({
      status: { isActive: false, agentStatus: 'starting', message: 'Starting', offlineMessage: null },
      isLoading: false,
      error: null,
      refresh: mockRefresh,
    });

    render(<OrchestratorStatusBanner />);
    expect(screen.getByText('Orchestrator Initializing')).toBeInTheDocument();
  });

  it('should call refresh when refresh button is clicked', async () => {
    vi.mocked(useOrchestratorStatus).mockReturnValue({
      status: { isActive: false, agentStatus: 'inactive', message: 'Inactive', offlineMessage: 'Offline' },
      isLoading: false,
      error: null,
      refresh: mockRefresh,
    });

    const user = userEvent.setup();
    render(<OrchestratorStatusBanner />);

    await user.click(screen.getByLabelText('Refresh status'));

    expect(mockRefresh).toHaveBeenCalled();
  });

  it('should hide banner when dismiss is clicked', async () => {
    vi.mocked(useOrchestratorStatus).mockReturnValue({
      status: { isActive: false, agentStatus: 'inactive', message: 'Inactive', offlineMessage: 'Offline' },
      isLoading: false,
      error: null,
      refresh: mockRefresh,
    });

    const user = userEvent.setup();
    render(<OrchestratorStatusBanner />);

    expect(screen.getByText('Orchestrator Not Running')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Dismiss banner'));

    await waitFor(() => {
      expect(screen.queryByText('Orchestrator Not Running')).not.toBeInTheDocument();
    });
  });

  describe('sign-in needed', () => {
    const loginRequired = { url: 'https://auth.openai.com/device', code: 'FBVZ-MJHKK', detectedAt: '2026-09-18T10:00:00.000Z' };

    it('shows the sign-in title and chip when the orchestrator is parked on a login screen', async () => {
      vi.mocked(useOrchestratorStatus).mockReturnValue({
        status: { isActive: false, agentStatus: 'starting', message: 'needs sign in', offlineMessage: 'Offline', loginRequired },
        isLoading: false,
        error: null,
        refresh: mockRefresh,
      });

      render(<OrchestratorStatusBanner />);
      expect(screen.getByText('Orchestrator Needs Sign-in')).toBeInTheDocument();
      expect(screen.queryByText('Orchestrator Initializing')).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /sign-in needed/i }));
      expect(screen.getByTestId('sign-in-url')).toHaveAttribute('href', loginRequired.url);
      expect(screen.getByTestId('sign-in-code')).toHaveTextContent('FBVZ-MJHKK');
    });

    it('still renders when the status reads active but a sign-in is pending', () => {
      vi.mocked(useOrchestratorStatus).mockReturnValue({
        status: { isActive: true, agentStatus: 'active', message: 'Active', offlineMessage: null, loginRequired },
        isLoading: false,
        error: null,
        refresh: mockRefresh,
      });

      render(<OrchestratorStatusBanner />);
      expect(screen.getByText('Orchestrator Needs Sign-in')).toBeInTheDocument();
    });
  });
});
