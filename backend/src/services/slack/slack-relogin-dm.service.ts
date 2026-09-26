/**
 * Slack side of the harness re-login (onboarding Phase 2).
 *
 * - {@link SlackReloginDmService.sendToOwner}: DM the owner (the person who
 *   installed the Slack app) through the master bot. The DM channel is
 *   remembered so replies can be matched to it. When the owner id is not
 *   known, falls back to the owner-notification path
 *   (`SlackService.sendNotification`, the most recent master-bot DM).
 * - {@link SlackReloginDmService.isOwnerDmReply}: whether an inbound message
 *   is the owner writing in that DM — or in their DM with the orchestrator's
 *   own bot ("Crewly Orc"), where they usually talk to the orc — so the Slack
 *   bridge may offer it to the re-login coordinator before anything else
 *   (logging, thread store, orc).
 * - An owner-requested login (「重新登录 claude」) answers in the conversation
 *   and thread it was asked in, under the bot that conversation belongs to
 *   ({@link ReloginReplyTarget}); the master-bot DM is the fallback.
 *
 * @module services/slack/slack-relogin-dm.service
 */

import type { SlackIncomingMessage, SlackNotification, SlackOutgoingMessage } from '../../types/slack.types.js';
import type { HarnessReloginService, ReloginOwnerNotifier, ReloginReplyTarget } from '../harness/harness-relogin.service.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';

/** Prefix of Slack direct-message channel ids. */
const DM_CHANNEL_PREFIX = 'D';

/** The slice of SlackService this adapter uses. */
export interface ReloginDmSlackApi {
	isConnected(): boolean;
	getOwnerUserId: (() => string | null) | null;
	isAgentOwnedConversation: ((channelId: string) => boolean) | null;
	openDirectMessage(userId: string): Promise<string>;
	sendMessage(message: SlackOutgoingMessage): Promise<string>;
	sendNotification(notification: SlackNotification): Promise<void>;
}

/**
 * Escape the three characters Slack reserves in message text. Slack still
 * auto-links a bare URL and decodes `&amp;` in its target, so an OAuth URL
 * full of `&` stays intact.
 *
 * @param text - Plain message text
 * @returns Text safe for `chat.postMessage`
 */
