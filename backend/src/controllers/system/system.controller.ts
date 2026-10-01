import { Request, Response } from 'express';
import os from 'os';
import path from 'path';
import * as fs from 'fs/promises';
import type { ApiContext } from '../types.js';
import { MonitoringService, ConfigService, LoggerService } from '../../services/index.js';
import { ApiResponse } from '../../types/index.js';
import { SOPService } from '../../services/sop/sop.service.js';
import { getLocalApiPort } from '../../utils/local-api-url.utils.js';

const logger = LoggerService.getInstance().createComponentLogger('SystemController');

/**
 * Directory entry for filesystem browsing
 */
interface DirectoryEntry {
  name: string;
  path: string;
  type: 'directory' | 'file';
  isHidden: boolean;
}

export async function getSystemHealth(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const monitoring = MonitoringService.getInstance();
    const config = ConfigService.getInstance();
    const healthStatus = monitoring.getHealthStatus();
    const overallHealth = monitoring.getOverallHealth();
    const systemMetrics = monitoring.getSystemMetrics();
    const performanceMetrics = monitoring.getPerformanceMetrics();
    const environmentInfo = config.getEnvironmentInfo();
    res.json({ success: true, data: { status: overallHealth, timestamp: new Date().toISOString(), services: Object.fromEntries(healthStatus), metrics: { system: systemMetrics, performance: performanceMetrics }, environment: environmentInfo } } as ApiResponse);
  } catch (error) {
    logger.error('Error getting system health', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to get system health' } as ApiResponse);
  }
}

export async function getSystemMetrics(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { hours } = req.query as any;
    const monitoring = MonitoringService.getInstance();
    const parsed = hours ? parseInt(hours) : 1;
    const hoursToFetch = isNaN(parsed) ? 1 : parsed;
    const metricsHistory = monitoring.getMetricsHistory(hoursToFetch);
    const currentMetrics = monitoring.getSystemMetrics();
    const performanceMetrics = monitoring.getPerformanceMetrics();
    res.json({ success: true, data: { current: { system: currentMetrics, performance: performanceMetrics }, history: metricsHistory, period: `${hoursToFetch} hours` } } as ApiResponse);
  } catch (error) {
    logger.error('Error getting system metrics', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to get system metrics' } as ApiResponse);
  }
}

export async function getSystemConfiguration(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const config = ConfigService.getInstance();
    const appConfig = config.getConfig();
    const validation = config.validateConfig();
    const environmentInfo = config.getEnvironmentInfo();
    res.json({ success: true, data: { config: appConfig, validation, environment: environmentInfo } } as ApiResponse);
  } catch (error) {
    logger.error('Error getting system configuration', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to get system configuration' } as ApiResponse);
  }
}

export async function updateSystemConfiguration(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const config = ConfigService.getInstance();
    const updates = req.body as any;
    await config.updateConfig(updates);
    const validation = config.validateConfig();
    res.json({ success: true, data: { updated: true, validation, timestamp: new Date().toISOString() } } as ApiResponse);
  } catch (error) {
    logger.error('Error updating system configuration', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to update system configuration' } as ApiResponse);
  }
}

export async function getSystemLogs(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { level, limit } = req.query as any;
    const logger = LoggerService.getInstance();
    const logs = await logger.getRecentLogs(level, limit ? parseInt(limit) : 100);
    res.json({ success: true, data: { logs, count: logs.length, level: level || 'all', limit: limit || 100 } } as ApiResponse);
  } catch (error) {
    logger.error('Error getting system logs', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to get system logs' } as ApiResponse);
  }
}

export async function getAlerts(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const monitoring = MonitoringService.getInstance();
    const activeAlerts = monitoring.getActiveAlerts();
    const alertConditions = monitoring.getAlertConditions();
    res.json({ success: true, data: { active: activeAlerts, conditions: alertConditions, count: activeAlerts.length } } as ApiResponse);
  } catch (error) {
    logger.error('Error getting alerts', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to get alerts' } as ApiResponse);
  }
}

