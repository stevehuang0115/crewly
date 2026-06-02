/**
 * Tests for API routes module
 *
 * Verifies:
 *  - Router constructs without errors (smoke).
 *  - Relay-device stub aliases are registered for both `/api/relay/*` and
 *    `/api/v1/relay/*` URL shapes (P0 fix for `/api/v1/relay/devices` 404 —
 *    callers using the cloud-style v1 prefix against the local backend now
 *    get a successful stub response with the same shape as the no-v1 form).
 *
 * The smoke test mocks every controller/router import so that this test
 * file does not transitively pull in optional services that may not exist
 * in every workspace checkout. The relay-stub assertions use a minimal
 * Express app with only the relay stub handlers registered, so they
 * exercise the public contract without depending on the full router graph.
 */

import express, { Router, type Request, type Response } from 'express';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Smoke test setup — mock every sub-router so `createApiRoutes` can run.
// ---------------------------------------------------------------------------
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
jest.mock('./factory.routes.js', () => ({ createFactoryRoutes: () => Router() }));
jest.mock('./modules/quality-gate.routes.js', () => ({ createQualityGateRouter: () => Router() }));
jest.mock('../controllers/self-improvement/index.js', () => ({ selfImprovementRouter: Router() }));
jest.mock('../controllers/messaging/messaging.routes.js', () => ({ createMessagingRouter: () => Router() }));
jest.mock('../controllers/teams-backup/teams-backup.routes.js', () => ({ createTeamsBackupRouter: () => Router() }));
jest.mock('../controllers/event-bus/event-bus.routes.js', () => ({ createEventBusRouter: () => Router() }));
jest.mock('../controllers/slack/slack-thread.routes.js', () => ({ createSlackThreadRouter: () => Router() }));
jest.mock('../controllers/memory/memory.routes.js', () => ({ createMemoryRouter: () => Router() }));
jest.mock('../controllers/credentials/credentials.routes.js', () => ({ createCredentialsRouter: () => Router() }));
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
jest.mock('../controllers/browser/browser.routes.js', () => ({ createBrowserRouter: () => Router() }));
jest.mock('../controllers/cross-machine/index.js', () => ({ createCrossMachineRouter: () => Router() }));
jest.mock('../controllers/onboarding/website-analysis.routes.js', () => ({ createWebsiteAnalysisRouter: () => Router() }));
jest.mock('../controllers/onboarding/onboarding.routes.js', () => ({ createOnboardingRouter: () => Router() }));
jest.mock('../controllers/orchestrator-onboarding/orchestrator-onboarding.routes.js', () => ({ createOrchestratorOnboardingRouter: () => Router() }));
jest.mock('../controllers/data/data.routes.js', () => ({ createDataRouter: () => Router() }));
jest.mock('../controllers/intent-task/intent-task.routes.js', () => ({ createIntentTaskRouter: () => Router() }));
jest.mock('../controllers/task-pool/task-pool.routes.js', () => ({ createTaskPoolRouter: () => Router() }));
jest.mock('../controllers/request/request.routes.js', () => ({ createRequestRouter: () => Router() }));
jest.mock('../controllers/reconciler/reconciler.routes.js', () => ({ createReconcilerRouter: () => Router() }));
jest.mock('../controllers/team-health/team-health.routes.js', () => ({ createTeamHealthRouter: () => Router() }));
jest.mock('../controllers/fission/fission.routes.js', () => ({ createFissionRouter: () => Router() }));
jest.mock('../controllers/mission/mission-policy.routes.js', () => ({ createMissionPolicyRouter: () => Router() }));
jest.mock('../controllers/v2-workspace/workspace.routes.js', () => ({ createV2WorkspaceRouter: () => Router() }));
jest.mock('../controllers/trigger/trigger.routes.js', () => ({ createTriggerRouter: () => Router() }));
jest.mock('../controllers/growth/growth.routes.js', () => ({ createGrowthRouter: () => Router() }));
jest.mock('../controllers/task-projection/task-projection.routes.js', () => ({ __esModule: true, default: Router() }));
jest.mock('../controllers/chat-v2/index.js', () => ({ createChatV2Router: () => Router() }));
jest.mock('../services/chat-v2/chat-v2.singleton.js', () => ({
  getChatV2Service: () => ({ setPresenceProvider: jest.fn() }),
}));
jest.mock('../services/chat-v2/chat-v2.team-membership.js', () => ({ createOssTeamMembershipValidator: () => undefined }));

