/**
 * What an agent's message queue needs to know about a message beyond its
 * text: whether the owner wrote it (it goes ahead of system traffic), which
 * conversation and thread it belongs to (for a colleague's message or a
 * reminder, a reply there after it was queued means it was answered — never
 * for the owner's own message), the owner message it carries (so a second
 * copy is recognised), and which earlier reminder it replaces.
 *
 * Callers that know this (the chat dispatcher for an owner's message, the
 * decision service for an owner's answer, the owner-message watchdog for its
 * reminder, the open-items service for a "promised work is ready" reminder)
 * run their delivery inside {@link withQueueMeta}. If the agent is busy and
 * the delivery path queues the message, {@link SubAgentMessageQueue.enqueue}
 * picks the meta up from the async context — no delivery signature changes.
 *
 * Case that motivated it (2026-10-05, #education, D-270): the owner's answer
 * to Atlas's decision card was queued at position 7 behind stale reminders,
 * handed over one per idle moment oldest-first, and reached Atlas after
 * ~18 minutes; a duplicate of an owner message Atlas had already answered sat
 * in front of it.
 *
 * @module services/messaging/queue-priority
 */

import { AsyncLocalStorage } from 'async_hooks';

/** Where a queued message's answer belongs. */
export interface QueueConversation {
	/** chat-v2 channel the message was recorded in */
	chatChannelId?: string;
	/** chat-v2 thread the answer belongs in (huddles) */
	chatThreadId?: string;
	/** Slack channel / DM */
	slackChannelId?: string;
	/** Slack thread root */
	threadTs?: string;
}

/** Metadata stored with a queued message. */
export interface QueueMessageMeta {
	/** The owner wrote it (or it carries the owner's words / answer): goes ahead of everything else */
	owner?: boolean;
	/** Identity of the owner message it carries (`slack:<ch>:<ts>`, `chat:<ch>:<id>`, `decision:<id>`); a later queued copy is a duplicate */
	ref?: string;
	/** Conversation (and thread) the answer belongs in */
	where?: QueueConversation;
	/** A newer queued message with the same key replaces an older one (a reminder about the same promise) */
	supersedeKey?: string;
	/**
	 * A harness reminder that carries the owner's words (the watchdog's nudge):
	 * owner priority, but — unlike the owner's own message — dropped once the
	 * agent has answered in its thread.
	 */
	reminder?: boolean;
}

/**
 * Meta bound to one message for one agent: a nested delivery to someone
 * else, or a timer scheduled during the delivery that later queues another
 * message, does not inherit it.
 */
interface BoundMeta {
	session: string;
	data: string;
	meta: QueueMessageMeta;
}

const context = new AsyncLocalStorage<BoundMeta>();

/**
 * Run a delivery with queue metadata for one message to one agent. If the
 * delivery queues that message for that agent, the queued copy carries the
 * metadata.
 *
 * @param session - The agent the delivery is for
 * @param data - The exact text being delivered
 * @param meta - The metadata
 * @param fn - The delivery
 * @returns What `fn` returns
 */
export function withQueueMeta<T>(session: string, data: string, meta: QueueMessageMeta, fn: () => T): T {
	return context.run({ session, data, meta }, fn);
}

/**
 * The metadata of the delivery running now, if it is this message for this agent.
 *
 * @param session - The agent a message is being queued for
 * @param data - The message being queued
 * @returns The metadata, or undefined
 */
export function currentQueueMeta(session: string, data: string): QueueMessageMeta | undefined {
	const bound = context.getStore();
	return bound && bound.session === session && bound.data === data ? bound.meta : undefined;
}

// ---------------------------------------------------------------------------
// Agent posts — "has the agent spoken in this conversation since?"
// ---------------------------------------------------------------------------

/** One post an agent made. */
interface AgentPost {
	at: number;
	where: QueueConversation;
}

