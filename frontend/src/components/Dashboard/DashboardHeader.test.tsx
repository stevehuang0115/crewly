import React from 'react';
import { render, screen } from '@testing-library/react';
import { DashboardHeader } from './DashboardHeader';

const mockProject = {
  id: '1',
  name: 'Test Project',
  path: '/test/path',
  status: 'active' as const,
  teams: {},
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01'
};

describe('DashboardHeader', () => {
  it('renders Crewly title', () => {
    render(<DashboardHeader connected={true} selectedProject={null} teamsCount={0} />);
    expect(screen.getByText('Crewly')).toBeInTheDocument();
  });

  it('shows connected status when connected', () => {
    render(<DashboardHeader connected={true} selectedProject={null} teamsCount={0} />);
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toHaveClass('text-emerald-400');
  });

  it('shows disconnected status when not connected', () => {
    render(<DashboardHeader connected={false} selectedProject={null} teamsCount={0} />);
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
    expect(screen.getByText('Disconnected')).toHaveClass('text-red-400');
  });

  it('displays project name when selected', () => {
    render(<DashboardHeader connected={true} selectedProject={mockProject} teamsCount={0} />);
    expect(screen.getByText('Project:')).toBeInTheDocument();
    expect(screen.getByText('Test Project')).toBeInTheDocument();
  });

  it('displays teams count', () => {
    render(<DashboardHeader connected={true} selectedProject={null} teamsCount={5} />);
    expect(screen.getByText('Teams:')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });
});