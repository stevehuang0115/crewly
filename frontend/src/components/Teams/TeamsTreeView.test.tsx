/**
 * TeamsTreeView Component Tests
 *
 * @module components/Teams/TeamsTreeView.test
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { TeamsTreeView } from './TeamsTreeView';
import type { Team } from '@/types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
  ChevronDown: () => <svg data-testid="chevron-down" />,
  ChevronRight: () => <svg data-testid="chevron-right" />,
  Users: () => <svg data-testid="users-icon" />,
  FolderOpen: () => <svg data-testid="folder-icon" />,
}));

// Mock MemberAvatar
vi.mock('@/components/common/MemberAvatar', () => ({
  MemberAvatar: ({ name }: any) => <div data-testid={`avatar-${name}`}>{name}</div>,
}));

/** Create a test team */
function makeTeam(overrides: Partial<Team> & { id: string; name: string }): Team {
  return {
    projectIds: [],
    members: [],
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    ...overrides,
  } as Team;
}

const parentTeam = makeTeam({ id: 'parent', name: 'Parent Org', members: [] });
const child1 = makeTeam({ id: 'child-1', name: 'Child Core', parentTeamId: 'parent', members: [
  { id: 'm1', name: 'Alice', sessionName: 'a', role: 'dev', agentStatus: 'active', workingStatus: 'idle', runtimeType: 'claude-code', systemPrompt: '', createdAt: '', updatedAt: '' } as any,
] });
const child2 = makeTeam({ id: 'child-2', name: 'Child Marketing', parentTeamId: 'parent' });
const standalone = makeTeam({ id: 'standalone', name: 'Standalone Team', projectIds: ['p1'] });

describe('TeamsTreeView', () => {
  const onTeamClick = vi.fn();
  const projectMap = { p1: 'My Project' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render root teams at top level', () => {
    render(
      <TeamsTreeView
        teams={[parentTeam, child1, child2, standalone]}
        projectMap={projectMap}
        onTeamClick={onTeamClick}
      />
    );
    expect(screen.getByTestId('tree-node-parent')).toBeInTheDocument();
    expect(screen.getByTestId('tree-node-standalone')).toBeInTheDocument();
  });

  it('should render children under parent', () => {
    render(
      <TeamsTreeView
        teams={[parentTeam, child1, child2, standalone]}
        projectMap={projectMap}
        onTeamClick={onTeamClick}
      />
    );
    expect(screen.getByTestId('children-parent')).toBeInTheDocument();
    expect(screen.getByTestId('tree-node-child-1')).toBeInTheDocument();
    expect(screen.getByTestId('tree-node-child-2')).toBeInTheDocument();
  });

  it('should collapse children when toggle is clicked', () => {
    render(
      <TeamsTreeView
        teams={[parentTeam, child1, child2]}
        projectMap={projectMap}
        onTeamClick={onTeamClick}
      />
    );
    expect(screen.getByTestId('children-parent')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('toggle-parent'));
    expect(screen.queryByTestId('children-parent')).not.toBeInTheDocument();
  });

  it('should expand children when toggle is clicked again', () => {
    render(
      <TeamsTreeView
        teams={[parentTeam, child1, child2]}
        projectMap={projectMap}
        onTeamClick={onTeamClick}
      />
    );
    // Collapse
    fireEvent.click(screen.getByTestId('toggle-parent'));
    expect(screen.queryByTestId('children-parent')).not.toBeInTheDocument();

    // Expand
    fireEvent.click(screen.getByTestId('toggle-parent'));
    expect(screen.getByTestId('children-parent')).toBeInTheDocument();
  });

  it('should call onTeamClick when a node is clicked', () => {
    render(
      <TeamsTreeView
        teams={[standalone]}
        projectMap={projectMap}
        onTeamClick={onTeamClick}
      />
    );
    fireEvent.click(screen.getByText('Standalone Team'));
    expect(onTeamClick).toHaveBeenCalledWith('standalone');
  });

  it('should show Active badge for teams with active members', () => {
    render(
      <TeamsTreeView
        teams={[parentTeam, child1]}
        projectMap={projectMap}
        onTeamClick={onTeamClick}
      />
    );
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('should show project name for teams with projects', () => {
    render(
      <TeamsTreeView
        teams={[standalone]}
        projectMap={projectMap}
        onTeamClick={onTeamClick}
      />
    );
    expect(screen.getByText('My Project')).toBeInTheDocument();
  });

  it('should show empty state when no teams', () => {
    render(
      <TeamsTreeView
        teams={[]}
        projectMap={projectMap}
        onTeamClick={onTeamClick}
      />
    );
    expect(screen.getByText('No teams to display')).toBeInTheDocument();
  });

  it('should render member avatars', () => {
    render(
      <TeamsTreeView
        teams={[parentTeam, child1]}
        projectMap={projectMap}
        onTeamClick={onTeamClick}
      />
    );
    expect(screen.getByTestId('avatar-Alice')).toBeInTheDocument();
  });
});
