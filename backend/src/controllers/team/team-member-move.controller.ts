/**
 * Move an existing agent to another team
 * (specs/2026-11-27-move-team-member.md):
 *
 * - `POST /api/teams/:id/members/:memberId/move` — the owner or the
 *   orchestrator (`move-team-member`): `{ toTeamId, allowLead?, asLead? }`.
 *
 * @module controllers/team/team-member-move.controller
 */

import type { Request, Response } from 'express';
import { CREWLY_CONSTANTS } from '../../constants.js';
import type { ApiContext } from '../types.js';
import type { TeamMember } from '../../types/index.js';
import { rejectNonOwnerOrOrchestrator } from '../../middleware/caller-identity.middleware.js';
import { actorFromRequest, recordActivity, type ActivityActor } from '../../services/activity/activity-log.service.js';
import { isAgentBusy } from '../../services/agent/member-relaunch.js';
import { LoggerService } from '../../services/core/logger.service.js';
import { DecisionService } from '../../services/decisions/decision.service.js';
import { getSessionBackendSync, getSessionStatePersistence } from '../../services/session/index.js';
import { TaskPoolService } from '../../services/task-pool/task-pool.service.js';
import { MoveRefusedError, moveTeamMember, type MemberRunState, type MoveMemberDeps } from '../../services/team/team-member-move.service.js';
import { applyTeamLead } from '../../services/team-lead-required/team-lead.apply.js';
import { TriggerEngine } from '../../services/v3/trigger-engine.service.js';
import { CronTaskService } from '../../services/workflow/cron-task.service.js';

const logger = LoggerService.getInstance().createComponentLogger('TeamMemberMove');

/**
 * What a member's session is doing. A session that cannot be read counts as
 * busy, so a working agent is never moved by mistake.
 *
 * @param member - Stored entry
 * @param sessionName - Its session
 * @returns Run state
 */
export async function memberRunState(member: TeamMember, sessionName: string): Promise<MemberRunState> {
  const status = member.agentStatus;
  if (status === CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVATING || status === 'starting') return 'starting';
  // In-process runtimes have no terminal session; their status is all there is.
  const running = (getSessionBackendSync()?.sessionExists(sessionName) ?? false) || status === CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE;
  if (!running) return 'stopped';
  if (status === 'started') return 'starting';
  if (member.workingStatus === CREWLY_CONSTANTS.WORKING_STATUSES.IN_PROGRESS) return 'busy';
  return (await isAgentBusy(sessionName)) ? 'busy' : 'idle';
}

/**
 * The live stores a move uses.
 *
 * @param context - API context
 * @param actor - Who asked, for the lead change's activity entry
 * @returns Dependencies
 */
export function buildMoveDeps(context: Pick<ApiContext, 'storageService'>, actor: ActivityActor): MoveMemberDeps {
  const decisions = DecisionService.getInstance();
  return {
    storage: context.storageService,
    runState: memberRunState,
    makeLead: (team, memberId) => applyTeamLead({ storage: context.storageService, team, memberId, actor }),
    workItems: TaskPoolService.getInstance(),
    // Empty until the engine has loaded at boot, so nothing is written before then.
    triggers: TriggerEngine.getInstance(),
    cron: CronTaskService.getInstance(),
    ...(decisions ? { decisions } : {}),
    sessionState: getSessionStatePersistence(),
  };
}

/**
 * `POST /api/teams/:id/members/:memberId/move`.
 *
 * @param req - `{ toTeamId, allowLead?, asLead? }`
 * @param res - The move result, or the refusal
 */
export async function moveTeamMemberHandler(this: ApiContext, req: Request, res: Response): Promise<void> {
  if (rejectNonOwnerOrOrchestrator(req, res)) return;
  const { id, memberId } = req.params;
  const body = (req.body ?? {}) as { toTeamId?: unknown; allowLead?: unknown; asLead?: unknown };
  if (typeof body.toTeamId !== 'string' || !body.toTeamId.trim()) {
    res.status(400).json({ success: false, error: 'toTeamId is required' });
    return;
  }
  try {
    const actor = actorFromRequest(req);
    const result = await moveTeamMember(buildMoveDeps(this, actor), {
      fromTeamId: id,
      memberId,
      toTeamId: body.toTeamId.trim(),
      allowLead: body.allowLead === true,
      asLead: body.asLead === true,
    });
    recordActivity({
      actor,
      action: 'team.member.moved',
      target: { type: 'member', id: result.member.id, name: result.member.name },
      before: { teamId: result.from.id, team: result.from.name, role: result.member.role },
      after: { teamId: result.to.id, team: result.to.name, role: result.member.role },
    });
    res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof MoveRefusedError) {
      res.status(error.status).json({ success: false, code: error.code, error: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Error moving team member', { teamId: id, memberId, toTeamId: body.toTeamId, error: message });
    res.status(500).json({ success: false, error: message });
  }
}
