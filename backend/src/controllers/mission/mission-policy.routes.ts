/**
 * Mission Policy Routes
 *
 * Router configuration for MissionPolicy CRUD API endpoints.
 * Mounted at `/api/missions` in the main API router.
 *
 * @module controllers/mission/mission-policy.routes
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  getPolicy,
  updatePolicy,
  checkPolicy,
} from './mission-policy.controller.js';
import {
  listKeyResults,
  createKR,
  getKR,
  updateKR,
  deleteKR,
  measureKR,
  getOKRSummary,
  getCascadeOKRSummary,
} from './kr.controller.js';
import { MissionExecutorService, type DecompositionResult } from '../../services/v3/mission-executor.service.js';
import { OKRReviewService } from '../../services/v3/okr-review.service.js';
import { OKRCascadeService, type DecomposeOKRInput } from '../../services/v3/okr-cascade.service.js';
import type { ReviewDecision, KeyResult } from '../../types/v2/key-result.types.js';
import {
  validateCascadeLink,
  deriveLevel,
  resolveMissionLevel,
  type Mission,
  type MissionPriority,
  type MissionLevel,
  type ProposalState,
} from '../../types/v2/mission.types.js';

/** Default priority applied to missions missing the field at read time. */
const DEFAULT_PRIORITY: MissionPriority = 'medium';

/**
 * Legacy-level fallback for a mission missing `level` AND any parent link, used
 * only by the update-time cascade re-validation guard (where the effective
 * parent may itself be changing). The canonical read-migration uses
 * {@link resolveMissionLevel} so a parentless legacy mission resolves to
 * `company`; this matches that for a non-parentless mission.
 */
const DEFAULT_LEVEL: MissionLevel = 'team';

/**
 * Default proposal state applied to legacy missions missing `approval` at read
 * time. Pre-cascade missions are treated as already-approved/active.
 */
const DEFAULT_PROPOSAL_STATE: ProposalState = 'approved';

/**
 * Fallback session identifier used as `proposedBy` / `decidedBy` when the
 * caller does not supply one (e.g. an anonymous API client).
 */
const UNKNOWN_ACTOR = 'unknown';

/** Summary of a KeyResult included inline on mission list/detail responses. */
interface KeyResultSummary {
  id: string;
  title: string;
  metricType: KeyResult['metricType'];
  baseline: number;
  target: number;
  current: number;
  unit: string;
  status: KeyResult['status'];
}

/** Resolve the missions directory from the project root. */
function getMissionsDir(): string {
  return path.join(process.cwd(), '.crewly', 'missions');
}

/**
 * Reads all KR JSON files stored under `<missionsDir>/<missionId>/key-results/`.
 *
 * @param missionId - Mission whose KRs should be loaded
 * @returns Array of KR summaries (empty if the folder is missing or unreadable)
 */
async function readKeyResultSummaries(missionId: string): Promise<KeyResultSummary[]> {
  const krDir = path.join(getMissionsDir(), missionId, 'key-results');
  let files: string[] = [];
  try {
    files = (await fs.readdir(krDir)).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const krs = await Promise.all(
    files.map(async (f) => {
      try {
        const raw = await fs.readFile(path.join(krDir, f), 'utf-8');
        const kr = JSON.parse(raw) as KeyResult;
        const summary: KeyResultSummary = {
          id: kr.id,
          title: kr.title,
          metricType: kr.metricType,
          baseline: kr.baseline,
          target: kr.target,
          current: kr.current,
          unit: kr.unit,
          status: kr.status,
        };
        return summary;
      } catch {
        return null;
      }
    }),
  );
  return krs.filter((k): k is KeyResultSummary => k !== null);
}

/**
 * Normalises a raw mission JSON blob into an API response shape:
 * applies the default priority and attaches inline KR summaries.
 *
 * @param raw - Mission object parsed from JSON
 * @param byId - Parent-link chain map for canonical level resolution
 * @returns Mission augmented with `keyResults` and a guaranteed `priority`
 */
async function normalizeMissionForResponse(
  raw: Mission,
  byId: ReadonlyMap<string, Pick<Mission, 'id' | 'parentMissionId'>>,
): Promise<Mission & { keyResults: KeyResultSummary[] }> {
  const keyResults = await readKeyResultSummaries(raw.id);
  return {
    ...raw,
    priority: raw.priority ?? DEFAULT_PRIORITY,
    // Migrate legacy missions on read via the SINGLE canonical level resolver
    // (shared with the cascade service) and treat them as already-approved.
    level: resolveMissionLevel(raw, byId),
    approval: raw.approval ?? { state: DEFAULT_PROPOSAL_STATE },
    keyResults,
  };
}

/** Build the lightweight parent-link chain map used by {@link resolveMissionLevel}. */
function buildChainMap(
  missions: ReadonlyArray<Pick<Mission, 'id' | 'parentMissionId'>>,
): Map<string, Pick<Mission, 'id' | 'parentMissionId'>> {
  return new Map(missions.map((m) => [m.id, { id: m.id, parentMissionId: m.parentMissionId }] as const));
}

/** Load every mission from disk, skipping unreadable files. */
async function loadAllMissionsRaw(): Promise<Mission[]> {
  const dir = getMissionsDir();
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const missions = await Promise.all(
    files.map(async (f) => {
      try {
        const raw = await fs.readFile(path.join(dir, f), 'utf-8');
        return JSON.parse(raw) as Mission;
      } catch {
        return null;
      }
    }),
  );
  return missions.filter((m): m is Mission => m !== null);
}

/** List all missions with KR summaries and normalised priority. */
async function listMissions(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const missions = await loadAllMissionsRaw();
    const byId = buildChainMap(missions);
    const enriched = await Promise.all(missions.map((m) => normalizeMissionForResponse(m, byId)));
    res.json({ success: true, data: enriched, count: enriched.length });
  } catch (err) { next(err); }
}

