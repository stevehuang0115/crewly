/**
 * Process-tree corrections of a request's agent identity, kept out of band.
 *
 * The agent-origin middleware proves from `X-Agent-Pid` which agent PTY a
 * skill shell really runs under. When that contradicts the identity the
 * shell claimed, it records the correction here. The caller-identity
 * middleware (#999) reads it to override a leaked agent badge. A header
 * would not do: a client could send it itself.
 *
 * @module middleware/agent-origin-correction
 */

/** The shell claimed `claimed`; its process runs under `actual`. */
export interface AgentOriginCorrection {
	claimed: string;
	actual: string;
}

const corrections = new WeakMap<object, AgentOriginCorrection>();

/**
 * Record a correction for a request.
 *
 * @param req - Request object
 * @param correction - Claimed and actual sessions
 */
export function setAgentOriginCorrection(req: object, correction: AgentOriginCorrection): void {
	corrections.set(req, correction);
}

/**
 * The correction recorded for a request, if any.
 *
 * @param req - Request object
 * @returns The correction or undefined
 */
export function getAgentOriginCorrection(req: object): AgentOriginCorrection | undefined {
	return corrections.get(req);
}
