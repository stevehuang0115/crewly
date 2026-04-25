/**
 * Tests for LiveTeamHealthDataProvider — adapter from existing services
 * to the THW snapshot shape.
 *
 * @module services/team-health/live-team-health-data-provider.test
 */

import { LiveTeamHealthDataProvider } from './live-team-health-data-provider.js';
import type { ReconcilerDataProvider } from '../reconciler/reconciler.service.js';
import type { AgentHealth } from '../reconciler/reconcile-rules.js';
import type { Team } from '../../types/index.js';
import type { WorkItem, Request, Trigger, ReconcileCorrection, WakeAction, TaskClaim } from '../../types/v2/index.js';

const NOW = new Date('2026-04-25T19:30:00.000Z');
const BOOTED = new Date('2026-04-25T08:00:00.000Z');

function fakeReconcilerProvider(opts: {
  workItems?: WorkItem[];
  requests?: Request[];
  claims?: TaskClaim[];
  agentHealth?: Map<string, AgentHealth>;
} = {}): ReconcilerDataProvider {
  return {
    getActiveWorkItems: async () => opts.workItems ?? [],
    getActiveRequests: async () => opts.requests ?? [],
    getActiveClaims: async () => opts.claims ?? [],
    getWorkItemsForRequest: async () => [],
    getAgentHealthMap: async () => opts.agentHealth ?? new Map<string, AgentHealth>(),
    applyCorrection: async (_c: ReconcileCorrection) => {},
    releaseToPool: async () => {},
    requeueWorkItem: async () => {},
    markClaimExpiring: async () => {},
    revokeClaimAndRelease: async () => {},
    executeWakeAction: async (_a: WakeAction) => false,
  };
}

function fakeTeam(id: string, members: string[]): Team {
  return {
    id, name: id, description: '',
    members: members.map((session, i) => ({
      id: `${id}-m${i}`, name: session, sessionName: session,
      role: (i === 0 ? 'team-leader' : 'member') as never,
      systemPrompt: '',
      agentStatus: 'active' as const,
      workingStatus: 'in_progress' as const,
      runtimeType: 'claude-code' as const,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })),
    projectIds: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    leaderIds: [`${id}-m0`],
  };
}

describe('LiveTeamHealthDataProvider', () => {
  it('returns a snapshot with teams projected to TeamSummary', async () => {
    const teams = [fakeTeam('marketing', ['ella', 'grace'])];
    const provider = new LiveTeamHealthDataProvider({
      reconcilerProvider: fakeReconcilerProvider(),
      getTeams: async () => teams,
      bootedAt: BOOTED,
    });
    const snapshot = await provider.collectSnapshot(NOW);
    expect(snapshot.teams).toHaveLength(1);
    expect(snapshot.teams[0].id).toBe('marketing');
    expect(snapshot.teams[0].memberSessions).toEqual(['ella', 'grace']);
    expect(snapshot.teams[0].tlSession).toBe('ella');
  });

  it('filters out archived teams', async () => {
    const teams = [
      fakeTeam('alive', ['a1']),
      { ...fakeTeam('archived', ['a2']), archived: true },
    ];
    const provider = new LiveTeamHealthDataProvider({
      reconcilerProvider: fakeReconcilerProvider(),
      getTeams: async () => teams,
      bootedAt: BOOTED,
    });
    const snapshot = await provider.collectSnapshot(NOW);
    expect(snapshot.teams.map((t) => t.id)).toEqual(['alive']);
  });

  it('enriches agent health with workingStatus from team config', async () => {
    const team = fakeTeam('t1', ['a1']);
    team.members[0].workingStatus = 'in_progress';
    const baseHealth = new Map<string, AgentHealth>([
      ['a1', { sessionName: 'a1', status: 'active', lastSeenAt: NOW.toISOString() }],
    ]);
    const provider = new LiveTeamHealthDataProvider({
      reconcilerProvider: fakeReconcilerProvider({ agentHealth: baseHealth }),
      getTeams: async () => [team],
      bootedAt: BOOTED,
    });
    const snapshot = await provider.collectSnapshot(NOW);
    const enriched = snapshot.agentHealth.get('a1');
    expect(enriched?.workingStatus).toBe('in_progress');
  });

  it('surfaces team members with NO base health entry as inactive (synthetic — see docstring)', async () => {
    // Regression contract for Arch's §A.1 invariant audit on PR #326:
    // when a team member is in the team config but missing from the
    // reconciler's authoritative agent-health map, this provider
    // FABRICATES a synthetic entry with status='inactive' so the
    // team_idle gate is computable. The fabrication is THW-LOCAL —
    // see enrichAgentHealth() docstring in the source file. Callers
    // must NOT feed this map back into ReconcilerService.
    const team = fakeTeam('t1', ['a1']);
    team.members[0].agentStatus = 'inactive';
    const provider = new LiveTeamHealthDataProvider({
      reconcilerProvider: fakeReconcilerProvider({ agentHealth: new Map() }),
      getTeams: async () => [team],
      bootedAt: BOOTED,
    });
    const snapshot = await provider.collectSnapshot(NOW);
    const a1 = snapshot.agentHealth.get('a1');
    expect(a1).toBeDefined();
    expect(a1?.workingStatus).toBe('inactive');
    // Sanity-check the synthetic entry has status='inactive' (the
    // synthetic field). If a future change accidentally treats
    // missing-from-base as authoritative, this assertion fires.
    expect(a1?.status).toBe('inactive');
  });

  it('passes triggers through when getTriggers is provided', async () => {
    const trigger: Trigger = {
      id: 'tr1', type: 'time',
      config: { type: 'time' as const },
      action: { runReconciler: true }, status: 'active', createdBy: 'system',
      createdAt: NOW.toISOString(), fireCount: 0, maxIdleFires: 3, consecutiveIdleFires: 0,
    };
    const provider = new LiveTeamHealthDataProvider({
      reconcilerProvider: fakeReconcilerProvider(),
      getTeams: async () => [],
      getTriggers: async () => [trigger],
      bootedAt: BOOTED,
    });
    const snapshot = await provider.collectSnapshot(NOW);
    expect(snapshot.triggers).toHaveLength(1);
    expect(snapshot.triggers[0].id).toBe('tr1');
  });

  it('degrades to empty arrays when accessors throw', async () => {
    const provider = new LiveTeamHealthDataProvider({
      reconcilerProvider: {
        ...fakeReconcilerProvider(),
        getActiveWorkItems: async () => { throw new Error('boom'); },
      },
      getTeams: async () => { throw new Error('boom'); },
      bootedAt: BOOTED,
    });
    const snapshot = await provider.collectSnapshot(NOW);
    expect(snapshot.workItems).toEqual([]);
    expect(snapshot.teams).toEqual([]);
  });
});
