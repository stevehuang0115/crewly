/**
 * Boot-time state invariant tests (C1 of the 2026-05-03 persistence-fix
 * spec). Exercises StorageService.verifyStateInvariantOnBoot() against
 * a real temp directory + real TeamsBackupService.
 *
 * @module services/core/storage.service.invariant.test
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import { existsSync, mkdirSync, rmSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StorageService } from './storage.service.js';
import { TeamsBackupService } from './teams-backup.service.js';
import {
  StateInvariantViolation,
  FORCE_EMPTY_BOOT_ENV,
} from './state-invariant.types.js';
import type { Team } from '../../types/index.js';

/**
 * Helper to create a minimal Team object.
 */
function createMockTeam(id: string, name: string): Team {
  return {
    id,
    name,
    description: '',
    projectIds: [],
    members: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Write a team config.json directly into the teamsDir, simulating an
 * already-loaded healthy state.
 */
async function seedTeamOnDisk(teamsDir: string, team: Team): Promise<void> {
  const dir = path.join(teamsDir, team.id);
  mkdirSync(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(team, null, 2), 'utf-8');
}

describe('StorageService.verifyStateInvariantOnBoot (C1)', () => {
  let testHome: string;
  let storage: StorageService;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-c1-'));
    StorageService.clearInstance();
    TeamsBackupService.clearInstance();
    storage = StorageService.getInstance(testHome);
    originalEnv = process.env[FORCE_EMPTY_BOOT_ENV];
    delete process.env[FORCE_EMPTY_BOOT_ENV];
  });

  afterEach(() => {
    StorageService.clearInstance();
    TeamsBackupService.clearInstance();
    if (originalEnv === undefined) {
      delete process.env[FORCE_EMPTY_BOOT_ENV];
    } else {
      process.env[FORCE_EMPTY_BOOT_ENV] = originalEnv;
    }
    if (existsSync(testHome)) {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it('passes on a fresh install (no teams, no backup)', async () => {
    await expect(storage.verifyStateInvariantOnBoot()).resolves.not.toThrow();
  });

  it('passes when both live teams and backup are populated', async () => {
    // Seed a healthy on-disk team.
    const teamsDir = path.join(testHome, 'teams');
    mkdirSync(teamsDir, { recursive: true });
    await seedTeamOnDisk(teamsDir, createMockTeam('t1', 'Alpha'));

    // Write a matching backup.
    const backupService = TeamsBackupService.getInstance(testHome);
    await backupService.updateBackup([createMockTeam('t1', 'Alpha')]);

    await expect(storage.verifyStateInvariantOnBoot()).resolves.not.toThrow();
  });

  it('passes when both live teams and backup are empty', async () => {
    // No teams seeded, no backup written.
    await expect(storage.verifyStateInvariantOnBoot()).resolves.not.toThrow();
  });

  it('throws StateInvariantViolation when live empty but backup populated', async () => {
    // Backup has 3 teams; live state has none.
    const backupService = TeamsBackupService.getInstance(testHome);
    await backupService.updateBackup([
      createMockTeam('t1', 'Alpha'),
      createMockTeam('t2', 'Beta'),
      createMockTeam('t3', 'Gamma'),
    ]);

    let caught: unknown;
    try {
      await storage.verifyStateInvariantOnBoot();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(StateInvariantViolation);
    const err = caught as StateInvariantViolation;
    expect(err.currentTeamCount).toBe(0);
    expect(err.backupTeamCount).toBe(3);
    expect(err.backupTimestamp).toBeTruthy();
    expect(err.message).toMatch(/Refusing to start/);
    expect(err.message).toMatch(/3 teams/);
    expect(err.message).toMatch(/CREWLY_FORCE_EMPTY_BOOT/);
  });

  it('honors CREWLY_FORCE_EMPTY_BOOT=1 override and boots through', async () => {
    const backupService = TeamsBackupService.getInstance(testHome);
    await backupService.updateBackup([createMockTeam('t1', 'Alpha')]);

    process.env[FORCE_EMPTY_BOOT_ENV] = '1';

    await expect(storage.verifyStateInvariantOnBoot()).resolves.not.toThrow();
  });

  it('rejects override when env value is falsy ("0")', async () => {
    const backupService = TeamsBackupService.getInstance(testHome);
    await backupService.updateBackup([createMockTeam('t1', 'Alpha')]);

    process.env[FORCE_EMPTY_BOOT_ENV] = '0';

    await expect(storage.verifyStateInvariantOnBoot()).rejects.toBeInstanceOf(
      StateInvariantViolation
    );
  });

  it('does NOT throw when backup status read fails (best-effort guard)', async () => {
    // Corrupt the backup file so getBackupStatus errors out internally.
    // safeReadJson returns null for unparseable JSON, which yields
    // hasMismatch=false — the check should pass cleanly.
    const backupPath = path.join(testHome, 'teams-backup.json');
    await fs.writeFile(backupPath, '{not valid json', 'utf-8');

    await expect(storage.verifyStateInvariantOnBoot()).resolves.not.toThrow();
  });
});
