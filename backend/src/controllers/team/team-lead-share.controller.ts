/**
 * Team-lead delegation endpoints (crewly#1083, specs/2026-10-04-tl-delegation.md):
 *
 * - `GET /api/teams/:id/lead-share` — the team's lead share of tokens (today,
 *   this week), nudge counts, and the lead's recent "no member fits" records.
 * - `POST /api/teams/lead-self-work` — a lead records work it keeps because
 *   no member fits (`delegate-task --no-member-fits`).
 *
 * @module controllers/team/team-lead-share.controller
 */

import type { Request, Response } from 'express';
import { TL_DELEGATION_CONSTANTS } from '../../constants.js';
import { StorageService } from '../../services/core/storage.service.js';
import { TokenUsageService } from '../../services/monitoring/token-usage.service.js';
import { computeLeadShares, memberLedgerKeys, startOfLocalDay } from '../../services/tl-delegation/lead-share.js';
import { leadContextFromTeams, TlDelegationService } from '../../services/tl-delegation/tl-delegation.service.js';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';

/** Kept-work records returned by GET (most recent). */
const RECENT_RECORDS = 10;

/**
 * GET /api/teams/:id/lead-share
 *
 * @param req - `:id` = team id
 * @param res - 200 `{ success, data: { row | null, nudges, keptWork } }`; 404 unknown team
 */
export async function getTeamLeadShare(req: Request, res: Response): Promise<void> {
  try {
    const teams = await StorageService.getInstance().getTeams();
    const team = teams.find((t) => t.id === req.params.id);
    if (!team) {
      res.status(404).json({ success: false, error: 'Team not found' });
      return;
    }
    const usage = TokenUsageService.getInstance();
    const now = new Date();
    const row = computeLeadShares([team], (visit, since) => usage.forEachEvent(visit, since), now)[0] ?? null;
    const delegation = TlDelegationService.getInstance();
    const sessions = row?.leadSessions ?? [];
    const weekStart = startOfLocalDay(new Date(now.getTime() - (TL_DELEGATION_CONSTANTS.WEEK_DAYS - 1) * 24 * 60 * 60 * 1000)).getTime();
    const keptWork = delegation.keptWorkSince(weekStart, { teamId: team.id, sessions }).slice(-RECENT_RECORDS).reverse();
    res.json({
      success: true,
      data: {
        row,
        nudges: delegation.nudgeCounts(sessions),
        keptWork,
        flagShare: TL_DELEGATION_CONSTANTS.FLAG_SHARE,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * POST /api/teams/lead-self-work — body `{ reason, work, workItemId?, ticket? }`,
 * caller = X-Agent-Session (the lead).
 *
 * @param req - Request
 * @param res - 201 `{ success, data: record }`; 400 missing caller / fields
 */
export async function recordLeadSelfWork(req: Request, res: Response): Promise<void> {
  try {
    const session = readAgentSessionHeader(req);
    if (!session) {
      res.status(400).json({ success: false, error: 'X-Agent-Session is required: only an agent records the work it keeps' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const work = typeof body.work === 'string' ? body.work.trim() : '';
    if (!reason || !work) {
      res.status(400).json({ success: false, error: 'reason and work are required: name what is missing (access, tool, permission, everyone busy) and the work you keep' });
      return;
    }
    const teams = await StorageService.getInstance().getTeams().catch(() => []);
    const teamId =
      leadContextFromTeams(teams, session)?.teamId ??
      teams.find((t) => (t.members ?? []).some((m) => memberLedgerKeys(m).includes(session)))?.id;
    const record = TlDelegationService.getInstance().recordKeptWork({
      session,
      ...(teamId ? { teamId } : {}),
      reason,
      work,
      ...(typeof body.workItemId === 'string' && body.workItemId.trim() ? { workItemId: body.workItemId.trim() } : {}),
      ...(typeof body.ticket === 'string' && body.ticket.trim() ? { ticket: body.ticket.trim() } : {}),
    });
    res.status(201).json({ success: true, data: record });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}
