/**
 * Tests for the THW controller — happy path + 503 + 400 paths.
 *
 * @module controllers/team-health/team-health.controller.test
 */

import type { Request, Response, NextFunction } from 'express';
import {
  getTeamHealthScan,
  runTeamHealthSweep,
  silenceTeamHealthAlerts,
  setTeamHealthWatchdogService,
  getTeamHealthWatchdogService,
} from './team-health.controller.js';
import type { TeamHealthWatchdogService } from '../../services/team-health/index.js';

interface ResponseSpy {
  statusCode: number;
  body: unknown;
  status(code: number): ResponseSpy;
  json(payload: unknown): ResponseSpy;
}

function makeRes(): ResponseSpy {
  const r: ResponseSpy = {
    statusCode: 200, body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return r;
}

const noopNext: NextFunction = () => {};

describe('THW controller', () => {
  beforeEach(() => {
    setTeamHealthWatchdogService(null);
  });

  describe('GET /api/team-health/scan', () => {
    it('returns 503 when service not initialized', async () => {
      const res = makeRes();
      await getTeamHealthScan({ query: {} } as unknown as Request, res as unknown as Response, noopNext);
      expect(res.statusCode).toBe(503);
    });

    it('returns verdicts and lastSweep on happy path', async () => {
      const fakeWatchdog: Partial<TeamHealthWatchdogService> = {
        getCurrentVerdicts: () => ([{
          teamId: 't1', verdict: 'healthy',
          gates: { team_idle: false, team_pending: false, team_silent: false, cascade_with_siblings: false },
          pendingWorkItemIds: [], idleAgentSessions: [],
          detectedAt: '2026-04-25T19:30:00.000Z', rationale: '',
        }]),
        getLastSweep: () => ({
          sweptAt: '2026-04-25T19:30:00.000Z', durationMs: 7,
          detections: [], alerts: [], bootGraceSuppressed: false, shadowMode: true,
        }),
        getLastSweepAgeMs: () => 1234,
        isDegraded: () => false,
      };
      setTeamHealthWatchdogService(fakeWatchdog as TeamHealthWatchdogService);
      const res = makeRes();
      await getTeamHealthScan({ query: {} } as unknown as Request, res as unknown as Response, noopNext);
      expect(res.statusCode).toBe(200);
      const body = res.body as { success: boolean; data: { verdicts: unknown[]; lastSweepAgeMs: number; degraded: boolean } };
      expect(body.success).toBe(true);
      expect(body.data.verdicts).toHaveLength(1);
      expect(body.data.lastSweepAgeMs).toBe(1234);
      expect(body.data.degraded).toBe(false);
    });

    it('passes teamId filter through to service', async () => {
      let receivedFilter: string | undefined;
      const fakeWatchdog: Partial<TeamHealthWatchdogService> = {
        getCurrentVerdicts: ((id?: string) => {
          receivedFilter = id;
          return [];
        }) as never,
        getLastSweep: () => null,
        getLastSweepAgeMs: () => -1,
        isDegraded: () => false,
      };
      setTeamHealthWatchdogService(fakeWatchdog as TeamHealthWatchdogService);
      const res = makeRes();
      await getTeamHealthScan(
        { query: { teamId: 'marketing' } } as unknown as Request,
        res as unknown as Response,
        noopNext,
      );
      expect(receivedFilter).toBe('marketing');
    });
  });

  describe('POST /api/team-health/run', () => {
    it('returns 503 when service not initialized', async () => {
      const res = makeRes();
      await runTeamHealthSweep({} as Request, res as unknown as Response, noopNext);
      expect(res.statusCode).toBe(503);
    });

    it('returns sweep result on happy path', async () => {
      const fakeWatchdog: Partial<TeamHealthWatchdogService> = {
        runOnce: async () => ({
          sweptAt: '2026-04-25T19:30:00.000Z', durationMs: 5,
          detections: [], alerts: [], bootGraceSuppressed: false, shadowMode: true,
        }),
      };
      setTeamHealthWatchdogService(fakeWatchdog as TeamHealthWatchdogService);
      const res = makeRes();
      await runTeamHealthSweep({} as Request, res as unknown as Response, noopNext);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /api/team-health/silence', () => {
    it('400 when teamId missing', async () => {
      const fakeWatchdog: Partial<TeamHealthWatchdogService> = { silenceTeam: () => {} };
      setTeamHealthWatchdogService(fakeWatchdog as TeamHealthWatchdogService);
      const res = makeRes();
      await silenceTeamHealthAlerts(
        { body: { durationMs: 60_000 } } as Request,
        res as unknown as Response,
        noopNext,
      );
      expect(res.statusCode).toBe(400);
    });

    it('400 when durationMs invalid', async () => {
      const fakeWatchdog: Partial<TeamHealthWatchdogService> = { silenceTeam: () => {} };
      setTeamHealthWatchdogService(fakeWatchdog as TeamHealthWatchdogService);
      const res = makeRes();
      await silenceTeamHealthAlerts(
        { body: { teamId: 'marketing', durationMs: -5 } } as Request,
        res as unknown as Response,
        noopNext,
      );
      expect(res.statusCode).toBe(400);
    });

    it('200 when silence applied', async () => {
      let calledWith: [string, number] | null = null;
      const fakeWatchdog: Partial<TeamHealthWatchdogService> = {
        silenceTeam: (id: string, ms: number) => { calledWith = [id, ms]; },
      };
      setTeamHealthWatchdogService(fakeWatchdog as TeamHealthWatchdogService);
      const res = makeRes();
      await silenceTeamHealthAlerts(
        { body: { teamId: 'marketing', durationMs: 7_200_000 } } as Request,
        res as unknown as Response,
        noopNext,
      );
      expect(res.statusCode).toBe(200);
      expect(calledWith).toEqual(['marketing', 7_200_000]);
    });
  });

  describe('getTeamHealthWatchdogService accessor', () => {
    it('returns the test override when set', () => {
      const fake = {} as TeamHealthWatchdogService;
      setTeamHealthWatchdogService(fake);
      expect(getTeamHealthWatchdogService()).toBe(fake);
    });
  });
});
