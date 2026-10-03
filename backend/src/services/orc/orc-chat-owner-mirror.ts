/**
 * The orchestrator's own chat and the away owner (crewly#1015 §11).
 *
 * The orchestrator's chat-v2 DM (the dashboard "Orchestrator" chat, e.g.
 * `a721f48d`) has no Slack link: Slack DMs to the orc reach it through the
 * bridge as `slack-…` conversations. An answer the orchestrator posts there
 * to a question the owner asked there, after the owner has left, never
 * reached an owner who lives in Slack.
 *
 * {@link mirrorOrcChatPostToOwner} also DMs such an answer to the owner from
 * this machine's orchestrator bot. Only real answers (review H1):
 * - not interim notes or bare acknowledgements;
 * - only when the orchestrator's current turn is the owner's message in that
 *   very chat — never a reply to a system event;
 * - not when the conversation already reaches the owner elsewhere (a Slack
 *   thread, a Slack-linked DM, a mapped room, a Telegram / Google Chat /
 *   WhatsApp thread), nor while the owner is using that chat;
 * - the same text in the same conversation once; at most one DM per
 *   conversation per MIN_INTERVAL_MS, later ones batched into the next.
 *
 * @module services/orc/orc-chat-owner-mirror
 * @see specs/2026-10-03-harness-drop-gaps.md §11
 */

