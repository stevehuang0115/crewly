/**
 * Tests for GmailSendApprovalService (CREW-257): the card, the one-shot
 * draft-bound approval, and re-approval after an edit.
 *
 * @module services/google/gmail-send-approval.service.test
 */

import type { OwnerDecision } from '../../types/decision.types.js';
import { GmailSendApprovalService, fingerprintDraft, GMAIL_SEND_KEYS, type GmailDraftApi } from './gmail-send-approval.service.js';
import { holdGmailSend, getHeldSend, resetGmailSendGate } from './gmail-send-gate.js';
import type { GmailDraftContent } from './gmail.service.js';

const draft = (over: Partial<GmailDraftContent> = {}): GmailDraftContent => ({
	draftId: 'd1',
	threadId: 't1',
	from: 'me@x.y',
	to: 'x@y.z',
	cc: '',
	bcc: '',
	subject: 'Hello',
	body: 'Body v1',
	html: '',
	attachments: [],
	...over,
});

function setup(initial: GmailDraftContent = draft()) {
	let current = initial;
	const gmail: GmailDraftApi & { getDraft: jest.Mock; sendDraft: jest.Mock; deleteDraft: jest.Mock } = {
		deleteDraft: jest.fn(),
		getDraft: jest.fn(async () => current),
		sendDraft: jest.fn(async () => ({ id: 'sent1', threadId: 't1', labelIds: ['SENT'] })),
	};
	let n = 0;
	const asked: unknown[] = [];
	const decisions = {
		askPrebuilt: jest.fn(async (ask: { gmail: unknown; question: string; sensitive: string; defaultKey: string }) => {
			asked.push(ask);
			n += 1;
			return { id: `D-${n}` } as OwnerDecision;
		}),
		chooseFromDashboard: jest.fn(),
	};
	const onSent = jest.fn();
	const svc = new GmailSendApprovalService({
		gmailFor: () => gmail,
		decisions: () => decisions,
		canAskInSlack: () => true,
		tellAgent: jest.fn(),
		onSent,
	});
	const settle = (id: string, key: string, status: OwnerDecision['status'] = 'resolved'): OwnerDecision => {
		const d = { id, status, chosenKey: key, gmail: (asked[Number(id.slice(2)) - 1] as { gmail: OwnerDecision['gmail'] }).gmail } as OwnerDecision;
		return d;
	};
	return { svc, gmail, decisions, onSent, settle, edit: (c: GmailDraftContent) => (current = c) };
}

const hold = () => holdGmailSend({ agentSession: 'lyra', draftId: 'd1', to: 'x@y.z', subject: 'Hello' });

beforeEach(() => resetGmailSendGate());

