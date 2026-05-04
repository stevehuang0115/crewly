/**
 * Persistence P0 — End-to-end "artificial nuke" recovery test.
 *
 * This is the acceptance gate referenced in
 * `.crewly/specs/2026-05-03-state-persistence-fix-spec.md`. It exercises
 * the full A1+A2+C1 chain through the real `StorageService` +
 * `TeamsBackupService` against a real temp directory, simulating the
 * 2026-05-03 incident in miniature:
 *
 *   1. Healthy state: 3 teams persisted on disk + populated ring buffer
 *      + populated live backup. Boot invariant passes.
 *   2. Artificial nuke: live `teams/` directory wiped while backups
 *      remain intact (mirrors the real incident).
 *   3. Boot refused: a fresh service instance evaluating the invariant
 *      detects the mismatch and throws `StateInvariantViolation` with
 *      the correct counts and remediation hint.
 *   4. Recovery: `restoreFromSlot(0)` returns the healthy snapshot;
 *      caller re-seeds teams via `saveTeam()`.
 *   5. Boot clean: a third fresh service instance evaluates the
 *      invariant and passes — the backend is ready to serve traffic.
 *
 * Runs entirely off the real filesystem (no mocks) so a regression in
 * any layer (atomic-write guard, ring-buffer rotation, restore path, or
 * boot invariant check) will fail this test.
 *
 * @module services/core/persistence-recovery.e2e.test
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import { existsSync, rmSync } from 'fs';
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
 * Build a minimal Team object suitable for round-tripping through
 * StorageService.saveTeam → getTeams.
 */