import { createHash } from 'crypto';
import { ORC_CHAT_OWNER_MIRROR_CONSTANTS as C, ORCHESTRATOR_SESSION_NAME, REPLY_ROUTING_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import { isAcknowledgement } from '../messaging/owner-message-watchdog.service.js';
import { parseInboundOrigin } from './orc-reply-route.service.js';

/** What the mirror decision depends on. */
export interface OrcChatMirrorInput {
	/** Conversation (chat-v2 channel) the orchestrator posted in */
	conversationId: string;
	/** What it posted */
	text: string;
	/** Posted as an interim note ("working on it") */
	interim: boolean;
	/** The orchestrator's current turn is the owner's message in this conversation */
	answersOwnerHere: boolean;
	/** The conversation is a Slack-linked agent DM */
	slackLinkedDm: boolean;
	/** The conversation is a Slack-mapped room */
	slackMappedRoom: boolean;
	/** Surface of the owner's latest message there (null: never) */
	ownerSource: string | null;
	/** When the owner last wrote there (epoch ms; null: never) */
	ownerAt: number | null;
	/** Now (epoch ms) */
	now: number;
}

/**
 * Whether an orchestrator post in a conversation must also be DMed to the owner.
 *
 * @param input - See {@link OrcChatMirrorInput}
 * @returns The decision and why (logged)
 */
export function shouldMirrorOrcChatToOwner(input: OrcChatMirrorInput): { mirror: boolean; reason: string } {
	if (!input.conversationId) return { mirror: false, reason: 'no conversation' };
	const id = input.conversationId.toLowerCase();
	if (id.startsWith('slack-')) return { mirror: false, reason: 'slack thread' };
	if (C.OTHER_MESSENGER_PREFIXES.some((p) => id.startsWith(p))) return { mirror: false, reason: 'another messenger' };
	if (input.ownerSource && (C.OTHER_MESSENGER_SOURCES as readonly string[]).includes(input.ownerSource)) {
		return { mirror: false, reason: 'another messenger' };
	}
	if (input.slackLinkedDm) return { mirror: false, reason: 'slack-linked dm' };
	if (input.slackMappedRoom) return { mirror: false, reason: 'slack room' };
	if (input.interim) return { mirror: false, reason: 'interim note' };
	if (isAcknowledgement(input.text)) return { mirror: false, reason: 'acknowledgement' };
	if (!input.answersOwnerHere) return { mirror: false, reason: 'not an answer to the owner here' };
	if (input.ownerSource !== null && input.ownerSource !== 'slack' && input.ownerAt !== null) {
		if (input.now - input.ownerAt < REPLY_ROUTING_CONSTANTS.DM_AFFINITY_FRESH_MS) {
			return { mirror: false, reason: 'owner is here' };
		}
	}
	return { mirror: true, reason: 'owner not here' };
}

/** Injected behaviour (defaults talk to the running backend). */
export interface OrcChatMirrorDeps {
	isSlackConnected: () => boolean;
	isSlackLinkedDm: (conversationId: string) => boolean;
	isSlackMappedRoom: (conversationId: string) => boolean;
	ownerSource: (conversationId: string) => string | null;
	ownerAt: (conversationId: string) => number | null;
	/** The last message delivered to the orchestrator (its current turn), if known */
	lastDeliveredToOrc: () => string | undefined;
	/** DM the owner from this machine's orchestrator bot; truthy when sent */
	sendToOwner: (text: string) => Promise<unknown>;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => unknown;
}

const logger = LoggerService.getInstance().createComponentLogger('OrcChatOwnerMirror');

/**
 * Rate-limited, de-duplicated mirror of orchestrator answers to the owner's DM.
 */
export class OrcChatOwnerMirror {
	/** conversation → last DM time, and texts waiting for the next one */
	private readonly perConversation = new Map<string, { lastSentAt: number; pending: string[]; flushScheduled: boolean }>();
	/** `<conversation>\0<text hash>` → when mirrored */
	private readonly seen = new Map<string, number>();

	/** @param deps - Injected behaviour */
	constructor(private readonly deps: OrcChatMirrorDeps) {}

	private now(): number {
		return this.deps.now ? this.deps.now() : Date.now();
	}

	/**
	 * Consider one orchestrator post. Never throws.
	 *
	 * @param conversationId - Conversation it was posted in
	 * @param text - What was posted
	 * @param opts - `interim`: an interim note
	 * @returns `sent`, `batched`, or why it was skipped
	 */
	async consider(conversationId: string, text: string, opts: { interim?: boolean } = {}): Promise<string> {
		try {
			if (!this.deps.isSlackConnected()) return 'slack not connected';
			const origin = parseInboundOrigin(this.deps.lastDeliveredToOrc() ?? '');
			const decision = shouldMirrorOrcChatToOwner({
				conversationId,
				text,
				interim: opts.interim === true,
				answersOwnerHere: !!origin && origin.conversationId === conversationId,
				slackLinkedDm: this.deps.isSlackLinkedDm(conversationId),
				slackMappedRoom: this.deps.isSlackMappedRoom(conversationId),
				ownerSource: this.deps.ownerSource(conversationId),
				ownerAt: this.deps.ownerAt(conversationId),
				now: this.now(),
			});
			if (!decision.mirror) {
				logger.debug('Orchestrator chat post not mirrored to the owner', { conversationId, reason: decision.reason });
				return decision.reason;
			}
			const now = this.now();
			for (const [k, at] of this.seen) if (now - at > C.DEDUPE_WINDOW_MS) this.seen.delete(k);
			const key = `${conversationId}\0${createHash('sha1').update(text.replace(/\s+/g, ' ').trim()).digest('hex')}`;
			if (this.seen.has(key)) return 'duplicate';
			this.seen.set(key, now);
			const state = this.perConversation.get(conversationId) ?? { lastSentAt: Number.NEGATIVE_INFINITY, pending: [], flushScheduled: false };
			this.perConversation.set(conversationId, state);
			if (now - state.lastSentAt < C.MIN_INTERVAL_MS) {
				state.pending.push(text);
				if (!state.flushScheduled) {
					state.flushScheduled = true;
					const wait = Math.max(0, state.lastSentAt + C.MIN_INTERVAL_MS - now);
					const timer = (this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => void this.flush(conversationId), wait);
					(timer as { unref?: () => void } | null)?.unref?.();
				}
				return 'batched';
			}
			state.lastSentAt = now;
			const sent = await this.deps.sendToOwner(text);
			logger.info('Orchestrator answer DMed to the owner (they are not looking at that chat)', { conversationId, sent: !!sent });
			return sent ? 'sent' : 'not sent';
		} catch (err) {
			logger.warn('Could not DM the orchestrator chat post to the owner', { conversationId, error: err instanceof Error ? err.message : String(err) });
			return 'error';
		}
	}

	private async flush(conversationId: string): Promise<void> {
		const state = this.perConversation.get(conversationId);
		if (!state) return;
		state.flushScheduled = false;
		if (state.pending.length === 0) return;
		const texts = state.pending.splice(0);
		state.lastSentAt = this.now();
		try {
			await this.deps.sendToOwner(texts.join('\n\n———\n\n'));
			logger.info('Orchestrator answers DMed to the owner in one batch', { conversationId, count: texts.length });
		} catch (err) {
			logger.warn('Could not DM batched orchestrator answers to the owner', { conversationId, error: err instanceof Error ? err.message : String(err) });
		}
	}
}

let instance: OrcChatOwnerMirror | null = null;

/**
 * DM an orchestrator answer in its own chat to the owner when they are not
 * looking at that chat (see the module doc). Never throws.
 *
 * @param conversationId - Conversation the orchestrator posted in
 * @param text - What it posted
 * @param opts - `interim`: an interim note
 * @returns What happened
 */
export async function mirrorOrcChatPostToOwner(conversationId: string, text: string, opts: { interim?: boolean } = {}): Promise<string> {
	try {
		if (!instance) instance = new OrcChatOwnerMirror(await defaultDeps());
		return await instance.consider(conversationId, text, opts);
	} catch (err) {
		logger.warn('Orchestrator chat mirror unavailable', { error: err instanceof Error ? err.message : String(err) });
		return 'error';
	}
}

async function defaultDeps(): Promise<OrcChatMirrorDeps> {
	const [{ getSlackService }, { getSlackAgentDmService }, { getSlackTeamChannelService }, { getSlackAgentIdentityService }, { SlackReloginDmService }, { getChatV2Service }, { OrcReplyRouteService }] =
		await Promise.all([
			import('../slack/slack.service.js'),
			import('../slack/slack-agent-dm.service.js'),
			import('../slack/slack-team-channel.service.js'),
			import('../slack/slack-agent-identity.service.js'),
			import('../slack/slack-relogin-dm.service.js'),
			import('../chat-v2/chat-v2.singleton.js'),
			import('./orc-reply-route.service.js'),
		]);
	const dm = new SlackReloginDmService(
		() => getSlackService(),
		undefined,
		(agentSession) => getSlackAgentIdentityService()?.getInstalled(agentSession)?.botToken ?? null,
	);
	return {
		isSlackConnected: () => getSlackService().isConnected(),
		isSlackLinkedDm: (id) => !!getSlackAgentDmService()?.findByChatChannelId(id),
		isSlackMappedRoom: (id) => !!getSlackTeamChannelService()?.findByChatChannelId(id),
		ownerSource: (id) => getChatV2Service().getLatestOwnerTurnSource(id),
		ownerAt: (id) => getChatV2Service().getLatestOwnerTurnAt(id),
		lastDeliveredToOrc: () => OrcReplyRouteService.getInstance().getLastDelivered(ORCHESTRATOR_SESSION_NAME),
		// The orc's text is Slack mrkdwn already: links must not be escaped.
		sendToOwner: (text) => dm.sendToOwner(text, null, { title: 'Message from the orchestrator', raw: true }),
	};
}
