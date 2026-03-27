/**
 * ProjectSearchService Tests
 *
 * @module services/project/project-search.service.test
 */

jest.mock('node-pty', () => ({ spawn: jest.fn() }));
jest.mock('fs/promises');

import * as fs from 'fs/promises';
import { ProjectSearchService } from './project-search.service.js';

const mockedFs = jest.mocked(fs);

describe('ProjectSearchService', () => {
  let service: ProjectSearchService;
  let mockStorageService: { getProjects: jest.Mock };

  const testProjects = [
    {
      id: 'proj-1',
      name: 'Auth Service',
      path: '/projects/auth-service',
      teams: {},
      status: 'active' as const,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'proj-2',
      name: 'Dashboard App',
      path: '/projects/dashboard-app',
      teams: {},
      status: 'active' as const,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockStorageService = {
      getProjects: jest.fn().mockResolvedValue(testProjects),
    };
    service = new ProjectSearchService(mockStorageService as any);

    // Default: no task files found (directory does not exist)
    mockedFs.readdir.mockRejectedValue(new Error('ENOENT'));
  });

  describe('search', () => {
    it('should find projects by name', async () => {
      const results = await service.search('auth');

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        id: 'proj-1',
        name: 'Auth Service',
        matchType: 'project_name',
      });
    });

    it('should find tasks by filename', async () => {
      mockedFs.readdir.mockImplementation(((dirPath: string) => {
        if (dirPath.includes('auth-service')) {
          return Promise.resolve(['m1_sprint1/open/setup_database_20260101.md']);
        }
        return Promise.reject(new Error('ENOENT'));
      }) as typeof fs.readdir);

      const results = await service.search('database');

      const taskResults = results.filter(r => r.matchType === 'task_name');
      expect(taskResults).toHaveLength(1);
      expect(taskResults[0]).toMatchObject({
        id: 'proj-1',
        name: 'Auth Service',
        matchType: 'task_name',
        taskName: 'setup database',
        taskPath: 'm1_sprint1/open/setup_database_20260101.md',
        milestone: 'm1_sprint1',
      });
    });

    it('should perform case-insensitive search', async () => {
      const results = await service.search('AUTH');

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        id: 'proj-1',
        name: 'Auth Service',
        matchType: 'project_name',
      });
    });

    it('should return empty when no matches', async () => {
      const results = await service.search('nonexistent-xyz');

      expect(results).toHaveLength(0);
    });

    it('should handle missing .crewly/tasks/ directory gracefully', async () => {
      const results = await service.search('auth');

      expect(results).toHaveLength(1);
      expect(results[0].matchType).toBe('project_name');
    });

    it('should sort results with project_name matches first', async () => {
      mockedFs.readdir.mockImplementation(((dirPath: string) => {
        if (dirPath.includes('dashboard-app')) {
          return Promise.resolve(['m0_defining_project/open/auth_integration_20260101.md']);
        }
        return Promise.reject(new Error('ENOENT'));
      }) as typeof fs.readdir);

      const results = await service.search('auth');

      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results[0].matchType).toBe('project_name');
      expect(results[0].name).toBe('Auth Service');
      expect(results[results.length - 1].matchType).toBe('task_name');
    });

    it('should only match .md files in task directory', async () => {
      mockedFs.readdir.mockImplementation(((dirPath: string) => {
        if (dirPath.includes('auth-service')) {
          return Promise.resolve([
            'm1_sprint1/open/setup_auth_20260101.md',
            'm1_sprint1/open/setup_auth_20260101.txt',
            'm1_sprint1/open/notes.json',
          ]);
        }
        return Promise.reject(new Error('ENOENT'));
      }) as typeof fs.readdir);

      const results = await service.search('setup');

      const taskResults = results.filter(r => r.matchType === 'task_name');
      expect(taskResults).toHaveLength(1);
      expect(taskResults[0].taskPath).toContain('.md');
    });

    it('should return results from multiple projects', async () => {
      mockStorageService.getProjects.mockResolvedValue([
        { ...testProjects[0], name: 'App One' },
        { ...testProjects[1], name: 'App Two' },
      ]);

      const results = await service.search('app');

      expect(results).toHaveLength(2);
      expect(results.every(r => r.matchType === 'project_name')).toBe(true);
    });
  });
});
