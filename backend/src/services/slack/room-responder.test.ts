/**
 * Tests for the pure parts of "one responder per owner message"
 * (specs/2026-10-03-one-responder-per-message.md).
 *
 * @module services/slack/room-responder.test
 */

import {
  buildRoomAgentDirectory,
  findPriorRoomAnswer,
  heldReplyMessage,
  isDecisionCardText,
  sameAgentName,
  threadOwnerFromSlack,
} from './room-responder.js';
import type { SlackContextMessage, SlackThreadContext } from '../../types/slack.types.js';
import type { ChatMessageDTO } from '../chat-v2/types.js';

const dir = buildRoomAgentDirectory({
  local: [
    { session: 'think-tank-atlas', name: 'Atlas', botUserId: 'UATLAS' },
    { session: 'crewly-marketing-ella', name: 'Ella', botUserId: 'UELLA' },
    { session: 'ops-noah', name: 'Noah' },
  ],
  remote: [{ session: 'pa-aria', name: 'Aria' }],
});

function msg(ts: string, text: string, o: Partial<SlackContextMessage> = {}): SlackContextMessage {
  return { ts, text, isBot: false, authorName: 'Steve', userId: 'UOWNER', ...o };
}
const atlas = (ts: string, text: string) => msg(ts, text, { userId: 'UATLAS', isBot: true, authorName: 'Atlas' });
const ella = (ts: string, text: string) => msg(ts, text, { userId: 'UELLA', isBot: true, authorName: 'Ella (Crewly Marketing)' });
const aria = (ts: string, text: string) => msg(ts, text, { userId: 'UARIA-ON-AIR', isBot: true, authorName: 'Aria' });
const thread = (messages: SlackContextMessage[], threadTs = '100.0'): SlackThreadContext => ({
  kind: 'thread',
  channelId: 'C0C46TTBNNP',
  threadTs,
  messages,
  totalBefore: messages.length,
});

describe('sameAgentName', () => {
  it('matches equal names and a team suffix, not prefixes of other words', () => {
    expect(sameAgentName('Ella', 'ella')).toBe(true);
    expect(sameAgentName('Ella (Crewly Marketing)', 'Ella')).toBe(true);
    expect(sameAgentName('Ellanor', 'Ella')).toBe(false);
    expect(sameAgentName('', 'Ella')).toBe(false);
  });
});

describe('isDecisionCardText', () => {
  it('recognises cards, ticket cards and reminders', () => {
    expect(isDecisionCardText('Decision D-92: Keep both versions? (Yes / No)')).toBe(true);
    expect(isDecisionCardText('TKT-12 · Landing page [D-92]: Keep both? (Yes / No)')).toBe(true);
    expect(isDecisionCardText('@Steve Still waiting on you: Keep both? — tap an answer on the card above, or reply here.')).toBe(true);
    expect(isDecisionCardText('Here is the draft for D-day')).toBe(false);
  });
});

describe('buildRoomAgentDirectory', () => {
  it('a local bot is matched by its user id, other bots by name, people never', () => {
    expect(dir.authorOf(atlas('1', 'x'))).toEqual({ session: 'think-tank-atlas', name: 'Atlas', local: true });
    expect(dir.authorOf(aria('1', 'x'))).toEqual({ session: 'pa-aria', name: 'Aria', local: false });
    expect(dir.authorOf(msg('1', 'x'))).toBeNull();
    // A local agent posting without its own app (username override).
    expect(dir.authorOf(msg('1', 'x', { userId: 'UMASTER', isBot: true, usernameOverride: true, authorName: 'Noah' }))).toMatchObject({ session: 'ops-noah', local: true });
    // The same name posted by some other bot is not taken for a local agent.
    expect(dir.authorOf(msg('1', 'x', { userId: 'UOTHER', isBot: true, authorName: 'Noah' }))).toBeNull();
  });

  it('a name that matches several agents is unclear', () => {
    const twoEllas = buildRoomAgentDirectory({
      local: [],
      remote: [
        { session: 'crewly-marketing-ella', name: 'Ella (Crewly Marketing)' },
        { session: 'pa-ella', name: 'Ella (Personal Assistant)' },
      ],
    });
    expect(twoEllas.authorOf(msg('1', 'x', { userId: 'U?', isBot: true, authorName: 'Ella' }))).toBeNull();
    expect(twoEllas.authorOf(msg('1', 'x', { userId: 'U?', isBot: true, authorName: 'Ella (Personal Assistant)' }))).toMatchObject({ session: 'pa-ella' });
  });
});

