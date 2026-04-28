/**
 * Tests for MissionReminderService.
 *
 * Coverage matrix (7 cases):
 *  1. off-track → reminder sent with urgency=high
 *  2. cooldown → skip
 *  3. non-active mission → filtered out
 *  4. at-risk only (no off-track) → urgency=normal
 *  5. Slack send failure → lastReminderAt NOT advanced (cooldown stays open)
 *  6. ownerId missing → falls back to TL via pickTeamLead
 *  7. force=true → bypasses cooldown
 *
 * (Corrupt-JSON skip is exercised implicitly by the existing
 *  loadAllActiveMissions try/catch — covered indirectly by case 3.)
 */

import { jest } from '@jest/globals';
import { MissionReminderService } from './mission-reminder.service.js';
import { KRTrackingService } from './kr-tracking.service.js';
import { StorageService } from '../core/storage.service.js';
import { getSlackOrchestratorBridge } from '../slack/slack-orchestrator-bridge.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { atomicWriteJson } from '../../utils/file-io.utils.js';
import * as fs from 'fs/promises';

// Mock dependencies
jest.mock('./kr-tracking.service.js');
jest.mock('../core/storage.service.js');
jest.mock('../slack/slack-orchestrator-bridge.js');
jest.mock('../task-pool/task-pool.service.js');
jest.mock('../../utils/file-io.utils.js');
jest.mock('fs/promises');

