import type { Team } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { selectAdhocMappings, identityOf, isOpenWorkItem, resetWorkItemForTarget, selectDecisions, selectPoolItems, selectScheduledMessages, targetsTeam } from './team-move-select.js';

const team = { id: 't1', name: 'CE', members: [{ id: 'm1', sessionName: 'ce-a' }, { id: 'm2', sessionName: 'ce-b' }] } as unknown as Team;
const id = identityOf(team);
const wi = (over: Partial<WorkItem>): WorkItem => ({ id: 'w', status: 'queued', title: 't', type: 'delegate', owner: 'team_lead', createdAt: 'x', retryCount: 0, maxRetries: 3, inputTokens: 0, outputTokens: 0, cost: 0, ...over }) as WorkItem;

describe('team-move-select', () => {
  it('matches targets by team id, name, session and member id', () => {
    for (const t of ['t1', 'CE', 'ce-a', 'm2']) expect(targetsTeam(t, id)).toBe(true);
    for (const t of ['other', '', undefined, 5]) expect(targetsTeam(t, id)).toBe(false);
  });

  it('treats finished, failed, rejected and cancelled items as not open', () => {
    for (const s of ['done', 'verified', 'cancelled', 'failed', 'rejected']) expect(isOpenWorkItem({ status: s as never })).toBe(false);
    for (const s of ['queued', 'running', 'blocked', 'proposed', 'escalated']) expect(isOpenWorkItem({ status: s as never })).toBe(true);
  });

  it('selects open items of the team, items a member holds, and their open children', () => {
    const pool = {
      workItems: [
        wi({ id: 'a', target: 'ce-a' }),
        wi({ id: 'b', target: 'ce-b', status: 'done' }),
        wi({ id: 'c', target: 'elsewhere' }),
        wi({ id: 'd' }), // untargeted, held by ce-b
        wi({ id: 'e', target: 'elsewhere', parentWorkItemId: 'a' }),
        wi({ id: 'f', target: 'elsewhere', parentWorkItemId: 'e', status: 'cancelled' }),
        wi({ id: 'g', target: 't1' }),
      ],
      claims: [{ id: 'cl', workItemId: 'd', agentId: 'ce-b', status: 'active' }, { id: 'cl2', workItemId: 'c', agentId: 'x', status: 'active' }],
    };
    const slice = selectPoolItems(pool as never, id);
    expect(slice.workItems.map((w) => w.id).sort()).toEqual(['a', 'd', 'e', 'g']);
    expect(slice.activeClaims).toBe(1);
    expect(selectPoolItems({}, id)).toEqual({ workItems: [], activeClaims: 0 });
  });

  it('puts running work back in the queue for the target', () => {
    const r = resetWorkItemForTarget(wi({ status: 'running', startedAt: 'now' }));
    expect(r.status).toBe('queued');
    expect(r.startedAt).toBeUndefined();
    expect(r.metadata).toEqual({ movedFromRunning: true });
    expect(resetWorkItemForTarget(wi({ status: 'blocked' })).status).toBe('blocked');
  });

  it('selects scheduled messages and pending decisions of the team', () => {
    expect(selectScheduledMessages([{ id: '1', targetTeam: 'CE' }, { id: '2', targetTeam: 'x' }] as never, id).map((m) => m.id)).toEqual(['1']);
    const ds = [
      { id: 'D1', status: 'open', teamId: 't1' },
      { id: 'D2', status: 'resolved', teamId: 't1' },
      { id: 'D3', status: 'parked', asker: 'ce-a' },
      { id: 'D4', status: 'open', requestedBy: 'ce-b' },
      { id: 'D5', status: 'open', teamId: 'other' },
    ];
    expect(selectDecisions(ds, id).map((d) => d.id)).toEqual(['D1', 'D3', 'D4']);
  });

  it('selects the Crewly channels the team is in, with only its own agents as members', () => {
    const mappings = [
      { teamId: 'adhoc:C1', slackChannelId: 'C1', chatChannelId: 'h1', members: ['ce-a', 'someone-else'], excluded: ['someone-else', 'ce-b'] },
      { teamId: 'adhoc:C2', slackChannelId: 'C2', chatChannelId: 'h2', members: ['someone-else'] },
      { teamId: 't1', slackChannelId: 'C3', chatChannelId: 'h3', members: ['ce-a'] },
    ];
    const picked = selectAdhocMappings(mappings, id);
    expect(picked.map((m) => m['chatChannelId'])).toEqual(['h1']);
    expect(picked[0]).toMatchObject({ members: ['ce-a'], excluded: ['ce-b'] });
    expect(selectAdhocMappings([{ teamId: 'adhoc:C9' }], id)).toEqual([]);
  });
});