/** Get a single mission by ID with KR summaries and normalised priority. */
async function getMission(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const filePath = path.join(getMissionsDir(), `${req.params.id}.json`);
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Mission;
    // Load the full set so the canonical level resolver can walk the parent chain.
    const byId = buildChainMap(await loadAllMissionsRaw());
    if (!byId.has(parsed.id)) byId.set(parsed.id, { id: parsed.id, parentMissionId: parsed.parentMissionId });
    const mission = await normalizeMissionForResponse(parsed, byId);
    res.json({ success: true, data: mission });
  } catch {
    res.status(404).json({ success: false, error: 'Mission not found' });
  }
}

/**
 * Create a new mission.
 *
 * Validates `parentMissionId` against existing missions to reject self-reference
 * and cycles before writing to disk.
 */
async function createMission(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dir = getMissionsDir();
    await fs.mkdir(dir, { recursive: true });
    const id = req.body.id || `mission-${Date.now()}`;

    const parentMissionId: string | undefined = req.body.parentMissionId || undefined;
    // Resolve the child level: explicit body value, else derived from the
    // parent chain (no parent ⇒ company).
    const all = await loadAllMissionsRaw();
    const byId = new Map(all.map(m => [m.id, m] as const));
    // Build a chain map (id + parentMissionId only) including the new mission so
    // deriveLevel can walk upward from it.
    const chainById = new Map<string, Pick<Mission, 'id' | 'parentMissionId'>>(
      all.map(m => [m.id, { id: m.id, parentMissionId: m.parentMissionId }] as const),
    );
    chainById.set(id, { id, parentMissionId });
    const level: MissionLevel = req.body.level ?? deriveLevel(id, chainById);

    // Combined cascade guard: cycle/self-ref + level adjacency.
    const reason = validateCascadeLink(id, level, parentMissionId, byId);
    if (reason) {
      res.status(400).json({ success: false, error: reason });
      return;
    }

    // A project-level mission must carry a projectId.
    if (level === 'project' && !req.body.projectId) {
      res.status(400).json({ success: false, error: 'A project-level mission requires projectId' });
      return;
    }

    const mission = {
      id,
      ...req.body,
      level,
      createdAt: new Date().toISOString(),
      status: req.body.status || 'active',
      // Ensure a well-formed Mission shape on disk so downstream readers that
      // validate with `isMission` (e.g. OKRCascadeService) accept it. These
      // arrays default to empty when the caller omits them.
      successCriteria: req.body.successCriteria ?? [],
      activeProjectTaskIds: req.body.activeProjectTaskIds ?? [],
    };
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(mission, null, 2));
    res.status(201).json({ success: true, data: mission });
  } catch (err) { next(err); }
}

/** Fields that are server-controlled and must never be overwritten by a PUT. */
const IMMUTABLE_MISSION_FIELDS = ['id', 'createdAt'] as const;

/**
 * Update an existing mission (partial).
 *
 * Accepts any subset of mutable mission fields. `parentMissionId` is re-validated
 * against the current set of missions on every change. `updatedAt` is refreshed
 * automatically; `id` and `createdAt` are immutable.
 */
