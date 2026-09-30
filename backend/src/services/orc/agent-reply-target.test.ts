import { planAgentReply, isStatusReport, originThread } from './agent-reply-target.js';
import type { TurnOrigin } from './orc-reply-route.service.js';

const dmOrigin: TurnOrigin = {
  conversationId: 'dm-ella',
  slackThreadKey: 'D0DM:1790000000.000100',
  receivedAt: 1,
};
const roomOrigin: TurnOrigin = {
  conversationId: 'room-1',
  slackThreadKey: 'C0ROOM:1790000000.000200',
  chatThreadId: 'root-9',
  receivedAt: 1,
};

function plan(over: Partial<Parameters<typeof planAgentReply>[0]> = {}) {
  return planAgentReply({
    session: 'ella',
    isOrchestrator: false,
    content: 'The EFT sheet is updated.',
    origin: dmOrigin,
    ownsConversation: (c) => c === 'dm-ella' || c === 'room-1',
    ...over,
  });
}

describe('isStatusReport / originThread', () => {
  it('recognises status markers', () => {
    expect(isStatusReport('[DONE] shipped')).toBe(true);
    expect(isStatusReport('  [working] on it')).toBe(true);
    expect(isStatusReport('Done — see the sheet')).toBe(false);
  });

  it('prefers the Slack thread key over the chat thread', () => {
    expect(originThread(roomOrigin)).toBe('C0ROOM:1790000000.000200');
    expect(originThread({ conversationId: 'h', chatThreadId: 'r', receivedAt: 1 })).toBe('r');
    expect(originThread(undefined)).toBeUndefined();
  });
});

describe('planAgentReply', () => {
  it('no ids → the recorded origin, with its thread', () => {
    expect(plan()).toEqual(expect.objectContaining({ kind: 'post', conversationId: 'dm-ella', thread: 'D0DM:1790000000.000100', via: 'origin' }));
  });

  it('wrong / legacy ids → the origin', () => {
    const p = plan({ requested: { conversationId: 'conv-legacy-123' } });
    expect(p).toEqual(expect.objectContaining({ kind: 'post', conversationId: 'dm-ella', via: 'origin' }));
    expect(p.kind === 'post' && p.reason).toContain('conv-legacy-123');
  });

  it('explicit correct ids win', () => {
    expect(plan({ requested: { conversationId: 'room-1', thread: 'C0ROOM:1790000000.000999' } })).toEqual(
      expect.objectContaining({ kind: 'post', conversationId: 'room-1', thread: 'C0ROOM:1790000000.000999', via: 'explicit' }),
    );
  });

  it('explicit own conversation without a thread takes the origin thread when it is the same conversation', () => {
    expect(plan({ origin: roomOrigin, requested: { conversationId: 'room-1' } })).toEqual(
      expect.objectContaining({ conversationId: 'room-1', thread: 'C0ROOM:1790000000.000200', via: 'explicit' }),
    );
    expect(plan({ origin: dmOrigin, requested: { conversationId: 'room-1' } })).toEqual(
      expect.not.objectContaining({ thread: expect.anything() }),
    );
  });

  it('an explicit thread with no conversation keeps the origin conversation', () => {
    expect(plan({ requested: { thread: 'D0DM:1790000000.000555' } })).toEqual(
      expect.objectContaining({ conversationId: 'dm-ella', thread: 'D0DM:1790000000.000555', via: 'origin' }),
    );
  });

  it('status markers → the orchestrator', () => {
    expect(plan({ content: '[DONE] EFT sheet updated' })).toEqual({ kind: 'status' });
  });

  it('--none → close, carrying the origin', () => {
    expect(plan({ none: true, content: '' })).toEqual({ kind: 'none', origin: dmOrigin });
  });

  it('no origin and no ids → no target (never silently dropped)', () => {
    expect(plan({ origin: undefined })).toEqual(expect.objectContaining({ kind: 'no-target' }));
  });

  describe('orchestrator', () => {
    it('answers a Slack-bridged turn in its Slack thread', () => {
      expect(
        plan({
          session: 'crewly-orc',
          isOrchestrator: true,
          origin: { conversationId: 'conv-orc', slackChannelId: 'D0MASTER', slackThreadTs: '1790.5', receivedAt: 1 },
        }),
      ).toEqual(expect.objectContaining({ kind: 'orc-slack', channelId: 'D0MASTER', threadTs: '1790.5' }));
    });

    it('answers a chat turn through its own chat routing', () => {
      expect(plan({ session: 'crewly-orc', isOrchestrator: true, origin: { conversationId: 'conv-orc', receivedAt: 1 } })).toEqual(
        expect.objectContaining({ kind: 'orc-chat', conversationId: 'conv-orc' }),
      );
    });

    it('status markers from the orchestrator stay status', () => {
      expect(plan({ session: 'crewly-orc', isOrchestrator: true, content: '[DONE] ok' })).toEqual({ kind: 'status' });
    });
  });
});
