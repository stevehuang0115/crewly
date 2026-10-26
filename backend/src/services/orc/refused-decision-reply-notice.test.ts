import { noticeRefusedDecisionReply, resetRefusedReplyNoticesForTesting, type RefusedReplyNoticeDeps } from './refused-decision-reply-notice.js';
import { REFUSED_DECISION_REPLY_CONSTANTS } from '../../constants.js';

const CARD = { slackChannelId: 'C0CE00001', threadTs: '1791427303.380879' };

function deps(over: Partial<RefusedReplyNoticeDeps> = {}): RefusedReplyNoticeDeps & { tell: jest.Mock; postToCard: jest.Mock } {
  return {
    decision: async () => ({ status: 'resolved', card: CARD }),
    leadOf: async () => 'sam',
    tell: jest.fn(async () => true),
    postToCard: jest.fn(async () => true),
    now: () => 1_000_000,
    ...over,
  } as RefusedReplyNoticeDeps & { tell: jest.Mock; postToCard: jest.Mock };
}
const input = { decisionId: 'D-457', agentSession: 'nova', failedStep: 'conversation room-ce did not take it.' };

describe('noticeRefusedDecisionReply (CREW-372)', () => {
  beforeEach(() => resetRefusedReplyNoticesForTesting());

  it('tells the lead once, naming the decision, the agent and the failed step', async () => {
    const d = deps();
    const r = await noticeRefusedDecisionReply(input, d);
    expect(r).toEqual({ sent: true, to: 'lead', target: 'sam' });
    expect(d.tell).toHaveBeenCalledTimes(1);
    const [to, text] = d.tell.mock.calls[0] as [string, string];
    expect(to).toBe('sam');
    expect(text).toContain('D-457');
    expect(text).toContain('nova');
    expect(text).toContain('conversation room-ce did not take it.');
    expect(d.postToCard).not.toHaveBeenCalled();
  });

  it('rate-limits per decision, and another decision still gets its notice', async () => {
    const d = deps();
    await noticeRefusedDecisionReply(input, d);
    const again = await noticeRefusedDecisionReply(input, d);
    expect(again.sent).toBe(false);
    expect(d.tell).toHaveBeenCalledTimes(1);
    expect((await noticeRefusedDecisionReply({ ...input, decisionId: 'D-458' }, d)).sent).toBe(true);
    // After the window it may notice again.
    const later = deps({ now: () => 1_000_000 + REFUSED_DECISION_REPLY_CONSTANTS.NOTICE_WINDOW_MS + 1 });
    expect((await noticeRefusedDecisionReply(input, later)).sent).toBe(true);
  });

  it('says nothing for a decision the owner has not answered', async () => {
    for (const status of ['open', 'parked', 'cancelled', 'expired']) {
      const d = deps({ decision: async () => ({ status, card: CARD }) });
      expect((await noticeRefusedDecisionReply(input, d)).sent).toBe(false);
      expect(d.tell).not.toHaveBeenCalled();
    }
  });

  it('also covers a decision whose default was applied', async () => {
    expect((await noticeRefusedDecisionReply(input, deps({ decision: async () => ({ status: 'defaulted', card: CARD }) }))).sent).toBe(true);
  });

  it('with no lead, or a lead that cannot be reached, uses the card thread', async () => {
    const noLead = deps({ leadOf: async () => null });
    expect(await noticeRefusedDecisionReply(input, noLead)).toEqual({ sent: true, to: 'card', target: 'C0CE00001:1791427303.380879' });
    expect(noLead.postToCard).toHaveBeenCalledWith(CARD, 'nova', expect.stringContaining('D-457'));
    resetRefusedReplyNoticesForTesting();
    const unreachable = deps({ tell: jest.fn(async () => false) });
    expect((await noticeRefusedDecisionReply(input, unreachable)).sent).toBe(true);
    expect(unreachable.postToCard).toHaveBeenCalledTimes(1);
  });

  it('reports why when nobody could be told, and does not rate-limit that', async () => {
    const d = deps({ leadOf: async () => null, decision: async () => ({ status: 'resolved' }) });
    const r = await noticeRefusedDecisionReply(input, d);
    expect(r).toEqual({ sent: false, reason: 'no team lead and no card thread' });
    expect((await noticeRefusedDecisionReply(input, deps())).sent).toBe(true);
  });

  it('never throws', async () => {
    const r = await noticeRefusedDecisionReply(input, deps({ decision: async () => { throw new Error('store down'); } }));
    expect(r).toEqual({ sent: false, reason: 'store down' });
  });

  it('unknown decision → no notice', async () => {
    expect((await noticeRefusedDecisionReply(input, deps({ decision: async () => null }))).sent).toBe(false);
  });
});