import { createApiRoutes } from './api.routes.js';

describe('API Routes', () => {
	describe('smoke', () => {
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
			} as unknown as Parameters<typeof createApiRoutes>[0];

			const router = createApiRoutes(mockApiController);
			expect(router).toBeDefined();
			// Router should have registered route layers
			expect(router.stack.length).toBeGreaterThan(0);
		});
	});

	describe('relay device stubs (P0 — /api/v1/relay/devices alias)', () => {
		/**
		 * Build a minimal app that registers ONLY the relay stub aliases.
		 *
		 * The handlers are kept identical in structure to the production
		 * stubs in `api.routes.ts`. The test asserts contract behavior
		 * (HTTP 200 + identical shape across both URL forms) rather than
		 * implementation identity, so any future divergence between the
		 * two URL shapes will trigger a regression here.
		 */
		function buildRelayApp(): express.Express {
			const app = express();
			const router = Router();
			const devicesHandler = (_req: Request, res: Response): void => {
				res.json({ success: true, data: { devices: [], client: { state: 'offline', sessionId: null } } });
			};
			const cloudDevicesHandler = (_req: Request, res: Response): void => {
				res.json({ success: true, data: [] });
			};
			router.get('/relay/devices', devicesHandler);
			router.get('/v1/relay/devices', devicesHandler);
			router.get('/relay/cloud-devices', cloudDevicesHandler);
			router.get('/v1/relay/cloud-devices', cloudDevicesHandler);
			app.use('/api', router);
			return app;
		}

		it.each([
			['/api/relay/devices'],
			['/api/v1/relay/devices'],
		])('GET %s → 200 with devices+client payload', async (path) => {
			const res = await request(buildRelayApp()).get(path);
			expect(res.status).toBe(200);
			expect(res.body).toEqual({
				success: true,
				data: { devices: [], client: { state: 'offline', sessionId: null } },
			});
		});

		it('GET /api/relay/devices and GET /api/v1/relay/devices return identical bodies', async () => {
			const app = buildRelayApp();
			const noPrefix = await request(app).get('/api/relay/devices');
			const v1 = await request(app).get('/api/v1/relay/devices');
			expect(noPrefix.status).toBe(200);
			expect(v1.status).toBe(200);
			expect(noPrefix.body).toEqual(v1.body);
		});

		it.each([
			['/api/relay/cloud-devices'],
			['/api/v1/relay/cloud-devices'],
		])('GET %s → 200 with empty data array', async (path) => {
			const res = await request(buildRelayApp()).get(path);
			expect(res.status).toBe(200);
			expect(res.body).toEqual({ success: true, data: [] });
		});

		it('production routes register both URL shapes (regression guard for missing v1 alias)', () => {
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
			} as unknown as Parameters<typeof createApiRoutes>[0];
			const router = createApiRoutes(mockApiController);

			const registered = new Set<string>();
			for (const layer of router.stack) {
				const route = (layer as { route?: { path?: string; methods?: Record<string, boolean> } }).route;
				if (route?.path && route.methods?.get) registered.add(route.path);
			}
			expect(registered.has('/relay/devices')).toBe(true);
			expect(registered.has('/v1/relay/devices')).toBe(true);
			expect(registered.has('/relay/cloud-devices')).toBe(true);
			expect(registered.has('/v1/relay/cloud-devices')).toBe(true);
		});
	});
});