export async function updateAlertCondition(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { conditionId } = req.params as any;
    const updates = req.body as any;
    const monitoring = MonitoringService.getInstance();
    const success = monitoring.updateAlertCondition(conditionId, updates);
    if (!success) { res.status(404).json({ success: false, error: 'Alert condition not found' } as ApiResponse); return; }
    res.json({ success: true, data: { conditionId, updated: true, timestamp: new Date().toISOString() } } as ApiResponse);
  } catch (error) {
    logger.error('Error updating alert condition', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to update alert condition' } as ApiResponse);
  }
}

export async function createDefaultConfig(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const config = ConfigService.getInstance();
    await config.createDefaultConfigFile();
    res.json({ success: true, data: { message: 'Default configuration file created', timestamp: new Date().toISOString() } } as ApiResponse);
  } catch (error) {
    logger.error('Error creating default configuration', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to create default configuration' } as ApiResponse);
  }
}

export async function healthCheck(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const monitoring = MonitoringService.getInstance();
    const overallHealth = monitoring.getOverallHealth();
    const uptime = process.uptime();
    const statusCode = overallHealth === 'unhealthy' ? 503 : 200;
    res.status(statusCode).json({ success: overallHealth !== 'unhealthy', data: { status: overallHealth, uptime: Math.round(uptime), timestamp: new Date().toISOString(), version: process.env.npm_package_version || '1.0.0' } } as ApiResponse);
  } catch (error) {
    logger.error('Error in health check', { error: error instanceof Error ? error.message : String(error) });
    res.status(503).json({ success: false, error: 'Health check failed' } as ApiResponse);
  }
}

export async function getClaudeStatus(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const claudeStatus = await this.tmuxService.checkClaudeInstallation();
    res.json({ success: true, data: claudeStatus } as ApiResponse);
  } catch (error) {
    logger.error('Error checking Claude status', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: (error as Error).message || 'Failed to check Claude status' } as ApiResponse);
  }
}

/**
 * Gets the local network IP address for QR code generation.
 * Returns the first non-internal IPv4 address found, or localhost as fallback.
 *
 * @param req - Express request object
 * @param res - Express response object
 * @returns JSON response with local IP address and port information
 */
export async function getLocalIpAddress(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const interfaces = os.networkInterfaces();
    let localIp = 'localhost';

    // Find the first non-internal IPv4 address
    for (const interfaceName of Object.keys(interfaces)) {
      const addresses = interfaces[interfaceName];
      if (!addresses) continue;

      for (const address of addresses) {
        // Skip internal (loopback) and non-IPv4 addresses
        if (address.family === 'IPv4' && !address.internal) {
          localIp = address.address;
          break;
        }
      }
      if (localIp !== 'localhost') break;
    }

    // The port this instance actually listens on (#777)
    const port = getLocalApiPort();

    res.json({
      success: true,
      data: {
        ip: localIp,
        port,
        url: `http://${localIp}:${port}`,
        timestamp: new Date().toISOString()
      }
    } as ApiResponse);
  } catch (error) {
    logger.error('Error getting local IP address', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({
      success: false,
      error: 'Failed to get local IP address'
    } as ApiResponse);
  }
}

/**
 * Browse directories on the server filesystem.
 * Used by frontend folder browser to let users select project paths with full paths.
 *
 * Query parameters:
 * - path: Directory to browse (defaults to home directory)
 * - showFiles: Include files in results (default: false)
 * - showHidden: Include hidden files/directories (default: false)
 *
 * @param req - Express request object
 * @param res - Express response object
 */
