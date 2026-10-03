/**
 * The orchestrator's own chat and the away owner (crewly#1015 §11).
 *
 * The orchestrator's chat-v2 DM (the dashboard "Orchestrator" chat, e.g.
 * `a721f48d`) has no Slack link: Slack DMs to the orc reach it through the
 * bridge as `slack-…` conversations. A post the orchestrator makes into its
 * own chat — a proactive follow-up such as "Claude Code 的登录链接…登上了吗？"
 * (2026-09-28/29) — therefore never reached an owner who uses Slack.
 *
 * {@link mirrorOrcChatPostToOwner} also DMs such a post to the owner from
 * this machine's orchestrator bot, unless the owner wrote in that chat
 * outside Slack recently (they are looking at it), or the conversation
 * already reaches Slack (a Slack thread, a Slack-linked DM, a mapped room).
 *
 * @module services/orc/orc-chat-owner-mirror
 * @see specs/2026-10-03-harness-drop-gaps.md §11
 */

import { REPLY_ROUTING_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';

/** What the mirror decision depends on. */
export interface OrcChatMirrorInput {
	/** Conversation (chat-v2 channel) the orchestrator posted in */
	conversationId: string;
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
 *
 * @example
 * ```typescript
 * shouldMirrorOrcChatToOwner({ conversationId: 'a721f48d', slackLinkedDm: false, slackMappedRoom: false, ownerSource: null, ownerAt: null, now: Date.now() });
 * // { mirror: true, reason: 'owner not here' }
 * ```
 */
export function shouldMirrorOrcChatToOwner(input: OrcChatMirrorInput): { mirror: boolean; reason: string } {
	if (!input.conversationId) return { mirror: false, reason: 'no conversation' };
	if (input.conversationId.startsWith('slack-')) return { mirror: false, reason: 'slack thread' };
	if (input.slackLinkedDm) return { mirror: false, reason: 'slack-linked dm' };
	if (input.slackMappedRoom) return { mirror: false, reason: 'slack room' };
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
	/** DM the owner from this machine's orchestrator bot; truthy when sent */
	sendToOwner: (text: string) => Promise<unknown>;
	now?: () => number;
}

const logger = LoggerService.getInstance().createComponentLogger('OrcChatOwnerMirror');

/**
 * DM an orchestrator post in its own chat to the owner when they are not
 * looking at that chat. Never throws.
 *
 * @param conversationId - Conversation the orchestrator posted in
 * @param text - What it posted
 * @param deps - Overrides (tests)
 * @returns True when the owner was DMed
 */
export async function mirrorOrcChatPostToOwner(conversationId: string, text: string, deps?: OrcChatMirrorDeps): Promise<boolean> {
	try {
		const d = deps ?? (await defaultDeps());
		if (!d.isSlackConnected()) return false;
		const decision = shouldMirrorOrcChatToOwner({
			conversationId,
			slackLinkedDm: d.isSlackLinkedDm(conversationId),
			slackMappedRoom: d.isSlackMappedRoom(conversationId),
			ownerSource: d.ownerSource(conversationId),
			ownerAt: d.ownerAt(conversationId),
			now: d.now ? d.now() : Date.now(),
		});
		if (!decision.mirror) {
			logger.debug('Orchestrator chat post not mirrored to the owner', { conversationId, reason: decision.reason });
			return false;
		}
		const sent = await d.sendToOwner(text);
		logger.info('Orchestrator chat post DMed to the owner (they are not looking at that chat)', { conversationId, sent: !!sent });
		return !!sent;
	} catch (err) {
		logger.warn('Could not DM the orchestrator chat post to the owner', {
			conversationId,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

async function defaultDeps(): Promise<OrcChatMirrorDeps> {
	const [{ getSlackService }, { getSlackAgentDmService }, { getSlackTeamChannelService }, { getSlackAgentIdentityService }, { SlackReloginDmService }, { getChatV2Service }] =
		await Promise.all([
			import('../slack/slack.service.js'),
			import('../slack/slack-agent-dm.service.js'),
			import('../slack/slack-team-channel.service.js'),
			import('../slack/slack-agent-identity.service.js'),
			import('../slack/slack-relogin-dm.service.js'),
			import('../chat-v2/chat-v2.singleton.js'),
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
		sendToOwner: (text) => dm.sendToOwner(text),
	};
}
