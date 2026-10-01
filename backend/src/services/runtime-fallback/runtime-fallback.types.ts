/**
 * Runtime fallback — shared types, settings defaults and validation.
 *
 * specs/2026-10-01-runtime-fallback.md
 *
 * @module services/runtime-fallback/runtime-fallback.types
 */

import { RUNTIME_FALLBACK_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';

/** Every runtime id Crewly knows. */
export const KNOWN_RUNTIMES: readonly string[] = Object.values(RUNTIME_TYPES);

/** Why an agent runs on a runtime other than its configured one. */
export type RuntimeOverrideReason = 'usage_limit';

/**
 * An agent temporarily running on another runtime. The member's configured
 * runtime (`primary`) is never changed.
 */
export interface RuntimeOverride {
	/** Runtime the agent runs on now */
	runtime: string;
	/** The member's configured runtime */
	primary: string;
	reason: RuntimeOverrideReason;
	/** ISO time the override started */
	since: string;
	/** ISO time the primary is expected back, when known */
	until?: string;
	/** Conversation id of the primary, restored when switching back */
	primarySessionId?: string;
	/** The primary is back; revert at the next idle boundary */
	revertPending?: boolean;
}

/** A runtime that is out of usage on this machine (account-wide). */
export interface ExhaustedRuntime {
	runtime: string;
	/** ISO time it was detected */
	since: string;
	/** ISO time it resets, when known (never for `billing`) */
	until?: string;
	/**
	 * `usage_limit` (a window that resets) or `billing` (out of money/credit:
	 * no timed retry, probed at most every BILLING_PROBE_INTERVAL_MS).
	 * Missing = `usage_limit` (state from before the field existed).
	 */
	kind?: 'usage_limit' | 'billing';
	/** Switch-backs that failed (the limit came straight back); backs off the next probe */
	failedReverts?: number;
	/** Rule that matched (never contains output) */
	ruleId: string;
	/** Last switch-back probe (ISO) */
	lastProbeAt?: string;
	/** Sessions switched away during this event */
	switched: string[];
	/** Fallback runtimes those sessions went to */
	switchedTo: string[];
	/** The owner was told about this event */
	notified: boolean;
	/** No fallback was available for at least one agent */
	noFallback?: boolean;
}

/** Owner-editable settings. */
export interface RuntimeFallbackSettings {
	enabled: boolean;
	/** Global fallback order */
	chain: string[];
	/** Per-member chains, keyed by member id */
	memberChains: Record<string, string[]>;
	/** The orchestrator switches too */
	orcFollows: boolean;
	/** provider/model a Crewly Agent fallback runs */
	crewlyAgentModel: string;
	probeIntervalMinutes: number;
}

/** What is persisted. */
export interface RuntimeFallbackState {
	version: 1;
	settings: RuntimeFallbackSettings;
	exhausted: Record<string, ExhaustedRuntime>;
	/** Active overrides, keyed by session name */
	overrides: Record<string, RuntimeOverride>;
}

/** Availability of one runtime as a fallback target. */
export interface RuntimeAvailability {
	runtime: string;
	label: string;
	/** Installed and signed in (Crewly Agent: an API key for its model's provider) */
	selectable: boolean;
	/** Why not, when not selectable ("Not installed", "Not signed in", …) */
	reason?: string;
	/** Not selectable because its Terms are not accepted (the owner can still add it: that asks again) */
	termsBlocked?: boolean;
}

/**
 * Default settings.
 *
 * @returns A fresh copy
 */
export function defaultRuntimeFallbackSettings(): RuntimeFallbackSettings {
	return {
		enabled: true,
		chain: [...RUNTIME_FALLBACK_CONSTANTS.DEFAULT_CHAIN],
		memberChains: {},
		orcFollows: true,
		crewlyAgentModel: RUNTIME_FALLBACK_CONSTANTS.DEFAULT_CREWLY_AGENT_MODEL,
		probeIntervalMinutes: RUNTIME_FALLBACK_CONSTANTS.DEFAULT_PROBE_INTERVAL_MINUTES,
	};
}

/**
 * Display name of a runtime.
 *
 * @param runtime - Runtime id
 * @param crewlyAgentModel - Model a Crewly Agent runs (a DeepSeek model reads as "DeepSeek")
 * @returns e.g. "Claude Code", "DeepSeek"
 */
export function runtimeLabel(runtime: string, crewlyAgentModel?: string): string {
	if (runtime === RUNTIME_TYPES.CREWLY_AGENT && crewlyAgentModel?.toLowerCase().startsWith('deepseek/')) return 'DeepSeek';
	return RUNTIME_FALLBACK_CONSTANTS.LABELS[runtime] ?? runtime;
}

/**
 * Short name of a runtime for "(Claude limit)".
 *
 * @param runtime - Runtime id
 * @returns e.g. "Claude"
 */
export function runtimeShortLabel(runtime: string): string {
	return RUNTIME_FALLBACK_CONSTANTS.SHORT_LABELS[runtime] ?? runtime;
}

/** A validation failure. */
export class RuntimeFallbackSettingsError extends Error {}

/**
 * Validate a chain: known runtime ids, no duplicates (later duplicates dropped).
 *
 * @param value - Candidate
 * @param field - Field name for the error
 * @returns The clean chain
 * @throws RuntimeFallbackSettingsError on an unknown id or a non-array
 */
function validateChain(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) throw new RuntimeFallbackSettingsError(`${field} must be a list of runtimes`);
	const out: string[] = [];
	for (const entry of value) {
		if (typeof entry !== 'string' || !KNOWN_RUNTIMES.includes(entry)) {
			throw new RuntimeFallbackSettingsError(`${field} has an unknown runtime: ${String(entry)}`);
		}
		if (!out.includes(entry)) out.push(entry);
	}
	return out;
}

