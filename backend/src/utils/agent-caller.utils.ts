/**
 * Who is calling an agent-facing API.
 *
 * The caller-identity middleware (#999, specs/2026-10-03-owner-auth.md)
 * decides from credentials: agents carry a badge (skills also send
 * `X-Agent-Session`), the owner holds the dashboard session or the API
 * token. A request without an agent header is NOT the owner — it is the
 * owner only with an owner credential ({@link isOwnerCaller}).
 *
 * @module utils/agent-caller
 */

import type { Request } from 'express';
import { API_SECURITY_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../constants.js';
import { StorageService } from '../services/core/storage.service.js';
import { getCallerIdentity, isOwnerCaller } from '../middleware/caller-identity.middleware.js';

export { isOwnerCaller };

/**
 * The resolved caller: `session` for an agent, `{}` for the owner, and
 * `{ anonymous: true }` for a caller with neither (never the owner).
 */
export interface AgentCaller {
  session?: string;
  /** Team-member role, `orchestrator`, or `worker` when the session is unknown. */
  role?: string;
  /** No agent identity and no owner credential */
  anonymous?: boolean;
}

/**
 * Resolve the calling agent.
 *
 * @param req - Incoming request
 * @returns `{}` for the owner, `{ anonymous: true }` for an unidentified
 *   caller, otherwise the session and its role
 */
export async function resolveAgentCaller(req: Request): Promise<AgentCaller> {
  const identity = getCallerIdentity(req);
  if (identity.kind === 'owner' || identity.kind === 'relay-owner') return {};
  const session = readAgentSessionHeader(req);
  if (!session) return identity.kind === 'agent' ? { role: 'worker' } : { anonymous: true };
  if (session === ORCHESTRATOR_SESSION_NAME) return { session, role: 'orchestrator' };
  try {
    const found = await StorageService.getInstance().findMemberBySessionName(session);
    return { session, role: found ? String(found.member.role) : 'worker' };
  } catch {
    return { session, role: 'worker' };
  }
}

/**
 * The agent session of the caller, if it is an agent.
 *
 * The caller-identity middleware's answer when it ran (the badge's session,
 * corrected by the process tree), else the `X-Agent-Session` header. Absent
 * does NOT mean the owner — use {@link isOwnerCaller} for that.
 *
 * @param req - Incoming request
 * @returns The session, or undefined when the caller is not an identified agent
 */
export function readAgentSessionHeader(req: Pick<Request, 'headers'>): string | undefined {
  const identity = getCallerIdentity(req);
  if (identity.kind === 'agent' && identity.session) return identity.session;
  if (identity.kind !== 'agent') return undefined;
  const headers = req.headers ?? {};
  const hdr =
    headers[API_SECURITY_CONSTANTS.AGENT_SESSION_HEADER] ??
    headers[API_SECURITY_CONSTANTS.AGENT_SESSION_HEADER_LEGACY];
  const value = Array.isArray(hdr) ? hdr[0] : hdr;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Whether a request is a human action by the owner (dashboard, phone, portal,
 * or the owner's API token).
 *
 * Used to rely on a self-set `X-Crewly-Caller: dashboard` header, which any
 * agent could send (#999). It now means "the caller holds an owner
 * credential" ({@link isOwnerCaller}). Callers that act on an agent's behalf
 * and send no credential — the reconciler's hybrid-wake, the auto-claim
 * wake, an in-process client without a session — are anonymous and still
 * NOT the owner, so the 2026-06-02 incident path (orchestrator writes a
 * WorkItem, an internal waker starts the dormant team) stays closed.
 *
 * @param req - Incoming request
 * @returns True only for an owner-credentialed request
 */
export function isOwnerDashboardRequest(req: Pick<Request, 'headers'>): boolean {
  return isOwnerCaller(req);
}

/**
 * Resolve the actor of a WorkItem status transition from the request (#813).
 *
 * Identity comes from the caller-identity middleware, never from the body:
 * - agent `crewly-orc` → `orchestrator` with that session.
 * - any other agent → `agent` with that session. What that session may do
 *   to a given item (complete it as its assignee, render a verdict as its
 *   reviewer) is decided per item by the transition gate.
 * - an owner credential ({@link isOwnerCaller}) → `owner`.
 * - nothing → `agent` with NO session: it can still take the worker edges it
 *   always could, but it has no identity, so it can never be anyone's reviewer.
 *
 * Agents are identified by their badge (#999); a bare `X-Agent-Session`
 * still names an agent for one release (migration window).
 *
 * @param req - Incoming request (only its headers are read)
 * @param via - Entry point, recorded on the actor for the audit log
 * @returns The transition actor
 *
 * @example
 * ```typescript
 * const actor = resolveTransitionActor(req, 'POST /task-pool/complete');
 * await pool.completeItem(id, result, actor);
 * ```
 */
export function resolveTransitionActor(
  req: Pick<Request, 'headers'>,
  via: string,
): { role: 'orchestrator' | 'agent' | 'owner'; session?: string; via: string } {
  const session = readAgentSessionHeader(req);
  if (session) {
    return { role: session === ORCHESTRATOR_SESSION_NAME ? 'orchestrator' : 'agent', session, via };
  }
  if (isOwnerDashboardRequest(req)) return { role: 'owner', via };
  return { role: 'agent', via };
}
