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
} from './kr.controller.js';
import { MissionExecutorService, type DecompositionResult } from '../../services/v3/mission-executor.service.js';
import { OKRReviewService } from '../../services/v3/okr-review.service.js';
import type { ReviewDecision, KeyResult } from '../../types/v2/key-result.types.js';
import {
  validateParentLink,
  type Mission,
  type MissionPriority,
} from '../../types/v2/mission.types.js';

/** Default priority applied to missions missing the field at read time. */
const DEFAULT_PRIORITY: MissionPriority = 'medium';

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
 * @returns Mission augmented with `keyResults` and a guaranteed `priority`
 */
async function normalizeMissionForResponse(raw: Mission): Promise<Mission & { keyResults: KeyResultSummary[] }> {
  const keyResults = await readKeyResultSummaries(raw.id);
  return {
    ...raw,
    priority: raw.priority ?? DEFAULT_PRIORITY,
    keyResults,
  };
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
    const enriched = await Promise.all(missions.map(normalizeMissionForResponse));
    res.json({ success: true, data: enriched, count: enriched.length });
  } catch (err) { next(err); }
}

/** Get a single mission by ID with KR summaries and normalised priority. */
async function getMission(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const filePath = path.join(getMissionsDir(), `${req.params.id}.json`);
    const raw = await fs.readFile(filePath, 'utf-8');
    const mission = await normalizeMissionForResponse(JSON.parse(raw) as Mission);
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

    const parentMissionId: string | undefined = req.body.parentMissionId;
    if (parentMissionId) {
      const existing = await loadAllMissionsRaw();
      const byId = new Map(existing.map(m => [m.id, m] as const));
      const reason = validateParentLink(id, parentMissionId, byId);
      if (reason) {
        res.status(400).json({ success: false, error: reason });
        return;
      }
    }

    const mission = { id, ...req.body, createdAt: new Date().toISOString(), status: req.body.status || 'active' };
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

    // Re-validate parent link if the caller is changing it.
    if (Object.prototype.hasOwnProperty.call(req.body, 'parentMissionId')) {
      const nextParent: string | undefined = req.body.parentMissionId || undefined;
      if (nextParent) {
        const all = await loadAllMissionsRaw();
        const byId = new Map(all.map(m => [m.id, m] as const));
        const reason = validateParentLink(id, nextParent, byId);
        if (reason) {
          res.status(400).json({ success: false, error: reason });
          return;
        }
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

  // Get a single KR
  router.get('/:id/key-results/:krId', getKR);

  // Update a KR
  router.put('/:id/key-results/:krId', updateKR);

  // Delete a KR
  router.delete('/:id/key-results/:krId', deleteKR);

  // Record a measurement
  router.post('/:id/key-results/:krId/measure', measureKR);

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
