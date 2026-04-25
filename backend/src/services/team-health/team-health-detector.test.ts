/**
 * Tests for the THW pure detector — gates, verdicts, FP guards, cascade,
 * orphan, and lost-dispatch wiring.
 *
 * Coverage requirements (per §11.2 of the SEALED design):
 *   - Negative cases N1–N6 (§E.7) green.
 *   - Boundary tests at T1 − 1ms vs T1 + 1ms.
 *   - Detector coverage ≥ 90%.
 *
 * Fixture-based regression tests for Cases #1–#7 are added in a follow-up
 * commit (depends on `__test-fixtures__/*.json` being present).
 *
 * @module services/team-health/team-health-detector.test
 */

import {
  detectTeamHealth,
  detectOrphanRequests,
} from './team-health-detector.js';
import type {
  AgentWorkingStatus,
  TeamHealthSnapshot,
  TeamSummary,
} from './team-health-types.js';
import { DEFAULT_CONFIG } from './team-health-types.js';
import type { WorkItem, Request, Trigger } from '../../types/v2/index.js';
import type { AgentHealth } from '../reconciler/reconcile-rules.js';

const NOW = new Date('2026-04-25T19:30:00.000Z');
const BOOTED = new Date('2026-04-25T08:00:00.000Z'); // 11.5h before NOW

function makeTeam(id: string, members: string[], parent?: string): TeamSummary {
  return {
    id, name: id, memberSessions: members,
    slackThreadId: `T_${id}`, parentTeamId: parent,
  };
}

function snap(overrides: Partial<TeamHealthSnapshot>): TeamHealthSnapshot {
  return {
    now: NOW, bootedAt: BOOTED,
    teams: [makeTeam('t1', ['a1'])],
    agentHealth: new Map(),
    workItems: [], requests: [], triggers: [],
    ...overrides,
  };
}

function pendingWi(id: string, target: string, ageMs: number): WorkItem {
  return {
    id, type: 'delegate', owner: 'agent', target,
    title: id, status: 'queued',
    createdAt: new Date(NOW.getTime() - ageMs).toISOString(),
    retryCount: 0, maxRetries: 3, inputTokens: 0, outputTokens: 0, cost: 0,
  };
}

function idleAgent(session: string, idleMs: number): AgentHealth & { workingStatus?: AgentWorkingStatus } {
  return {
    sessionName: session, status: 'inactive', workingStatus: 'inactive',
    lastSeenAt: new Date(NOW.getTime() - idleMs).toISOString(),
  };
}

