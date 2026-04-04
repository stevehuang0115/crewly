/**
 * Tests for API routes module
 *
 * Verifies route registration and basic endpoint behavior.
 */

import { Router } from 'express';

// Mock all sub-route modules to isolate route registration test
jest.mock('../controllers/index.js', () => ({
	createApiRouter: () => Router(),
}));
jest.mock('./modules/task-management.routes.js', () => ({ registerTaskManagementRoutes: jest.fn() }));
jest.mock('./modules/system.routes.js', () => ({ registerSystemRoutes: jest.fn() }));
jest.mock('./modules/scheduler.routes.js', () => ({ registerSchedulerRoutes: jest.fn() }));
jest.mock('./modules/terminal.routes.js', () => ({ registerTerminalRoutes: jest.fn() }));
jest.mock('./modules/assignments.routes.js', () => ({ registerAssignmentsRoutes: jest.fn() }));
jest.mock('./modules/errors.routes.js', () => ({ registerErrorRoutes: jest.fn() }));
jest.mock('./modules/scheduled-messages.routes.js', () => ({ registerScheduledMessageRoutes: jest.fn() }));
jest.mock('./modules/delivery-logs.routes.js', () => ({ registerDeliveryLogRoutes: jest.fn() }));
jest.mock('./modules/config.routes.js', () => ({ registerConfigRoutes: jest.fn() }));
jest.mock('./modules/cron-task.routes.js', () => ({ registerCronTaskRoutes: jest.fn() }));
jest.mock('./modules/unified-scheduler.routes.js', () => ({ createUnifiedSchedulerRoutes: () => Router() }));
jest.mock('./factory.routes.js', () => ({ createFactoryRoutes: () => Router() }));
jest.mock('../controllers/self-improvement/index.js', () => ({ selfImprovementRouter: Router() }));
jest.mock('../controllers/messaging/messaging.routes.js', () => ({ createMessagingRouter: () => Router() }));
jest.mock('../controllers/teams-backup/teams-backup.routes.js', () => ({ createTeamsBackupRouter: () => Router() }));
jest.mock('../controllers/event-bus/event-bus.routes.js', () => ({ createEventBusRouter: () => Router() }));
jest.mock('../controllers/slack/slack-thread.routes.js', () => ({ createSlackThreadRouter: () => Router() }));
jest.mock('../controllers/memory/memory.routes.js', () => ({ createMemoryRouter: () => Router() }));
jest.mock('./modules/quality-gate.routes.js', () => ({ createQualityGateRouter: () => Router() }));
jest.mock('../controllers/marketplace/index.js', () => ({ createMarketplaceRouter: () => Router() }));
jest.mock('../controllers/knowledge/index.js', () => ({ createKnowledgeRouter: () => Router() }));
jest.mock('../controllers/template/index.js', () => ({ createTemplateRouter: () => Router() }));
jest.mock('../controllers/auditor/auditor.routes.js', () => ({ createAuditorRouter: () => Router() }));
jest.mock('../controllers/payment/payment.routes.js', () => ({ createPaymentRouter: () => Router() }));
jest.mock('../controllers/provisioning/provisioning.routes.js', () => ({ createProvisioningRouter: () => Router() }));
jest.mock('../controllers/cloud/index.js', () => ({ createCloudRouter: () => Router() }));
jest.mock('../controllers/pr-review/pr-review.routes.js', () => ({ createPrReviewRouter: () => Router() }));
jest.mock('../controllers/approvals/approvals.routes.js', () => ({ createApprovalsRouter: () => Router() }));
jest.mock('../controllers/approvals/approvals.controller.js', () => ({ setApprovalQueueService: jest.fn() }));
jest.mock('../services/agent/crewly-agent/approval-queue.service.js', () => ({
	ApprovalQueueService: { getInstance: () => ({}) },
}));
jest.mock('../controllers/monitoring/monitoring.routes.js', () => ({ createMonitoringRouter: () => Router() }));
jest.mock('../controllers/intent-task/intent-task.routes.js', () => ({ createIntentTaskRouter: () => Router() }));
jest.mock('../controllers/browser/browser.routes.js', () => ({ createBrowserRouter: () => Router() }));
jest.mock('../controllers/cross-machine/index.js', () => ({ createCrossMachineRouter: () => Router() }));
jest.mock('../controllers/data/data.routes.js', () => ({ createDataRouter: () => Router() }));

import { createApiRoutes } from './api.routes.js';

describe('API Routes', () => {
	it('should create a router without errors', () => {
		const mockApiController = {
			storageService: {},
			tmuxService: {},
			agentRegistrationService: {},
			schedulerService: {},
			messageSchedulerService: {},
			activeProjectsService: {},
			promptTemplateService: {},
			taskAssignmentMonitor: {},
			taskTrackingService: {},
		} as any;

		const router = createApiRoutes(mockApiController);
		expect(router).toBeDefined();
		// Router should have registered route layers
		expect(router.stack.length).toBeGreaterThan(0);
	});
});
