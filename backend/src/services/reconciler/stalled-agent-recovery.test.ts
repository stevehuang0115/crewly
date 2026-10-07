/**
 * Tests for stalled-agent detection (CREW-303).
 */

import { detectStalledAgents } from './stalled-agent-recovery.js';
import type { AgentHealth } from './reconcile-rules.js';
import { createWorkItem } from '../../types/v2/index.js';
import type { WorkItem } from '../../types/v2/index.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { markOwnerStopped, resetOwnerStoppedForTesting } from '../agent/owner-stopped.registry.js';

const MIN = 60_000;
const NOW = Date.parse('2026-10-06T13:40:00Z');
const OPTS = { now: NOW, queuedAgeMs: 20 * MIN, idleNoProgressMs: 20 * MIN };

function queued(target: string, ageMin: number, extra: Partial<WorkItem> = {}): WorkItem {
  return {
    ...createWorkItem({ type: 'delegate', owner: 'team_lead', title: `Work for ${target}`, target }),
    status: 'queued',
    createdAt: new Date(NOW - ageMin * MIN).toISOString(),
    ...extra,
  };
}

function health(sessionName: string, extra: Partial<AgentHealth> = {}): [string, AgentHealth] {
  return [sessionName, { sessionName, status: 'active', activeWorkItemCount: 0, ...extra }];
}

