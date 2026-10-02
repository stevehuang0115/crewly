/**
 * Tests for the project tickets board.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectTicketsView, formatAcceptance, parseAcceptance, parseLabels } from './ProjectTicketsView';
import type { ProjectTicket } from '../../types/project-ticket.types';
import type { Project, Team } from '../../types';

const mockList = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockAssign = vi.fn();
vi.mock('../../services/project-tickets.service', () => ({
  listProjectTickets: (...a: unknown[]) => mockList(...a),
  createProjectTicket: (...a: unknown[]) => mockCreate(...a),
  updateProjectTicket: (...a: unknown[]) => mockUpdate(...a),
  assignProjectTicket: (...a: unknown[]) => mockAssign(...a),
}));

const project = { id: 'p1', name: 'App', path: '/work/app', status: 'active', teams: {}, createdAt: '', updatedAt: '' } as unknown as Project;
const teams = [
  { id: 't1', name: 'App', projectIds: ['p1'], createdAt: '', updatedAt: '', members: [{ id: 'm1', name: 'Ann', sessionName: 'dev-ann' }] },
] as unknown as Team[];

function ticket(over: Partial<ProjectTicket>): ProjectTicket {
  return {
    id: 'APP-1', title: 'Export CSV', status: 'ready', priority: 'P1', assignee: null, team: null, labels: ['export'],
    ownerReview: false, createdAt: '', updatedAt: '', workItemId: null, requestId: null, source: 'owner', migratedFrom: null,
    fileName: 'APP-1-export-csv.md', filePath: '/work/app/.crewly/tickets/APP-1-export-csv.md', projectPath: '/work/app',
    description: 'why', acceptance: [{ text: 'header row', done: true }], log: ['t · owner · created'], ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue({
    project: { id: 'p1', name: 'App', path: '/work/app' },
    tickets: [
      ticket({}),
      ticket({ id: 'APP-2', title: 'Fix login', status: 'in_progress', assignee: 'dev-ann', priority: 'P0' }),
      ticket({ id: 'APP-3', title: 'Old idea', status: 'cancelled' }),
    ],
    invalid: [{ fileName: 'broken.md', error: 'missing YAML frontmatter' }],
  });
  mockCreate.mockResolvedValue(ticket({ id: 'APP-4' }));
  mockUpdate.mockResolvedValue(ticket({}));
  mockAssign.mockResolvedValue({ ticket: ticket({ status: 'in_progress', assignee: 'dev-ann' }) });
});

function renderBoard(onCountChange = vi.fn()) {
  render(<ProjectTicketsView project={project} teams={teams} onCountChange={onCountChange} pollIntervalMs={0} />);
  return onCountChange;
}

describe('ProjectTicketsView', () => {
  it('shows a column per status with the tickets, hides cancelled, reports the count', async () => {
    const onCount = renderBoard();
    await screen.findByText('Export CSV');
    const ready = screen.getByRole('region', { name: 'Ready' });
    expect(within(ready).getByText('Export CSV')).toBeTruthy();
    const inProgress = screen.getByRole('region', { name: 'In progress' });
    expect(within(inProgress).getByText('@dev-ann')).toBeTruthy();
    expect(screen.queryByText('Old idea')).toBeNull();
    expect(onCount).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByText('Show cancelled'));
    expect(screen.getByText('Old idea')).toBeTruthy();
  });

  it('warns about files that could not be read', async () => {
    renderBoard();
    expect(await screen.findByText(/broken\.md \(missing YAML frontmatter\)/)).toBeTruthy();
  });

  it('creates a ticket from the form', async () => {
    renderBoard();
    await screen.findByText('Export CSV');
    fireEvent.click(screen.getByText('New ticket'));
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Add dark mode' } });
    fireEvent.change(screen.getByLabelText('Labels'), { target: { value: 'ui, theme' } });
    fireEvent.change(screen.getByLabelText('Acceptance criteria'), { target: { value: 'toggle in settings\n\nremembers choice' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'ready' } });
    fireEvent.click(screen.getByText('Create ticket'));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate).toHaveBeenCalledWith('p1', expect.objectContaining({
      title: 'Add dark mode', status: 'ready', labels: ['ui', 'theme'], acceptance: ['toggle in settings', 'remembers choice'], priority: 'P2',
    }));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it('edits a ticket, sending the status only when it changed, and keeps done flags', async () => {
    renderBoard();
    fireEvent.click(await screen.findByText('Export CSV'));
    expect((screen.getByLabelText('Acceptance criteria') as HTMLTextAreaElement).value).toBe('[x] header row');
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'P0' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    const [, id, body] = mockUpdate.mock.calls[0];
    expect(id).toBe('APP-1');
    expect(body).toMatchObject({ priority: 'P0', acceptance: [{ text: 'header row', done: true }] });
    expect(body).not.toHaveProperty('status');
  });

  it('offers only allowed moves and sends a status change', async () => {
    renderBoard();
    fireEvent.click(await screen.findByText('Export CSV'));
    const options = Array.from((screen.getByLabelText('Status') as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toEqual(['ready', 'backlog', 'cancelled']);
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'backlog' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(mockUpdate.mock.calls[0][2]).toMatchObject({ status: 'backlog' }));
  });

  it('assigns a team member', async () => {
    renderBoard();
    fireEvent.click(await screen.findByText('Export CSV'));
    fireEvent.change(screen.getByLabelText('Assignee'), { target: { value: 'dev-ann' } });
    // Assign is its own action: it must not also submit (save) the form.
    expect(screen.getByText('Assign').closest('button')).toHaveAttribute('type', 'button');
    fireEvent.click(screen.getByText('Assign'));
    await waitFor(() => expect(mockAssign).toHaveBeenCalledWith('p1', 'APP-1', 'dev-ann'));
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('shows the server error when a save is refused', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('Cannot move APP-1 from ready to done'));
    renderBoard();
    fireEvent.click(await screen.findByText('Export CSV'));
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText('Cannot move APP-1 from ready to done')).toBeTruthy();
  });

  it('shows a load failure', async () => {
    mockList.mockRejectedValueOnce(new Error('Project not found: p1'));
    renderBoard();
    expect(await screen.findByText('Project not found: p1')).toBeTruthy();
  });
});

describe('form helpers', () => {
  it('parses labels and acceptance lines', () => {
    expect(parseLabels(' a, ,b ')).toEqual(['a', 'b']);
    expect(parseAcceptance('[x] done one\nkept\n[ ] open', [{ text: 'kept', done: true }])).toEqual([
      { text: 'done one', done: true },
      { text: 'kept', done: true },
      { text: 'open', done: false },
    ]);
    expect(formatAcceptance([{ text: 'a', done: true }, { text: 'b', done: false }])).toBe('[x] a\nb');
  });
});
