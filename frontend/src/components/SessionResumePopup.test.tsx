/**
 * Session Resume Popup Tests
 *
 * Tests for the SessionResumePopup component.
 *
 * @module components/SessionResumePopup.test
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SessionResumePopup } from './SessionResumePopup';
import { apiService } from '../services/api.service';
import { settingsService } from '../services/settings.service';

vi.mock('../services/api.service', () => ({
  apiService: {
    getPreviousSessions: vi.fn(),
    dismissPreviousSessions: vi.fn(),
    startTeam: vi.fn(),
  },
}));

vi.mock('../services/settings.service', () => ({
  settingsService: {
    getSettings: vi.fn(),
  },
}));

/**
 * Helper to mock settings with autoResumeOnRestart value.
 * When false, the dialog is shown for manual action.
 * When true, the component does nothing (the backend restore owns it).
 */
const mockSettingsWithAutoResume = (autoResume: boolean) => {
  vi.mocked(settingsService.getSettings).mockResolvedValue({
    general: { autoResumeOnRestart: autoResume },
  } as ReturnType<typeof settingsService.getSettings> extends Promise<infer T> ? T : never);
};

describe('SessionResumePopup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: auto-resume disabled so existing tests show the dialog
    mockSettingsWithAutoResume(false);
  });

  it('should not render when no previous sessions exist', async () => {
    vi.mocked(apiService.getPreviousSessions).mockResolvedValue({ sessions: [] });

    render(<SessionResumePopup />);

    // Wait for the API call to resolve
    await waitFor(() => {
      expect(apiService.getPreviousSessions).toHaveBeenCalled();
    });

    expect(screen.queryByText('Previous Sessions Detected')).not.toBeInTheDocument();
  });

  it('should render popup when previous sessions exist', async () => {
    vi.mocked(apiService.getPreviousSessions).mockResolvedValue({
      sessions: [
        { name: 'agent-1', role: 'dev', runtimeType: 'claude-code', hasResumeId: true },
      ],
    });

    render(<SessionResumePopup />);

    await waitFor(() => {
      expect(screen.getByText('Previous Sessions Detected')).toBeInTheDocument();
    });

    expect(screen.getByText('agent-1')).toBeInTheDocument();
    expect(screen.getByText('dev')).toBeInTheDocument();
  });

  it('should show session names, roles, and badges (excluding orchestrator)', async () => {
    vi.mocked(apiService.getPreviousSessions).mockResolvedValue({
      sessions: [
        { name: 'orc-session', role: 'orchestrator', runtimeType: 'claude-code', hasResumeId: true },
        { name: 'dev-session', role: 'dev', runtimeType: 'claude-code', hasResumeId: true },
        { name: 'qa-session', role: 'qa', runtimeType: 'gemini-cli', hasResumeId: false },
      ],
    });

    render(<SessionResumePopup />);

    await waitFor(() => {
      expect(screen.getByText('dev-session')).toBeInTheDocument();
    });

    // Orchestrator sessions are filtered out
    expect(screen.queryByText('orc-session')).not.toBeInTheDocument();
    expect(screen.getByText('qa-session')).toBeInTheDocument();
    expect(screen.getByText('qa')).toBeInTheDocument();
    expect(screen.getByText('Resumable')).toBeInTheDocument();
    expect(screen.getByText('Restart')).toBeInTheDocument();
  });

  it('should not show popup when only orchestrator sessions exist', async () => {
    vi.mocked(apiService.getPreviousSessions).mockResolvedValue({
      sessions: [
        { name: 'orc-session', role: 'orchestrator', runtimeType: 'claude-code', hasResumeId: true },
      ],
    });

    render(<SessionResumePopup />);

    await waitFor(() => {
      expect(apiService.getPreviousSessions).toHaveBeenCalled();
    });

    expect(screen.queryByText('Previous Sessions Detected')).not.toBeInTheDocument();
  });

  it('should call dismiss API and close when Dismiss is clicked', async () => {
    vi.mocked(apiService.getPreviousSessions).mockResolvedValue({
      sessions: [
        { name: 'agent-1', role: 'dev', runtimeType: 'claude-code', hasResumeId: true },
      ],
    });
    vi.mocked(apiService.dismissPreviousSessions).mockResolvedValue(undefined);

    const user = userEvent.setup();
    render(<SessionResumePopup />);

    await waitFor(() => {
      expect(screen.getByText('Previous Sessions Detected')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Dismiss'));

    await waitFor(() => {
      expect(apiService.dismissPreviousSessions).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.queryByText('Previous Sessions Detected')).not.toBeInTheDocument();
    });
  });

  it('should handle API errors gracefully', async () => {
    vi.mocked(apiService.getPreviousSessions).mockRejectedValue(new Error('Network error'));

    render(<SessionResumePopup />);

    await waitFor(() => {
      expect(apiService.getPreviousSessions).toHaveBeenCalled();
    });

    // Should not show popup on error
    expect(screen.queryByText('Previous Sessions Detected')).not.toBeInTheDocument();
  });

  // ============ Resume All Tests ============

  it('should show Resume All button when sessions have teamIds', async () => {
    vi.mocked(apiService.getPreviousSessions).mockResolvedValue({
      sessions: [
        { name: 'agent-1', role: 'dev', teamId: 'team-1', runtimeType: 'claude-code', hasResumeId: true },
      ],
    });

    render(<SessionResumePopup />);

    await waitFor(() => {
      expect(screen.getByText('Resume All')).toBeInTheDocument();
    });

    expect(screen.getByText('Resume All').closest('button')).not.toBeDisabled();
  });

  it('should disable Resume All button when no sessions have teamIds', async () => {
    vi.mocked(apiService.getPreviousSessions).mockResolvedValue({
      sessions: [
        { name: 'agent-1', role: 'dev', runtimeType: 'claude-code', hasResumeId: true },
        { name: 'agent-2', role: 'qa', runtimeType: 'claude-code', hasResumeId: true },
      ],
    });

    render(<SessionResumePopup />);

    await waitFor(() => {
      expect(screen.getByText('Resume All')).toBeInTheDocument();
    });

    expect(screen.getByText('Resume All').closest('button')).toBeDisabled();
  });

  it('should call startTeam for each unique teamId and close on success', async () => {
    vi.mocked(apiService.getPreviousSessions).mockResolvedValue({
      sessions: [
        { name: 'agent-1', role: 'dev', teamId: 'team-1', runtimeType: 'claude-code', hasResumeId: true },
        { name: 'agent-2', role: 'qa', teamId: 'team-1', runtimeType: 'claude-code', hasResumeId: true },
        { name: 'agent-3', role: 'dev', teamId: 'team-2', runtimeType: 'claude-code', hasResumeId: true },
      ],
    });
    vi.mocked(apiService.startTeam).mockResolvedValue(undefined);
    vi.mocked(apiService.dismissPreviousSessions).mockResolvedValue(undefined);

    const user = userEvent.setup();
    render(<SessionResumePopup />);

    await waitFor(() => {
      expect(screen.getByText('Resume All')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Resume All'));

    await waitFor(() => {
      expect(apiService.startTeam).toHaveBeenCalledTimes(2);
    });

    expect(apiService.startTeam).toHaveBeenCalledWith('team-1');
    expect(apiService.startTeam).toHaveBeenCalledWith('team-2');
    expect(apiService.dismissPreviousSessions).toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.queryByText('Previous Sessions Detected')).not.toBeInTheDocument();
    });
  });

  it('should show error message on partial failure and keep popup open', async () => {
    vi.mocked(apiService.getPreviousSessions).mockResolvedValue({
      sessions: [
        { name: 'agent-1', role: 'dev', teamId: 'team-1', runtimeType: 'claude-code', hasResumeId: true },
        { name: 'agent-2', role: 'qa', teamId: 'team-2', runtimeType: 'claude-code', hasResumeId: true },
      ],
    });
    vi.mocked(apiService.startTeam)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Start failed'));

    const user = userEvent.setup();
    render(<SessionResumePopup />);

    await waitFor(() => {
      expect(screen.getByText('Resume All')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Resume All'));

    await waitFor(() => {
      expect(screen.getByText(/Failed to start 1 team/)).toBeInTheDocument();
    });

    // Popup should still be open
    expect(screen.getByText('Previous Sessions Detected')).toBeInTheDocument();
    // Dismiss should not have been called on failure
    expect(apiService.dismissPreviousSessions).not.toHaveBeenCalled();
  });

  it('should exclude orchestrator sessions from Resume All', async () => {
    vi.mocked(apiService.getPreviousSessions).mockResolvedValue({
      sessions: [
        { name: 'orc-session', role: 'orchestrator', teamId: 'orc-team', runtimeType: 'claude-code', hasResumeId: true },
        { name: 'agent-1', role: 'dev', teamId: 'team-1', runtimeType: 'claude-code', hasResumeId: true },
      ],
    });
    vi.mocked(apiService.startTeam).mockResolvedValue(undefined);
    vi.mocked(apiService.dismissPreviousSessions).mockResolvedValue(undefined);

    const user = userEvent.setup();
    render(<SessionResumePopup />);

    await waitFor(() => {
      expect(screen.getByText('Resume All')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Resume All'));

    await waitFor(() => {
      expect(apiService.startTeam).toHaveBeenCalledTimes(1);
    });

    expect(apiService.startTeam).toHaveBeenCalledWith('team-1');
    // Should NOT have been called with orc-team
    expect(apiService.startTeam).not.toHaveBeenCalledWith('orc-team');
  });

  // ============ Auto-Resume Tests ============

  it('should neither start teams nor dismiss when autoResumeOnRestart is true (backend restore owns it)', async () => {
    mockSettingsWithAutoResume(true);
    vi.mocked(apiService.getPreviousSessions).mockResolvedValue({
      sessions: [
        { name: 'agent-1', role: 'dev', teamId: 'team-1', runtimeType: 'claude-code', hasResumeId: true },
        { name: 'agent-2', role: 'qa', teamId: 'team-2', runtimeType: 'claude-code', hasResumeId: true },
      ],
    });

    render(<SessionResumePopup />);

    await waitFor(() => {
      expect(settingsService.getSettings).toHaveBeenCalled();
      expect(apiService.getPreviousSessions).toHaveBeenCalled();
    });
    // Flush the effect's remaining microtasks before asserting absence.
    await new Promise((r) => setTimeout(r, 0));

    // A second launcher raced the backend restore (two kickoffs per agent),
    // and dismissing mid-restore dropped not-yet-restored conversation ids.
    expect(apiService.startTeam).not.toHaveBeenCalled();
    expect(apiService.dismissPreviousSessions).not.toHaveBeenCalled();
    expect(screen.queryByText('Previous Sessions Detected')).not.toBeInTheDocument();
  });

  it('should show dialog when autoResumeOnRestart is false', async () => {
    mockSettingsWithAutoResume(false);
    vi.mocked(apiService.getPreviousSessions).mockResolvedValue({
      sessions: [
        { name: 'agent-1', role: 'dev', teamId: 'team-1', runtimeType: 'claude-code', hasResumeId: true },
      ],
    });

    render(<SessionResumePopup />);

    await waitFor(() => {
      expect(screen.getByText('Previous Sessions Detected')).toBeInTheDocument();
    });

    // Should NOT auto-start teams
    expect(apiService.startTeam).not.toHaveBeenCalled();
  });

  it('should default to auto-resume (no start, no dialog) when settings fetch fails', async () => {
    vi.mocked(settingsService.getSettings).mockRejectedValue(new Error('Settings unavailable'));
    vi.mocked(apiService.getPreviousSessions).mockResolvedValue({
      sessions: [
        { name: 'agent-1', role: 'dev', teamId: 'team-1', runtimeType: 'claude-code', hasResumeId: true },
      ],
    });

    render(<SessionResumePopup />);

    await waitFor(() => {
      expect(apiService.getPreviousSessions).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 0));

    // Default is auto-resume, which the backend restore performs.
    expect(apiService.startTeam).not.toHaveBeenCalled();
    expect(apiService.dismissPreviousSessions).not.toHaveBeenCalled();
    expect(screen.queryByText('Previous Sessions Detected')).not.toBeInTheDocument();
  });
});
