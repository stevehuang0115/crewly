/**
 * ProjectSearchService Tests — project names and project tickets.
 *
 * @module services/project/project-search.service.test
 */

jest.mock('node-pty', () => ({ spawn: jest.fn() }));

import { ProjectSearchService, type ProjectTicketLister } from './project-search.service.js';

describe('ProjectSearchService', () => {
  let service: ProjectSearchService;
  let mockStorageService: { getProjects: jest.Mock };
  let tickets: { list: jest.Mock };

  const testProjects = [
    { id: 'proj-1', name: 'Auth Service', path: '/projects/auth-service', teams: {}, status: 'active' as const, createdAt: '', updatedAt: '' },
    { id: 'proj-2', name: 'Dashboard App', path: '/projects/dashboard-app', teams: {}, status: 'active' as const, createdAt: '', updatedAt: '' },
  ];

  function ticket(id: string, title: string) {
    return { id, title, status: 'ready', fileName: `${id}-x.md` };
  }

  beforeEach(() => {
    mockStorageService = { getProjects: jest.fn().mockResolvedValue(testProjects) };
    tickets = { list: jest.fn().mockResolvedValue({ tickets: [], invalid: [] }) };
    service = new ProjectSearchService(mockStorageService as never, tickets as unknown as ProjectTicketLister);
  });

  it('finds projects by name, case-insensitively', async () => {
    const results = await service.search('AUTH');
    expect(results).toEqual([{ id: 'proj-1', name: 'Auth Service', matchType: 'project_name' }]);
  });

  it('finds tickets by title and by id', async () => {
    tickets.list.mockImplementation(async (p: string) =>
      p.includes('auth-service') ? { tickets: [ticket('AS-3', 'Set up database'), ticket('AS-7', 'Login page')], invalid: [] } : { tickets: [], invalid: [] },
    );
    expect(await service.search('database')).toEqual([
      { id: 'proj-1', name: 'Auth Service', matchType: 'task_name', taskName: 'Set up database', taskPath: 'AS-3-x.md', ticketId: 'AS-3', status: 'ready' },
    ]);
    expect((await service.search('as-7'))[0]).toMatchObject({ ticketId: 'AS-7' });
  });

  it('sorts project matches before ticket matches', async () => {
    tickets.list.mockImplementation(async (p: string) =>
      p.includes('dashboard-app') ? { tickets: [ticket('DA-1', 'Auth integration')], invalid: [] } : { tickets: [], invalid: [] },
    );
    const results = await service.search('auth');
    expect(results.map((r) => r.matchType)).toEqual(['project_name', 'task_name']);
  });

  it('ignores projects whose tickets cannot be read', async () => {
    tickets.list.mockRejectedValue(new Error('EACCES'));
    expect(await service.search('nothing')).toEqual([]);
  });
});
