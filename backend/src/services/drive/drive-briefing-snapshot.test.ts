/**
 * Drive mode status snapshot: derived from tickets, work items, live owner
 * items and the agents' messages to the owner — states, activity, counts,
 * order of attention, de-duplication of ticket-linked work, secrets and URLs
 * out, the size cap.
 */

import { agentStateOf, buildBriefingSnapshot, collapseReviews, capSnapshot, logMessage, safeText, ticketStatus, waitingRef, workItemStatus, type SnapshotSources } from './drive-briefing-snapshot.js';
import type { BriefingSnapshot } from './drive-briefing.contract.js';

const NOW = new Date('2026-10-09T10:00:00.000Z');
const ago = (min: number): string => new Date(NOW.getTime() - min * 60_000).toISOString();

function sources(over: Partial<SnapshotSources> = {}): SnapshotSources {
  return {
    now: NOW,
    agents: [
      { agentSession: 'crewly-orc', name: 'Crewly Orc', role: 'orchestrator', state: 'idle' },
      { agentSession: 'owen-1', name: 'Owen', team: 'CE', role: 'team-leader', state: 'working' },
      { agentSession: 'vera-1', name: 'Vera', team: 'CE', role: 'developer', state: 'idle' },
      { agentSession: 'ella-1', name: 'Ella', team: 'Marketing', role: 'marketer', state: 'stopped' },
    ],
    teams: [
      { id: 't-ce', name: 'CE', lead: 'owen-1', members: ['owen-1', 'vera-1'] },
      { id: 't-mk', name: 'Marketing', lead: 'ella-1', members: ['ella-1'] },
    ],
    tickets: [
      { project: 'ce-site', id: 'CE-12', title: 'Description page', status: 'review', labels: [], assignee: 'vera-1', team: 't-ce', updatedAt: ago(10), workItemId: 'wi-aaaa1111', log: [`${ago(10)} · vera-1 · Submitted for review, see https://preview.example/x`] },
      { project: 'ce-site', id: 'CE-14', title: 'Pricing page copy', status: 'in_progress', labels: [], assignee: 'owen-1', team: 't-ce', updatedAt: ago(30), workItemId: null, log: [] },
      { project: 'ce-site', id: 'CE-15', title: 'Checkout bug', status: 'ready', labels: ['blocked'], assignee: 'vera-1', team: null, updatedAt: ago(60), workItemId: null, log: [] },
      { project: 'ce-site', id: 'CE-9', title: 'Old banner', status: 'done', labels: [], assignee: 'vera-1', team: 't-ce', updatedAt: ago(3 * 24 * 60), workItemId: null, log: [] },
    ],
    workItems: [
      // Linked to CE-12: not listed twice.
      { id: 'wi-aaaa1111', title: 'Build description page', status: 'done_by_worker', target: 'vera-1', createdAt: ago(120), statusChangedAt: ago(5), output: { summary: 'Page built; 3 screenshots attached.' } },
      { id: 'wi-bbbb2222', title: 'Render video v3', status: 'running', target: 'ella-1', createdAt: ago(50), startedAt: ago(45) },
      { id: 'wi-cccc3333', title: 'Old cleanup', status: 'done', target: 'ella-1', createdAt: ago(5000), completedAt: ago(4000) },
    ],
    waiting: [
      { id: 'd:D-7', kind: 'decision', agentSession: 'ella-1', agentName: 'Ella', summary: 'Ella asks which video cut to publish (key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789)', since: ago(20), urgency: 'normal', answerTarget: { kind: 'decision', decisionId: 'D-7' } },
    ],
    ownerFeed: {
      messages: [
        { id: 'm1', channelId: 'dm-ella', channelType: 'dm', channelName: 'Ella', senderType: 'agent', senderId: 'ella-1', senderKind: 'agent', agentSession: 'ella-1', content: 'Video v3 is **ready** — https://drive.example/v3', createdAt: NOW.getTime() - 15 * 60_000 },
        { id: 'm2', channelId: 'dm-ella', channelType: 'dm', channelName: 'Ella', senderType: 'agent', senderId: 'ella-1', senderKind: 'agent', agentSession: 'ella-1', content: 'Starting v3 render.', createdAt: NOW.getTime() - 50 * 60_000 },
        { id: 'm3', channelId: 'dm-owen', channelType: 'dm', channelName: 'Owen', senderType: 'user', senderId: 'owner', senderKind: 'owner', agentSession: 'owen-1', content: 'ok', createdAt: NOW.getTime() - 5 * 60_000 },
      ],
      ownerTurns: [],
    },
    ...over,
  };
}

