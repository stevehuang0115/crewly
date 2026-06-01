/**
 * Tests for TeamChatRoute — the live host wiring for `/team-chat`.
 *
 * @module components/Chat-team/TeamChatRoute.test
 */

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Team } from '../../types';
import { ORCHESTRATOR_SESSION } from '../../utils/team-chat.utils';
import { HOME_ID, teamRailId } from './LiveTeamChatPage';

// Capture the props LiveTeamChatPage is rendered with. Keep the module's real
// exports (HOME_ID / teamRailId, which TeamChatRoute imports) and only stub the
// component so we don't mount the full chat surface.
const liveProps = vi.fn();
vi.mock('./LiveTeamChatPage', async (importActual) => {
  const actual = await importActual<typeof import('./LiveTeamChatPage')>();
  return {
    ...actual,
    LiveTeamChatPage: (props: Record<string, unknown>) => {
      liveProps(props);
      return <div data-testid="live-team-chat" />;
    },
  };
});

// Control the teams the wrapper derives labels/mentionables from.
const teamsRef: { teams: Team[] } = { teams: [] };
vi.mock('../../hooks/useTeams', () => ({
  useTeams: () => ({ teams: teamsRef.teams, loading: false, error: null, refresh: vi.fn() }),
}));

import { TeamChatRoute } from './TeamChatRoute';

function makeTeam(id: string, name: string, members: Team['members'] = []): Team {
  return {
    id,
    name,
    members,
    projectIds: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function makeMember(id: string, name: string, sessionName: string) {
  return {
    id,
    name,
    sessionName,
    role: 'developer',
    systemPrompt: '',
    agentStatus: 'inactive' as const,
    workingStatus: 'idle' as const,
    runtimeType: 'claude-code' as const,
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

/** Parse the body of the Nth fetch call as JSON. */
function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as RequestInit).body as string);
}

let fetchMock: ReturnType<typeof vi.fn>;

describe('TeamChatRoute', () => {
  beforeEach(() => {
    liveProps.mockClear();
    teamsRef.teams = [makeTeam('t1', 'Alpha'), makeTeam('t2', 'Beta')];
    vi.unstubAllEnvs();
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { id: 'orc-chan' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ensures the orchestrator DM and lands on Home by default (no ?team=)', async () => {
    renderAt('/team-chat');

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Orchestrator DM is ensured.
    const dmCall = fetchMock.mock.calls.find((c) => c[0] === '/api/chat/channels/dm/ensure');
    expect(dmCall).toBeTruthy();
    expect(bodyOf(dmCall!)).toMatchObject({ agentSession: ORCHESTRATOR_SESSION });
    // Every team's huddle is ensured up-front (so each rail icon has its
    // all-members channel), even without a ?team= deep-link.
    const teamEnsures = fetchMock.mock.calls
      .filter((c) => c[0] === '/api/chat/channels/team/ensure')
      .map((c) => bodyOf(c).teamId);
    expect(teamEnsures).toEqual(expect.arrayContaining(['t1', 't2']));

    await screen.findByTestId('live-team-chat');
    expect(liveProps).toHaveBeenCalledWith(
      expect.objectContaining({
        initialWorkspaceId: HOME_ID,
        initialConversationId: 'orc-chan',
      }),
    );
  });

  it('ensures both the orchestrator DM and the team channel for a ?team= deep-link', async () => {
    renderAt('/team-chat?team=t2');

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => c[0] === '/api/chat/channels/team/ensure')).toBe(true),
    );
    // The deep-linked team's huddle is ensured (among all teams' huddles).
    const teamEnsures = fetchMock.mock.calls
      .filter((c) => c[0] === '/api/chat/channels/team/ensure')
      .map((c) => bodyOf(c).teamId);
    expect(teamEnsures).toContain('t2');

    await screen.findByTestId('live-team-chat');
    // Deep-link focuses the team's rail icon; conversation auto-selects within it.
    expect(liveProps).toHaveBeenCalledWith(
      expect.objectContaining({ initialWorkspaceId: teamRailId('t2'), initialConversationId: null }),
    );
  });

  it('still renders the page when the ensure calls fail', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    renderAt('/team-chat');
    await screen.findByTestId('live-team-chat');
    expect(liveProps).toHaveBeenCalledWith(
      expect.objectContaining({ initialWorkspaceId: HOME_ID }),
    );
  });

  it('passes the full agent directory (every team member) to the page', async () => {
    teamsRef.teams = [
      makeTeam('t1', 'Alpha', [makeMember('m1', 'Ella', 'sess-ella')]),
      makeTeam('t2', 'Beta', [makeMember('m2', 'Grace', 'sess-grace')]),
    ];
    renderAt('/team-chat');
    await screen.findByTestId('live-team-chat');
    const props = liveProps.mock.calls[0][0] as {
      directoryAgents?: Array<{ agentSession: string }>;
    };
    expect((props.directoryAgents ?? []).map((a) => a.agentSession)).toEqual([
      'sess-ella',
      'sess-grace',
    ]);
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
