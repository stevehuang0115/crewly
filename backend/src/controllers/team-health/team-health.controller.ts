/**
 * Team-Health-Watchdog (THW) Controller
 *
 * HTTP handlers for THW status, on-demand scan, and silence commands.
 * Backs the orchestrator-facing `team-health-scan` skill (§6.5).
 *
 * Per Sam's etiquette nudge: this controller resolves the watchdog via
 * the `getTeamHealthWatchdogSingleton()` accessor — NOT a module-load
 * import — so /api/health can fail-soft when the singleton isn't ready.
 *
 * @module controllers/team-health/team-health.controller
 */

import type { Request, Response, NextFunction } from 'express';
import {
  getTeamHealthWatchdogSingleton,
  type TeamHealthWatchdogService,
} from '../../services/team-health/index.js';

// Local override for tests — bypasses the singleton accessor when set.
let testOverride: TeamHealthWatchdogService | null = null;

/**
 * Override the singleton accessor for tests. Pass `null` to clear.
 * Production code should use `setTeamHealthWatchdogSingleton()` from
 * `services/team-health` instead.
 *
 * @param service - The instance to use, or null to fall back to singleton
 */
export function setTeamHealthWatchdogService(service: TeamHealthWatchdogService | null): void {
  testOverride = service;
}

/**
 * Read the current watchdog service. Used internally by handlers; also
 * exported for /api/health augmentation in index.ts.
 */
export function getTeamHealthWatchdogService(): TeamHealthWatchdogService | null {
  return testOverride ?? getTeamHealthWatchdogSingleton();
}

/**
 * GET /api/team-health/scan
 *
 * Returns current verdicts (last sweep). Optional ?teamId=... filter.
 *
 * @param req - Express request with optional `teamId` query param
 * @param res - Express response with verdicts payload
 * @param next - Express next function for error forwarding
 */
export async function getTeamHealthScan(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const watchdog = getTeamHealthWatchdogService();
    if (!watchdog) {
      res.status(503).json({ success: false, error: 'TeamHealthWatchdog not initialized' });
      return;
    }
    const rawTeamId = req.query.teamId;
    const teamId = typeof rawTeamId === 'string' && rawTeamId.length > 0 ? rawTeamId : undefined;
    const verdicts = watchdog.getCurrentVerdicts(teamId);
    const lastSweep = watchdog.getLastSweep();
    res.json({
      success: true,
      data: {
        verdicts,
        lastSweep: lastSweep ? {
          sweptAt: lastSweep.sweptAt,
          durationMs: lastSweep.durationMs,
          shadowMode: lastSweep.shadowMode,
        } : null,
        lastSweepAgeMs: watchdog.getLastSweepAgeMs(),
        degraded: watchdog.isDegraded(),
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/team-health/run
 *
 * Manually trigger one sweep on demand. Returns the result.
 *
 * @param _req - Express request (unused)
 * @param res - Express response with TeamHealthSweepResult
 * @param next - Express next function for error forwarding
 */
export async function runTeamHealthSweep(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const watchdog = getTeamHealthWatchdogService();
    if (!watchdog) {
      res.status(503).json({ success: false, error: 'TeamHealthWatchdog not initialized' });
      return;
    }
    const result = await watchdog.runOnce();
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/team-health/silence
 *
 * Apply a manual silence to a team. Body: { teamId, durationMs }.
 * Used by the Slack 🔇 react handler.
 *
 * @param req - Express request with body { teamId, durationMs }
 * @param res - Express response with success flag
 * @param next - Express next function for error forwarding
 */
export async function silenceTeamHealthAlerts(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const watchdog = getTeamHealthWatchdogService();
    if (!watchdog) {
      res.status(503).json({ success: false, error: 'TeamHealthWatchdog not initialized' });
      return;
    }
    const { teamId, durationMs } = req.body ?? {};
    if (typeof teamId !== 'string' || teamId.length === 0) {
      res.status(400).json({ success: false, error: 'teamId is required' });
      return;
    }
    if (typeof durationMs !== 'number' || durationMs <= 0) {
      res.status(400).json({ success: false, error: 'durationMs must be a positive number' });
      return;
    }
    watchdog.silenceTeam(teamId, durationMs);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
}
