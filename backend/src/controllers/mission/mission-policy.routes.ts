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

  return router;
}
