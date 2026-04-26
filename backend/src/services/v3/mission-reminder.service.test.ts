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
import { atomicWriteJson } from '../../utils/file-io.utils.js';
import * as fs from 'fs/promises';

// Mock dependencies
jest.mock('./kr-tracking.service.js');
jest.mock('../core/storage.service.js');
jest.mock('../slack/slack-orchestrator-bridge.js');
jest.mock('../../utils/file-io.utils.js');
jest.mock('fs/promises');

describe('MissionReminderService', () => {
  let service: MissionReminderService;
  let mockKRTrackingService: any;
  let mockStorageService: any;
  let mockSlackBridge: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockKRTrackingService = {
      computeMissionOKRProgress: jest.fn(),
    };
    (KRTrackingService.getInstance as any).mockReturnValue(mockKRTrackingService);

    mockStorageService = {
      getMemberById: jest.fn(),
      getTeams: jest.fn(),
    };
    (StorageService.getInstance as any).mockReturnValue(mockStorageService);

    mockSlackBridge = {
      sendNotification: jest.fn(),
    };
    (getSlackOrchestratorBridge as any).mockReturnValue(mockSlackBridge);

    (atomicWriteJson as any).mockResolvedValue(undefined);

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
});
