import { OWNER_COMPLETION_REPORT_CONSTANTS as C } from '../../constants.js';
import { OwnerRequestContextRegistry, getOwnerRequestContext, resetOwnerRequestContext } from './owner-request-context.js';

const NOW = Date.parse('2026-10-07T13:44:10Z');
const comment = { appId: 'upb7se5pfj', commentId: 'QMSjXIhFanDw' };

describe('OwnerRequestContextRegistry', () => {
  let reg: OwnerRequestContextRegistry;
  beforeEach(() => {
    reg = new OwnerRequestContextRegistry();
  });

  it('an app comment delivered to an agent becomes its owner request, pointing at the comment', () => {
    reg.noteAppComment('lyra', comment, NOW);
    expect(reg.get('lyra', NOW + 1000)).toEqual({
      origin: { kind: 'owner', receivedBy: 'lyra', appComment: comment },
      at: NOW,
      via: 'app-comment',
    });
  });

  it('expires after CONTEXT_FRESH_MS', () => {
    reg.noteAppComment('lyra', comment, NOW);
    expect(reg.get('lyra', NOW + C.CONTEXT_FRESH_MS + 1)).toBeNull();
  });

  it('resolve() fills in the comment\'s Slack thread', async () => {
    reg.setAppCommentThreadResolver(async (appId, commentId) =>
      appId === comment.appId && commentId === comment.commentId ? { slackChannelId: 'C0C2WMFB9EF', threadTs: '1791380650.784969' } : null,
    );
    reg.noteAppComment('lyra', comment, NOW);
    const ctx = await reg.resolve('lyra', NOW);
    expect(ctx?.origin).toEqual({ kind: 'owner', receivedBy: 'lyra', appComment: comment, slackChannelId: 'C0C2WMFB9EF', threadTs: '1791380650.784969' });
  });

  it('resolve() keeps the context when the resolver fails', async () => {
    reg.setAppCommentThreadResolver(async () => {
      throw new Error('no links');
    });
    reg.noteAppComment('lyra', comment, NOW);
    expect((await reg.resolve('lyra', NOW))?.origin.appComment).toEqual(comment);
  });

  it('a hand-over (Lyra messages Ella) gives the colleague the request, still received by Lyra', () => {
    reg.noteAppComment('lyra', comment, NOW);
    expect(reg.relay('lyra', 'ella', NOW + 5000)).toBe(true);
    expect(reg.get('ella', NOW + 6000)).toEqual({
      origin: { kind: 'owner', receivedBy: 'lyra', appComment: comment },
      at: NOW + 5000,
      via: 'hand-over',
    });
    // and on to Ella's team
    expect(reg.relay('ella', 'atlas', NOW + 9000)).toBe(true);
    expect(reg.get('atlas', NOW + 9000)?.origin.receivedBy).toBe('lyra');
  });

  it('a sender handling the owner\'s chat turn hands that over', () => {
    reg.setTurnLookup((s) => (s === 'ella' ? { origin: { kind: 'owner', conversationId: 'room', slackChannelId: 'C1', threadTs: '1.2', receivedBy: 'ella' }, at: NOW } : null));
    expect(reg.relay('ella', 'luna', NOW + 10)).toBe(true);
    expect(reg.get('luna', NOW + 10)?.origin).toMatchObject({ slackChannelId: 'C1', receivedBy: 'ella' });
  });

  it('nothing to hand over, or the target has a newer owner request of its own → no change', () => {
    expect(reg.relay('lyra', 'ella', NOW)).toBe(false);
    reg.noteAppComment('lyra', comment, NOW);
    reg.noteAppComment('ella', { appId: 'other', commentId: 'c2' }, NOW + 100);
    expect(reg.relay('lyra', 'ella', NOW + 200)).toBe(false);
    expect(reg.get('ella', NOW + 200)?.origin.appComment?.appId).toBe('other');
    reg.setTurnLookup((s) => (s === 'kai' ? { origin: { kind: 'owner', conversationId: 'dm' }, at: NOW + 500 } : null));
    expect(reg.relay('lyra', 'kai', NOW + 600)).toBe(false);
    expect(reg.relay('lyra', 'lyra', NOW + 600)).toBe(false);
  });

  it('remembers at most MAX_CONTEXT_SESSIONS sessions', () => {
    for (let i = 0; i <= C.MAX_CONTEXT_SESSIONS; i++) reg.noteAppComment(`a${i}`, comment, NOW);
    expect(reg.get('a0', NOW)).toBeNull();
    expect(reg.get(`a${C.MAX_CONTEXT_SESSIONS}`, NOW)).not.toBeNull();
  });

  it('the process-wide registry is shared and resettable', () => {
    getOwnerRequestContext().noteAppComment('lyra', comment, Date.now());
    expect(getOwnerRequestContext().get('lyra')).not.toBeNull();
    resetOwnerRequestContext();
    expect(getOwnerRequestContext().get('lyra')).toBeNull();
  });
});
