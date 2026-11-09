/**
 * Tests for the machine side of a 1:1 meeting: the pack is built from the
 * agent's own sources (a failing source is left empty), the wiki search
 * reads only the agent's vaults and reports its time, and write-backs land
 * in the right thread — a Slack thread, a Crewly chat thread, the open
 * decision card — with a new topic starting one thread that later
 * write-backs reuse.
 */

import { DriveMeetingService, type DriveMeetingDeps } from './drive-meeting.service.js';
import type { MeetingDecisionSource, MeetingTimelineRow } from './drive-meeting-pack.js';

const SID = 'drv_abcdefghijkl';
const NOW = new Date('2026-10-21T10:00:00.000Z');
const ROOT = '4b1c2d3e-0000-4000-8000-000000000001';

const card: MeetingDecisionSource = {
  id: 'D-7',
  question: 'Tuesday or Thursday?',
  status: 'open',
  asker: 'ella',
  requestedBy: 'ella',
  options: [{ key: 'a', label: 'Tuesday' }, { key: 'b', label: 'Thursday' }],
  card: { slackChannelId: 'C0MKT', messageTs: '1760953333.000400' },
  createdAt: '2026-10-21T08:00:00.000Z',
  updatedAt: '2026-10-21T08:00:00.000Z',
};

function harness(over: Partial<DriveMeetingDeps> = {}) {
  const rows: Array<Record<string, unknown>> = [];
  const posts: Array<Record<string, unknown>> = [];
  const answered: Array<[string, string]> = [];
  const searched: Array<{ vaults: string[]; query: string; agent: string }> = [];
  let n = 0;
  const timeline: MeetingTimelineRow[] = [
    { id: 'a1', channelId: 'dm-ella', channelType: 'dm', senderType: 'agent', senderKind: 'agent', senderId: 'ella', content: 'Headline A or B?', createdAt: NOW.getTime() - 1000, metadata: { slackChannelId: 'D0ELLA', slackThreadTs: '1760950000.000100' } },
  ];
  const deps: DriveMeetingDeps = {
    timeline: async () => timeline,
    decisions: async () => [card],
    snapshot: async () => null,
    handover: async () => 'Working on the launch post.',
    vaults: async () => [{ vaultPath: '/home/.crewly/teams/t1/wiki', label: 'Marketing' }],
    searchWiki: async (vaults, query, agent) => {
      searched.push({ vaults: vaults.map((v) => v.vaultPath), query, agent });
      return [{ title: 'brand voice', where: 'Marketing/brand.md', text: 'Short, warm, no jargon.', absPath: '/home/.crewly/teams/t1/wiki/brand.md' }];
    },
    readPage: async () => 'The whole brand voice page.',
    answerDecision: async (id, text) => {
      answered.push([id, text]);
      return true;
    },
    slackDmOf: () => ({ slackChannelId: 'D0ELLA', chatChannelId: 'dm-ella' }),
    chatChannelOfSlack: (ch) => (ch === 'D0ELLA' ? { chatChannelId: 'dm-ella', dm: true } : ch === 'C0MKT' ? { chatChannelId: 'room-mkt', dm: false } : null),
    slackRootId: (chatChannelId, ts) => (chatChannelId === 'room-mkt' && ts === '1760953333.000400' ? ROOT : null),
    postSlack: async (input) => {
      posts.push(input as unknown as Record<string, unknown>);
      return `1760960000.00010${posts.length}`;
    },
    ownerDmChannel: () => 'dm-ella',
    recordOwnerTurn: async (input) => {
      rows.push(input as unknown as Record<string, unknown>);
      n += 1;
      return { messageId: `aaaaaaaa-0000-4000-8000-00000000000${n}` };
    },
    now: () => NOW,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never,
    ...over,
  };
  return { service: new DriveMeetingService(deps), rows, posts, answered, searched, deps };
}

describe('buildPack', () => {
  it('reads the agent’s sources, wiki pages included', async () => {
    const h = harness();
    const pack = await h.service.buildPack({ agentSession: 'ella', name: 'Ella', team: 'Marketing', language: 'en' });
    expect(pack.agent).toMatchObject({ name: 'Ella', session: 'ella', team: 'Marketing' });
    expect(pack.agenda.map((a) => a.state)).toEqual(['waiting_on_owner', 'question']);
    expect(pack.handover).toBe('Working on the launch post.');
    expect(pack.wiki).toEqual([{ title: 'brand voice', where: 'Marketing/brand.md', text: 'The whole brand voice page.' }]);
    expect(h.searched[0]).toMatchObject({ agent: 'ella', vaults: ['/home/.crewly/teams/t1/wiki'] });
    expect(h.searched[0].query).toContain('Marketing');
  });

  it('a failing source is left empty', async () => {
    const h = harness({
      timeline: async () => {
        throw new Error('db down');
      },
      handover: async () => {
        throw new Error('no file');
      },
    });
    const pack = await h.service.buildPack({ agentSession: 'ella', name: 'Ella', language: 'en' });
    expect(pack.messages).toEqual([]);
    expect(pack.handover).toBeUndefined();
    expect(pack.agenda).toHaveLength(1);
  });
});