/** How long posts are remembered; a queued message older than this is judged by the other rules. */
const POST_KEEP_MS = 24 * 60 * 60 * 1000;
/** Posts remembered per agent. */
const POSTS_PER_AGENT = 200;

/**
 * The agents' recent posts, by agent. Fed by the chat-v2 turn stream and the
 * `reply` endpoint; read by the queue when it flushes.
 */
export class AgentPostLog {
	private static instance: AgentPostLog | null = null;
	private readonly posts = new Map<string, AgentPost[]>();

	/** @returns The process-wide log */
	static getInstance(): AgentPostLog {
		if (!AgentPostLog.instance) AgentPostLog.instance = new AgentPostLog();
		return AgentPostLog.instance;
	}

	/** Reset (tests). */
	static resetInstance(): void {
		AgentPostLog.instance = null;
	}

	/**
	 * Record that an agent posted (a real answer, not an interim "working on it").
	 *
	 * @param session - The agent
	 * @param where - Where it posted
	 * @param at - When (default now)
	 */
	note(session: string, where: QueueConversation, at: number = Date.now()): void {
		if (!session || (!where.chatChannelId && !where.slackChannelId)) return;
		const list = this.posts.get(session) ?? [];
		list.push({ at, where: { ...where } });
		const cutoff = Date.now() - POST_KEEP_MS;
		const kept = list.filter((p) => p.at >= cutoff).slice(-POSTS_PER_AGENT);
		this.posts.set(session, kept);
	}

	/**
	 * Whether the agent posted in a conversation (and thread) after a moment.
	 *
	 * Matched by thread only (see {@link sameConversation}).
	 *
	 * @param session - The agent
	 * @param where - The queued message's conversation
	 * @param since - When it was queued
	 * @returns True when the agent spoke there after `since`
	 */
	postedSince(session: string, where: QueueConversation, since: number): boolean {
		const list = this.posts.get(session);
		if (!list) return false;
		return list.some((p) => p.at > since && sameConversation(p.where, where));
	}
}

/**
 * Whether a post landed in the conversation (and thread) a queued message belongs to.
 *
 * @param post - Where the agent posted
 * @param queued - Where the queued message's answer belongs
 * @returns True on a match
 */
export function sameConversation(post: QueueConversation, queued: QueueConversation): boolean {
	// Only a thread identifies one conversation. A top-level DM is never
	// matched: the agent posting there about something else (an earlier
	// request finishing) must not make a newer owner message look answered.
	if (queued.chatChannelId && queued.chatThreadId && post.chatChannelId === queued.chatChannelId && post.chatThreadId === queued.chatThreadId) {
		return true;
	}
	if (queued.slackChannelId && queued.threadTs && post.slackChannelId === queued.slackChannelId && post.threadTs === queued.threadTs) {
		return true;
	}
	return false;
}

/**
 * Feed a recorded chat-v2 turn to the post log: an agent's real answer (not
 * an interim "working on it") in a conversation, and the Slack thread it
 * mirrors to when the turn says so.
 *
 * @param dto - The turn (sender, channel, thread, metadata)
 * @param log - The post log (default: the process-wide one)
 */
export function noteAgentChatTurn(
	dto: { senderType: string; senderId: string; channelId: string; threadId?: string | null; createdAt?: number; metadata?: Record<string, unknown> },
	log: AgentPostLog = AgentPostLog.getInstance(),
): void {
	if (dto.senderType !== 'agent' || !dto.senderId) return;
	const meta = dto.metadata ?? {};
	if (meta.interim === true) return;
	const slackChannelId = typeof meta.slackChannelId === 'string' ? meta.slackChannelId : undefined;
	const threadTs = typeof meta.slackThreadTs === 'string' ? meta.slackThreadTs : undefined;
	log.note(dto.senderId, {
		chatChannelId: dto.channelId,
		...(dto.threadId ? { chatThreadId: dto.threadId } : {}),
		...(slackChannelId && threadTs ? { slackChannelId, threadTs } : {}),
	});
}
