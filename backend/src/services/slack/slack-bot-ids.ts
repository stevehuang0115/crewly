/**
 * Whether a Slack user id is one of Crewly's own bots — the master bot or an
 * agent's bot (issue #968). A bot is never a person: it is not added to the
 * people directory and never becomes the person an agent acts for.
 *
 * Synchronous and best effort: it reads what is already loaded (the Cloud
 * Slack config, the agent identity store, the master bot's cached id).
 *
 * @module services/slack/slack-bot-ids
 */

import { getSlackAgentIdentityService } from './slack-agent-identity.service.js';
import { getSlackCloudConfigService } from './slack-cloud-config.service.js';
import { getSlackService } from './slack.service.js';

/** Where bot ids come from (injectable for tests). */
export interface SlackBotIdSources {
	/** Agent session for an agent bot's user id, or null */
	findAgentByBotUserId?: (slackUserId: string) => string | null | undefined;
	/** Bot user ids from the Cloud Slack config (master bot and every agent bot) */
	cloudBotUserIds?: () => readonly string[];
	/** The master bot's user id when known */
	masterBotUserId?: () => string | null | undefined;
}

/** The backend's sources. */
const defaultSources: Required<SlackBotIdSources> = {
	findAgentByBotUserId: (id) => getSlackAgentIdentityService()?.findByBotUserId(id) ?? null,
	cloudBotUserIds: () => {
		const config = getSlackCloudConfigService()?.getConfig();
		if (!config) return [];
		return [config.workspace?.botUserId, ...(config.agents ?? []).map((a) => a.botUserId)].filter((id): id is string => !!id);
	},
	masterBotUserId: () => getSlackService().getCachedBotUserId?.() ?? null,
};

/**
 * Whether a Slack user id is a Crewly bot.
 *
 * @param slackUserId - Slack user id
 * @param sources - Where to look (default: the backend's Slack services)
 * @returns True for the master bot or an agent's bot; false when unknown or on any error
 *
 * @example
 * ```ts
 * isCrewlyBotUserId('U0BOTDEV1'); // true when it is an agent's bot
 * ```
 */
export function isCrewlyBotUserId(slackUserId: string, sources: SlackBotIdSources = defaultSources): boolean {
	if (!slackUserId) return false;
	const tries: Array<() => boolean> = [
		() => !!sources.findAgentByBotUserId?.(slackUserId),
		() => (sources.cloudBotUserIds?.() ?? []).includes(slackUserId),
		() => sources.masterBotUserId?.() === slackUserId,
	];
	for (const t of tries) {
		try {
			if (t()) return true;
		} catch {
			// one source failing does not decide
		}
	}
	return false;
}
