/**
 * Asks the owner, over Slack, for the one-time consent an agent runtime needs.
 *
 * Claude Code asks once per computer to accept Bypass Permissions mode, which
 * every Crewly agent runs in. On a new machine no agent can start until that
 * screen is answered, and the owner is usually not at the machine
 * (Windows host, 2026-11-19: the agents sat on it and Crewly kept restarting
 * them). The choice stays the owner's: Crewly sends one DM that says what the
 * mode means, and only an explicit reply makes it choose "Yes, I accept"
 * (bypass-consent-acceptor.ts) and start the waiting agents.
 *
 * The reply must be the whole message and must name the consent
 * (`accept bypass`, 「同意跳过权限」, or Claude Code's own "Yes, I accept"). A
 * bare "yes" or 「同意」 is not taken: the owner answers many other questions
 * in the same DM.
 *
 * Several machines of one account share the owner's DM with the Crewly bot,
 * and Cloud sends a reply there to the account's primary machine only
 * (2026-11-19: the Windows host asked, the MacBook got `accept bypass` and its
 * orchestrator answered "what do you mean?"). So a machine that gets such a
 * reply while it is not waiting itself passes it to the account's other
 * machines ({@link ConsentSiblingRelay}); the one that asked applies it and
 * confirms, and when none does the owner is told that nothing is waiting.
 *
 * @module services/harness/runtime-consent
 */

