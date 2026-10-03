/**
 * Run trace store: append-only `<CREWLY_HOME>/traces/<traceId>.jsonl` files
 * plus a small `index.json` for listing and ref lookups.
 *
 * - Bookkeeping (index, refs, size cap) is synchronous and in memory; file
 *   writes are chained on one promise and never awaited by callers.
 * - A trace takes at most MAX_EVENTS_PER_TRACE events / MAX_BYTES_PER_TRACE
 *   bytes; the event that would cross a limit becomes one `trace.truncated`
 *   marker and later events are dropped.
 * - Traces idle for RETENTION_MS are deleted by a sweep that runs on the first
 *   write after boot and then at most once per SWEEP_INTERVAL_MS.
 * - Nothing here throws to a caller: a failed write is logged and counted.
 *
 * specs/2026-10-03-run-traces.md
 *
 * @module services/trace/trace-store
 */

import { promises as fsp, readFileSync } from 'fs';
import * as path from 'path';
import { TRACE_CONSTANTS } from '../../constants.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import {
	isTraceId,
	traceRefKey,
	type TraceEvent,
	type TraceIndexEntry,
	type TraceIndexFile,
	type TraceRefKind,
	type TraceRoot,
	type TraceRootKind,
} from './trace.types.js';

/** File operations the store uses (injectable to simulate failures). */
export interface TraceFsOps {
	mkdir(dir: string, opts: { recursive: true }): Promise<unknown>;
	appendFile(file: string, data: string): Promise<void>;
	writeFile(file: string, data: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	readFile(file: string): Promise<string>;
	unlink(file: string): Promise<void>;
	readdir(dir: string): Promise<string[]>;
	stat(file: string): Promise<{ mtimeMs: number }>;
}

/** The real file system. */
const NODE_FS: TraceFsOps = {
	mkdir: (dir, opts) => fsp.mkdir(dir, opts),
	appendFile: (file, data) => fsp.appendFile(file, data, 'utf8'),
	writeFile: (file, data) => fsp.writeFile(file, data, 'utf8'),
	rename: (from, to) => fsp.rename(from, to),
	readFile: (file) => fsp.readFile(file, 'utf8'),
	unlink: (file) => fsp.unlink(file),
	readdir: (dir) => fsp.readdir(dir),
	stat: (file) => fsp.stat(file),
};

/** Options (all optional; tests override limits and the clock). */
export interface TraceStoreOptions {
	/** Traces folder (default `<CREWLY_HOME>/traces`, resolved on first use) */
	dir?: string;
	now?: () => Date;
	fs?: TraceFsOps;
	maxEvents?: number;
	maxBytes?: number;
	retentionMs?: number;
	sweepIntervalMs?: number;
	indexFlushDelayMs?: number;
}

/** Filters of {@link TraceStore.list}. */
export interface TraceListFilter {
	/** Only traces with an event at or after this time */
	since?: Date;
	/** Only this root kind */
	rootKind?: TraceRootKind;
	limit?: number;
}

/** One page of a trace. */
export interface TracePage {
	root: TraceRoot;
	events: TraceEvent[];
	/** Events in the file */
	total: number;
	offset: number;
	limit: number;
	truncated: boolean;
}

/** Result of a retention sweep. */
export interface TraceSweepResult {
	removedTraces: number;
	removedFiles: number;
}

/**
 * The trace store. One per process (see {@link getTraceStore}).
 */
export class TraceStore {
	private readonly logger: ComponentLogger;
	private readonly fs: TraceFsOps;
	private readonly now: () => Date;
	private readonly maxEvents: number;
	private readonly maxBytes: number;
	private readonly retentionMs: number;
	private readonly sweepIntervalMs: number;
	private readonly indexFlushDelayMs: number;
	private readonly explicitDir?: string;
	private resolvedDir: string | null = null;
	private index: TraceIndexFile | null = null;
	private chain: Promise<void> = Promise.resolve();
	private indexTimer: NodeJS.Timeout | null = null;
	private dirReady = false;
	private sweepScheduled = false;
	private failures = 0;

	/**
	 * @param options - Folder, clock, limits, file ops
	 */
	constructor(options: TraceStoreOptions = {}) {
		this.logger = LoggerService.getInstance().createComponentLogger('TraceStore');
		this.fs = options.fs ?? NODE_FS;
		this.now = options.now ?? (() => new Date());
		this.maxEvents = options.maxEvents ?? TRACE_CONSTANTS.MAX_EVENTS_PER_TRACE;
		this.maxBytes = options.maxBytes ?? TRACE_CONSTANTS.MAX_BYTES_PER_TRACE;
		this.retentionMs = options.retentionMs ?? TRACE_CONSTANTS.RETENTION_MS;
		this.sweepIntervalMs = options.sweepIntervalMs ?? TRACE_CONSTANTS.SWEEP_INTERVAL_MS;
		this.indexFlushDelayMs = options.indexFlushDelayMs ?? TRACE_CONSTANTS.INDEX_FLUSH_DELAY_MS;
		this.explicitDir = options.dir;
	}