/**
 * Apply a partial settings update.
 *
 * @param current - Current settings
 * @param patch - Owner's update (untrusted)
 * @returns New settings
 * @throws RuntimeFallbackSettingsError when the patch is invalid
 *
 * @example
 * ```ts
 * applySettingsPatch(defaultRuntimeFallbackSettings(), { chain: ['claude-code', 'antigravity-cli'] });
 * ```
 */
export function applySettingsPatch(current: RuntimeFallbackSettings, patch: unknown): RuntimeFallbackSettings {
	if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
		throw new RuntimeFallbackSettingsError('Settings must be an object');
	}
	const p = patch as Record<string, unknown>;
	const next: RuntimeFallbackSettings = { ...current, chain: [...current.chain], memberChains: { ...current.memberChains } };
	if ('enabled' in p) {
		if (typeof p.enabled !== 'boolean') throw new RuntimeFallbackSettingsError('enabled must be true or false');
		next.enabled = p.enabled;
	}
	if ('orcFollows' in p) {
		if (typeof p.orcFollows !== 'boolean') throw new RuntimeFallbackSettingsError('orcFollows must be true or false');
		next.orcFollows = p.orcFollows;
	}
	if ('chain' in p) next.chain = validateChain(p.chain, 'chain');
	if ('memberChains' in p) {
		const raw = p.memberChains;
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RuntimeFallbackSettingsError('memberChains must be an object');
		const chains: Record<string, string[]> = {};
		for (const [memberId, chain] of Object.entries(raw as Record<string, unknown>)) {
			// null / empty clears a member's override
			if (chain === null || (Array.isArray(chain) && chain.length === 0)) continue;
			chains[memberId] = validateChain(chain, `memberChains.${memberId}`);
		}
		next.memberChains = chains;
	}
	if ('crewlyAgentModel' in p) {
		if (typeof p.crewlyAgentModel !== 'string' || !/^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/.test(p.crewlyAgentModel)) {
			throw new RuntimeFallbackSettingsError('crewlyAgentModel must look like provider/model');
		}
		next.crewlyAgentModel = p.crewlyAgentModel;
	}
	if ('probeIntervalMinutes' in p) {
		const n = Number(p.probeIntervalMinutes);
		const { MIN_PROBE_INTERVAL_MINUTES: min, MAX_PROBE_INTERVAL_MINUTES: max } = RUNTIME_FALLBACK_CONSTANTS;
		if (!Number.isInteger(n) || n < min || n > max) {
			throw new RuntimeFallbackSettingsError(`probeIntervalMinutes must be a whole number from ${min} to ${max}`);
		}
		next.probeIntervalMinutes = n;
	}
	return next;
}

/**
 * Settings read from disk, with defaults for anything missing or invalid.
 *
 * @param raw - Parsed JSON (untrusted)
 * @returns Settings
 */
export function normalizeSettings(raw: unknown): RuntimeFallbackSettings {
	const base = defaultRuntimeFallbackSettings();
	if (!raw || typeof raw !== 'object') return base;
	let out = base;
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		try {
			out = applySettingsPatch(out, { [key]: value });
		} catch {
			// keep the default for a field that does not validate
		}
	}
	return out;
}
