/**
 * Start a stopped member who was just assigned a ticket
 * (specs/2026-09-28-project-tickets.md §5a).
 *
 * Assigning a ticket queues a WorkItem for the assignee. A running agent
 * gets it pushed by the WorkItem dispatcher; a STOPPED one (idle-stopped,
 * suspended) has no terminal to push to and nothing else starts it — the
 * reconciler's wake only sees members with a live session name — so the
 * ticket sat `in_progress` until someone happened to start the agent.
 *
 * This starts the assignee through the normal member-start endpoint
 * (`POST /api/teams/:teamId/members/:memberId/start`) with the ticket's
 * WorkItem id, as the caller who assigned it. Every existing start gate
 * therefore still applies:
 * - the wake gate passes, because the WorkItem is queued for that member;
 * - the commitment-approval gate applies when the member's team is dormant
 *   (nobody running). A lead assigning inside its own team is running
 *   itself, so its team is never dormant and the start goes through.
 *
 * A refusal is reported, never thrown: the ticket stays assigned and the
 * WorkItem queued, and the member picks it up on its next start.
 *
 * @module services/project-tickets/ticket-assignee-waker
 */

import { AGENT_WAKE_ERROR_CODES } from '../../constants.js';
import { getLocalApiBaseUrl } from '../../utils/local-api-url.utils.js';
import { internalAgentHeaders } from '../core/owner-auth.service.js';

/** What happened to a stopped assignee. */
export interface AssigneeWakeResult {
  /** `started` — start accepted; `blocked` — a start gate refused it; `failed` — any other error */
  outcome: 'started' | 'blocked' | 'failed';
  /** The gate's code when blocked (e.g. `commitment_requires_owner_approval`) */
  code?: string;
  /** Short reason for the log / API answer */
  detail?: string;
}

/** Who to start and why. */
export interface AssigneeWakeRequest {
  teamId: string;
  memberId: string;
  session: string;
  /** The ticket's WorkItem (the wake gate's evidence) */
  workItemId: string;
  /** Who assigned the ticket (sent as `X-Agent-Session`); absent = the owner */
  callerSession?: string;
}

/** Starts a stopped assignee. */
export type AssigneeWaker = (req: AssigneeWakeRequest) => Promise<AssigneeWakeResult>;

/** The subset of `fetch` the HTTP waker uses. */
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * The default waker: the member-start endpoint over loopback.
 *
 * The owner's own assignment (no caller session) is sent without an agent
 * header — the backend then treats it as an internal waker, so the
 * commitment gate still guards a dormant team (the dashboard marker is never
 * forged here).
 *
 * @param fetchImpl - fetch (tests)
 * @param baseUrl - API base (tests)
 * @returns The waker
 */
export function createHttpAssigneeWaker(
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  baseUrl: () => string = getLocalApiBaseUrl,
): AssigneeWaker {
  return async (req) => {
    const url = `${baseUrl()}/api/teams/${encodeURIComponent(req.teamId)}/members/${encodeURIComponent(req.memberId)}/start`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (req.callerSession) Object.assign(headers, internalAgentHeaders(req.callerSession));
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionName: req.session, workItemId: req.workItemId }),
      });
      if (res.ok) return { outcome: 'started' };
      const text = await res.text().catch(() => '');
      const code = (Object.values(AGENT_WAKE_ERROR_CODES) as string[]).find((c) => text.includes(c));
      if (code) return { outcome: 'blocked', code, detail: text.slice(0, 300) };
      return { outcome: 'failed', detail: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    } catch (err) {
      return { outcome: 'failed', detail: err instanceof Error ? err.message : String(err) };
    }
  };
}
