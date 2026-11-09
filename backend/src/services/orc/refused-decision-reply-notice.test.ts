import { noticeRefusedDecisionReply, resetRefusedReplyNoticesForTesting, type RefusedReplyNoticeDeps } from './refused-decision-reply-notice.js';
import { REFUSED_DECISION_REPLY_CONSTANTS } from '../../constants.js';

const CARD = { slackChannelId: 'C0CE00001', threadTs: '1791427303.380879' };

function deps(over: Partial<RefusedReplyNoticeDeps> = {}): RefusedReplyNoticeDeps & { tell: jest.Mock; postToCard: jest.Mock } {
  return {
    decision: async () => ({ status: 'resolved', card: CARD }),
    leadOf: async () => 'sam',
    tell: jest.fn(async () => true),
    orchestrator: 'crewly-orc',
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

  it('order is lead → orchestrator → plain card line, each only when the one before failed', async () => {
    const noLead = deps({ leadOf: async () => null });
    expect(await noticeRefusedDecisionReply(input, noLead)).toEqual({ sent: true, to: 'orchestrator', target: 'crewly-orc' });
    expect(noLead.tell).toHaveBeenCalledWith('crewly-orc', expect.stringContaining('D-457'));
    expect(noLead.postToCard).not.toHaveBeenCalled();

    resetRefusedReplyNoticesForTesting();
    const leadDown = deps({ tell: jest.fn(async (to: string) => to === 'crewly-orc') });
    expect(await noticeRefusedDecisionReply(input, leadDown)).toEqual({ sent: true, to: 'orchestrator', target: 'crewly-orc' });
    expect(leadDown.tell.mock.calls.map((c) => c[0])).toEqual(['sam', 'crewly-orc']);

    resetRefusedReplyNoticesForTesting();
    const allDown = deps({ tell: jest.fn(async () => false) });
    expect(await noticeRefusedDecisionReply(input, allDown)).toEqual({ sent: true, to: 'card', target: 'C0CE00001:1791427303.380879' });
    expect(allDown.tell.mock.calls.map((c) => c[0])).toEqual(['sam', 'crewly-orc']);
  });

  it('the card line is plain: no session name, no error text, no internal words', async () => {
    const d = deps({ tell: jest.fn(async () => false) });
    await noticeRefusedDecisionReply({ ...input, failedStep: 'thread_not_found fallback blew up' }, d);
    const [, line] = d.postToCard.mock.calls[0] as unknown as [unknown, string];
    expect(line).toBe('Your answer on D-457 was received, but the follow-up message did not get through; we are on it.');
    for (const bad of ['nova', 'sam', 'crewly-orc', 'thread_not_found', 'fallback', 'failed step', 'session']) expect(line.toLowerCase()).not.toContain(bad);
  });

  it('the agent IS a lead (no lead above it) → the orchestrator, never itself', async () => {
    const d = deps({ leadOf: async () => null });
    const r = await noticeRefusedDecisionReply({ ...input, agentSession: 'sam' }, d);
    expect(r).toEqual({ sent: true, to: 'orchestrator', target: 'crewly-orc' });
    expect(d.tell.mock.calls.map((c) => c[0])).toEqual(['crewly-orc']);
    // a lead that resolves to the agent itself is skipped too
    resetRefusedReplyNoticesForTesting();
    const self = deps({ leadOf: async () => 'sam' });
    await noticeRefusedDecisionReply({ ...input, agentSession: 'sam' }, self);
    expect(self.tell.mock.calls.map((c) => c[0])).toEqual(['crewly-orc']);
  });

  it('the orchestrator is the failing agent and has no lead → only the card line', async () => {
    const d = deps({ leadOf: async () => null });
    const r = await noticeRefusedDecisionReply({ ...input, agentSession: 'crewly-orc' }, d);
    expect(r.sent && r.to).toBe('card');
    expect(d.tell).not.toHaveBeenCalled();
  });

  it('reports why when nobody could be told, and does not rate-limit that', async () => {
    const d = deps({ leadOf: async () => null, tell: jest.fn(async () => false), decision: async () => ({ status: 'resolved' }) });
    const r = await noticeRefusedDecisionReply(input, d);
    expect(r).toEqual({ sent: false, reason: 'the orchestrator could not be reached' });
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
