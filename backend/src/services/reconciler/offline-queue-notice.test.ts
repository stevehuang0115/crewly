import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import type { Team } from '../../types/index.js';
import { buildOfflineQueueNotice, surfaceOfflineQueue } from './offline-queue-notice.js';

const NOW = new Date('2026-10-25T04:00:00.000Z');
const team = {
  id: 'team-ce',
  name: 'CE',
  members: [
    { id: 'm1', name: 'Owen', sessionName: 'ce-owen', role: 'tech-lead', hierarchyLevel: 1, canDelegate: true },
    { id: 'm2', name: 'Nova', sessionName: 'ce-nova', role: 'content-strategist', hierarchyLevel: 2, parentMemberId: 'm1' },
  ],
} as unknown as Team;
const q = { session: 'ce-nova', workItemId: 'wi-9', queuedCount: 2, queuedForMs: 15 * 3_600_000, offlineMinutes: 90 };

describe('buildOfflineQueueNotice (CREW-862)', () => {
  it('is a review for the lead naming the agent, count, waits and outage', () => {
    const wi = buildOfflineQueueNotice(q, 'verify brief', team, NOW);
    expect(wi.target).toBe('ce-owen');
    expect(wi.type).toBe('review');
    expect(wi.id).toBe('wi-9:review:offline_queue');
    expect(wi.title).toContain('ce-nova');
    expect(wi.title).toContain('verify brief');
    expect(wi.description).toContain('2 queued');
    expect(wi.description).toContain('15.0 h');
    expect(wi.description).toContain('1.5 h');
    expect(wi.metadata).toEqual(expect.objectContaining({ sourceWorkItemId: 'wi-9', reviewReason: 'offline_queue', teamId: 'team-ce' }));
  });

  it('goes to the orchestrator when the agent leads its team or has none; omits an unknown outage', () => {
    expect(buildOfflineQueueNotice({ ...q, session: 'ce-owen' }, undefined, team, NOW).target).toBe(ORCHESTRATOR_SESSION_NAME);
    const none = buildOfflineQueueNotice({ ...q, offlineMinutes: undefined }, undefined, null, NOW);
    expect(none.target).toBe(ORCHESTRATOR_SESSION_NAME);
    expect(none.description).not.toContain('offline for');
  });
});

describe('surfaceOfflineQueue', () => {
  it('queues the notice on the lead, reading the title from the item', async () => {
    const addToPool = jest.fn().mockResolvedValue(undefined);
    const review = await surfaceOfflineQueue(q, {
      loadTeams: async () => [team], addToPool, stamp: jest.fn(), now: () => NOW,
      findWorkItem: async () => ({ id: 'wi-9', title: 'verify brief' }) as never,
    });
    expect(addToPool).toHaveBeenCalledWith(review);
    expect(review.title).toContain('verify brief');
  });

  it('still reports when teams or the item cannot be read', async () => {
    const addToPool = jest.fn().mockResolvedValue(undefined);
    const review = await surfaceOfflineQueue(q, {
      loadTeams: async () => { throw new Error('x'); }, addToPool, stamp: jest.fn(),
      findWorkItem: async () => { throw new Error('y'); },
    });
    expect(review.target).toBe(ORCHESTRATOR_SESSION_NAME);
  });
});
