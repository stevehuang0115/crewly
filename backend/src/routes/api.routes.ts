import { Router } from 'express';
import { ApiController } from '../controllers/api.controller.js';
import { createApiRouter, type ApiContext } from '../controllers/index.js';
import { registerTaskManagementRoutes } from './modules/task-management.routes.js';
import { registerSystemRoutes } from './modules/system.routes.js';
import { registerSchedulerRoutes } from './modules/scheduler.routes.js';
import { registerTerminalRoutes } from './modules/terminal.routes.js';
import { registerAssignmentsRoutes } from './modules/assignments.routes.js';
import { registerErrorRoutes } from './modules/errors.routes.js';
import { registerScheduledMessageRoutes } from './modules/scheduled-messages.routes.js';
import { registerDeliveryLogRoutes } from './modules/delivery-logs.routes.js';
import { registerConfigRoutes } from './modules/config.routes.js';
import { registerCronTaskRoutes } from './modules/cron-task.routes.js';
import { createUnifiedSchedulerRoutes } from './modules/unified-scheduler.routes.js';
import { createFactoryRoutes } from './factory.routes.js';
import { selfImprovementRouter } from '../controllers/self-improvement/index.js';
import { createMessagingRouter } from '../controllers/messaging/messaging.routes.js';
import { createTeamsBackupRouter } from '../controllers/teams-backup/teams-backup.routes.js';
import { createEventBusRouter } from '../controllers/event-bus/event-bus.routes.js';
import { createSlackThreadRouter } from '../controllers/slack/slack-thread.routes.js';
import { createMemoryRouter } from '../controllers/memory/memory.routes.js';
import { createCredentialsRouter } from '../controllers/credentials/credentials.routes.js';
import { createQualityGateRouter } from './modules/quality-gate.routes.js';
import { createMarketplaceRouter } from '../controllers/marketplace/index.js';
import { createKnowledgeRouter } from '../controllers/knowledge/index.js';
import { createTemplateRouter } from '../controllers/template/index.js';
import { createAuditorRouter } from '../controllers/auditor/auditor.routes.js';
import { createPaymentRouter } from '../controllers/payment/payment.routes.js';
import { createProvisioningRouter } from '../controllers/provisioning/provisioning.routes.js';
import { createCloudRouter } from '../controllers/cloud/index.js';
import { createPrReviewRouter } from '../controllers/pr-review/pr-review.routes.js';
import { createApprovalsRouter } from '../controllers/approvals/approvals.routes.js';
import { createBrowserRouter } from '../controllers/browser/browser.routes.js';
import { createCrossMachineRouter } from '../controllers/cross-machine/index.js';
import { createWebsiteAnalysisRouter } from '../controllers/onboarding/website-analysis.routes.js';
import { createOnboardingRouter } from '../controllers/onboarding/onboarding.routes.js';
import { createDataRouter } from '../controllers/data/data.routes.js';
import { createIntentTaskRouter } from '../controllers/intent-task/intent-task.routes.js';
import { createTaskPoolRouter } from '../controllers/task-pool/task-pool.routes.js';
import { createRequestRouter } from '../controllers/request/request.routes.js';
import { createReconcilerRouter } from '../controllers/reconciler/reconciler.routes.js';
import { createTeamHealthRouter } from '../controllers/team-health/team-health.routes.js';
import { createFissionRouter } from '../controllers/fission/fission.routes.js';
import { createMissionPolicyRouter } from '../controllers/mission/mission-policy.routes.js';
import { createV2WorkspaceRouter } from '../controllers/v2-workspace/workspace.routes.js';
import { createTriggerRouter } from '../controllers/trigger/trigger.routes.js';
import { createGrowthRouter } from '../controllers/growth/growth.routes.js';
import taskProjectionRouter from '../controllers/task-projection/task-projection.routes.js';
import { createChatV2Router } from '../controllers/chat-v2/index.js';
import { getChatV2Service } from '../services/chat-v2/chat-v2.singleton.js';
import { createOssTeamMembershipValidator } from '../services/chat-v2/chat-v2.team-membership.js';

/**
 * Creates API routes using the new organized controller structure
 * @param apiController - Legacy API controller (for backward compatibility)
 * @returns Express router configured with all API routes
 */
