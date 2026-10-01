/**
 * The runtime an agent really runs on, for code that only knows the
 * member's configured runtime.
 *
 * While an agent runs on a fallback runtime (its runtime ran out of usage)
 * the member record still names its configured runtime. Every place that
 * decides HOW to talk to a session (PTY heuristics, Ctrl+C, delivery,
 * activity detection) asks {@link effectiveRuntimeType} instead.
 *
 * This module holds only the hooks the RuntimeFallbackService registers, so
 * importing it is cheap and cycle-free; with no service registered every
 * function is a no-op that returns the configured value.
 *
 * @module services/runtime-fallback/effective-runtime
 */

/** Where a usage-limit report came from. */
export type RuntimeOutputSource = 'output' | 'screen' | 'error';

/** What {@link resolveLaunchRuntime} decided. */
export interface LaunchRuntimeDecision {
	/** Runtime to launch */
	runtime: string;
	/** True when it is not the configured runtime (a fallback) */
	overridden: boolean;
	/** Model to run when the fallback is the Crewly Agent (provider/model) */
	crewlyAgentModel?: string;
}

/** Input of a launch decision. */
export interface LaunchRuntimeInput {
	sessionName: string;
	/** The member's (or orchestrator's) configured runtime */
	configured: string;
	memberId?: string;
	teamId?: string;
	isOrchestrator: boolean;
}

/** Hooks the RuntimeFallbackService provides. */
export interface RuntimeFallbackHooks {
	/** Runtime a session runs on instead of its configured one, or null */
	overrideFor(sessionName: string): string | null;
	/** Runtime to launch a session on (may start a fallback for an exhausted runtime) */
	resolveLaunch(input: LaunchRuntimeInput): Promise<LaunchRuntimeDecision>;
	/** Before a message is written into a session: deliver now, or queue it (a switch is running / needed) */
	beforeDelivery(sessionName: string, runtime: string): 'deliver' | 'queue';
	/** Runtime output / error text of a session, checked for a usage limit */
	reportOutput(sessionName: string, runtime: string, text: string, source: RuntimeOutputSource): boolean;
	/** One-time note for the session's next kickoff (after a switch), consumed */
	takeKickoffNote(sessionName: string): string | null;
}

let hooks: RuntimeFallbackHooks | null = null;

/**
 * Register (or clear) the hooks.
 *
 * @param next - Hooks, or null
 */
export function setRuntimeFallbackHooks(next: RuntimeFallbackHooks | null): void {
	hooks = next;
}

/**
 * The runtime a session actually runs on.
 *
 * @param sessionName - Session name (undefined → configured)
 * @param configured - Its configured runtime
 * @returns The fallback runtime while one is active, else `configured`
 *
 * @example
 * ```ts
 * const runtime = effectiveRuntimeType(member.sessionName, member.runtimeType as RuntimeType);
 * ```
 */
export function effectiveRuntimeType<T extends string>(sessionName: string | undefined | null, configured: T): T {
	if (!hooks || !sessionName) return configured;
	try {
		return (hooks.overrideFor(sessionName) as T | null) ?? configured;
	} catch {
		return configured;
	}
}

/**
 * Decide the runtime to launch a session on.
 *
 * @param input - Session and its configured runtime
 * @returns The decision (configured runtime when no hooks are registered)
 */
export async function resolveLaunchRuntime(input: LaunchRuntimeInput): Promise<LaunchRuntimeDecision> {
	if (!hooks) return { runtime: input.configured, overridden: false };
	try {
		return await hooks.resolveLaunch(input);
	} catch {
		return { runtime: input.configured, overridden: false };
	}
}

/**
 * Gate before a delivery.
 *
 * @param sessionName - Target session
 * @param runtime - Runtime the caller resolved
 * @returns `queue` when the message must wait for a runtime switch
 */
export function runtimeFallbackBeforeDelivery(sessionName: string, runtime: string): 'deliver' | 'queue' {
	if (!hooks) return 'deliver';
	try {
		return hooks.beforeDelivery(sessionName, runtime);
	} catch {
		return 'deliver';
	}
}

/**
 * Report runtime output (live chunk, screen, or an error) for usage-limit detection.
 *
 * @param sessionName - Session
 * @param runtime - Runtime it runs on
 * @param text - Output / error text (never logged)
 * @param source - Where it came from
 * @returns True when a usage limit was recognised
 */
export function reportRuntimeOutput(sessionName: string, runtime: string, text: string, source: RuntimeOutputSource): boolean {
	if (!hooks || !text) return false;
	try {
		return hooks.reportOutput(sessionName, runtime, text, source);
	} catch {
		return false;
	}
}

/**
 * Take the note a session's next kickoff should carry after a switch.
 *
 * @param sessionName - Session
 * @returns The note, once, or null
 */
export function takeRuntimeSwitchKickoffNote(sessionName: string): string | null {
	if (!hooks) return null;
	try {
		return hooks.takeKickoffNote(sessionName);
	} catch {
		return null;
	}
}