describe('threadOwnerFromSlack', () => {
  it('the incident: a D-92 reminder went up since the owner last spoke → Atlas (by the card)', () => {
    const ctx = thread([
      ella('100.0', 'Draft A and draft B for the newsletter'),
      atlas('100.5', 'Decision D-92: Keep both versions? (Yes / No)'),
      ella('100.7', 'I can prepare both if needed'),
      atlas('101.0', '@Steve Still waiting on you: Keep both versions? — tap an answer on the card above, or reply here.'),
    ]);
    expect(threadOwnerFromSlack(ctx, dir)).toEqual({ agent: { session: 'think-tank-atlas', name: 'Atlas', local: true }, via: 'card' });
  });

  it('a card posted since the owner last spoke wins even when a colleague spoke after it', () => {
    const ctx = thread([atlas('100.0', 'Decision D-92: Keep both? (Yes / No)'), ella('100.1', 'I can prepare both')]);
    expect(threadOwnerFromSlack(ctx, dir)).toMatchObject({ agent: { session: 'think-tank-atlas' }, via: 'card' });
  });

  it('a card the owner already answered no longer decides: the last speaker does', () => {
    const ctx = thread([atlas('100.0', 'Decision D-92: Keep both? (Yes / No)'), msg('100.1', 'yes'), ella('100.2', 'Done, both are up')]);
    expect(threadOwnerFromSlack(ctx, dir)).toMatchObject({ agent: { session: 'crewly-marketing-ella' }, via: 'last-speaker' });
  });

  it('probe: Atlas starts, owner "looks off", Ella "I can dig into it", owner "yes please do" → Ella (09-21 last-speaker rule)', () => {
    const ctx = thread([atlas('100.0', 'Weekly numbers are up'), msg('100.1', 'looks off'), ella('100.2', 'I can dig into it')]);
    expect(threadOwnerFromSlack(ctx, dir)).toMatchObject({ agent: { session: 'crewly-marketing-ella' }, via: 'last-speaker' });
  });

  it('a thread a person started: the agent that spoke last; an agent on another machine can own it', () => {
    expect(threadOwnerFromSlack(thread([msg('100.0', 'who has the numbers?'), ella('100.1', 'I do'), atlas('100.2', 'me too')]), dir)).toMatchObject({
      agent: { session: 'think-tank-atlas' },
    });
    expect(threadOwnerFromSlack(thread([aria('100.0', 'Your calendar for today')]), dir)).toEqual({
      agent: { session: 'pa-aria', name: 'Aria', local: false },
      via: 'last-speaker',
    });
  });

  it('no agent → null; not a thread → null', () => {
    expect(threadOwnerFromSlack(thread([msg('100.0', 'hi')]), dir)).toBeNull();
    expect(threadOwnerFromSlack(null, dir)).toBeNull();
    expect(threadOwnerFromSlack({ ...thread([atlas('1', 'a')]), kind: 'channel' }, dir)).toBeNull();
  });
});

