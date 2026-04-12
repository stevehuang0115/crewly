/**
 * MissionPolicy Controller Tests
 *
 * Tests for GET /api/missions/:id/policy, PUT /api/missions/:id/policy,
 * and POST /api/missions/:id/policy/check endpoints.
 *
 * @module controllers/mission/mission-policy.controller.test
 */

import type { Request, Response } from 'express';
import {
  getPolicy,
  updatePolicy,
  checkPolicy,
  resetEnforcementService,
  _loadMission,
  _saveMission,
} from './mission-policy.controller.js';
import type { Mission, MissionPolicy } from '../../types/v2/index.js';
import { createMission, createMissionPolicy } from '../../types/v2/index.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('fs/promises');
jest.mock('../../utils/file-io.utils.js', () => ({
  ensureDir: jest.fn().mockResolvedValue(undefined),
  atomicWriteJson: jest.fn().mockResolvedValue(undefined),
  safeReadJson: jest.fn().mockResolvedValue(null),
}));

import * as fileIo from '../../utils/file-io.utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock Express request.
 */
function mockRequest(overrides: Partial<Request> = {}): Request {
  return {
    params: {},
    body: {},
    query: {},
    ...overrides,
  } as unknown as Request;
}

/**
 * Creates a mock Express response with spies.
 */