describe('mapping helpers', () => {
  it('agent states, ticket and work item statuses, log lines, waiting refs', () => {
    expect(agentStateOf('active', 'in_progress')).toBe('working');
    expect(agentStateOf('active', 'idle')).toBe('idle');
    expect(agentStateOf('starting', 'idle')).toBe('starting');
    expect(agentStateOf('inactive', 'idle')).toBe('stopped');
    expect(ticketStatus('ready', ['Blocked'])).toBe('blocked');
    expect(ticketStatus('backlog', [])).toBe('open');
    expect(workItemStatus('done_by_worker')).toBe('review');
    expect(workItemStatus('failed')).toBe('blocked');
    expect(workItemStatus('verified')).toBe('done');
    expect(logMessage('2026-10-09T09:00:00Z · vera-1 · Sent it')).toBe('Sent it');
    expect(waitingRef({ id: 'q:req-1:abcdef99', kind: 'question', answerTarget: { kind: 'thread' } })).toBe('Q-abcdef');
    expect(waitingRef({ id: 't:req-2', kind: 'review', answerTarget: { kind: 'ticket', tkt: 'TKT-5' } })).toBe('TKT-5');
  });

  it('safeText: no URLs, no secrets, clipped', () => {
    expect(safeText('see https://x.y/z now', 100)).toBe('see now');
    expect(safeText('token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 here', 100)).not.toContain('abcdefghijklmnop');
    expect(safeText('a '.repeat(200), 50).length).toBeLessThanOrEqual(50);
  });
});