async function updateMission(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const filePath = path.join(getMissionsDir(), `${id}.json`);

    let existing: Mission;
    try {
      existing = JSON.parse(await fs.readFile(filePath, 'utf-8')) as Mission;
    } catch {
      res.status(404).json({ success: false, error: 'Mission not found' });
      return;
    }

    // Any direct write to governance metadata is forbidden — the entire
    // `approval` object (not just `approval.state`) is owned by the dedicated
    // approve/reject workflow. Accepting an `approval` payload here would
    // overwrite `existing.approval` wholesale (the merge below replaces, not
    // deep-merges), so a body like `{ approval: { proposedBy: 'x' } }` would
    // silently drop `approval.state` — flipping an approved mission to
    // not-cascade-active and wiping governance metadata. Rejecting the whole
    // key preserves the single-source-of-transitions invariant (spec §3.3).
    if (Object.prototype.hasOwnProperty.call(req.body, 'approval')) {
      res.status(400).json({
        success: false,
        error: 'approval.state cannot be set via update; use approve/reject endpoints',
      });
      return;
    }

    // Determine the effective child level + parent for cascade re-validation.
    const changingParent = Object.prototype.hasOwnProperty.call(req.body, 'parentMissionId');
    const changingLevel = Object.prototype.hasOwnProperty.call(req.body, 'level');
    if (changingParent || changingLevel) {
      const nextParent: string | undefined =
        (changingParent ? req.body.parentMissionId : existing.parentMissionId) || undefined;
      const all = await loadAllMissionsRaw();
      const byId = new Map(all.map(m => [m.id, m] as const));
      // Resolve the existing level via the canonical resolver when not changing
      // it, so legacy missions migrate consistently with the read path.
      const chainById = buildChainMap(all);
      if (!chainById.has(id)) chainById.set(id, { id, parentMissionId: existing.parentMissionId });
      const nextLevel: MissionLevel = changingLevel
        ? (req.body.level ?? DEFAULT_LEVEL)
        : resolveMissionLevel(existing, chainById);
      const reason = validateCascadeLink(id, nextLevel, nextParent, byId);
      if (reason) {
        res.status(400).json({ success: false, error: reason });
        return;
      }
      if (nextLevel === 'project' && !(req.body.projectId ?? existing.projectId)) {
        res.status(400).json({ success: false, error: 'A project-level mission requires projectId' });
        return;
      }
    }

    // Merge while guarding immutable fields.
    const patch: Record<string, unknown> = { ...req.body };
    for (const f of IMMUTABLE_MISSION_FIELDS) delete patch[f];
    const merged: Mission = {
      ...existing,
      ...(patch as Partial<Mission>),
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    await fs.writeFile(filePath, JSON.stringify(merged, null, 2));
    res.json({ success: true, data: merged });
  } catch (err) { next(err); }
}

/**
 * Resolve the acting session/owner identity for a request.
 *
 * Reads the agent session header (set by skill `api_call`) or an explicit body
 * field, falling back to {@link UNKNOWN_ACTOR}.
 *
 * @param req - Incoming request
 * @param bodyField - Body property to consult (e.g. `proposedBy`/`decidedBy`)
 * @returns The resolved actor identifier
 */
function resolveActor(req: Request, bodyField: 'proposedBy' | 'decidedBy'): string {
  const fromBody = typeof req.body?.[bodyField] === 'string' ? (req.body[bodyField] as string) : '';
  const fromHeader = req.header('X-Agent-Session') ?? '';
  return fromBody || fromHeader || UNKNOWN_ACTOR;
}

/**
 * Propose an OKR decomposition (agent drafts child OKRs as a proposal).
 *
 * Distinct from the task-level `/:id/decompose` endpoint: this creates child
 * Missions + KRs in `pending_approval` state, awaiting owner approval.
 */
async function decomposeOKR(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parentId = req.params.id;
    const input = req.body as DecomposeOKRInput;
    if (!input || !Array.isArray(input.children)) {
      res.status(400).json({ success: false, error: 'children array is required' });
      return;
    }
    const proposedBy = resolveActor(req, 'proposedBy');
    const service = OKRCascadeService.getInstance();
    const result = await service.proposeDecomposition(parentId, input, proposedBy);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: (err as Error).message });
  }
}

/** List the pending-approval child proposals for a parent mission. */
async function listProposals(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const service = OKRCascadeService.getInstance();
    const pending = await service.listPendingApprovals(req.params.id);
    res.json({ success: true, data: pending, count: pending.length });
  } catch (err) { next(err); }
}

/** Approve a pending decomposition proposal (owner decision). */
async function approveProposal(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const decidedBy = resolveActor(req, 'decidedBy');
    const service = OKRCascadeService.getInstance();
    const mission = await service.approveDecomposition(req.params.id, decidedBy);
    res.json({ success: true, data: mission });
  } catch (err) {
    res.status(400).json({ success: false, error: (err as Error).message });
  }
}

