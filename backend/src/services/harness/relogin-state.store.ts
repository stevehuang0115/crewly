/**
 * Persisted re-login state — what survives a backend restart.
 *
 * The owner is told once per harness per machine that it is signed out, then
 * re-reminded with backoff. Without persistence every restart (an
 * auto-update, a crash loop while every agent is stuck) would DM again. The
 * file also remembers which harnesses were seen signed in, so a later
 * `logged_out` is an expiry and not a machine that was never set up.
 *
 * File: `<crewlyHome>/harness-relogin-state.json` (mode 0600, no secrets).
 *
 * @module services/harness/relogin-state.store
 */

import * as fs from 'fs';
import * as path from 'path';
import { HARNESS_CONSTANTS } from '../../constants.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { isHarnessId, type HarnessId } from './harness.types.js';

/** What is remembered for one harness. */
export interface HarnessReloginRecord {
	/** When the harness was first confirmed signed out (epoch ms) */
	signedOutSince?: number;
	/** When the owner was last told (epoch ms) */
	lastNoticeAt?: number;
	/** Notices sent since it was signed out (drives the backoff) */
	noticeCount?: number;
	/** Last time the harness was seen signed in (epoch ms) */
	seenLoggedInAt?: number;
}

/** Storage for {@link HarnessReloginRecord}s. */
export interface ReloginStateStore {
	get(harnessId: HarnessId): HarnessReloginRecord;
	update(harnessId: HarnessId, patch: Partial<HarnessReloginRecord> | null): void;
}

/** In-memory store (tests, CLI). */
export class MemoryReloginStateStore implements ReloginStateStore {
	private readonly records = new Map<HarnessId, HarnessReloginRecord>();

	get(harnessId: HarnessId): HarnessReloginRecord {
		return { ...(this.records.get(harnessId) ?? {}) };
	}

	/**
	 * Merge a patch (null / undefined fields are dropped; a null patch clears the record).
	 *
	 * @param harnessId - Harness
	 * @param patch - Fields to set, or null to forget the harness
	 */
	update(harnessId: HarnessId, patch: Partial<HarnessReloginRecord> | null): void {
		if (patch === null) {
			this.records.delete(harnessId);
			return;
		}
		const next: HarnessReloginRecord = { ...(this.records.get(harnessId) ?? {}) };
		for (const [key, value] of Object.entries(patch) as Array<[keyof HarnessReloginRecord, number | undefined]>) {
			if (value === undefined || value === null) delete next[key];
			else next[key] = value;
		}
		this.records.set(harnessId, next);
	}

	/** @returns Every record (persistence) */
	entries(): Array<[HarnessId, HarnessReloginRecord]> {
		return [...this.records.entries()];
	}
}

/** File-backed store; a missing or unreadable file starts empty. */
export class FileReloginStateStore extends MemoryReloginStateStore {
	/**
	 * @param file - JSON file path
	 */
	constructor(private readonly file: string) {
		super();
		try {
			const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { harnesses?: Record<string, HarnessReloginRecord> };
			for (const [id, record] of Object.entries(raw.harnesses ?? {})) {
				if (isHarnessId(id) && record && typeof record === 'object') super.update(id, record);
			}
		} catch {
			// Missing or corrupt: start empty.
		}
	}

	/** @inheritdoc */
	override update(harnessId: HarnessId, patch: Partial<HarnessReloginRecord> | null): void {
		super.update(harnessId, patch);
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			const tmp = `${this.file}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify({ harnesses: Object.fromEntries(this.entries()) }, null, 2), { mode: 0o600 });
			fs.renameSync(tmp, this.file);
		} catch {
			// Best effort: the in-memory state still applies.
		}
	}
}

/**
 * The backend's store under CREWLY_HOME.
 *
 * @returns A file store
 */
export function createDefaultReloginStateStore(): ReloginStateStore {
	return new FileReloginStateStore(path.join(getCrewlyHomePath(), HARNESS_CONSTANTS.RELOGIN.STATE_FILENAME));
}