import { randomUUID } from 'crypto';
import * as os from 'os';
import { RUNTIME_CONSENT_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import { acceptBypassConsent, type BypassConsentResult } from './bypass-consent-acceptor.js';
import type { ReloginOwnerNotifier, ReloginReplyTarget } from './harness-relogin.service.js';

/** Minimal logger surface. */
type ConsentLogger = { info: (message: string, meta?: Record<string, unknown>) => void; warn: (message: string, meta?: Record<string, unknown>) => void };

/** What the owner's reply means. */
export type ConsentReply = 'accept' | 'decline';

/** Passes an owner's answer to the account's other machines (runtime-consent.relay.ts). */
export interface ConsentSiblingRelay {
	/**
	 * Whether the account has another machine that could be the one waiting.
	 *
	 * @returns True when a forward could reach someone
	 */
	hasSiblings(): boolean;
	/**
	 * Send the answer to every other machine of the account.
	 *
	 * @param forward - The answer, where the owner wrote it, and an id for the confirmation
	 * @returns How many machines it was sent to
	 */
	forward(forward: { id: string; reply: ConsentReply; target: ReloginReplyTarget | null; inThread: boolean }): Promise<number>;
}

/** Injectable dependencies. */
export interface RuntimeConsentDeps {
	/** Reaches the account's other machines; absent = answers are only taken locally */
	siblings?: ConsentSiblingRelay | null;
	/** Id for a forwarded answer (default: random UUID) */
	newId?: () => string;
	notifier?: ReloginOwnerNotifier | null;
	/** Chooses "Yes, I accept" (default: {@link acceptBypassConsent}) */
	accept?: () => Promise<BypassConsentResult>;
	/** Starts the agents that waited on the consent */
	resume?: ((sessionNames: readonly string[]) => Promise<{ resumed: string[]; failed: string[] }>) | null;
	machineName?: () => string;
	now?: () => number;
	logger?: ConsentLogger;
}

/** A consent the owner has been asked for. */
interface PendingConsent {
	sessions: Set<string>;
	askedAt: number;
	phase: 'asked' | 'accepting';
	/** Where the question was posted (null when unknown): replies in another thread are not for it */
	ask: { channelId: string; messageTs: string } | null;
}

/**
 * Normalise a DM for matching: drop Slack mention markup, quotes and end
 * punctuation, collapse whitespace, lower-case.
 *
 * @param text - Raw message text
 * @returns Normalised text
 */
export function normaliseConsentText(text: string): string {
	return text
		.replace(/<@[A-Z0-9]+>/g, ' ')
		.replace(/[「」“”"'`]/g, ' ')
		.replace(/[.。!！~～]+\s*$/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}

/**
 * Read an owner's DM as an answer to the consent question.
 *
 * @param text - Message text
 * @returns `accept`, `decline`, or null when it is not an answer
 *
 * @example
 * ```ts
 * parseConsentReply('Accept bypass'); // 'accept'
 * parseConsentReply('同意'); // null — does not name the consent
 * ```
 */
export function parseConsentReply(text: string): ConsentReply | null {
	if (typeof text !== 'string') return null;
	const norm = normaliseConsentText(text);
	// Decline first: 「不同意跳过权限」 contains the accept phrase.
	if (RUNTIME_CONSENT_CONSTANTS.DECLINE_PATTERN.test(norm)) return 'decline';
	if (RUNTIME_CONSENT_CONSTANTS.ACCEPT_PATTERN.test(norm)) return 'accept';
	return null;
}

/**
 * Whether an owner's reply can be an answer to a question this machine posted.
 *
 * Two machines of one account can be waiting at the same time, each with its
 * own question in the owner's DMs. A reply written in the thread of one
 * question is for that machine only (2026-11-19: the reply under the Windows
 * host's question was applied on the MacBook). A reply outside any thread, or
 * when the place of the question is not known, is taken.
 *
 * @param ask - Where this machine's question was posted, or null
 * @param target - Where the owner wrote (its `threadTs` is the reply's own timestamp outside a thread)
 * @param inThread - Whether the owner wrote inside a thread
 * @returns False only when the reply is in a different thread
 */
export function isReplyToAsk(ask: { channelId: string; messageTs: string } | null, target: ReloginReplyTarget | null, inThread: boolean): boolean {
	if (!ask || !inThread || !target?.threadTs) return true;
	return target.channelId === ask.channelId && target.threadTs === ask.messageTs;
}

/**
 * The DM that asks for the consent.
 *
 * @param machine - This machine's name
 * @param waiting - How many agents wait on it
 * @returns Slack mrkdwn text
 */
export function formatConsentAskDm(machine: string, waiting: number): string {
	const who = waiting > 1 ? `${waiting} agents are` : 'An agent is';
	return [
		`*Claude Code on ${machine} needs your OK before agents can start.* ${who} waiting.`,
		'Claude Code asks once per computer to accept Bypass Permissions mode. In that mode an agent runs commands and changes files on that computer without asking each time. Every Crewly agent runs this way.',
		'Claude Code\'s own warning: it "will not ask for your approval before running potentially dangerous commands", and by proceeding you accept responsibility for what is done in this mode.',
		'Reply `accept bypass` (or 「同意跳过权限」) and I will choose "Yes, I accept" there and start the agents.',
		'Reply `decline bypass` (or 「不同意跳过权限」) to leave them stopped.',
	].join('\n');
}

/**
 * The DM after the consent was accepted and the agents were started.
 *
 * @param machine - This machine's name
 * @param result - Which agents came back
 * @returns Slack mrkdwn text
 */
export function formatConsentDoneDm(machine: string, result: { resumed: string[]; failed: string[] }): string {
	const lines = [`Accepted Bypass Permissions mode on ${machine}.`];
	if (result.resumed.length > 0) lines.push(`Started: ${result.resumed.join(', ')}.`);
	if (result.failed.length > 0) lines.push(`Could not start: ${result.failed.join(', ')}. Start the team again from the dashboard.`);
	if (result.resumed.length === 0 && result.failed.length === 0) lines.push('Start the team again from the dashboard.');
	return lines.join('\n');
}

/**
 * The DM when Crewly could not answer the consent screen.
 *
 * @param machine - This machine's name
 * @returns Slack mrkdwn text
 */
export function formatConsentFailedDm(machine: string): string {
	return `I could not accept Bypass Permissions mode on ${machine} for you. In a terminal on that computer run \`claude --dangerously-skip-permissions\` once, choose "Yes, I accept", exit, then start the team again.`;
}

/** Asks for, and applies, the owner's runtime consent. */
export class RuntimeConsentService {
	private notifier: ReloginOwnerNotifier | null;
	private resume: RuntimeConsentDeps['resume'];
	private siblings: ConsentSiblingRelay | null;
	private readonly newId: () => string;
	/** Forwarded answers no machine has confirmed yet (id → timer) */
	private readonly awaitingSibling = new Map<string, NodeJS.Timeout>();
	private readonly accept: () => Promise<BypassConsentResult>;
	private readonly machineName: () => string;
	private readonly now: () => number;
	private readonly logger: ConsentLogger;
	private pending: PendingConsent | null = null;
	/** When Crewly last answered the consent screen (0 = never) */
	private lastAcceptAt = 0;
	/** The "did not hold" DM was sent for the last attempt */
	private toldNotHeld = false;

	/**
	 * @param deps - Injectable dependencies
	 */
	constructor(deps: RuntimeConsentDeps = {}) {
		this.notifier = deps.notifier ?? null;
		this.resume = deps.resume ?? null;
		this.siblings = deps.siblings ?? null;
		this.newId = deps.newId ?? randomUUID;
		this.accept = deps.accept ?? (() => acceptBypassConsent());
		this.machineName = deps.machineName ?? (() => os.hostname());
		this.now = deps.now ?? Date.now;
		this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('RuntimeConsent');
	}

	/**
	 * Set how the owner is reached.
	 *
	 * @param notifier - Owner DM sender
	 */
	setNotifier(notifier: ReloginOwnerNotifier | null): void {
		this.notifier = notifier;
	}

	/**
	 * Set how waiting agents are started after the consent.
	 *
	 * @param resume - Starts the given sessions
	 */
	setResumer(resume: RuntimeConsentDeps['resume']): void {
		this.resume = resume ?? null;
	}

	/**
	 * Set how the account's other machines are reached.
	 *
	 * @param siblings - Sibling relay, or null for local answers only
	 */
	setSiblings(siblings: ConsentSiblingRelay | null): void {
		this.siblings = siblings;
	}

	/**
	 * Whether the owner has been asked and has not answered yet.
	 *
	 * @returns True while a question is open
	 */
	isPending(): boolean {
		return this.currentPending() !== null;
	}

	/**
	 * An agent could not start because Claude Code shows the consent screen.
	 * Asks the owner once; further agents join the same question.
	 *
	 * @param sessionName - The agent session that is waiting
	 * @returns True when the owner has been (or already was) asked
	 */
	async request(sessionName: string): Promise<boolean> {
		const open = this.currentPending();
		if (open) {
			open.sessions.add(sessionName);
			return true;
		}
		const machine = this.machineName();
		// The screen came back right after Crewly answered it: asking again
		// would loop. Say once that it has to be done at the machine.
		if (this.lastAcceptAt > 0 && this.now() - this.lastAcceptAt < RUNTIME_CONSENT_CONSTANTS.REASK_GUARD_MS) {
			if (!this.toldNotHeld) {
				this.toldNotHeld = true;
				this.logger.warn('Bypass consent shown again after it was answered; not asking again', { sessionName });
				await this.send(formatConsentFailedDm(machine));
			}
			return false;
		}
		if (!this.notifier || this.notifier.isAvailable?.() === false) {
			this.logger.info('Bypass consent needed but the owner cannot be reached over Slack', { sessionName });
			return false;
		}
		// Claim the question before the DM goes out, so agents that fail in the
		// same moment join it instead of sending a second DM.
		const pending: PendingConsent = { sessions: new Set([sessionName]), askedAt: this.now(), phase: 'asked', ask: null };
		this.pending = pending;
		const delivered = await this.sendAsk(pending, formatConsentAskDm(machine, pending.sessions.size));
		if (!delivered) {
			if (this.pending === pending) this.pending = null;
			return false;
		}
		this.logger.info('Asked the owner to accept Bypass Permissions mode', { sessionName });
		return true;
	}

	/**
	 * Offer an owner DM to the consent question. Text that does not answer it
	 * is left for the next handler.
	 *
	 * @param text - Message text
	 * @param target - Conversation the owner wrote in (answers go there)
	 * @param inThread - Whether the owner wrote inside a thread (then only the machine whose question it is takes it)
	 * @returns True when consumed; the caller must then NOT pass it on as a chat message
	 */
	handleOwnerReply(text: string, target: ReloginReplyTarget | null = null, inThread: boolean = false): boolean {
		const reply = parseConsentReply(text);
		if (!reply) return false;
		const pending = this.currentPending();
		if (pending && isReplyToAsk(pending.ask, target, inThread)) return this.applyReply(pending, reply, target);
		// Not waiting here, or the reply is in the thread of a question this
		// machine did not post: another machine of the account asked it.
		if (!this.siblings || !this.safeHasSiblings()) return false;
		void this.forwardToSiblings(reply, target, inThread);
		return true;
	}

	/**
	 * An owner's answer another machine of the account received and passed on.
	 *
	 * @param reply - The answer
	 * @param target - Conversation the owner wrote in (answers go there)
	 * @param inThread - Whether the owner wrote inside a thread
	 * @returns True when this machine was waiting and took it
	 */
	handleSiblingReply(reply: ConsentReply, target: ReloginReplyTarget | null = null, inThread: boolean = false): boolean {
		const pending = this.currentPending();
		if (!pending || !isReplyToAsk(pending.ask, target, inThread)) return false;
		this.logger.info('Owner answer for the Bypass Permissions consent arrived from another machine', { reply });
		return this.applyReply(pending, reply, target);
	}

	/**
	 * Another machine confirmed it took a forwarded answer.
	 *
	 * @param id - Id of the forward
	 */
	handleSiblingAck(id: string): void {
		const timer = this.awaitingSibling.get(id);
		if (!timer) return;
		clearTimeout(timer);
		this.awaitingSibling.delete(id);
	}

	/**
	 * Apply an answer to the open question.
	 *
	 * @param pending - The open question
	 * @param reply - The answer
	 * @param target - Conversation to answer in
	 * @returns True (the answer is consumed)
	 */
	private applyReply(pending: PendingConsent, reply: ConsentReply, target: ReloginReplyTarget | null): boolean {
		// A second answer while the first is being applied changes nothing.
		if (pending.phase === 'accepting') return true;
		if (reply === 'decline') {
			this.pending = null;
			this.logger.info('Owner declined Bypass Permissions mode');
			void this.send(`OK. Bypass Permissions mode is not accepted on ${this.machineName()} and the agents there stay stopped. Start the team again when you want to be asked again.`, target);
			return true;
		}
		pending.phase = 'accepting';
		void this.applyAccept(pending, target);
		return true;
	}

	/**
	 * Pass an answer to the account's other machines, and tell the owner when
	 * none of them was waiting for it.
	 *
	 * @param reply - The answer
	 * @param target - Conversation the owner wrote in
	 * @param inThread - Whether the owner wrote inside a thread
	 */
	private async forwardToSiblings(reply: ConsentReply, target: ReloginReplyTarget | null, inThread: boolean): Promise<void> {
		const id = this.newId();
		const timer = setTimeout(() => {
			this.awaitingSibling.delete(id);
			void this.send(RUNTIME_CONSENT_CONSTANTS.NOBODY_WAITING_TEXT, target);
		}, RUNTIME_CONSENT_CONSTANTS.SIBLING_ACK_WAIT_MS);
		timer.unref?.();
		this.awaitingSibling.set(id, timer);
		let sent = 0;
		try {
			sent = (await this.siblings?.forward({ id, reply, target, inThread })) ?? 0;
		} catch (error) {
			this.logger.warn('Could not pass the consent answer to the other machines', { error: error instanceof Error ? error.message : String(error) });
		}
		this.logger.info('Consent answer passed to the account\'s other machines', { reply, sent });
		if (sent === 0 && this.awaitingSibling.has(id)) {
			this.handleSiblingAck(id);
			await this.send(RUNTIME_CONSENT_CONSTANTS.NOBODY_WAITING_TEXT, target);
		}
	}

	/**
	 * {@link ConsentSiblingRelay.hasSiblings}, never throwing.
	 *
	 * @returns True when another machine may be waiting
	 */
	private safeHasSiblings(): boolean {
		try {
			return this.siblings?.hasSiblings() === true;
		} catch {
			return false;
		}
	}

	/**
	 * Answer the consent screen, start the waiting agents and tell the owner.
	 *
	 * @param pending - The open question
	 * @param target - Conversation to answer in
	 */
	private async applyAccept(pending: PendingConsent, target: ReloginReplyTarget | null): Promise<void> {
		const machine = this.machineName();
		this.logger.info('Owner accepted Bypass Permissions mode over Slack', { waiting: pending.sessions.size });
		let result: BypassConsentResult;
		try {
			result = await this.accept();
		} catch (error) {
			result = { outcome: 'failed', detail: error instanceof Error ? error.message : String(error) };
		}
		this.lastAcceptAt = this.now();
		this.toldNotHeld = false;
		const sessions = [...pending.sessions];
		if (this.pending === pending) this.pending = null;
		this.logger.info('Bypass consent attempt finished', { outcome: result.outcome, detail: result.detail });
		if (result.outcome === 'failed') {
			this.toldNotHeld = true;
			await this.send(formatConsentFailedDm(machine), target);
			return;
		}
		let started: { resumed: string[]; failed: string[] } = { resumed: [], failed: [] };
		if (this.resume) {
			try {
				started = await this.resume(sessions);
			} catch (error) {
				this.logger.warn('Could not start agents after the consent', { error: error instanceof Error ? error.message : String(error) });
				started = { resumed: [], failed: sessions };
			}
		}
		await this.send(formatConsentDoneDm(machine, started), target);
	}

	/**
	 * The open question, dropping one the owner never answered.
	 *
	 * @returns The pending consent, or null
	 */
	private currentPending(): PendingConsent | null {
		if (this.pending && this.pending.phase === 'asked' && this.now() - this.pending.askedAt > RUNTIME_CONSENT_CONSTANTS.ASK_TTL_MS) {
			this.pending = null;
		}
		return this.pending;
	}

	/**
	 * Post the question and remember where it landed.
	 *
	 * @param pending - The question being asked
	 * @param text - Message
	 * @returns True when delivered
	 */
	private async sendAsk(pending: PendingConsent, text: string): Promise<boolean> {
		if (!this.notifier?.sendToOwnerTracked) return this.send(text);
		try {
			const { delivery, messageTs } = await this.notifier.sendToOwnerTracked(text, null);
			if (delivery && typeof delivery === 'object' && messageTs) pending.ask = { channelId: delivery.channelId, messageTs };
			return Boolean(delivery);
		} catch (error) {
			this.logger.warn('Could not DM the owner about the consent', { error: error instanceof Error ? error.message : String(error) });
			return false;
		}
	}

	/**
	 * DM the owner, never throwing.
	 *
	 * @param text - Message
	 * @param target - Conversation to answer in
	 * @returns True when delivered
	 */
	private async send(text: string, target: ReloginReplyTarget | null = null): Promise<boolean> {
		if (!this.notifier) return false;
		try {
			return Boolean(await this.notifier.sendToOwner(text, target));
		} catch (error) {
			this.logger.warn('Could not DM the owner about the consent', { error: error instanceof Error ? error.message : String(error) });
			return false;
		}
	}
}

let instance: RuntimeConsentService | null = null;

/**
 * The process-wide consent service.
 *
 * @returns The singleton
 */
export function getRuntimeConsentService(): RuntimeConsentService {
	if (!instance) instance = new RuntimeConsentService();
	return instance;
}

/**
 * Replace the singleton (tests).
 *
 * @param service - Instance to use, or null to reset
 */
export function setRuntimeConsentServiceForTesting(service: RuntimeConsentService | null): void {
	instance = service;
}