/** Reject a pending decomposition proposal with a required reason. */
async function rejectProposal(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
    if (!reason || reason.trim().length === 0) {
      res.status(400).json({ success: false, error: 'reason is required' });
      return;
    }
    const decidedBy = resolveActor(req, 'decidedBy');
    const service = OKRCascadeService.getInstance();
    const mission = await service.rejectDecomposition(req.params.id, decidedBy, reason);
    res.json({ success: true, data: mission });
  } catch (err) {
    res.status(400).json({ success: false, error: (err as Error).message });
  }
}

/**
 * Creates the mission router.
 *
 * @returns Express router for /api/missions routes
 */
export function createMissionPolicyRouter(): Router {
  const router = Router();

  // List all missions
  router.get('/', listMissions);

  // Create a mission
  router.post('/', createMission);

  // Get a single mission
  router.get('/:id', getMission);

  // Update a mission (partial)
  router.put('/:id', updateMission);

  // Get mission policy
  router.get('/:id/policy', getPolicy);

  // Update mission policy (partial update)
  router.put('/:id/policy', updatePolicy);

  // Dry-run: check if an action is allowed
  router.post('/:id/policy/check', checkPolicy);

  // --- Key Result (OKR) Endpoints ---

  // List KRs for a mission
  router.get('/:id/key-results', listKeyResults);

  // Create a KR
  router.post('/:id/key-results', createKR);

  // OKR aggregated summary
  router.get('/:id/okr-summary', getOKRSummary);

  // OKR cross-level cascade roll-up (company -> team -> project)
  router.get('/:id/okr-summary/cascade', getCascadeOKRSummary);

  // Get a single KR
  router.get('/:id/key-results/:krId', getKR);

  // Update a KR
  router.put('/:id/key-results/:krId', updateKR);

  // Delete a KR
  router.delete('/:id/key-results/:krId', deleteKR);

  // Record a measurement
  router.post('/:id/key-results/:krId/measure', measureKR);

  // --- OKR Cascade (decompose / approve / reject) Endpoints ---

  // Propose an OKR decomposition (agent drafts child OKRs as a proposal)
  router.post('/:id/decompose-okr', decomposeOKR);

  // List pending child proposals for a parent
  router.get('/:id/proposals', listProposals);

  // Approve a pending proposal (owner)
  router.post('/:id/approve', approveProposal);

  // Reject a pending proposal with a reason (owner)
  router.post('/:id/reject', rejectProposal);

  // --- Mission Execution Endpoints ---

  // Submit decomposition result (from decompose-mission skill)
  router.post('/:id/decompose', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const missionId = req.params.id;
      const filePath = path.join(getMissionsDir(), `${missionId}.json`);

      let mission;
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        mission = JSON.parse(raw);
      } catch {
        res.status(404).json({ success: false, error: 'Mission not found' });
        return;
      }

      const result = req.body as DecompositionResult;
      if (!result.tasks || !Array.isArray(result.tasks)) {
        res.status(400).json({ success: false, error: 'tasks array is required' });
        return;
      }

      const executor = MissionExecutorService.getInstance();
      const createdIds = await executor.processDecomposition(
        { ...result, missionId },
        mission,
      );

      res.status(201).json({ success: true, data: { createdIds, count: createdIds.length } });
    } catch (err) { next(err); }
  });

  // Get mission progress
  router.get('/:id/progress', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const executor = MissionExecutorService.getInstance();
      const progress = await executor.checkProgress(req.params.id);
      res.json({ success: true, data: progress });
    } catch (err) { next(err); }
  });

  // Pause mission (freeze queued tasks)
  router.post('/:id/pause', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const executor = MissionExecutorService.getInstance();
      const frozenCount = await executor.pauseMission(req.params.id);
      res.json({ success: true, data: { frozenCount } });
    } catch (err) { next(err); }
  });

  // Resume mission (unfreeze tasks)
  router.post('/:id/resume', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const executor = MissionExecutorService.getInstance();
      const unfrozenCount = await executor.resumeMission(req.params.id);
      res.json({ success: true, data: { unfrozenCount } });
    } catch (err) { next(err); }
  });

  // --- OKR Review Endpoints ---

  // Submit review decision (from review-mission skill)
  router.post('/:id/review-decision', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const decision = req.body as ReviewDecision;
      if (!decision.action) {
        res.status(400).json({ success: false, error: 'action is required' });
        return;
      }
      const reviewService = OKRReviewService.getInstance();
      await reviewService.processReviewDecision(req.params.id, decision);
      res.json({ success: true, message: `Review decision "${decision.action}" processed` });
    } catch (err) { next(err); }
  });

  // Trigger an OKR review (manual or scheduled)
  router.post('/:id/okr-review', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const reviewService = OKRReviewService.getInstance();
      const result = await reviewService.executeReview(req.params.id);
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  });

  return router;
}
