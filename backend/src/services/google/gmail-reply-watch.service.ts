/**
 * Gmail Reply Watch
 *
 * Wakes the agent that owns a Gmail thread when a new reply lands
 * (CREW-257, specs/2026-10-06-gmail-approve-send-and-reply-wake.md).
 *
 * Polls `threads.get` for the threads agents asked to watch (or that an
 * approved send started) and publishes `gmail:reply_received` on the event
 * bus for each message it has not seen. `watch-for-event` can target it with
 * `--filter-json '{"threadId":"…"}'`.
 *
 * Fires at most once per message: the seen-set is written to disk *before*
 * the event is published, so a crash or restart can lose a wake-up but never
 * repeat one. A watch is created with the thread's existing messages already
 * marked seen, so history never fires. Only the Google account a watch was
 * created under is polled, and only while it is still connected.
 *
 * @module services/google/gmail-reply-watch
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentEvent } from '../../types/event-bus.types.js';
import { atomicWriteJson } from '../../utils/file-io.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { GmailThreadMessage } from './gmail.service.js';

/** How often watched threads are read. */
export const GMAIL_WATCH_POLL_MS = 60_000;

/** Seen ids kept per thread (oldest dropped). */
const MAX_SEEN_PER_THREAD = 500;

/** Event-bus session name for the event; per thread so the bus never merges two threads. */
export const GMAIL_EVENT_SESSION_PREFIX = 'gmail:';

/** One watched thread. */
export interface GmailThreadWatch {
	threadId: string;
	/** Agent that owns the thread and is woken */
	ownerSession: string;
	/** The owner's Google account the thread belongs to ('' = default account) */
	account: string;
	/** Message ids already seen (history at watch time + every reply fired) */
	seen: string[];
	createdAt: string;
}

/** Dependencies, injected so tests need no Google or event bus. */
export interface GmailReplyWatchDeps {
	/** JSON file holding the watches */
	file: string;
	/** Messages in a thread, for an account */
	getThread: (threadId: string, account: string) => Promise<GmailThreadMessage[]>;
	/** Whether the account is still connected; a disconnected one is skipped */
	accountConnected: (account: string) => Promise<boolean>;
	/** The default connected account's email, to stamp new watches */
	defaultAccount: () => Promise<string>;
	/** Event bus publish */
	publish: (event: AgentEvent) => void;
}

/**
 * Whether a message is one the owner (or an agent as the owner) wrote or is
 * still drafting, which is not a reply.
 *
 * @param m - Thread message
 * @returns True for the owner's own mail
 */
export function isOwnMessage(m: GmailThreadMessage): boolean {
	return m.labelIds.includes('SENT') || m.labelIds.includes('DRAFT');
}

/**
 * Watches Gmail threads for replies and publishes an event for each.
 */
export class GmailReplyWatchService {
	private readonly logger: ComponentLogger;
	private watches: GmailThreadWatch[] | null = null;
	private timer: NodeJS.Timeout | null = null;
	private polling = false;

	constructor(private readonly deps: GmailReplyWatchDeps) {
		this.logger = LoggerService.getInstance().createComponentLogger('GmailReplyWatch');
	}

