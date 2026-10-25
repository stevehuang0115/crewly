/**
 * Team move REST controller (crewly#1189).
 *
 *   GET  /api/team-moves             moves of this account (Cloud) with local progress
 *   GET  /api/team-moves/machines    the account's other live machines (with canReceive and update hints)
 *   POST /api/team-moves/check       what would block a move of a team (unpushed work)
 *   POST /api/team-moves/preflight   what the owner should know before a move: per repository the uncommitted and unpushed work,
 *                                    whether it can be carried, the secret scan, size and tools (nothing is sent)
 *   POST /api/team-moves/preview     dry run: build the package here, report what and how big (nothing is sent)
 *   POST /api/team-moves             start a move (owner, or the orchestrator after the owner said yes)
 *   GET  /api/team-moves/:moveId     one move with its local journal
 *   POST /api/team-moves/:moveId/rollback   roll a move back (owner only)
 *
 * @module controllers/team-move/team-move.controller
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { getCallerIdentity, requireOwner } from '../../middleware/caller-identity.middleware.js';
import { containsApprovalToken } from '../../services/orchestrator/commitment-approval-guard.js';
import { getChatV2Service } from '../../services/chat-v2/chat-v2.singleton.js';
import { CloudClientService } from '../../services/cloud/cloud-client.service.js';
import { DeviceIdentityService } from '../../services/cloud/device-identity.service.js';
import { StorageService } from '../../services/core/storage.service.js';
import { TeamMoveBlockedError } from '../../services/team-move/team-move-exporter.js';
import { TeamMoveSecretScanError } from '../../services/team-move/team-move-secret-scan.js';
import { TeamMoveCloudError } from '../../services/team-move/team-move-cloud.client.js';
import { getTeamMoveDriver, type TeamMoveDriver } from '../../services/team-move/team-move-driver.service.js';
import { fetchMachines, updateHints, type MachineView } from '../../services/team-move/team-move-machines.js';
import { isMoveId } from '../../services/team-move/team-move-journal.js';
import { actorFromRequest, recordActivity } from '../../services/activity/activity-log.service.js';

/** How recent the owner's "yes" must be when the orchestrator starts a move. */
export const MOVE_APPROVAL_LOOKBACK_MS = 30 * 60 * 1000;

export type { MachineView };

/** Collaborators (injectable for tests). */
export interface TeamMoveControllerDeps {
  driver: () => TeamMoveDriver | null;
  teams: () => Promise<Array<{ id: string; name: string }>>;
  machines: () => Promise<MachineView[]>;
  /** Texts of the owner's recent chat messages, newest window first. */
  recentOwnerMessages: (sinceMs: number) => string[];
  now?: () => number;
}

/**
 * The account's live remote machines from Cloud's instance registry.
 *
 * @returns Machines other than this one
 */
async function defaultMachines(): Promise<MachineView[]> {
  const local = await DeviceIdentityService.getInstance().getOrCreateIdentity().catch(() => null);
  return fetchMachines(CloudClientService.getInstance(), local?.deviceId ?? null);
}

const fail = (res: Response, status: number, error: string, extra: Record<string, unknown> = {}): void => {
  res.status(status).json({ success: false, error, ...extra });
};

/**
 * Map a thrown error to an HTTP answer.
 *
 * @param res - Response
 * @param error - Error
 */
function sendError(res: Response, error: unknown): void {
  if (error instanceof TeamMoveBlockedError) return fail(res, 409, error.message, { code: 'unpushed_work', repos: error.lines });
  if (error instanceof TeamMoveSecretScanError) return fail(res, 422, error.message, { code: 'secrets_found', findings: error.findings.map((f) => f.path) });
  if (error instanceof TeamMoveCloudError) return fail(res, error.status >= 400 && error.status < 600 ? error.status : 502, error.message, { code: error.code });
  fail(res, 500, error instanceof Error ? error.message : String(error));
}

/**
 * Create the team move router.
 *
 * @param deps - Collaborators (defaults to the running backend's)
 * @returns Router mounted at /api/team-moves
 */
