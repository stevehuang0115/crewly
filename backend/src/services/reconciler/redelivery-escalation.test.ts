import { ORCHESTRATOR_SESSION_NAME, RECONCILER_WAKE_CONSTANTS } from '../../constants.js';
import type { Team } from '../../types/index.js';
import { buildRedeliveryEscalation, surfaceRedeliveryMiss } from './redelivery-escalation.js';

const NOW = new Date('2026-10-26T13:00:00.000Z');
const team = {
  id: 'team-ce',
  name: 'CE',
  members: [
    { id: 'm1', name: 'Owen', sessionName: 'ce-owen', role: 'tech-lead', hierarchyLevel: 1, canDelegate: true },
    { id: 'm2', name: 'Nova', sessionName: 'ce-nova', role: 'content-strategist', hierarchyLevel: 2, parentMemberId: 'm1' },
  ],
} as unknown as Team;
const miss = { workItemId: 'wi-282', session: 'ce-nova', attempts: 3, reason: 'over its daily token cap' };

describe('buildRedeliveryEscalation (CREW-577)', () => {
  it('is a review for the target\'s lead naming the item, the target and the reason', () => {
    const wi = buildRedeliveryEscalation(miss, 'CE-282 brief', team, NOW);
    expect(wi.target).toBe('ce-owen');
    expect(wi.type).toBe('review');
    expect(wi.id).toBe('wi-282:review:redelivery_miss');
    expect(wi.title).toContain('ce-nova');
    expect(wi.title).toContain('CE-282 brief');
    expect(wi.description).toContain('wi-282');
    expect(wi.description).toContain('3 redeliveries');
    expect(wi.description).toContain('over its daily token cap');
    expect(wi.metadata).toEqual(expect.objectContaining({ teamId: 'team-ce', sourceWorkItemId: 'wi-282', reviewReason: 'redelivery_miss' }));
  });

  it('goes to the orchestrator when the target leads its own team or has no team', () => {
    expect(buildRedeliveryEscalation({ ...miss, session: 'ce-owen' }, undefined, team, NOW).target).toBe(ORCHESTRATOR_SESSION_NAME);
    expect(buildRedeliveryEscalation(miss, undefined, null, NOW).target).toBe(ORCHESTRATOR_SESSION_NAME);
  });

  it('clips a long multi-line reason and tolerates a missing one', () => {
    const long = buildRedeliveryEscalation({ ...miss, reason: `a\nb ${'x'.repeat(500)}` }, undefined, team, NOW);
    const line = long.description!.split('\n')[0];
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(RECONCILER_WAKE_CONSTANTS.REDELIVERY_REASON_MAX_CHARS + 200);
    expect(buildRedeliveryEscalation({ ...miss, reason: undefined }, undefined, team, NOW).description).toContain('no reason given');
  });
});

describe('surfaceRedeliveryMiss', () => {
  it('queues the review on the lead, reading the title from the item', async () => {
    const addToPool = jest.fn().mockResolvedValue(undefined);
    const review = await surfaceRedeliveryMiss(miss, {
      loadTeams: async () => [team],
      addToPool,
      stamp: jest.fn(),
      now: () => NOW,
      findWorkItem: async () => ({ id: 'wi-282', title: 'CE-282 brief' }) as never,
    });
    expect(addToPool).toHaveBeenCalledTimes(1);
    expect(addToPool.mock.calls[0][0]).toBe(review);
    expect(review.target).toBe('ce-owen');
    expect(review.title).toContain('CE-282 brief');
  });

  it('still reports when teams or the item cannot be read', async () => {
    const addToPool = jest.fn().mockResolvedValue(undefined);
    const review = await surfaceRedeliveryMiss(miss, {
      loadTeams: async () => { throw new Error('no store'); },
      addToPool,
      stamp: jest.fn(),
      findWorkItem: async () => { throw new Error('no pool'); },
    });
    expect(review.target).toBe(ORCHESTRATOR_SESSION_NAME);
    expect(addToPool).toHaveBeenCalledTimes(1);
  });
});
