/**
 * Per-machine Terms consent state (`<CREWLY_HOME>/runtime-terms-consent.json`).
 *
 * One record per runtime. Writes are atomic (temp file + rename); an
 * unreadable file reads as empty. specs/2026-10-01-runtime-terms-consent.md
 *
 * @module services/runtime-terms/runtime-terms.store
 */

import * as fs from 'fs';
import * as path from 'path';
import { RUNTIME_TERMS_CONSTANTS } from '../../constants.js';

/**
 * Where a runtime's Terms stand on this machine.
 *
 * - `pending`: the first-run Terms screen was seen; a card is waiting for the owner
 * - `accepting`: the owner agreed; the harness is driving the screens
 * - `accepted`: the screens were completed (or were already done)
 * - `declined`: the owner chose Don't agree (or the deadline applied it)
 * - `failed`: the harness stopped before (or after) Done because the screen did not match
 */
export type RuntimeTermsStatus = 'pending' | 'accepting' | 'accepted' | 'declined' | 'failed';

/** One runtime's record. */
export interface RuntimeTermsRecord {
	runtime: string;
	status: RuntimeTermsStatus;
	/** ISO time of the last change */
	updatedAt: string;
	/** Decision card of the current / last ask */
	decisionId?: string;
	/** Owner's choice for the data-sharing item, once agreed */
	dataSharing?: boolean;
	/** Why it is declined / failed (English, shown in Settings) */
	reason?: string;
	/** What found the Terms screen (launch, smoke_test, settings, probe) */
	detectedBy?: string;
}

/** File shape. */
interface TermsFile {
	version: 1;
	runtimes: Record<string, RuntimeTermsRecord>;
}

const STATUSES: readonly RuntimeTermsStatus[] = ['pending', 'accepting', 'accepted', 'declined', 'failed'];

/** Reads and writes the records. */
export class RuntimeTermsStore {
	/**
	 * @param file - JSON file path
	 */
	constructor(private readonly file: string) {}

	/**
	 * Store in a Crewly home.
	 *
	 * @param crewlyHome - CREWLY_HOME
	 * @returns Store
	 */
	static inHome(crewlyHome: string): RuntimeTermsStore {
		return new RuntimeTermsStore(path.join(crewlyHome, RUNTIME_TERMS_CONSTANTS.STORE_FILENAME));
	}

	/** @returns Every record, keyed by runtime */
	all(): Record<string, RuntimeTermsRecord> {
		return this.read().runtimes;
	}

	/**
	 * One record.
	 *
	 * @param runtime - Runtime id
	 * @returns Record, or null
	 */
	get(runtime: string): RuntimeTermsRecord | null {
		return this.read().runtimes[runtime] ?? null;
	}

	/**
	 * Replace a record.
	 *
	 * @param record - Record
	 * @returns The record
	 */
	set(record: RuntimeTermsRecord): RuntimeTermsRecord {
		const data = this.read();
		data.runtimes[record.runtime] = record;
		this.write(data);
		return record;
	}

	private read(): TermsFile {
		try {
			const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<TermsFile>;
			const runtimes: Record<string, RuntimeTermsRecord> = {};
			for (const [runtime, r] of Object.entries(raw.runtimes ?? {})) {
				if (!r || !STATUSES.includes(r.status) || typeof r.updatedAt !== 'string') continue;
				runtimes[runtime] = { ...r, runtime };
			}
			return { version: 1, runtimes };
		} catch {
			return { version: 1, runtimes: {} };
		}
	}

	private write(data: TermsFile): void {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
		fs.renameSync(tmp, this.file);
	}
}
