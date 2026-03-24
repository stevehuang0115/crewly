import { CronTaskService, getNextRunTime, getDatePartsInTimezone, parseCronField } from './cron-task.service.js';
import type { CronTask } from '../../types/cron-task.types.js';

// Mock logger
jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: jest.fn().mockReturnValue({
			createComponentLogger: jest.fn().mockReturnValue({
				info: jest.fn(),
				debug: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
			}),
		}),
	},
}));

// Mock fs/promises
jest.mock('fs/promises', () => ({
	readFile: jest.fn(),
	writeFile: jest.fn().mockResolvedValue(undefined),
	mkdir: jest.fn().mockResolvedValue(undefined),
}));

const mockReadFile = require('fs/promises').readFile as jest.Mock;
const mockWriteFile = require('fs/promises').writeFile as jest.Mock;

describe('CronTaskService', () => {
	let service: CronTaskService;

	beforeEach(() => {
		jest.clearAllMocks();
		CronTaskService.resetInstance();
		service = new CronTaskService('/tmp/test-crewly');
		mockReadFile.mockRejectedValue(new Error('ENOENT'));
	});

	afterEach(() => {
		service.stop();
	});

	describe('parseCronField', () => {
		it('should return null for wildcard', () => {
			expect(parseCronField('*', 0, 59)).toBeNull();
		});

		it('should parse single number', () => {
			const result = parseCronField('5', 0, 59);
			expect(result).toEqual(new Set([5]));
		});

		it('should parse range (1-5)', () => {
			const result = parseCronField('1-5', 0, 6);
			expect(result).toEqual(new Set([1, 2, 3, 4, 5]));
		});

		it('should parse list (1,3,5)', () => {
			const result = parseCronField('1,3,5', 0, 6);
			expect(result).toEqual(new Set([1, 3, 5]));
		});

		it('should parse step values (*/15)', () => {
			const result = parseCronField('*/15', 0, 59);
			expect(result).toEqual(new Set([0, 15, 30, 45]));
		});

		it('should parse range with step (10-30/5)', () => {
			const result = parseCronField('10-30/5', 0, 59);
			expect(result).toEqual(new Set([10, 15, 20, 25, 30]));
		});

		it('should parse combined list and range (1-3,5)', () => {
			const result = parseCronField('1-3,5', 0, 6);
			expect(result).toEqual(new Set([1, 2, 3, 5]));
		});
	});

	describe('getNextRunTime', () => {
		it('should calculate next run for daily cron', () => {
			const result = getNextRunTime('0 9 * * *', 'UTC', new Date('2026-03-20T08:00:00Z'));
			expect(new Date(result).getUTCHours()).toBe(9);
			expect(new Date(result).getUTCMinutes()).toBe(0);
		});

		it('should calculate next run for hourly cron', () => {
			const result = getNextRunTime('30 * * * *', 'UTC', new Date('2026-03-20T08:00:00Z'));
			expect(new Date(result).getMinutes()).toBe(30);
		});

		it('should throw for invalid cron expression', () => {
			expect(() => getNextRunTime('invalid', 'UTC')).toThrow('Invalid cron expression');
		});

		it('should advance past current time', () => {
			const now = new Date('2026-03-20T09:00:00Z');
			const result = getNextRunTime('0 9 * * *', 'UTC', now);
			expect(new Date(result).getTime()).toBeGreaterThan(now.getTime());
		});

		it('should use timezone for field matching (Asia/Shanghai = UTC+8)', () => {
			const after = new Date('2026-03-20T00:00:00Z');
			const result = getNextRunTime('0 9 * * *', 'Asia/Shanghai', after);
			const resultDate = new Date(result);

			expect(resultDate.getUTCHours()).toBe(1);
			expect(resultDate.getUTCMinutes()).toBe(0);
			expect(resultDate.toISOString()).toBe('2026-03-20T01:00:00.000Z');
		});

		it('should give different UTC times for same cron in different timezones', () => {
			const after = new Date('2026-03-20T00:00:00Z');
			const utcResult = getNextRunTime('0 9 * * *', 'UTC', after);
			const shanghaiResult = getNextRunTime('0 9 * * *', 'Asia/Shanghai', after);

			expect(new Date(utcResult).getUTCHours()).toBe(9);
			expect(new Date(shanghaiResult).getUTCHours()).toBe(1);
			expect(utcResult).not.toBe(shanghaiResult);
		});

		it('should handle America/New_York timezone (UTC-5 in March, EDT)', () => {
			const after = new Date('2026-03-20T00:00:00Z');
			const result = getNextRunTime('30 14 * * *', 'America/New_York', after);
			const resultDate = new Date(result);

			expect(resultDate.getUTCHours()).toBe(18);
			expect(resultDate.getUTCMinutes()).toBe(30);
		});

		it('should handle day-of-week in timezone (Monday in Asia/Shanghai)', () => {
			const after = new Date('2026-03-22T20:00:00Z');
			const result = getNextRunTime('0 9 * * 1', 'Asia/Shanghai', after);
			const resultDate = new Date(result);

			expect(resultDate.toISOString()).toBe('2026-03-23T01:00:00.000Z');
		});

		it('should handle day-of-week range 1-5 (weekdays)', () => {
			// 2026-03-20 is a Friday UTC. "45 8 * * 1-5" after Friday 09:00 should go to Monday.
			const after = new Date('2026-03-20T09:00:00Z');
			const result = getNextRunTime('45 8 * * 1-5', 'UTC', after);
			const resultDate = new Date(result);

			// Monday 2026-03-23 at 08:45 UTC
			expect(resultDate.getUTCHours()).toBe(8);
			expect(resultDate.getUTCMinutes()).toBe(45);
			expect(resultDate.getUTCDay()).toBe(1); // Monday
			expect(resultDate.getUTCDate()).toBe(23);
		});

		it('should handle day-of-week range with timezone (1-5 in Asia/Shanghai)', () => {
			// "45 8 * * 1-5" in Asia/Shanghai, after Fri 2026-03-20T09:00:00Z
			// Fri Shanghai = 2026-03-20 17:00. Next weekday 08:45 CST is Mon 2026-03-23.
			// Mon 08:45 CST = Mon 00:45 UTC
			const after = new Date('2026-03-20T09:00:00Z');
			const result = getNextRunTime('45 8 * * 1-5', 'Asia/Shanghai', after);
			const resultDate = new Date(result);

			expect(resultDate.getUTCHours()).toBe(0);
			expect(resultDate.getUTCMinutes()).toBe(45);
			expect(resultDate.getUTCDate()).toBe(23);
		});

		it('should handle step values in minutes (*/15)', () => {
			const after = new Date('2026-03-20T08:00:00Z');
			const result = getNextRunTime('*/15 * * * *', 'UTC', after);
			const resultDate = new Date(result);

			// Next 15-minute mark after 08:00 is 08:15
			expect(resultDate.getUTCMinutes() % 15).toBe(0);
		});
	});

	describe('getDatePartsInTimezone', () => {
		it('should return UTC parts for UTC timezone', () => {
			const date = new Date('2026-03-20T14:30:00Z');
			const parts = getDatePartsInTimezone(date, 'UTC');

			expect(parts.hour).toBe(14);
			expect(parts.minute).toBe(30);
			expect(parts.month).toBe(3);
			expect(parts.dayOfMonth).toBe(20);
		});

		it('should return Shanghai parts (UTC+8)', () => {
			const date = new Date('2026-03-20T14:30:00Z');
			const parts = getDatePartsInTimezone(date, 'Asia/Shanghai');

			expect(parts.hour).toBe(22);
			expect(parts.minute).toBe(30);
			expect(parts.month).toBe(3);
			expect(parts.dayOfMonth).toBe(20);
		});

		it('should handle date rollover across timezone boundary', () => {
			const date = new Date('2026-03-20T23:00:00Z');
			const parts = getDatePartsInTimezone(date, 'Asia/Shanghai');

			expect(parts.hour).toBe(7);
			expect(parts.dayOfMonth).toBe(21);
		});

		it('should return correct dayOfWeek', () => {
			const date = new Date('2026-03-20T12:00:00Z');
			const parts = getDatePartsInTimezone(date, 'UTC');
			expect(parts.dayOfWeek).toBe(5); // Friday
		});
	});

	describe('create', () => {
		it('should create a cron task with generated ID and nextRunAt', async () => {
			const task = await service.create({
				cronExpression: '0 9 * * *',
				timezone: 'Asia/Shanghai',
				targetAgent: 'crewly-marketing-ella',
				targetTeamId: 'team-1',
				taskDescription: 'Generate daily report',
			});

			expect(task.id).toMatch(/^cron-/);
			expect(task.cronExpression).toBe('0 9 * * *');
			expect(task.timezone).toBe('Asia/Shanghai');
			expect(task.targetAgent).toBe('crewly-marketing-ella');
			expect(task.enabled).toBe(true);
			expect(task.lastRunAt).toBeNull();
			expect(task.nextRunAt).toBeTruthy();
			expect(task.createdBy).toBe('user');
		});

		it('should default timezone to UTC', async () => {
			const task = await service.create({
				cronExpression: '0 9 * * *',
				targetAgent: 'agent-1',
				targetTeamId: 'team-1',
				taskDescription: 'Test',
			});

			expect(task.timezone).toBe('UTC');
		});

		it('should persist to disk', async () => {
			await service.create({
				cronExpression: '0 9 * * *',
				targetAgent: 'agent-1',
				targetTeamId: 'team-1',
				taskDescription: 'Test',
			});

			expect(mockWriteFile).toHaveBeenCalledWith(
				expect.stringContaining('cron-tasks.json'),
				expect.any(String),
				'utf-8',
			);
		});
	});

	describe('list', () => {
		it('should return all tasks', async () => {
			await service.create({ cronExpression: '0 9 * * *', targetAgent: 'a1', targetTeamId: 't1', taskDescription: 'Task 1' });

			const lastWrite = JSON.parse(mockWriteFile.mock.calls[mockWriteFile.mock.calls.length - 1][1]);
			mockReadFile.mockResolvedValueOnce(JSON.stringify(lastWrite));

			const tasks = await service.list();
			expect(tasks.length).toBe(1);
		});

		it('should filter by targetAgent', async () => {
			const store = {
				tasks: [
					{ id: 'cron-1', targetAgent: 'a1', enabled: true } as CronTask,
					{ id: 'cron-2', targetAgent: 'a2', enabled: true } as CronTask,
				],
			};
			mockReadFile.mockResolvedValueOnce(JSON.stringify(store));

			const tasks = await service.list({ targetAgent: 'a1' });
			expect(tasks.length).toBe(1);
			expect(tasks[0].id).toBe('cron-1');
		});

		it('should filter by enabled', async () => {
			const store = {
				tasks: [
					{ id: 'cron-1', enabled: true } as CronTask,
					{ id: 'cron-2', enabled: false } as CronTask,
				],
			};
			mockReadFile.mockResolvedValueOnce(JSON.stringify(store));

			const tasks = await service.list({ enabled: true });
			expect(tasks.length).toBe(1);
		});
	});

	describe('get', () => {
		it('should return task by ID', async () => {
			const store = { tasks: [{ id: 'cron-abc', targetAgent: 'a1' } as CronTask] };
			mockReadFile.mockResolvedValueOnce(JSON.stringify(store));

			const task = await service.get('cron-abc');
			expect(task?.id).toBe('cron-abc');
		});

		it('should return null for unknown ID', async () => {
			mockReadFile.mockResolvedValueOnce(JSON.stringify({ tasks: [] }));

			const task = await service.get('cron-unknown');
			expect(task).toBeNull();
		});
	});

	describe('update', () => {
		it('should update taskDescription', async () => {
			const store = {
				tasks: [{
					id: 'cron-1', cronExpression: '0 9 * * *', timezone: 'UTC',
					targetAgent: 'a1', taskDescription: 'Old', enabled: true, nextRunAt: null,
				} as CronTask],
			};
			mockReadFile.mockResolvedValueOnce(JSON.stringify(store));

			const updated = await service.update('cron-1', { taskDescription: 'New description' });

			expect(updated?.taskDescription).toBe('New description');
		});

		it('should recalculate nextRunAt when cronExpression changes', async () => {
			const store = {
				tasks: [{
					id: 'cron-1', cronExpression: '0 9 * * *', timezone: 'UTC',
					taskDescription: 'Test', enabled: true, nextRunAt: null,
				} as CronTask],
			};
			mockReadFile.mockResolvedValueOnce(JSON.stringify(store));

			const updated = await service.update('cron-1', { cronExpression: '30 14 * * *' });

			expect(updated?.cronExpression).toBe('30 14 * * *');
			expect(updated?.nextRunAt).toBeTruthy();
		});

		it('should return null for unknown ID', async () => {
			mockReadFile.mockResolvedValueOnce(JSON.stringify({ tasks: [] }));

			const result = await service.update('cron-unknown', { taskDescription: 'test' });
			expect(result).toBeNull();
		});
	});

	describe('delete', () => {
		it('should remove task from store', async () => {
			const store = { tasks: [{ id: 'cron-1' } as CronTask, { id: 'cron-2' } as CronTask] };
			mockReadFile.mockResolvedValueOnce(JSON.stringify(store));

			const deleted = await service.delete('cron-1');

			expect(deleted).toBe(true);
			const saved = JSON.parse(mockWriteFile.mock.calls[mockWriteFile.mock.calls.length - 1][1]);
			expect(saved.tasks.length).toBe(1);
			expect(saved.tasks[0].id).toBe('cron-2');
		});

		it('should return false for unknown ID', async () => {
			mockReadFile.mockResolvedValueOnce(JSON.stringify({ tasks: [] }));

			const deleted = await service.delete('cron-unknown');
			expect(deleted).toBe(false);
		});
	});

	describe('evaluateTasks', () => {
		it('should execute tasks whose nextRunAt has passed', async () => {
			const executedTasks: CronTask[] = [];
			service.setExecutionCallback(async (task) => { executedTasks.push(task); });

			const pastTime = new Date(Date.now() - 60000).toISOString();
			const store = {
				tasks: [{
					id: 'cron-1', cronExpression: '0 9 * * *', timezone: 'UTC',
					targetAgent: 'a1', targetTeamId: 't1', taskDescription: 'Run',
					enabled: true, lastRunAt: null, nextRunAt: pastTime,
					createdBy: 'user' as const, createdAt: '2026-01-01',
				}],
			};
			mockReadFile.mockResolvedValueOnce(JSON.stringify(store));

			await service.evaluateTasks();

			expect(executedTasks.length).toBe(1);
			expect(executedTasks[0].id).toBe('cron-1');
		});

		it('should skip disabled tasks', async () => {
			const executedTasks: CronTask[] = [];
			service.setExecutionCallback(async (task) => { executedTasks.push(task); });

			const pastTime = new Date(Date.now() - 60000).toISOString();
			const store = {
				tasks: [{
					id: 'cron-1', cronExpression: '0 9 * * *', timezone: 'UTC',
					targetAgent: 'a1', taskDescription: 'Run', enabled: false,
					nextRunAt: pastTime, createdBy: 'user' as const, createdAt: '2026-01-01',
					targetTeamId: 't1', lastRunAt: null,
				}],
			};
			mockReadFile.mockResolvedValueOnce(JSON.stringify(store));

			await service.evaluateTasks();

			expect(executedTasks.length).toBe(0);
		});

		it('should skip tasks whose nextRunAt is in the future', async () => {
			const executedTasks: CronTask[] = [];
			service.setExecutionCallback(async (task) => { executedTasks.push(task); });

			const futureTime = new Date(Date.now() + 3600000).toISOString();
			const store = {
				tasks: [{
					id: 'cron-1', cronExpression: '0 9 * * *', timezone: 'UTC',
					targetAgent: 'a1', taskDescription: 'Run', enabled: true,
					nextRunAt: futureTime, createdBy: 'user' as const, createdAt: '2026-01-01',
					targetTeamId: 't1', lastRunAt: null,
				}],
			};
			mockReadFile.mockResolvedValueOnce(JSON.stringify(store));

			await service.evaluateTasks();

			expect(executedTasks.length).toBe(0);
		});

		it('should update lastRunAt and nextRunAt after execution', async () => {
			service.setExecutionCallback(async () => {});

			const pastTime = new Date(Date.now() - 60000).toISOString();
			const store = {
				tasks: [{
					id: 'cron-1', cronExpression: '0 9 * * *', timezone: 'UTC',
					targetAgent: 'a1', taskDescription: 'Run', enabled: true,
					nextRunAt: pastTime, lastRunAt: null,
					createdBy: 'user' as const, createdAt: '2026-01-01', targetTeamId: 't1',
				}],
			};
			mockReadFile.mockResolvedValueOnce(JSON.stringify(store));

			await service.evaluateTasks();

			const saved = JSON.parse(mockWriteFile.mock.calls[mockWriteFile.mock.calls.length - 1][1]);
			expect(saved.tasks[0].lastRunAt).toBeTruthy();
			expect(saved.tasks[0].nextRunAt).not.toBe(pastTime);
		});

		it('should continue evaluation even if execution callback fails', async () => {
			service.setExecutionCallback(async () => { throw new Error('fail'); });

			const pastTime = new Date(Date.now() - 60000).toISOString();
			const store = {
				tasks: [{
					id: 'cron-1', cronExpression: '0 9 * * *', timezone: 'UTC',
					targetAgent: 'a1', taskDescription: 'Run', enabled: true,
					nextRunAt: pastTime, lastRunAt: null,
					createdBy: 'user' as const, createdAt: '2026-01-01', targetTeamId: 't1',
				}],
			};
			mockReadFile.mockResolvedValueOnce(JSON.stringify(store));

			await service.evaluateTasks();

			const saved = JSON.parse(mockWriteFile.mock.calls[mockWriteFile.mock.calls.length - 1][1]);
			expect(saved.tasks[0].lastRunAt).toBeTruthy();
		});

		it('should check agent status before executing', async () => {
			const executedTasks: CronTask[] = [];
			const mockStatus = jest.fn().mockResolvedValue(false); // agent offline

			service.setExecutionCallback(async (task) => { executedTasks.push(task); });
			service.setAgentStatusCallback(mockStatus);

			const pastTime = new Date(Date.now() - 60000).toISOString();
			const store = {
				tasks: [{
					id: 'cron-1', cronExpression: '0 9 * * *', timezone: 'UTC',
					targetAgent: 'a1', targetTeamId: 't1', taskDescription: 'Run',
					enabled: true, nextRunAt: pastTime, lastRunAt: null,
					createdBy: 'user' as const, createdAt: '2026-01-01',
				}],
			};
			mockReadFile.mockResolvedValueOnce(JSON.stringify(store));

			await service.evaluateTasks();

			// Agent offline, no start callback → skip execution
			expect(executedTasks.length).toBe(0);
			expect(mockStatus).toHaveBeenCalledWith('a1', 't1');

			// But nextRunAt should still be advanced
			const saved = JSON.parse(mockWriteFile.mock.calls[mockWriteFile.mock.calls.length - 1][1]);
			expect(saved.tasks[0].nextRunAt).not.toBe(pastTime);
			// lastRunAt should NOT be set (task was skipped)
			expect(saved.tasks[0].lastRunAt).toBeNull();
		});

		it('should auto-start offline agent when agentStartCallback is set', async () => {
			const executedTasks: CronTask[] = [];
			const mockStatus = jest.fn().mockResolvedValue(false);
			const mockStart = jest.fn().mockResolvedValue(true);

			service.setExecutionCallback(async (task) => { executedTasks.push(task); });
			service.setAgentStatusCallback(mockStatus);
			service.setAgentStartCallback(mockStart);

			const pastTime = new Date(Date.now() - 60000).toISOString();
			const store = {
				tasks: [{
					id: 'cron-1', cronExpression: '0 9 * * *', timezone: 'UTC',
					targetAgent: 'a1', targetTeamId: 't1', taskDescription: 'Run',
					enabled: true, nextRunAt: pastTime, lastRunAt: null,
					createdBy: 'user' as const, createdAt: '2026-01-01',
				}],
			};
			mockReadFile.mockResolvedValueOnce(JSON.stringify(store));

			await service.evaluateTasks();

			// Agent was started and task executed
			expect(mockStart).toHaveBeenCalledWith('a1', 't1');
			expect(executedTasks.length).toBe(1);
		});

		it('should skip execution if auto-start fails', async () => {
			const executedTasks: CronTask[] = [];
			const mockStatus = jest.fn().mockResolvedValue(false);
			const mockStart = jest.fn().mockResolvedValue(false);

			service.setExecutionCallback(async (task) => { executedTasks.push(task); });
			service.setAgentStatusCallback(mockStatus);
			service.setAgentStartCallback(mockStart);

			const pastTime = new Date(Date.now() - 60000).toISOString();
			const store = {
				tasks: [{
					id: 'cron-1', cronExpression: '0 9 * * *', timezone: 'UTC',
					targetAgent: 'a1', targetTeamId: 't1', taskDescription: 'Run',
					enabled: true, nextRunAt: pastTime, lastRunAt: null,
					createdBy: 'user' as const, createdAt: '2026-01-01',
				}],
			};
			mockReadFile.mockResolvedValueOnce(JSON.stringify(store));

			await service.evaluateTasks();

			expect(executedTasks.length).toBe(0);
		});
	});

	describe('recalculateAllNextRunTimes', () => {
		it('should recalculate stale nextRunAt values', async () => {
			// Simulate a task with wrong nextRunAt (computed in server timezone)
			// "0 9 * * *" in Asia/Shanghai, correct next should be 01:00 UTC
			// but stored as 09:00 UTC (server local)
			const store = {
				tasks: [{
					id: 'cron-1', cronExpression: '0 9 * * *', timezone: 'Asia/Shanghai',
					targetAgent: 'a1', targetTeamId: 't1', taskDescription: 'Report',
					enabled: true, lastRunAt: null,
					nextRunAt: '2026-03-24T09:00:00.000Z', // WRONG — server local
					createdBy: 'user' as const, createdAt: '2026-01-01',
				}],
			};
			mockReadFile.mockResolvedValueOnce(JSON.stringify(store));

			const updated = await service.recalculateAllNextRunTimes();

			expect(updated).toBe(1);
			const saved = JSON.parse(mockWriteFile.mock.calls[0][1]);
			const newNextRun = new Date(saved.tasks[0].nextRunAt);
			// 09:00 Shanghai = 01:00 UTC, so hour should be 1
			expect(newNextRun.getUTCHours()).toBe(1);
		});

		it('should skip disabled tasks', async () => {
			const store = {
				tasks: [{
					id: 'cron-1', cronExpression: '0 9 * * *', timezone: 'UTC',
					enabled: false, lastRunAt: null, nextRunAt: '2026-03-24T09:00:00.000Z',
					targetAgent: 'a1', targetTeamId: 't1', taskDescription: 'X',
					createdBy: 'user' as const, createdAt: '2026-01-01',
				}],
			};
			mockReadFile.mockResolvedValueOnce(JSON.stringify(store));

			const updated = await service.recalculateAllNextRunTimes();

			expect(updated).toBe(0);
			expect(mockWriteFile).not.toHaveBeenCalled();
		});

		it('should keep stale nextRunAt for missed first run (lastRunAt=null, nextRunAt in past)', async () => {
			// Simulate: cron job was created for 08:45 Beijing but backend wasn't running.
			// On restart at 08:48, nextRunAt is in the past and lastRunAt is null.
			// The fix: keep stale nextRunAt so evaluateTasks() fires it immediately.
			const pastTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago
			const store = {
				tasks: [{
					id: 'cron-missed', cronExpression: '45 8 * * *', timezone: 'Asia/Shanghai',
					targetAgent: 'eve', targetTeamId: 't1', taskDescription: 'Morning report',
					enabled: true, lastRunAt: null,
					nextRunAt: pastTime, // in the past — missed first run
					createdBy: 'user' as const, createdAt: '2026-01-01',
				}],
			};
			mockReadFile.mockResolvedValueOnce(JSON.stringify(store));

			const updated = await service.recalculateAllNextRunTimes();

			// Should NOT update — keeps stale nextRunAt for immediate execution
			expect(updated).toBe(0);
			expect(mockWriteFile).not.toHaveBeenCalled();
		});

		it('should use lastRunAt as the after parameter when available', async () => {
			const lastRun = '2026-03-23T01:00:00.000Z';
			const store = {
				tasks: [{
					id: 'cron-1', cronExpression: '0 9 * * *', timezone: 'Asia/Shanghai',
					enabled: true, lastRunAt: lastRun,
					nextRunAt: '2026-03-23T09:00:00.000Z', // stale
					targetAgent: 'a1', targetTeamId: 't1', taskDescription: 'X',
					createdBy: 'user' as const, createdAt: '2026-01-01',
				}],
			};
			mockReadFile.mockResolvedValueOnce(JSON.stringify(store));

			const updated = await service.recalculateAllNextRunTimes();

			expect(updated).toBe(1);
			const saved = JSON.parse(mockWriteFile.mock.calls[0][1]);
			const newNextRun = new Date(saved.tasks[0].nextRunAt);
			// After 2026-03-23T01:00:00Z, next 09:00 Shanghai = 2026-03-24T01:00:00Z
			expect(newNextRun.getUTCHours()).toBe(1);
		});
	});

	describe('start / stop', () => {
		it('should start and stop the evaluation loop', () => {
			service.start();
			expect(service.isRunning()).toBe(true);

			service.stop();
			expect(service.isRunning()).toBe(false);
		});

		it('should not start twice', () => {
			service.start();
			service.start(); // no-op
			expect(service.isRunning()).toBe(true);

			service.stop();
		});
	});
});
