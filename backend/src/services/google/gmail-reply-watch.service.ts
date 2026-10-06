/**
 * Gmail Reply Watch
 *
 * Wakes the agent that owns a Gmail thread when a new reply lands
 * (CREW-257, specs/2026-10-06-gmail-approve-send-and-reply-wake.md §2).
 *
 * One `history.list` per connected account per tick
 * ({@link GOOGLE_WORKSPACE_CONSTANTS.GMAIL_WATCH_POLL_MS}), however many
 * threads are watched, and only while something is watched. New messages in
 * watched threads are published as `gmail:reply_received` — ids only; the
 * message text is outside input and the event never carries it.
 *
 * Cursor (`historyId` per account) and fired message ids are persisted
 * before publishing: a restart never repeats a wake or re-reads old
 * history. A 404 (cursor too old) re-seeds the cursor and resyncs each
 * watched thread once. Every watch expires 14 days after its last reply and
 * goes when its account is no longer connected.
 *
 * @module services/google/gmail-reply-watch
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { GOOGLE_WORKSPACE_CONSTANTS } from '../../constants.js';
import type { AgentEvent } from '../../types/event-bus.types.js';
import { atomicWriteJson } from '../../utils/file-io.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { GmailHistoryAdded, GmailThreadMessage } from './gmail.service.js';

/** Event-bus session name prefix; per thread so the bus never merges two threads. */
export const GMAIL_EVENT_SESSION_PREFIX = 'gmail:';

/** Seen ids kept per thread (oldest dropped). */
const MAX_SEEN_PER_THREAD = 500;

/** One watched thread. */
export interface GmailThreadWatch {
	threadId: string;
	/** Agent that owns the thread and is woken */
	ownerSession: string;
	/** The owner's Google account the thread belongs to */
	account: string;
	/** Message ids already seen or fired */
	seen: string[];
	createdAt: string;
	/** Last reply (or creation); the expiry clock runs from here */
	lastActivityAt: string;
}

/** Persisted state. */
interface WatchFile {
	/** historyId cursor per account */
	cursors: Record<string, string>;
	watches: GmailThreadWatch[];
}

/** The Gmail calls the watcher makes, for one account. */
export interface GmailWatchApi {
	getProfile(): Promise<{ emailAddress: string; historyId: string }>;
	listHistoryAdded(startHistoryId: string): Promise<GmailHistoryAdded>;
	getMessageMeta(id: string): Promise<GmailThreadMessage & { threadId: string }>;
	getThread(threadId: string): Promise<GmailThreadMessage[]>;
}

/** Dependencies, injected so tests need no Google, clock or event bus. */
export interface GmailReplyWatchDeps {
	/** JSON file holding cursors and watches */
	file: string;
	gmailFor: (account: string) => GmailWatchApi;
	/** Whether the account is still connected */
	accountConnected: (account: string) => Promise<boolean>;
	/** The default connected account's email, to stamp new watches */
	defaultAccount: () => Promise<string>;
	publish: (event: AgentEvent) => void;
	/** Clock (epoch ms) */
	now?: () => number;
}

/**
 * Whether a message is the owner's own mail or a draft, not a reply.
 *
 * @param m - Thread message
 * @returns True for the owner's own mail
 */
export function isOwnMessage(m: Pick<GmailThreadMessage, 'labelIds'>): boolean {
	return m.labelIds.includes('SENT') || m.labelIds.includes('DRAFT');
}

/**
 * Watches Gmail threads for replies and publishes an event for each.
 */
export class GmailReplyWatchService {
	private readonly logger: ComponentLogger;
	private state: WatchFile | null = null;
	private timer: NodeJS.Timeout | null = null;
	private polling = false;
	private current: Promise<unknown> = Promise.resolve();
	private running = false;
	/** Consecutive not-connected ticks per account (memory only) */
	private readonly misses = new Map<string, number>();

	constructor(private readonly deps: GmailReplyWatchDeps) {
		this.logger = LoggerService.getInstance().createComponentLogger('GmailReplyWatch');
	}

	private now(): number {
		return this.deps.now ? this.deps.now() : Date.now();
	}

	/** Load persisted watches and arm the timer if there are any. */
	async start(): Promise<void> {
		this.running = true;
		await this.load();
		this.arm();
	}

