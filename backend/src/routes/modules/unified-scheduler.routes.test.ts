/**
 * Tests for Unified Scheduler Routes
 *
 * Validates that the router is properly configured with all expected
 * endpoints, HTTP methods, and path patterns.
 *
 * @module routes/modules/unified-scheduler.routes.test
 */


// Mock the controller to avoid service initialization
jest.mock('../../controllers/scheduler/unified-scheduler.controller.js', () => ({
	listSchedules: jest.fn(),
	createSchedule: jest.fn(),
	getSchedule: jest.fn(),
	updateSchedule: jest.fn(),
	deleteSchedule: jest.fn(),
	pauseSchedule: jest.fn(),
	resumeSchedule: jest.fn(),
	triggerSchedule: jest.fn(),
	getHealth: jest.fn(),
}));

import { createUnifiedSchedulerRoutes } from './unified-scheduler.routes.js';

/**
 * Extracts route definitions from an Express router's internal stack.
 *
 * @param router - Express router instance
 * @returns Array of { path, methods } objects
 */
function getRoutes(router: any): Array<{ path: string; methods: string[] }> {
	return router.stack
		.filter((layer: any) => layer.route)
		.map((layer: any) => ({
			path: layer.route.path,
			methods: Object.keys(layer.route.methods),
		}));
}

describe('Unified Scheduler Routes', () => {
	it('should return a valid Express router', () => {
		const router = createUnifiedSchedulerRoutes();
		expect(typeof router.use).toBe('function');
		expect(typeof router.get).toBe('function');
		expect(typeof router.post).toBe('function');
		expect(typeof router.put).toBe('function');
		expect(typeof router.delete).toBe('function');
	});

	it('should register exactly 9 routes', () => {
		const router = createUnifiedSchedulerRoutes();
		const routes = getRoutes(router);
		expect(routes).toHaveLength(9);
	});

	it('should register GET /schedules', () => {
		const routes = getRoutes(createUnifiedSchedulerRoutes());
		expect(routes).toContainEqual({ path: '/schedules', methods: ['get'] });
	});

	it('should register POST /schedules', () => {
		const routes = getRoutes(createUnifiedSchedulerRoutes());
		expect(routes).toContainEqual({ path: '/schedules', methods: ['post'] });
	});

	it('should register GET /schedules/:id', () => {
		const routes = getRoutes(createUnifiedSchedulerRoutes());
		expect(routes).toContainEqual({ path: '/schedules/:id', methods: ['get'] });
	});

	it('should register PUT /schedules/:id', () => {
		const routes = getRoutes(createUnifiedSchedulerRoutes());
		expect(routes).toContainEqual({ path: '/schedules/:id', methods: ['put'] });
	});

	it('should register DELETE /schedules/:id', () => {
		const routes = getRoutes(createUnifiedSchedulerRoutes());
		expect(routes).toContainEqual({ path: '/schedules/:id', methods: ['delete'] });
	});

	it('should register POST /schedules/:id/pause', () => {
		const routes = getRoutes(createUnifiedSchedulerRoutes());
		expect(routes).toContainEqual({ path: '/schedules/:id/pause', methods: ['post'] });
	});

	it('should register POST /schedules/:id/resume', () => {
		const routes = getRoutes(createUnifiedSchedulerRoutes());
		expect(routes).toContainEqual({ path: '/schedules/:id/resume', methods: ['post'] });
	});

	it('should register POST /schedules/:id/trigger', () => {
		const routes = getRoutes(createUnifiedSchedulerRoutes());
		expect(routes).toContainEqual({ path: '/schedules/:id/trigger', methods: ['post'] });
	});

	it('should register GET /health', () => {
		const routes = getRoutes(createUnifiedSchedulerRoutes());
		expect(routes).toContainEqual({ path: '/health', methods: ['get'] });
	});
});
