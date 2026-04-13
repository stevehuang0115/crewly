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
import { MissionExecutorService, type DecompositionResult } from '../../services/v3/mission-executor.service.js';

/** Resolve the missions directory from the project root. */
function getMissionsDir(): string {
  return path.join(process.cwd(), '.crewly', 'missions');
}

/** List all missions. */
async function listMissions(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dir = getMissionsDir();
    let files: string[] = [];
    try {
      files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));
    } catch { /* dir doesn't exist */ }
    const missions = await Promise.all(
      files.map(async (f) => {
        try {
          const raw = await fs.readFile(path.join(dir, f), 'utf-8');
          return JSON.parse(raw);
        } catch { return null; }
      })
    );
    res.json({ success: true, data: missions.filter(Boolean), count: missions.filter(Boolean).length });
  } catch (err) { next(err); }
}

/** Get a single mission by ID. */
async function getMission(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const filePath = path.join(getMissionsDir(), `${req.params.id}.json`);
    const raw = await fs.readFile(filePath, 'utf-8');
    res.json({ success: true, data: JSON.parse(raw) });
  } catch {
    res.status(404).json({ success: false, error: 'Mission not found' });
  }
}

/** Create a new mission. */
async function createMission(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dir = getMissionsDir();
    await fs.mkdir(dir, { recursive: true });
    const id = req.body.id || `mission-${Date.now()}`;
    const mission = { id, ...req.body, createdAt: new Date().toISOString(), status: req.body.status || 'active' };
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(mission, null, 2));
    res.status(201).json({ success: true, data: mission });
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

  // Get mission policy
  router.get('/:id/policy', getPolicy);

  // Update mission policy (partial update)
  router.put('/:id/policy', updatePolicy);

  // Dry-run: check if an action is allowed
  router.post('/:id/policy/check', checkPolicy);

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

  return router;
}