	/**
	 * The traces folder.
	 *
	 * @returns Absolute path
	 */
	get dir(): string {
		if (!this.resolvedDir) this.resolvedDir = this.explicitDir ?? path.join(getCrewlyHomePath(), TRACE_CONSTANTS.DIR_NAME);
		return this.resolvedDir;
	}

	/** Writes that failed since the store was created. */
	get writeFailures(): number {
		return this.failures;
	}

	// ---------------------------------------------------------------------------
	// Writes (fire-and-forget)
	// ---------------------------------------------------------------------------

	/**
	 * Register a new trace and write its `trace.root` event.
	 *
	 * @param root - The root (its traceId must be new and well-formed)
	 * @returns True when registered
	 */
	createRoot(root: TraceRoot): boolean {
		try {
			if (!isTraceId(root.traceId)) return false;
			const index = this.loadIndex();
			if (index.traces[root.traceId]) return false;
			index.traces[root.traceId] = {
				traceId: root.traceId,
				root,
				updatedAt: root.createdAt,
				eventCount: 0,
				bytes: 0,
				truncated: false,
			};
			this.append({
				ts: root.createdAt,
				traceId: root.traceId,
				type: 'trace.root',
				actor: root.actor,
				refs: root.refs,
				summary: root.summary,
				outcome: 'info',
				data: { kind: root.kind },
			});
			return true;
		} catch (err) {
			this.noteFailure('createRoot', err);
			return false;
		}
	}

	/**
	 * Append one event. Unknown traces and events past the cap are dropped.
	 *
	 * @param event - The event
	 * @returns True when it was queued for writing
	 */
	append(event: TraceEvent): boolean {
		try {
			const index = this.loadIndex();
			const entry = index.traces[event.traceId];
			if (!entry || entry.truncated) return false;
			let line = `${JSON.stringify(event)}\n`;
			let bytes = Buffer.byteLength(line);
			if (entry.eventCount + 1 > this.maxEvents || entry.bytes + bytes > this.maxBytes) {
				const marker: TraceEvent = {
					ts: event.ts,
					traceId: event.traceId,
					type: 'trace.truncated',
					actor: { kind: 'system' },
					refs: {},
					summary: `Trace reached its size limit (${entry.eventCount} events, ${entry.bytes} bytes); later events are dropped`,
					outcome: 'info',
				};
				line = `${JSON.stringify(marker)}\n`;
				bytes = Buffer.byteLength(line);
				entry.truncated = true;
			}
			entry.eventCount += 1;
			entry.bytes += bytes;
			if (event.ts > entry.updatedAt) entry.updatedAt = event.ts;
			const file = this.fileOf(event.traceId);
			this.enqueue(async () => {
				await this.ensureDir();
				await this.fs.appendFile(file, line);
			}, 'append');
			this.scheduleIndexFlush();
			this.maybeSweep();
			return !entry.truncated || event.type === 'trace.truncated';
		} catch (err) {
			this.noteFailure('append', err);
			return false;
		}
	}

	/**
	 * Remember which trace an entity belongs to. The first link wins: an
	 * entity is never moved to another trace.
	 *
	 * @param kind - Entity kind
	 * @param id - Entity id
	 * @param traceId - Trace
	 */
	linkRef(kind: TraceRefKind, id: string, traceId: string): void {
		try {
			if (!id || !isTraceId(traceId)) return;
			const index = this.loadIndex();
			if (!index.traces[traceId]) return;
			const key = traceRefKey(kind, id);
			if (index.refs[key]) return;
			index.refs[key] = traceId;
			this.scheduleIndexFlush();
		} catch (err) {
			this.noteFailure('linkRef', err);
		}
	}

	// ---------------------------------------------------------------------------
	// Reads
	// ---------------------------------------------------------------------------

	/**
	 * The trace an entity belongs to.
	 *
	 * @param kind - Entity kind
	 * @param id - Entity id
	 * @returns Trace id, or null
	 */
	traceByRef(kind: TraceRefKind, id: string | null | undefined): string | null {
		if (!id) return null;
		try {
			const traceId = this.loadIndex().refs[traceRefKey(kind, id)];
			return traceId && this.loadIndex().traces[traceId] ? traceId : null;
		} catch {
			return null;
		}
	}

