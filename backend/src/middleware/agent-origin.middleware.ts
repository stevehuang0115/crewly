/**
 * Agent Origin Middleware
 *
 * Checks a local skill request's claimed identity (`X-Agent-Session`) against
 * the agent PTY its process actually runs under (`X-Agent-Pid`, walked up the
 * process tree). When the process provably belongs to a different agent, the
 * request is treated as that agent: `X-Agent-Session` is rewritten and the
 * claim is kept in `X-Agent-Session-Claimed`. Either way it WARNs, because a
 * wrong CREWLY_SESSION_NAME means the runtime leaked another agent's
 * environment (Codex's shared app-server daemon did, 2026-09-30).
 *
 * It only ever corrects a header that is already there — it never gives an
 * anonymous request an agent identity — and only on loopback, where the pid
 * means something. A slow or failed lookup leaves the request as it came.
 *
 * @module agent-origin.middleware
 */

import type { Request, Response, NextFunction } from 'express';
import { AGENT_ORIGIN_CONSTANTS } from '../constants.js';
import { LoggerService } from '../services/core/logger.service.js';
import { getSessionBackendSync } from '../services/session/session-backend.factory.js';
import { AgentProcessOriginService, type ProcessOrigin } from '../services/agent/agent-process-origin.service.js';
import { isLoopbackAddress, isLoopbackRequest } from './api-token.middleware.js';
import { setAgentOriginCorrection } from './agent-origin-correction.js';
import { inProcessRuntimePids } from '../services/agent/crewly-agent/in-process-runtime-registry.js';

const logger = LoggerService.getInstance().createComponentLogger('AgentOriginMiddleware');

/**
 * PTY shell pid → session name for the live sessions, plus each Crewly Agent
 * child process (#1024), which has no PTY.
 *
 * @returns Map (empty when nothing is running)
 */
export function liveSessionPids(): Map<number, string> {
	const out = inProcessRuntimePids();
	const backend = getSessionBackendSync();
	if (!backend) return out;
	for (const name of backend.listSessions()) {
		const pid = backend.getSession(name)?.pid;
		if (typeof pid === 'number' && pid > 1) out.set(pid, name);
	}
	return out;
}

let originService: AgentProcessOriginService | null = null;
const lastWarned = new Map<string, number>();


/**
 * Log at most once per WARN_THROTTLE_MS per key.
 *
 * @param key - Throttle key
 * @param message - Log message
 * @param meta - Log fields
 */
function warnThrottled(key: string, message: string, meta: Record<string, unknown>): void {
	const now = Date.now();
	const last = lastWarned.get(key);
	if (last !== undefined && now - last < AGENT_ORIGIN_CONSTANTS.WARN_THROTTLE_MS) return;
	lastWarned.set(key, now);
	logger.warn(message, meta);
}

/**
 * Resolve with `null` if the lookup takes longer than `ms`.
 *
 * @param promise - Lookup
 * @param ms - Timeout
 * @returns The lookup's result or null
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(null);
			},
		);
	});
}

/**
 * Apply a resolved origin to the request: rewrite a contradicted header and
 * warn about it, or warn that the command ran in a shared daemon.
 *
 * @param req - Request (headers are mutated when corrected)
 * @param claimed - The X-Agent-Session the shell sent
 * @param origin - Where its process really runs
 */
export function applyAgentOrigin(req: Request, claimed: string, origin: ProcessOrigin): void {
	if (origin.session && origin.session !== claimed) {
		// Out of band for the caller-identity middleware (#999): the header below is for logs.
		setAgentOriginCorrection(req, { claimed, actual: origin.session });
		req.headers[AGENT_ORIGIN_CONSTANTS.CLAIMED_SESSION_HEADER] = claimed;
		req.headers[AGENT_ORIGIN_CONSTANTS.SESSION_HEADER] = origin.session;
		warnThrottled(`mismatch:${claimed}:${origin.session}`, 'Skill request claimed another agent\'s identity — its process runs under a different agent PTY; treating it as that agent. The runtime leaked the wrong CREWLY_SESSION_NAME into the agent\'s shell.', {
			claimedSession: claimed,
			actualSession: origin.session,
			viaSharedDaemon: origin.viaSharedDaemon,
			path: req.path,
		});
		return;
	}
	if (!origin.session && origin.viaSharedDaemon) {
		warnThrottled(`daemon:${claimed}`, 'Skill request came from a shared Codex app-server daemon, not an agent PTY — its X-Agent-Session may belong to whichever agent started the daemon. Restart the agent so Codex launches with --no-daemon.', {
			claimedSession: claimed,
			path: req.path,
		});
	}
}

/**
 * Express middleware; see the module doc. Runs after the API-token gate and
 * before the heartbeat middleware, so the heartbeat and every controller see
 * the corrected identity.
 *
 * @param req - Express request
 * @param _res - Express response
 * @param next - Next handler
 */
export function agentOriginMiddleware(req: Request, _res: Response, next: NextFunction): void {
	const claimed = req.headers[AGENT_ORIGIN_CONSTANTS.SESSION_HEADER];
	const rawPid = req.headers[AGENT_ORIGIN_CONSTANTS.PID_HEADER];
	if (typeof claimed !== 'string' || !claimed || typeof rawPid !== 'string' || !/^\d+$/.test(rawPid)) {
		next();
		return;
	}
	const pid = Number(rawPid);
	if (pid <= 1 || !isLoopbackAddress(req.socket?.remoteAddress ?? '') || !isLoopbackRequest(req)) {
		next();
		return;
	}
	originService ??= new AgentProcessOriginService({ listSessionPids: liveSessionPids });
	void withTimeout(originService.resolve(pid), AGENT_ORIGIN_CONSTANTS.LOOKUP_TIMEOUT_MS).then((origin) => {
		try {
			if (origin) applyAgentOrigin(req, claimed, origin);
		} catch (error) {
			logger.debug('Agent origin check failed (request left as sent)', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		next();
	});
}

/**
 * Replace the origin service (tests).
 *
 * @param service - Service to use, or null to rebuild the default lazily
 */
export function setAgentOriginServiceForTesting(service: AgentProcessOriginService | null): void {
	originService = service;
	lastWarned.clear();
}
