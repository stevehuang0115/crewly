/**
 * ProjectCard Component Tests
 *
 * Tests for the project card including rendering, status badge,
 * progress bar, and kebab menu with Archive option.
 *
 * @module components/Cards/ProjectCard.test
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ProjectCard } from './ProjectCard';
import type { Project } from '@/types';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  FolderOpen: () => <svg data-testid="folder-icon" />,
  MoreVertical: () => <svg data-testid="more-icon" />,
}));

// Mock OverflowMenu to capture items
let capturedMenuItems: any[] = [];
vi.mock('@/components/UI/OverflowMenu', () => ({
  OverflowMenu: ({ items }: any) => {
    capturedMenuItems = items;
    return (
      <div data-testid="overflow-menu">
        {items.map((item: any, i: number) => (
          <button key={i} data-testid={`menu-item-${item.label}`} onClick={item.onClick}>
            {item.label}
          </button>
        ))}
      </div>
    );
  },
}));

/** Create a minimal project for testing */
function createProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test Project',
    path: '/home/user/projects/test',
    status: 'active',
    teams: {},
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-06-15T10:00:00Z',
    ...overrides,
  };
}

describe('ProjectCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedMenuItems = [];
  });

  describe('Rendering', () => {
    it('should render project name', () => {
      render(<ProjectCard project={createProject()} />);
      expect(screen.getByText('Test Project')).toBeInTheDocument();
    });

    it('should render project path', () => {
      render(<ProjectCard project={createProject()} />);
      expect(screen.getByTitle('/home/user/projects/test')).toBeInTheDocument();
    });

    it('should render status badge when showStatus is true', () => {
      render(<ProjectCard project={createProject()} showStatus />);
      expect(screen.getByText('Running')).toBeInTheDocument();
    });

    it('should render Completed badge for completed projects', () => {
      render(<ProjectCard project={createProject({ status: 'completed' })} showStatus />);
      expect(screen.getByText('Completed')).toBeInTheDocument();
    });

    it('should render Idle badge for paused projects (not Stopped)', () => {
      render(<ProjectCard project={createProject({ status: 'paused' })} showStatus />);
      expect(screen.getByText('Idle')).toBeInTheDocument();
      expect(screen.queryByText('Stopped')).not.toBeInTheDocument();
    });

    it('should render Idle badge for stopped projects (not Stopped)', () => {
      render(<ProjectCard project={createProject({ status: 'stopped' as any })} showStatus />);
      expect(screen.getByText('Idle')).toBeInTheDocument();
    });

    it('should render updated date', () => {
      render(<ProjectCard project={createProject()} />);
      expect(screen.getByText(/Updated/)).toBeInTheDocument();
    });
  });

  describe('Progress', () => {
    it('should render progress bar when percent is provided', () => {
      render(<ProjectCard project={createProject()} progressPercent={75} />);
      expect(screen.getByText('75%')).toBeInTheDocument();
      expect(screen.getByText('Progress')).toBeInTheDocument();
    });

    it('should not render progress bar when percent is undefined', () => {
      render(<ProjectCard project={createProject()} />);
      expect(screen.queryByText('Progress')).not.toBeInTheDocument();
    });
  });

  describe('Click Handler', () => {
    it('should call onClick when card is clicked', () => {
      const onClick = vi.fn();
      render(<ProjectCard project={createProject()} onClick={onClick} />);
      fireEvent.click(screen.getByText('Test Project'));
      expect(onClick).toHaveBeenCalled();
    });
  });

  describe('Archive Menu', () => {
    it('should show kebab menu with Archive when onArchive is provided', () => {
      const onArchive = vi.fn();
      render(<ProjectCard project={createProject()} onArchive={onArchive} />);
      expect(screen.getByTestId('overflow-menu')).toBeInTheDocument();
      expect(screen.getByTestId('menu-item-Archive')).toBeInTheDocument();
    });

    it('should call onArchive when Archive menu item is clicked', () => {
      const onArchive = vi.fn();
      render(<ProjectCard project={createProject()} onArchive={onArchive} />);
      fireEvent.click(screen.getByTestId('menu-item-Archive'));
      expect(onArchive).toHaveBeenCalled();
    });

    it('should not show Archive for completed projects', () => {
      const onArchive = vi.fn();
      render(<ProjectCard project={createProject({ status: 'completed' })} onArchive={onArchive} />);
      expect(screen.queryByTestId('menu-item-Archive')).not.toBeInTheDocument();
    });

    it('should not show kebab menu when no onArchive provided', () => {
      render(<ProjectCard project={createProject()} />);
      expect(screen.queryByTestId('overflow-menu')).not.toBeInTheDocument();
    });
  });

  describe('Team Avatars', () => {
    it('should render member avatars from assigned teams', () => {
      const teams = [{
        id: 't1', name: 'Team 1', projectIds: ['proj-1'],
        members: [
          { id: 'm1', name: 'Alice', avatar: undefined },
          { id: 'm2', name: 'Bob', avatar: undefined },
        ],
        createdAt: '2024-01-01', updatedAt: '2024-01-01',
      }];
      render(
        <ProjectCard
          project={createProject()}
          showTeams
          assignedTeams={teams as any}
        />
      );
      // Avatars should show initials
      expect(screen.getByText('A')).toBeInTheDocument();
      expect(screen.getByText('B')).toBeInTheDocument();
    });
  });
});
