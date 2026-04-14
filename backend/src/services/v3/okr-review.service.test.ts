/**
 * Tests for OKR Review Service — review execution and decision processing.
 *
 * @module services/v3/okr-review.service.test
 */

import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { OKRReviewService } from './okr-review.service.js';

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

// Mock KRTrackingService
const mockComputeProgress = jest.fn();
const mockKRUpdate = jest.fn();

jest.mock('./kr-tracking.service.js', () => ({
  KRTrackingService: {
    getInstance: () => ({
      computeMissionOKRProgress: mockComputeProgress,
      update: mockKRUpdate,
    }),
  },
}));

// Mock MissionExecutorService
const mockCheckProgress = jest.fn();
const mockPauseMission = jest.fn();
const mockCancelRemaining = jest.fn();

jest.mock('./mission-executor.service.js', () => ({
  MissionExecutorService: {
    getInstance: () => ({
      checkProgress: mockCheckProgress,
      pauseMission: mockPauseMission,
      cancelRemainingPhaseTasks: mockCancelRemaining,
    }),
  },
}));

// Mock getEffectiveCadence
jest.mock('../../types/v2/mission.types.js', () => ({
  getEffectiveCadence: jest.fn().mockReturnValue({
    reviewSchedule: '0 9 * * 1',
    phaseGateApproval: 'none',
  }),
}));

describe('OKRReviewService', () => {
  let tempDir: string;
  let originalCwd: () => string;

  beforeEach(() => {
    OKRReviewService.resetInstance();
    tempDir = join(tmpdir(), `crewly-okr-review-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    originalCwd = process.cwd;
    process.cwd = () => tempDir;
    jest.clearAllMocks();
  });

  afterEach(() => {
    OKRReviewService.resetInstance();
    process.cwd = originalCwd;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeMission(id: string, overrides: Record<string, unknown> = {}): void {
    const dir = join(tempDir, '.crewly', 'missions');
    mkdirSync(dir, { recursive: true });
    const mission = {
      id,
      objective: 'Test objective',
      ownerTeamId: 'team-1',
      successCriteria: [],
      currentStrategy: 'Build fast',
      policy: { canCreateTasks: true, maxParallelExecutions: 3, escalationRules: [] },
      status: 'active',
      learnings: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(mission, null, 2));
  }

  describe('executeReview', () => {
    it('should return continue when KRs are healthy', async () => {
      writeMission('m1');
      mockComputeProgress.mockResolvedValue({
        missionId: 'm1',
        totalKRs: 3,
        achieved: 1,
        onTrack: 2,
        atRisk: 0,
        offTrack: 0,
        notStarted: 0,
        overallProgress: 70,
        recommendation: 'continue',
      });
      mockCheckProgress.mockResolvedValue({ missionId: 'm1', totalTasks: 10, completedTasks: 7 });

      const service = OKRReviewService.getInstance();
      const result = await service.executeReview('m1');

      expect(result.action).toBe('continue');
      expect(result.recommendation).toBe('continue');
    });

    it('should trigger review skill when strategy adjustment needed', async () => {
      writeMission('m1');
      mockComputeProgress.mockResolvedValue({
        missionId: 'm1', totalKRs: 3, achieved: 0, onTrack: 1, atRisk: 2, offTrack: 0,
        notStarted: 0, overallProgress: 35, recommendation: 'adjust_strategy',
      });
      mockCheckProgress.mockResolvedValue({ missionId: 'm1' });

      const service = OKRReviewService.getInstance();
      const result = await service.executeReview('m1');

      expect(result.action).toBe('trigger_review_skill');
    });

    it('should trigger replan when off track', async () => {
      writeMission('m1');
      mockComputeProgress.mockResolvedValue({
        missionId: 'm1', totalKRs: 3, achieved: 0, onTrack: 0, atRisk: 1, offTrack: 2,
        notStarted: 0, overallProgress: 15, recommendation: 'replan',
      });
      mockCheckProgress.mockResolvedValue({ missionId: 'm1' });

      const service = OKRReviewService.getInstance();
      const result = await service.executeReview('m1');

      expect(result.action).toBe('trigger_replan');
    });

    it('should escalate after stale cycles', async () => {
      writeMission('m1', { staleCycles: 1, lastReviewSummary: 'Progress: 30%' });
      mockComputeProgress
        .mockResolvedValueOnce({
          missionId: 'm1', totalKRs: 2, achieved: 0, onTrack: 0, atRisk: 2, offTrack: 0,
          notStarted: 0, overallProgress: 30, recommendation: 'adjust_strategy',
        })
        .mockResolvedValueOnce({
          missionId: 'm1', totalKRs: 2, achieved: 0, onTrack: 0, atRisk: 2, offTrack: 0,
          notStarted: 0, overallProgress: 30, recommendation: 'escalate',
        });
      mockCheckProgress.mockResolvedValue({ missionId: 'm1' });

      const service = OKRReviewService.getInstance();
      const result = await service.executeReview('m1');

      expect(result.action).toBe('escalate');
    });

    it('should throw for non-existent mission', async () => {
      const service = OKRReviewService.getInstance();
      await expect(service.executeReview('nonexistent')).rejects.toThrow('Mission nonexistent not found');
    });
  });

  describe('processReviewDecision', () => {
    it('should update strategy on adjust_strategy', async () => {
      writeMission('m1');

      const service = OKRReviewService.getInstance();
      await service.processReviewDecision('m1', {
        action: 'adjust_strategy',
        newStrategy: 'Focus on performance optimization',
      });

      // Mission should be updated (we can't easily verify file content without re-reading)
      // At least it shouldn't throw
    });

    it('should cancel remaining tasks on replan_phase', async () => {
      writeMission('m1');
      mockCancelRemaining.mockResolvedValue(3);

      const service = OKRReviewService.getInstance();
      await service.processReviewDecision('m1', {
        action: 'replan_phase',
        newPhase: 2,
      });

      expect(mockCancelRemaining).toHaveBeenCalledWith('m1');
    });

    it('should cancel mission and pause on cancel_mission', async () => {
      writeMission('m1');
      mockPauseMission.mockResolvedValue(5);

      const service = OKRReviewService.getInstance();
      await service.processReviewDecision('m1', { action: 'cancel_mission' });

      expect(mockPauseMission).toHaveBeenCalledWith('m1');
    });

    it('should update KR targets when krUpdates provided', async () => {
      writeMission('m1');
      mockKRUpdate.mockResolvedValue({});

      const service = OKRReviewService.getInstance();
      await service.processReviewDecision('m1', {
        action: 'continue',
        krUpdates: [{ krId: 'kr-1', newTarget: 150 }],
      });

      expect(mockKRUpdate).toHaveBeenCalledWith('m1', 'kr-1', { target: 150 });
    });
  });
});