	/** Stop for good (shutdown). */
	stop(): void {
		this.running = false;
		this.disarm();
	}

	/** The timer runs only while at least one thread is watched. */
	private arm(): void {
		if (!this.running || this.timer || !this.state || this.state.watches.length === 0) return;
		this.timer = setInterval(() => void this.poll(), GOOGLE_WORKSPACE_CONSTANTS.GMAIL_WATCH_POLL_MS);
		this.timer.unref?.();
	}

	private disarm(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/**
	 * Watch a thread for an agent. Existing messages are marked seen; an
	 * account's first watch seeds its cursor from the profile.
	 *
	 * @param threadId - Gmail thread id
	 * @param ownerSession - Agent to wake
	 * @param account - Google account; the default account when omitted
	 * @returns The watch
	 */
	async watch(threadId: string, ownerSession: string, account?: string): Promise<GmailThreadWatch> {
		const acct = account?.trim() || (await this.deps.defaultAccount());
		const st = await this.load();
		const existing = st.watches.find((w) => w.threadId === threadId && w.account === acct);
		if (existing) {
			existing.ownerSession = ownerSession;
			existing.lastActivityAt = new Date(this.now()).toISOString();
			await this.save();
			return existing;
		}
		const gmail = this.deps.gmailFor(acct);
		const messages = await gmail.getThread(threadId);
		if (!st.cursors[acct]) st.cursors[acct] = (await gmail.getProfile()).historyId;
		const iso = new Date(this.now()).toISOString();
		const entry: GmailThreadWatch = { threadId, ownerSession, account: acct, seen: messages.map((m) => m.id), createdAt: iso, lastActivityAt: iso };
		st.watches.push(entry);
		await this.save();
		this.arm();
		this.logger.info('Watching Gmail thread', { threadId, ownerSession, account: acct });
		return entry;
	}

	/**
	 * Stop watching a thread.
	 *
	 * @param threadId - Gmail thread id
	 * @param ownerSession - Only the owning agent may remove it
	 * @returns True when a watch was removed
	 */
	async unwatch(threadId: string, ownerSession: string): Promise<boolean> {
		const st = await this.load();
		const before = st.watches.length;
		st.watches = st.watches.filter((w) => !(w.threadId === threadId && w.ownerSession === ownerSession));
		if (st.watches.length === before) return false;
		this.prune(st);
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
		const st = await this.load();
		return ownerSession ? st.watches.filter((w) => w.ownerSession === ownerSession) : [...st.watches];
	}

	/**
	 * One tick: expire old watches, then one `history.list` per account that
	 * has watches; publish an event per new reply.
	 *
	 * @returns Number of events published
	 */
	poll(): Promise<number> {
		const p = this.doPoll();
		this.current = p;
		return p;
	}

	/**
	 * Resolves when the tick in progress (if any) has finished.
	 *
	 * @returns Nothing
	 */
	async whenIdle(): Promise<void> {
		await this.current;
	}

	private async doPoll(): Promise<number> {
		if (this.polling) return 0;
		this.polling = true;
		let fired = 0;
		try {
			const st = await this.load();
			await this.expire(st);
			for (const account of [...new Set(st.watches.map((w) => w.account))]) {
				if (!(await this.accountStillConnected(account, st))) continue;
				try {
					fired += await this.pollAccount(account, st);
				} catch (err) {
					this.logger.warn('Gmail reply poll failed', { account, error: err instanceof Error ? err.message : String(err) });
				}
			}
			this.prune(st);
			if (st.watches.length === 0) this.disarm();
		} finally {
			this.polling = false;
		}
		return fired;
	}

	private async pollAccount(account: string, st: WatchFile): Promise<number> {
		const gmail = this.deps.gmailFor(account);
		const mine = st.watches.filter((w) => w.account === account);
		const cursor = st.cursors[account];
		const fresh = new Map<string, GmailThreadMessage>();

		let nextCursor: string;
		try {
			if (!cursor) throw Object.assign(new Error('no cursor'), { status: 404 });
			const { historyId, added } = await gmail.listHistoryAdded(cursor);
			nextCursor = historyId;
			const watched = new Set(mine.map((w) => w.threadId));
			for (const a of added) {
				if (!watched.has(a.threadId) || mine.some((w) => w.threadId === a.threadId && w.seen.includes(a.id)) || fresh.has(a.id)) continue;
				const meta = await gmail.getMessageMeta(a.id);
				fresh.set(a.id, { ...meta, threadId: a.threadId } as GmailThreadMessage & { threadId: string });
			}
		} catch (err) {
			if ((err as { status?: number }).status !== 404) throw err;
			// Cursor missing or too old: re-seed it, then look at each watched thread once.
			this.logger.warn('Gmail history cursor expired — resyncing watched threads', { account });
			nextCursor = (await gmail.getProfile()).historyId;
			for (const w of mine) {
				for (const m of await gmail.getThread(w.threadId)) {
					if (!w.seen.includes(m.id) && !fresh.has(m.id)) fresh.set(m.id, { ...m, threadId: w.threadId } as GmailThreadMessage & { threadId: string });
				}
			}
		}

		// Persist cursor + fired ids BEFORE publishing (at-most-once).
		const toFire: Array<{ w: GmailThreadWatch; m: GmailThreadMessage }> = [];
		for (const m of fresh.values()) {
			const w = mine.find((x) => x.threadId === (m as { threadId?: string }).threadId);
			if (!w) continue;
			w.seen = [...w.seen, m.id].slice(-MAX_SEEN_PER_THREAD);
			if (!isOwnMessage(m)) {
				w.lastActivityAt = new Date(this.now()).toISOString();
				toFire.push({ w, m });
			}
		}
		st.cursors[account] = nextCursor;
		await this.save();
		for (const { w, m } of toFire) this.deps.publish(this.eventFor(w, m));
		return toFire.length;
	}

	/** Drop watches idle for longer than the expiry. */
	private async expire(st: WatchFile): Promise<void> {
		const limit = this.now() - GOOGLE_WORKSPACE_CONSTANTS.GMAIL_WATCH_EXPIRY_MS;
		const keep = st.watches.filter((w) => Date.parse(w.lastActivityAt) > limit);
		if (keep.length === st.watches.length) return;
		this.logger.info('Gmail thread watches expired', { removed: st.watches.length - keep.length });
		st.watches = keep;
		this.prune(st);
		await this.save();
	}

	/** An account that stays disconnected loses its watches (after a few ticks, not one blip). */
	private async accountStillConnected(account: string, st: WatchFile): Promise<boolean> {
		if (await this.deps.accountConnected(account)) {
			this.misses.delete(account);
			return true;
		}
		const n = (this.misses.get(account) ?? 0) + 1;
		this.misses.set(account, n);
		if (n >= GOOGLE_WORKSPACE_CONSTANTS.GMAIL_WATCH_DISCONNECT_MISSES) {
			st.watches = st.watches.filter((w) => w.account !== account);
			delete st.cursors[account];
			this.misses.delete(account);
			this.logger.info('Account disconnected — Gmail watches removed', { account });
			await this.save();
		}
		return false;
	}

	/** Forget cursors of accounts with no watches. */
	private prune(st: WatchFile): void {
		for (const a of Object.keys(st.cursors)) if (!st.watches.some((w) => w.account === a)) delete st.cursors[a];
	}

	private eventFor(w: GmailThreadWatch, m: GmailThreadMessage): AgentEvent {
		return {
			id: `gmail:reply:${m.id}`,
			type: 'gmail:reply_received',
			timestamp: new Date(this.now()).toISOString(),
			teamId: '',
			teamName: '',
			memberId: '',
			memberName: '',
			sessionName: `${GMAIL_EVENT_SESSION_PREFIX}${w.threadId}`,
			previousValue: '',
			newValue: m.id,
			changedField: 'gmailReply',
			threadId: w.threadId,
			target: w.ownerSession,
		};
	}

	private async load(): Promise<WatchFile> {
		if (this.state) return this.state;
		try {
			const parsed = JSON.parse(await fs.readFile(this.deps.file, 'utf-8')) as Partial<WatchFile>;
			this.state = { cursors: parsed.cursors ?? {}, watches: Array.isArray(parsed.watches) ? parsed.watches : [] };
		} catch {
			this.state = { cursors: {}, watches: [] };
		}
		return this.state;
	}

	private async save(): Promise<void> {
		await fs.mkdir(path.dirname(this.deps.file), { recursive: true });
		await atomicWriteJson(this.deps.file, this.state);
	}
}
