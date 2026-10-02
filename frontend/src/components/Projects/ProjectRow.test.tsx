import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, it, expect, vi } from 'vitest';
import { ProjectRow, progressText, projectStatus } from './ProjectRow';
import type { Project, Team } from '@/types';

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'CE',
  path: '/Users/me/ce',
  teams: {},
  status: 'active',
  createdAt: '2026-01-01',
  updatedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  ...over,
});

const progress = { percent: 96, total: 78, open: 2, inProgress: 0, pending: 1, done: 75, blocked: 0 };

describe('ProjectRow helpers', () => {
  it('maps statuses to colour + word', () => {
    expect(projectStatus('active')).toEqual({ label: 'Running', tone: 'success' });
    expect(projectStatus('paused').label).toBe('Idle');
    expect(projectStatus('completed').label).toBe('Completed');
    expect(projectStatus('weird').label).toBe('Running');
  });

  it('writes the progress part', () => {
    expect(progressText(undefined)).toBeNull();
    expect(progressText({ ...progress, total: 0 })).toBe('No tasks yet');
    expect(progressText(progress)).toBe('75 of 78 tasks done');
  });
});

describe('ProjectRow', () => {
  it('shows name, progress, team, updated time and status', () => {
    const teams = [{ id: 't', name: 'CE Crew', members: [{ id: 'm', name: 'Owen' }] }] as unknown as Team[];
    render(<ProjectRow project={project()} assignedTeams={teams} progress={progress} onOpen={vi.fn()} />);
    expect(screen.getByText('CE')).toBeInTheDocument();
    expect(screen.getByText('75 of 78 tasks done')).toHaveAttribute('title', expect.stringContaining('Done: 75'));
    expect(screen.getByText('CE Crew')).toHaveAttribute('title', 'Members: Owen');
    expect(screen.getByText('updated 3h ago')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByTitle('/Users/me/ce')).toBeInTheDocument();
  });

  it('says when no team is assigned', () => {
    render(<ProjectRow project={project()} onOpen={vi.fn()} />);
    expect(screen.getByText('No team yet')).toBeInTheDocument();
  });

  it('opens on click and keeps pin / archive in ⋯', () => {
    const onOpen = vi.fn();
    const onArchive = vi.fn();
    const onTogglePin = vi.fn();
    render(<ProjectRow project={project()} onOpen={onOpen} onArchive={onArchive} isPinned onTogglePin={onTogglePin} />);
    fireEvent.click(screen.getByText('CE'));
    expect(onOpen).toHaveBeenCalledWith('p1');
    expect(screen.getByLabelText('Pinned')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'More actions for CE' }));
    fireEvent.click(screen.getByText('Unpin from favorites'));
    expect(onTogglePin).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'More actions for CE' }));
    fireEvent.click(screen.getByText('Archive'));
    expect(onArchive).toHaveBeenCalledWith('p1');
  });

  it('does not offer Archive for a completed project', () => {
    render(<ProjectRow project={project({ status: 'completed' })} onOpen={vi.fn()} onArchive={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions for CE' }));
    expect(screen.queryByText('Archive')).not.toBeInTheDocument();
  });
});
