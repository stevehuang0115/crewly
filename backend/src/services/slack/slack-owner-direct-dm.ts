/**
 * Owner DM straight through the Slack Web API — for when Cloud is gone.
 *
 * Inbound Slack reaches a machine only through Crewly Cloud → relay, but
 * outbound works with the bot tokens the machine already holds. When Cloud
 * is unreachable this is the one way left to reach the owner, and — since
 * their replies will not be relayed — the one way to read what they answer:
 * `conversations.history` on the same DM with the same token.
 *
 * Tokens never appear in logs or errors.
 *
 * @module services/slack/slack-owner-direct-dm
 */

import { CLOUD_DISCONNECT_NOTICE_CONSTANTS } from '../../../../config/constants.js';

const C = CLOUD_DISCONNECT_NOTICE_CONSTANTS;

/** `fetch` signature (injectable for tests). */
export type SlackFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A message the owner wrote in the DM. */
export interface OwnerDmReply {
	/** Slack ts */
	ts: string;
	/** Text with Slack's `&amp;` / `&lt;` / `&gt;` decoded */
	text: string;
}

/** A posted message. */
export interface PostedDm {
	channelId: string;
	ts: string;
}

/** The owner DM operations the disconnect notice needs. */
export interface OwnerDirectDm {
	/** Post into the owner's DM; returns where it landed */
	send(text: string): Promise<PostedDm>;
	/** Replace a message posted earlier with {@link send} */
	update(channelId: string, ts: string, text: string): Promise<void>;
	/** The owner's messages in that DM after `afterTs`, oldest first */
	readOwnerReplies(channelId: string, afterTs: string): Promise<OwnerDmReply[]>;
}

/**
 * Escape the three characters Slack reserves in message text.
 *
 * @param text - Plain text
 * @returns Escaped text
 */
function escapeSlack(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Undo {@link escapeSlack} (and strip Slack's `<url|label>` link wrapping).
 *
 * @param text - Slack message text
 * @returns Plain text
 */
export function decodeSlackText(text: string): string {
	return text
		.replace(/<([^|>]+)\|[^>]*>/g, '$1')
		.replace(/<([^>]+)>/g, '$1')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

/**
 * Build the owner DM on a bot token.
 *
 * @param options - Bot token, owner's Slack user id and fetch (tests)
 * @returns The DM operations
 */
export function createOwnerDirectDm(options: { botToken: string; ownerUserId: string; fetchImpl?: SlackFetch }): OwnerDirectDm {
	const { botToken, ownerUserId } = options;
	const fetchImpl = options.fetchImpl ?? fetch;

	const call = async <T>(method: string, body: Record<string, unknown>, httpMethod: 'POST' | 'GET' = 'POST'): Promise<T> => {
		let url = `${C.SLACK_API_BASE}/${method}`;
		const init: RequestInit = {
			method: httpMethod,
			headers: {
				Authorization: `Bearer ${botToken}`,
				...(httpMethod === 'POST' ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
			},
			signal: AbortSignal.timeout(C.SLACK_REQUEST_TIMEOUT_MS),
		};
		if (httpMethod === 'GET') {
			const qs = new URLSearchParams(Object.entries(body).map(([k, v]): [string, string] => [k, String(v)]));
			url = `${url}?${qs.toString()}`;
		} else {
			init.body = JSON.stringify(body);
		}
		let response: Response;
		try {
			response = await fetchImpl(url, init);
		} catch (error) {
			throw new Error(`Slack ${method} unreachable: ${error instanceof Error ? error.message : String(error)}`);
		}
		const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
		if (!response.ok || !data.ok) throw new Error(`Slack ${method} failed: ${data.error ?? `HTTP ${response.status}`}`);
		return data;
	};

	let dmChannel: string | null = null;
	const openDm = async (): Promise<string> => {
		if (dmChannel) return dmChannel;
		const res = await call<{ channel?: { id?: string } }>('conversations.open', { users: ownerUserId });
		const id = res.channel?.id;
		if (!id) throw new Error('Slack conversations.open returned no channel');
		dmChannel = id;
		return id;
	};

	return {
		async send(text) {
			const channelId = await openDm();
			const res = await call<{ ts?: string; channel?: string }>('chat.postMessage', {
				channel: channelId,
				text: escapeSlack(text),
				unfurl_links: false,
				unfurl_media: false,
			});
			if (!res.ts) throw new Error('Slack chat.postMessage returned no ts');
			return { channelId: res.channel ?? channelId, ts: res.ts };
		},
		async update(channelId, ts, text) {
			await call('chat.update', { channel: channelId, ts, text: escapeSlack(text) });
		},
		async readOwnerReplies(channelId, afterTs) {
			const res = await call<{ messages?: Array<{ ts?: string; text?: string; user?: string; bot_id?: string; subtype?: string }> }>(
				'conversations.history',
				{ channel: channelId, oldest: afterTs, inclusive: false, limit: 50 },
				'GET',
			);
			return (res.messages ?? [])
				.filter((m) => m.user === ownerUserId && !m.bot_id && !m.subtype && typeof m.ts === 'string' && typeof m.text === 'string')
				.filter((m) => Number(m.ts) > Number(afterTs))
				.sort((a, b) => Number(a.ts) - Number(b.ts))
				.map((m) => ({ ts: m.ts as string, text: decodeSlackText(m.text as string).trim() }));
		},
	};
}
