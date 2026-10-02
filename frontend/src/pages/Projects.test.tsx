import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Projects, PROJECTS_VISIBLE } from './Projects';

const api = vi.hoisted(() => ({
  getProjects: vi.fn(),
  getAllTasks: vi.fn(),
  getTeams: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
}));
vi.mock('@/services/api.service', () => ({ apiService: api }));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const pins = vi.hoisted(() => ({ pinned: new Set<string>(), togglePin: vi.fn() }));
vi.mock('@/hooks/usePinnedFavorites', () => ({
  usePinnedFavorites: () => ({ isPinned: (id: string) => pins.pinned.has(id), togglePin: pins.togglePin, pinnedItems: [] }),
}));

vi.mock('@/components/Modals/ProjectCreator', () => ({
  ProjectCreator: ({ onSave, onClose }: { onSave: (p: string) => void; onClose: () => void }) => (
    <div data-testid="project-creator">
      <button onClick={() => onSave('/test/project/path')}>Create Project</button>
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

const project = (id: string, name: string, status: string, path = `/Users/me/${id}`) => ({
  id,
  name,
  path,
  status,
  teams: {},
  createdAt: '2024-01-01',
  updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
});

const projects = [
  project('p1', 'Frontend App', 'active', '/path/to/frontend'),
  project('p2', 'Backend API', 'paused', '/path/to/backend'),
  project('p3', 'Mobile App', 'completed', '/path/to/mobile'),
];

const renderPage = (entry = '/projects') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Projects />
    </MemoryRouter>,
  );

describe('Projects page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pins.pinned = new Set();
    api.getProjects.mockResolvedValue(projects);
    api.getAllTasks.mockImplementation(async (id: string) =>
      id === 'p1' ? [{ status: 'done' }, { status: 'done' }, { status: 'open' }] : [],
    );
    api.getTeams.mockResolvedValue([
      { id: 't1', name: 'Web Crew', projectIds: ['p1'], members: [{ id: 'm1', name: 'Ella' }] },
    ]);
  });

  it('shows the loading state', () => {
    api.getProjects.mockImplementation(() => new Promise(() => {}));
    renderPage();
    expect(screen.getByText('Loading projects...')).toBeInTheDocument();
  });

  it('shows an error with Retry', async () => {
    api.getProjects.mockRejectedValueOnce(new Error('down'));
    renderPage();
    expect(await screen.findByText('Failed to load projects. Please try again.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Frontend App')).toBeInTheDocument();
  });

  it('renders the header with its two actions', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New Project/ })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('generate-tasks-cta'));
    expect(mockNavigate).toHaveBeenCalledWith('/team-chat');
  });

  it('lists open projects as compact rows: progress, team, status', async () => {
    renderPage();
    const row = await screen.findByTestId('project-row-p1');
    await waitFor(() => expect(within(row).getByText('2 of 3 tasks done')).toBeInTheDocument());
    expect(within(row).getByText('Web Crew')).toBeInTheDocument();
    expect(within(row).getByText('Running')).toBeInTheDocument();
    expect(within(screen.getByTestId('project-row-p2')).getByText('Idle')).toBeInTheDocument();
    // The path is a tooltip, not row text
    expect(screen.queryByText('/path/to/frontend')).not.toBeInTheDocument();
    expect(within(row).getByTitle('/path/to/frontend')).toBeInTheDocument();
  });

  it('keeps completed projects in a collapsed section', async () => {
    renderPage();
    const toggle = await screen.findByRole('button', { name: /Completed \(1\)/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(within(screen.getByTestId('archived-grid')).getByText('Mobile App')).toBeVisible();
  });

  it('filters by search (name or path)', async () => {
    renderPage();
    await screen.findByText('Frontend App');
    fireEvent.change(screen.getByLabelText('Search projects'), { target: { value: 'backend' } });
    expect(screen.queryByText('Frontend App')).not.toBeInTheDocument();
    expect(screen.getByText('Backend API')).toBeInTheDocument();
  });

  it('filters by status through the one Filter button', async () => {
    renderPage();
    await screen.findByText('Frontend App');
    fireEvent.click(screen.getByTestId('filter-button'));
    fireEvent.click(screen.getByRole('radio', { name: /Idle/ }));
    expect(screen.queryByTestId('project-row-p1')).not.toBeInTheDocument();
    expect(screen.getByTestId('project-row-p2')).toBeInTheDocument();
    expect(screen.getByText('Status: Idle')).toBeInTheDocument();
  });

  it('shows the empty state when nothing matches', async () => {
    renderPage();
    await screen.findByText('Frontend App');
    fireEvent.change(screen.getByLabelText('Search projects'), { target: { value: 'zzz' } });
    expect(screen.getByText('No projects found')).toBeInTheDocument();
    expect(screen.getByText('Try adjusting your search or filter criteria')).toBeInTheDocument();
  });

  it('offers Create Project when there are no projects', async () => {
    api.getProjects.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No projects yet')).toBeInTheDocument();
    expect(screen.queryByTestId('generate-tasks-cta')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Create Project/ }));
    expect(screen.getByTestId('project-creator')).toBeInTheDocument();
  });

  it('opens a project when its row is clicked', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('Frontend App'));
    expect(mockNavigate).toHaveBeenCalledWith('/projects/p1');
  });

  it('keeps pin and archive in the row menu', async () => {
    api.updateProject.mockResolvedValue({ ...projects[0], status: 'completed' });
    renderPage();
    await screen.findByText('Frontend App');
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Frontend App' }));
    fireEvent.click(screen.getByText('Pin to favorites'));
    expect(pins.togglePin).toHaveBeenCalledWith({ id: 'p1', name: 'Frontend App', type: 'project' });

    fireEvent.click(screen.getByRole('button', { name: 'More actions for Frontend App' }));
    fireEvent.click(screen.getByText('Archive'));
    await waitFor(() => expect(api.updateProject).toHaveBeenCalledWith('p1', { status: 'completed' }));
  });

  it('creates a project and opens it', async () => {
    api.createProject.mockResolvedValue(project('p9', 'New One', 'active'));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /New Project/ }));
    fireEvent.click(screen.getByText('Create Project'));
    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith('/test/project/path'));
    expect(mockNavigate).toHaveBeenCalledWith('/projects/p9');
  });

  it('opens the creator from ?create=true', async () => {
    renderPage('/projects?create=true');
    expect(await screen.findByTestId('project-creator')).toBeInTheDocument();
  });

  it(`shows ${PROJECTS_VISIBLE} rows, then "Show all"`, async () => {
    api.getProjects.mockResolvedValue(
      Array.from({ length: PROJECTS_VISIBLE + 2 }, (_, i) => project(`x${i}`, `Proj ${i}`, 'active')),
    );
    renderPage();
    await screen.findByText('Proj 0');
    expect(screen.queryByText(`Proj ${PROJECTS_VISIBLE}`)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `Show all ${PROJECTS_VISIBLE + 2}` }));
    expect(screen.getByText(`Proj ${PROJECTS_VISIBLE + 1}`)).toBeInTheDocument();
  });
});
