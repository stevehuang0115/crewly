import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ProjectDetail, shortenPath } from './ProjectDetail';

const api = vi.hoisted(() => ({
  getProject: vi.fn(),
  getTeams: vi.fn(),
  startProject: vi.fn(),
  unassignTeamFromProject: vi.fn(),
}));
vi.mock('../services/api.service', () => ({ apiService: api }));

const mockListProjectTickets = vi.fn();
vi.mock('../services/project-tickets.service', () => ({
  listProjectTickets: (...args: unknown[]) => mockListProjectTickets(...args),
}));

vi.mock('../services/in-progress-tasks.service', () => ({
  inProgressTasksService: { getInProgressTasks: vi.fn().mockResolvedValue([]) },
}));

const mockOpenTerminalWithSession = vi.fn();
vi.mock('../contexts/TerminalContext', () => ({
  useTerminal: () => ({ openTerminalWithSession: mockOpenTerminalWithSession }),
}));

// Heavy children: the tab bodies have their own tests.
vi.mock('../components/Tickets/TicketBoard', () => ({
  TicketBoard: ({ projectId }: { projectId: string }) => <div data-testid="project-tickets-board">board {projectId}</div>,
}));
vi.mock('../components/ProjectDetail/EditorView', () => ({
  EditorView: () => <div data-testid="editor-view">editor</div>,
}));
vi.mock('../components/Modals/TeamAssignmentModal', () => ({
  TeamAssignmentModal: () => <div data-testid="team-assignment-modal" />,
}));

const project = {
  id: 'project-1',
  name: 'Test Project',
  path: '/Users/steve/code/test-project',
  status: 'paused' as const,
  teams: {},
  createdAt: '2024-01-01',
  updatedAt: '2024-01-02',
};

const teams = [
  {
    id: 'team-1',
    name: 'Development Team',
    projectIds: ['project-1'],
    members: [{ id: 'm1', name: 'John', role: 'developer', agentStatus: 'active', sessionName: 'john' }],
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  },
  { id: 'team-2', name: 'Other', projectIds: ['other'], members: [], createdAt: '', updatedAt: '' },
];

const Where: React.FC = () => {
  const l = useLocation();
  return <div data-testid="where">{`${l.pathname}${l.search}${l.hash}`}</div>;
};

const renderAt = (entry = '/projects/project-1') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/projects/:id" element={<><ProjectDetail /><Where /></>} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );

// Multi-step UI tests: allow more than the 5s default on a busy machine.
vi.setConfig({ testTimeout: 20000 });

describe('ProjectDetail page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getProject.mockResolvedValue(project);
    api.getTeams.mockResolvedValue(teams);
    api.startProject.mockResolvedValue({ message: 'started' });
    mockListProjectTickets.mockResolvedValue({
      project: { id: 'project-1' },
      tickets: [{ status: 'ready' }, { status: 'done' }, { status: 'cancelled' }],
      invalid: [],
    });
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) }) as unknown as typeof fetch;
  });

  it('shows the loading state', () => {
    api.getProject.mockImplementation(() => new Promise(() => {}));
    renderAt();
    expect(screen.getByText('Loading project...')).toBeInTheDocument();
  });

  it('shows the error state', async () => {
    api.getProject.mockRejectedValue(new Error('boom'));
    renderAt();
    expect(await screen.findByText('Error Loading Project')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('renders the header: breadcrumb, name, status, counts and folder', async () => {
    renderAt();
    expect(await screen.findByRole('heading', { level: 1, name: 'Test Project' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('href', '/projects');
    expect(screen.getByText('Idle')).toBeInTheDocument();
    expect(screen.getByText('2 tasks · 1 team')).toBeInTheDocument();
    expect(screen.getByTestId('project-path')).toHaveTextContent('~/code/test-project');
    expect(screen.getByTestId('project-path')).toHaveAttribute('title', expect.stringContaining('/Users/steve/code/test-project'));
  });

  it('puts Detail / Editor / Tasks / Teams in the header as tabs with counts', async () => {
    renderAt();
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Detail', 'Editor', 'Tasks2', 'Teams1']);
    expect(screen.getByRole('tab', { name: /Detail/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('project-detail-view')).toBeInTheDocument();
  });

  it('keeps the tab in ?tab= and switches panels', async () => {
    renderAt();
    fireEvent.click(await screen.findByRole('tab', { name: /Teams/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/projects/project-1?tab=teams');
    expect(screen.getByTestId('project-teams-view')).toBeInTheDocument();
    expect(screen.getByText('Development Team')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Editor/ }));
    expect(screen.getByTestId('editor-view')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Detail/ }));
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/projects\/project-1$/);
  });

  it('opens a tab from ?tab=', async () => {
    renderAt('/projects/project-1?tab=tasks');
    expect(await screen.findByTestId('project-tasks-tab')).toBeInTheDocument();
    expect(screen.getByTestId('project-tickets-board')).toHaveTextContent('board project-1');
  });

  it('maps an old #hash link (the former sidebar sub-nav) to ?tab=', async () => {
    renderAt('/projects/project-1#teams');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/projects\/project-1\?tab=teams$/));
    expect(await screen.findByTestId('project-teams-view')).toBeInTheDocument();
  });

  it('starts the project with its assigned teams', async () => {
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: /Start Project/ }));
    await waitFor(() => expect(api.startProject).toHaveBeenCalledWith('project-1', ['team-1']));
  });

  it('disables Start without an assigned team', async () => {
    api.getTeams.mockResolvedValue([teams[1]]);
    renderAt();
    expect(await screen.findByRole('button', { name: /Start Project/ })).toBeDisabled();
  });

  it('shows Stop for an active project', async () => {
    api.getProject.mockResolvedValue({ ...project, status: 'active' });
    renderAt();
    expect(await screen.findByRole('button', { name: /Stop Project/ })).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('keeps Open in Finder, Assign Team and Delete Project in the ⋯ menu', async () => {
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'More project actions' }));
    expect(screen.getByText('Open in Finder')).toBeInTheDocument();
    expect(screen.getByText('Delete Project')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Assign Team'));
    expect(screen.getByTestId('team-assignment-modal')).toBeInTheDocument();
  });

  it('opens the folder in Finder from the path', async () => {
    renderAt();
    fireEvent.click(await screen.findByTestId('project-path'));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/projects/project-1/open-finder', { method: 'POST' }),
    );
  });

  it('asks before deleting', async () => {
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'More project actions' }));
    fireEvent.click(screen.getByText('Delete Project'));
    expect(await screen.findByText(/Remove the project from Crewly registry/)).toBeInTheDocument();
  });

  it('shortens home-relative paths', () => {
    expect(shortenPath('/Users/a/x/y')).toBe('~/x/y');
    expect(shortenPath('/home/a/x')).toBe('~/x');
    expect(shortenPath('/opt/x')).toBe('/opt/x');
  });
});
