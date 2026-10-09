/**
 * Tests for Drive mode recall: which messages count as "sent to the owner",
 * and ranking by the owner's hint.
 */

import { hintScore, messagesToOwner, pickRecall, type RecallFeedMessage } from './drive-recall.js';

let n = 0;
function msg(over: Partial<RecallFeedMessage> = {}): RecallFeedMessage {
  n += 1;
  return {
    id: `m${n}`,
    channelId: 'dm-ella',
    channelType: 'dm',
    channelName: 'Ella',
    senderType: 'agent',
    senderId: 'ella',
    senderKind: 'agent',
    agentSession: 'ella',
    content: `message ${n}`,
    createdAt: 1000 + n,
    ...over,
  };
}

describe('messagesToOwner', () => {
  it('keeps the agent DMs and threads the owner is in; drops others, system lines and Drive relays', () => {
    const rows = [
      msg({ content: 'DM answer' }),
      msg({ channelId: 'h1', channelType: 'huddle', channelName: '#ce', threadId: 'root-1', content: 'in owner thread' }),
      msg({ channelId: 'h1', channelType: 'huddle', channelName: '#ce', threadId: 'root-2', content: 'thread without the owner' }),
      msg({ senderId: 'leo', agentSession: 'leo', content: 'someone else' }),
      msg({ senderType: 'system', senderKind: 'system', content: 'system' }),
      msg({ senderType: 'user', senderKind: 'owner', content: 'owner' }),
      msg({ content: '[Drive mode · session x] relay' }),
    ];
    const out = messagesToOwner(rows, [{ channelId: 'h1', root: 'root-1', lastAt: 1 }], ['ella']);
    expect(out.map((m) => m.content)).toEqual(['in owner thread', 'DM answer']);
  });

  it('a remote agent mirrored in from Slack counts by its session too', () => {
    const rows = [msg({ senderType: 'user', senderKind: 'agent', senderId: 'Rex (agent)', agentSession: 'rex', content: 'from Rex' })];
    expect(messagesToOwner(rows, [], ['rex']).map((m) => m.content)).toEqual(['from Rex']);
  });
});

describe('pickRecall', () => {
  it('ranks by the hint, newest first otherwise; speakable, at most four', () => {
    const rows = [
      msg({ content: 'The **newsletter** is ready: https://x.y/z', createdAt: 5 }),
      msg({ content: 'Banner draft done', createdAt: 9 }),
    ];
    const byHint = pickRecall(rows, 'newsletter');
    expect(byHint).toEqual([{ agentSession: 'ella', where: 'your DM', at: new Date(5).toISOString(), text: 'The newsletter is ready:' }]);
    expect(pickRecall(rows).map((m) => m.text)).toEqual(['The newsletter is ready:', 'Banner draft done']);
    expect(pickRecall(Array.from({ length: 9 }, () => msg()))).toHaveLength(4);
  });

  it('hint score: substring 1, unrelated low, Chinese bigrams', () => {
    expect(hintScore('周报', '这是本周的周报')).toBe(1);
    expect(hintScore('invoice', 'newsletter ready')).toBeLessThan(0.34);
    expect(hintScore('上线的事', '上线已经完成')).toBeGreaterThan(0.3);
  });
});
