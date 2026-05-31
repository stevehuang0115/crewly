/**
 * Tests for TeamChatRoute — the live host wiring for `/team-chat`.
 *
 * @module components/Chat-team/TeamChatRoute.test
 */

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Team } from '../../types';

// Capture the props LiveTeamChatPage is rendered with.
const liveProps = vi.fn();
vi.mock('./LiveTeamChatPage', () => ({
  LiveTeamChatPage: (props: Record<string, unknown>) => {
    liveProps(props);
    return <div data-testid="live-team-chat" />;
  },
}));

// Control the teams the wrapper derives labels/mentionables from.
const teamsRef: { teams: Team[] } = { teams: [] };
vi.mock('../../hooks/useTeams', () => ({
  useTeams: () => ({ teams: teamsRef.teams, loading: false, error: null, refresh: vi.fn() }),
}));

import { TeamChatRoute } from './TeamChatRoute';

function makeTeam(id: string, name: string): Team {
  return {
    id,
    name,
    members: [],
    projectIds: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <TeamChatRoute />
    </MemoryRouter>,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

describe('TeamChatRoute', () => {
  beforeEach(() => {
    liveProps.mockClear();
    teamsRef.teams = [makeTeam('t1', 'Alpha'), makeTeam('t2', 'Beta')];
    vi.unstubAllEnvs();
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { id: 'chan-1' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ensures the team channel then passes ?team= through as initialWorkspaceId', async () => {
    renderAt('/team-chat?team=t2');

    // POSTs team/ensure with the deep-linked team id.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/chat/channels/team/ensure');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ teamId: 't2' });

    // After the ensure settles, the page mounts with the workspace selected.
    await screen.findByTestId('live-team-chat');
    expect(liveProps).toHaveBeenCalledWith(
      expect.objectContaining({ initialWorkspaceId: 't2' }),
    );
  });

  it('renders immediately and does not ensure when no ?team= is present', async () => {
    renderAt('/team-chat');
    await screen.findByTestId('live-team-chat');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(liveProps).toHaveBeenCalledWith(
      expect.objectContaining({ initialWorkspaceId: null }),
    );
  });

  it('still renders the page when the ensure call fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'));
    renderAt('/team-chat?team=t2');
    await screen.findByTestId('live-team-chat');
    expect(liveProps).toHaveBeenCalledWith(
      expect.objectContaining({ initialWorkspaceId: 't2' }),
    );
  });

  it('derives teamLabels from the teams directory', async () => {
    renderAt('/team-chat');
    await screen.findByTestId('live-team-chat');
    expect(liveProps).toHaveBeenCalledWith(
      expect.objectContaining({ teamLabels: { t1: 'Alpha', t2: 'Beta' } }),
    );
  });

  it('passes a backendURL in real mode', async () => {
    vi.stubEnv('VITE_CHAT_MODE', 'real');
    renderAt('/team-chat');
    await screen.findByTestId('live-team-chat');
    const props = liveProps.mock.calls[0][0] as { backendURL?: string };
    expect(props.backendURL).toBe(window.location.origin);
  });

  it('omits backendURL and skips ensure in mock mode', async () => {
    vi.stubEnv('VITE_CHAT_MODE', 'mock');
    renderAt('/team-chat?team=t2');
    await screen.findByTestId('live-team-chat');
    expect(fetchMock).not.toHaveBeenCalled();
    const props = liveProps.mock.calls[0][0] as { backendURL?: string };
    expect(props.backendURL).toBeUndefined();
  });
});
