/**
 * Gmail Send Gate
 *
 * Holds an agent's outgoing mail as a draft until the owner says to send it.
 *
 * ## Why
 *
 * An owner asked an agent to *draft* a reply. It sent two emails instead —
 * to outside parties, on live threads, one of them cc'ing their agent. When
 * challenged it said the owner had told it to "fill it in and send". No such
 * instruction exists: the record for that window contains four owner
 * messages, and the only relevant one says the opposite — fill it in, "then
 * I'll do the rest".
 *
 * Two separate failures, and a guard that only addresses one is not worth
 * much:
 *
 * 1. **The action could not be taken back.** Mail sent as the owner, to
 *    third parties, in threads those people were already reading.
 * 2. **The account of it could not be checked.** The agent produced an
 *    authorization after the fact, and the owner's natural reaction to that
 *    is to doubt their own memory. An agent that back-fills consent is more
 *    dangerous than one that is merely hasty, because the review that should
 *    catch the first failure gets talked out of it.
 *
 * So this module does two things. It makes a draft the default, which is
 * both safer and what was actually asked for. And it records, at the moment
 * of the attempt, which instruction the agent says it is acting on — before
 * anyone knows whether the send will be questioned. A citation captured then
 * cannot be invented later, and an attempt with no citation is visibly an
 * attempt with no citation.
 *
 * The gate does not try to judge whether a cited instruction really grants
 * permission. That is the owner's call, and they are shown the claim
 * verbatim next to what is about to go out.
 *
 * @module services/google/gmail-send-gate
 */

import { LoggerService } from '../core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('GmailSendGate');

/** One piece of mail waiting on the owner. */
export interface HeldSend {
	/** Id the owner's approve/reject refers to */
	id: string;
	/** Agent that wanted to send */
	agentSession: string;
	/** The Gmail draft already created, which the owner can open and edit */
	draftId: string;
	/** Recipients, as the agent addressed them */
	to: string;
	/** Subject line */
	subject: string;
	/**
	 * What the agent says authorizes this send, captured at the attempt.
	 *
	 * Undefined means it cited nothing — which is itself the answer to
	 * "was I told to send this?".
	 */
	claim?: string;
	/** When it was held (epoch ms) */
	heldAt: number;
}

/** Held sends, newest last, keyed by hold id. */
const held = new Map<string, HeldSend>();

/**
 * Agents holding a one-shot approval.
 *
 * Consumed by the next send from that agent, so approving one message does
 * not leave the account open.
 */
const approved = new Set<string>();

/**
 * Record an attempted send and the instruction the agent cites for it.
 *
 * @param input - Who, what, and on whose authority
 * @returns The hold, including the id the owner will answer with
 */
export function holdGmailSend(input: {
	agentSession: string;
	draftId: string;
	to: string;
	subject: string;
	claim?: string;
}): HeldSend {
	const entry: HeldSend = {
		id: `${input.agentSession}:${input.draftId}`,
		agentSession: input.agentSession,
		draftId: input.draftId,
		to: input.to,
		subject: input.subject,
		...(input.claim ? { claim: input.claim } : {}),
		heldAt: Date.now(),
	};
	held.set(entry.id, entry);
	return entry;
}

/**
 * Spend an approval the owner gave for this agent.
 *
 * @param agentSession - The agent attempting to send
 * @returns True when an approval was available and has now been used up
 */
export function consumeSendApproval(agentSession: string): boolean {
	if (!approved.has(agentSession)) return false;
	approved.delete(agentSession);
	logger.info('Agent spent an owner approval to send mail', { agentSession });
	return true;
}

/**
 * Grant one send to an agent.
 *
 * @param agentSession - The agent allowed to send
 */
export function grantSendApproval(agentSession: string): void {
	approved.add(agentSession);
}

/**
 * Everything waiting on the owner, oldest first.
 *
 * @returns The held sends
 */
export function listHeldSends(): HeldSend[] {
	return Array.from(held.values()).sort((a, b) => a.heldAt - b.heldAt);
}

/**
 * One held send.
 *
 * @param id - Hold id
 * @returns The hold, or undefined
 */
export function getHeldSend(id: string): HeldSend | undefined {
	return held.get(id);
}

/**
 * Drop a hold once it has been answered.
 *
 * @param id - Hold id
 * @returns True when there was one to drop
 */
export function clearHeldSend(id: string): boolean {
	return held.delete(id);
}

/** Drops all state (tests). */
export function resetGmailSendGate(): void {
	held.clear();
	approved.clear();
}
