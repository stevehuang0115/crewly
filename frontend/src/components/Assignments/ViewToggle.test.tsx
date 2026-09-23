import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import { ViewToggle } from './ViewToggle';
import { Project, Team } from '../../types';

const mockProjects: Project[] = [
  {
    id: '1',
    name: 'Project A',
    description: 'Test project',
    path: '/path/a',
    teams: {},
    status: 'active',
    createdAt: '2023-01-01',
    updatedAt: '2023-01-01'
  }
];

const mockTeams: Team[] = [
  {
    id: '1',
    name: 'Team Alpha',
    description: 'Test team',
    members: [],
    projectIds: ['1'],
    createdAt: '2023-01-01',
    updatedAt: '2023-01-01'
  }
];

describe('ViewToggle', () => {
  const mockOnViewModeChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render both projects and teams toggle buttons', () => {
    render(
      <ViewToggle
        viewMode="projects"
        assignedProjects={mockProjects}
        assignedTeams={mockTeams}
        onViewModeChange={mockOnViewModeChange}
      />
    );

    expect(screen.getByText('Projects (1)')).toBeInTheDocument();
    expect(screen.getByText('Teams (1)')).toBeInTheDocument();
  });

  it('should highlight active view mode', () => {
    render(
      <ViewToggle
        viewMode="projects"
        assignedProjects={mockProjects}
        assignedTeams={mockTeams}
        onViewModeChange={mockOnViewModeChange}
      />
    );

    const projectsButton = screen.getByText('Projects (1)').closest('button');
    const teamsButton = screen.getByText('Teams (1)').closest('button');

    // SegmentedControl marks the selected option with aria-checked.
    expect(projectsButton).toHaveAttribute('aria-checked', 'true');
    expect(teamsButton).toHaveAttribute('aria-checked', 'false');
  });

  it('should call onViewModeChange when projects button is clicked', () => {
    render(
      <ViewToggle
        viewMode="teams"
        assignedProjects={mockProjects}
        assignedTeams={mockTeams}
        onViewModeChange={mockOnViewModeChange}
      />
    );

    const projectsButton = screen.getByText('Projects (1)');
    fireEvent.click(projectsButton);

    expect(mockOnViewModeChange).toHaveBeenCalledWith('projects');
  });

  it('should call onViewModeChange when teams button is clicked', () => {
    render(
      <ViewToggle
        viewMode="projects"
        assignedProjects={mockProjects}
        assignedTeams={mockTeams}
        onViewModeChange={mockOnViewModeChange}
      />
    );

    const teamsButton = screen.getByText('Teams (1)');
    fireEvent.click(teamsButton);

    expect(mockOnViewModeChange).toHaveBeenCalledWith('teams');
  });
});