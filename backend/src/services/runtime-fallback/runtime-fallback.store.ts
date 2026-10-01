/**
 * Persistence of runtime-fallback settings and state
 * (`<CREWLY_HOME>/runtime-fallback.json`).
 *
 * Writes are atomic (temp file + rename) so a crash never leaves a half
 * file; an unreadable file reads as defaults.
 *
 * @module services/runtime-fallback/runtime-fallback.store
 */

import * as fs from 'fs';
import * as path from 'path';
import { normalizeSettings, type ExhaustedRuntime, type RuntimeFallbackState, type RuntimeOverride } from './runtime-fallback.types.js';

/** Reads and writes the state. */
export interface RuntimeFallbackStore {
	load(): RuntimeFallbackState;
	save(state: RuntimeFallbackState): void;
}

/**
 * Normalize a parsed state file.
 *
 * @param raw - Parsed JSON (untrusted)
 * @returns State with defaults filled in
 */
export function normalizeState(raw: unknown): RuntimeFallbackState {
	const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	const exhausted: Record<string, ExhaustedRuntime> = {};
	if (obj.exhausted && typeof obj.exhausted === 'object') {
		for (const [runtime, entry] of Object.entries(obj.exhausted as Record<string, Partial<ExhaustedRuntime>>)) {
			if (!entry || typeof entry.since !== 'string') continue;
			exhausted[runtime] = {
				runtime,
				since: entry.since,
				...(typeof entry.until === 'string' ? { until: entry.until } : {}),
				ruleId: typeof entry.ruleId === 'string' ? entry.ruleId : 'unknown',
				...(entry.kind === 'billing' || entry.kind === 'usage_limit' ? { kind: entry.kind } : {}),
				...(typeof entry.failedReverts === 'number' && entry.failedReverts > 0 ? { failedReverts: Math.floor(entry.failedReverts) } : {}),
				...(typeof entry.lastProbeAt === 'string' ? { lastProbeAt: entry.lastProbeAt } : {}),
				switched: Array.isArray(entry.switched) ? entry.switched.filter((s): s is string => typeof s === 'string') : [],
				switchedTo: Array.isArray(entry.switchedTo) ? entry.switchedTo.filter((s): s is string => typeof s === 'string') : [],
				notified: entry.notified === true,
				...(entry.noFallback ? { noFallback: true } : {}),
			};
		}
	}
	const overrides: Record<string, RuntimeOverride> = {};
	if (obj.overrides && typeof obj.overrides === 'object') {
		for (const [session, o] of Object.entries(obj.overrides as Record<string, Partial<RuntimeOverride>>)) {
			if (!o || typeof o.runtime !== 'string' || typeof o.primary !== 'string' || typeof o.since !== 'string') continue;
			overrides[session] = {
				runtime: o.runtime,
				primary: o.primary,
				reason: 'usage_limit',
				since: o.since,
				...(typeof o.until === 'string' ? { until: o.until } : {}),
				...(typeof o.primarySessionId === 'string' ? { primarySessionId: o.primarySessionId } : {}),
				...(o.revertPending ? { revertPending: true } : {}),
			};
		}
	}
	return { version: 1, settings: normalizeSettings(obj.settings), exhausted, overrides };
}

/** File-backed store. */
export class FileRuntimeFallbackStore implements RuntimeFallbackStore {
	/**
	 * @param filePath - State file
	 */
	constructor(private readonly filePath: string) {}

	/**
	 * Read the state (defaults when missing or unreadable).
	 *
	 * @returns State
	 */
	load(): RuntimeFallbackState {
		try {
			return normalizeState(JSON.parse(fs.readFileSync(this.filePath, 'utf-8')));
		} catch {
			return normalizeState(undefined);
		}
	}

	/**
	 * Write the state atomically.
	 *
	 * @param state - State
	 */
	save(state: RuntimeFallbackState): void {
		fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
		const tmp = `${this.filePath}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
		fs.renameSync(tmp, this.filePath);
	}
}

/** In-memory store (tests). */
export class MemoryRuntimeFallbackStore implements RuntimeFallbackStore {
	private state: RuntimeFallbackState;

	/**
	 * @param initial - Starting state (defaults when absent)
	 */
	constructor(initial?: unknown) {
		this.state = normalizeState(initial);
	}

	load(): RuntimeFallbackState {
		return JSON.parse(JSON.stringify(this.state)) as RuntimeFallbackState;
	}

	save(state: RuntimeFallbackState): void {
		this.state = JSON.parse(JSON.stringify(state)) as RuntimeFallbackState;
	}
}
