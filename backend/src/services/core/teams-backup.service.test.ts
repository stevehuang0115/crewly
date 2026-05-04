/**
 * Teams Backup Service Tests
 *
 * @module services/core/teams-backup.service.test
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { existsSync, mkdirSync, rmSync } from 'fs';
import {
  TeamsBackupService,
  type TeamsBackup,
  type TeamsBackupHistoryIndex,
  MAX_HISTORY_SLOTS,
} from './teams-backup.service.js';
import type { Team } from '../../types/index.js';

jest.mock('./logger.service.js', () => ({
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

describe('TeamsBackupService', () => {
  let testDir: string;
  let service: TeamsBackupService;

  /**
   * Helper to create a mock Team object.
   *
   * @param id - Team ID
   * @param name - Team name
   * @returns A minimal Team object for testing
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

  beforeEach(() => {
    TeamsBackupService.clearInstance();
    testDir = path.join(os.tmpdir(), `teams-backup-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    service = new TeamsBackupService(testDir);
  });

  afterEach(() => {
    TeamsBackupService.clearInstance();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const a = TeamsBackupService.getInstance(testDir);
      const b = TeamsBackupService.getInstance(testDir);
      expect(a).toBe(b);
    });

    it('should reset after clearInstance', () => {
      const a = TeamsBackupService.getInstance(testDir);
      TeamsBackupService.clearInstance();
      const b = TeamsBackupService.getInstance(testDir);
      expect(a).not.toBe(b);
    });
  });

  describe('updateBackup', () => {
    it('should write backup file with teams data', async () => {
      const teams = [createMockTeam('t1', 'Team Alpha'), createMockTeam('t2', 'Team Beta')];
      await service.updateBackup(teams);

      const backupPath = service.getBackupPath();
      expect(existsSync(backupPath)).toBe(true);

      const content = await fs.readFile(backupPath, 'utf-8');
      const backup: TeamsBackup = JSON.parse(content);
      expect(backup.teams).toHaveLength(2);
      expect(backup.teams[0].name).toBe('Team Alpha');
      expect(backup.timestamp).toBeDefined();
    });

    it('should overwrite previous backup', async () => {
      await service.updateBackup([createMockTeam('t1', 'First')]);
      await service.updateBackup([createMockTeam('t2', 'Second'), createMockTeam('t3', 'Third')]);

      const backup = await service.readBackup();
      expect(backup!.teams).toHaveLength(2);
      expect(backup!.teams[0].name).toBe('Second');
    });

    it('should handle empty teams array', async () => {
      await service.updateBackup([]);

      const backup = await service.readBackup();
      expect(backup!.teams).toHaveLength(0);
    });
  });

  describe('readBackup', () => {
    it('should return null when no backup file exists', async () => {
      const backup = await service.readBackup();
      expect(backup).toBeNull();
    });

    it('should return parsed backup data', async () => {
      const teams = [createMockTeam('t1', 'Team One')];
      await service.updateBackup(teams);

      const backup = await service.readBackup();
      expect(backup).not.toBeNull();
      expect(backup!.teams).toHaveLength(1);
      expect(backup!.teams[0].id).toBe('t1');
    });

    it('should return null on corrupted backup file', async () => {
      await fs.writeFile(service.getBackupPath(), 'not valid json', 'utf-8');

      const backup = await service.readBackup();
      expect(backup).toBeNull();
    });
  });

  describe('getBackupStatus', () => {
    it('should report no mismatch when no backup exists', async () => {
      const status = await service.getBackupStatus([]);
      expect(status.hasMismatch).toBe(false);
      expect(status.backupTeamCount).toBe(0);
      expect(status.currentTeamCount).toBe(0);
      expect(status.backupTimestamp).toBeNull();
    });

    it('should report mismatch when current is empty but backup has data', async () => {
      await service.updateBackup([createMockTeam('t1', 'Alpha'), createMockTeam('t2', 'Beta')]);

      const status = await service.getBackupStatus([]);
      expect(status.hasMismatch).toBe(true);
      expect(status.backupTeamCount).toBe(2);
      expect(status.currentTeamCount).toBe(0);
      expect(status.backupTimestamp).toBeDefined();
    });

    it('should report no mismatch when both current and backup have data', async () => {
      const teams = [createMockTeam('t1', 'Alpha')];
      await service.updateBackup(teams);

      const status = await service.getBackupStatus(teams);
      expect(status.hasMismatch).toBe(false);
      expect(status.backupTeamCount).toBe(1);
      expect(status.currentTeamCount).toBe(1);
    });

    it('should report no mismatch when backup is empty', async () => {
      await service.updateBackup([]);

      const status = await service.getBackupStatus([]);
      expect(status.hasMismatch).toBe(false);
      expect(status.backupTeamCount).toBe(0);
      expect(status.currentTeamCount).toBe(0);
    });

    it('should report no mismatch when current has data (even if backup differs)', async () => {
      await service.updateBackup([createMockTeam('t1', 'Alpha'), createMockTeam('t2', 'Beta')]);

      const status = await service.getBackupStatus([createMockTeam('t1', 'Alpha')]);
      expect(status.hasMismatch).toBe(false);
      expect(status.backupTeamCount).toBe(2);
      expect(status.currentTeamCount).toBe(1);
    });
  });

  describe('rotating snapshots (A2)', () => {
    /**
     * Helper to read the on-disk history index directly.
     */
    async function readIndex(): Promise<TeamsBackupHistoryIndex> {
      const indexPath = path.join(service.getHistoryDir(), 'index.json');
      const content = await fs.readFile(indexPath, 'utf-8');
      return JSON.parse(content);
    }

    it('should write a snapshot file into the history directory on first save', async () => {
      const teams = [createMockTeam('t1', 'Alpha')];
      await service.updateBackup(teams);

      const slotPath = path.join(service.getHistoryDir(), 'teams-backup-000.json');
      expect(existsSync(slotPath)).toBe(true);

      const slot: TeamsBackup = JSON.parse(await fs.readFile(slotPath, 'utf-8'));
      expect(slot.teams).toHaveLength(1);
      expect(slot.teams[0].id).toBe('t1');
    });

    it('should write index.json with head=0 and written=1 on first save', async () => {
      await service.updateBackup([createMockTeam('t1', 'Alpha')]);

      const idx = await readIndex();
      expect(idx.head).toBe(0);
      expect(idx.written).toBe(1);
      expect(idx.slots[0]).toBeDefined();
      expect(idx.slots[0].teamCount).toBe(1);
    });

    it('should advance head and accumulate slots across multiple saves', async () => {
      await service.updateBackup([createMockTeam('t1', 'A')]);
      await service.updateBackup([createMockTeam('t1', 'A'), createMockTeam('t2', 'B')]);
      await service.updateBackup([createMockTeam('t3', 'C')]);

      const idx = await readIndex();
      expect(idx.head).toBe(2);
      expect(idx.written).toBe(3);
      expect(Object.keys(idx.slots).sort()).toEqual(['0', '1', '2']);
      expect(idx.slots[1].teamCount).toBe(2);
    });

    it('getBackupHistory returns entries newest-first with head first', async () => {
      await service.updateBackup([createMockTeam('t1', 'A')]);
      await service.updateBackup([createMockTeam('t1', 'A'), createMockTeam('t2', 'B')]);

      const history = await service.getBackupHistory();
      expect(history).toHaveLength(2);
      expect(history[0].isHead).toBe(true);
      expect(history[0].slot).toBe(1);
      expect(history[0].teamCount).toBe(2);
      expect(history[1].slot).toBe(0);
      expect(history[1].isHead).toBe(false);
    });

    it('getBackupHistory returns empty array when no history exists', async () => {
      const history = await service.getBackupHistory();
      expect(history).toEqual([]);
    });

    it('rotates back to slot 0 after MAX_HISTORY_SLOTS writes', async () => {
      // Write MAX+2 to force two ring-buffer wrap-arounds
      for (let i = 0; i < MAX_HISTORY_SLOTS + 2; i++) {
        await service.updateBackup([createMockTeam(`t${i}`, `Team ${i}`)]);
      }

      const idx = await readIndex();
      // After MAX writes head is at MAX-1, then writes 0 (slot 0 overwritten), then 1
      expect(idx.head).toBe(1);
      expect(idx.written).toBe(MAX_HISTORY_SLOTS + 2);

      // Slot 0 must contain the LATEST overwrite (team 30), not the original (team 0)
      const slot0 = await service.readSlot(0);
      expect(slot0!.teams[0].id).toBe(`t${MAX_HISTORY_SLOTS}`);

      // Slot 1 must contain team 31
      const slot1 = await service.readSlot(1);
      expect(slot1!.teams[0].id).toBe(`t${MAX_HISTORY_SLOTS + 1}`);
    });

    it('readSlot returns null for out-of-range slot indices', async () => {
      await service.updateBackup([createMockTeam('t1', 'A')]);

      expect(await service.readSlot(-1)).toBeNull();
      expect(await service.readSlot(MAX_HISTORY_SLOTS)).toBeNull();
      expect(await service.readSlot(1.5)).toBeNull();
    });

    it('readSlot returns null for an empty (never-written) slot', async () => {
      await service.updateBackup([createMockTeam('t1', 'A')]);
      // Only slot 0 is populated; slot 5 is empty
      expect(await service.readSlot(5)).toBeNull();
    });

    it('restoreFromSlot retrieves the snapshot for a given slot', async () => {
      const teams = [createMockTeam('t1', 'A'), createMockTeam('t2', 'B')];
      await service.updateBackup(teams);

      const restored = await service.restoreFromSlot(0);
      expect(restored).not.toBeNull();
      expect(restored!.teams).toHaveLength(2);
      expect(restored!.teams[1].name).toBe('B');
    });

    it('integrity-guarded live backup refuses to wipe healthy state; slot 0 still recoverable', async () => {
      // KEY REGRESSION TEST: the 2026-05-03 incident scenario.
      // Prior healthy state with 3 teams.
      const healthy = [createMockTeam('t1', 'A'), createMockTeam('t2', 'B'), createMockTeam('t3', 'C')];
      await service.updateBackup(healthy);

      // Then a "corrupting" save attempts to wipe live backup to []. With A1
      // wired into updateBackup(), the integrity guard REJECTS this write
      // and the live backup stays at the prior healthy 3-team snapshot.
      await service.updateBackup([]);

      // Live backup retained the healthy 3-team snapshot — guard fired.
      const liveBackup = await service.readBackup();
      expect(liveBackup!.teams).toHaveLength(3);
      expect(liveBackup!.teams.map((t) => t.id)).toEqual(['t1', 't2', 't3']);

      // The rotating history slot 0 also retains the healthy snapshot
      // (slot 1 may exist with the empty save — rotating snapshots are
      //  best-effort and not subject to the integrity guard).
      const slot0 = await service.readSlot(0);
      expect(slot0!.teams).toHaveLength(3);
      expect(slot0!.teams.map((t) => t.id)).toEqual(['t1', 't2', 't3']);

      // Operator can restore from the prior-healthy slot if needed.
      const recovered = await service.restoreFromSlot(0);
      expect(recovered!.teams).toHaveLength(3);
    });

    it('tolerates a corrupted history index (best-effort, never throws)', async () => {
      // Pre-create the directory and a corrupted index
      mkdirSync(service.getHistoryDir(), { recursive: true });
      await fs.writeFile(
        path.join(service.getHistoryDir(), 'index.json'),
        '{not valid json',
        'utf-8'
      );

      // updateBackup should still proceed (live backup at minimum)
      await expect(
        service.updateBackup([createMockTeam('t1', 'A')])
      ).resolves.not.toThrow();

      // Live backup still wrote
      const live = await service.readBackup();
      expect(live!.teams).toHaveLength(1);
    });

    it('history failures must NOT block the live backup write path', async () => {
      // Force history write to fail by making historyDir a file instead of a dir.
      // (We do this by writing a file at the historyDir path before any save.)
      await fs.writeFile(service.getHistoryDir(), 'blocker', 'utf-8');

      // updateBackup must not throw — live backup should still succeed
      await expect(
        service.updateBackup([createMockTeam('t1', 'A')])
      ).resolves.not.toThrow();

      const live = await service.readBackup();
      expect(live!.teams).toHaveLength(1);
    });
  });
});