export function escapeSlackText(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Resolves an agent's own Slack bot token (null when it has no bot). */
export type AgentBotTokenResolver = (agentSession: string) => string | null;

/** DMs the owner for the re-login coordinator and recognises their replies. */
export class SlackReloginDmService implements ReloginOwnerNotifier {
	private readonly logger: ComponentLogger;
	/** DM channel the last re-login message went to */
	private dmChannelId: string | null = null;

	/**
	 * @param getSlack - Slack service accessor (resolved per call; the connection can come up late)
	 * @param now - Clock
	 * @param getAgentBotToken - Bot token of an agent's own Slack app (for answering in the orc's DM)
	 */
	constructor(
		private readonly getSlack: () => ReloginDmSlackApi,
		private readonly now: () => Date = () => new Date(),
		private readonly getAgentBotToken: AgentBotTokenResolver = () => null,
	) {
		this.logger = LoggerService.getInstance().createComponentLogger('SlackReloginDm');
	}

	/**
	 * Whether Slack is connected, so a DM can go out now.
	 *
	 * @returns True when connected
	 */
	isAvailable(): boolean {
		try {
			return this.getSlack().isConnected();
		} catch {
			return false;
		}
	}

	/**
	 * Where to answer a message: its conversation and thread, and the agent
	 * whose bot owns the conversation (for the orc's own-bot DM).
	 *
	 * @param message - Inbound Slack message
	 * @returns Reply target
	 */
	replyTargetOf(message: SlackIncomingMessage): ReloginReplyTarget {
		const threadTs = message.threadTs || message.ts;
		return {
			channelId: message.channelId,
			...(threadTs ? { threadTs } : {}),
			...(message.agentSession ? { agentSession: message.agentSession } : {}),
		};
	}

	/**
	 * DM the owner. Never logs the text.
	 *
	 * @param text - Message (plain text with Slack mrkdwn emphasis; escaped here)
	 * @param target - Conversation to answer in; absent/unusable = the master-bot DM
	 * @returns True when Slack accepted it
	 */
	async sendToOwner(text: string, target?: ReloginReplyTarget | null): Promise<boolean> {
		const slack = this.getSlack();
		if (!slack.isConnected()) return false;
		const escaped = escapeSlackText(text);
		if (target && (await this.sendToTarget(slack, escaped, target))) return true;
		const ownerId = slack.getOwnerUserId?.() ?? null;
		if (ownerId) {
			try {
				const channelId = await slack.openDirectMessage(ownerId);
				await slack.sendMessage({ channelId, text: escaped, unfurlLinks: false, unfurlMedia: false, skipChatV2Mirror: true });
				this.dmChannelId = channelId;
				return true;
			} catch (error) {
				this.logger.warn('Could not DM the owner directly; using the owner-notification path', {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		try {
			await slack.sendNotification({ type: 'agent_error', title: 'Login needed', message: escaped, urgency: 'high', timestamp: this.now().toISOString() });
			return true;
		} catch (error) {
			this.logger.warn('Could not send the re-login message to the owner', { error: error instanceof Error ? error.message : String(error) });
			return false;
		}
	}

	/**
	 * Post into a specific conversation (the thread the owner asked in).
	 *
	 * @param slack - Slack API
	 * @param escaped - Escaped text
	 * @param target - Conversation, thread and owning agent
	 * @returns True when posted
	 */
	private async sendToTarget(slack: ReloginDmSlackApi, escaped: string, target: ReloginReplyTarget): Promise<boolean> {
		// A DM with an agent's own bot is only reachable with that bot's token.
		const botToken = target.agentSession ? this.getAgentBotToken(target.agentSession) : null;
		if (target.agentSession && !botToken) return false;
		try {
			await slack.sendMessage({
				channelId: target.channelId,
				text: escaped,
				...(target.threadTs ? { threadTs: target.threadTs } : {}),
				...(botToken ? { botToken } : {}),
				unfurlLinks: false,
				unfurlMedia: false,
				skipChatV2Mirror: true,
			});
			return true;
		} catch (error) {
			this.logger.warn('Could not answer in the conversation the login was asked in; using the owner DM', {
				channelId: target.channelId,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	/**
	 * Whether a message is the owner writing in their DM with the master bot
	 * (the DM the re-login messages went to, when known) or in their DM with
	 * the orchestrator's own bot.
	 *
	 * @param message - Inbound Slack message
	 * @returns True for the owner's DM reply
	 */
	isOwnerDmReply(message: SlackIncomingMessage): boolean {
		if (message.authorAgentSession || message.handoffTo) return false;
		if (!message.channelId?.startsWith(DM_CHANNEL_PREFIX)) return false;
		const slack = this.getSlack();
		const ownerId = slack.getOwnerUserId?.() ?? null;
		if (ownerId && message.userId !== ownerId) return false;
		// The owner's DM with the orc's own bot: where they talk to the orc
		// (2026-09-26: 「帮我重新登陆claude code」 was written there). Other
		// agents' DMs stay theirs.
		if (message.agentSession) return message.agentSession === ORCHESTRATOR_SESSION_NAME;
		if (slack.isAgentOwnedConversation?.(message.channelId)) return false;
		if (this.dmChannelId && message.channelId !== this.dmChannelId) return false;
		return true;
	}
}

/** The slice of the orc's turn origin the reply-target resolver reads. */
export interface OrcTurnOriginLike {
	conversationId: string;
	slackChannelId?: string;
	slackThreadTs?: string;
}

/** Link between a chat-v2 DM channel and a Slack DM with an agent's bot. */
export interface AgentDmLinkLike {
	agentSession: string;
	slackChannelId: string;
	replyThreadTs?: string;
}

/**
 * Where the orchestrator's current conversation is on Slack — the answer
 * target for a login the orc starts with its `harness-login` skill, so the
 * link lands in the thread the owner asked in.
 *
 * @param origin - The orc's fresh turn origin, if any
 * @param agentDm - Lookups into the agent-DM links (orc bot DM ↔ chat channel)
 * @returns The Slack target, or null (then the master-bot DM is used)
 */
export function resolveOrcTurnReplyTarget(
	origin: OrcTurnOriginLike | undefined,
	agentDm: {
		findBySlackChannelId(slackChannelId: string): AgentDmLinkLike | null;
		findByChatChannelId(chatChannelId: string): AgentDmLinkLike | null;
	} | null,
): ReloginReplyTarget | null {
	if (!origin) return null;
	if (origin.slackChannelId) {
		if (!origin.slackChannelId.startsWith(DM_CHANNEL_PREFIX)) return null;
		const link = agentDm?.findBySlackChannelId(origin.slackChannelId) ?? null;
		return {
			channelId: origin.slackChannelId,
			...(origin.slackThreadTs ? { threadTs: origin.slackThreadTs } : {}),
			...(link ? { agentSession: link.agentSession } : {}),
		};
	}
	const link = agentDm?.findByChatChannelId(origin.conversationId) ?? null;
	if (!link) return null;
	return {
		channelId: link.slackChannelId,
		...(link.replyThreadTs ? { threadTs: link.replyThreadTs } : {}),
		agentSession: link.agentSession,
	};
}

/**
 * Build the Slack bridge's inbound interceptor for the re-login: an owner's
 * DM reply (text only) is offered to the coordinator, which consumes it only
 * when it belongs to a login (a code, the retry keyword, a reply to an
 * unrecognised screen) or asks for one (「重新登录 claude」). A consumed
 * message must not be logged, stored or forwarded to the orchestrator.
 *
 * @param dm - Owner-DM recogniser
 * @param coordinator - Re-login coordinator
 * @returns Interceptor: true when the message was consumed
 *
 * @example
 * ```ts
 * bridge.setInboundInterceptor(createReloginReplyInterceptor(dm, getHarnessReloginService()));
 * ```
 */
export function createReloginReplyInterceptor(
	dm: Pick<SlackReloginDmService, 'isOwnerDmReply' | 'replyTargetOf'>,
	coordinator: Pick<HarnessReloginService, 'handleOwnerReply'>,
): (message: SlackIncomingMessage) => boolean {
	return (message) => {
		if (message.hasFiles || !message.text) return false;
		if (!dm.isOwnerDmReply(message)) return false;
		return coordinator.handleOwnerReply(message.text, dm.replyTargetOf(message));
	};
}