describe('buildBriefingSnapshot', () => {
  it('teams with lead, members and counts; agents with state, activity and last messages; items in order of attention', () => {
    const s = buildBriefingSnapshot(sources());
    expect(s).toMatchObject({ v: 1, generatedAt: NOW.toISOString() });
    expect(s.teams).toEqual([
      { name: 'CE', lead: 'Owen', agents: ['Owen', 'Vera'], open: 0, inProgress: 1, review: 1, blocked: 1, doneToday: 0 },
      { name: 'Marketing', lead: 'Ella', agents: ['Ella'], open: 0, inProgress: 1, review: 0, blocked: 0, doneToday: 0 },
    ]);
    // Ticket-linked work is not listed twice; old done work is left out.
    expect(s.items.map((i) => i.ref)).toEqual(['CE-12', 'CE-15', 'CE-14', 'wi:wi-bbbb2']);
    // The ticket shows its work item's newer summary.
    expect(s.items[0]).toMatchObject({ status: 'review', assignee: 'Vera', team: 'CE', project: 'ce-site', last: 'Page built; 3 screenshots attached.' });
    expect(s.items[1]).toMatchObject({ ref: 'CE-15', status: 'blocked', team: 'CE' });
    const owen = s.agents.find((a) => a.name === 'Owen');
    expect(owen).toMatchObject({ state: 'working', activity: { title: 'Pricing page copy', ref: 'CE-14', since: ago(30) } });
    const ella = s.agents.find((a) => a.name === 'Ella');
    expect(ella?.activity).toEqual({ title: 'Render video v3', since: ago(45), ref: 'wi:wi-bbbb2' });
    expect(ella?.lastToOwner).toEqual([
      { at: ago(15), text: 'Video v3 is ready —' },
      { at: ago(50), text: 'Starting v3 render.' },
    ]);
    // The owner's own words are never an agent's message.
    expect(owen?.lastToOwner).toBeUndefined();
    expect(s.waiting).toEqual([{ ref: 'D-7', kind: 'decision', from: 'Ella', team: 'Marketing', summary: expect.stringContaining('Ella asks which video cut to publish'), since: ago(20), urgency: 'normal' }]);
  });

  it('carries no URLs or secrets anywhere', () => {
    const json = JSON.stringify(buildBriefingSnapshot(sources()));
    expect(json).not.toMatch(/https?:\/\//);
    expect(json).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('stays under the size cap on a busy machine', () => {
    const many = sources({
      tickets: Array.from({ length: 400 }, (_, i) => ({ project: 'p', id: `CE-${i}`, title: `Ticket number ${i} `.repeat(8), status: i % 3 ? 'in_progress' : 'done', labels: [], assignee: 'vera-1', team: 't-ce', updatedAt: ago(i), workItemId: null, log: [`${ago(i)} · vera-1 · ${'progress note '.repeat(30)}`] })),
    });
    const s = buildBriefingSnapshot(many);
    expect(Buffer.byteLength(JSON.stringify(s))).toBeLessThanOrEqual(48 * 1024);
    expect(s.items.length).toBeLessThanOrEqual(80);
  });
});

describe('capSnapshot', () => {
  it('drops finished work first, then older messages, then the least urgent items', () => {
    const s: BriefingSnapshot = {
      v: 1,
      generatedAt: NOW.toISOString(),
      teams: [],
      agents: [{ session: 'a', name: 'A', state: 'idle', lastToOwner: [{ at: ago(1), text: 'x'.repeat(200) }, { at: ago(2), text: 'y'.repeat(200) }] }],
      items: [
        { ref: 'R-1', kind: 'ticket', title: 't'.repeat(100), status: 'review', updatedAt: ago(1) },
        { ref: 'D-1', kind: 'ticket', title: 'd'.repeat(100), status: 'done', updatedAt: ago(1) },
      ],
      waiting: [],
    };
    const full = Buffer.byteLength(JSON.stringify(s));
    const out = capSnapshot(s, full - 50);
    expect(out.items.map((i) => i.ref)).toEqual(['R-1']);
    const tighter = capSnapshot(s, full - 250);
    expect(tighter.agents[0].lastToOwner).toHaveLength(1);
  });
});

describe('ticket freshness', () => {
  const day = (n: number): string => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
  const ticket = (over: Partial<SnapshotSources['tickets'][number]>): SnapshotSources['tickets'][number] => ({
    project: 'ce-site',
    id: 'CE-1',
    title: 'A ticket',
    status: 'in_progress',
    labels: [],
    assignee: 'vera-1',
    team: 't-ce',
    updatedAt: day(0),
    workItemId: null,
    log: [],
    ...over,
  });
  const itemOf = (tickets: SnapshotSources['tickets'], ref: string) => buildBriefingSnapshot(sources({ tickets, workItems: [] })).items.find((i) => i.ref === ref)!;

  it('gives every ticket its last-activity date and idle days', () => {
    const i = itemOf([ticket({ id: 'CE-1', updatedAt: day(1), log: [`${day(1)} · vera-1 · wrote the intro`] })], 'CE-1');
    expect(i.lastActivityAt).toBe(day(1));
    expect(i.idleDays).toBe(1);
    expect(i.maybeOutdated).toBeUndefined();
    expect(i.last).toBe('wrote the intro');
  });

  it('uses a newer Log line over updatedAt', () => {
    const i = itemOf([ticket({ updatedAt: day(6), log: [`${day(2)} · vera-1 · progress`] })], 'CE-1');
    expect(i.lastActivityAt).toBe(day(2));
    expect(i.idleDays).toBe(2);
  });

  it('marks open tickets silent past the threshold as maybe outdated, with the age in the spoken text', () => {
    const inProgress = itemOf([ticket({ status: 'in_progress', updatedAt: day(5), log: [`${day(5)} · vera-1 · started`] })], 'CE-1');
    expect(inProgress.maybeOutdated).toBe(true);
    expect(inProgress.idleDays).toBe(5);
    expect(inProgress.last).toBe('May be outdated: no update for 5 days. Last note: started');
    // Backlog gets the longer 14-day allowance.
    expect(itemOf([ticket({ status: 'backlog', updatedAt: day(10) })], 'CE-1').maybeOutdated).toBeUndefined();
    const backlog = itemOf([ticket({ status: 'backlog', updatedAt: day(15) })], 'CE-1');
    expect(backlog.maybeOutdated).toBe(true);
    expect(backlog.last).toBe('May be outdated: no update for 15 days.');
  });

  it('does not mark parked tickets or finished ones', () => {
    expect(itemOf([ticket({ status: 'backlog', updatedAt: day(40), labels: ['parked'] })], 'CE-1').maybeOutdated).toBeUndefined();
    expect(itemOf([ticket({ status: 'done', updatedAt: day(0.5) })], 'CE-1').maybeOutdated).toBeUndefined();
  });

  it('does not report an outdated in-progress ticket as what its assignee is doing now', () => {
    const snap = buildBriefingSnapshot(sources({ tickets: [ticket({ status: 'in_progress', updatedAt: day(6) })], workItems: [] }));
    expect(snap.agents.find((a) => a.session === 'vera-1')?.activity).toBeUndefined();
    const fresh = buildBriefingSnapshot(sources({ tickets: [ticket({ status: 'in_progress', updatedAt: day(0.1) })], workItems: [] }));
    expect(fresh.agents.find((a) => a.session === 'vera-1')?.activity?.ref).toBe('CE-1');
  });

  it('stays backward compatible: the old fields are unchanged and the new ones are optional', () => {
    const i = itemOf([ticket({ status: 'in_progress', updatedAt: day(6) })], 'CE-1');
    expect(i).toMatchObject({ ref: 'CE-1', kind: 'ticket', status: 'in_progress', updatedAt: day(6), project: 'ce-site' });
    // Work items keep their old shape.
    const wi = buildBriefingSnapshot(sources()).items.find((x) => x.kind === 'work')!;
    expect(wi.maybeOutdated).toBeUndefined();
    expect(wi.lastActivityAt).toBeUndefined();
  });
});

describe('collapsing review entries per agent', () => {
  const review = (id: string, who: string, title: string, minutes: number, tkt: string) => ({
    id: `t:${id}`,
    kind: 'review' as const,
    agentSession: `${who.toLowerCase()}-1`,
    agentName: who,
    summary: `${who} finished: ${title}. Accept it or send it back?`,
    since: ago(minutes),
    urgency: 'low' as const,
    answerTarget: { kind: 'ticket', ticketId: id, tkt },
  });

  it('one entry per agent with several reviews; decisions and single reviews stay as they are', () => {
    const waiting = [
      review('a', 'Milo', 'Bigger pet home', 300, 'TKT-1'),
      { id: 'd:D-7', kind: 'decision' as const, agentSession: 'ella-1', agentName: 'Ella', summary: 'Ella asks which cut', since: ago(20), urgency: 'normal' as const, answerTarget: { kind: 'decision', decisionId: 'D-7' } },
      review('b', 'Milo', 'Multi photo upload', 200, 'TKT-2'),
      review('c', 'Milo', 'Setting overlay', 100, 'TKT-3'),
      review('d', 'Ella', 'Competitor UI notes', 50, 'TKT-4'),
    ];
    const out = collapseReviews(waiting);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      agentName: 'Milo',
      summary: 'Milo finished 3 things: Bigger pet home, Multi photo upload, Setting overlay - any you want changed?',
      since: ago(300),
      refs: ['TKT-1', 'TKT-2', 'TKT-3'],
    });
    expect(out[1].id).toBe('d:D-7');
    expect(out[2].summary).toContain('Ella finished: Competitor UI notes');
  });

  it('flows into the snapshot with refs; a lone review keeps the old shape', () => {
    const s = buildBriefingSnapshot(
      sources({ waiting: [review('a', 'Milo', 'A', 30, 'TKT-1'), review('b', 'Milo', 'B', 20, 'TKT-2'), review('c', 'Ella', 'C', 10, 'TKT-3')] }),
    );
    expect(s.waiting).toHaveLength(2);
    expect(s.waiting[0]).toMatchObject({ ref: 'TKT-1', kind: 'review', refs: ['TKT-1', 'TKT-2'] });
    expect(s.waiting[1]).not.toHaveProperty('refs');
  });

  it('says "and N more" past four', () => {
    const many = ['A', 'B', 'C', 'D', 'E', 'F'].map((t, i) => review(String(i), 'Milo', t, 60 - i, `TKT-${i}`));
    expect(collapseReviews(many)[0].summary).toBe('Milo finished 6 things: A, B, C, D and 2 more - any you want changed?');
  });
});
