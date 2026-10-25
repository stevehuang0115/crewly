/**
 * Team charter endpoint (specs/2026-10-10-team-roster.md):
 * `PUT /api/teams/:id/charter` with `{ charter }`.
 *
 * A charter is the few sentences that say what a team is responsible for.
 * The orchestrator routes owner requests with it, so the team's own lead keeps
 * it current. Allowed: the owner, the orchestrator, and a lead of that team.
 * An empty charter clears it (the roster falls back to the description).
 *
 * @module controllers/team/team-charter.controller
 */

import type { Request, Response } from 'express';
import { TEAM_ROSTER_CONSTANTS as C } from '../../constants.js';
import { StorageService } from '../../services/core/storage.service.js';
import { TeamRosterService } from '../../services/team-roster/team-roster.service.js';
import { resolveAgentCaller } from '../../utils/agent-caller.utils.js';
import { getTeamLeads } from '../../utils/team.utils.js';
import { memberSessionKeys } from '../../services/team/team-pause.registry.js';
import { recordActivity } from '../../services/activity/activity-log.service.js';

/**
 * PUT /api/teams/:id/charter
 *
 * @param req - `:id` = team id; body `{ charter: string }`
 * @param res - 200 `{ success, data: { teamId, charter } }`; 400 invalid text; 401/403 caller may not write it; 404 unknown team
 */
export async function setTeamCharter(req: Request, res: Response): Promise<void> {
	try {
		const body = (req.body ?? {}) as { charter?: unknown };
		if (typeof body.charter !== 'string') {
			res.status(400).json({ success: false, error: 'charter must be a string (empty clears it)' });
			return;
		}
		const charter = body.charter.replace(/\s+/g, ' ').trim();
		if (charter.length > C.CHARTER_MAX_CHARS) {
			res.status(400).json({ success: false, error: `charter is ${charter.length} chars; keep it to ${C.CHARTER_MAX_CHARS} (what the team owns, what it takes, what it avoids)` });
			return;
		}
		const storage = StorageService.getInstance();
		const team = (await storage.getTeams()).find((t) => t.id === req.params.id);
		if (!team) {
			res.status(404).json({ success: false, error: 'Team not found' });
			return;
		}
		const caller = await resolveAgentCaller(req);
		let by: string;
		if (caller.anonymous) {
			res.status(401).json({ success: false, error: 'Owner or agent credentials required' });
			return;
		} else if (!caller.session) {
			by = 'owner';
		} else if (caller.role === 'orchestrator') {
			by = 'orchestrator';
		} else {
			const lead = getTeamLeads(team).find((m) => memberSessionKeys(team.name, m).includes(caller.session as string));
			if (!lead) {
				res.status(403).json({ success: false, error: 'Only the lead of this team (or the orchestrator, or the owner) can write its charter' });
				return;
			}
			by = caller.session;
		}
		team.updatedAt = new Date().toISOString();
		if (charter) {
			team.charter = charter;
			team.charterUpdatedAt = team.updatedAt;
			team.charterUpdatedBy = by;
		} else {
			delete team.charter;
			delete team.charterUpdatedAt;
			delete team.charterUpdatedBy;
		}
		await storage.saveTeam(team);
		TeamRosterService.getInstance().invalidate();
		recordActivity({
			actor: by === 'owner' ? { type: 'owner' } : { type: 'agent', id: by },
			action: charter ? 'team.charter.updated' : 'team.charter.cleared',
			target: { type: 'team', id: team.id, name: team.name },
			...(charter ? { after: { charter } } : {}),
		});
		res.json({ success: true, data: { teamId: team.id, charter: charter || null } });
	} catch (err) {
		res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
	}
}
