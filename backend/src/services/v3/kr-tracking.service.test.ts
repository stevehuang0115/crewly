/**
 * Tests for KR Tracking Service — CRUD, measurement, aggregation.
 *
 * @module services/v3/kr-tracking.service.test
 */

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KRTrackingService } from './kr-tracking.service.js';

// Mock logger
jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
      }),
    }),
  },
}));

// Mock TaskPoolService for onWorkItemCompleted
const mockGetAllItems = jest.fn().mockResolvedValue([]);
jest.mock('../task-pool/task-pool.service.js', () => ({
  TaskPoolService: {
    getInstance: () => ({
      getAllItems: mockGetAllItems,
    }),
  },
}));

describe('KRTrackingService', () => {
  let tempDir: string;
  let originalCwd: () => string;

  beforeEach(() => {
    KRTrackingService.resetInstance();
    tempDir = join(tmpdir(), `crewly-kr-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    // Override process.cwd so service writes to temp
    originalCwd = process.cwd;
    process.cwd = () => tempDir;
  });

  afterEach(() => {
    KRTrackingService.resetInstance();
    process.cwd = originalCwd;
    rmSync(tempDir, { recursive: true, force: true });
    mockGetAllItems.mockReset().mockResolvedValue([]);
  });

  const validInput = {
    missionId: 'mission-1',
    title: 'Reduce P95 latency to 200ms',
    metricType: 'number' as const,
    baseline: 500,
    target: 200,
    unit: 'ms',
  };

  describe('create', () => {
    it('should create a KR and persist to disk', async () => {
      const service = KRTrackingService.getInstance();
      const kr = await service.create(validInput);

      expect(kr.id).toBeDefined();
      expect(kr.missionId).toBe('mission-1');
      expect(kr.current).toBe(500);
      expect(kr.status).toBe('not_started');

      // Verify persisted
      const loaded = await service.get('mission-1', kr.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.title).toBe('Reduce P95 latency to 200ms');
    });

    it('should throw on invalid input', async () => {
      const service = KRTrackingService.getInstance();
      await expect(service.create({ ...validInput, title: '' })).rejects.toThrow('Invalid KeyResult input');
    });
  });

  describe('listByMission', () => {
    it('should list all KRs for a mission', async () => {
      const service = KRTrackingService.getInstance();
      await service.create(validInput);
      await service.create({ ...validInput, title: 'Second KR' });

      const list = await service.listByMission('mission-1');
      expect(list).toHaveLength(2);
    });

    it('should return empty array for non-existent mission', async () => {
      const service = KRTrackingService.getInstance();
      const list = await service.listByMission('no-such-mission');
      expect(list).toEqual([]);
    });
  });

  describe('update', () => {
    it('should update current value and recompute status', async () => {
      const service = KRTrackingService.getInstance();
      const kr = await service.create(validInput);

      // Move from 500 toward 200 (lower is better)
      const updated = await service.update('mission-1', kr.id, { current: 350 });
      expect(updated!.current).toBe(350);
      expect(updated!.status).toBe('on_track'); // 50% progress
    });

    it('should return null for non-existent KR', async () => {
      const service = KRTrackingService.getInstance();
      const result = await service.update('mission-1', 'nonexistent', { current: 50 });
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('should delete a KR', async () => {
      const service = KRTrackingService.getInstance();
      const kr = await service.create(validInput);
      const deleted = await service.delete('mission-1', kr.id);
      expect(deleted).toBe(true);

      const loaded = await service.get('mission-1', kr.id);
      expect(loaded).toBeNull();
    });

    it('should return false for non-existent KR', async () => {
      const service = KRTrackingService.getInstance();
      const deleted = await service.delete('mission-1', 'nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('recordMeasurement', () => {
    it('should record measurement and update status', async () => {
      const service = KRTrackingService.getInstance();
      const kr = await service.create(validInput);

      const measurement = await service.recordMeasurement('mission-1', kr.id, 350, 'test-agent');
      expect(measurement).not.toBeNull();
      expect(measurement!.value).toBe(350);

      const updated = await service.get('mission-1', kr.id);
      expect(updated!.current).toBe(350);
      expect(updated!.status).toBe('on_track');
      expect(updated!.measurements).toHaveLength(1);
    });

    it('should cap measurement history', async () => {
      const service = KRTrackingService.getInstance();
      const kr = await service.create(validInput);

      // Record 55 measurements
      for (let i = 0; i < 55; i++) {
        await service.recordMeasurement('mission-1', kr.id, 500 - i, 'test');
      }

      const updated = await service.get('mission-1', kr.id);
      expect(updated!.measurements.length).toBeLessThanOrEqual(50);
    });

    it('should return null for non-existent KR', async () => {
      const service = KRTrackingService.getInstance();
      const result = await service.recordMeasurement('mission-1', 'nonexistent', 100, 'test');
      expect(result).toBeNull();
    });
  });

  describe('linkWorkItem', () => {
    it('should link a WorkItem to a KR', async () => {
      const service = KRTrackingService.getInstance();
      const kr = await service.create(validInput);

      await service.linkWorkItem('mission-1', kr.id, 'work-item-1');
      const updated = await service.get('mission-1', kr.id);
      expect(updated!.linkedWorkItemIds).toContain('work-item-1');
    });

    it('should not duplicate links', async () => {
      const service = KRTrackingService.getInstance();
      const kr = await service.create(validInput);

      await service.linkWorkItem('mission-1', kr.id, 'work-item-1');
      await service.linkWorkItem('mission-1', kr.id, 'work-item-1');
      const updated = await service.get('mission-1', kr.id);
      expect(updated!.linkedWorkItemIds.filter(id => id === 'work-item-1')).toHaveLength(1);
    });
  });

  describe('onWorkItemCompleted', () => {
    it('should auto-update task_completion KR on WorkItem done', async () => {
      const service = KRTrackingService.getInstance();
      const kr = await service.create({
        ...validInput,
        baseline: 0,
        target: 100,
        measurementSource: 'task_completion',
      });
      await service.linkWorkItem('mission-1', kr.id, 'wi-1');
      await service.linkWorkItem('mission-1', kr.id, 'wi-2');

      // Simulate: wi-1 done, wi-2 still running
      mockGetAllItems.mockResolvedValue([
        { id: 'wi-1', status: 'done' },
        { id: 'wi-2', status: 'running' },
      ]);

      await service.onWorkItemCompleted({
        id: 'wi-1',
        missionId: 'mission-1',
        metadata: { krId: kr.id },
        status: 'done',
      } as any);

      const updated = await service.get('mission-1', kr.id);
      expect(updated!.current).toBe(50); // 1/2 = 50%
    });

    it('should skip non-task_completion KRs', async () => {
      const service = KRTrackingService.getInstance();
      const kr = await service.create(validInput); // default: manual

      await service.onWorkItemCompleted({
        id: 'wi-1',
        missionId: 'mission-1',
        metadata: { krId: kr.id },
        status: 'done',
      } as any);

      const updated = await service.get('mission-1', kr.id);
      expect(updated!.current).toBe(500); // unchanged
    });
  });

  describe('computeMissionOKRProgress', () => {
    it('should aggregate KR progress', async () => {
      const service = KRTrackingService.getInstance();
      await service.create({ ...validInput, title: 'KR1' });
      const kr2 = await service.create({
        ...validInput,
        title: 'KR2',
        baseline: 0,
        target: 100,
      });
      // Update kr2 to 100% achieved
      await service.update('mission-1', kr2.id, { current: 100 });

      const summary = await service.computeMissionOKRProgress('mission-1');
      expect(summary.totalKRs).toBe(2);
      expect(summary.achieved).toBe(1);
      expect(summary.notStarted).toBe(1);
      expect(summary.overallProgress).toBe(50); // average of 0% and 100%
    });

    it('should return empty summary for mission without KRs', async () => {
      const service = KRTrackingService.getInstance();
      const summary = await service.computeMissionOKRProgress('empty-mission');
      expect(summary.totalKRs).toBe(0);
      expect(summary.recommendation).toBe('continue');
    });
  });

  // -------------------------------------------------------------------------
  // Cross-Level Roll-Up (cascade)
  // -------------------------------------------------------------------------

  describe('listChildMissions / computeCascadeOKRProgress', () => {
    /** Minimal Mission writer for cascade tests. */
    function writeMission(
      id: string,
      opts: {
        parentMissionId?: string;
        level?: 'company' | 'team' | 'project';
        approvalState?: 'draft' | 'pending_approval' | 'approved' | 'rejected';
        staleCycles?: number;
      } = {},
    ): void {
      const dir = join(tempDir, '.crewly', 'missions');
      mkdirSync(dir, { recursive: true });
      const mission: Record<string, unknown> = {
        id,
        objective: `Objective ${id}`,
        ownerTeamId: 'team-x',
        successCriteria: [],
        currentStrategy: '',
        activeProjectTaskIds: [],
        cadence: '0 9 * * 1',
        policy: { missionId: id },
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        learnings: [],
        parentMissionId: opts.parentMissionId,
        level: opts.level,
        staleCycles: opts.staleCycles,
      };
      if (opts.approvalState) {
        mission.approval = { state: opts.approvalState };
      }
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(mission, null, 2));
    }

    /** Create one KR on a mission and drive it to a given current value. */
    async function seedKR(missionId: string, current: number): Promise<void> {
      const service = KRTrackingService.getInstance();
      const kr = await service.create({
        missionId,
        title: `KR for ${missionId}`,
        metricType: 'percentage',
        baseline: 0,
        target: 100,
        unit: '%',
      });
      await service.update(missionId, kr.id, { current });
    }

    it('lists only cascade-active (approved/legacy) direct children', async () => {
      writeMission('co', { level: 'company' });
      writeMission('t-approved', { parentMissionId: 'co', level: 'team', approvalState: 'approved' });
      writeMission('t-pending', { parentMissionId: 'co', level: 'team', approvalState: 'pending_approval' });
      writeMission('t-legacy', { parentMissionId: 'co', level: 'team' }); // no approval => active

      const service = KRTrackingService.getInstance();
      const children = await service.listChildMissions('co');
      const ids = children.map((c) => c.id).sort();
      expect(ids).toEqual(['t-approved', 't-legacy']);
    });

    it('rolls up a 3-level tree with equal-weight averaging', async () => {
      // company -> team -> project
      writeMission('co', { level: 'company' });
      writeMission('team', { parentMissionId: 'co', level: 'team', approvalState: 'approved' });
      writeMission('proj', { parentMissionId: 'team', level: 'project', approvalState: 'approved' });

      await seedKR('co', 30);    // company own = 30
      await seedKR('team', 60);  // team own = 60
      await seedKR('proj', 90);  // project own = 90 (leaf)

      const service = KRTrackingService.getInstance();
      const summary = await service.computeCascadeOKRProgress('co');

      // project is a leaf: rolledUp = 90
      const team = summary.children[0];
      const proj = team.children[0];
      expect(proj.rolledUpProgress).toBe(90);
      expect(proj.level).toBe('project');
      expect(proj.childMissionCount).toBe(0);

      // team: avg(60, 90) = 75
      expect(team.rolledUpProgress).toBe(75);
      expect(team.level).toBe('team');
      expect(team.childMissionCount).toBe(1);

      // company: avg(30, 75) = round(52.5) = 53
      expect(summary.rolledUpProgress).toBe(53);
      expect(summary.level).toBe('company');
      expect(summary.childMissionCount).toBe(1);
    });

    it('excludes pending/draft/rejected children from roll-up', async () => {
      writeMission('co', { level: 'company' });
      writeMission('approved', { parentMissionId: 'co', level: 'team', approvalState: 'approved' });
      writeMission('pending', { parentMissionId: 'co', level: 'team', approvalState: 'pending_approval' });

      await seedKR('co', 40);
      await seedKR('approved', 100);
      await seedKR('pending', 0); // would drag the avg down if (wrongly) included

      const service = KRTrackingService.getInstance();
      const summary = await service.computeCascadeOKRProgress('co');

      expect(summary.childMissionCount).toBe(1);
      // avg(40, 100) = 70 (pending child excluded)
      expect(summary.rolledUpProgress).toBe(70);
    });

    it('treats an orphan (missing parent) as a root for its own subtree', async () => {
      // No 'ghost' parent file exists.
      writeMission('orphan', { parentMissionId: 'ghost', level: 'team', approvalState: 'approved' });
      await seedKR('orphan', 50);

      const service = KRTrackingService.getInstance();
      const summary = await service.computeCascadeOKRProgress('orphan');
      expect(summary.missionId).toBe('orphan');
      expect(summary.rolledUpProgress).toBe(50);
      // level honoured from explicit field even though parent is missing
      expect(summary.level).toBe('team');
    });

    it('guards against cycles in the parent chain', async () => {
      // a -> b -> a (illegal, but defend anyway)
      writeMission('a', { parentMissionId: 'b', level: 'team', approvalState: 'approved' });
      writeMission('b', { parentMissionId: 'a', level: 'team', approvalState: 'approved' });
      await seedKR('a', 20);
      await seedKR('b', 80);

      const service = KRTrackingService.getInstance();
      // Should terminate (no infinite recursion) and produce a finite summary.
      const summary = await service.computeCascadeOKRProgress('a');
      expect(summary.missionId).toBe('a');
      // a visits b once; b will not re-visit a (already visited).
      expect(summary.children.map((c) => c.missionId)).toEqual(['b']);
      expect(summary.children[0].children).toEqual([]);
    });

    it('derives a roll-up recommendation from own + synthetic child statuses', async () => {
      writeMission('co', { level: 'company' });
      writeMission('c1', { parentMissionId: 'co', level: 'team', approvalState: 'approved' });
      writeMission('c2', { parentMissionId: 'co', level: 'team', approvalState: 'approved' });

      // Company has no own KRs; both children are off_track (low progress).
      await seedKR('c1', 5);
      await seedKR('c2', 5);

      const service = KRTrackingService.getInstance();
      const summary = await service.computeCascadeOKRProgress('co');
      // Two synthetic off_track child statuses, no healthy => not 'continue'.
      expect(summary.recommendation).not.toBe('continue');
    });

    // Regression (finding 1): children stalled at EXACTLY 0% progress must read
    // as off_track (not not_started) so an all-stalled parent escalates/replans.
    // Previously deriveKRStatus(0, 0, 0) short-circuited to not_started, masking
    // the signal; the dedicated deriveCascadeChildStatus mapper fixes it.
    it('escalates/replans when every child is stalled at 0% rolled-up progress', async () => {
      writeMission('co', { level: 'company' });
      writeMission('c1', { parentMissionId: 'co', level: 'team', approvalState: 'approved' });
      writeMission('c2', { parentMissionId: 'co', level: 'team', approvalState: 'approved' });

      // Company has no own KRs; both children sit at exactly 0 progress.
      await seedKR('c1', 0);
      await seedKR('c2', 0);

      const service = KRTrackingService.getInstance();
      const summary = await service.computeCascadeOKRProgress('co');

      // Both children roll up to 0%.
      expect(summary.children.map((c) => c.rolledUpProgress)).toEqual([0, 0]);
      // Two synthetic off_track statuses (off_track ratio = 1.0 > 0.4) => replan,
      // NOT 'continue' and NOT silently suppressed as not_started.
      expect(summary.recommendation).toBe('replan');
    });

    // Regression (finding 3): the root's persisted staleCycles must seed the
    // rollup. Previously computeCascadeOKRProgress defaulted staleCycles to 0,
    // ignoring the queried root's persisted value and suppressing escalation.
    it('seeds the root staleCycles from the persisted mission (staleness escalates)', async () => {
      // Root with 2 stale cycles (>= escalate threshold) and no children.
      writeMission('co', { level: 'company', staleCycles: 2 });
      // One own KR so the recommendation logic runs (empty KR set short-circuits
      // to 'continue' before the staleCycles check).
      await seedKR('co', 80);

      const service = KRTrackingService.getInstance();
      // No explicit staleCycles arg => must read the persisted value (2).
      const summary = await service.computeCascadeOKRProgress('co');
      expect(summary.childMissionCount).toBe(0);
      expect(summary.recommendation).toBe('escalate');
    });

    // An explicit staleCycles argument still overrides the persisted value.
    it('lets an explicit staleCycles argument override the persisted value', async () => {
      writeMission('co', { level: 'company', staleCycles: 2 });
      await seedKR('co', 80);

      const service = KRTrackingService.getInstance();
      const summary = await service.computeCascadeOKRProgress('co', 0);
      // staleCycles 0 + a healthy (on_track) KR => continue, not escalate.
      expect(summary.recommendation).toBe('continue');
    });
  });

});
