/**
 * Gmail Send Approval
 *
 * Puts a drafted email in front of the owner as a decision card and sends
 * it only when the owner taps Send (CREW-257,
 * specs/2026-10-06-gmail-approve-send-and-reply-wake.md).
 *
 * The send happens in exactly one place, {@link GmailSendApprovalService.onSettled},
 * which the decision service calls when an owner answer settles a
 * `gmail_send` card (button, reaction, thread reply, dashboard). Nothing an
 * agent can call reaches it, so an agent cannot approve its own mail.
 *
 * Each approval is bound to one hold (`agent:draftId`) and to a fingerprint
 * of the draft as the owner saw it. A hold settles once; a draft that was
 * edited after the card was raised is not sent, a new card is raised for the
 * edited text instead.
 *
 * @module services/google/gmail-send-approval
 */

import { createHash } from 'node:crypto';
import type { OwnerDecision, DecisionOption, GmailSendSubject } from '../../types/decision.types.js';
import type { DecisionKindHandler } from '../decisions/decision.service.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { GmailDraftContent, GmailSendResult } from './gmail.service.js';
import { clearHeldSend, getHeldSend, holdGmailSend, updateHeldSend, type HeldSend } from './gmail-send-gate.js';

/** Option keys on the card. */
export const GMAIL_SEND_KEYS = { SEND: 'send', DISCARD: 'discard' } as const;

/** How long the card waits before the (safe) default, Discard, applies. */
export const GMAIL_SEND_DEADLINE_MS = 24 * 60 * 60 * 1000;

/** Body characters shown on the card. */
const PREVIEW_CHARS = 700;

/** The Gmail calls the approval needs. */
export interface GmailDraftApi {
	getDraft(draftId: string): Promise<GmailDraftContent>;
	sendDraft(draftId: string): Promise<GmailSendResult>;
}

/** The decision-service surface used here. */
export interface GmailApprovalDecisions {
	askPrebuilt(ask: {
		kind: 'gmail_send';
		asker: string;
		question: string;
		options: DecisionOption[];
		defaultKey: string;
		yesKey: string;
		deadline: Date;
		sensitive: 'email';
		gmail: GmailSendSubject;
	}): Promise<OwnerDecision>;
	chooseFromDashboard(id: string, optionKey: string): Promise<OwnerDecision>;
	cancelWhere?(predicate: (d: OwnerDecision) => boolean, reason: string): Promise<unknown>;
}

/** Dependencies, injected so tests need no Slack or Google. */
export interface GmailSendApprovalDeps {
	/** Gmail access for the account the draft lives in */
	gmailFor: (account?: string) => GmailDraftApi;
	/** The decision service, once cards run */
	decisions: () => GmailApprovalDecisions | null;
	/** Whether a card can be posted at all */
	canAskInSlack: () => boolean;
	/** Tell the drafting agent what happened */
	tellAgent: (session: string, message: string) => Promise<unknown>;
	/** Display name for the card */
	agentNameOf?: (session: string) => Promise<string | undefined>;
	/** Called after a send so replies on the thread wake the agent */
	onSent?: (info: { threadId: string; agentSession: string; account?: string }) => Promise<void> | void;
}

/**
 * sha256 of everything the owner approves: recipients, subject and body.
 *
 * @param d - Draft content
 * @returns Hex digest
 */
export function fingerprintDraft(d: Pick<GmailDraftContent, 'to' | 'cc' | 'subject' | 'body'>): string {
	return createHash('sha256').update(JSON.stringify([d.to, d.cc, d.subject, d.body])).digest('hex');
}

/**
 * The card question: who it goes to, what it says.
 *
 * @param agentName - Drafting agent
 * @param d - The draft
 * @returns mrkdwn
 */
export function approvalQuestion(agentName: string, d: GmailDraftContent): string {
	const body = d.body.length > PREVIEW_CHARS ? `${d.body.slice(0, PREVIEW_CHARS)}…` : d.body;
	const cc = d.cc ? `\n*Cc:* ${d.cc}` : '';
	return `${agentName} drafted an email and wants it sent.\n*To:* ${d.to}${cc}\n*Subject:* ${d.subject}\n\n${body}`;
}

/**
 * Raises the send card and applies the owner's answer.
 */
export class GmailSendApprovalService implements DecisionKindHandler {
	private readonly logger: ComponentLogger;

	constructor(private readonly deps: GmailSendApprovalDeps) {
		this.logger = LoggerService.getInstance().createComponentLogger('GmailSendApproval');
	}

