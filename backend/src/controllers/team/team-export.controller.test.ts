/**
 * Team Export/Import Controller Tests
 *
 * Tests for the export and import HTTP endpoints.
 *
 * @module controllers/team/team-export.controller.test
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { exportTeam, importTeam, exportFileName } from './team-export.controller.js';

// Mock the TeamExportService
const mockExportTeam = jest.fn<any>();
const mockImportTeam = jest.fn<any>();

jest.mock('../../services/core/team-export.service.js', () => ({
  TeamExportService: jest.fn().mockImplementation(() => ({
    exportTeam: mockExportTeam,
    importTeam: mockImportTeam,
  })),
}));

const mockRejectNonOwner = jest.fn<any>(() => false);
jest.mock('../../middleware/caller-identity.middleware.js', () => ({
  rejectNonOwner: (...args: unknown[]) => mockRejectNonOwner(...args),
}));

// Mock session modules to avoid node-pty binary loading
jest.mock('../../services/session/index.js', () => ({
  getSessionBackend: jest.fn(),
}));
jest.mock('../../services/session/session-state-persistence.js', () => ({
  getSessionStatePersistence: jest.fn(),
}));

describe('Team Export/Import Controller', () => {
  let mockReq: any;
  let mockRes: any;
  let jsonFn: jest.Mock;
  let statusFn: jest.Mock;
  const mockContext = {
    storageService: {},
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    jsonFn = jest.fn();
    statusFn = jest.fn().mockReturnValue({ json: jsonFn });
    mockRes = { json: jsonFn, status: statusFn, setHeader: jest.fn(), send: jest.fn() };
    mockRejectNonOwner.mockReturnValue(false);
  });

  it('names the download after the team', () => {
    expect(exportFileName('CE Site / Marketing')).toBe('crewly-team-ce-site-marketing.json');
    expect(exportFileName('***')).toBe('crewly-team-team.json');
  });

  it('refuses callers that are not the owner', async () => {
    mockRejectNonOwner.mockReturnValue(true);
    mockReq = { params: { teamId: 'team-1' }, query: {}, body: { version: '1.1', team: {} } };
    await exportTeam.call(mockContext, mockReq as Request, mockRes as Response);
    await importTeam.call(mockContext, mockReq as Request, mockRes as Response);
    expect(mockExportTeam).not.toHaveBeenCalled();
    expect(mockImportTeam).not.toHaveBeenCalled();
    expect(mockRejectNonOwner.mock.calls[0][2]).toMatchObject({ error: 'owner_only' });
  });

  describe('GET /api/teams/:teamId/export', () => {
    it('should return team export data on success', async () => {
      const exportData = {
        version: '1.0',
        exportedAt: '2026-03-28T00:00:00Z',
        team: { id: 'team-1', name: 'Test' },
        prompts: {},
        norms: {},
        cronTasks: [],
      };
      mockExportTeam.mockResolvedValue(exportData);
      mockReq = { params: { teamId: 'team-1' }, query: {} };

      await exportTeam.call(mockContext, mockReq as Request, mockRes as Response);

      expect(jsonFn).toHaveBeenCalledWith({ success: true, data: exportData });
      expect(mockExportTeam.mock.calls[0][1]).toEqual({ knownSecrets: expect.any(Array), includeWiki: false });
    });

    it('packages the wiki only with ?wiki=1', async () => {
      mockExportTeam.mockResolvedValue({ version: '1.2', exportedAt: 'x', team: { id: 'team-1', name: 'T' }, prompts: {}, norms: {}, cronTasks: [] });
      mockReq = { params: { teamId: 'team-1' }, query: { wiki: '1' } };
      await exportTeam.call(mockContext, mockReq as Request, mockRes as Response);
      expect(mockExportTeam.mock.calls[0][1]).toEqual({ knownSecrets: expect.any(Array), includeWiki: true });
    });

    it('sends the package as an attachment with ?download=1', async () => {
      const exportData = { version: '1.1', exportedAt: 'x', team: { id: 'team-1', name: 'CE Site' }, prompts: {}, norms: {}, cronTasks: [] };
      mockExportTeam.mockResolvedValue(exportData);
      mockReq = { params: { teamId: 'team-1' }, query: { download: '1' } };

      await exportTeam.call(mockContext, mockReq as Request, mockRes as Response);

      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="crewly-team-ce-site.json"');
      expect(JSON.parse(mockRes.send.mock.calls[0][0])).toEqual(exportData);
      expect(jsonFn).not.toHaveBeenCalled();
    });

    it('should return 404 if team not found', async () => {
      mockExportTeam.mockRejectedValue(new Error('Team not found: team-xyz'));
      mockReq = { params: { teamId: 'team-xyz' }, query: {} };

      await exportTeam.call(mockContext, mockReq as Request, mockRes as Response);

      expect(statusFn).toHaveBeenCalledWith(404);
      expect(jsonFn).toHaveBeenCalledWith({
        success: false,
        message: 'Team not found: team-xyz',
      });
    });
  });

  describe('POST /api/teams/import', () => {
    it('should import team and return result', async () => {
      const importResult = {
        team: { id: 'team-1', name: 'Test' },
        promptsImported: 2,
        normsImported: 1,
        cronTasksImported: 3,
      };
      mockImportTeam.mockResolvedValue(importResult);
      mockReq = {
        body: {
          version: '1.0',
          team: { id: 'team-1' },
          prompts: {},
          norms: {},
          cronTasks: [],
        },
      };

      await importTeam.call(mockContext, mockReq as Request, mockRes as Response);

      expect(jsonFn).toHaveBeenCalledWith({ success: true, data: importResult });
    });

    it('should return 400 for invalid format (missing version)', async () => {
      mockReq = { body: { team: { id: 'team-1' } } };

      await importTeam.call(mockContext, mockReq as Request, mockRes as Response);

      expect(statusFn).toHaveBeenCalledWith(400);
    });

    it('should return 400 for invalid format (missing team)', async () => {
      mockReq = { body: { version: '1.0' } };

      await importTeam.call(mockContext, mockReq as Request, mockRes as Response);

      expect(statusFn).toHaveBeenCalledWith(400);
    });

    it('unwraps a saved API answer and returns 400 for an unsupported version', async () => {
      mockImportTeam.mockResolvedValue({ team: { id: 't' }, promptsImported: 0, normsImported: 0, cronTasksImported: 0 });
      mockReq = { body: { success: true, data: { version: '1.1', team: { id: 't' } } } };
      await importTeam.call(mockContext, mockReq as Request, mockRes as Response);
      expect(mockImportTeam).toHaveBeenCalledWith({ version: '1.1', team: { id: 't' } });

      mockImportTeam.mockRejectedValue(new Error('Unsupported team export version: 9.0 (this Crewly reads 1.0, 1.1)'));
      mockReq = { body: { version: '9.0', team: { id: 't' } } };
      await importTeam.call(mockContext, mockReq as Request, mockRes as Response);
      expect(statusFn).toHaveBeenLastCalledWith(400);
    });

    it('should return 500 on import failure', async () => {
      mockImportTeam.mockRejectedValue(new Error('Disk full'));
      mockReq = {
        body: {
          version: '1.0',
          team: { id: 'team-1' },
        },
      };

      await importTeam.call(mockContext, mockReq as Request, mockRes as Response);

      expect(statusFn).toHaveBeenCalledWith(500);
    });
  });
});