function buildTeam(id: string, name: string): Team {
  return {
    id,
    name,
    description: `${name} description`,
    projectIds: [],
    members: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Force the in-memory live backup state to be flushed and the ring
 * buffer to advance, since `saveTeam` schedules backup via a
 * fire-and-forget call. We call `updateBackup` directly with the
 * current `getTeams()` result to make the test deterministic.
 */
async function flushBackup(
  storage: StorageService,
  backup: TeamsBackupService
): Promise<void> {
  const teams = await storage.getTeams();
  await backup.updateBackup(teams);
}

describe('Persistence P0 — artificial-nuke recovery (e2e)', () => {
  let testHome: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-p0-e2e-'));
    StorageService.clearInstance();
    TeamsBackupService.clearInstance();
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

  it('healthy state → nuke → boot refused → restore → boot clean', async () => {
    // ──────────────────────────────────────────────────────────────
    // PHASE 1: Establish a healthy persisted state.
    // ──────────────────────────────────────────────────────────────
    let storage = StorageService.getInstance(testHome);
    let backup = TeamsBackupService.getInstance(testHome);

    const seedTeams: Team[] = [
      buildTeam('team-alpha', 'Alpha Squad'),
      buildTeam('team-beta', 'Beta Squad'),
      buildTeam('team-gamma', 'Gamma Squad'),
    ];

    for (const t of seedTeams) {
      await storage.saveTeam(t);
    }
    await flushBackup(storage, backup);

    // Sanity: live state has 3 teams, backup has 3 teams, slot 0 populated.
    expect((await storage.getTeams()).length).toBe(3);
    const status = await backup.getBackupStatus(await storage.getTeams());
    expect(status.backupTeamCount).toBe(3);
    expect(status.currentTeamCount).toBe(3);
    expect(status.hasMismatch).toBe(false);

    const historyBefore = await backup.getBackupHistory();
    expect(historyBefore.length).toBeGreaterThanOrEqual(1);

    // Boot invariant passes against the healthy state.
    await expect(storage.verifyStateInvariantOnBoot()).resolves.not.toThrow();

    // ──────────────────────────────────────────────────────────────
    // PHASE 2: Artificially nuke the live `teams/` directory (mirrors
    // the 2026-05-03 incident). Backups remain intact.
    // ──────────────────────────────────────────────────────────────
    const teamsDir = path.join(testHome, 'teams');
    expect(existsSync(teamsDir)).toBe(true);
    rmSync(teamsDir, { recursive: true, force: true });
    expect(existsSync(teamsDir)).toBe(false);

    // Backup files must still exist on disk.
    expect(existsSync(path.join(testHome, 'teams-backup.json'))).toBe(true);
    expect(existsSync(path.join(testHome, 'teams-backup-history'))).toBe(true);

    // Simulate a fresh process: re-instantiate services from disk.
    StorageService.clearInstance();
    TeamsBackupService.clearInstance();
    storage = StorageService.getInstance(testHome);
    backup = TeamsBackupService.getInstance(testHome);

    // ──────────────────────────────────────────────────────────────
    // PHASE 3: Boot is refused — invariant fires with correct details.
    // ──────────────────────────────────────────────────────────────
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
    expect(err.message).toMatch(/CREWLY_FORCE_EMPTY_BOOT/);

    // ──────────────────────────────────────────────────────────────
    // PHASE 4: Recover from ring-buffer slot 0.
    // ──────────────────────────────────────────────────────────────
    const restored = await backup.restoreFromSlot(0);
    expect(restored).not.toBeNull();
    expect(restored!.teams.length).toBe(3);

    for (const t of restored!.teams) {
      await storage.saveTeam(t);
    }
    await flushBackup(storage, backup);

    // ──────────────────────────────────────────────────────────────
    // PHASE 5: Boot is clean — fresh services pass the invariant.
    // ──────────────────────────────────────────────────────────────
    StorageService.clearInstance();
    TeamsBackupService.clearInstance();
    storage = StorageService.getInstance(testHome);
    backup = TeamsBackupService.getInstance(testHome);

    const recoveredTeams = await storage.getTeams();
    expect(recoveredTeams.length).toBe(3);
    expect(recoveredTeams.map((t) => t.id).sort()).toEqual([
      'team-alpha',
      'team-beta',
      'team-gamma',
    ]);

    await expect(storage.verifyStateInvariantOnBoot()).resolves.not.toThrow();
  });

  it('CREWLY_FORCE_EMPTY_BOOT=1 lets operator boot through after nuke (legitimate reset path)', async () => {
    // Healthy state.
    let storage = StorageService.getInstance(testHome);
    let backup = TeamsBackupService.getInstance(testHome);
    await storage.saveTeam(buildTeam('team-only', 'Only Team'));
    await flushBackup(storage, backup);

    // Nuke.
    rmSync(path.join(testHome, 'teams'), { recursive: true, force: true });
    StorageService.clearInstance();
    TeamsBackupService.clearInstance();
    storage = StorageService.getInstance(testHome);

    // Without override: refused.
    await expect(storage.verifyStateInvariantOnBoot()).rejects.toBeInstanceOf(
      StateInvariantViolation
    );

    // With override: allowed (operator is intentionally booting empty).
    process.env[FORCE_EMPTY_BOOT_ENV] = '1';
    await expect(storage.verifyStateInvariantOnBoot()).resolves.not.toThrow();
  });

  it('A1 guard blocks an in-flight wipe attempt (collapse-to-empty refused)', async () => {
    // Establish 3-team healthy state with populated backup.
    const storage = StorageService.getInstance(testHome);
    const backup = TeamsBackupService.getInstance(testHome);
    for (const t of [
      buildTeam('a', 'A'),
      buildTeam('b', 'B'),
      buildTeam('c', 'C'),
    ]) {
      await storage.saveTeam(t);
    }
    await flushBackup(storage, backup);

    // Pre-condition: backup has 3 teams.
    expect((await backup.readBackup())!.teams.length).toBe(3);

    // Attempt to collapse the live backup to empty. The A1 guard should
    // refuse the write internally; the catch path in updateBackup logs
    // an error but does not re-throw, so the live backup must remain
    // unchanged on disk.
    await backup.updateBackup([]);

    const liveAfter = await backup.readBackup();
    expect(liveAfter!.teams.length).toBe(3);
    expect(liveAfter!.teams.map((t) => t.id).sort()).toEqual(['a', 'b', 'c']);
  });
});