	/**
	 * Whether a trace exists.
	 *
	 * @param traceId - Trace id
	 * @returns True when indexed
	 */
	has(traceId: string): boolean {
		try {
			return isTraceId(traceId) && !!this.loadIndex().traces[traceId];
		} catch {
			return false;
		}
	}

	/**
	 * The index entry of a trace.
	 *
	 * @param traceId - Trace id
	 * @returns Copy of the entry, or null
	 */
	getEntry(traceId: string): TraceIndexEntry | null {
		if (!this.has(traceId)) return null;
		const entry = this.loadIndex().traces[traceId];
		return { ...entry, root: { ...entry.root } };
	}

	/**
	 * Traces, most recently active first.
	 *
	 * @param filter - Since / root kind / limit
	 * @returns Index entries (copies)
	 */
	list(filter: TraceListFilter = {}): TraceIndexEntry[] {
		const since = filter.since ? filter.since.toISOString() : null;
		const limit = Math.max(1, Math.min(filter.limit ?? TRACE_CONSTANTS.DEFAULT_LIST_LIMIT, TRACE_CONSTANTS.MAX_LIST_LIMIT));
		let entries: TraceIndexEntry[];
		try {
			entries = Object.values(this.loadIndex().traces);
		} catch {
			return [];
		}
		return entries
			.filter((e) => (!since || e.updatedAt >= since) && (!filter.rootKind || e.root.kind === filter.rootKind))
			.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
			.slice(0, limit)
			.map((e) => ({ ...e, root: { ...e.root } }));
	}

	/**
	 * One page of a trace's events, oldest first. Waits for queued writes.
	 *
	 * @param traceId - Trace id
	 * @param offset - Events to skip
	 * @param limit - Page size
	 * @returns The page, or null when the trace is unknown
	 */
	async read(traceId: string, offset = 0, limit: number = TRACE_CONSTANTS.DEFAULT_PAGE_SIZE): Promise<TracePage | null> {
		const entry = this.getEntry(traceId);
		if (!entry) return null;
		await this.flush();
		let raw = '';
		try {
			raw = await this.fs.readFile(this.fileOf(traceId));
		} catch (err) {
			this.logger.debug('Trace file could not be read', { traceId, error: errText(err) });
		}
		const events: TraceEvent[] = [];
		for (const line of raw.split('\n')) {
			if (!line.trim()) continue;
			try {
				events.push(JSON.parse(line) as TraceEvent);
			} catch {
				// A torn last line (crash mid-append) is skipped.
			}
		}
		const start = Math.max(0, offset);
		const size = Math.max(1, Math.min(limit, TRACE_CONSTANTS.MAX_PAGE_SIZE));
		return {
			root: entry.root,
			events: events.slice(start, start + size),
			total: events.length,
			offset: start,
			limit: size,
			truncated: entry.truncated,
		};
	}

	// ---------------------------------------------------------------------------
	// Retention + persistence
	// ---------------------------------------------------------------------------

	/**
	 * Delete traces whose last event is older than the retention, their refs,
	 * and orphan `.jsonl` files older than the retention.
	 *
	 * @returns What was removed
	 */
	async sweep(): Promise<TraceSweepResult> {
		const result: TraceSweepResult = { removedTraces: 0, removedFiles: 0 };
		try {
			const index = this.loadIndex();
			const nowMs = this.now().getTime();
			const cutoff = new Date(nowMs - this.retentionMs).toISOString();
			const expired = new Set(Object.values(index.traces).filter((e) => e.updatedAt < cutoff).map((e) => e.traceId));
			for (const id of expired) delete index.traces[id];
			for (const [key, traceId] of Object.entries(index.refs)) {
				if (expired.has(traceId) || !index.traces[traceId]) delete index.refs[key];
			}
			index.lastSweepAt = new Date(nowMs).toISOString();
			result.removedTraces = expired.size;
			await this.flush();
			let files: string[] = [];
			try {
				files = await this.fs.readdir(this.dir);
			} catch {
				files = [];
			}
			for (const name of files) {
				if (!name.endsWith('.jsonl')) continue;
				const id = name.slice(0, -'.jsonl'.length);
				const file = path.join(this.dir, name);
				let remove = expired.has(id);
				if (!remove && !index.traces[id]) {
					const stat = await this.fs.stat(file).catch(() => null);
					remove = !!stat && stat.mtimeMs < nowMs - this.retentionMs;
				}
				if (!remove) continue;
				await this.fs.unlink(file).then(
					() => {
						result.removedFiles += 1;
					},
					(err) => this.logger.debug('Expired trace file could not be removed', { file, error: errText(err) }),
				);
			}
			await this.writeIndex();
			if (result.removedTraces || result.removedFiles) this.logger.info('Trace retention sweep', { ...result });
		} catch (err) {
			this.noteFailure('sweep', err);
		}
		return result;
	}

