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
jest.mock('../controllers/browser/browser.routes.js', () => ({ createBrowserRouter: () => Router() }));
jest.mock('../services/wechat/wechat.controller.js', () => ({ createWeChatRouter: () => Router() }));
jest.mock('../controllers/cross-machine/index.js', () => ({ createCrossMachineRouter: () => Router() }));
jest.mock('./modules/cron-task.routes.js', () => ({ registerCronTaskRoutes: jest.fn() }));
jest.mock('./modules/unified-scheduler.routes.js', () => ({ createUnifiedSchedulerRoutes: () => Router() }));

// Mock task management and terminal handlers for alias route tests (#262)
const mockListTasks = jest.fn(function(this: any, _req: any, res: any) { res.json({ success: true, data: [] }); });
const mockListTerminalSessions = jest.fn((_req: any, res: any) => res.json({ success: true, data: [] }));
jest.mock('../controllers/task-management/task-management.controller.js', () => ({
	listTasks: mockListTasks,
	createTask: jest.fn(),
	assignTask: jest.fn(),
	completeTask: jest.fn(),
	blockTask: jest.fn(),
	unblockTask: jest.fn(),
	readTask: jest.fn(),
	takeNextTask: jest.fn(),
	syncTaskStatus: jest.fn(),
	getTeamProgress: jest.fn(),
	startTaskExecution: jest.fn(),
	recoverAbandonedTasks: jest.fn(),
	createTasksFromConfig: jest.fn(),
	getTaskOutput: jest.fn(),
	requestReview: jest.fn(),
	addMonitoring: jest.fn(),
	completeTasksBySession: jest.fn(),
	cleanupOrphanTasks: jest.fn(),
	scoreTask: jest.fn(),
	recordHandoff: jest.fn(),
}));
jest.mock('../controllers/monitoring/terminal.controller.js', () => ({
	listTerminalSessions: mockListTerminalSessions,
	getSessionLogs: jest.fn(),
	captureTerminal: jest.fn(),
}));

import { createApiRoutes } from './api.routes.js';
import express from 'express';
import request from 'supertest';

describe('API Routes', () => {
	const mockApiController = {
		storageService: {
			getTeams: jest.fn().mockResolvedValue([
				{
					id: 'team-1',
					name: 'Test Team',
					members: [
						{ id: 'm1', name: 'Dev 1', sessionName: 'dev-1', role: 'developer', agentStatus: 'active' },
					],
				},
			]),
		},
		tmuxService: {},
		agentRegistrationService: {},
		schedulerService: {},
		messageSchedulerService: {},
		activeProjectsService: {},
		promptTemplateService: {},
		taskAssignmentMonitor: {},
		taskTrackingService: {},
	} as any;

	describe('Alias routes (#262)', () => {
		let app: express.Express;

		beforeEach(() => {
			app = express();
			app.use(express.json());
			app.use('/api', createApiRoutes(mockApiController));
		});

		it('GET /api/tasks should return task list', async () => {
			const res = await request(app).get('/api/tasks');
			expect(res.status).toBe(200);
			expect(res.body.success).toBe(true);
		});

		it('GET /api/agent-logs should return terminal sessions', async () => {
			const res = await request(app).get('/api/agent-logs');
			expect(res.status).toBe(200);
			expect(res.body.success).toBe(true);
		});

		it('GET /api/members should return all team members', async () => {
			const res = await request(app).get('/api/members');
			expect(res.status).toBe(200);
			expect(res.body.success).toBe(true);
			expect(res.body.data).toHaveLength(1);
			expect(res.body.data[0].name).toBe('Dev 1');
			expect(res.body.data[0].teamId).toBe('team-1');
			expect(res.body.data[0].teamName).toBe('Test Team');
		});

		it('GET /api/members should handle storage errors', async () => {
			const errorController = {
				...mockApiController,
				storageService: {
					getTeams: jest.fn().mockRejectedValue(new Error('Storage failure')),
				},
			} as any;

			const errorApp = express();
			errorApp.use(express.json());
			errorApp.use('/api', createApiRoutes(errorController));

			const res = await request(errorApp).get('/api/members');
			expect(res.status).toBe(500);
			expect(res.body.success).toBe(false);
		});
	});
});