	/**
	 * A draft was held: read it, remember what the owner will be shown and ask.
	 *
	 * @param hold - The held send
	 * @returns True when a card was raised
	 */
	async onHeld(hold: HeldSend): Promise<boolean> {
		const decisions = this.deps.decisions();
		if (!decisions || !this.deps.canAskInSlack()) return false;
		const gmail = this.deps.gmailFor(hold.account);
		const draft = await gmail.getDraft(hold.draftId);
		const fingerprint = fingerprintDraft(draft);
		const agentName = (await this.deps.agentNameOf?.(hold.agentSession).catch(() => undefined)) ?? hold.agentSession;
		const decision = await decisions.askPrebuilt({
			kind: 'gmail_send',
			asker: hold.agentSession,
			question: approvalQuestion(agentName, draft),
			options: [
				{ key: GMAIL_SEND_KEYS.SEND, label: 'Send', detail: 'send exactly this email, once' },
				{ key: GMAIL_SEND_KEYS.DISCARD, label: "Don't send", detail: 'it stays a draft in Gmail' },
			],
			defaultKey: GMAIL_SEND_KEYS.DISCARD,
			yesKey: GMAIL_SEND_KEYS.SEND,
			deadline: new Date(Date.now() + GMAIL_SEND_DEADLINE_MS),
			sensitive: 'email',
			gmail: { agentSession: hold.agentSession, agentName, holdId: hold.id, draftId: hold.draftId, to: hold.to, subject: hold.subject },
		});
		updateHeldSend(hold.id, { fingerprint, decisionId: decision.id });
		this.logger.info('Asked the owner about a drafted email', { holdId: hold.id, decisionId: decision.id });
		return true;
	}

	/**
	 * The owner answered on the dashboard route: settle the card so it and the
	 * send agree.
	 *
	 * @param holdId - Hold id
	 * @param answer - What the owner chose
	 * @returns True when a card carried the answer
	 */
	async answerFromOwner(holdId: string, answer: 'send' | 'discard'): Promise<boolean> {
		const hold = getHeldSend(holdId);
		const decisions = this.deps.decisions();
		if (!hold?.decisionId || !decisions) return false;
		await decisions.chooseFromDashboard(hold.decisionId, answer === 'send' ? GMAIL_SEND_KEYS.SEND : GMAIL_SEND_KEYS.DISCARD);
		return true;
	}

	/**
	 * A `gmail_send` card settled. The only place a held draft is sent.
	 *
	 * @param decision - The settled decision
	 * @returns Note for the drafting agent, or null
	 */
	async onSettled(decision: OwnerDecision): Promise<string | null> {
		const subject = decision.gmail;
		if (!subject) return null;
		const hold = getHeldSend(subject.holdId);
		// Settles once: a second answer (or one for a hold lost to a restart) finds nothing.
		if (!hold || hold.decisionId !== decision.id) return null;

		if (decision.status !== 'resolved' || decision.chosenKey !== GMAIL_SEND_KEYS.SEND) {
			clearHeldSend(hold.id);
			this.logger.info('Owner did not send a drafted email', { holdId: hold.id, status: decision.status });
			return `[GMAIL] The owner chose not to send "${hold.subject}" to ${hold.to}. It stays a draft in Gmail. Do not send it another way.`;
		}

		const gmail = this.deps.gmailFor(hold.account);
		const current = await gmail.getDraft(hold.draftId);
		if (!hold.fingerprint || fingerprintDraft(current) !== hold.fingerprint) {
			// The text changed after the owner looked at it: that approval is for
			// a different email. Ask again, with what is there now.
			clearHeldSend(hold.id);
			const reheld = holdGmailSend({
				agentSession: hold.agentSession,
				draftId: hold.draftId,
				to: hold.to,
				subject: hold.subject,
				...(hold.claim ? { claim: hold.claim } : {}),
				...(hold.account ? { account: hold.account } : {}),
			});
			await this.onHeld(reheld);
			this.logger.warn('Drafted email changed after approval — not sent, asked again', { holdId: hold.id });
			return `[GMAIL] "${hold.subject}" was edited after the owner approved it, so it was NOT sent. A new card with the edited text is waiting for the owner.`;
		}

		const sent = await gmail.sendDraft(hold.draftId);
		clearHeldSend(hold.id);
		// Audit line: who, what, to whom, on which owner decision.
		this.logger.info('Owner approved a drafted email — sent', {
			holdId: hold.id,
			decisionId: decision.id,
			to: hold.to,
			subject: hold.subject,
			messageId: sent.id,
			threadId: sent.threadId,
			agentSession: hold.agentSession,
		});
		try {
			await this.deps.onSent?.({ threadId: sent.threadId, agentSession: hold.agentSession, ...(hold.account ? { account: hold.account } : {}) });
		} catch (err) {
			this.logger.warn('Could not watch the thread after sending', { threadId: sent.threadId, error: err instanceof Error ? err.message : String(err) });
		}
		return `[GMAIL] The owner approved and "${hold.subject}" was sent to ${hold.to} (thread ${sent.threadId}). Replies on that thread will wake you.`;
	}
}