describe('MissionReminderService', () => {
  let service: MissionReminderService;
  let mockKRTrackingService: any;
  let mockStorageService: any;
  let mockSlackBridge: any;
  let mockTaskPool: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockKRTrackingService = {
      computeMissionOKRProgress: jest.fn(),
    };
    (KRTrackingService.getInstance as any).mockReturnValue(mockKRTrackingService);

    mockStorageService = {
      getMemberById: jest.fn(),
      // Default to empty list so resolveTeamLeadSession can fall through
      // to the orchestrator without throwing on `teams.find`.
      getTeams: jest.fn(() => Promise.resolve([])),
    };
    (StorageService.getInstance as any).mockReturnValue(mockStorageService);

    mockSlackBridge = {
      sendNotification: jest.fn(),
    };
    (getSlackOrchestratorBridge as any).mockReturnValue(mockSlackBridge);

    mockTaskPool = {
      addToPool: jest.fn(() => Promise.resolve(undefined)),
      findWorkItem: jest.fn(() => Promise.resolve(null)),
    };
    (TaskPoolService.getInstance as any).mockReturnValue(mockTaskPool);

    (atomicWriteJson as any).mockResolvedValue(undefined);

    // Default-on for the review WI loop; specific tests can flip this.
    delete process.env['CREWLY_REVIEW_WI_ENABLED'];

    MissionReminderService.resetInstance();
    service = MissionReminderService.getInstance();
  });

  it('should send reminders for missions with off-track KRs (urgency=high)', async () => {
    const mockMission = {
      id: 'm1',
      objective: 'Test Mission',
      status: 'active',
      ownerTeamId: 't1',
      ownerId: 'u1',
    };

    (fs.readdir as any).mockResolvedValue(['m1.json']);
    (fs.readFile as any).mockResolvedValue(JSON.stringify(mockMission));

    mockKRTrackingService.computeMissionOKRProgress.mockResolvedValue({
      missionId: 'm1',
      total: 2,
      achieved: 0,
      onTrack: 0,
      atRisk: 0,
      offTrack: 1,
      progress: 0,
      status: 'off_track',
    });

    mockStorageService.getMemberById.mockResolvedValue({ id: 'u1', name: 'Victor' });

    const result = await service.runSweep();

    expect(result.sent).toBe(1);
    expect(mockSlackBridge.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'okr_reminder',
        urgency: 'high',
      }),
    );
  });

  it('should not send reminders if cooldown has not passed', async () => {
    const oneHourAgo = new Date();
    oneHourAgo.setHours(oneHourAgo.getHours() - 1);

    const mockMission = {
      id: 'm1',
      objective: 'Test Mission',
      status: 'active',
      ownerTeamId: 't1',
      lastReminderAt: oneHourAgo.toISOString(),
    };

    (fs.readdir as any).mockResolvedValue(['m1.json']);
    (fs.readFile as any).mockResolvedValue(JSON.stringify(mockMission));

    const result = await service.runSweep();

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockSlackBridge.sendNotification).not.toHaveBeenCalled();
  });

  it('should skip completed or cancelled missions', async () => {
    (fs.readdir as any).mockResolvedValue(['m1.json', 'm2.json']);
    (fs.readFile as any).mockImplementation((p: string) => {
      if (p.includes('m1')) return Promise.resolve(JSON.stringify({ id: 'm1', status: 'completed' }));
      if (p.includes('m2')) return Promise.resolve(JSON.stringify({ id: 'm2', status: 'active' }));
      return Promise.reject(new Error('File not found'));
    });

    mockKRTrackingService.computeMissionOKRProgress.mockResolvedValue({
      offTrack: 0,
      atRisk: 0,
    });

    const result = await service.runSweep();

    expect(result.checked).toBe(1); // only m2 was active
  });

  // ---- M5 NEW CASES ------------------------------------------------------

  it('case 4: at-risk only (no off-track) → urgency=normal', async () => {
    const mockMission = {
      id: 'm1',
      objective: 'At-risk Mission',
      status: 'active',
      ownerTeamId: 't1',
      ownerId: 'u1',
    };

    (fs.readdir as any).mockResolvedValue(['m1.json']);
    (fs.readFile as any).mockResolvedValue(JSON.stringify(mockMission));

    mockKRTrackingService.computeMissionOKRProgress.mockResolvedValue({
      missionId: 'm1',
      total: 3,
      achieved: 0,
      onTrack: 1,
      atRisk: 2,
      offTrack: 0, // no off-track
      progress: 0.3,
      status: 'at_risk',
    });

    mockStorageService.getMemberById.mockResolvedValue({ id: 'u1', name: 'Owner' });

    const result = await service.runSweep();

    expect(result.sent).toBe(1);
    expect(mockSlackBridge.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'okr_reminder',
        urgency: 'normal',
      }),
    );
  });

  it('case 5: Slack send failure → lastReminderAt NOT advanced (cooldown stays open)', async () => {
    const mockMission = {
      id: 'm1',
      objective: 'Failing send mission',
      status: 'active',
      ownerTeamId: 't1',
      ownerId: 'u1',
    };

    (fs.readdir as any).mockResolvedValue(['m1.json']);
    (fs.readFile as any).mockResolvedValue(JSON.stringify(mockMission));

    mockKRTrackingService.computeMissionOKRProgress.mockResolvedValue({
      missionId: 'm1',
      total: 1,
      achieved: 0,
      onTrack: 0,
      atRisk: 0,
      offTrack: 1,
      progress: 0,
      status: 'off_track',
    });

    mockStorageService.getMemberById.mockResolvedValue({ id: 'u1', name: 'Owner' });

    // Slack throws — sendReminder should swallow + return false; cooldown
    // must stay open so the next sweep retries.
    mockSlackBridge.sendNotification.mockRejectedValue(new Error('slack outage'));

    const result = await service.runSweep();

    expect(result.sent).toBe(0);
    expect(atomicWriteJson).not.toHaveBeenCalled(); // lastReminderAt NOT persisted
  });

  it('case 6: ownerId missing → falls back to TL via pickTeamLead', async () => {
    const mockMission = {
      id: 'm1',
      objective: 'Owner-fallback Mission',
      status: 'active',
      ownerTeamId: 't1',
      // ownerId intentionally absent
    };

    (fs.readdir as any).mockResolvedValue(['m1.json']);
    (fs.readFile as any).mockResolvedValue(JSON.stringify(mockMission));

    mockKRTrackingService.computeMissionOKRProgress.mockResolvedValue({
      missionId: 'm1',
      total: 1,
      achieved: 0,
      onTrack: 0,
      atRisk: 0,
      offTrack: 1,
      progress: 0,
      status: 'off_track',
    });

    mockStorageService.getTeams.mockResolvedValue([
      {
        id: 't1',
        name: 'Team One',
        members: [
          { id: 'd1', name: 'Dev', role: 'developer', hierarchyLevel: 2, canDelegate: false },
          {
            id: 'tl1',
            name: 'Lead Person',
            role: 'team-leader',
            hierarchyLevel: 1,
            canDelegate: true,
          },
        ],
      },
    ]);

    const result = await service.runSweep();

    expect(result.sent).toBe(1);
    expect(mockSlackBridge.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Lead Person'),
      }),
    );
  });

  it('case 7: force=true bypasses cooldown', async () => {
    const oneHourAgo = new Date();
    oneHourAgo.setHours(oneHourAgo.getHours() - 1);

    const mockMission = {
      id: 'm1',
      objective: 'Recently-reminded mission',
      status: 'active',
      ownerTeamId: 't1',
      ownerId: 'u1',
      lastReminderAt: oneHourAgo.toISOString(), // would normally be cooled-down
    };

    (fs.readdir as any).mockResolvedValue(['m1.json']);
    (fs.readFile as any).mockResolvedValue(JSON.stringify(mockMission));

    mockKRTrackingService.computeMissionOKRProgress.mockResolvedValue({
      missionId: 'm1',
      total: 1,
      achieved: 0,
      onTrack: 0,
      atRisk: 0,
      offTrack: 1,
      progress: 0,
      status: 'off_track',
    });

    mockStorageService.getMemberById.mockResolvedValue({ id: 'u1', name: 'Owner' });

    const result = await service.runSweep(true); // force

    expect(result.skipped).toBe(0);
    expect(result.sent).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // REVIEW-1: cadence-driven review WorkItem creation
  // ---------------------------------------------------------------------------

  describe('review WorkItem creation (REVIEW-1)', () => {
    /** Build a mission shaped like the live JSON files, with cadence + member. */
    function makeMissionWithCadence(overrides: Record<string, unknown> = {}) {
      return {
        id: 'm-cadence',
        objective: 'Ship cadence-driven reviews',
        ownerTeamId: 't-1',
        successCriteria: [],
        currentStrategy: '',
        activeProjectTaskIds: ['pt-1'],
        cadence: '',
        status: 'active',
        createdAt: '2026-04-20T00:00:00.000Z',
        updatedAt: '2026-04-20T00:00:00.000Z',
        learnings: [],
        policy: {
          missionId: 'm-cadence',
          executionCadence: {
            // AUTONOMOUS — daily 09:00 UTC.
            reviewSchedule: '0 9 * * *',
            dailyItemLimit: 0,
            workHours: null,
            phaseGateApproval: 'none',
            requireVerificationGate: false,
          },
        },
        ...overrides,
      };
    }

    function defaultSummary(overrides: Record<string, number> = {}) {
      return {
        missionId: 'm-cadence',
        total: 1,
        achieved: 0,
        onTrack: 1,
        atRisk: 0,
        offTrack: 0,
        progress: 0,
        status: 'on_track',
        totalKRs: 1,
        overallProgress: 0,
        ...overrides,
      };
    }

    /**
     * Pin `Date.now()` so cron-parser deterministically produces the
     * same boundary across replays in a single test.
     */
    function pinNow(iso: string) {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(iso));
    }

    afterEach(() => {
      jest.useRealTimers();
    });

    it('creates a review WorkItem at the cadence boundary with deterministic id', async () => {
      pinNow('2026-04-27T10:00:00Z'); // after today's 09:00 boundary
      const mission = makeMissionWithCadence();
      (fs.readdir as any).mockResolvedValue(['m-cadence.json']);
      (fs.readFile as any).mockResolvedValue(JSON.stringify(mission));
      mockKRTrackingService.computeMissionOKRProgress.mockResolvedValue(defaultSummary());

      const result = await service.runSweep();

      expect(result.reviewsCreated).toBe(1);
      expect(mockTaskPool.addToPool).toHaveBeenCalledTimes(1);
      const wi = mockTaskPool.addToPool.mock.calls[0][0];
      // Deterministic id collapses to <missionId>:review:<YYYY-MM-DD>
      expect(wi.id).toBe('m-cadence:review:2026-04-27');
      expect(wi.type).toBe('review');
      expect(wi.owner).toBe('team_lead');
      expect(wi.missionId).toBe('m-cadence');
      // F-H: review WIs MUST opt out of TL self-verification.
      expect(wi.metadata.requiresVerification).toBe(false);
      // V1: idempotencyKey == id (same dedup surface).
      expect(wi.metadata.idempotencyKey).toBe(wi.id);
    });

    it('persists pendingReviewWorkItemId + lastReviewAt on the Mission after creation', async () => {
      pinNow('2026-04-27T10:00:00Z');
      const mission = makeMissionWithCadence();
      (fs.readdir as any).mockResolvedValue(['m-cadence.json']);
      (fs.readFile as any).mockResolvedValue(JSON.stringify(mission));
      mockKRTrackingService.computeMissionOKRProgress.mockResolvedValue(defaultSummary());

      await service.runSweep();

      const lastSaveCall = (atomicWriteJson as any).mock.calls.at(-1);
      const persistedMission = lastSaveCall[1];
      expect(persistedMission.pendingReviewWorkItemId).toBe('m-cadence:review:2026-04-27');
      expect(persistedMission.lastReviewAt).toBe('2026-04-27T10:00:00.000Z');
    });

    it('idempotent replay — second sweep tick within the same cycle creates no duplicate', async () => {
      pinNow('2026-04-27T10:00:00Z');
      const mission = makeMissionWithCadence({
        // First sweep already recorded today's review.
        lastReviewAt: '2026-04-27T09:30:00.000Z',
        pendingReviewWorkItemId: undefined, // pretend the prior WI already cleared
      });
      (fs.readdir as any).mockResolvedValue(['m-cadence.json']);
      (fs.readFile as any).mockResolvedValue(JSON.stringify(mission));
      mockKRTrackingService.computeMissionOKRProgress.mockResolvedValue(defaultSummary());

      const result = await service.runSweep();

      expect(result.reviewsCreated).toBe(0);
      expect(result.reviewsSkipped).toBe(1);
      expect(mockTaskPool.addToPool).not.toHaveBeenCalled();
    });

    it('reentrancy lock — pendingReviewWorkItemId in non-terminal state blocks creation', async () => {
      pinNow('2026-04-28T10:00:00Z'); // next cycle, but the previous WI is still active
      const mission = makeMissionWithCadence({
        lastReviewAt: '2026-04-27T09:30:00.000Z',
        pendingReviewWorkItemId: 'm-cadence:review:2026-04-27',
      });
      (fs.readdir as any).mockResolvedValue(['m-cadence.json']);
      (fs.readFile as any).mockResolvedValue(JSON.stringify(mission));
      mockKRTrackingService.computeMissionOKRProgress.mockResolvedValue(defaultSummary());
      mockTaskPool.findWorkItem.mockResolvedValue({
        id: 'm-cadence:review:2026-04-27',
        status: 'running', // still active — TL hasn't acted on it yet
      });

      const result = await service.runSweep();

      expect(result.reviewsCreated).toBe(0);
      expect(result.reviewsSkipped).toBe(1);
      expect(mockTaskPool.addToPool).not.toHaveBeenCalled();
    });

    it('clears pendingReviewWorkItemId when the prior WI has reached terminal status', async () => {
      pinNow('2026-04-28T10:00:00Z');
      const mission = makeMissionWithCadence({
        lastReviewAt: '2026-04-27T09:30:00.000Z',
        pendingReviewWorkItemId: 'm-cadence:review:2026-04-27',
      });
      (fs.readdir as any).mockResolvedValue(['m-cadence.json']);
      (fs.readFile as any).mockResolvedValue(JSON.stringify(mission));
      mockKRTrackingService.computeMissionOKRProgress.mockResolvedValue(defaultSummary());
      // Prior WI is verified — lock should clear and a new review fire.
      mockTaskPool.findWorkItem.mockResolvedValue({
        id: 'm-cadence:review:2026-04-27',
        status: 'verified',
      });

      const result = await service.runSweep();

      expect(result.reviewsCreated).toBe(1);
      const lastSaveCall = (atomicWriteJson as any).mock.calls.at(-1);
      const persistedMission = lastSaveCall[1];
      expect(persistedMission.pendingReviewWorkItemId).toBe('m-cadence:review:2026-04-28');
    });

    // V8 N1 regression guard (Arch BLOCKING on PR #354):
    // PENDING_REVIEW_TERMINAL_STATUSES must include every status a review
    // WorkItem can reach that represents "exited the active queue", otherwise
    // a single rejection / failure freezes the lock and silently skips all
    // future cadence ticks for that mission.
    it.each([
      ['done',      'done'],
      ['verified',  'verified'],
      ['cancelled', 'cancelled'],
      ['failed',    'failed'],
      ['rejected',  'rejected'], // ← N1: TL-rejected review WI must clear the lock
    ])('clears pendingReviewWorkItemId when prior WI status is %s', async (_label, priorStatus) => {
      pinNow('2026-04-28T10:00:00Z');
      const mission = makeMissionWithCadence({
        lastReviewAt: '2026-04-27T09:30:00.000Z',
        pendingReviewWorkItemId: 'm-cadence:review:2026-04-27',
      });
      (fs.readdir as any).mockResolvedValue(['m-cadence.json']);
      (fs.readFile as any).mockResolvedValue(JSON.stringify(mission));
      mockKRTrackingService.computeMissionOKRProgress.mockResolvedValue(defaultSummary());
      mockTaskPool.findWorkItem.mockResolvedValue({
        id: 'm-cadence:review:2026-04-27',
        status: priorStatus,
      });

      const result = await service.runSweep();

      expect(result.reviewsCreated).toBe(1);
      const lastSaveCall = (atomicWriteJson as any).mock.calls.at(-1);
      const persistedMission = lastSaveCall[1];
      expect(persistedMission.pendingReviewWorkItemId).toBe('m-cadence:review:2026-04-28');
    });

    it.each([
      ['CONSERVATIVE', '0 9 * * 1', '2026-04-27T10:00:00Z', '2026-04-27'], // Mon 09:00 UTC
      ['MODERATE',     '0 9 * * 1,4', '2026-04-23T10:00:00Z', '2026-04-23'], // Thu 09:00 UTC
      ['AUTONOMOUS',   '0 9 * * *', '2026-04-25T10:00:00Z', '2026-04-25'], // any day 09:00 UTC
    ])('cadence routing: %s → cycleId %s', async (_label, cron, nowIso, expectedCycle) => {
      pinNow(nowIso);
      const mission = makeMissionWithCadence({
        policy: {
          missionId: 'm-cadence',
          executionCadence: {
            reviewSchedule: cron,
            dailyItemLimit: 0,
            workHours: null,
            phaseGateApproval: 'none',
            requireVerificationGate: false,
          },
        },
      });
      (fs.readdir as any).mockResolvedValue(['m-cadence.json']);
      (fs.readFile as any).mockResolvedValue(JSON.stringify(mission));
      mockKRTrackingService.computeMissionOKRProgress.mockResolvedValue(defaultSummary());

      await service.runSweep();

      expect(mockTaskPool.addToPool).toHaveBeenCalledTimes(1);
      const wi = mockTaskPool.addToPool.mock.calls[0][0];
      expect(wi.id).toBe(`m-cadence:review:${expectedCycle}`);
      expect(wi.metadata.reviewCycleId).toBe(expectedCycle);
      expect(wi.metadata.cadenceSchedule).toBe(cron);
    });

    it.each([
      ['off_track_kr',     defaultSummary({ offTrack: 2 }), { activeProjectTaskIds: ['pt-1'] }],
      ['no_active_work',   defaultSummary(),                { activeProjectTaskIds: [] }],
      // NTH-1 (Arch on PR #354): positive test for `phase_complete`. Fires
      // when the mission's current phase has advanced past whatever the
      // previous review summary captured (`lastReviewSummary` does NOT
      // include `phase=<currentPhase>`). Must come BEFORE the
      // `scheduled_review` default, but AFTER off_track_kr / no_active_work
      // since those have higher precedence in `inferReviewReason`.
      [
        'phase_complete',
        defaultSummary(),
        {
          activeProjectTaskIds: ['pt-1'],
          currentPhase: 2,
          lastReviewSummary: 'phase=1, on track',
        },
      ],
      ['scheduled_review', defaultSummary(),                { activeProjectTaskIds: ['pt-1'] }],
    ])('reviewReason routing → %s', async (expectedReason, summary, missionOverrides) => {
      pinNow('2026-04-27T10:00:00Z');
      const mission = makeMissionWithCadence(missionOverrides);
      (fs.readdir as any).mockResolvedValue(['m-cadence.json']);
      (fs.readFile as any).mockResolvedValue(JSON.stringify(mission));
      mockKRTrackingService.computeMissionOKRProgress.mockResolvedValue(summary);

      await service.runSweep();

      const wi = mockTaskPool.addToPool.mock.calls[0][0];
      expect(wi.metadata.reviewReason).toBe(expectedReason);
    });

    it('does NOT create a review WorkItem when CREWLY_REVIEW_WI_ENABLED=false (config gate)', async () => {
      pinNow('2026-04-27T10:00:00Z');
      process.env['CREWLY_REVIEW_WI_ENABLED'] = 'false';
      const mission = makeMissionWithCadence();
      (fs.readdir as any).mockResolvedValue(['m-cadence.json']);
      (fs.readFile as any).mockResolvedValue(JSON.stringify(mission));
      mockKRTrackingService.computeMissionOKRProgress.mockResolvedValue(defaultSummary());

      const result = await service.runSweep();

      expect(result.reviewsCreated).toBe(0);
      expect(mockTaskPool.addToPool).not.toHaveBeenCalled();
      // Slack DM path is independent — must NOT be affected.
      // (off_track=0 in default summary, so it doesn't fire either way; the
      // assertion is the absence of pool calls.)
    });

    it('skips review WI creation when the mission has no executionCadence (legacy mission)', async () => {
      pinNow('2026-04-27T10:00:00Z');
      const mission = {
        id: 'm-legacy',
        objective: 'Legacy mission without policy.executionCadence',
        ownerTeamId: 't-1',
        successCriteria: [],
        currentStrategy: '',
        activeProjectTaskIds: [],
        cadence: '',
        status: 'active',
        createdAt: '2026-04-20T00:00:00.000Z',
        updatedAt: '2026-04-20T00:00:00.000Z',
        learnings: [],
        policy: {
          missionId: 'm-legacy',
          // executionCadence intentionally omitted
        },
      };
      (fs.readdir as any).mockResolvedValue(['m-legacy.json']);
      (fs.readFile as any).mockResolvedValue(JSON.stringify(mission));
      mockKRTrackingService.computeMissionOKRProgress.mockResolvedValue(defaultSummary());

      const result = await service.runSweep();

      expect(result.reviewsCreated).toBe(0);
      expect(result.reviewsSkipped).toBe(0);
      expect(mockTaskPool.addToPool).not.toHaveBeenCalled();
    });

    it('targets the team-lead session resolved via pickTeamLead', async () => {
      pinNow('2026-04-27T10:00:00Z');
      const mission = makeMissionWithCadence({ ownerId: undefined });
      (fs.readdir as any).mockResolvedValue(['m-cadence.json']);
      (fs.readFile as any).mockResolvedValue(JSON.stringify(mission));
      mockKRTrackingService.computeMissionOKRProgress.mockResolvedValue(defaultSummary());
      mockStorageService.getTeams.mockResolvedValue([
        {
          id: 't-1',
          name: 'Squad',
          members: [
            {
              id: 'm-tl',
              name: 'Lead Person',
              sessionName: 'crewly-tl-session',
              role: 'developer',
              canDelegate: true,
              hierarchyLevel: 1,
            },
            {
              id: 'm-w',
              name: 'Worker',
              sessionName: 'crewly-worker-session',
              role: 'developer',
              canDelegate: false,
              hierarchyLevel: 2,
            },
          ],
        },
      ]);

      await service.runSweep();

      const wi = mockTaskPool.addToPool.mock.calls[0][0];
      expect(wi.target).toBe('crewly-tl-session');
    });

    it('preserves the Slack DM path even when off_track > 0 (additive, not replacement)', async () => {
      pinNow('2026-04-27T10:00:00Z');
      const mission = makeMissionWithCadence();
      (fs.readdir as any).mockResolvedValue(['m-cadence.json']);
      (fs.readFile as any).mockResolvedValue(JSON.stringify(mission));
      mockKRTrackingService.computeMissionOKRProgress.mockResolvedValue(
        defaultSummary({ offTrack: 1 }),
      );
      mockStorageService.getMemberById.mockResolvedValue({ id: 'u1', name: 'Owner' });

      const result = await service.runSweep();

      // Both fire on the same sweep tick.
      expect(result.sent).toBe(1);
      expect(result.reviewsCreated).toBe(1);
      expect(mockSlackBridge.sendNotification).toHaveBeenCalled();
      expect(mockTaskPool.addToPool).toHaveBeenCalled();
    });

    // -------------------------------------------------------------------
    // Arch NTH-2 / NTH-3 / NTH-4 on PR #354 — efficiency + reliability
    // -------------------------------------------------------------------

    it('NTH-2: collapses lock-clear + new-WI persistence into a SINGLE saveMission per sweep tick', async () => {
      pinNow('2026-04-28T10:00:00Z'); // next cycle past lastReviewAt
      const mission = makeMissionWithCadence({
        // Reentrancy lock points at a WI that has already terminalized.
        pendingReviewWorkItemId: 'm-cadence:review:2026-04-27',
        lastReviewAt: '2026-04-27T09:00:00.000Z',
      });
      mockTaskPool.findWorkItem.mockResolvedValueOnce({
        id: 'm-cadence:review:2026-04-27',
        status: 'verified', // terminal — triggers lazy clear
      });
      (fs.readdir as any).mockResolvedValue(['m-cadence.json']);
      (fs.readFile as any).mockResolvedValue(JSON.stringify(mission));
      mockKRTrackingService.computeMissionOKRProgress.mockResolvedValue(defaultSummary());

      // Reset write-counter before the assertion window so the NTH-2 count
      // is isolated from any reads/writes in the runSweep setup phase.
      (atomicWriteJson as any).mockClear();

      const result = await service.runSweep();

      expect(result.reviewsCreated).toBe(1);
      // BEFORE NTH-2: 2 writes (clear + new id). AFTER: 1 write only.
      expect(atomicWriteJson).toHaveBeenCalledTimes(1);

      // Verify the single write carries BOTH the cleared lock-then-new-id
      // AND the bumped lastReviewAt — proving the collapse is correct
      // (we did not silently drop the lock-clear).
      const persistedMission = (atomicWriteJson as any).mock.calls[0][1];
      expect(persistedMission.pendingReviewWorkItemId).toBe('m-cadence:review:2026-04-28');
      expect(persistedMission.lastReviewAt).toBe('2026-04-28T10:00:00.000Z');
    });

    it('NTH-2: still persists the cleared lock when the NEW-WI path bails (skipped/noop)', async () => {
      // Same setup as above (terminal pendingReview, lock-clear path), but
      // pin now BEFORE the cadence boundary so the new-WI path returns
      // 'skipped' — the cleared lock must still be persisted.
      pinNow('2026-04-27T08:59:59Z'); // BEFORE today's 09:00 boundary
      const mission = makeMissionWithCadence({
        pendingReviewWorkItemId: 'm-cadence:review:2026-04-26',
        lastReviewAt: '2026-04-27T05:00:00.000Z', // covers the previous 09:00 boundary
      });
      mockTaskPool.findWorkItem.mockResolvedValueOnce({
        id: 'm-cadence:review:2026-04-26',
        status: 'verified',
      });
      (fs.readdir as any).mockResolvedValue(['m-cadence.json']);
      (fs.readFile as any).mockResolvedValue(JSON.stringify(mission));
      mockKRTrackingService.computeMissionOKRProgress.mockResolvedValue(defaultSummary());

      (atomicWriteJson as any).mockClear();

      await service.runSweep();

      // The exit-branch saveMission MUST fire so the cleared lock is durable.
      expect(atomicWriteJson).toHaveBeenCalledTimes(1);
      const persistedMission = (atomicWriteJson as any).mock.calls[0][1];
      expect(persistedMission.pendingReviewWorkItemId).toBeUndefined();
    });

    it('NTH-3: bumps cronParseFailureCount + warn-logs total on a malformed cron', async () => {
      pinNow('2026-04-27T10:00:00Z');
      const mission = makeMissionWithCadence({
        policy: {
          missionId: 'm-bad-cron',
          executionCadence: {
            reviewSchedule: 'this is not a cron expression',
            dailyItemLimit: 0,
            workHours: null,
            phaseGateApproval: 'none',
            requireVerificationGate: false,
          },
        },
      });
      (fs.readdir as any).mockResolvedValue(['m-cadence.json']);
      (fs.readFile as any).mockResolvedValue(JSON.stringify(mission));
      mockKRTrackingService.computeMissionOKRProgress.mockResolvedValue(defaultSummary());

      const startCount = service.cronParseFailureCount;

      const result = await service.runSweep();

      expect(result.reviewsCreated).toBe(0);
      expect(mockTaskPool.addToPool).not.toHaveBeenCalled();
      // The failure counter incremented by exactly 1.
      expect(service.cronParseFailureCount).toBe(startCount + 1);
    });

    it('NTH-3: cronParseFailureCount accumulates across multiple bad missions in one sweep', async () => {
      pinNow('2026-04-27T10:00:00Z');
      const startCount = service.cronParseFailureCount;
      const m1 = makeMissionWithCadence({
        id: 'm-bad-1',
        policy: {
          missionId: 'm-bad-1',
          executionCadence: {
            reviewSchedule: 'garbage-cron-1',
            dailyItemLimit: 0,
            workHours: null,
            phaseGateApproval: 'none',
            requireVerificationGate: false,
          },
        },
      });
      const m2 = makeMissionWithCadence({
        id: 'm-bad-2',
        policy: {
          missionId: 'm-bad-2',
          executionCadence: {
            reviewSchedule: 'garbage-cron-2',
            dailyItemLimit: 0,
            workHours: null,
            phaseGateApproval: 'none',
            requireVerificationGate: false,
          },
        },
      });
      (fs.readdir as any).mockResolvedValue(['m-bad-1.json', 'm-bad-2.json']);
      (fs.readFile as any).mockImplementation((p: string) => {
        if (p.includes('m-bad-1')) return Promise.resolve(JSON.stringify(m1));
        if (p.includes('m-bad-2')) return Promise.resolve(JSON.stringify(m2));
        return Promise.reject(new Error('File not found'));
      });
      mockKRTrackingService.computeMissionOKRProgress.mockResolvedValue(defaultSummary());

      await service.runSweep();

      // Both missions failed cron parse → counter += 2.
      expect(service.cronParseFailureCount).toBe(startCount + 2);
    });

    it('NTH-4: caches the TaskPoolService.getInstance() result for the service lifetime', async () => {
      pinNow('2026-04-27T10:00:00Z');
      const mission = makeMissionWithCadence();
      (fs.readdir as any).mockResolvedValue(['m-cadence.json']);
      (fs.readFile as any).mockResolvedValue(JSON.stringify(mission));
      mockKRTrackingService.computeMissionOKRProgress.mockResolvedValue(defaultSummary());

      // Reset the spy counter just before the runSweep so prior test
      // setup work (constructor calls etc.) does not leak into this
      // assertion. The service was constructed at line 74 in beforeEach.
      (TaskPoolService.getInstance as any).mockClear();

      // Run multiple sweeps in a row — same call-site path each time
      // (review WI creation + lock check + addToPool).
      await service.runSweep();
      await service.runSweep();
      await service.runSweep();

      // BEFORE NTH-4: TaskPoolService.getInstance() called per call site
      // per mission per sweep (~6 times across 3 sweeps × 2 sites).
      // AFTER NTH-4: cached in the private field after first access,
      // so AT MOST 1 call across the entire service lifetime.
      expect((TaskPoolService.getInstance as any).mock.calls.length).toBeLessThanOrEqual(1);
    });
  });
});
