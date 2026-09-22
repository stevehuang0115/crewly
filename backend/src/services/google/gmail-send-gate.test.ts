/**
 * Tests for the Gmail send gate.
 *
 * @module services/google/gmail-send-gate.test
 */

import {
  holdGmailSend,
  consumeSendApproval,
  grantSendApproval,
  listHeldSends,
  getHeldSend,
  clearHeldSend,
  resetGmailSendGate,
} from './gmail-send-gate.js';

describe('gmail send gate', () => {
  beforeEach(() => resetGmailSendGate());
  afterEach(() => resetGmailSendGate());

  it('records what the agent cited, at the moment it tried', () => {
    // Captured now, before anyone knows the send will be questioned. A
    // citation produced afterwards cannot be told apart from one that
    // existed; this one can.
    const held = holdGmailSend({
      agentSession: 'ella',
      draftId: 'r-1',
      to: 'kpan@panlawoffice.com',
      subject: 'Re: closing',
      claim: "owner, 14:22 — 'yes send it'",
    });

    expect(getHeldSend(held.id)).toMatchObject({
      agentSession: 'ella',
      to: 'kpan@panlawoffice.com',
      claim: "owner, 14:22 — 'yes send it'",
    });
    expect(held.heldAt).toBeLessThanOrEqual(Date.now());
  });

  it('leaves the citation absent when the agent named nothing', () => {
    // Which is itself the answer to "were you told to send this?".
    const held = holdGmailSend({ agentSession: 'ella', draftId: 'r-1', to: 'a@b.c', subject: 'Hi' });
    expect(getHeldSend(held.id)!.claim).toBeUndefined();
  });

  it('grants exactly one send per approval', () => {
    grantSendApproval('ella');

    expect(consumeSendApproval('ella')).toBe(true);
    // The next attempt is held again — approving one message must not leave
    // the account open.
    expect(consumeSendApproval('ella')).toBe(false);
  });

  it('does not let one agent spend another agent\'s approval', () => {
    grantSendApproval('ella');
    expect(consumeSendApproval('atlas')).toBe(false);
    expect(consumeSendApproval('ella')).toBe(true);
  });

  it('refuses by default, with no approval anywhere', () => {
    expect(consumeSendApproval('never-approved')).toBe(false);
  });

  it('lists held mail oldest first', () => {
    const a = holdGmailSend({ agentSession: 'ella', draftId: 'r-1', to: 'a@b.c', subject: 'One' });
    const b = holdGmailSend({ agentSession: 'ella', draftId: 'r-2', to: 'a@b.c', subject: 'Two' });
    // Same millisecond is possible; assert membership and order by heldAt.
    const ids = listHeldSends().map((h) => h.id);
    expect(ids).toEqual([a.id, b.id]);
  });

  it('keeps two drafts from one agent apart', () => {
    holdGmailSend({ agentSession: 'ella', draftId: 'r-1', to: 'a@b.c', subject: 'One' });
    holdGmailSend({ agentSession: 'ella', draftId: 'r-2', to: 'd@e.f', subject: 'Two' });
    expect(listHeldSends()).toHaveLength(2);
  });

  it('drops a hold once answered, and says whether there was one', () => {
    const held = holdGmailSend({ agentSession: 'ella', draftId: 'r-1', to: 'a@b.c', subject: 'Hi' });
    expect(clearHeldSend(held.id)).toBe(true);
    expect(getHeldSend(held.id)).toBeUndefined();
    expect(clearHeldSend(held.id)).toBe(false);
  });
});