describe('detectStalledAgents', () => {
  it('flags a stopped agent whose queued work waited past the threshold (Owen, 2026-10-06)', () => {
    const items = [queued('ce-owen', 25), queued('ce-owen', 40), queued('ce-owen', 5)];
    const map = new Map([health('ce-owen', { status: 'inactive', role: 'team-leader', teamId: 't1', memberId: 'm1' })]);
    const [owen] = detectStalledAgents(items, map, OPTS);
    expect(owen).toMatchObject({ sessionName: 'ce-owen', kind: 'stopped', queuedCount: 2, role: 'team-leader', teamId: 't1', memberId: 'm1' });
    expect(owen.workItem.id).toBe(items[1].id); // the oldest
    expect(owen.queuedForMs).toBe(40 * MIN);
  });

  it('measures the wait from the last status change when there is one', () => {
    const wi = queued('ce-vera', 120, { statusChangedAt: new Date(NOW - 5 * MIN).toISOString() });
    expect(detectStalledAgents([wi], new Map([health('ce-vera', { status: 'inactive' })]), OPTS)).toHaveLength(0);
  });

  it('flags a suspended agent as stopped', () => {
    const out = detectStalledAgents([queued('a', 30)], new Map([health('a', { status: 'suspended' })]), OPTS);
    expect(out[0].kind).toBe('stopped');
  });

  it('flags an awake agent idle past the threshold, holding nothing', () => {
    const map = new Map([health('a', { lastActivityAt: new Date(NOW - 30 * MIN).toISOString() })]);
    expect(detectStalledAgents([queued('a', 30)], map, OPTS)[0].kind).toBe('idle');
  });

  it('flags a hung agent even with a claim and recent activity', () => {
    const map = new Map([health('a', { activeWorkItemCount: 1, lastActivityAt: new Date(NOW).toISOString() })]);
    const out = detectStalledAgents([queued('a', 30)], map, { ...OPTS, hungSessions: new Set(['a']) });
    expect(out[0].kind).toBe('hung');
  });

  it.each([
    ['recent work only', [queued('a', 10)], health('a', { status: 'inactive' })],
    ['still starting', [queued('a', 30)], health('a', { status: 'started' })],
    ['recently active', [queued('a', 30)], health('a', { lastActivityAt: new Date(NOW - 5 * MIN).toISOString() })],
    ['no recorded activity', [queued('a', 30)], health('a', {})],
    ['holding a claim', [queued('a', 30)], health('a', { activeWorkItemCount: 1, lastActivityAt: new Date(NOW - 30 * MIN).toISOString() })],
    ['mid-turn', [queued('a', 30)], health('a', { midTurn: true, lastActivityAt: new Date(NOW - 30 * MIN).toISOString() })],
    ['waiting on the owner', [queued('a', 30)], health('a', { waitingOnHumanSince: new Date(NOW - 30 * MIN).toISOString(), lastActivityAt: new Date(NOW - 30 * MIN).toISOString() })],
    ['work not queued', [queued('a', 30, { status: 'running' })], health('a', { status: 'inactive' })],
    ['housekeeping only', [queued('a', 30, { metadata: { housekeeping: true } })], health('a', { status: 'inactive' })],
    ['unknown agent', [queued('ghost', 30)], health('a', { status: 'inactive' })],
  ] as Array<[string, WorkItem[], [string, AgentHealth]]>)('leaves alone: %s', (_label, items, entry) => {
    expect(detectStalledAgents(items, new Map([entry]), OPTS)).toEqual([]);
  });

  it('never flags the orchestrator (it has its own heartbeat monitor)', () => {
    const map = new Map([health(ORCHESTRATOR_SESSION_NAME, { status: 'inactive' })]);
    expect(detectStalledAgents([queued(ORCHESTRATOR_SESSION_NAME, 60)], map, OPTS)).toEqual([]);
  });

  it('orders by the longest wait first', () => {
    const items = [queued('a', 25), queued('b', 90)];
    const map = new Map([health('a', { status: 'inactive' }), health('b', { status: 'inactive' })]);
    expect(detectStalledAgents(items, map, OPTS).map((s) => s.sessionName)).toEqual(['b', 'a']);
  });

  describe('work a stopped agent still holds (Nova, CE-206, 2026-10-07)', () => {
    const HELD_OPTS = { ...OPTS, heldStoppedMs: 10 * MIN };
    const held = (target: string, ageMin: number, extra: Partial<WorkItem> = {}): WorkItem =>
      queued(target, ageMin, { status: 'running', ...extra });
    const stoppedFor = (sessionName: string, minutes: number, extra: Partial<AgentHealth> = {}) =>
      health(sessionName, { status: 'inactive', lastSeenAt: new Date(NOW - minutes * MIN).toISOString(), ...extra });

    afterEach(() => resetOwnerStoppedForTesting());

    it('flags a stopped agent holding running work past the threshold', () => {
      const wi = held('ce-nova', 60);
      const [nova] = detectStalledAgents([wi], new Map([stoppedFor('ce-nova', 15, { teamId: 't1', memberId: 'm1' })]), HELD_OPTS);
      expect(nova).toMatchObject({ sessionName: 'ce-nova', kind: 'stopped', queuedCount: 0, heldCount: 1, teamId: 't1', memberId: 'm1' });
      expect(nova.workItem.id).toBe(wi.id);
    });

    it.each(['accepted', 'proposed'] as const)('flags %s work the same way', (status) => {
      expect(detectStalledAgents([held('a', 60, { status })], new Map([stoppedFor('a', 15)]), HELD_OPTS)).toHaveLength(1);
    });

    it('flags work blocked by the agent dropping out', () => {
      expect(detectStalledAgents([held('a', 60, { status: 'blocked' })], new Map([stoppedFor('a', 15)]), HELD_OPTS)[0].heldCount).toBe(1);
    });

    it('prefers the queued work as the one to start for, and counts both', () => {
      const q = queued('a', 30);
      const [a] = detectStalledAgents([held('a', 60), q], new Map([stoppedFor('a', 15)]), HELD_OPTS);
      expect(a).toMatchObject({ queuedCount: 1, heldCount: 1 });
      expect(a.workItem.id).toBe(q.id);
    });

    it.each([
      ['stopped only just now', [held('a', 60)], stoppedFor('a', 3)],
      ['work held only briefly', [held('a', 5)], stoppedFor('a', 30)],
      ['agent awake', [held('a', 60)], health('a', { lastActivityAt: new Date(NOW - 60 * MIN).toISOString() })],
      ['explicit block', [held('a', 60, { status: 'blocked', blockSource: 'explicit' })], stoppedFor('a', 30)],
      ['waiting on the owner', [held('a', 60, { status: 'blocked', blockSource: 'waiting_on_human' })], stoppedFor('a', 30)],
      ['done by the worker', [held('a', 60, { status: 'done_by_worker' })], stoppedFor('a', 30)],
    ] as Array<[string, WorkItem[], [string, AgentHealth]]>)('leaves alone: %s', (_label, items, entry) => {
      expect(detectStalledAgents(items, new Map([entry]), HELD_OPTS)).toEqual([]);
    });

    it('leaves alone a block that waits on an unfinished dependency', () => {
      const dep = queued('b', 1);
      const wi = held('a', 60, { status: 'blocked', dependsOn: [dep.id] });
      expect(detectStalledAgents([wi, dep], new Map([stoppedFor('a', 30)]), HELD_OPTS)).toEqual([]);
    });

    it('never restarts an agent someone stopped on purpose', () => {
      markOwnerStopped('a');
      expect(detectStalledAgents([held('a', 60), queued('a', 30)], new Map([stoppedFor('a', 30)]), HELD_OPTS)).toEqual([]);
    });

    it('ignores held work when no threshold is given', () => {
      expect(detectStalledAgents([held('a', 60)], new Map([stoppedFor('a', 30)]), OPTS)).toEqual([]);
    });
  });
});
