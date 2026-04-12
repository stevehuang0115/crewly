/**
 * Tests for Unified Scheduler Controller
 *
 * Validates all REST handlers: CRUD, pause/resume, trigger, health,
 * request validation, and error handling.
 *
 * @module controllers/scheduler/unified-scheduler.controller.test
 */

import express from 'express';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Hoisted service mock — must be hoisted so the jest.mock factory can reference it
// ---------------------------------------------------------------------------
const mockService = {
	list: jest.fn(),
	create: jest.fn(),
	get: jest.fn(),
	update: jest.fn(),
	delete: jest.fn(),
	pause: jest.fn(),
	resume: jest.fn(),
	triggerNow: jest.fn(),
	getHealth: jest.fn(),
};

jest.mock('../../services/workflow/unified-scheduler.service.js', () => ({
	UnifiedSchedulerService: {
		getInstance: () => mockService,
	},
}));

import { createUnifiedSchedulerRoutes } from '../../routes/modules/unified-scheduler.routes.js';

/**
 * Creates a test Express app with the unified scheduler routes mounted.
 */
function createApp() {
	const app = express();
	app.use(express.json());
	app.use('/api/unified-scheduler', createUnifiedSchedulerRoutes());
	return app;
}

/** Sample schedule object for reuse across tests. */
const sampleSchedule = {
	id: 'sched-001',
	target: 'crewly-orc',
	type: 'cron',
	cron: '*/5 * * * *',
	message: 'Check status',
	enabled: true,
	autoStart: false,
	maxConsecutiveTriggers: 10,
	createdAt: '2026-03-22T10:00:00Z',
	updatedAt: '2026-03-22T10:00:00Z',
	triggerCount: 0,
	consecutiveTriggers: 0,
	status: 'active',
};