	/**
	 * Wait for queued writes and write the index now.
	 */
	async flush(): Promise<void> {
		if (this.indexTimer) {
			clearTimeout(this.indexTimer);
			this.indexTimer = null;
			this.enqueue(() => this.writeIndex(), 'index');
		}
		await this.chain;
	}

	/**
	 * Stop the index timer (tests / shutdown). Pending writes still finish.
	 */
	dispose(): void {
		if (this.indexTimer) clearTimeout(this.indexTimer);
		this.indexTimer = null;
	}

	// ---------------------------------------------------------------------------
	// Internals
	// ---------------------------------------------------------------------------

	/**
	 * Path of a trace's event file.
	 *
	 * @param traceId - A well-formed id
	 * @returns Absolute path
	 */
	private fileOf(traceId: string): string {
		return path.join(this.dir, `${traceId}.jsonl`);
	}

	/**
	 * The in-memory index, read from disk on first use.
	 *
	 * @returns The index
	 */
	private loadIndex(): TraceIndexFile {
		if (this.index) return this.index;
		let loaded: TraceIndexFile | null = null;
		try {
			const parsed = JSON.parse(readFileSync(path.join(this.dir, TRACE_CONSTANTS.INDEX_FILE), 'utf8')) as Partial<TraceIndexFile>;
			if (parsed && typeof parsed === 'object' && parsed.traces && parsed.refs) {
				loaded = {
					version: TRACE_CONSTANTS.INDEX_VERSION,
					...(parsed.lastSweepAt ? { lastSweepAt: parsed.lastSweepAt } : {}),
					traces: parsed.traces,
					refs: parsed.refs,
				};
			}
		} catch {
			loaded = null;
		}
		this.index = loaded ?? { version: TRACE_CONSTANTS.INDEX_VERSION, traces: {}, refs: {} };
		return this.index;
	}

	/** Create the folder once. */
	private async ensureDir(): Promise<void> {
		if (this.dirReady) return;
		await this.fs.mkdir(this.dir, { recursive: true });
		this.dirReady = true;
	}

	/** Write the index atomically (temp file + rename). */
	private async writeIndex(): Promise<void> {
		const index = this.loadIndex();
		await this.ensureDir();
		const file = path.join(this.dir, TRACE_CONSTANTS.INDEX_FILE);
		const tmp = `${file}.${process.pid}.tmp`;
		await this.fs.writeFile(tmp, JSON.stringify(index));
		await this.fs.rename(tmp, file);
	}

	/** Write the index after a short delay, once per burst of changes. */
	private scheduleIndexFlush(): void {
		if (this.indexTimer) return;
		this.indexTimer = setTimeout(() => {
			this.indexTimer = null;
			this.enqueue(() => this.writeIndex(), 'index');
		}, this.indexFlushDelayMs);
		this.indexTimer.unref?.();
	}

	/** Run the retention sweep when it is due (first write after boot, then daily). */
	private maybeSweep(): void {
		if (this.sweepScheduled) return;
		const last = this.loadIndex().lastSweepAt;
		const due = !last || this.now().getTime() - Date.parse(last) >= this.sweepIntervalMs;
		if (!due) return;
		this.sweepScheduled = true;
		void this.chain.then(() => this.sweep()).finally(() => {
			this.sweepScheduled = false;
		});
	}

	/**
	 * Chain a write after the previous one; a failure is logged and counted.
	 *
	 * @param op - The write
	 * @param what - Label for the log
	 */
	private enqueue(op: () => Promise<void>, what: string): void {
		this.chain = this.chain.then(op).catch((err) => this.noteFailure(what, err));
	}

	/**
	 * Count and log (debug) a failure.
	 *
	 * @param what - Operation
	 * @param err - Error
	 */
	private noteFailure(what: string, err: unknown): void {
		this.failures += 1;
		this.logger.debug('Trace write failed (ignored)', { what, error: errText(err) });
	}
}

/**
 * Error text.
 *
 * @param err - Anything thrown
 * @returns Message
 */
function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

let instance: TraceStore | null = null;

/**
 * The process-wide trace store.
 *
 * @returns The store (created on first use)
 */
export function getTraceStore(): TraceStore {
	if (!instance) instance = new TraceStore();
	return instance;
}

/**
 * Replace the process-wide store (tests).
 *
 * @param store - Store, or null to rebuild the default lazily
 */
export function setTraceStoreForTesting(store: TraceStore | null): void {
	instance?.dispose();
	instance = store;
}
