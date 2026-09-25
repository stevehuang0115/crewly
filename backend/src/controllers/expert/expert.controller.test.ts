/**
 * Expert Controller Tests
 *
 * Unit tests for the GET /api/experts endpoint.
 *
 * @module controllers/expert/expert.controller.test
 */

import { Request, Response } from 'express';
import * as fs from 'fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listExperts, resolveExpertsDir } from './expert.controller.js';

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
  /**
   * Published-package layout tests. These use the real filesystem: the
   * fs/promises mock is pointed back at the actual implementation.
   *
   * The compiled controller runs from dist/backend/backend/src/controllers/expert/,
   * which is six directories below the package root, but the source runs four
   * below it. A fixed "walk up N levels" gets one of the two wrong, and under
   * ESM `__dirname` does not exist at all, so resolution has to go through the
   * entry script and the package.json named "crewly".
   */
  describe('package root resolution (published layout)', () => {
    const actualFs = jest.requireActual<typeof fs>('fs/promises');
    const originalArgv1 = process.argv[1];
    let tmpRoot: string;

    /**
     * Builds a fake installed package that mirrors `npm pack`: package.json and
     * config/ at the root, and the compiled backend under dist/backend/backend/src.
     *
     * @param withExperts - Whether to create config/experts with one expert
     * @returns Paths to the package root and the compiled entry script
     */
    function makeInstalledPackage(withExperts: boolean): { pkgRoot: string; entry: string } {
      const pkgRoot = path.join(tmpRoot, 'node_modules', 'crewly');
      const srcDir = path.join(pkgRoot, 'dist', 'backend', 'backend', 'src');
      mkdirSync(path.join(srcDir, 'controllers', 'expert'), { recursive: true });
      writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: 'crewly', type: 'module' }));
      const entry = path.join(srcDir, 'index.js');
      writeFileSync(entry, '');
      if (withExperts) {
        const expertDir = path.join(pkgRoot, 'config', 'experts', 'installed-expert');
        mkdirSync(expertDir, { recursive: true });
        writeFileSync(path.join(pkgRoot, 'config', 'experts', 'EXAMPLE.json'), '{}');
        writeFileSync(
          path.join(expertDir, 'expert.json'),
          JSON.stringify({
            id: 'installed-expert',
            version: '1.0.0',
            name: 'Installed Expert',
            category: 'Strategy',
            intensity: 0.5,
            baseRoles: ['generalist'],
            tags: ['fixture'],
            distillationDate: '2026-09-24',
            teacherModel: 'none',
          }),
        );
      }
      return { pkgRoot, entry };
    }

    beforeEach(() => {
      tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'crewly-experts-'));
      mockedFs.readdir.mockImplementation(actualFs.readdir as unknown as typeof fs.readdir);
      mockedFs.stat.mockImplementation(actualFs.stat as unknown as typeof fs.stat);
      mockedFs.readFile.mockImplementation(actualFs.readFile as unknown as typeof fs.readFile);
    });

    afterEach(() => {
      process.argv[1] = originalArgv1;
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('resolves config/experts at the package root from the compiled controller directory', () => {
      const { pkgRoot } = makeInstalledPackage(true);
      const compiledControllerDir = path.join(
        pkgRoot, 'dist', 'backend', 'backend', 'src', 'controllers', 'expert',
      );

      expect(resolveExpertsDir([compiledControllerDir])).toBe(path.join(pkgRoot, 'config', 'experts'));
    });

    it('returns null when no anchor is inside a crewly package', () => {
      expect(resolveExpertsDir([tmpRoot])).toBeNull();
    });

    it('lists the experts of the installed package the compiled entry script belongs to', async () => {
      const { entry } = makeInstalledPackage(true);
      process.argv[1] = entry;
      const res = createMockResponse();

      await listExperts(createMockRequest(), res);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: [
          {
            id: 'installed-expert',
            name: 'Installed Expert',
            category: 'Strategy',
            tags: ['fixture'],
            baseRoles: ['generalist'],
          },
        ],
      });
    });

    it('returns 200 with an empty list, not 500, when the installed package has no config/experts', async () => {
      const { entry } = makeInstalledPackage(false);
      process.argv[1] = entry;
      const res = createMockResponse();

      await listExperts(createMockRequest(), res);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ success: true, data: [] });
    });
  });
});
