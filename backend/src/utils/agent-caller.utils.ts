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
import { ORCHESTRATOR_SESSION_NAME } from '../constants.js';
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
  const hdr = req.headers['x-agent-session'] ?? req.headers['x-crewly-agent-session'];
  const session = typeof hdr === 'string' && hdr.trim().length > 0 ? hdr.trim() : undefined;
  if (!session) return {};
  if (session === ORCHESTRATOR_SESSION_NAME) return { session, role: 'orchestrator' };
  try {
    const found = await StorageService.getInstance().findMemberBySessionName(session);
    return { session, role: found ? String(found.member.role) : 'worker' };
  } catch {
    return { session, role: 'worker' };
  }
}
