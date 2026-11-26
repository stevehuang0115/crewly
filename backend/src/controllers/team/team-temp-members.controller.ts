/**
 * Temporary members and permanent seat requests
 * (specs/2026-11-26-temp-members-seat-requests.md):
 *
 * - `GET    /api/teams/:id/temp-members` — the team's temporary headcount and who uses it.
 * - `POST   /api/teams/:id/temp-members` — the team's lead (`add-temp-member`): `{ role, reason, name?, workItemId? }`.
 * - `DELETE /api/teams/:id/temp-members/:member` — the team's lead (`remove-temp-member`): body `{ reason?, force? }`.
 * - `POST   /api/teams/:id/seat-requests` — the team's lead (`request-seat`): `{ role, reason, name? }`.
 *
 * The temporary headcount itself is the owner's setting, on the team update
 * route (`PUT /api/teams/:id` `{ tempHeadcount }`).
 *
 * @module controllers/team/team-temp-members.controller
 */

import type { Request, Response } from 'express';
import { getTempMemberService, TempMemberError, type TempMemberService } from '../../services/temp-members/temp-member.service.js';
import { actorFromRequest, recordActivity } from '../../services/activity/activity-log.service.js';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';

/**
 * The running service, or a 503.
 *
 * @param res - Response
 * @returns Service, or null after answering 503
 */
function serviceOr503(res: Response): TempMemberService | null {
  const s = getTempMemberService();
  if (!s) res.status(503).json({ success: false, error: 'Temporary members are not running yet (they start a few seconds after boot). Try again in a minute.' });
  return s;
}

/**
 * Answer a refusal: the service's status, code and message, else a 500.
 *
 * @param res - Response
 * @param err - What was thrown
 */
function fail(res: Response, err: unknown): void {
  if (err instanceof TempMemberError) {
    res.status(err.status).json({ success: false, error: err.message, code: err.code });
    return;
  }
  res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
}

/**
 * GET /api/teams/:id/temp-members
 *
 * @param req - `:id` = team id
 * @param res - 200 `{ success, data: { teamId, headcount: { used, limit }, members } }`
 */
export async function getTeamTempMembers(req: Request, res: Response): Promise<void> {
  const s = serviceOr503(res);
  if (!s) return;
  try {
    res.json({ success: true, data: await s.status(req.params.id) });
  } catch (err) {
    fail(res, err);
  }
}

/**
 * POST /api/teams/:id/temp-members — a lead of that team adds a temporary member.
 *
 * @param req - Caller = X-Agent-Session; body `{ role, reason, name?, workItemId? }`
 * @param res - 200 `{ success, data: { member, temporary, headcount, delegate, note, hint? } }`; 400 / 403 / 409 with `code`
 */
export async function addTeamTempMember(req: Request, res: Response): Promise<void> {
  const s = serviceOr503(res);
  if (!s) return;
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const data = await s.addTemp(readAgentSessionHeader(req), req.params.id, { role: body.role, reason: body.reason, name: body.name, workItemId: body.workItemId });
    const member = data.member as { id: string; name: string; role: string };
    recordActivity({
      actor: actorFromRequest(req),
      action: 'team.member.added',
      target: { type: 'member', id: member.id, name: member.name },
      after: { teamId: req.params.id, role: member.role, temporary: true, reason: String(body.reason ?? '') },
    });
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
}

/**
 * DELETE /api/teams/:id/temp-members/:member — a lead of that team removes a
 * temporary member early. Permanent members are refused.
 *
 * @param req - Caller = X-Agent-Session; `:member` = id, name or session; body `{ reason?, force? }`
 * @param res - 200 `{ success, data: { removed, member, headcount } }`; 403 / 404 / 409 with `code`
 */
export async function removeTeamTempMember(req: Request, res: Response): Promise<void> {
  const s = serviceOr503(res);
  if (!s) return;
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const data = await s.removeTemp(readAgentSessionHeader(req), req.params.id, { member: req.params.member, reason: body.reason, force: body.force === true });
    const member = data.member as { id: string; name: string; role: string };
    recordActivity({
      actor: actorFromRequest(req),
      action: 'team.member.removed',
      target: { type: 'member', id: member.id, name: member.name },
      before: { teamId: req.params.id, role: member.role, temporary: true },
    });
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
}

/**
 * POST /api/teams/:id/seat-requests — a lead of that team asks the owner for
 * a permanent seat (one owner card).
 *
 * @param req - Caller = X-Agent-Session; body `{ role, reason, name? }`
 * @param res - 200 `{ success, data: { requested, decisionId, note } }`; 400 / 403 / 409 / 503 with `code`
 */
export async function requestTeamSeat(req: Request, res: Response): Promise<void> {
  const s = serviceOr503(res);
  if (!s) return;
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.json({ success: true, data: await s.requestSeat(readAgentSessionHeader(req), req.params.id, { role: body.role, reason: body.reason, name: body.name }) });
  } catch (err) {
    fail(res, err);
  }
}
