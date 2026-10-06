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

import fs from 'node:fs';
import path from 'node:path';

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
	/** Google account the draft lives in (X-Google-Account), when not the default */
	account?: string;
	/** sha256 of the draft's to/cc/subject/body when the owner was asked; an edit changes it */
	fingerprint?: string;
	/** The decision card the owner answers */
	decisionId?: string;
}

/** Held sends, newest last, keyed by hold id. */
const held = new Map<string, HeldSend>();

/** Where holds are persisted (set at startup); undefined = memory only. */
let storeFile: string | undefined;

/** Decision ids already acted on (bounded, persisted) so a repeat settle is not mistaken for a lost hold. */
const SETTLED_MAX = 200;
let settled: string[] = [];

/** Remember that a card's answer has been acted on. */
export function markSettled(decisionId: string): void {
	settled = [...settled.filter((d) => d !== decisionId), decisionId].slice(-SETTLED_MAX);
	persist();
}

/** True when this card's answer was already acted on. */
export function wasSettled(decisionId: string): boolean {
	return settled.includes(decisionId);
}

/**
 * Write the holds to disk (tmp + rename). A card waits up to 24 h and every
 * release restarts the backend, so a hold kept only in memory would be lost
 * while its card still shows Yes. Failure is swallowed: the in-memory hold
 * still works until the next restart.
 */
function persist(): void {
	if (!storeFile) return;
	try {
		fs.mkdirSync(path.dirname(storeFile), { recursive: true });
		const tmp = `${storeFile}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ holds: Array.from(held.values()), settled }, null, 2));
		fs.renameSync(tmp, storeFile);
	} catch {
		/* best effort */
	}
}

/**
 * Persist holds to `file` and load whatever is already there (call once at
 * startup, before cards can settle).
 *
 * @param file - JSON file, e.g. ~/.crewly/gmail-send-holds.json
 * @returns Number of holds loaded
 */
export function loadHeldSends(file: string): number {
	storeFile = file;
	held.clear();
	settled = [];
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { holds?: HeldSend[]; settled?: string[] };
		if (Array.isArray(parsed.settled)) settled = parsed.settled.filter((x) => typeof x === 'string');
		for (const h of Array.isArray(parsed.holds) ? parsed.holds : []) {
			if (h && typeof h.id === 'string' && typeof h.draftId === 'string') held.set(h.id, h);
		}
	} catch {
		/* no file yet */
	}
	return held.size;
}

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
	account?: string;
}): HeldSend {
	const entry: HeldSend = {
		id: `${input.agentSession}:${input.draftId}`,
		agentSession: input.agentSession,
		draftId: input.draftId,
		to: input.to,
		subject: input.subject,
		...(input.claim ? { claim: input.claim } : {}),
		...(input.account ? { account: input.account } : {}),
		heldAt: Date.now(),
	};
	held.set(entry.id, entry);
	persist();
	return entry;
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
 * Merge fields into a hold (the fingerprint and card id once the owner has
 * been asked).
 *
 * @param id - Hold id
 * @param patch - Fields to set
 * @returns The updated hold, or undefined when there is none
 */
export function updateHeldSend(id: string, patch: Partial<Pick<HeldSend, 'fingerprint' | 'decisionId'>>): HeldSend | undefined {
	const cur = held.get(id);
	if (!cur) return undefined;
	const next = { ...cur, ...patch };
	held.set(id, next);
	persist();
	return next;
}

/**
 * Drop a hold once it has been answered.
 *
 * @param id - Hold id
 * @returns True when there was one to drop
 */
export function clearHeldSend(id: string): boolean {
	const had = held.delete(id);
	if (had) persist();
	return had;
}

/** Drops all state (tests). */
export function resetGmailSendGate(): void {
	held.clear();
	settled = [];
	storeFile = undefined;
}