describe('GmailSendApprovalService', () => {
	it('raises a sensitive card whose default is not sending, and sends nothing yet', async () => {
		const { svc, gmail, decisions } = setup();
		expect(await svc.onHeld(hold())).toBe(true);
		const ask = decisions.askPrebuilt.mock.calls[0][0];
		expect(ask.sensitive).toBe('email');
		expect(ask.defaultKey).toBe(GMAIL_SEND_KEYS.NOT_NOW);
		expect(ask.question).toContain('Body v1');
		expect(gmail.sendDraft).not.toHaveBeenCalled();
		expect(getHeldSend('lyra:d1')?.fingerprint).toBe(fingerprintDraft(draft()));
	});

	it('sends exactly that draft when the owner taps Send, then watches the thread', async () => {
		const { svc, gmail, onSent, settle } = setup();
		await svc.onHeld(hold());
		const note = await svc.onSettled(settle('D-1', GMAIL_SEND_KEYS.SEND));
		expect(gmail.sendDraft).toHaveBeenCalledWith('d1');
		expect(onSent).toHaveBeenCalledWith({ threadId: 't1', agentSession: 'lyra' });
		expect(note).toContain('was sent');
		expect(getHeldSend('lyra:d1')).toBeUndefined();
	});

	it('cannot be reused: a second settle for the same card sends nothing', async () => {
		const { svc, gmail, settle } = setup();
		await svc.onHeld(hold());
		await svc.onSettled(settle('D-1', GMAIL_SEND_KEYS.SEND));
		expect(await svc.onSettled(settle('D-1', GMAIL_SEND_KEYS.SEND))).toBeNull();
		expect(gmail.sendDraft).toHaveBeenCalledTimes(1);
	});

	it('is bound to one draft: an answer to a stale card does not send a newer hold', async () => {
		const { svc, gmail, settle } = setup();
		await svc.onHeld(hold());
		// same agent+draft re-held (new card D-2) — the old card D-1 must not send it
		await svc.onHeld(hold());
		expect(await svc.onSettled(settle('D-1', GMAIL_SEND_KEYS.SEND))).toBeNull();
		expect(gmail.sendDraft).not.toHaveBeenCalled();
	});

	it('an edit after approval is not sent; a new card is raised for the edited text', async () => {
		const { svc, gmail, decisions, settle, edit } = setup();
		await svc.onHeld(hold());
		edit(draft({ body: 'Body v2 — owner changed it' }));
		const note = await svc.onSettled(settle('D-1', GMAIL_SEND_KEYS.SEND));
		expect(gmail.sendDraft).not.toHaveBeenCalled();
		expect(note).toContain('NOT sent');
		expect(decisions.askPrebuilt).toHaveBeenCalledTimes(2);
		expect(decisions.askPrebuilt.mock.calls[1][0].question).toContain('Body v2');
		// the first card's approval cannot send the edited text either
		expect(await svc.onSettled(settle('D-1', GMAIL_SEND_KEYS.SEND))).toBeNull();
		expect(gmail.sendDraft).not.toHaveBeenCalled();
		// approving the second card sends it
		await svc.onSettled(settle('D-2', GMAIL_SEND_KEYS.SEND));
		expect(gmail.sendDraft).toHaveBeenCalledTimes(1);
	});

	it.each([
		[GMAIL_SEND_KEYS.NOT_NOW, 'resolved', 'said not now'],
		[GMAIL_SEND_KEYS.NOT_NOW, 'defaulted', 'not approved in 24h'],
		[GMAIL_SEND_KEYS.NOT_NOW, 'expired', 'not approved in 24h'],
		[GMAIL_SEND_KEYS.SEND, 'defaulted', 'not approved in 24h'],
		[GMAIL_SEND_KEYS.SEND, 'cancelled', 'withdrawn'],
	] as const)('%s / %s: nothing is sent and the draft is NOT deleted', async (key, status, text) => {
		const { svc, gmail, settle } = setup();
		await svc.onHeld(hold());
		const note = await svc.onSettled(settle('D-1', key, status));
		expect(gmail.sendDraft).not.toHaveBeenCalled();
		expect(gmail.deleteDraft).not.toHaveBeenCalled();
		expect(note).toContain(text);
		if (status === 'defaulted') expect(note).toContain('draft is left in Gmail');
	});

	it('the card defaults to Not now with a 24 h deadline, and is labelled Yes / Not now', async () => {
		const { svc, decisions } = setup();
		await svc.onHeld(hold());
		const ask = decisions.askPrebuilt.mock.calls[0][0] as unknown as { options: Array<{ label: string }>; defaultKey: string; deadline: Date };
		expect(ask.options.map((o) => o.label)).toEqual(['Yes', 'Not now']);
		expect(ask.defaultKey).toBe(GMAIL_SEND_KEYS.NOT_NOW);
		expect(ask.deadline.getTime() - Date.now()).toBeGreaterThan(23 * 3600 * 1000);
	});

	it('the card shows every recipient, Bcc included, and attachments', async () => {
		const { svc, decisions } = setup(draft({ bcc: 'secret@y.z', cc: 'cc@y.z', attachments: [{ filename: 'q.pdf', size: 1200 }] }));
		await svc.onHeld(hold());
		const q = decisions.askPrebuilt.mock.calls[0][0].question;
		expect(q).toContain('Send this to x@y.z?');
		expect(q).toContain('secret@y.z');
		expect(q).toContain('cc@y.z');
		expect(q).toContain('q.pdf');
	});

	it('Bcc added after the card: no send, a new card showing the Bcc', async () => {
		const { svc, gmail, decisions, settle, edit } = setup();
		await svc.onHeld(hold());
		edit(draft({ bcc: 'silent@y.z' }));
		const note = await svc.onSettled(settle('D-1', GMAIL_SEND_KEYS.SEND));
		expect(gmail.sendDraft).not.toHaveBeenCalled();
		expect(note).toContain('NOT sent');
		expect(decisions.askPrebuilt).toHaveBeenCalledTimes(2);
		expect(decisions.askPrebuilt.mock.calls[1][0].question).toContain('silent@y.z');
	});

	const changes: Array<[string, Partial<GmailDraftContent>, Partial<GmailDraftContent>]> = [
		['from', {}, { from: 'other@x.y' }],
		['html', {}, { html: '<b>hi</b>' }],
		['attachment added', {}, { attachments: [{ filename: 'a.pdf', size: 1 }] }],
		['attachment size', { attachments: [{ filename: 'a.pdf', size: 1 }] }, { attachments: [{ filename: 'a.pdf', size: 2 }] }],
		['cc', {}, { cc: 'new@y.z' }],
		['subject', {}, { subject: 'Different' }],
	];
	it.each(changes)('a changed %s after the card is not sent', async (_name, before, after) => {
		const t = setup(draft(before));
		await t.svc.onHeld(hold());
		t.edit(draft(after));
		await t.svc.onSettled(t.settle('D-1', GMAIL_SEND_KEYS.SEND));
		expect(t.gmail.sendDraft).not.toHaveBeenCalled();
	});

	it('only the owner Discard deletes: discarded() settles the card and the agent is told it was deleted', async () => {
		const { svc, gmail, decisions } = setup();
		await svc.onHeld(hold());
		decisions.chooseFromDashboard.mockResolvedValue({});
		await svc.discarded('lyra:d1');
		expect(decisions.chooseFromDashboard).toHaveBeenCalledWith('D-1', GMAIL_SEND_KEYS.NOT_NOW);
		expect(gmail.deleteDraft).not.toHaveBeenCalled(); // deletion is the owner route's call, not the service's
	});

	it('with no card available it raises none (the draft stays held for the owner route)', async () => {
		const svc = new GmailSendApprovalService({
			gmailFor: () => setup().gmail,
			decisions: () => null,
			canAskInSlack: () => false,
			tellAgent: jest.fn(),
		});
		expect(await svc.onHeld(hold())).toBe(false);
	});
});
