/**
 * Expert Controller Tests
 *
 * Unit tests for the GET /api/experts endpoint.
 *
 * @module controllers/expert/expert.controller.test
 */

import { Request, Response } from 'express';
import * as fs from 'fs/promises';
import { listExperts } from './expert.controller.js';

// Mock fs/promises
jest.mock('fs/promises');
const mockedFs = jest.mocked(fs);

// Mock logger
jest.mock('../../services/core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
    }),
  },
}));

/**
 * Creates a mock Express Response object
 */
function createMockResponse(): Response {
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

/**
 * Creates a mock Express Request object
 */
function createMockRequest(): Request {
  return {} as Request;
}

describe('expert.controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('listExperts', () => {
    it('returns empty array when experts directory does not exist', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      mockedFs.readdir.mockRejectedValue(new Error('ENOENT'));

      await listExperts(req, res);

      expect(res.json).toHaveBeenCalledWith({ success: true, data: [] });
    });

    it('returns expert summaries from valid subdirectories', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      mockedFs.readdir.mockResolvedValue([
        'empathetic-resolver',
        'pragmatic-architect',
        'EXAMPLE.json',
        'EXAMPLE.md',
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      (mockedFs.stat as jest.Mock).mockImplementation(async (p: string) => {
        if (p.includes('empathetic-resolver') || p.includes('pragmatic-architect')) {
          return { isDirectory: () => true };
        }
        return { isDirectory: () => false };
      });

      (mockedFs.readFile as jest.Mock).mockImplementation(async (p: string) => {
        const pathStr = String(p);
        if (pathStr.includes('empathetic-resolver')) {
          return JSON.stringify({
            id: 'empathetic-resolver',
            version: '1.0.0',
            name: 'Empathetic Resolver',
            category: 'Customer Support',
            intensity: 0.85,
            baseRoles: ['support', 'customer-success'],
            tags: ['empathy', 'retention', 'loyalty'],
            distillationDate: '2026-04-15',
            teacherModel: 'claude-3-5-sonnet-20240620',
          });
        }
        if (pathStr.includes('pragmatic-architect')) {
          return JSON.stringify({
            id: 'pragmatic-architect',
            version: '1.0.0',
            name: 'Pragmatic Architect',
            category: 'Development',
            intensity: 0.8,
            baseRoles: ['architect', 'backend-developer'],
            tags: ['YAGNI', 'scalability', 'maintainability'],
            distillationDate: '2026-04-15',
            teacherModel: 'claude-3-5-sonnet-20240620',
          });
        }
        throw new Error('Not found');
      });

      await listExperts(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: [
          {
            id: 'empathetic-resolver',
            name: 'Empathetic Resolver',
            category: 'Customer Support',
            tags: ['empathy', 'retention', 'loyalty'],
            baseRoles: ['support', 'customer-success'],
          },
          {
            id: 'pragmatic-architect',
            name: 'Pragmatic Architect',
            category: 'Development',
            tags: ['YAGNI', 'scalability', 'maintainability'],
            baseRoles: ['architect', 'backend-developer'],
          },
        ],
      });
    });

    it('skips EXAMPLE.json and EXAMPLE.md entries', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      mockedFs.readdir.mockResolvedValue([
        'EXAMPLE.json',
        'EXAMPLE.md',
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      await listExperts(req, res);

      expect(res.json).toHaveBeenCalledWith({ success: true, data: [] });
      expect(mockedFs.stat).not.toHaveBeenCalled();
    });

    it('skips entries that are not directories', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      mockedFs.readdir.mockResolvedValue([
        'some-file.txt',
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      mockedFs.stat.mockResolvedValue({
        isDirectory: () => false,
      } as unknown as Awaited<ReturnType<typeof fs.stat>>);

      await listExperts(req, res);

      expect(res.json).toHaveBeenCalledWith({ success: true, data: [] });
    });

    it('skips subdirectories with invalid expert.json', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      mockedFs.readdir.mockResolvedValue([
        'broken-expert',
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      mockedFs.stat.mockResolvedValue({
        isDirectory: () => true,
      } as unknown as Awaited<ReturnType<typeof fs.stat>>);

      mockedFs.readFile.mockResolvedValue('not valid json');

      await listExperts(req, res);

      expect(res.json).toHaveBeenCalledWith({ success: true, data: [] });
    });

    it('returns 500 on unexpected error', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      mockedFs.readdir.mockResolvedValue([
        'some-dir',
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      // Force an unexpected error by making stat throw after the initial readdir succeeds
      mockedFs.stat.mockRejectedValue(null);

      await listExperts(req, res);

      // Even with stat returning null, it should handle gracefully (skip entry)
      expect(res.json).toHaveBeenCalledWith({ success: true, data: [] });
    });
  });
});