describe('findPriorRoomAnswer (reply gate)', () => {
  let seq = 0;
  const row = (o: Partial<ChatMessageDTO>): ChatMessageDTO => ({
    id: `m${++seq}`,
    channelId: 'huddle-1',
    seq,
    senderType: 'user',
    senderId: 'steve',
    content: 'x',
    contentType: 'markdown',
    createdAt: seq,
    attachments: [],
    mentions: [],
    ...o,
  });
  const ATLAS = 'think-tank-atlas';
  const ELLA = 'crewly-marketing-ella';
  const names = (s: string) => ({ [ATLAS]: 'Atlas', [ELLA]: 'Ella' } as Record<string, string>)[s];
  const owner = (content: string, responders: string[], mentions: string[] = []) => row({ content, mentions, metadata: { roomResponders: responders } });
  const said = (session: string, content: string, extra: Partial<ChatMessageDTO> = {}) => row({ senderType: 'agent', senderId: session, content, ...extra });

  it('the chosen responder answered the owner\'s latest message → another agent\'s repeat is held', () => {
    const t = [said(ATLAS, 'Reminder: D-92'), owner('我之前不是说了吗 两者应该都要有', [ATLAS]), said(ATLAS, 'Got it — keeping both versions.')];
    expect(findPriorRoomAnswer(t, ELLA, names)).toMatchObject({ by: 'Atlas', bySession: ATLAS, excerpt: 'Got it — keeping both versions.' });
    expect(findPriorRoomAnswer(t, ATLAS, names)).toBeNull();
  });

  it('probe: "@Atlas @Ella both give me your view" — Ella is not held after Atlas answers', () => {
    const t = [owner('@Atlas @Ella both give me your view', [ATLAS, ELLA], [ATLAS, ELLA]), said(ATLAS, 'My view: ship it')];
    expect(findPriorRoomAnswer(t, ELLA, names)).toBeNull();
    // @'d in the message even when not recorded as a responder.
    const t2 = [owner('@Atlas @Ella views?', [ATLAS], [ATLAS, ELLA]), said(ATLAS, 'My view: ship it')];
    expect(findPriorRoomAnswer(t2, ELLA, names)).toBeNull();
  });

  it('probe: Atlas answers "@Ella can you confirm?" — Ella is not held', () => {
    const t = [owner('is the draft final?', [ATLAS]), said(ATLAS, 'I think so. @Ella can you confirm?')];
    expect(findPriorRoomAnswer(t, ELLA, names)).toBeNull();
    const t2 = [owner('is the draft final?', [ATLAS]), said(ATLAS, 'I think so — Ella, confirm?', { mentions: [ELLA] })];
    expect(findPriorRoomAnswer(t2, ELLA, names)).toBeNull();
  });

  it('probe: an agent answering an earlier owner question it was chosen for is not held', () => {
    const t = [owner('Ella, pull last week\'s numbers', [ELLA]), owner('and is the newsletter out?', [ATLAS]), said(ATLAS, 'Yes, sent at 9:00')];
    expect(findPriorRoomAnswer(t, ELLA, names)).toBeNull();
    // Once Ella has answered that earlier one, a later repeat is held again.
    const t2 = [owner('Ella, pull numbers', [ELLA]), said(ELLA, 'Numbers: …'), owner('newsletter out?', [ATLAS]), said(ATLAS, 'Yes')];
    expect(findPriorRoomAnswer(t2, ELLA, names)).toMatchObject({ bySession: ATLAS });
  });

  it('only an answer from the chosen responder holds; no recorded responders, interim notes and earlier answers never hold', () => {
    expect(findPriorRoomAnswer([owner('q', [ATLAS]), said('ops-noah', 'chiming in')], ELLA, names)).toBeNull();
    expect(findPriorRoomAnswer([row({ content: 'q' }), said(ATLAS, 'a')], ELLA, names)).toBeNull();
    expect(findPriorRoomAnswer([owner('q', [ATLAS]), said(ATLAS, 'on it (~5 min)', { metadata: { interim: true } })], ELLA, names)).toBeNull();
    expect(findPriorRoomAnswer([owner('q1', [ATLAS]), said(ATLAS, 'a1'), owner('q2', [ATLAS])], ELLA, names)).toBeNull();
  });

  it('a chosen responder on another machine, recorded here, holds under its name', () => {
    const t = [owner('q', ['pa-aria']), row({ senderId: 'Aria (agent)', content: 'done', metadata: { remoteAgentSession: 'pa-aria' } })];
    expect(findPriorRoomAnswer(t, ELLA)).toMatchObject({ by: 'Aria', bySession: 'pa-aria' });
  });

  it('the held message never says to drop it, and names --adds-new for something new or when asked', () => {
    const text = heldReplyMessage({ by: 'Atlas', excerpt: 'keeping both' });
    expect(text).toContain('Held, not posted: Atlas, the agent answering the owner');
    expect(text).toContain('Post with --adds-new if you have something new, or if you were asked.');
    expect(text).not.toContain('--none');
  });
});