export function createApiRoutes(apiController: ApiController): Router {
  const router = Router();

  // Create context from ApiController for new organized controllers
  const context: ApiContext = {
    storageService: apiController.storageService,
    tmuxService: apiController.tmuxService,
    agentRegistrationService: apiController.agentRegistrationService,
    schedulerService: apiController.schedulerService,
    messageSchedulerService: apiController.messageSchedulerService,
    activeProjectsService: apiController.activeProjectsService,
    promptTemplateService: apiController.promptTemplateService,
    taskAssignmentMonitor: apiController.taskAssignmentMonitor,
    taskTrackingService: apiController.taskTrackingService,
    cleanupProjectScheduledMessages: async (projectId: string) => {
      // Import and call the cleanup function with the current context
      const { cleanupProjectScheduledMessages } = await import('../controllers/project/project.controller.js');
      return cleanupProjectScheduledMessages.call(context, projectId);
    }
  };

  // Use the new organized controller structure
  router.use('/', createApiRouter(context));

  // Factory routes for 3D visualization
  router.use('/factory', createFactoryRoutes());

  // Self-improvement routes for orchestrator codebase modifications
  router.use('/self-improvement', selfImprovementRouter);

  // Message queue routes
  router.use('/messaging', createMessagingRouter());

  // Teams backup and restore routes
  router.use('/teams/backup', createTeamsBackupRouter());

  // Event bus subscription routes
  router.use('/events', createEventBusRouter());

  // Slack thread storage routes
  router.use('/slack-threads', createSlackThreadRouter());

  // Memory routes for agent/project knowledge storage and retrieval
  router.use('/memory', createMemoryRouter());

  // Credentials routes for OAuth tokens and API keys used by skills
  router.use('/credentials', createCredentialsRouter());

  // Quality gate routes for running quality checks before task completion
  router.use('/quality-gates', createQualityGateRouter());

  // Marketplace routes for browsing, installing, and managing marketplace items
  router.use('/marketplace', createMarketplaceRouter());

  // Knowledge document routes for company knowledge management
  router.use('/knowledge', createKnowledgeRouter());

  // Template routes for team template management and team creation
  router.use('/templates', createTemplateRouter());

  // Auditor routes for manual audit triggers and status
  router.use('/auditor', createAuditorRouter());

  // Payment routes for Stripe checkout, subscriptions, and webhooks
  router.use('/payment', createPaymentRouter());

  // Provisioning routes for DigitalOcean deployment management
  router.use('/provisioning', createProvisioningRouter());

  // Cloud routes for connect, disconnect, validate, status, templates, and Google OAuth
  router.use('/cloud', createCloudRouter());


  // PR review routes for automated GitHub PR reviews via webhooks
  router.use('/pr-review', createPrReviewRouter());

  // Tool approval management routes for granular tool execution control
  router.use('/approvals', createApprovalsRouter());

  // Crewly in Chrome routes for browser control
  router.use('/browser', createBrowserRouter());

  // Cross-machine communication routes for Slack-based inter-machine messaging
  router.use('/cross-machine', createCrossMachineRouter());

  // Website Analysis routes for KR3 magic onboarding — SSE + sync analysis
  router.use('/website-analysis', createWebsiteAnalysisRouter());

  // Onboarding session routes for KR3 Cloud Portal onboarding flow
  router.use('/onboarding', createOnboardingRouter());

  // Data Architecture V2 — Unified Data Model, Schemas, Sinks
  router.use('/v2/data', createDataRouter());

  // Intent Task routes for task decomposition, tracking, and lifecycle
  router.use('/intent-tasks', createIntentTaskRouter());

  // Request routes for V3 incoming pipeline
  router.use('/requests', createRequestRouter());

  // Task Pool routes for V2 work item pool management
  router.use('/task-pool', createTaskPoolRouter());

  // Reconciler routes for status monitoring, manual trigger, and history
  router.use('/reconciler', createReconcilerRouter());

  // Team-Health-Watchdog (THW) — Layer 4 liveness aggregator routes
  router.use('/team-health', createTeamHealthRouter());

  // Fission guardrail routes for config, stats, violations, and pre-checks
  router.use('/fission', createFissionRouter());

  // Mission policy routes for CRUD and dry-run policy checks
  router.use('/missions', createMissionPolicyRouter());

  // V2 Shared Workspace routes — versioned JSON CRUD with CAS
  router.use('/v2/workspaces', createV2WorkspaceRouter());

  // Trigger routes — unified TimeTrigger, SignalTrigger, CompoundTrigger management
  router.use('/triggers', createTriggerRouter());

  // Growth routes — agent growth area tracking (keyword-based, no LLM)
  router.use('/growth', createGrowthRouter());

  // Task Projection routes — V3.1 TaskRecord + TaskEvent observability layer
  router.use('/task-projection', taskProjectionRouter);

  // Chat V2 (Agent-First Chat MVP Phase 1) — mounts /api/chat/channels/*
  // Coexists with the legacy /api/chat/{send,messages,conversations,...} routes
  // registered by `createApiRouter` → no route overlap.
  //
  // F2b (#333): inject the OSS team-membership validator on the singleton's
  // first construction so type='channel' creates are gated by team
  // existence (single-user OSS treats existence === membership; Cloud
  // Portal Phase E swaps in a tenant-aware validator).
  router.use(
    '/chat',
    createChatV2Router(
      getChatV2Service({
        validateTeamMembership: createOssTeamMembershipValidator(),
      }),
    ),
  );

  // Keep legacy modular routes for handlers not yet migrated (for backward compatibility)
  // Note: Project routes consolidated into new architecture - no longer needed here
  registerTaskManagementRoutes(router, apiController);
  registerSystemRoutes(router, apiController);
  registerSchedulerRoutes(router, apiController);
  registerTerminalRoutes(router, apiController);
  registerAssignmentsRoutes(router, apiController);
  registerErrorRoutes(router, apiController);
  registerScheduledMessageRoutes(router, apiController);
  registerDeliveryLogRoutes(router, apiController);
  registerConfigRoutes(router, apiController);
  registerCronTaskRoutes(router);

  // Unified Scheduler (cron + interval + idle — consolidation)
  router.use('/unified-scheduler', createUnifiedSchedulerRoutes());

  // Escalation routes — human escalation resolution
  router.get('/escalations', async (_req, res) => {
    try {
      const { EscalationRouterService } = await import('../services/v3/escalation-router.service.js');
      const pending = await EscalationRouterService.getInstance().listPending();
      res.json({ success: true, data: pending, count: pending.length });
    } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });

  router.post('/escalations/:id/resolve', async (req, res) => {
    try {
      const { EscalationRouterService } = await import('../services/v3/escalation-router.service.js');
      const { resolution, resolvedBy } = req.body;
      if (!resolution) { res.status(400).json({ success: false, error: 'resolution is required' }); return; }
      const result = await EscalationRouterService.getInstance().resolve(
        req.params.id, resolution, resolvedBy || 'user',
      );
      if (!result) { res.status(404).json({ success: false, error: 'Escalation not found' }); return; }
      res.json({ success: true, data: result });
    } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });

  // Relay devices stubs (prevents 404 noise from dashboard relay health card).
  //
  // Two URL shapes are supported because callers use either the local-stub
  // form (`/api/relay/devices`) or the cloud-relay form (`/api/v1/relay/devices`).
  // The cloud constants (CLOUD_CONSTANTS.RELAY_ENDPOINTS in `backend/src/constants.ts`)
  // standardize on the `/api/v1/relay/*` form when targeting cloud, and dev
  // proxies (frontend Vite proxy → localhost:8787) can route those requests at
  // the local backend instead, producing 404 noise. The aliases below re-use
  // the same stub handlers so both shapes return identical payloads.
  const relayDevicesHandler = (_req: import('express').Request, res: import('express').Response): void => {
    res.json({ success: true, data: { devices: [], client: { state: 'offline', sessionId: null } } });
  };
  router.get('/relay/devices', relayDevicesHandler);
  router.get('/v1/relay/devices', relayDevicesHandler);

  // Legacy cloud-devices endpoint (used by RelayHealthCard and CloudTab).
  // Same dual-shape rationale as `/relay/devices` above.
  const relayCloudDevicesHandler = (_req: import('express').Request, res: import('express').Response): void => {
    res.json({ success: true, data: [] });
  };
  router.get('/relay/cloud-devices', relayCloudDevicesHandler);
  router.get('/v1/relay/cloud-devices', relayCloudDevicesHandler);

  return router;
}
