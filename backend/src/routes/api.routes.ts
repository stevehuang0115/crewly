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
import { createFactoryRoutes } from './factory.routes.js';
import { selfImprovementRouter } from '../controllers/self-improvement/index.js';
import { createMessagingRouter } from '../controllers/messaging/messaging.routes.js';
import { createTeamsBackupRouter } from '../controllers/teams-backup/teams-backup.routes.js';
import { createEventBusRouter } from '../controllers/event-bus/event-bus.routes.js';
import { createSlackThreadRouter } from '../controllers/slack/slack-thread.routes.js';
import { createMemoryRouter } from '../controllers/memory/memory.routes.js';
import { createQualityGateRouter } from './modules/quality-gate.routes.js';
import { createMarketplaceRouter } from '../controllers/marketplace/index.js';
import { createKnowledgeRouter } from '../controllers/knowledge/index.js';
import { createTemplateRouter } from '../controllers/template/index.js';
import { createAuditorRouter } from '../controllers/auditor/auditor.routes.js';
import { createPaymentRouter } from '../controllers/payment/payment.routes.js';
import { createCloudRouter, createRelayRouter } from '../controllers/cloud/index.js';
import { createPrReviewRouter } from '../controllers/pr-review/pr-review.routes.js';
import { createApprovalsRouter } from '../controllers/approvals/approvals.routes.js';
import { setApprovalQueueService } from '../controllers/approvals/approvals.controller.js';
import { ApprovalQueueService } from '../services/agent/crewly-agent/approval-queue.service.js';

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

  // Cloud routes for connect, disconnect, validate, status, templates, and Google OAuth
  router.use('/cloud', createCloudRouter());

  // Relay routes for cloud relay client endpoints (connect, disconnect, devices, send)
  router.use('/relay', createRelayRouter());

  // PR review routes for automated GitHub PR reviews via webhooks
  router.use('/pr-review', createPrReviewRouter());

  // Tool approval management routes for granular tool execution control
  // Wire the shared approval queue singleton to the API controller
  setApprovalQueueService(ApprovalQueueService.getInstance());
  router.use('/approvals', createApprovalsRouter());

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

  return router;
}
