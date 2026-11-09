/**
 * Tests for the meeting pack (Meetings P2b): the agenda of open owner↔agent
 * threads, thread refs, plain words, and the token budget.
 */

import { MEETING_CONSTANTS } from '../../constants.js';
import {
  buildAgenda,
  buildMeetingPack,
  estimateTokens,
  packTextForBudget,
  packWikiQuery,
  parseChatThreadRef,
  parseSlackThreadRef,
  plainWords,
  threadRefOfRow,
  threadState,
  type MeetingDecisionSource,
  type MeetingTimelineRow,
} from './drive-meeting-pack.js';
import type { BriefingSnapshot } from './drive-briefing.contract.js';

const NOW = new Date('2026-10-21T10:00:00.000Z');
const T = NOW.getTime();
const ROOT = '4b1c2d3e-0000-4000-8000-000000000001';
const agent = { session: 'ella', name: 'Ella', role: 'Marketing lead', team: 'Marketing' };

function row(over: Partial<MeetingTimelineRow>): MeetingTimelineRow {
  return { id: 'r', channelId: 'dm-ella', channelType: 'dm', senderType: 'agent', senderKind: 'agent', senderId: 'ella', content: 'hi', createdAt: T - 60_000, ...over };
}

const slackMeta = (ts: string) => ({ slackChannelId: 'D0ELLA', slackThreadTs: ts });

function timeline(): MeetingTimelineRow[] {
  return [
    // Slack DM thread A: the agent asked a question, no answer yet.
    row({ id: 'a1', senderType: 'user', senderKind: 'owner', senderId: 'owner', content: 'Draft the launch post', metadata: slackMeta('1760950000.000100'), createdAt: T - 3_600_000 }),
    row({ id: 'a2', content: 'Draft 2 is ready. Headline A or B?', metadata: slackMeta('1760950000.000100'), createdAt: T - 3_000_000 }),
    // Slack DM thread B: the owner asked, the agent has not answered.
    row({ id: 'b1', senderType: 'user', senderKind: 'owner', senderId: 'owner', content: 'Send me the weekly report [SLACK-THREAD:D0ELLA:1760951111.000200]', metadata: slackMeta('1760951111.000200'), createdAt: T - 1_000_000 }),
    // Slack DM thread C: settled (the agent answered, nothing open).
    row({ id: 'c1', senderType: 'user', senderKind: 'owner', senderId: 'owner', content: 'Thanks', metadata: slackMeta('1760952222.000300'), createdAt: T - 900_000 }),
    row({ id: 'c2', content: 'Done, posted.', metadata: slackMeta('1760952222.000300'), createdAt: T - 800_000 }),
    // A room thread where only another agent spoke: not this agent's thread.
    row({ id: 'd1', channelId: 'room', channelType: 'channel', channelName: 'launch', threadId: ROOT, senderType: 'agent', senderId: 'owen', content: 'Can you check?', createdAt: T - 700_000 }),
    // A room thread with the owner and this agent: the agent says it is on it.
    row({ id: 'e1', channelId: 'room', channelType: 'channel', channelName: 'launch', threadId: 'aaaaaaaa-0000-4000-8000-000000000002', senderType: 'user', senderKind: 'owner', senderId: 'owner', content: 'Pricing page copy?', createdAt: T - 600_000 }),
    row({ id: 'e2', channelId: 'room', channelType: 'channel', channelName: 'launch', threadId: 'aaaaaaaa-0000-4000-8000-000000000002', content: "I'm drafting it now", createdAt: T - 500_000 }),
    // Too old.
    row({ id: 'z1', senderType: 'user', senderKind: 'owner', senderId: 'owner', content: 'Old thing', metadata: slackMeta('1700000000.000100'), createdAt: T - MEETING_CONSTANTS.AGENDA_WINDOW_MS - 1 }),
  ];
}

const card: MeetingDecisionSource = {
  id: 'D-7',
  question: 'Post on Tuesday or Thursday?',
  status: 'open',
  asker: 'ella',
  requestedBy: 'ella',
  options: [{ key: 'a', label: 'Tuesday' }, { key: 'b', label: 'Thursday' }],
  card: { slackChannelId: 'C0MKT', messageTs: '1760953333.000400' },
  createdAt: '2026-10-21T08:00:00.000Z',
  updatedAt: '2026-10-21T08:00:00.000Z',
};

