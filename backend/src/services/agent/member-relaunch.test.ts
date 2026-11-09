/**
 * Tests for member-relaunch — the shared stop / start path of a planned
 * relaunch (runtime fallback, model tiers).
 */

const workingStatus = jest.fn<string | undefined, [string]>();
const hasActivity = jest.fn<boolean, [string]>();
const idleMs = jest.fn<number, [string]>();
const clearSession = jest.fn();
const clearHungState = jest.fn();

jest.mock('../monitoring/activity-monitor.service.js', () => ({
  ActivityMonitorService: { getInstance: () => ({ getObservedWorkingStatus: workingStatus }) },
}));
jest.mock('./pty-activity-tracker.service.js', () => ({
  PtyActivityTrackerService: { getInstance: () => ({ hasActivity, getIdleTimeMs: idleMs, clearSession }) },
}));
jest.mock('../task-pool/task-pool.service.js', () => ({
  TaskPoolService: { getInstance: () => ({ clearHungState }) },
}));

import { isAgentBusy, startMemberSession, stopForRelaunch } from './member-relaunch.js';

describe('member-relaunch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    workingStatus.mockReturnValue('idle');
    hasActivity.mockReturnValue(true);
    idleMs.mockReturnValue(60_000);
  });

  describe('isAgentBusy', () => {
    it('is busy while the observed status is in_progress', async () => {
      workingStatus.mockReturnValue('in_progress');
      await expect(isAgentBusy('s', 20_000)).resolves.toBe(true);
    });

    it('is busy when the PTY printed within the quiet time, idle after it', async () => {
      idleMs.mockReturnValue(5_000);
      await expect(isAgentBusy('s', 20_000)).resolves.toBe(true);
      idleMs.mockReturnValue(25_000);
      await expect(isAgentBusy('s', 20_000)).resolves.toBe(false);
    });

    it('is idle with no PTY activity recorded, and busy when the check fails', async () => {
      hasActivity.mockReturnValue(false);
      await expect(isAgentBusy('s', 20_000)).resolves.toBe(false);
      workingStatus.mockImplementation(() => {
        throw new Error('not ready');
      });
      await expect(isAgentBusy('s', 20_000)).resolves.toBe(true);
    });
  });

  it('stopForRelaunch stops the session and forgets its activity and hung state', async () => {
    const stop = jest.fn(async () => true);
    await expect(stopForRelaunch({ stopSessionForRelaunch: stop }, 'mkt-ella')).resolves.toBe(true);
    expect(stop).toHaveBeenCalledWith('mkt-ella');
    expect(clearSession).toHaveBeenCalledWith('mkt-ella');
    expect(clearHungState).toHaveBeenCalledWith('mkt-ella');
  });

  describe('startMemberSession', () => {
    const storage = {
      getTeams: async () => [
        { id: 't1', projectIds: ['p1'], members: [{ id: 'm-ella', role: 'developer', sessionName: 'mkt-ella' }] },
        { id: 't2', projectIds: [], members: [{ id: 'm-sam', role: 'writer', sessionName: 'mkt-sam' }] },
      ],
      getProjects: async () => [{ id: 'p1', path: '/work/p1' }],
    };

    it('starts the member in its team project', async () => {
      const create = jest.fn(async () => ({ success: true }));
      await expect(startMemberSession({ storage }, { createAgentSession: create }, 'mkt-ella')).resolves.toBe(true);
      expect(create).toHaveBeenCalledWith({ sessionName: 'mkt-ella', role: 'developer', projectPath: '/work/p1', memberId: 'm-ella', teamId: 't1' });
    });

    it('falls back to the last working directory, and reports a failed start', async () => {
      const create = jest.fn(async () => ({ success: false, error: 'boom' }));
      const warn = jest.fn();
      await expect(startMemberSession({ storage, cwdOf: async () => '/cwd', logger: { warn } }, { createAgentSession: create }, 'mkt-sam')).resolves.toBe(false);
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ projectPath: '/cwd', teamId: 't2' }));
      expect(warn).toHaveBeenCalled();
    });

    it('does nothing for an unknown session', async () => {
      const create = jest.fn(async () => ({ success: true }));
      await expect(startMemberSession({ storage }, { createAgentSession: create }, 'nobody')).resolves.toBe(false);
      expect(create).not.toHaveBeenCalled();
    });
  });
});