describe('Unified Scheduler Controller', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	// -----------------------------------------------------------------------
	// GET /schedules
	// -----------------------------------------------------------------------
	describe('GET /api/unified-scheduler/schedules', () => {
		it('should return all schedules', async () => {
			mockService.list.mockResolvedValue([sampleSchedule]);

			const app = createApp();
			const res = await request(app).get('/api/unified-scheduler/schedules');

			expect(res.status).toBe(200);
			expect(res.body.schedules).toHaveLength(1);
			expect(res.body.schedules[0].id).toBe('sched-001');
			expect(mockService.list).toHaveBeenCalledWith(undefined);
		});

		it('should pass target query parameter to service', async () => {
			mockService.list.mockResolvedValue([]);

			const app = createApp();
			const res = await request(app).get('/api/unified-scheduler/schedules?target=crewly-orc');

			expect(res.status).toBe(200);
			expect(mockService.list).toHaveBeenCalledWith('crewly-orc');
		});

		it('should return 500 on service error', async () => {
			mockService.list.mockRejectedValue(new Error('DB failure'));

			const app = createApp();
			const res = await request(app).get('/api/unified-scheduler/schedules');

			expect(res.status).toBe(500);
			expect(res.body.error).toBe('DB failure');
		});
	});

	// -----------------------------------------------------------------------
	// POST /schedules — Create
	// -----------------------------------------------------------------------
	describe('POST /api/unified-scheduler/schedules', () => {
		it('should create a cron schedule', async () => {
			mockService.create.mockResolvedValue(sampleSchedule);

			const app = createApp();
			const res = await request(app)
				.post('/api/unified-scheduler/schedules')
				.send({ target: 'crewly-orc', type: 'cron', cron: '*/5 * * * *', message: 'Check status' });

			expect(res.status).toBe(201);
			expect(res.body.id).toBe('sched-001');
			expect(mockService.create).toHaveBeenCalledTimes(1);
		});

		it('should create an interval schedule', async () => {
			const intervalSchedule = { ...sampleSchedule, type: 'interval', intervalMinutes: 15 };
			mockService.create.mockResolvedValue(intervalSchedule);

			const app = createApp();
			const res = await request(app)
				.post('/api/unified-scheduler/schedules')
				.send({ target: 'agent-1', type: 'interval', intervalMinutes: 15, message: 'Ping' });

			expect(res.status).toBe(201);
			expect(res.body.type).toBe('interval');
		});

		it('should create an idle schedule', async () => {
			const idleSchedule = { ...sampleSchedule, type: 'idle', idleTimeoutMinutes: 30 };
			mockService.create.mockResolvedValue(idleSchedule);

			const app = createApp();
			const res = await request(app)
				.post('/api/unified-scheduler/schedules')
				.send({ target: 'agent-1', type: 'idle', idleTimeoutMinutes: 30, message: 'Wake up' });

			expect(res.status).toBe(201);
			expect(res.body.type).toBe('idle');
		});

		it('should return 400 when target is missing', async () => {
			const app = createApp();
			const res = await request(app)
				.post('/api/unified-scheduler/schedules')
				.send({ type: 'cron', cron: '*/5 * * * *', message: 'test' });

			expect(res.status).toBe(400);
			expect(res.body.error).toContain('target');
		});

		it('should return 400 when type is missing', async () => {
			const app = createApp();
			const res = await request(app)
				.post('/api/unified-scheduler/schedules')
				.send({ target: 'agent-1', message: 'test' });

			expect(res.status).toBe(400);
			expect(res.body.error).toContain('type');
		});

		it('should return 400 when type is invalid', async () => {
			const app = createApp();
			const res = await request(app)
				.post('/api/unified-scheduler/schedules')
				.send({ target: 'agent-1', type: 'weekly', message: 'test' });

			expect(res.status).toBe(400);
			expect(res.body.error).toContain('type');
		});

		it('should return 400 when message is missing', async () => {
			const app = createApp();
			const res = await request(app)
				.post('/api/unified-scheduler/schedules')
				.send({ target: 'agent-1', type: 'interval', intervalMinutes: 5 });

			expect(res.status).toBe(400);
			expect(res.body.error).toContain('message');
		});

		it('should return 400 when cron expression is missing for type=cron', async () => {
			const app = createApp();
			const res = await request(app)
				.post('/api/unified-scheduler/schedules')
				.send({ target: 'agent-1', type: 'cron', message: 'test' });

			expect(res.status).toBe(400);
			expect(res.body.error).toContain('cron');
		});

		it('should return 400 when cron expression is invalid', async () => {
			const app = createApp();
			const res = await request(app)
				.post('/api/unified-scheduler/schedules')
				.send({ target: 'agent-1', type: 'cron', cron: 'not-valid', message: 'test' });

			expect(res.status).toBe(400);
			expect(res.body.error).toContain('cron');
		});

		it('should return 400 when cron has wrong number of fields', async () => {
			const app = createApp();
			const res = await request(app)
				.post('/api/unified-scheduler/schedules')
				.send({ target: 'agent-1', type: 'cron', cron: '* * *', message: 'test' });

			expect(res.status).toBe(400);
			expect(res.body.error).toContain('cron');
		});

		it('should return 400 when intervalMinutes is missing for type=interval', async () => {
			const app = createApp();
			const res = await request(app)
				.post('/api/unified-scheduler/schedules')
				.send({ target: 'agent-1', type: 'interval', message: 'test' });

			expect(res.status).toBe(400);
			expect(res.body.error).toContain('intervalMinutes');
		});

		it('should return 400 when intervalMinutes is zero', async () => {
			const app = createApp();
			const res = await request(app)
				.post('/api/unified-scheduler/schedules')
				.send({ target: 'agent-1', type: 'interval', intervalMinutes: 0, message: 'test' });

			expect(res.status).toBe(400);
			expect(res.body.error).toContain('intervalMinutes');
		});

		it('should return 400 when intervalMinutes is negative', async () => {
			const app = createApp();
			const res = await request(app)
				.post('/api/unified-scheduler/schedules')
				.send({ target: 'agent-1', type: 'interval', intervalMinutes: -5, message: 'test' });

			expect(res.status).toBe(400);
			expect(res.body.error).toContain('intervalMinutes');
		});

		it('should return 400 when idleTimeoutMinutes is missing for type=idle', async () => {
			const app = createApp();
			const res = await request(app)
				.post('/api/unified-scheduler/schedules')
				.send({ target: 'agent-1', type: 'idle', message: 'test' });

			expect(res.status).toBe(400);
			expect(res.body.error).toContain('idleTimeoutMinutes');
		});

		it('should return 400 when idleTimeoutMinutes is zero', async () => {
			const app = createApp();
			const res = await request(app)
				.post('/api/unified-scheduler/schedules')
				.send({ target: 'agent-1', type: 'idle', idleTimeoutMinutes: 0, message: 'test' });

			expect(res.status).toBe(400);
			expect(res.body.error).toContain('idleTimeoutMinutes');
		});

		it('should return 500 on service error', async () => {
			mockService.create.mockRejectedValue(new Error('Disk full'));

			const app = createApp();
			const res = await request(app)
				.post('/api/unified-scheduler/schedules')
				.send({ target: 'agent-1', type: 'cron', cron: '0 * * * *', message: 'test' });

			expect(res.status).toBe(500);
			expect(res.body.error).toBe('Disk full');
		});
	});

	// -----------------------------------------------------------------------
	// GET /schedules/:id
	// -----------------------------------------------------------------------
	describe('GET /api/unified-scheduler/schedules/:id', () => {
		it('should return a single schedule', async () => {
			mockService.get.mockResolvedValue(sampleSchedule);

			const app = createApp();
			const res = await request(app).get('/api/unified-scheduler/schedules/sched-001');

			expect(res.status).toBe(200);
			expect(res.body.id).toBe('sched-001');
			expect(mockService.get).toHaveBeenCalledWith('sched-001');
		});

		it('should return 404 when schedule not found', async () => {
			mockService.get.mockResolvedValue(null);

			const app = createApp();
			const res = await request(app).get('/api/unified-scheduler/schedules/nonexistent');

			expect(res.status).toBe(404);
			expect(res.body.error).toContain('nonexistent');
		});

		it('should return 500 on service error', async () => {
			mockService.get.mockRejectedValue(new Error('Read error'));

			const app = createApp();
			const res = await request(app).get('/api/unified-scheduler/schedules/sched-001');

			expect(res.status).toBe(500);
			expect(res.body.error).toBe('Read error');
		});
	});

	// -----------------------------------------------------------------------
	// PUT /schedules/:id — Update
	// -----------------------------------------------------------------------
	describe('PUT /api/unified-scheduler/schedules/:id', () => {
		it('should update a schedule with partial fields', async () => {
			const updated = { ...sampleSchedule, message: 'Updated message' };
			mockService.update.mockResolvedValue(updated);

			const app = createApp();
			const res = await request(app)
				.put('/api/unified-scheduler/schedules/sched-001')
				.send({ message: 'Updated message' });

			expect(res.status).toBe(200);
			expect(res.body.message).toBe('Updated message');
			expect(mockService.update).toHaveBeenCalledWith('sched-001', { message: 'Updated message' });
		});

		it('should return 404 when schedule not found', async () => {
			mockService.update.mockResolvedValue(null);

			const app = createApp();
			const res = await request(app)
				.put('/api/unified-scheduler/schedules/nonexistent')
				.send({ message: 'test' });

			expect(res.status).toBe(404);
			expect(res.body.error).toContain('nonexistent');
		});

		it('should return 400 when update includes invalid type', async () => {
			const app = createApp();
			const res = await request(app)
				.put('/api/unified-scheduler/schedules/sched-001')
				.send({ type: 'weekly' });

			expect(res.status).toBe(400);
			expect(res.body.error).toContain('type');
		});

		it('should validate cron expression on update when type=cron', async () => {
			const app = createApp();
			const res = await request(app)
				.put('/api/unified-scheduler/schedules/sched-001')
				.send({ type: 'cron', cron: 'bad' });

			expect(res.status).toBe(400);
			expect(res.body.error).toContain('cron');
		});

		it('should return 500 on service error', async () => {
			mockService.update.mockRejectedValue(new Error('Write error'));

			const app = createApp();
			const res = await request(app)
				.put('/api/unified-scheduler/schedules/sched-001')
				.send({ message: 'test' });

			expect(res.status).toBe(500);
			expect(res.body.error).toBe('Write error');
		});
	});

	// -----------------------------------------------------------------------
	// DELETE /schedules/:id
	// -----------------------------------------------------------------------
	describe('DELETE /api/unified-scheduler/schedules/:id', () => {
		it('should delete a schedule', async () => {
			mockService.delete.mockResolvedValue(true);

			const app = createApp();
			const res = await request(app).delete('/api/unified-scheduler/schedules/sched-001');

			expect(res.status).toBe(200);
			expect(res.body.success).toBe(true);
			expect(res.body.id).toBe('sched-001');
		});

		it('should return 404 when schedule not found', async () => {
			mockService.delete.mockResolvedValue(false);

			const app = createApp();
			const res = await request(app).delete('/api/unified-scheduler/schedules/nonexistent');

			expect(res.status).toBe(404);
			expect(res.body.error).toContain('nonexistent');
		});

		it('should return 500 on service error', async () => {
			mockService.delete.mockRejectedValue(new Error('Delete error'));

			const app = createApp();
			const res = await request(app).delete('/api/unified-scheduler/schedules/sched-001');

			expect(res.status).toBe(500);
			expect(res.body.error).toBe('Delete error');
		});
	});

	// -----------------------------------------------------------------------
	// POST /schedules/:id/pause
	// -----------------------------------------------------------------------
	describe('POST /api/unified-scheduler/schedules/:id/pause', () => {
		it('should pause a schedule', async () => {
			const paused = { ...sampleSchedule, status: 'paused', enabled: false };
			mockService.pause.mockResolvedValue(paused);

			const app = createApp();
			const res = await request(app).post('/api/unified-scheduler/schedules/sched-001/pause');

			expect(res.status).toBe(200);
			expect(res.body.status).toBe('paused');
			expect(mockService.pause).toHaveBeenCalledWith('sched-001');
		});

		it('should return 404 when schedule not found', async () => {
			mockService.pause.mockResolvedValue(null);

			const app = createApp();
			const res = await request(app).post('/api/unified-scheduler/schedules/nonexistent/pause');

			expect(res.status).toBe(404);
		});

		it('should return 500 on service error', async () => {
			mockService.pause.mockRejectedValue(new Error('Pause error'));

			const app = createApp();
			const res = await request(app).post('/api/unified-scheduler/schedules/sched-001/pause');

			expect(res.status).toBe(500);
		});
	});

	// -----------------------------------------------------------------------
	// POST /schedules/:id/resume
	// -----------------------------------------------------------------------
	describe('POST /api/unified-scheduler/schedules/:id/resume', () => {
		it('should resume a paused schedule', async () => {
			const resumed = { ...sampleSchedule, status: 'active', enabled: true };
			mockService.resume.mockResolvedValue(resumed);

			const app = createApp();
			const res = await request(app).post('/api/unified-scheduler/schedules/sched-001/resume');

			expect(res.status).toBe(200);
			expect(res.body.status).toBe('active');
			expect(mockService.resume).toHaveBeenCalledWith('sched-001');
		});

		it('should return 404 when schedule not found', async () => {
			mockService.resume.mockResolvedValue(null);

			const app = createApp();
			const res = await request(app).post('/api/unified-scheduler/schedules/nonexistent/resume');

			expect(res.status).toBe(404);
		});

		it('should return 500 on service error', async () => {
			mockService.resume.mockRejectedValue(new Error('Resume error'));

			const app = createApp();
			const res = await request(app).post('/api/unified-scheduler/schedules/sched-001/resume');

			expect(res.status).toBe(500);
		});
	});

	// -----------------------------------------------------------------------
	// POST /schedules/:id/trigger
	// -----------------------------------------------------------------------
	describe('POST /api/unified-scheduler/schedules/:id/trigger', () => {
		it('should trigger a schedule manually', async () => {
			const result = { triggered: true, scheduleId: 'sched-001', triggeredAt: '2026-03-22T12:00:00Z' };
			mockService.triggerNow.mockResolvedValue(result);

			const app = createApp();
			const res = await request(app).post('/api/unified-scheduler/schedules/sched-001/trigger');

			expect(res.status).toBe(200);
			expect(res.body.triggered).toBe(true);
			expect(mockService.triggerNow).toHaveBeenCalledWith('sched-001');
		});

		it('should return 404 when schedule not found', async () => {
			mockService.triggerNow.mockResolvedValue(null);

			const app = createApp();
			const res = await request(app).post('/api/unified-scheduler/schedules/nonexistent/trigger');

			expect(res.status).toBe(404);
		});

		it('should return 500 on service error', async () => {
			mockService.triggerNow.mockRejectedValue(new Error('Trigger error'));

			const app = createApp();
			const res = await request(app).post('/api/unified-scheduler/schedules/sched-001/trigger');

			expect(res.status).toBe(500);
		});
	});

	// -----------------------------------------------------------------------
	// GET /health
	// -----------------------------------------------------------------------
	describe('GET /api/unified-scheduler/health', () => {
		it('should return scheduler health stats', async () => {
			const health = {
				schedulerState: 'running',
				activeCount: 5,
				pausedCount: 2,
				totalTriggers: 142,
			};
			mockService.getHealth.mockResolvedValue(health);

			const app = createApp();
			const res = await request(app).get('/api/unified-scheduler/health');

			expect(res.status).toBe(200);
			expect(res.body.schedulerState).toBe('running');
			expect(res.body.activeCount).toBe(5);
			expect(res.body.pausedCount).toBe(2);
			expect(res.body.totalTriggers).toBe(142);
		});

		it('should return 500 on service error', async () => {
			mockService.getHealth.mockRejectedValue(new Error('Health check failed'));

			const app = createApp();
			const res = await request(app).get('/api/unified-scheduler/health');

			expect(res.status).toBe(500);
			expect(res.body.error).toBe('Health check failed');
		});
	});

	// -----------------------------------------------------------------------
	// Edge cases
	// -----------------------------------------------------------------------
	describe('Edge cases', () => {
		it('should handle non-Error thrown values in list', async () => {
			mockService.list.mockRejectedValue('raw string error');

			const app = createApp();
			const res = await request(app).get('/api/unified-scheduler/schedules');

			expect(res.status).toBe(500);
			expect(res.body.error).toBe('Failed to list schedules');
		});

		it('should accept valid complex cron expressions', async () => {
			mockService.create.mockResolvedValue(sampleSchedule);

			const app = createApp();
			const res = await request(app)
				.post('/api/unified-scheduler/schedules')
				.send({ target: 'agent-1', type: 'cron', cron: '0,30 9-17 */2 1,6 1-5', message: 'test' });

			expect(res.status).toBe(201);
		});

		it('should allow partial update without type-specific validation when type not in body', async () => {
			const updated = { ...sampleSchedule, message: 'new msg' };
			mockService.update.mockResolvedValue(updated);

			const app = createApp();
			const res = await request(app)
				.put('/api/unified-scheduler/schedules/sched-001')
				.send({ message: 'new msg' });

			expect(res.status).toBe(200);
		});
	});
});
