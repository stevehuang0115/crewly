/**
 * Tests for TeamChatRoute — the live host wiring for `/team-chat`.
 *
 * @module components/Chat-team/TeamChatRoute.test
 */

import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

describe('TeamChatRoute', () => {
  beforeEach(() => {
    liveProps.mockClear();
    teamsRef.teams = [makeTeam('t1', 'Alpha'), makeTeam('t2', 'Beta')];
    vi.unstubAllEnvs();
  });

  it('passes the ?team= param through as initialWorkspaceId', () => {
    renderAt('/team-chat?team=t2');
    expect(liveProps).toHaveBeenCalledWith(
      expect.objectContaining({ initialWorkspaceId: 't2' }),
    );
  });

  it('defaults initialWorkspaceId to null when no ?team= is present', () => {
    renderAt('/team-chat');
    expect(liveProps).toHaveBeenCalledWith(
      expect.objectContaining({ initialWorkspaceId: null }),
    );
  });

  it('derives teamLabels from the teams directory', () => {
    renderAt('/team-chat');
    expect(liveProps).toHaveBeenCalledWith(
      expect.objectContaining({ teamLabels: { t1: 'Alpha', t2: 'Beta' } }),
    );
  });

  it('passes a backendURL in real mode', () => {
    vi.stubEnv('VITE_CHAT_MODE', 'real');
    renderAt('/team-chat');
    const props = liveProps.mock.calls[0][0] as { backendURL?: string };
    expect(props.backendURL).toBe(window.location.origin);
  });

  it('omits backendURL in mock mode', () => {
    vi.stubEnv('VITE_CHAT_MODE', 'mock');
    renderAt('/team-chat');
    const props = liveProps.mock.calls[0][0] as { backendURL?: string };
    expect(props.backendURL).toBeUndefined();
  });
});
