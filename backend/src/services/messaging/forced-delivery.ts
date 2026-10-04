/**
 * In-process forced delivery (#1024).
 *
 * What `POST /api/terminal/:s/deliver` with `force: true` does, callable from
 * backend services without an HTTP hop. The runtime exit monitor and the
 * Slack bridge's direct-delivery fallback used to make that hop with no
 * credential; the route now refuses anonymous callers, and a service
 * presenting a pseudo-agent badge would also make the target "act for" the
 * owner (issue #968), which a system notice must not do.
 *
 * Same gates as the route, in the same order:
 * 1. restart drain — queued for after the restart (crewly#1015 §6);
 * 2. daily token cap — queued, no new turn (#937);
 * 3. in-process Crewly Agent — `handleMessage`;
 * 4. PTY — the guarded two-step write (`sendMessage`).
 *
 * @module services/messaging/forced-delivery
 */

import { getSessionBackendSync, createSessionCommandHelper } from '../session/index.js';
import { TuiInputGuardError } from '../session/tui-input-guard.js';
import { getInProcessRuntime } from '../agent/crewly-agent/in-process-runtime-registry.js';
import { queueIfSpendCapped } from './spend-capped-delivery.js';
import { queueIfRestartDraining } from './drain-queued-delivery.js';

/** Outcome of a forced delivery. */
export type ForcedDeliveryResult =
	| { status: 'delivered'; inProcess: boolean }
	| { status: 'queued'; reason: 'restart-drain' | 'spend-cap'; message: string }
	| { status: 'not-found'; error: string }
	| { status: 'input-not-ours'; error: string }
	| { status: 'failed'; error: string };

/** Minimal in-process runtime surface used here. */
interface InProcessTarget {
	isReady(): boolean;
	handleMessage(message: string): Promise<unknown>;
}

/** Injectable dependencies (tests). */
export interface ForcedDeliveryDeps {
	/** In-process Crewly Agent runtime for a session, if any */
	getInProcessRuntime?: (sessionName: string) => InProcessTarget | undefined;
	/** PTY write: resolves when written; throws TuiInputGuardError when the box holds someone else's text */
	writeToPty?: (sessionName: string) => ((message: string) => Promise<void>) | null;
	/** Drain gate */
	queueIfRestartDraining?: typeof queueIfRestartDraining;
	/** Spend-cap gate */
	queueIfSpendCapped?: typeof queueIfSpendCapped;
}

/**
 * The PTY writer for a session, or null when there is no such session.
 *
 * @param sessionName - Target session
 * @returns Writer or null
 */
function defaultPtyWriter(sessionName: string): ((message: string) => Promise<void>) | null {
	const backend = getSessionBackendSync();
	if (!backend || !backend.getSession(sessionName)) return null;
	const helper = createSessionCommandHelper(backend);
	return (message: string) => helper.sendMessage(sessionName, message);
}

/**
 * Force-deliver a message into a local agent, in process.
 *
 * @param sessionName - Target agent session
 * @param message - Message text
 * @param deps - Dependencies (tests)
 * @returns What happened; never throws
 *
 * @example
 * ```ts
 * const r = await deliverForcedMessage(ORCHESTRATOR_SESSION_NAME, notice);
 * if (r.status !== 'delivered' && r.status !== 'queued') logger.debug('not delivered', r);
 * ```
 */
export async function deliverForcedMessage(
	sessionName: string,
	message: string,
	deps: ForcedDeliveryDeps = {},
): Promise<ForcedDeliveryResult> {
	try {
		const held = (deps.queueIfRestartDraining ?? queueIfRestartDraining)(sessionName, message);
		if (held) return { status: 'queued', reason: 'restart-drain', message: held.message };
		const capped = (deps.queueIfSpendCapped ?? queueIfSpendCapped)(sessionName, message);
		if (capped) return { status: 'queued', reason: 'spend-cap', message: capped.message };

		const inProcess = (deps.getInProcessRuntime ?? getInProcessRuntime)(sessionName);
		if (inProcess) {
			if (!inProcess.isReady()) return { status: 'not-found', error: `In-process agent '${sessionName}' is not ready` };
			await inProcess.handleMessage(message);
			return { status: 'delivered', inProcess: true };
		}

		const write = (deps.writeToPty ?? defaultPtyWriter)(sessionName);
		if (!write) return { status: 'not-found', error: `Session '${sessionName}' not found` };
		await write(message);
		return { status: 'delivered', inProcess: false };
	} catch (err) {
		if (err instanceof TuiInputGuardError) return { status: 'input-not-ours', error: err.message };
		return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
	}
}