function mockResponse(): Response & {
  _status: number;
  _json: unknown;
} {
  const res = {
    _status: 200,
    _json: null as unknown,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(data: unknown) {
      res._json = data;
      return res;
    },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

/**
 * Creates a test mission with a moderate policy.
 */
function createTestMission(id: string = 'mission-1'): Mission {
  return createMission({
    objective: 'Test mission',
    ownerTeamId: 'team-1',
    successCriteria: ['criterion-1'],
    currentStrategy: 'test strategy',
    policy: { ...createMissionPolicy(id, 'moderate'), missionId: id },
  });
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('MissionPolicy Controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetEnforcementService();
  });

  // =========================================================================
  // GET /api/missions/:id/policy
  // =========================================================================
  describe('getPolicy', () => {
    it('returns 400 when mission ID is missing', async () => {
      const req = mockRequest({ params: {} });
      const res = mockResponse();

      await getPolicy(req, res);

      expect(res._status).toBe(400);
      expect((res._json as Record<string, unknown>).success).toBe(false);
    });

    it('returns 404 when mission is not found', async () => {
      jest.mocked(fileIo.safeReadJson).mockResolvedValueOnce(null);

      const req = mockRequest({ params: { id: 'nonexistent' } });
      const res = mockResponse();

      await getPolicy(req, res);

      expect(res._status).toBe(404);
      expect((res._json as Record<string, unknown>).success).toBe(false);
    });

    it('returns the policy for an existing mission', async () => {
      const mission = createTestMission('m-abc');
      jest.mocked(fileIo.safeReadJson).mockResolvedValueOnce(mission);

      const req = mockRequest({ params: { id: 'm-abc' } });
      const res = mockResponse();

      await getPolicy(req, res);

      expect(res._status).toBe(200);
      const body = res._json as { success: boolean; data: MissionPolicy };
      expect(body.success).toBe(true);
      expect(body.data.missionId).toBe(mission.policy.missionId);
      expect(body.data.canCreateTasks).toBe(mission.policy.canCreateTasks);
    });

    it('returns 500 on internal error', async () => {
      jest.mocked(fileIo.safeReadJson).mockRejectedValueOnce(new Error('disk failure'));

      const req = mockRequest({ params: { id: 'm-1' } });
      const res = mockResponse();

      await getPolicy(req, res);

      expect(res._status).toBe(500);
      expect((res._json as Record<string, unknown>).error).toBe('disk failure');
    });
  });

  // =========================================================================
  // PUT /api/missions/:id/policy
  // =========================================================================
  describe('updatePolicy', () => {
    it('returns 400 when mission ID is missing', async () => {
      const req = mockRequest({ params: {}, body: { canCreateTasks: true } });
      const res = mockResponse();

      await updatePolicy(req, res);

      expect(res._status).toBe(400);
    });

    it('returns 400 when body is invalid (non-boolean field)', async () => {
      const req = mockRequest({
        params: { id: 'm-1' },
        body: { canCreateTasks: 'yes' },
      });
      const res = mockResponse();

      await updatePolicy(req, res);

      expect(res._status).toBe(400);
      expect((res._json as Record<string, string>).error).toContain('canCreateTasks');
    });

    it('returns 400 when maxParallelExecutions is invalid', async () => {
      const req = mockRequest({
        params: { id: 'm-1' },
        body: { maxParallelExecutions: 0 },
      });
      const res = mockResponse();

      await updatePolicy(req, res);

      expect(res._status).toBe(400);
      expect((res._json as Record<string, string>).error).toContain('maxParallelExecutions');
    });

    it('returns 400 when escalationRules contain invalid rule', async () => {
      const req = mockRequest({
        params: { id: 'm-1' },
        body: {
          escalationRules: [{ condition: 'bogus', threshold: 1, escalateTo: 'user', action: 'pause' }],
        },
      });
      const res = mockResponse();

      await updatePolicy(req, res);

      expect(res._status).toBe(400);
      expect((res._json as Record<string, string>).error).toContain('escalationRules[0]');
    });

    it('returns 404 when mission is not found', async () => {
      jest.mocked(fileIo.safeReadJson).mockResolvedValueOnce(null);

      const req = mockRequest({
        params: { id: 'nonexistent' },
        body: { canDeployToStaging: true },
      });
      const res = mockResponse();

      await updatePolicy(req, res);

      expect(res._status).toBe(404);
    });

    it('updates policy fields and persists', async () => {
      const mission = createTestMission('m-upd');
      jest.mocked(fileIo.safeReadJson).mockResolvedValueOnce(mission);

      const req = mockRequest({
        params: { id: 'm-upd' },
        body: { canDeployToStaging: true, maxParallelExecutions: 10 },
      });
      const res = mockResponse();

      await updatePolicy(req, res);

      expect(res._status).toBe(200);
      const body = res._json as { success: boolean; data: MissionPolicy };
      expect(body.success).toBe(true);
      expect(body.data.canDeployToStaging).toBe(true);
      expect(body.data.maxParallelExecutions).toBe(10);
      // missionId should be preserved
      expect(body.data.missionId).toBe(mission.policy.missionId);
      // atomicWriteJson should have been called to persist
      expect(fileIo.atomicWriteJson).toHaveBeenCalledTimes(1);
    });

    it('updates escalation rules when provided', async () => {
      const mission = createTestMission('m-esc');
      jest.mocked(fileIo.safeReadJson).mockResolvedValueOnce(mission);

      const newRules = [
        { condition: 'cost_exceeded' as const, threshold: 100, escalateTo: 'user' as const, action: 'block' as const },
      ];

      const req = mockRequest({
        params: { id: 'm-esc' },
        body: { escalationRules: newRules },
      });
      const res = mockResponse();

      await updatePolicy(req, res);

      expect(res._status).toBe(200);
      const body = res._json as { success: boolean; data: MissionPolicy };
      expect(body.data.escalationRules).toHaveLength(1);
      expect(body.data.escalationRules[0].condition).toBe('cost_exceeded');
    });

    it('returns 500 on internal error', async () => {
      const mission = createTestMission('m-err');
      jest.mocked(fileIo.safeReadJson).mockResolvedValueOnce(mission);
      jest.mocked(fileIo.atomicWriteJson).mockRejectedValueOnce(new Error('write failed'));

      const req = mockRequest({
        params: { id: 'm-err' },
        body: { canCreateTasks: false },
      });
      const res = mockResponse();

      await updatePolicy(req, res);

      expect(res._status).toBe(500);
    });
  });

  // =========================================================================
  // POST /api/missions/:id/policy/check — Dry-run
  // =========================================================================
  describe('checkPolicy', () => {
    it('returns 400 when mission ID is missing', async () => {
      const req = mockRequest({ params: {}, body: { action: 'create_task' } });
      const res = mockResponse();

      await checkPolicy(req, res);

      expect(res._status).toBe(400);
    });

    it('returns 400 when action is missing', async () => {
      const req = mockRequest({ params: { id: 'm-1' }, body: {} });
      const res = mockResponse();

      await checkPolicy(req, res);

      expect(res._status).toBe(400);
      expect((res._json as Record<string, string>).error).toContain('action is required');
    });

    it('returns 400 when action is invalid', async () => {
      const req = mockRequest({
        params: { id: 'm-1' },
        body: { action: 'hack_the_planet' },
      });
      const res = mockResponse();

      await checkPolicy(req, res);

      expect(res._status).toBe(400);
      expect((res._json as Record<string, string>).error).toContain('Invalid action');
    });

    it('returns 404 when mission is not found', async () => {
      jest.mocked(fileIo.safeReadJson).mockResolvedValueOnce(null);

      const req = mockRequest({
        params: { id: 'ghost' },
        body: { action: 'create_task' },
      });
      const res = mockResponse();

      await checkPolicy(req, res);

      expect(res._status).toBe(404);
    });

    it('returns allowed=true for permitted action', async () => {
      const mission = createTestMission('m-chk');
      // Moderate policy allows create_task
      jest.mocked(fileIo.safeReadJson).mockResolvedValueOnce(mission);

      const req = mockRequest({
        params: { id: 'm-chk' },
        body: { action: 'create_task' },
      });
      const res = mockResponse();

      await checkPolicy(req, res);

      expect(res._status).toBe(200);
      const body = res._json as { success: boolean; data: { allowed: boolean } };
      expect(body.success).toBe(true);
      expect(body.data.allowed).toBe(true);
    });

    it('returns allowed=false for blocked action', async () => {
      const mission = createTestMission('m-blk');
      // Moderate policy blocks deploy_prod
      jest.mocked(fileIo.safeReadJson).mockResolvedValueOnce(mission);

      const req = mockRequest({
        params: { id: 'm-blk' },
        body: { action: 'deploy_prod' },
      });
      const res = mockResponse();

      await checkPolicy(req, res);

      expect(res._status).toBe(200);
      const body = res._json as { success: boolean; data: { allowed: boolean; reason?: string } };
      expect(body.data.allowed).toBe(false);
      expect(body.data.reason).toBeDefined();
    });

    it('evaluates escalation context in dry-run', async () => {
      const mission = createTestMission('m-esc-chk');
      // Add an escalation rule that blocks on cost_exceeded > 50
      mission.policy.escalationRules = [
        { condition: 'cost_exceeded', threshold: 50, escalateTo: 'user', action: 'block' },
      ];
      jest.mocked(fileIo.safeReadJson).mockResolvedValueOnce(mission);

      const req = mockRequest({
        params: { id: 'm-esc-chk' },
        body: {
          action: 'create_task',
          context: { currentCost: 100 },
        },
      });
      const res = mockResponse();

      await checkPolicy(req, res);

      expect(res._status).toBe(200);
      const body = res._json as { success: boolean; data: { allowed: boolean; reason?: string } };
      expect(body.data.allowed).toBe(false);
      expect(body.data.reason).toContain('cost_exceeded');
    });

    it('returns 400 when context is not an object', async () => {
      const req = mockRequest({
        params: { id: 'm-1' },
        body: { action: 'create_task', context: 'not-an-object' },
      });
      const res = mockResponse();

      await checkPolicy(req, res);

      expect(res._status).toBe(400);
      expect((res._json as Record<string, string>).error).toContain('context must be an object');
    });

    it('returns 500 on internal error', async () => {
      jest.mocked(fileIo.safeReadJson).mockRejectedValueOnce(new Error('read error'));

      const req = mockRequest({
        params: { id: 'm-1' },
        body: { action: 'create_task' },
      });
      const res = mockResponse();

      await checkPolicy(req, res);

      expect(res._status).toBe(500);
    });
  });
});
