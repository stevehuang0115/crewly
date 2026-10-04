import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TeamRow, teamPlacement, teamLastActivity } from './TeamRow';
import type { Team } from '@/types';

vi.mock('@/components/SignInNeededChip', () => ({
  SignInNeededChip: ({ agentLabel }: { agentLabel: string }) => <span data-testid="sign-in-chip">{agentLabel}</span>,
}));

const team = (over: Partial<Team> = {}): Team =>
  ({
    id: 't1',
    name: 'CE',
    projectIds: ['p1'],
    createdAt: '',
    updatedAt: '',
    members: [
      { id: 'm1', name: 'Owen', role: 'developer', agentStatus: 'active', updatedAt: new Date(Date.now() - 3600_000).toISOString() },
      { id: 'm2', name: 'Vera', role: 'developer', agentStatus: 'inactive' },
    ],
    ...over,
  }) as unknown as Team;

describe('TeamRow helpers', () => {
  it('places a team', () => {
    expect(teamPlacement(team(), 'CE project')).toEqual({ label: 'CE project', needsProject: false });
    expect(teamPlacement(team({ projectIds: [], members: [{ role: 'orchestrator' }] as Team['members'] })).label).toBe('System team');
    expect(teamPlacement(team({ projectIds: [] }), undefined, 2).label).toBe('Parent team');
    expect(teamPlacement(team({ projectIds: [] }))).toEqual({ label: 'No project yet', needsProject: true });
  });

  it('finds the latest member activity', () => {
    expect(teamLastActivity(team())).not.toBeNull();
    expect(teamLastActivity(team({ members: [] }))).toBeNull();
  });
});

describe('TeamRow', () => {
  const handlers = {
    onOpen: vi.fn(),
    onEdit: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onOpenChat: vi.fn(),
    onOpenWiki: vi.fn(),
    onDelete: vi.fn(),
    onTogglePin: vi.fn(),
  };
  beforeEach(() => vi.clearAllMocks());
  const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'More actions for CE' }));

  it('shows name, project, members, last activity and status', () => {
    render(<TeamRow team={team()} projectName="CE project" {...handlers} />);
    expect(screen.getByText('CE')).toBeInTheDocument();
    expect(screen.getByText('CE project')).toBeInTheDocument();
    expect(screen.getByText('Owen, Vera')).toBeInTheDocument();
    expect(screen.getByText('1h ago')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows the sub-team count for parent teams', () => {
    render(<TeamRow team={team({ projectIds: [] })} subTeamCount={4} {...handlers} />);
    expect(screen.getByText('4 sub-teams · 2 members')).toBeInTheDocument();
    expect(screen.getByText('Parent team')).toBeInTheDocument();
  });

  it('flags a team without a project', () => {
    render(<TeamRow team={team({ projectIds: [] })} {...handlers} />);
    expect(screen.getByTestId('assign-project-cta')).toHaveTextContent('No project yet');
  });

  it('stops an active team after confirming', () => {
    render(<TeamRow team={team()} {...handlers} />);
    fireEvent.click(screen.getByTestId('stop-btn-t1'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop Team' }));
    expect(handlers.onStop).toHaveBeenCalledWith('t1');
  });

  it('starts an idle team', () => {
    const idle = team({ members: [{ id: 'm', name: 'Nova', agentStatus: 'inactive' }] as Team['members'] });
    render(<TeamRow team={idle} {...handlers} />);
    expect(screen.getByText('Idle')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('start-btn-t1'));
    expect(handlers.onStart).toHaveBeenCalledWith('t1');
  });

  it('opens the team on click', () => {
    render(<TeamRow team={team()} {...handlers} />);
    fireEvent.click(screen.getByText('CE'));
    expect(handlers.onOpen).toHaveBeenCalledWith('t1');
  });

  it('keeps view, edit, chat, wiki, pin and delete in ⋯', () => {
    render(<TeamRow team={team()} {...handlers} />);
    for (const [label, fn] of [
      ['View team', handlers.onOpen],
      ['Edit team', handlers.onEdit],
      ['Open chat', handlers.onOpenChat],
      ['Open wiki', handlers.onOpenWiki],
    ] as const) {
      openMenu();
      fireEvent.click(screen.getByText(label));
      expect(fn).toHaveBeenCalledWith('t1');
    }
    openMenu();
    fireEvent.click(screen.getByText('Pin to favorites'));
    expect(handlers.onTogglePin).toHaveBeenCalled();
    openMenu();
    fireEvent.click(screen.getByText('Delete team'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(handlers.onDelete).toHaveBeenCalledWith('t1');
  });

  it('shows sign-in chips for members waiting on a login', () => {
    const t = team({ members: [{ id: 'm', name: 'Kai', agentStatus: 'active', loginRequired: { url: 'x' } }] as unknown as Team['members'] });
    render(<TeamRow team={t} {...handlers} />);
    expect(screen.getByTestId('sign-in-chip')).toHaveTextContent('Kai');
  });
});

describe('TeamRow — team pause (specs/2026-10-04-team-pause.md)', () => {
  const base = { onOpen: vi.fn(), onStart: vi.fn(), onStop: vi.fn(), onPause: vi.fn(), onResume: vi.fn() };
  const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'More actions for CE' }));
  beforeEach(() => vi.clearAllMocks());

  it('offers "Pause team…" for a running team', () => {
    render(<TeamRow team={team()} {...base} />);
    expect(screen.queryByTestId('team-paused-t1')).not.toBeInTheDocument();
    openMenu();
    fireEvent.click(screen.getByText('Pause team…'));
    expect(base.onPause).toHaveBeenCalledWith('t1');
  });

  it('shows a Paused badge and Resume instead of Start/Stop while paused', () => {
    const t = team({ pausedNow: true, paused: { pausedAt: '2026-10-04T00:00:00Z', by: 'owner', reason: 'harness work moved' } });
    render(<TeamRow team={t} {...base} />);
    expect(screen.getByTestId('team-paused-t1')).toHaveTextContent('Paused');
    expect(screen.getByTestId('team-paused-t1')).toHaveAttribute('title', expect.stringContaining('harness work moved'));
    expect(screen.queryByTestId('stop-btn-t1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('resume-btn-t1'));
    expect(base.onResume).toHaveBeenCalledWith('t1');
    openMenu();
    expect(screen.queryByText('Pause team…')).not.toBeInTheDocument();
    expect(screen.getByText('Resume team')).toBeInTheDocument();
  });
});