describe('searchWiki', () => {
  it('top hits in plain words, with the time it took', async () => {
    const h = harness();
    const out = await h.service.searchWiki({ agentSession: 'ella', query: 'brand voice' });
    expect(out.hits).toEqual([{ title: 'brand voice', where: 'Marketing/brand.md', text: 'Short, warm, no jargon.' }]);
    expect(typeof out.ms).toBe('number');
  });

  it('an agent with no vaults gets nothing (no global wiki)', async () => {
    const h = harness({ vaults: async () => [] });
    expect((await h.service.searchWiki({ agentSession: 'ella', query: 'x' })).hits).toEqual([]);
    expect(h.searched).toHaveLength(0);
  });
});

describe('writeBack', () => {
  it('a Slack DM thread: posted there by the agent, recorded in the DM, handed to the agent', async () => {
    const h = harness();
    const out = await h.service.writeBack({ sessionId: SID, agentSession: 'ella', text: 'Use headline B', writeBack: { kind: 'decision', topic: 'Headline', threadRef: 'slack:D0ELLA:1760950000.000100' } });
    expect(out).toEqual({ threadRef: 'slack:D0ELLA:1760950000.000100', via: 'slack' });
    expect(h.posts[0]).toMatchObject({ agentSession: 'ella', slackChannelId: 'D0ELLA', threadTs: '1760950000.000100', text: 'From our voice meeting — Decision: Use headline B' });
    expect(h.rows[0]).toMatchObject({ channelId: 'dm-ella', metadata: { source: 'cloud-talk', via: 'meeting', slackThreadTs: '1760950000.000100', slackAlreadyPosted: true, meetingSessionId: SID } });
    expect(h.rows[0].threadId).toBeUndefined();
  });

  it('an open decision card: the owner’s words settle it', async () => {
    const h = harness();
    const out = await h.service.writeBack({ sessionId: SID, agentSession: 'ella', text: 'Thursday', writeBack: { kind: 'decision', topic: 'Post day', threadRef: 'slack:C0MKT:1760953333.000400' } });
    expect(out.via).toBe('decision');
    expect(h.answered).toEqual([['D-7', 'Thursday']]);
    expect(h.posts).toHaveLength(0);
  });

  it('a card the words do not settle, or a task on it: posted in its room thread', async () => {
    const h = harness({ answerDecision: async () => false });
    const out = await h.service.writeBack({ sessionId: SID, agentSession: 'ella', text: 'Ask Owen first', writeBack: { kind: 'task', topic: 'Post day', threadRef: 'slack:C0MKT:1760953333.000400' } });
    expect(out.via).toBe('slack');
    expect(h.rows[0]).toMatchObject({ channelId: 'room-mkt', threadId: ROOT, text: 'From our voice meeting — New task: Ask Owen first' });
  });

  it('a Crewly chat thread: recorded in that thread', async () => {
    const h = harness();
    const ref = `chat:room-mkt:${ROOT}`;
    expect(await h.service.writeBack({ sessionId: SID, agentSession: 'ella', text: 'Go', writeBack: { kind: 'answer', topic: 'X', threadRef: ref } })).toEqual({ threadRef: ref, via: 'chat' });
    expect(h.rows[0]).toMatchObject({ channelId: 'room-mkt', threadId: ROOT });
    expect(h.posts).toHaveLength(0);
  });

  it('a new topic starts one Slack thread in the DM; the next write-back on it reuses it', async () => {
    const h = harness();
    const first = await h.service.writeBack({ sessionId: SID, agentSession: 'ella', text: 'Hire a designer', writeBack: { kind: 'task', topic: 'Hiring', newTopic: 'Hiring' } });
    expect(first).toEqual({ threadRef: 'slack:D0ELLA:1760960000.000101', via: 'slack' });
    expect(h.posts[0]).toMatchObject({ slackChannelId: 'D0ELLA', text: 'Hiring\nFrom our voice meeting — New task: Hire a designer' });
    expect(h.posts[0].threadTs).toBeUndefined();
    const second = await h.service.writeBack({ sessionId: SID, agentSession: 'ella', text: 'Budget 5k', writeBack: { kind: 'decision', topic: 'Hiring', newTopic: 'Hiring' } });
    expect(second.threadRef).toBe(first.threadRef);
    expect(h.posts[1]).toMatchObject({ threadTs: '1760960000.000101' });
  });

  it('a new topic without a Slack DM: a new Crewly chat thread', async () => {
    const h = harness({ slackDmOf: () => null });
    const out = await h.service.writeBack({ sessionId: SID, agentSession: 'ella', text: 'Note it', writeBack: { kind: 'note', topic: 'Misc', newTopic: 'Misc' } });
    expect(out).toEqual({ threadRef: 'chat:dm-ella:aaaaaaaa-0000-4000-8000-000000000001', via: 'chat' });
    const next = await h.service.writeBack({ sessionId: SID, agentSession: 'ella', text: 'More', writeBack: { kind: 'note', topic: 'Misc', newTopic: 'Misc' } });
    expect(h.rows[1]).toMatchObject({ channelId: 'dm-ella', threadId: 'aaaaaaaa-0000-4000-8000-000000000001' });
    expect(next.threadRef).toBe(out.threadRef);
  });

  it('a Slack conversation not mirrored here still reaches the agent in its DM', async () => {
    const h = harness({ chatChannelOfSlack: () => null });
    await h.service.writeBack({ sessionId: SID, agentSession: 'ella', text: 'Fine', writeBack: { kind: 'answer', topic: 'X', threadRef: 'slack:C0OTHER:1760950000.000100' } });
    expect(h.rows[0]).toMatchObject({ channelId: 'dm-ella', metadata: { slackChannelId: 'C0OTHER' } });
  });
});
