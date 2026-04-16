/**
 * Tests for Mission Period Lifecycle Service
 *
 * @module services/v3/mission-period.service.test
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { MissionPeriodService } from './mission-period.service.js';
import { createMission, createMonthlyPeriod } from '../../types/v2/mission.types.js';
import type { Mission } from '../../types/v2/mission.types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMissionsDir(): string {
  return path.join(process.cwd(), '.crewly', 'missions');
}

async function writeMission(mission: Mission): Promise<void> {
  const dir = getMissionsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${mission.id}.json`), JSON.stringify(mission, null, 2));
}

async function readMission(id: string): Promise<Mission> {
  const raw = await fs.readFile(path.join(getMissionsDir(), `${id}.json`), 'utf-8');
  return JSON.parse(raw) as Mission;
}

async function cleanMissionsDir(): Promise<void> {
  try {
    const dir = getMissionsDir();
    const files = await fs.readdir(dir);
    for (const f of files) {
      await fs.unlink(path.join(dir, f));
    }
  } catch { /* dir doesn't exist */ }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MissionPeriodService', () => {
  beforeEach(async () => {
    MissionPeriodService.resetInstance();
    await cleanMissionsDir();
  });

  afterEach(async () => {
    await cleanMissionsDir();
  });

  describe('reconcile', () => {
    it('should activate paused missions whose period has started', async () => {
      const period = createMonthlyPeriod(2026, 4);
      const mission = createMission({
        objective: 'April OKR',
        ownerTeamId: 'team-1',
        successCriteria: ['Done'],
        currentStrategy: 'Go',
        period,
      });
      // Force paused status (as if created before period started)
      mission.status = 'paused';
      await writeMission(mission);

      const service = MissionPeriodService.getInstance();
      // Reconcile with a date inside April 2026
      const result = await service.reconcile(new Date('2026-04-15T12:00:00.000Z'));

      expect(result.activated).toContain(mission.id);
      expect(result.endOfPeriod).toHaveLength(0);

      // Verify mission was actually updated on disk
      const updated = await readMission(mission.id);
      expect(updated.status).toBe('active');
    });

    it('should flag active missions whose period has ended', async () => {
      const period = createMonthlyPeriod(2026, 3); // March
      const mission = createMission({
        objective: 'March OKR',
        ownerTeamId: 'team-1',
        successCriteria: ['Done'],
        currentStrategy: 'Go',
        period,
      });
      mission.status = 'active';
      await writeMission(mission);

      const service = MissionPeriodService.getInstance();
      const result = await service.reconcile(new Date('2026-04-05T00:00:00.000Z'));

      expect(result.endOfPeriod).toContain(mission.id);
      expect(result.activated).toHaveLength(0);
    });

    it('should skip missions without a period', async () => {
      const mission = createMission({
        objective: 'No period',
        ownerTeamId: 'team-1',
        successCriteria: [],
        currentStrategy: '',
      });
      await writeMission(mission);

      const service = MissionPeriodService.getInstance();
      const result = await service.reconcile();

      expect(result.evaluated).toBe(0);
      expect(result.activated).toHaveLength(0);
      expect(result.endOfPeriod).toHaveLength(0);
    });

    it('should skip terminal missions', async () => {
      const period = createMonthlyPeriod(2026, 4);
      const mission = createMission({
        objective: 'Completed',
        ownerTeamId: 'team-1',
        successCriteria: [],
        currentStrategy: '',
        period,
      });
      mission.status = 'completed';
      await writeMission(mission);

      const service = MissionPeriodService.getInstance();
      const result = await service.reconcile(new Date('2026-04-15T12:00:00.000Z'));

      expect(result.evaluated).toBe(0);
    });
  });

  describe('getActivePeriodMissions', () => {
    it('should return active missions sorted by priority', async () => {
      const period = createMonthlyPeriod(2026, 4);
      const low = createMission({
        objective: 'Low priority',
        ownerTeamId: 'team-1',
        successCriteria: [],
        currentStrategy: '',
        priority: 'low',
        period,
      });
      const high = createMission({
        objective: 'High priority',
        ownerTeamId: 'team-1',
        successCriteria: [],
        currentStrategy: '',
        priority: 'high',
        period,
      });
      await writeMission(low);
      await writeMission(high);

      const service = MissionPeriodService.getInstance();
      const results = await service.getActivePeriodMissions(new Date('2026-04-15T12:00:00.000Z'));

      expect(results).toHaveLength(2);
      expect(results[0].priority).toBe('high');
      expect(results[1].priority).toBe('low');
    });

    it('should include missions without a period', async () => {
      const mission = createMission({
        objective: 'Always active',
        ownerTeamId: 'team-1',
        successCriteria: [],
        currentStrategy: '',
      });
      await writeMission(mission);

      const service = MissionPeriodService.getInstance();
      const results = await service.getActivePeriodMissions();

      expect(results).toHaveLength(1);
    });
  });

  describe('getMissionsByTeamAndPeriod', () => {
    it('should filter by team and current period', async () => {
      const period = createMonthlyPeriod(2026, 4);
      const team1 = createMission({
        objective: 'Team 1 OKR',
        ownerTeamId: 'team-1',
        successCriteria: [],
        currentStrategy: '',
        period,
      });
      const team2 = createMission({
        objective: 'Team 2 OKR',
        ownerTeamId: 'team-2',
        successCriteria: [],
        currentStrategy: '',
        period,
      });
      await writeMission(team1);
      await writeMission(team2);

      const service = MissionPeriodService.getInstance();
      const results = await service.getMissionsByTeamAndPeriod(
        'team-1', 'current', new Date('2026-04-15T12:00:00.000Z'),
      );

      expect(results).toHaveLength(1);
      expect(results[0].ownerTeamId).toBe('team-1');
    });

    it('should return future missions', async () => {
      const futurePeriod = createMonthlyPeriod(2026, 5);
      const mission = createMission({
        objective: 'May OKR',
        ownerTeamId: 'team-1',
        successCriteria: [],
        currentStrategy: '',
        period: futurePeriod,
      });
      await writeMission(mission);

      const service = MissionPeriodService.getInstance();
      const results = await service.getMissionsByTeamAndPeriod(
        'team-1', 'future', new Date('2026-04-15T12:00:00.000Z'),
      );

      expect(results).toHaveLength(1);
    });
  });
});
