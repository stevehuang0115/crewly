import { Router } from 'express';
import { ApiController } from '../../controllers/api.controller.js';
import * as systemHandlers from '../../controllers/system/system.controller.js';
import { registerSystemControlRoutes } from '../../controllers/system/system-control.controller.js';
import { getOwnerMessageWatchdog } from '../../services/messaging/owner-message-watchdog.service.js';
import { registerRuntimeFallbackRoutes } from '../../controllers/system/runtime-fallback.controller.js';

export function registerSystemRoutes(router: Router, apiController: ApiController): void {
  // System Administration Routes
  router.get('/system/health', (req, res) => systemHandlers.getSystemHealth.call(apiController, req, res));
  router.get('/system/claude-status', (req, res) => systemHandlers.getClaudeStatus.call(apiController, req, res));
  router.get('/system/metrics', (req, res) => systemHandlers.getSystemMetrics.call(apiController, req, res));
  router.get('/system/config', (req, res) => systemHandlers.getSystemConfiguration.call(apiController, req, res));
  router.patch('/system/config', (req, res) => systemHandlers.updateSystemConfiguration.call(apiController, req, res));
  router.post('/system/config/default', (req, res) => systemHandlers.createDefaultConfig.call(apiController, req, res));
  router.get('/system/logs', (req, res) => systemHandlers.getSystemLogs.call(apiController, req, res));
  router.get('/system/alerts', (req, res) => systemHandlers.getAlerts.call(apiController, req, res));
  router.patch('/system/alerts/:conditionId', (req, res) => systemHandlers.updateAlertCondition.call(apiController, req, res));

  // Owner messages still waiting for an answer (debug; specs/2026-09-30-owner-message-guarantee.md)
  router.get('/system/unanswered-owner-messages', (_req, res) => {
    const watchdog = getOwnerMessageWatchdog();
    res.json({ success: true, data: { running: !!watchdog, messages: watchdog?.list() ?? [] } });
  });

  // Owner-only Upgrade / Restart (specs/2026-10-01-upgrade-restart-controls.md):
  // GET /system/update-status, POST /system/upgrade, POST /system/restart
  registerSystemControlRoutes(router);

  // Runtime fallback on usage limits + runtime smoke tests (specs/2026-10-01-runtime-fallback.md)
  registerRuntimeFallbackRoutes(router);

  // API Health within /api scope
  router.get('/health', (req, res) => systemHandlers.healthCheck.call(apiController, req, res));

  // Local IP address for QR code generation (mobile access)
  router.get('/system/local-ip', (req, res) => systemHandlers.getLocalIpAddress.call(apiController, req, res));

  // Directory browsing for folder selection (used by project creator)
  router.get('/directories', (req, res) => systemHandlers.browseDirectories.call(apiController, req, res));

  // SOP query endpoint for agents to retrieve relevant procedures
  router.post('/system/sops/query', (req, res) => systemHandlers.querySOPs.call(apiController, req, res));
}
