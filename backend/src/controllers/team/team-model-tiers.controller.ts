/**
 * Model tiers and "Optimize usage" (crewly#1173, specs/2026-10-08-model-tiers.md):
 *
 * - `GET  /api/teams/:id/model-tiers` — toggle, tier maps, members' tiers, review state.
 * - `PUT  /api/teams/:id/model-tiers` — owner: `{ optimizeUsage?, tierModels?, memberTiers? }`.
 * - `POST /api/teams/:id/model-tiers/review` — owner or the team's lead: start a review now.
 * - `POST /api/teams/model-tiers/proposals` — the lead's `propose-tier-change` skill
 *   (`{ member, tier, reason }` | `{ routing }` | `{ submit: true }` | `{ clear: true }`).
 *
 * @module controllers/team/team-model-tiers.controller
 */

import type { Request, Response } from 'express';
import { rejectNonOwner } from '../../middleware/caller-identity.middleware.js';
import { getModelTierService, ModelTierError, type ModelTierService } from '../../services/model-tiers/model-tier.service.js';
import { isOwnerCaller, readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { isTeamLead } from '../../utils/team.utils.js';
import { StorageService } from '../../services/core/storage.service.js';

/** The running service, or a 503. */
function serviceOr503(res: Response): ModelTierService | null {
  const s = getModelTierService();
  if (!s) res.status(503).json({ success: false, error: 'Model tiers are not running yet (decision cards start a few seconds after boot)' });
  return s;
}

function fail(res: Response, err: unknown): void {
  if (err instanceof ModelTierError) {
    res.status(err.status).json({ success: false, error: err.message });
    return;
  }
  res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
}

/**
 * GET /api/teams/:id/model-tiers
 *
 * @param req - `:id` = team id
 * @param res - 200 `{ success, data: TierSettingsView }`
 */
export async function getTeamModelTiers(req: Request, res: Response): Promise<void> {
  const s = serviceOr503(res);
  if (!s) return;
  try {
    res.json({ success: true, data: await s.settings(req.params.id) });
  } catch (err) {
    fail(res, err);
  }
}

/**
 * PUT /api/teams/:id/model-tiers — owner only.
 *
 * @param req - Body `{ optimizeUsage?, tierModels?, memberTiers? }`
 * @param res - 200 `{ success, data }`; 400 invalid; 401/403 not the owner
 */
export async function updateTeamModelTiers(req: Request, res: Response): Promise<void> {
  if (rejectNonOwner(req, res, { success: false, error: 'Only the owner changes model tiers and "Optimize usage". A team lead proposes changes with propose-tier-change.' })) return;
  const s = serviceOr503(res);
  if (!s) return;
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.json({ success: true, data: await s.updateSettings(req.params.id, { optimizeUsage: body.optimizeUsage, tierModels: body.tierModels, memberTiers: body.memberTiers }) });
  } catch (err) {
    fail(res, err);
  }
}

/**
 * POST /api/teams/:id/model-tiers/review — the owner, or the team's own lead.
 *
 * @param req - `:id` = team id
 * @param res - 200 `{ success, data: { reviewId, lead, delivered } }`; 403 another agent; 409 no lead / card open
 */
export async function startTeamModelTierReview(req: Request, res: Response): Promise<void> {
  const s = serviceOr503(res);
  if (!s) return;
  try {
    if (!isOwnerCaller(req)) {
      const session = readAgentSessionHeader(req);
      const team = (await StorageService.getInstance().getTeams()).find((t) => t.id === req.params.id);
      const me = team?.members.find((m) => !!session && (m.sessionName === session || m.agentId === session));
      if (!team || !me || !isTeamLead(team, me)) {
        res.status(403).json({ success: false, error: "Only the owner or this team's lead starts a tier review" });
        return;
      }
    }
    res.json({ success: true, data: await s.startReview(req.params.id, 'on_demand') });
  } catch (err) {
    fail(res, err);
  }
}

/**
 * POST /api/teams/model-tiers/proposals — the lead's skill.
 *
 * @param req - Caller = X-Agent-Session; body = one proposal action
 * @param res - 200 `{ success, data }`; 400 / 403 / 409 with the reason
 */
export async function proposeTierChange(req: Request, res: Response): Promise<void> {
  const s = serviceOr503(res);
  if (!s) return;
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.json({ success: true, data: await s.propose(readAgentSessionHeader(req), body) });
  } catch (err) {
    fail(res, err);
  }
}
