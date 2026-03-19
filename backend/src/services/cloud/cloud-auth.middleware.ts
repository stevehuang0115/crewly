/**
 * Cloud Auth Middleware
 *
 * Express middleware for gating premium features behind an active
 * CrewlyAI Cloud connection and subscription tier check.
 *
 * @module services/cloud/cloud-auth.middleware
 */

import type { Request, Response, NextFunction } from 'express';
import { CloudClientService } from './cloud-client.service.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { CloudTier } from '../../constants.js';
import { CLOUD_CONSTANTS } from '../../constants.js';

const logger: ComponentLogger = LoggerService.getInstance().createComponentLogger('CloudAuthMiddleware');

/**
 * Throttle interval for repeated warning logs (5 minutes).
 * Prevents log flooding from high-frequency polling endpoints like /devices.
 */
export const WARN_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Map tracking last warn timestamps by key (reason:path).
 * Exported for testing purposes.
 */
export const _warnTimestamps: Map<string, number> = new Map();

/**
 * Check whether a warning should be logged for the given key.
 * Returns true if no warning was logged for this key within WARN_THROTTLE_MS.
 * Updates the timestamp when returning true.
 *
 * @param key - Unique identifier for the warning (e.g., 'not-connected:/devices')
 * @returns true if the warning should be logged
 */
function shouldLogWarn(key: string): boolean {
  const now = Date.now();
  const lastWarn = _warnTimestamps.get(key);
  if (lastWarn !== undefined && now - lastWarn < WARN_THROTTLE_MS) {
    return false;
  }
  _warnTimestamps.set(key, now);
  return true;
}

/** Tier hierarchy for permission comparison (higher index = more permissive). */
const TIER_HIERARCHY: CloudTier[] = [
  CLOUD_CONSTANTS.TIERS.FREE,
  CLOUD_CONSTANTS.TIERS.PRO,
  CLOUD_CONSTANTS.TIERS.ENTERPRISE,
];

/**
 * Check whether the local Crewly instance is connected to CrewlyAI Cloud.
 *
 * @returns true if CloudClientService reports a connected status
 */
export function isCloudConnected(): boolean {
  return CloudClientService.getInstance().isConnected();
}

/**
 * Express middleware that requires an active cloud connection.
 *
 * Responds with 403 if the instance is not connected.
 *
 * @param req - Express request
 * @param res - Express response
 * @param next - Next middleware
 *
 * @example
 * ```ts
 * router.get('/premium-data', requireCloudConnection, handler);
 * ```
 */
export function requireCloudConnection(req: Request, res: Response, next: NextFunction): void {
  if (!isCloudConnected()) {
    logger.debug('Cloud connection required but not connected', { path: req.path });
    res.status(403).json({
      success: false,
      error: 'CrewlyAI Cloud connection required. Connect via POST /api/cloud/connect.',
    });
    return;
  }
  next();
}

/**
 * Factory that returns Express middleware requiring a minimum subscription tier.
 *
 * The middleware first checks cloud connectivity, then verifies that the
 * current subscription tier meets or exceeds the required level.
 * Warning logs are throttled to once per 5 minutes per path to prevent
 * log flooding from high-frequency polling endpoints (#212).
 *
 * @param tier - Minimum required tier ('pro' or 'enterprise')
 * @returns Express middleware function
 *
 * @example
 * ```ts
 * router.get('/enterprise-report', requireTier('enterprise'), handler);
 * ```
 */
export function requireTier(tier: 'pro' | 'enterprise'): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const client = CloudClientService.getInstance();

    if (!client.isConnected()) {
      const throttleKey = `not-connected:${req.path}`;
      if (shouldLogWarn(throttleKey)) {
        logger.warn('Tier check failed: not connected', { requiredTier: tier, path: req.path });
      }
      res.status(403).json({
        success: false,
        error: 'CrewlyAI Cloud connection required. Connect via POST /api/cloud/connect.',
      });
      return;
    }

    const currentTier = client.getTier();
    const currentIndex = TIER_HIERARCHY.indexOf(currentTier);
    const requiredIndex = TIER_HIERARCHY.indexOf(tier);

    if (currentIndex < requiredIndex) {
      const throttleKey = `insufficient-tier:${req.path}`;
      if (shouldLogWarn(throttleKey)) {
        logger.warn('Tier check failed: insufficient tier', {
          currentTier,
          requiredTier: tier,
          path: req.path,
        });
      }
      res.status(403).json({
        success: false,
        error: `This feature requires a "${tier}" subscription. Current tier: "${currentTier}". Upgrade at https://crewly.dev/pricing.`,
      });
      return;
    }

    next();
  };
}