describe('thread refs', () => {
  it('Slack thread, chat thread, DM top level; a room top level is none', () => {
    expect(threadRefOfRow(row({ metadata: slackMeta('1760950000.000100') }))).toBe('slack:D0ELLA:1760950000.000100');
    expect(threadRefOfRow(row({ channelType: 'channel', channelId: 'room', threadId: ROOT }))).toBe(`chat:room:${ROOT}`);
    expect(threadRefOfRow(row({}))).toBe('chat:dm-ella');
    expect(threadRefOfRow(row({ channelType: 'channel', channelId: 'room' }))).toBeNull();
  });

  it('parse back', () => {
    expect(parseChatThreadRef(`chat:slack-C0X:1.2:${ROOT}`)).toEqual({ channelId: 'slack-C0X:1.2', rootId: ROOT });
    expect(parseChatThreadRef('chat:dm-ella')).toEqual({ channelId: 'dm-ella' });
    expect(parseChatThreadRef('slack:D0ELLA:1.1')).toBeNull();
    expect(parseSlackThreadRef('slack:D0ELLA:1760950000.000100')).toEqual({ slackChannelId: 'D0ELLA', threadTs: '1760950000.000100' });
    expect(parseSlackThreadRef('chat:x')).toBeNull();
  });
});

describe('threadState', () => {
  it('owner last → in progress; agent asks → question; agent on it → in progress; else settled', () => {
    const at = '';
    expect(threadState([{ from: 'owner', text: 'Send it', at }])).toBe('in_progress');
    expect(threadState([{ from: 'agent', text: 'A or B?', at }])).toBe('question');
    expect(threadState([{ from: 'agent', text: '要不要先发给你看', at }])).toBe('question');
    expect(threadState([{ from: 'agent', text: "I'll send it by noon", at }])).toBe('in_progress');
    expect(threadState([{ from: 'agent', text: 'Done.', at }])).toBeNull();
    expect(threadState([])).toBeNull();
  });
});

describe('buildAgenda', () => {
  it('open card first, then questions, then work in progress; settled, old and other agents’ threads left out', () => {
    const agenda = buildAgenda({ now: NOW, agent, timeline: timeline(), decisions: [card] });
    expect(agenda.map((a) => [a.threadRef, a.state])).toEqual([
      ['slack:C0MKT:1760953333.000400', 'waiting_on_owner'],
      ['slack:D0ELLA:1760950000.000100', 'question'],
      [`chat:room:aaaaaaaa-0000-4000-8000-000000000002`, 'in_progress'],
      ['slack:D0ELLA:1760951111.000200', 'in_progress'],
    ]);
    expect(agenda[1]).toMatchObject({ topic: 'Draft the launch post', where: 'Slack DM' });
    expect(agenda[2].where).toBe('#launch');
    expect(agenda[3].topic).toBe('Send me the weekly report');
    expect(agenda[0].recent?.[0].text).toContain('Tuesday / Thursday');
  });

  it('a meeting\'s own write-backs (in the owner\'s name) are not new topics for the next meeting', () => {
    const wb = { source: MEETING_CONSTANTS.SOURCE, via: MEETING_CONSTANTS.VIA, meetingSessionId: 'drv_1' };
    const rows = [
      row({ id: 'w1', channelId: 'dm-ella', threadId: 'bbbbbbbb-0000-4000-8000-000000000003', senderType: 'user', senderKind: 'owner', senderId: 'owner', content: 'From our voice meeting — Decision: karma 积累是行动而非内容选题。', metadata: wb, createdAt: T - 400_000 }),
      // Real words in the same kind of thread still count.
      row({ id: 'w2', channelId: 'dm-ella', threadId: 'cccccccc-0000-4000-8000-000000000004', senderType: 'user', senderKind: 'owner', senderId: 'owner', content: 'Can you redo the cover?', createdAt: T - 300_000 }),
    ];
    const agenda = buildAgenda({ now: NOW, agent, timeline: rows, decisions: [] });
    expect(agenda.map((a) => a.topic)).toEqual(['Can you redo the cover?']);
  });

  it('a settled card and another agent’s card are not on it; at most AGENDA_MAX topics', () => {
    const many = Array.from({ length: 30 }, (_, i) => row({ id: `q${i}`, content: `Question ${i}?`, metadata: slackMeta(`17609${String(10000 + i)}.000100`), createdAt: T - i * 1000 }));
    const agenda = buildAgenda({ now: NOW, agent, timeline: many, decisions: [{ ...card, status: 'resolved' }, { ...card, id: 'D-8', asker: 'owen', requestedBy: 'owen' }] });
    expect(agenda).toHaveLength(MEETING_CONSTANTS.AGENDA_MAX);
    expect(agenda.every((a) => a.state === 'question')).toBe(true);
  });
});

