/**
 * Key Result REST Controller
 *
 * Handles CRUD, measurement recording, and OKR aggregation
 * for Key Results attached to Missions.
 *
 * Mounted as sub-routes under /api/missions/:id/key-results
 *
 * @module controllers/mission/kr.controller
 */

import type { Request, Response, NextFunction } from 'express';
import { KRTrackingService } from '../../services/v3/kr-tracking.service.js';
import { validateCreateKeyResultInput } from '../../types/v2/key-result.types.js';

/**
 * GET /api/missions/:id/key-results — List all KRs for a mission.
 */
export async function listKeyResults(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const service = KRTrackingService.getInstance();
    const krs = await service.listByMission(req.params.id);
    res.json({ success: true, data: krs, count: krs.length });
  } catch (err) { next(err); }
}

/**
 * POST /api/missions/:id/key-results — Create a new KR.
 */
export async function createKR(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = { ...req.body, missionId: req.params.id };
    const errors = validateCreateKeyResultInput(input);
    if (errors.length > 0) {
      res.status(400).json({ success: false, error: errors.join(', ') });
      return;
    }
    const service = KRTrackingService.getInstance();
    const kr = await service.create(input);
    res.status(201).json({ success: true, data: kr });
  } catch (err) { next(err); }
}

/**
 * GET /api/missions/:id/key-results/:krId — Get a single KR.
 */
export async function getKR(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const service = KRTrackingService.getInstance();
    const kr = await service.get(req.params.id, req.params.krId);
    if (!kr) {
      res.status(404).json({ success: false, error: 'Key Result not found' });
      return;
    }
    res.json({ success: true, data: kr });
  } catch (err) { next(err); }
}

/**
 * PUT /api/missions/:id/key-results/:krId — Update a KR.
 */
export async function updateKR(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const service = KRTrackingService.getInstance();
    const kr = await service.update(req.params.id, req.params.krId, req.body);
    if (!kr) {
      res.status(404).json({ success: false, error: 'Key Result not found' });
      return;
    }
    res.json({ success: true, data: kr });
  } catch (err) { next(err); }
}

/**
 * DELETE /api/missions/:id/key-results/:krId — Delete a KR.
 */
export async function deleteKR(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const service = KRTrackingService.getInstance();
    const deleted = await service.delete(req.params.id, req.params.krId);
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Key Result not found' });
      return;
    }
    res.json({ success: true, message: 'Key Result deleted' });
  } catch (err) { next(err); }
}

/**
 * POST /api/missions/:id/key-results/:krId/measure — Record a measurement.
 */
export async function measureKR(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { value, source, note } = req.body as { value?: number; source?: string; note?: string };
    if (typeof value !== 'number') {
      res.status(400).json({ success: false, error: 'value (number) is required' });
      return;
    }
    const service = KRTrackingService.getInstance();
    const measurement = await service.recordMeasurement(
      req.params.id,
      req.params.krId,
      value,
      source ?? 'api',
      note,
    );
    if (!measurement) {
      res.status(404).json({ success: false, error: 'Key Result not found' });
      return;
    }
    res.json({ success: true, data: measurement });
  } catch (err) { next(err); }
}

/**
 * GET /api/missions/:id/okr-summary — Aggregated OKR progress.
 */
export async function getOKRSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const service = KRTrackingService.getInstance();
    const summary = await service.computeMissionOKRProgress(req.params.id);
    res.json({ success: true, data: summary });
  } catch (err) { next(err); }
}

/**
 * GET /api/missions/:id/okr-summary/cascade — Cross-level cascade roll-up.
 *
 * Walks the `parentMissionId` tree so the mission's progress aggregates its
 * approved children's roll-up (company → team → project). Returns a recursive
 * {@link CascadeOKRSummary}.
 */
export async function getCascadeOKRSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const service = KRTrackingService.getInstance();
    const summary = await service.computeCascadeOKRProgress(req.params.id);
    res.json({ success: true, data: summary });
  } catch (err) { next(err); }
}
