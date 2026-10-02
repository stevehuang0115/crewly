/**
 * Tests for the project tickets API client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  assignProjectTicket,
  createProjectTicket,
  getProjectTicket,
  listAllProjectTickets,
  listProjectTickets,
  transitionProjectTicket,
  updateProjectTicket,
} from './project-tickets.service';
import { ProjectTicketApiError } from '../types/project-ticket.types';

const fetchMock = vi.fn();

function respond(body: unknown, status = 200): void {
  fetchMock.mockResolvedValueOnce({ ok: status >= 200 && status < 300, status, json: async () => body });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('project tickets service', () => {
  it('lists a project and defaults missing arrays', async () => {
    respond({ success: true, data: { project: { id: 'p1', name: 'App', path: '/a' }, tickets: [{ id: 'APP-1' }] } });
    const r = await listProjectTickets('p1');
    expect(fetchMock).toHaveBeenCalledWith('/api/project-tickets/p1', undefined);
    expect(r.tickets).toHaveLength(1);
    expect(r.invalid).toEqual([]);
  });

  it('encodes ids and posts JSON bodies to the right sub-resources', async () => {
    respond({ success: true, data: { id: 'APP-1' } });
    await getProjectTicket('p 1', 'APP-1');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/project-tickets/p%201/APP-1');

    respond({ success: true, data: { id: 'APP-2' } });
    await createProjectTicket('p1', { title: 'X', acceptance: ['a'] });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/project-tickets/p1');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ title: 'X', acceptance: ['a'] });

    respond({ success: true, data: {} });
    await updateProjectTicket('p1', 'APP-1', { priority: 'P0' });
    expect(fetchMock.mock.calls[2][0]).toBe('/api/project-tickets/p1/APP-1/update');

    respond({ success: true, data: {} });
    await transitionProjectTicket('p1', 'APP-1', 'ready', 'groomed');
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ status: 'ready', note: 'groomed' });

    respond({ success: true, data: { ticket: {} } });
    await assignProjectTicket('p1', 'APP-1', 'dev-ann');
    expect(fetchMock.mock.calls[4][0]).toBe('/api/project-tickets/p1/APP-1/assign');
    expect(JSON.parse(fetchMock.mock.calls[4][1].body)).toEqual({ assignee: 'dev-ann' });
  });

  it('throws the server error with its status', async () => {
    respond({ success: false, error: 'Cannot move APP-1 from backlog to done' }, 400);
    await expect(transitionProjectTicket('p1', 'APP-1', 'done')).rejects.toMatchObject({ status: 400, message: 'Cannot move APP-1 from backlog to done' });
  });

  it('refuses a blank title without calling the server', async () => {
    await expect(createProjectTicket('p1', { title: '  ' })).rejects.toBeInstanceOf(ProjectTicketApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('survives a non-JSON error body', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => { throw new Error('html'); } });
    await expect(listProjectTickets('p1')).rejects.toMatchObject({ status: 502, message: 'HTTP 502' });
  });

  it('lists every project and defaults missing ticket arrays', async () => {
    respond({ success: true, data: [{ project: { id: 'p1', name: 'App', path: '/a' } }, { project: { id: 'p2', name: 'Web', path: '/w' }, tickets: [{ id: 'WEB-1' }] }] });
    const r = await listAllProjectTickets();
    expect(fetchMock).toHaveBeenCalledWith('/api/project-tickets', undefined);
    expect(r.map((g) => g.tickets.length)).toEqual([0, 1]);
  });
});
