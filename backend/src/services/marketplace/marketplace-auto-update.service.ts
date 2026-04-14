/**
 * Marketplace Auto-Update Service
 *
 * Periodically checks the registry for updates to installed marketplace items
 * and automatically applies them. This means pushing new skills/templates to
 * the git repo will propagate to all OSS instances without manual intervention.
 *
 * Runs on a configurable interval (default: 6 hours).
 * Only updates items that are already installed — does not auto-install new items.
 *
 * @module services/marketplace/marketplace-auto-update
 */

import { LoggerService } from '../core/logger.service.js';
import { fetchRegistry, getInstalledItems, listItems } from './marketplace.service.js';
import { updateItem } from './marketplace-installer.service.js';
import type { MarketplaceItemWithStatus } from '../../types/marketplace.types.js';

const logger = LoggerService.getInstance().createComponentLogger('MarketplaceAutoUpdate');

/** Default check interval: 6 hours */
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Minimum interval: 10 minutes (to prevent abuse) */
const MIN_CHECK_INTERVAL_MS = 10 * 60 * 1000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

/**
 * Checks for updates and applies them.
 *
 * @returns Summary of what was updated
 */
export async function checkAndApplyUpdates(): Promise<{
  checked: number;
  updated: string[];
  failed: string[];
  skipped: number;
}> {
  const result = { checked: 0, updated: [] as string[], failed: [] as string[], skipped: 0 };

  if (isRunning) {
    logger.debug('Auto-update already in progress, skipping');
    return result;
  }

  isRunning = true;
  try {
    // Force-refresh the registry to get latest versions
    await fetchRegistry(true);

    // Find installed items with available updates
    const allItems = await listItems();
    const updatable = allItems.filter((i) => i.installStatus === 'update_available');
    result.checked = allItems.filter((i) => i.installStatus !== 'not_installed').length;

    if (updatable.length === 0) {
      logger.debug('No marketplace updates available', { checkedItems: result.checked });
      return result;
    }

    logger.info('Marketplace updates available', {
      count: updatable.length,
      items: updatable.map((i) => `${i.id}@${i.version}`),
    });

    // Apply updates sequentially (avoid concurrent file operations)
    for (const item of updatable) {
      try {
        const updateResult = await updateItem(item);
        if (updateResult.success) {
          result.updated.push(`${item.id}@${item.version}`);
          logger.info('Auto-updated marketplace item', {
            id: item.id,
            version: item.version,
          });
        } else {
          result.failed.push(`${item.id}: ${updateResult.message}`);
          logger.warn('Auto-update failed for item', {
            id: item.id,
            error: updateResult.message,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.failed.push(`${item.id}: ${msg}`);
        logger.warn('Auto-update exception', { id: item.id, error: msg });
      }
    }

    if (result.updated.length > 0) {
      logger.info('Auto-update cycle complete', {
        updated: result.updated.length,
        failed: result.failed.length,
      });
    }

    return result;
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the periodic auto-update loop.
 *
 * @param intervalMs - Check interval in milliseconds (default: 6 hours)
 */
export function startAutoUpdate(intervalMs = DEFAULT_CHECK_INTERVAL_MS): void {
  if (intervalHandle) {
    logger.debug('Auto-update already running');
    return;
  }

  const safeInterval = Math.max(intervalMs, MIN_CHECK_INTERVAL_MS);

  // Run first check after a delay (don't block startup)
  setTimeout(() => {
    checkAndApplyUpdates().catch((err) => {
      logger.debug('Initial auto-update check failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, 60_000); // 1 minute after startup

  // Then run periodically
  intervalHandle = setInterval(() => {
    checkAndApplyUpdates().catch((err) => {
      logger.debug('Periodic auto-update check failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, safeInterval);

  logger.info('Marketplace auto-update started', {
    intervalHours: Math.round(safeInterval / 3600000 * 10) / 10,
  });
}

/**
 * Stops the periodic auto-update loop.
 */
export function stopAutoUpdate(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('Marketplace auto-update stopped');
  }
}
