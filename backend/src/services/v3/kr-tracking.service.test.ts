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
});
