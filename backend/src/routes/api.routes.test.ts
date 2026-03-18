/**
 * Tests for API routes module
 *
 * Verifies route registration and basic endpoint behavior.
 */

import { Router } from 'express';

// Mock all sub-route modules to isolate the heartbeat route test
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
jest.mock('../controllers/cloud/index.js', () => ({ createCloudRouter: () => Router(), createRelayRouter: () => Router() }));
jest.mock('../controllers/pr-review/pr-review.routes.js', () => ({ createPrReviewRouter: () => Router() }));
jest.mock('../controllers/approvals/approvals.routes.js', () => ({ createApprovalsRouter: () => Router() }));
jest.mock('../controllers/approvals/approvals.controller.js', () => ({ setApprovalQueueService: jest.fn() }));
jest.mock('../services/agent/crewly-agent/approval-queue.service.js', () => ({
	ApprovalQueueService: { getInstance: () => ({}) },
}));
jest.mock('../controllers/monitoring/monitoring.routes.js', () => ({ createMonitoringRouter: () => Router() }));

import { createApiRoutes } from './api.routes.js';
import express from 'express';
import request from 'supertest';

describe('API Routes', () => {
	describe('POST /heartbeat', () => {
		it('should return success response', async () => {
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

			const app = express();
			app.use(express.json());
			app.use('/api', createApiRoutes(mockApiController));

			const res = await request(app)
				.post('/api/heartbeat')
				.set('X-Agent-Session', 'test-agent')
				.send({ source: 'skill-start' });

			expect(res.status).toBe(200);
			expect(res.body).toEqual({ success: true });
		});
	});
});
