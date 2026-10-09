/**
 * Gathering the status snapshot's sources: teams → agents (state from the
 * member record) with their lead, tickets from every project, and a failing
 * source left empty instead of failing the snapshot.
 */

import type { Team } from '../../types/index.js';
import { collectSnapshotSources, type BriefingWiringDeps } from './drive-briefing.wiring.js';
import { buildBriefingSnapshot } from './drive-briefing-snapshot.js';

const NOW = new Date('2026-10-09T10:00:00.000Z');

function team(): Team {
  return {
    id: 't-ce',
    name: 'CE',
    projectIds: ['p1'],
    leaderIds: ['m-owen'],
    createdAt: '',
    updatedAt: '',
    members: [
      { id: 'm-owen', name: 'Owen', sessionName: 'owen-1', role: 'team-leader', agentStatus: 'active', workingStatus: 'in_progress' },
      { id: 'm-vera', name: 'Vera', sessionName: 'vera-1', role: 'developer', agentStatus: 'inactive', workingStatus: 'idle' },
    ],
  } as unknown as Team;
}

function deps(over: Partial<BriefingWiringDeps> = {}): BriefingWiringDeps {
  return {
    getTeams: async () => [team()],
    getProjects: async () => [{ name: 'ce-site', path: '/p/ce' }],
    listTickets: async () => [{ id: 'CE-1', title: 'Hero', status: 'in_progress', labels: [], assignee: 'owen-1', team: 't-ce', updatedAt: NOW.toISOString(), workItemId: null, log: [] }],
    listWorkItems: async () => [],
    waiting: async () => [],
    ownerFeed: () => ({ messages: [], ownerTurns: [] }),
    orchestratorRunning: () => true,
    orchestratorName: 'Crewly Orc',
    now: () => NOW,
    ...over,
  };
}

describe('collectSnapshotSources', () => {
  it('agents with their state, teams with their lead, tickets tagged with the project', async () => {
    const src = await collectSnapshotSources(deps());
    expect(src.agents).toEqual([
      { agentSession: 'crewly-orc', name: 'Crewly Orc', role: 'orchestrator', state: 'idle' },
      { agentSession: 'owen-1', name: 'Owen', team: 'CE', role: 'team-leader', state: 'working' },
      { agentSession: 'vera-1', name: 'Vera', team: 'CE', role: 'developer', state: 'stopped' },
    ]);
    expect(src.teams).toEqual([{ id: 't-ce', name: 'CE', lead: 'owen-1', members: ['owen-1', 'vera-1'] }]);
    expect(src.tickets[0]).toMatchObject({ id: 'CE-1', project: 'ce-site' });
    const snap = buildBriefingSnapshot(src);
    expect(snap.teams[0]).toMatchObject({ name: 'CE', lead: 'Owen', inProgress: 1 });
  });

  it('a failing source is left empty; the rest still comes through', async () => {
    const src = await collectSnapshotSources(
      deps({
        listTickets: async () => {
          throw new Error('disk');
        },
        listWorkItems: async () => {
          throw new Error('pool');
        },
        ownerFeed: () => {
          throw new Error('db');
        },
        orchestratorRunning: () => {
          throw new Error('pty');
        },
      }),
    );
    expect(src.tickets).toEqual([]);
    expect(src.workItems).toEqual([]);
    expect(src.ownerFeed).toEqual({ messages: [], ownerTurns: [] });
    expect(src.agents[0].state).toBe('stopped');
    expect(src.agents).toHaveLength(3);
  });
});

describe('SnapshotSourceCache', () => {
  it('re-reads a project\'s tickets only after its change event or the TTL; the pool after an event or its TTL', async () => {
    let clock = 0;
    const { SnapshotSourceCache } = await import('./drive-briefing.wiring.js');
    const cache = new SnapshotSourceCache(() => clock);
    const listTickets = jest.fn(async () => []);
    const listWorkItems = jest.fn(async () => []);
    const r = cache.wrap({ listTickets, listWorkItems });
    await r.listTickets('/p/a');
    await r.listTickets('/p/a');
    await r.listTickets('/p/b');
    expect(listTickets).toHaveBeenCalledTimes(2);
    cache.invalidateTickets('/p/a');
    await r.listTickets('/p/a');
    await r.listTickets('/p/b');
    expect(listTickets).toHaveBeenCalledTimes(3);
    clock += 5 * 60_000;
    await r.listTickets('/p/b');
    expect(listTickets).toHaveBeenCalledTimes(4);

    await r.listWorkItems();
    await r.listWorkItems();
    expect(listWorkItems).toHaveBeenCalledTimes(1);
    cache.invalidatePool();
    await r.listWorkItems();
    expect(listWorkItems).toHaveBeenCalledTimes(2);
    clock += 60_000;
    await r.listWorkItems();
    expect(listWorkItems).toHaveBeenCalledTimes(3);
  });
});