export async function browseDirectories(
  this: ApiContext,
  req: Request,
  res: Response
): Promise<void> {
  try {
    const requestedPath = req.query.path as string | undefined;
    const showFiles = req.query.showFiles === 'true';
    const showHidden = req.query.showHidden === 'true';

    // Default to home directory if no path specified
    const targetPath = requestedPath || os.homedir();

    // Resolve the path to handle relative paths and symlinks
    const resolvedPath = path.resolve(targetPath);

    // Security: Ensure path exists and is accessible
    try {
      const stats = await fs.stat(resolvedPath);
      if (!stats.isDirectory()) {
        res.status(400).json({
          success: false,
          error: 'Path is not a directory',
        } as ApiResponse);
        return;
      }
    } catch (statError) {
      res.status(404).json({
        success: false,
        error: 'Directory not found or not accessible',
      } as ApiResponse);
      return;
    }

    // Read directory contents
    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });

    const result: DirectoryEntry[] = [];

    for (const entry of entries) {
      const isHidden = entry.name.startsWith('.');

      // Skip hidden files unless requested
      if (isHidden && !showHidden) continue;

      // Skip files unless requested
      if (!entry.isDirectory() && !showFiles) continue;

      const entryPath = path.join(resolvedPath, entry.name);

      result.push({
        name: entry.name,
        path: entryPath,
        type: entry.isDirectory() ? 'directory' : 'file',
        isHidden,
      });
    }

    // Sort: directories first, then alphabetically
    result.sort((a, b) => {
      if (a.type === 'directory' && b.type === 'file') return -1;
      if (a.type === 'file' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name);
    });

    // Get parent directory path
    const parentPath = path.dirname(resolvedPath);
    const isRoot = resolvedPath === parentPath;

    res.json({
      success: true,
      data: {
        currentPath: resolvedPath,
        parentPath: isRoot ? null : parentPath,
        entries: result,
      },
    } as ApiResponse);
  } catch (error) {
    logger.error('Error browsing directories', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({
      success: false,
      error: 'Failed to browse directories',
    } as ApiResponse);
  }
}

/**
 * POST /api/system/sops/query
 *
 * Query Standard Operating Procedures relevant to a given context.
 * Uses the SOPService to find and format relevant SOPs based on
 * the agent's role and current task context.
 *
 * @param req - Express request with body: { context, category?, role? }
 * @param res - Express response returning { success, data: { sopContext: string } }
 *
 * @example
 * ```
 * POST /api/system/sops/query
 * {
 *   "context": "implementing a new API endpoint",
 *   "role": "developer",
 *   "category": "workflow"
 * }
 * ```
 */
export async function querySOPs(
  this: ApiContext,
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { context, category, role, teamId } = req.body;

    if (!context) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameter: context',
      } as ApiResponse);
      return;
    }

    const sopService = SOPService.getInstance();
    const sopContext = await sopService.generateSOPContext({
      role: role || 'developer',
      taskContext: context,
      taskType: category,
      teamId: typeof teamId === 'string' && teamId ? teamId : undefined,
    });

    // F8: surface graceful-fallback telemetry to callers so they can
    // distinguish "no SOPs matched" from "index unavailable, served
    // empty fallback". Always 200 — the service layer no longer throws
    // on missing/unparseable index.
    const fallbackReason = sopService.getLastFallbackReason();
    const data: { sopContext: string; reason?: string } = { sopContext };
    if (fallbackReason) {
      data.reason = fallbackReason;
    }

    res.json({
      success: true,
      data,
    } as ApiResponse);
  } catch (error) {
    // F8: SOPService.generateSOPContext should not throw for
    // missing-index conditions any more (graceful fallback). Reaching
    // this catch indicates a genuinely unexpected failure (e.g. invalid
    // request body shape, OOM). Degrade to a 200 + empty SOPs envelope
    // with a degraded-mode reason rather than a 500, since this endpoint
    // is on the agent session-startup hot path and a 500 hard-fails
    // every recovery flow.
    logger.warn(
      'querySOPs hit unexpected error — serving empty fallback to avoid blocking session startup',
      { error: error instanceof Error ? error.message : String(error) }
    );
    res.json({
      success: true,
      data: {
        sopContext: '',
        reason: 'unexpected-error-graceful-fallback',
      },
    } as ApiResponse);
  }
}
