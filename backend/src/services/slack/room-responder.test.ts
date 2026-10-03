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
  it('the incident: the owner replies under Atlas\'s D-92 reminder in a thread Ella started → Atlas', () => {
    const ctx = thread([
      ella('100.0', 'Draft A and draft B for the newsletter'),
      atlas('100.5', 'Decision D-92: Keep both versions? (Yes / No)'),
      ella('100.7', 'I can prepare both if needed'),
      atlas('101.0', '@Steve Still waiting on you: Keep both versions? — tap an answer on the card above, or reply here.'),
    ]);
    expect(threadOwnerFromSlack(ctx, dir)).toMatchObject({ session: 'think-tank-atlas', local: true });
  });

  it('no card: the agent that started the thread', () => {
    const ctx = thread([ella('100.0', 'Weekly digest'), atlas('100.2', 'Two notes on the digest'), msg('100.3', 'thanks')]);
    expect(threadOwnerFromSlack(ctx, dir)).toMatchObject({ session: 'crewly-marketing-ella' });
  });

  it('the owner @\'d another agent in the thread: the conversation moved on → last speaker', () => {
    const ctx = thread([ella('100.0', 'Weekly digest'), msg('100.1', '@Atlas 看看上面的这些'), atlas('100.2', 'Looked: two issues')]);
    expect(threadOwnerFromSlack(ctx, dir)).toMatchObject({ session: 'think-tank-atlas' });
  });

  it('a thread a person started: the agent that spoke last', () => {
    const ctx = thread([msg('100.0', 'who has the numbers?'), ella('100.1', 'I do'), atlas('100.2', 'me too')]);
    expect(threadOwnerFromSlack(ctx, dir)).toMatchObject({ session: 'think-tank-atlas' });
  });

  it('an agent on another machine can own it (every machine names the same agent)', () => {
    const ctx = thread([aria('100.0', 'Your calendar for today')]);
    expect(threadOwnerFromSlack(ctx, dir)).toEqual({ session: 'pa-aria', name: 'Aria', local: false });
  });

  it('a truncated thread (root not shown) falls back to the last speaker; no agent → null', () => {
    expect(threadOwnerFromSlack({ ...thread([atlas('100.4', 'a'), ella('100.5', 'b')]), totalBefore: 40 }, dir)).toMatchObject({ session: 'crewly-marketing-ella' });
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
  const names = (s: string) => ({ 'think-tank-atlas': 'Atlas', 'crewly-marketing-ella': 'Ella' })[s];

  it('a colleague answered after the owner\'s latest message → held, with that answer', () => {
    const t = [
      row({ senderType: 'agent', senderId: 'think-tank-atlas', content: 'Reminder: D-92' }),
      row({ content: '我之前不是说了吗 两者应该都要有' }),
      row({ senderType: 'agent', senderId: 'think-tank-atlas', content: 'Got it — keeping both versions.' }),
    ];
    expect(findPriorRoomAnswer(t, 'crewly-marketing-ella', names)).toMatchObject({ by: 'Atlas', bySession: 'think-tank-atlas', excerpt: 'Got it — keeping both versions.' });
    // The one who answered may post again.
    expect(findPriorRoomAnswer(t, 'think-tank-atlas', names)).toBeNull();
  });

  it('answers before the owner\'s latest message, interim notes and no owner message do not count', () => {
    const before = [
      row({ content: 'first question' }),
      row({ senderType: 'agent', senderId: 'think-tank-atlas', content: 'answer to the first' }),
      row({ content: 'second question' }),
      row({ senderType: 'agent', senderId: 'think-tank-atlas', content: 'on it (~5 min)', metadata: { interim: true } }),
    ];
    expect(findPriorRoomAnswer(before, 'crewly-marketing-ella', names)).toBeNull();
    expect(findPriorRoomAnswer([row({ senderType: 'agent', senderId: 'think-tank-atlas' })], 'crewly-marketing-ella')).toBeNull();
  });

  it('a colleague on another machine recorded here counts, under its name', () => {
    const t = [row({ content: 'q' }), row({ senderId: 'Aria (agent)', content: 'done', metadata: { remoteAgentSession: 'pa-aria' } })];
    expect(findPriorRoomAnswer(t, 'crewly-marketing-ella')).toMatchObject({ by: 'Aria', bySession: 'pa-aria' });
  });

  it('the held message names the flag and the way out', () => {
    const text = heldReplyMessage({ by: 'Atlas', excerpt: 'keeping both' });
    expect(text).toContain('Held, not posted: Atlas already answered');
    expect(text).toContain('--adds-new');
    expect(text).toContain('reply --none');
  });
});