describe('buildMeetingPack', () => {
  const snapshot: BriefingSnapshot = {
    v: 1,
    generatedAt: NOW.toISOString(),
    teams: [],
    agents: [{ session: 'ella', name: 'Ella', team: 'Marketing', role: 'lead', state: 'working', activity: { title: 'Launch post CE-12', since: '2026-10-21T09:00:00.000Z' } }],
    items: [
      { ref: 'CE-12', kind: 'ticket', title: 'Launch post CE-12', status: 'in_progress', assignee: 'Ella', updatedAt: '' },
      { ref: 'CE-13', kind: 'ticket', title: 'Newsletter', status: 'review', assignee: 'Ella', updatedAt: '', last: 'waiting for review' },
      { ref: 'CE-14', kind: 'ticket', title: 'Old', status: 'done', assignee: 'Ella', updatedAt: '' },
      { ref: 'CE-15', kind: 'ticket', title: 'Owen thing', status: 'open', assignee: 'Owen', updatedAt: '' },
    ],
    waiting: [
      { ref: 'D-7', kind: 'decision', from: 'Ella', summary: 'Post on Tuesday or Thursday?', since: '' },
      { ref: 'D-9', kind: 'decision', from: 'Owen', summary: 'Not Ella', since: '' },
    ],
  };

  it('holds the agent, work, waiting, messages, decisions, agenda and wiki, with secrets masked', () => {
    const pack = buildMeetingPack({
      now: NOW,
      agent,
      handover: 'Working on the launch. token sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0123456789',
      snapshot,
      timeline: timeline(),
      decisions: [card, { ...card, id: 'D-5', status: 'resolved', chosenKey: 'b', updatedAt: '2026-10-20T08:00:00.000Z' }],
      wiki: [{ title: 'Brand voice', where: 'Marketing/brand.md', text: 'Short, warm.' }],
    });
    expect(pack.agent).toEqual({ name: 'Ella', session: 'ella', role: 'Marketing lead', team: 'Marketing' });
    expect(pack.handover).not.toContain('sk-ant-api03');
    expect(pack.work.map((w) => w.title)).toEqual(['Launch post CE-12', 'Newsletter']);
    expect(pack.waiting).toEqual([{ kind: 'decision', summary: 'Post on Tuesday or Thursday?' }]);
    expect(pack.decisions).toEqual([{ question: 'Post on Tuesday or Thursday?', answer: 'Thursday', at: '2026-10-20T08:00:00.000Z' }]);
    expect(pack.messages.some((m) => m.text.includes('SLACK-THREAD'))).toBe(false);
    expect(pack.messages.find((m) => m.text === 'Can you check?')).toBeUndefined();
    expect(pack.agenda).toHaveLength(4);
    expect(pack.wiki[0].title).toBe('Brand voice');
    expect(pack.estTokens).toBeGreaterThan(0);
  });

  it('stays within the token budget: wiki dropped first, then old messages, then the handover cut', () => {
    const big = 'word '.repeat(5000);
    const pack = buildMeetingPack({
      now: NOW,
      agent,
      handover: big.repeat(4),
      snapshot: null,
      timeline: Array.from({ length: 40 }, (_, i) => row({ id: `m${i}`, content: big.slice(0, 3000), createdAt: T - i * 1000 })),
      decisions: [],
      wiki: Array.from({ length: 10 }, (_, i) => ({ title: `Page ${i}`, where: 'x.md', text: big })),
    });
    expect(estimateTokens(packTextForBudget(pack))).toBeLessThanOrEqual(MEETING_CONSTANTS.PACK_MAX_TOKENS);
    expect(pack.estTokens).toBeLessThanOrEqual(MEETING_CONSTANTS.PACK_MAX_TOKENS);
  });
});

describe('helpers', () => {
  it('plain words strip tags and links', () => {
    expect(plainWords('[Drive mode · session drv_x] See https://x.y/z now', 100)).toBe('See now');
  });

  it('the wiki query: team, role, topics, at most 200 characters', () => {
    expect(packWikiQuery(agent, [{ threadRef: 'chat:x', topic: 'Launch post', state: 'question' }])).toBe('Marketing Marketing lead Launch post');
    expect(packWikiQuery({ session: 's', name: 'n' }, [])).toBe('');
    const long = Array.from({ length: 20 }, (_, i) => ({ threadRef: `chat:${i}`, topic: `Topic number ${i} with words`, state: 'question' as const }));
    expect(packWikiQuery(agent, long).length).toBeLessThanOrEqual(200);
  });

  it('estimateTokens: CJK one each', () => {
    expect(estimateTokens('你好abcd')).toBe(3);
  });
});