	/** Start the poll loop. */
	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.poll(), GMAIL_WATCH_POLL_MS);
		this.timer.unref?.();
	}

	/** Stop the poll loop. */
	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/**
	 * Watch a thread on behalf of an agent. Existing messages are marked seen.
	 * Watching an already-watched thread re-points it at the new owner and
	 * keeps what was seen.
	 *
	 * @param threadId - Gmail thread id
	 * @param ownerSession - Agent to wake
	 * @param account - Google account; default account when omitted
	 * @returns The watch
	 * @throws Error when the thread cannot be read
	 */
	async watch(threadId: string, ownerSession: string, account?: string): Promise<GmailThreadWatch> {
		const acct = account?.trim() || (await this.deps.defaultAccount());
		const list = await this.load();
		const existing = list.find((w) => w.threadId === threadId && w.account === acct);
		if (existing) {
			existing.ownerSession = ownerSession;
			await this.save();
			return existing;
		}
		const messages = await this.deps.getThread(threadId, acct);
		const entry: GmailThreadWatch = {
			threadId,
			ownerSession,
			account: acct,
			seen: messages.map((m) => m.id),
			createdAt: new Date().toISOString(),
		};
		list.push(entry);
		await this.save();
		this.logger.info('Watching Gmail thread', { threadId, ownerSession, account: acct });
		return entry;
	}

	/**
	 * Stop watching a thread.
	 *
	 * @param threadId - Gmail thread id
	 * @param ownerSession - Only the owner of the watch may remove it
	 * @returns True when a watch was removed
	 */
	async unwatch(threadId: string, ownerSession: string): Promise<boolean> {
		const list = await this.load();
		const next = list.filter((w) => !(w.threadId === threadId && w.ownerSession === ownerSession));
		if (next.length === list.length) return false;
		this.watches = next;
		await this.save();
		return true;
	}

	/**
	 * The watches, optionally for one agent.
	 *
	 * @param ownerSession - Filter
	 * @returns Watches
	 */
	async list(ownerSession?: string): Promise<GmailThreadWatch[]> {
		const list = await this.load();
		return ownerSession ? list.filter((w) => w.ownerSession === ownerSession) : [...list];
	}

	/**
	 * Read every watched thread once and publish an event per new reply.
	 *
	 * @returns Number of events published
	 */
	async poll(): Promise<number> {
		if (this.polling) return 0;
		this.polling = true;
		let fired = 0;
		try {
			const connected = new Map<string, boolean>();
			for (const w of await this.load()) {
				try {
					if (!connected.has(w.account)) connected.set(w.account, await this.deps.accountConnected(w.account));
					if (!connected.get(w.account)) continue;
					const fresh = (await this.deps.getThread(w.threadId, w.account)).filter((m) => !w.seen.includes(m.id));
					if (fresh.length === 0) continue;
					// Record first: a restart must never repeat a wake-up.
					w.seen = [...w.seen, ...fresh.map((m) => m.id)].slice(-MAX_SEEN_PER_THREAD);
					await this.save();
					for (const m of fresh.filter((x) => !isOwnMessage(x))) {
						this.deps.publish(this.eventFor(w, m));
						fired += 1;
					}
				} catch (err) {
					this.logger.warn('Gmail thread poll failed', { threadId: w.threadId, error: err instanceof Error ? err.message : String(err) });
				}
			}
		} finally {
			this.polling = false;
		}
		return fired;
	}

	private eventFor(w: GmailThreadWatch, m: GmailThreadMessage): AgentEvent {
		return {
			id: `gmail:reply:${m.id}`,
			type: 'gmail:reply_received',
			timestamp: new Date().toISOString(),
			teamId: '',
			teamName: '',
			memberId: '',
			memberName: '',
			sessionName: `${GMAIL_EVENT_SESSION_PREFIX}${w.threadId}`,
			previousValue: m.from,
			newValue: m.id,
			changedField: 'gmailReply',
			threadId: w.threadId,
			target: w.ownerSession,
			workItemTitle: m.subject,
		};
	}

	private async load(): Promise<GmailThreadWatch[]> {
		if (this.watches) return this.watches;
		try {
			const parsed = JSON.parse(await fs.readFile(this.deps.file, 'utf-8')) as unknown;
			this.watches = Array.isArray(parsed) ? (parsed as GmailThreadWatch[]) : [];
		} catch {
			this.watches = [];
		}
		return this.watches;
	}

	private async save(): Promise<void> {
		await fs.mkdir(path.dirname(this.deps.file), { recursive: true });
		await atomicWriteJson(this.deps.file, this.watches ?? []);
	}
}