export function createTeamMovesRouter(deps: Partial<TeamMoveControllerDeps> = {}): Router {
  const driver = deps.driver ?? getTeamMoveDriver;
  const teams = deps.teams ?? (async () => (await StorageService.getInstance().getTeams()).map((t) => ({ id: t.id, name: t.name })));
  const machines = deps.machines ?? defaultMachines;
  const ownerMessages = deps.recentOwnerMessages ?? ((since: number) => getChatV2Service().getRecentOwnerMessageContents(since));
  const now = deps.now ?? Date.now;
  const router = Router();

  const needDriver = (res: Response): TeamMoveDriver | null => {
    const d = driver();
    if (!d) fail(res, 503, 'Team moves are not available: sign in to Crewly Cloud first');
    return d;
  };

  router.get('/', async (_req: Request, res: Response) => {
    const d = needDriver(res);
    if (!d) return;
    try {
      res.json({ success: true, data: { moves: await d.listMoves() } });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/machines', async (_req: Request, res: Response) => {
    try {
      const list = await machines();
      res.json({ success: true, data: { machines: list, hints: updateHints(list) } });
    } catch (error) {
      sendError(res, error);
    }
  });

  /** Resolve `teamId`/`teamName` and `targetInstanceId`/`targetName` from a body. */
  const resolve = async (body: Record<string, unknown>): Promise<{ teamId: string; targetInstanceId: string; targetName: string } | { error: string }> => {
    const allTeams = await teams();
    const team =
      allTeams.find((t) => t.id === body['teamId']) ??
      (typeof body['teamName'] === 'string' ? allTeams.find((t) => t.name.toLowerCase() === (body['teamName'] as string).toLowerCase()) : undefined);
    if (!team) return { error: 'Team not found on this machine' };
    const all = (await machines()).filter((m) => !m.isLocal);
    const target =
      all.find((m) => m.instanceId === body['targetInstanceId']) ??
      (typeof body['targetName'] === 'string' ? all.filter((m) => m.name.toLowerCase() === (body['targetName'] as string).toLowerCase()) : []).at(0);
    if (!target) return { error: `Target machine not found. Machines that can receive a team: ${all.filter((m) => m.canReceive).map((m) => m.name).join(', ') || 'none'}` };
    if (!target.canReceive) return { error: `Update Crewly on ${target.name} first: it does not support team moves yet${target.crewlyVersion ? ` (it runs ${target.crewlyVersion})` : ''}.` };
    return { teamId: team.id, targetInstanceId: target.instanceId, targetName: target.name };
  };

  router.post('/check', async (req: Request, res: Response) => {
    try {
      const d = needDriver(res);
      if (!d) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const team = (await teams()).find((t) => t.id === body['teamId'] || t.name.toLowerCase() === String(body['teamName'] ?? '').toLowerCase());
      if (!team) return fail(res, 404, 'Team not found on this machine');
      const result = await d.checkRepos(team.id);
      res.json({ success: true, data: result });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/preflight', requireOwner, async (req: Request, res: Response) => {
    try {
      const d = needDriver(res);
      if (!d) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const team = (await teams()).find((t) => t.id === body['teamId'] || t.name.toLowerCase() === String(body['teamName'] ?? '').toLowerCase());
      if (!team) return fail(res, 404, 'Team not found on this machine');
      const report = await d.sourcePreflight({ teamId: team.id, carryChanges: body['carryChanges'] === true, quick: body['quick'] === true, force: body['force'] === true });
      res.json({ success: true, data: report });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/preview', requireOwner, async (req: Request, res: Response) => {
    let staging: string | null = null;
    try {
      const d = needDriver(res);
      if (!d) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const team = (await teams()).find((t) => t.id === body['teamId'] || t.name.toLowerCase() === String(body['teamName'] ?? '').toLowerCase());
      if (!team) return fail(res, 404, 'Team not found on this machine');
      staging = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-team-move-preview-'));
      const result = await d.preview({ teamId: team.id, stagingDir: staging, allowDirty: true, skipFlagged: body['skipFlagged'] === true });
      res.json({ success: true, data: result });
    } catch (error) {
      sendError(res, error);
    } finally {
      if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  router.post('/', async (req: Request, res: Response) => {
    try {
      const d = needDriver(res);
      if (!d) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      // An agent (the orchestrator) may start a move only after the owner said yes in chat.
      if (getCallerIdentity(req).kind === 'agent') {
        const recent = ownerMessages(now() - MOVE_APPROVAL_LOOKBACK_MS);
        if (!recent.some((m) => containsApprovalToken(m))) {
          return fail(res, 403, 'Ask the owner first: tell them which team moves to which machine and wait for a yes in chat, then try again.', { code: 'owner_approval_required' });
        }
      }
      const resolved = await resolve(body);
      if ('error' in resolved) return fail(res, 404, resolved.error);
      const started = await d.startMove({
        teamId: resolved.teamId,
        targetInstanceId: resolved.targetInstanceId,
        allowDirty: body['allowDirty'] === true,
        skipFlagged: body['skipFlagged'] === true,
        carryChanges: body['carryChanges'] === true,
      });
      recordActivity({ actor: actorFromRequest(req), action: 'team.move.started', target: { type: 'team', id: resolved.teamId }, after: { target: resolved.targetName, targetInstanceId: resolved.targetInstanceId, moveId: started.moveId } });
      res.status(202).json({ success: true, data: { moveId: started.moveId, target: resolved.targetName } });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/:moveId', async (req: Request, res: Response) => {
    const d = needDriver(res);
    if (!d) return;
    const moveId = String(req.params['moveId']);
    if (!isMoveId(moveId)) return fail(res, 400, 'Invalid move id');
    try {
      res.json({ success: true, data: await d.getMove(moveId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:moveId/rollback', requireOwner, async (req: Request, res: Response) => {
    const d = needDriver(res);
    if (!d) return;
    const moveId = String(req.params['moveId']);
    if (!isMoveId(moveId)) return fail(res, 400, 'Invalid move id');
    try {
      await d.rollbackMove(moveId);
      res.json({ success: true, data: { moveId } });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
