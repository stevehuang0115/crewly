/**
 * Durable store of held browser actions (irreversible clicks waiting for the
 * owner). One JSON file under CREWLY_HOME, so a held action survives a
 * Crewly restart: it is re-attached to its tab, or expired and the agent is
 * told — never silently dropped.
 *
 * Only what is needed to ask and to tell is stored: never the call's params
 * (a page script or typed text may hold anything).
 *
 * @module services/browser/held-action-store
 */

import * as path from 'path';
import { BROWSER_APPROVAL_CONSTANTS } from '../../constants.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';

/** Lifecycle of a held action. */
export type HeldActionStatus =
	/** Waiting for the owner */
	| 'pending'
	/** The owner said Let it */
	| 'approved'
	/** The owner said No */
	| 'rejected'
	/** No answer by the deadline: treated as No */
	| 'timed_out'
	/** Lost to a restart (its tab could not be re-bound) */
	| 'expired'
	/** Dropped without an answer (the owner took the wheel and gave it back) */
	| 'dropped';

/** One held action. */
export interface HeldBrowserAction {
	/** `PendingConfirmation.id` */
	pendingId: string;
	agentSession: string;
	/** Display name, when known at hold time */
	agentName?: string;
	tool: string;
	/** `describeAction` of the call */
	description: string;
	/** Why it was held ("submitting") */
	matched: string;
	/** What it wants to do, e.g. `click "Submit"` */
	target: string;
	/** "host/path" of the page, when known */
	where?: string;
	/** Last URL the agent targeted */
	url?: string;
	/** Tab it was bound to, when known */
	tabId?: number;
	/** Relay browser instance of that tab */
	instanceId?: string;
	/** When it was held (epoch ms) */
	raisedAt: number;
	/** Text the action would put out, shown on the card */
	draftText?: string;
	/** `PendingConfirmation.fingerprint`: an approval admits only this action */
	fingerprint?: string;
	/** Decision card asking the owner */
	decisionId?: string;
	/** Last attempt to create the card (epoch ms) */
	cardTriedAt?: number;
	status: HeldActionStatus;
	/** When it settled (epoch ms) */
	settledAt?: number;
}

interface HeldActionFile {
	actions: HeldBrowserAction[];
}

/**
 * Persistent store of held browser actions.
 */
export class HeldActionStore {
	private data: HeldActionFile | null = null;
	private chain: Promise<unknown> = Promise.resolve();

	/**
	 * @param filePath - JSON file
	 * @param now - Clock (tests)
	 */
	constructor(
		private readonly filePath: string,
		private readonly now: () => number = () => Date.now(),
	) {}

	/**
	 * Store under a CREWLY_HOME.
	 *
	 * @param crewlyHome - CREWLY_HOME
	 * @returns The store
	 */
	static inHome(crewlyHome: string): HeldActionStore {
		return new HeldActionStore(path.join(crewlyHome, BROWSER_APPROVAL_CONSTANTS.STORE_FILENAME));
	}

	/**
	 * Add (or replace) a held action.
	 *
	 * @param action - The record
	 * @returns A copy
	 */
	async put(action: HeldBrowserAction): Promise<HeldBrowserAction> {
		return this.serial(async () => {
			const data = await this.load();
			data.actions = data.actions.filter((a) => a.pendingId !== action.pendingId);
			data.actions.push({ ...action });
			await this.save();
			return { ...action };
		});
	}

	/**
	 * Change a record under the write lock.
	 *
	 * @param pendingId - Record id
	 * @param fn - Returns the patch, or null to leave it alone
	 * @returns The updated record, or null when missing / unchanged
	 */
	async update(pendingId: string, fn: (a: HeldBrowserAction) => Partial<HeldBrowserAction> | null): Promise<HeldBrowserAction | null> {
		return this.serial(async () => {
			const data = await this.load();
			const idx = data.actions.findIndex((a) => a.pendingId === pendingId);
			if (idx < 0) return null;
			const patch = fn({ ...data.actions[idx] });
			if (!patch) return null;
			data.actions[idx] = { ...data.actions[idx], ...patch };
			await this.save();
			return { ...data.actions[idx] };
		});
	}

	/**
	 * Settle a pending record (only once).
	 *
	 * @param pendingId - Record id
	 * @param status - Outcome
	 * @returns The settled record, or null when it was not pending
	 */
	settle(pendingId: string, status: Exclude<HeldActionStatus, 'pending'>): Promise<HeldBrowserAction | null> {
		return this.update(pendingId, (a) => (a.status === 'pending' ? { status, settledAt: this.now() } : null));
	}

	/**
	 * One record.
	 *
	 * @param pendingId - Record id
	 * @returns Copy, or null
	 */
	async get(pendingId: string): Promise<HeldBrowserAction | null> {
		const data = await this.load();
		const a = data.actions.find((x) => x.pendingId === pendingId);
		return a ? { ...a } : null;
	}

	/**
	 * Records, optionally filtered.
	 *
	 * @param filter - Predicate
	 * @returns Copies, oldest first
	 */
	async list(filter?: (a: HeldBrowserAction) => boolean): Promise<HeldBrowserAction[]> {
		const data = await this.load();
		return data.actions.filter((a) => !filter || filter(a)).map((a) => ({ ...a }));
	}

	/**
	 * Drop settled records older than the keep window.
	 *
	 * @returns How many were dropped
	 */
	async prune(): Promise<number> {
		return this.serial(async () => {
			const data = await this.load();
			const cutoff = this.now() - BROWSER_APPROVAL_CONSTANTS.KEEP_SETTLED_MS;
			const before = data.actions.length;
			data.actions = data.actions.filter((a) => a.status === 'pending' || (a.settledAt ?? a.raisedAt) >= cutoff);
			const dropped = before - data.actions.length;
			if (dropped > 0) await this.save();
			return dropped;
		});
	}

	private async load(): Promise<HeldActionFile> {
		if (this.data) return this.data;
		const raw = await safeReadJson<Partial<HeldActionFile>>(this.filePath, {});
		this.data = { actions: Array.isArray(raw.actions) ? raw.actions : [] };
		return this.data;
	}

	private async save(): Promise<void> {
		if (this.data) await atomicWriteJson(this.filePath, this.data);
	}

	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.chain.then(fn, fn);
		this.chain = next.catch(() => undefined);
		return next;
	}
}