function activeAgent(session: string): AgentHealth & { workingStatus?: AgentWorkingStatus } {
  return {
    sessionName: session, status: 'active', workingStatus: 'in_progress',
    lastSeenAt: NOW.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Negative cases (§E.7 N1–N6)
// ---------------------------------------------------------------------------

describe('Negative cases — no false positives (§E.7)', () => {
  it('N1 — Big LLM thinking task (25 min) stays healthy', () => {
    const ah = new Map([['a1', {
      sessionName: 'a1', status: 'active' as const, workingStatus: 'in_progress' as const,
      lastSeenAt: new Date(NOW.getTime() - 25 * 60 * 1000).toISOString(),
    }]]);
    const det = detectTeamHealth(snap({ agentHealth: ah }), DEFAULT_CONFIG);
    expect(det[0].verdict).toBe('healthy');
  });

  it('N2 — Healthy off-hours (no pending work) stays healthy', () => {
    const ah = new Map([['a1', idleAgent('a1', 90 * 60 * 1000)]]);
    const det = detectTeamHealth(snap({ agentHealth: ah, workItems: [] }), DEFAULT_CONFIG);
    expect(det[0].verdict).toBe('healthy');
  });

  it('N3 — Boot grace (backend started 2 min ago) suppresses everything', () => {
    const ah = new Map([['a1', idleAgent('a1', 2 * 60 * 60 * 1000)]]);
    const det = detectTeamHealth(
      snap({
        agentHealth: ah,
        workItems: [pendingWi('w1', 'a1', 2 * 60 * 60 * 1000)],
        bootedAt: new Date(NOW.getTime() - 2 * 60 * 1000),
      }),
      DEFAULT_CONFIG,
    );
    expect(det[0].verdict).toBe('healthy');
    expect(det[0].rationale).toContain('Boot-grace');
  });

  it('N4 — Owner-paused via thinking override stays healthy', () => {
    const ah = new Map([['a1', idleAgent('a1', 90 * 60 * 1000)]]);
    const thinking = new Map([['a1', new Date(NOW.getTime() + 30 * 60 * 1000)]]);
    const det = detectTeamHealth(
      snap({
        agentHealth: ah,
        workItems: [pendingWi('w1', 'a1', 90 * 60 * 1000)],
        thinkingOverrides: thinking,
      }),
      DEFAULT_CONFIG,
    );
    expect(det[0].verdict).toBe('healthy');
  });

  it('N5 — Ramping team (some idle, others active) stays healthy', () => {
    const team = makeTeam('t1', ['a1', 'a2']);
    const ah = new Map([
      ['a1', idleAgent('a1', 90 * 60 * 1000)],
      ['a2', activeAgent('a2')],
    ]);
    const det = detectTeamHealth(
      {
        now: NOW, bootedAt: BOOTED, teams: [team], agentHealth: ah,
        workItems: [pendingWi('w1', 'a1', 90 * 60 * 1000)],
        requests: [], triggers: [],
      },
      DEFAULT_CONFIG,
    );
    expect(det[0].verdict).toBe('healthy');
  });

  it('N6 — In-flight decomposition (Request open 8 min) is NOT orphan', () => {
    const req: Request = {
      id: 'r1', sourceConversationItemId: 'c1', title: 'in-flight', description: '',
      status: 'open', priority: 'normal', requiresConfirmation: false, workItemIds: [],
      intentLevel: 'L1', intentCategory: 'research', tags: [],
      createdAt: new Date(NOW.getTime() - 8 * 60 * 1000).toISOString(),
      updatedAt: new Date(NOW.getTime() - 8 * 60 * 1000).toISOString(),
      totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0,
    };
    const out = detectOrphanRequests([req], [], NOW, DEFAULT_CONFIG.thresholds.ORPHAN_REQUEST_T1_MS);
    expect(out.systemTotal).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Boundary thresholds (§11.2)
// ---------------------------------------------------------------------------

describe('Boundary thresholds (T1 ± 1ms)', () => {
  function buildSnapshot(idleAgeMs: number, pendingAgeMs: number): TeamHealthSnapshot {
    const ah = new Map([['a1', idleAgent('a1', idleAgeMs)]]);
    return {
      now: NOW, bootedAt: BOOTED,
      teams: [makeTeam('t1', ['a1'])],
      agentHealth: ah,
      workItems: [pendingWi('w1', 'a1', pendingAgeMs)],
      requests: [], triggers: [],
    };
  }

  const T1 = DEFAULT_CONFIG.thresholds.TEAM_IDLE_T1_MS;
  const PT1 = DEFAULT_CONFIG.thresholds.PENDING_T1_MS;

  it('T1 - 1ms (idle) AND PT1 - 1ms (pending) ⇒ healthy', () => {
    const det = detectTeamHealth(buildSnapshot(T1 - 1, PT1 - 1), DEFAULT_CONFIG);
    expect(det[0].verdict).toBe('healthy');
  });

  it('T1 (exact) AND PT1 (exact) ⇒ stuck', () => {
    const det = detectTeamHealth(buildSnapshot(T1, PT1), DEFAULT_CONFIG);
    expect(det[0].verdict).toBe('stuck');
  });

  it('T1 + 1ms AND PT1 + 1ms ⇒ stuck', () => {
    const det = detectTeamHealth(buildSnapshot(T1 + 1, PT1 + 1), DEFAULT_CONFIG);
    expect(det[0].verdict).toBe('stuck');
  });
});

// ---------------------------------------------------------------------------
// Cascade detection
// ---------------------------------------------------------------------------

describe('Cascade detection (§B.2)', () => {
  it('two sibling teams both stuck ⇒ both go to cascade', () => {
    const teams: TeamSummary[] = [
      makeTeam('child-a', ['a1'], 'parent'),
      makeTeam('child-b', ['b1'], 'parent'),
    ];
    const ah = new Map([
      ['a1', idleAgent('a1', 90 * 60 * 1000)],
      ['b1', idleAgent('b1', 90 * 60 * 1000)],
    ]);
    const wis = [
      pendingWi('w1', 'a1', 90 * 60 * 1000),
      pendingWi('w2', 'b1', 90 * 60 * 1000),
    ];
    const det = detectTeamHealth(
      { now: NOW, bootedAt: BOOTED, teams, agentHealth: ah, workItems: wis, requests: [], triggers: [] },
      DEFAULT_CONFIG,
    );
    expect(det.find((d) => d.teamId === 'child-a')?.verdict).toBe('cascade');
    expect(det.find((d) => d.teamId === 'child-b')?.verdict).toBe('cascade');
    expect(det.find((d) => d.teamId === 'child-a')?.cascadeWith).toContain('child-b');
  });

  it('lone stuck team without sibling ⇒ stuck (NOT cascade)', () => {
    const teams: TeamSummary[] = [makeTeam('child-a', ['a1'], 'parent')];
    const ah = new Map([['a1', idleAgent('a1', 90 * 60 * 1000)]]);
    const det = detectTeamHealth(
      {
        now: NOW, bootedAt: BOOTED, teams, agentHealth: ah,
        workItems: [pendingWi('w1', 'a1', 90 * 60 * 1000)],
        requests: [], triggers: [],
      },
      DEFAULT_CONFIG,
    );
    expect(det[0].verdict).toBe('stuck');
  });
});

// ---------------------------------------------------------------------------
// Trigger-silence axis behavior
// ---------------------------------------------------------------------------

describe('team_silent axis', () => {
  function snapshotWith(triggers: Trigger[]): TeamHealthSnapshot {
    const ah = new Map([['a1', idleAgent('a1', 60 * 60 * 1000)]]);
    return {
      now: NOW, bootedAt: BOOTED,
      teams: [makeTeam('t1', ['a1'])],
      agentHealth: ah,
      workItems: [pendingWi('w1', 'a1', 60 * 60 * 1000)],
      requests: [], triggers,
    };
  }

  it('a recent member-owned trigger fire downgrades stuck → stalling', () => {
    const trig: Trigger = {
      id: 'tr1', type: 'time',
      config: { type: 'time', cronExpression: '*/5 * * * *' },
      action: { sendMessage: { target: 'a1', message: 'hi' } },
      status: 'active', createdBy: 'system',
      createdAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      lastFiredAt: new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(),
      fireCount: 1, maxIdleFires: 3, consecutiveIdleFires: 0, teamId: 't1',
    };
    const det = detectTeamHealth(snapshotWith([trig]), DEFAULT_CONFIG);
    expect(det[0].verdict).toBe('stalling');
  });

  it('no triggers configured ⇒ team_silent fires by default', () => {
    const det = detectTeamHealth(snapshotWith([]), DEFAULT_CONFIG);
    expect(det[0].gates.team_silent).toBe(true);
    expect(det[0].verdict).toBe('stuck');
  });
});

// ---------------------------------------------------------------------------
// Orphan-Request verdict mapping (§B.5)
// ---------------------------------------------------------------------------

describe('Orphan-Request verdict mapping', () => {
  function makeReq(id: string, ageMs: number): Request {
    return {
      id, sourceConversationItemId: 'c1', title: id, description: '',
      status: 'open', priority: 'normal', requiresConfirmation: false, workItemIds: [],
      intentLevel: 'L1', intentCategory: 'research', tags: [],
      createdAt: new Date(NOW.getTime() - ageMs).toISOString(),
      updatedAt: new Date(NOW.getTime() - ageMs).toISOString(),
      totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0,
      ownerAgent: 't1',
    };
  }

  it('1 orphan ⇒ stalling', () => {
    const det = detectTeamHealth(
      snap({
        teams: [makeTeam('t1', ['a1'])],
        agentHealth: new Map([['a1', activeAgent('a1')]]),
        requests: [makeReq('r1', 30 * 60 * 1000)],
      }),
      DEFAULT_CONFIG,
    );
    expect(det[0].verdict).toBe('stalling');
    expect(det[0].orphanRequestIds).toContain('r1');
  });

  it('3 system-wide orphans ⇒ cascade', () => {
    const det = detectTeamHealth(
      snap({
        teams: [makeTeam('t1', ['a1'])],
        agentHealth: new Map([['a1', activeAgent('a1')]]),
        requests: [
          makeReq('r1', 30 * 60 * 1000),
          makeReq('r2', 30 * 60 * 1000),
          makeReq('r3', 30 * 60 * 1000),
        ],
      }),
      DEFAULT_CONFIG,
    );
    expect(det[0].verdict).toBe('cascade');
  });
});

// ---------------------------------------------------------------------------
// Lost-dispatch wiring (§B.6 amendment)
// ---------------------------------------------------------------------------

describe('Lost-dispatch wiring (post-SEALED amendment)', () => {
  it('lost dispatch on otherwise healthy team ⇒ stalling + lostDispatchWorkItemIds', () => {
    const lostWi: WorkItem = {
      id: 'w-lost', type: 'delegate', owner: 'agent', target: 'a1',
      title: 'lost', status: 'proposed',
      createdAt: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(),
      retryCount: 0, maxRetries: 3, inputTokens: 0, outputTokens: 0, cost: 0,
    };
    const ah = new Map([['a1', activeAgent('a1')]]);
    const det = detectTeamHealth(
      snap({ workItems: [lostWi], agentHealth: ah }),
      DEFAULT_CONFIG,
    );
    expect(det[0].verdict).toBe('stalling');
    expect(det[0].lostDispatchWorkItemIds).toContain('w-lost');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('empty teams array ⇒ empty detections', () => {
    const det = detectTeamHealth(
      {
        now: new Date(), bootedAt: new Date(0),
        teams: [], agentHealth: new Map(),
        workItems: [], requests: [], triggers: [],
      },
      DEFAULT_CONFIG,
    );
    expect(det).toEqual([]);
  });

  it('zero-member team is not idle (returns healthy)', () => {
    const det = detectTeamHealth(
      {
        now: NOW, bootedAt: BOOTED,
        teams: [{ id: 't', name: 't', memberSessions: [] }],
        agentHealth: new Map(),
        workItems: [], requests: [], triggers: [],
      },
      DEFAULT_CONFIG,
    );
    expect(det[0].verdict).toBe('healthy');
  });
});
