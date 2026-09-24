/**
 * Who is calling an agent-facing API.
 *
 * Skills send `X-Agent-Session: <sessionName>` (see
 * `config/skills/agent/_common/lib.sh`). A request without it came from the
 * dashboard or a curl by the owner — that is the owner, not an agent, and
 * the two are allowed different things.
 *
 * @module utils/agent-caller
 */

import type { Request } from 'express';
import { API_SECURITY_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../constants.js';
import { StorageService } from '../services/core/storage.service.js';

/** The resolved caller. `session` absent = the owner (dashboard / direct call). */
export interface AgentCaller {
  session?: string;
  /** Team-member role, `orchestrator`, or `worker` when the session is unknown. */
  role?: string;
}

/**
 * Resolve the calling agent from the request headers.
 *
 * @param req - Incoming request
 * @returns `{}` for the owner, otherwise the session and its role
 */
export async function resolveAgentCaller(req: Request): Promise<AgentCaller> {
  const session = readAgentSessionHeader(req);
  if (!session) return {};
  if (session === ORCHESTRATOR_SESSION_NAME) return { session, role: 'orchestrator' };
  try {
    const found = await StorageService.getInstance().findMemberBySessionName(session);
    return { session, role: found ? String(found.member.role) : 'worker' };
  } catch {
    return { session, role: 'worker' };
  }
}

/**
 * The agent session a request declares, if any.
 *
 * @param req - Incoming request (only its headers are read)
 * @returns The trimmed `X-Agent-Session` value, or undefined when absent/blank
 */
export function readAgentSessionHeader(req: Pick<Request, 'headers'>): string | undefined {
  const hdr =
    req.headers[API_SECURITY_CONSTANTS.AGENT_SESSION_HEADER] ??
    req.headers[API_SECURITY_CONSTANTS.AGENT_SESSION_HEADER_LEGACY];
  const value = Array.isArray(hdr) ? hdr[0] : hdr;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Whether a request is a human action taken from the dashboard.
 *
 * Stricter than {@link resolveAgentCaller}'s "no header = owner": it also
 * requires the dashboard's positive `X-Crewly-Caller: dashboard` marker.
 * A missing `X-Agent-Session` alone is not enough, because several callers
 * that act on an agent's behalf send no header at all: the reconciler's
 * hybrid-wake and the auto-claim wake (server-to-server `fetch`/`axios`),
 * and an in-process crewly-agent client started without a session name.
 * Treating those as the owner would reopen the 2026-06-02 incident path
 * (orchestrator writes a WorkItem, an internal waker starts the dormant team).
 *
 * An agent session header always wins: a skill that also sets the dashboard
 * marker is still an agent.
 *
 * @param req - Incoming request (only its headers are read)
 * @returns True only for a dashboard request with no agent session
 */
export function isOwnerDashboardRequest(req: Pick<Request, 'headers'>): boolean {
  if (readAgentSessionHeader(req)) return false;
  const hdr = req.headers[API_SECURITY_CONSTANTS.CALLER_HEADER];
  const value = Array.isArray(hdr) ? hdr[0] : hdr;
  return typeof value === 'string' && value.trim().toLowerCase() === API_SECURITY_CONSTANTS.DASHBOARD_CALLER;
}
