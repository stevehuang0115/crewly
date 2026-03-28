/**
 * Team Export/Import Controller Tests
 *
 * Tests for the export and import HTTP endpoints.
 *
 * @module controllers/team/team-export.controller.test
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { exportTeam, importTeam } from './team-export.controller.js';

// Mock the TeamExportService
const mockExportTeam = jest.fn<any>();
const mockImportTeam = jest.fn<any>();

jest.mock('../../services/core/team-export.service.js', () => ({
  TeamExportService: jest.fn().mockImplementation(() => ({
    exportTeam: mockExportTeam,
    importTeam: mockImportTeam,
  })),
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
    mockRes = { json: jsonFn, status: statusFn };
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
      mockReq = { params: { teamId: 'team-1' } };

      await exportTeam.call(mockContext, mockReq as Request, mockRes as Response);

      expect(jsonFn).toHaveBeenCalledWith({ success: true, data: exportData });
    });

    it('should return 404 if team not found', async () => {
      mockExportTeam.mockRejectedValue(new Error('Team not found: team-xyz'));
      mockReq = { params: { teamId: 'team-xyz' } };

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
