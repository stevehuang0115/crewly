/**
 * Tests for KR Controller — REST endpoint handlers.
 *
 * @module controllers/mission/kr.controller.test
 */

import {
  listKeyResults,
  createKR,
  getKR,
  updateKR,
  deleteKR,
  measureKR,
  getOKRSummary,
} from './kr.controller.js';

// Mock KRTrackingService
const mockListByMission = jest.fn();
const mockCreate = jest.fn();
const mockGet = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockRecordMeasurement = jest.fn();
const mockComputeProgress = jest.fn();

jest.mock('../../services/v3/kr-tracking.service.js', () => ({
  KRTrackingService: {
    getInstance: () => ({
      listByMission: mockListByMission,
      create: mockCreate,
      get: mockGet,
      update: mockUpdate,
      delete: mockDelete,
      recordMeasurement: mockRecordMeasurement,
      computeMissionOKRProgress: mockComputeProgress,
    }),
  },
}));

describe('KR Controller', () => {
  let mockRes: { json: jest.Mock; status: jest.Mock };
  const next = jest.fn();

  beforeEach(() => {
    mockRes = {
      json: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
    };
    jest.clearAllMocks();
  });

  describe('listKeyResults', () => {
    it('should return KRs for a mission', async () => {
      const krs = [{ id: 'kr-1', title: 'KR 1' }];
      mockListByMission.mockResolvedValue(krs);

      await listKeyResults(
        { params: { id: 'mission-1' } } as any,
        mockRes as any,
        next,
      );

      expect(mockListByMission).toHaveBeenCalledWith('mission-1');
      expect(mockRes.json).toHaveBeenCalledWith({ success: true, data: krs, count: 1 });
    });
  });

  describe('createKR', () => {
    it('should create a KR', async () => {
      const kr = { id: 'kr-1', title: 'New KR' };
      mockCreate.mockResolvedValue(kr);

      await createKR(
        { params: { id: 'mission-1' }, body: { title: 'New KR', metricType: 'number', baseline: 0, target: 100, unit: '%' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(201);
    });

    it('should return 400 for invalid input', async () => {
      await createKR(
        { params: { id: 'mission-1' }, body: {} } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });
  });

  describe('getKR', () => {
    it('should return KR when found', async () => {
      const kr = { id: 'kr-1', title: 'KR' };
      mockGet.mockResolvedValue(kr);

      await getKR(
        { params: { id: 'mission-1', krId: 'kr-1' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.json).toHaveBeenCalledWith({ success: true, data: kr });
    });

    it('should return 404 when not found', async () => {
      mockGet.mockResolvedValue(null);

      await getKR(
        { params: { id: 'mission-1', krId: 'nonexistent' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(404);
    });
  });

  describe('measureKR', () => {
    it('should record a measurement', async () => {
      const measurement = { value: 350, measuredAt: '2026-04-13T00:00:00Z', source: 'test' };
      mockRecordMeasurement.mockResolvedValue(measurement);

      await measureKR(
        { params: { id: 'mission-1', krId: 'kr-1' }, body: { value: 350, source: 'test' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.json).toHaveBeenCalledWith({ success: true, data: measurement });
    });

    it('should return 400 when value is missing', async () => {
      await measureKR(
        { params: { id: 'mission-1', krId: 'kr-1' }, body: {} } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should return 404 when KR not found', async () => {
      mockRecordMeasurement.mockResolvedValue(null);

      await measureKR(
        { params: { id: 'mission-1', krId: 'nonexistent' }, body: { value: 100 } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(404);
    });
  });

  describe('getOKRSummary', () => {
    it('should return aggregated progress', async () => {
      const summary = { missionId: 'mission-1', totalKRs: 3, overallProgress: 60, recommendation: 'continue' };
      mockComputeProgress.mockResolvedValue(summary);

      await getOKRSummary(
        { params: { id: 'mission-1' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.json).toHaveBeenCalledWith({ success: true, data: summary });
    });
  });
});
