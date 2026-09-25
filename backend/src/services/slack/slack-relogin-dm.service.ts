/**
 * Slack side of the harness re-login (onboarding Phase 2).
 *
 * - {@link SlackReloginDmService.sendToOwner}: DM the owner (the person who
 *   installed the Slack app) through the master bot. The DM channel is
 *   remembered so replies can be matched to it. When the owner id is not
 *   known, falls back to the owner-notification path
 *   (`SlackService.sendNotification`, the most recent master-bot DM).
 * - {@link SlackReloginDmService.isOwnerDmReply}: whether an inbound message
 *   is the owner writing in that DM, so the Slack bridge may offer it to the
 *   re-login coordinator before anything else (logging, thread store, orc).
 *
 * @module services/slack/slack-relogin-dm.service
 */

import type { SlackIncomingMessage, SlackNotification, SlackOutgoingMessage } from '../../types/slack.types.js';
import type { HarnessReloginService, ReloginOwnerNotifier } from '../harness/harness-relogin.service.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';

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

/** DMs the owner for the re-login coordinator and recognises their replies. */
export class SlackReloginDmService implements ReloginOwnerNotifier {
	private readonly logger: ComponentLogger;
	/** DM channel the last re-login message went to */
	private dmChannelId: string | null = null;

	/**
	 * @param getSlack - Slack service accessor (resolved per call; the connection can come up late)
	 * @param now - Clock
	 */
	constructor(
		private readonly getSlack: () => ReloginDmSlackApi,
		private readonly now: () => Date = () => new Date(),
	) {
		this.logger = LoggerService.getInstance().createComponentLogger('SlackReloginDm');
	}

	/**
	 * DM the owner. Never logs the text.
	 *
	 * @param text - Message (plain text with Slack mrkdwn emphasis; escaped here)
	 * @returns True when Slack accepted it
	 */
	async sendToOwner(text: string): Promise<boolean> {
		const slack = this.getSlack();
		if (!slack.isConnected()) return false;
		const escaped = escapeSlackText(text);
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
	 * Whether a message is the owner writing in their DM with the master bot
	 * (the DM the re-login messages went to, when known).
	 *
	 * @param message - Inbound Slack message
	 * @returns True for the owner's DM reply
	 */
	isOwnerDmReply(message: SlackIncomingMessage): boolean {
		if (message.agentSession || message.authorAgentSession || message.handoffTo) return false;
		if (!message.channelId?.startsWith(DM_CHANNEL_PREFIX)) return false;
		const slack = this.getSlack();
		if (slack.isAgentOwnedConversation?.(message.channelId)) return false;
		const ownerId = slack.getOwnerUserId?.() ?? null;
		if (ownerId && message.userId !== ownerId) return false;
		if (this.dmChannelId && message.channelId !== this.dmChannelId) return false;
		return true;
	}
}

/**
 * Build the Slack bridge's inbound interceptor for the re-login: an owner's
 * DM reply (text only) is offered to the coordinator, which consumes it only
 * when it belongs to a login (a code, the retry keyword, a reply to an
 * unrecognised screen). A consumed message must not be logged, stored or
 * forwarded to the orchestrator.
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
	dm: Pick<SlackReloginDmService, 'isOwnerDmReply'>,
	coordinator: Pick<HarnessReloginService, 'handleOwnerReply'>,
): (message: SlackIncomingMessage) => boolean {
	return (message) => {
		if (message.hasFiles || !message.text) return false;
		if (!dm.isOwnerDmReply(message)) return false;
		return coordinator.handleOwnerReply(message.text);
	};
}
