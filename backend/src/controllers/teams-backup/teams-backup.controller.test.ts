/**
 * Teams Backup Controller Tests
 *
 * @module controllers/teams-backup/teams-backup.controller.test
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';
import type { Team } from '../../types/index.js';
import type {
  TeamsBackup,
  TeamsBackupHistoryEntry,
} from '../../services/core/teams-backup.service.js';

// Mock data holders
const mockTeams: { value: Team[] } = { value: [] };
const mockBackup: { value: TeamsBackup | null } = { value: null };
const mockHistory: { value: TeamsBackupHistoryEntry[] } = { value: [] };
const mockSlots: { value: Record<number, TeamsBackup> } = { value: {} };

jest.mock('../../services/core/storage.service', () => ({
  StorageService: {
    getInstance: () => ({
      getTeams: async () => mockTeams.value,
      saveTeam: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../../services/core/teams-backup.service', () => ({
  TeamsBackupService: {
    getInstance: () => ({
      getBackupStatus: async (currentTeams: Team[]) => ({
        hasMismatch: currentTeams.length === 0 && (mockBackup.value?.teams?.length || 0) > 0,
        backupTeamCount: mockBackup.value?.teams?.length || 0,
        currentTeamCount: currentTeams.length,
        backupTimestamp: mockBackup.value?.timestamp || null,
      }),
      readBackup: async () => mockBackup.value,
      getBackupHistory: async () => mockHistory.value,
      restoreFromSlot: async (slot: number) => mockSlots.value[slot] ?? null,
    }),
  },
}));

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

import {
  getBackupStatus,
  restoreFromBackup,
  getBackupHistory,
  restoreFromSlot,
} from './teams-backup.controller.js';

/**
 * Helper to create a mock Team.
 *
 * @param id - Team ID
 * @param name - Team name
 * @returns Minimal Team object
 */
function createMockTeam(id: string, name: string): Team {
  return {
    id,
    name,
    projectIds: [],
    members: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Helper to create mock Express request/response/next.
 */
function createMockReqRes() {
  const req = {} as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, next };
}

describe('TeamsBackupController', () => {
  beforeEach(() => {
    mockTeams.value = [];
    mockBackup.value = null;
    mockHistory.value = [];
    mockSlots.value = {};
    jest.clearAllMocks();
  });

  describe('getBackupStatus', () => {
    it('should return no mismatch when no backup exists', async () => {
      const { req, res, next } = createMockReqRes();
      await getBackupStatus(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          hasMismatch: false,
          backupTeamCount: 0,
          currentTeamCount: 0,
        }),
      });
    });

    it('should report mismatch when current is empty but backup has data', async () => {
      mockBackup.value = {
        timestamp: '2026-02-08T00:00:00.000Z',
        teams: [createMockTeam('t1', 'Alpha'), createMockTeam('t2', 'Beta')],
      };

      const { req, res, next } = createMockReqRes();
      await getBackupStatus(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          hasMismatch: true,
          backupTeamCount: 2,
          currentTeamCount: 0,
        }),
      });
    });

    it('should report no mismatch when current has data', async () => {
      mockTeams.value = [createMockTeam('t1', 'Alpha')];
      mockBackup.value = {
        timestamp: '2026-02-08T00:00:00.000Z',
        teams: [createMockTeam('t1', 'Alpha')],
      };

      const { req, res, next } = createMockReqRes();
      await getBackupStatus(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          hasMismatch: false,
          backupTeamCount: 1,
          currentTeamCount: 1,
        }),
      });
    });
  });

  describe('restoreFromBackup', () => {
    it('should return 404 when no backup exists', async () => {
      const { req, res, next } = createMockReqRes();
      await restoreFromBackup(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false })
      );
    });

    it('should return 404 when backup is empty', async () => {
      mockBackup.value = {
        timestamp: '2026-02-08T00:00:00.000Z',
        teams: [],
      };

      const { req, res, next } = createMockReqRes();
      await restoreFromBackup(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should restore teams from backup successfully', async () => {
      mockBackup.value = {
        timestamp: '2026-02-08T00:00:00.000Z',
        teams: [createMockTeam('t1', 'Alpha'), createMockTeam('t2', 'Beta')],
      };

      const { req, res, next } = createMockReqRes();
      await restoreFromBackup(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          restoredCount: 2,
          totalInBackup: 2,
        }),
      });
    });
  });

  describe('getBackupHistory (A2)', () => {
    it('should return empty array when no rotating snapshots exist', async () => {
      const { req, res, next } = createMockReqRes();
      await getBackupHistory(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: [],
      });
    });

    it('should return populated history entries when slots exist', async () => {
      mockHistory.value = [
        { slot: 2, timestamp: '2026-05-03T03:00:00.000Z', teamCount: 4, isHead: true },
        { slot: 1, timestamp: '2026-05-03T02:00:00.000Z', teamCount: 3, isHead: false },
        { slot: 0, timestamp: '2026-05-03T01:00:00.000Z', teamCount: 3, isHead: false },
      ];

      const { req, res, next } = createMockReqRes();
      await getBackupHistory(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: mockHistory.value,
      });
    });
  });

  describe('restoreFromSlot (A2)', () => {
    /**
     * Helper to build a mock Express request with a slot URL parameter.
     */
    function reqWithSlot(slot: string): Request {
      return { params: { slot } } as unknown as Request;
    }

    it('should return 400 when slot param is non-numeric', async () => {
      const req = reqWithSlot('abc');
      const res = {
        json: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;
      const next = jest.fn() as unknown as NextFunction;

      await restoreFromSlot(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: 'Invalid slot' })
      );
    });

    it('should return 400 when slot is negative', async () => {
      const req = reqWithSlot('-1');
      const res = {
        json: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;
      const next = jest.fn() as unknown as NextFunction;

      await restoreFromSlot(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 404 when slot is not populated', async () => {
      // mockSlots.value is empty, so any slot lookup returns null
      const req = reqWithSlot('5');
      const res = {
        json: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;
      const next = jest.fn() as unknown as NextFunction;

      await restoreFromSlot(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false })
      );
    });

    it('should return 404 when slot snapshot has zero teams', async () => {
      mockSlots.value = {
        3: { timestamp: '2026-05-03T01:00:00.000Z', teams: [] },
      };

      const req = reqWithSlot('3');
      const res = {
        json: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;
      const next = jest.fn() as unknown as NextFunction;

      await restoreFromSlot(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should restore teams from a valid slot and return restoredCount + snapshotTimestamp', async () => {
      mockSlots.value = {
        7: {
          timestamp: '2026-05-03T01:00:00.000Z',
          teams: [
            createMockTeam('t1', 'Alpha'),
            createMockTeam('t2', 'Beta'),
            createMockTeam('t3', 'Gamma'),
          ],
        },
      };

      const req = reqWithSlot('7');
      const res = {
        json: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;
      const next = jest.fn() as unknown as NextFunction;

      await restoreFromSlot(req, res, next);

      expect(res.status).not.toHaveBeenCalledWith(400);
      expect(res.status).not.toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          slot: 7,
          snapshotTimestamp: '2026-05-03T01:00:00.000Z',
          restoredCount: 3,
          totalInSnapshot: 3,
        }),
      });
    });
  });
});
