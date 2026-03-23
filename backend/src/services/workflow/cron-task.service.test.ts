import { CronTaskService, getNextRunTime } from './cron-task.service.js';
import { CronTask } from '../../types/cron-task.types.js';

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

	describe('getNextRunTime', () => {
		it('should calculate next run for daily cron', () => {
			const result = getNextRunTime('0 9 * * *', 'UTC', new Date('2026-03-20T08:00:00Z'));
			expect(new Date(result).getUTCHours()).toBe(9);
			expect(new Date(result).getUTCMinutes()).toBe(0);
		});

		it('should calculate next run for hourly cron', () => {
			const result = getNextRunTime('30 * * * *', 'UTC', new Date('2026-03-20T08:00:00Z'));
			expect(new Date(result).getUTCMinutes()).toBe(30);
		});

		it('should throw for invalid cron expression', () => {
			expect(() => getNextRunTime('invalid', 'UTC')).toThrow('Invalid cron expression');
		});

		it('should advance past current time', () => {
			const now = new Date('2026-03-20T09:00:00Z');
			const result = getNextRunTime('0 9 * * *', 'UTC', now);
			expect(new Date(result).getTime()).toBeGreaterThan(now.getTime());
		});

		describe('timezone support (#268)', () => {
			it('should schedule 08:45 Asia/Shanghai correctly as ~00:45 UTC', () => {
				// "45 8 * * *" in Asia/Shanghai (UTC+8) should be 00:45 UTC
				const result = getNextRunTime('45 8 * * *', 'Asia/Shanghai', new Date('2026-03-22T16:00:00Z'));
				const nextRun = new Date(result);
				// 08:45 CST = 00:45 UTC. Since after is 16:00 UTC (00:00 CST next day),
				// should be next day 00:45 UTC
				expect(nextRun.getUTCHours()).toBe(0);
				expect(nextRun.getUTCMinutes()).toBe(45);
			});

			it('should differ from UTC result for non-UTC timezone', () => {
				const after = new Date('2026-03-20T00:00:00Z');
				const utcResult = getNextRunTime('0 9 * * *', 'UTC', after);
				const shanghaiResult = getNextRunTime('0 9 * * *', 'Asia/Shanghai', after);
				// 09:00 UTC = 17:00 CST vs 09:00 CST = 01:00 UTC — should be different
				expect(utcResult).not.toBe(shanghaiResult);
			});

			it('should handle UTC timezone the same as before', () => {
				const result = getNextRunTime('0 14 * * *', 'UTC', new Date('2026-03-20T10:00:00Z'));
				expect(new Date(result).getUTCHours()).toBe(14);
			});

			it('should handle America/New_York timezone', () => {
				// "0 9 * * *" in America/New_York (UTC-4 during DST)
				const result = getNextRunTime('0 9 * * *', 'America/New_York', new Date('2026-03-20T10:00:00Z'));
				const nextRun = new Date(result);
				// 09:00 EDT = 13:00 UTC
				expect(nextRun.getUTCHours()).toBe(13);
			});

			it('should handle day-of-week range with timezone', () => {
				// "45 8 * * 1-5" (weekdays only) in Asia/Shanghai
				// 2026-03-23 is Monday
				const after = new Date('2026-03-22T17:00:00Z'); // Sunday 01:00 CST
				const result = getNextRunTime('45 8 * * 1-5', 'Asia/Shanghai', after);
				const nextRun = new Date(result);
				// Should be Monday 08:45 CST = 00:45 UTC Monday
				expect(nextRun.getUTCMinutes()).toBe(45);
				expect(nextRun.getUTCHours()).toBe(0);
				expect(nextRun.getUTCDay()).toBe(1); // Monday in UTC
			});
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

			// Mock readFile to return what was written
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

			// Should not throw
			await service.evaluateTasks();

			// Should still update run times
			const saved = JSON.parse(mockWriteFile.mock.calls[mockWriteFile.mock.calls.length - 1][1]);
			expect(saved.tasks[0].lastRunAt).toBeTruthy();
		});

		describe('agent auto-start (#268)', () => {
			it('should auto-start offline agent before dispatching', async () => {
				const executedTasks: CronTask[] = [];
				const startedAgents: string[] = [];

				service.setExecutionCallback(async (task) => { executedTasks.push(task); });
				service.setAgentStatusCallback(async () => false); // agent offline
				service.setAgentStartCallback(async (session, _teamId) => {
					startedAgents.push(session);
					return true; // start succeeded
				});

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

				expect(startedAgents).toEqual(['a1']);
				expect(executedTasks.length).toBe(1);
			});

			it('should skip task if agent offline and auto-start fails', async () => {
				const executedTasks: CronTask[] = [];

				service.setExecutionCallback(async (task) => { executedTasks.push(task); });
				service.setAgentStatusCallback(async () => false);
				service.setAgentStartCallback(async () => false); // start failed

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

				// Task should NOT have been executed
				expect(executedTasks.length).toBe(0);

				// lastRunAt should remain null (task was not actually run)
				const saved = JSON.parse(mockWriteFile.mock.calls[mockWriteFile.mock.calls.length - 1][1]);
				expect(saved.tasks[0].lastRunAt).toBeNull();
				// nextRunAt should still be advanced (to avoid retry storm)
				expect(saved.tasks[0].nextRunAt).not.toBe(pastTime);
			});

			it('should skip task if agent offline and no start callback', async () => {
				const executedTasks: CronTask[] = [];

				service.setExecutionCallback(async (task) => { executedTasks.push(task); });
				service.setAgentStatusCallback(async () => false);
				// No agentStartCallback set

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

				expect(executedTasks.length).toBe(0);
			});

			it('should proceed normally when agent is already online', async () => {
				const executedTasks: CronTask[] = [];
				const startedAgents: string[] = [];

				service.setExecutionCallback(async (task) => { executedTasks.push(task); });
				service.setAgentStatusCallback(async () => true); // agent online
				service.setAgentStartCallback(async (s) => { startedAgents.push(s); return true; });

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

				// Should NOT have tried to auto-start
				expect(startedAgents.length).toBe(0);
				// Should have executed the task
				expect(executedTasks.length).toBe(1);
			});
		});
	});

	describe('recalculateAllNextRunTimes (#286)', () => {
		it('should recalculate nextRunAt for all enabled tasks', async () => {
			const staleNextRunAt = '2026-01-01T00:00:00.000Z';
			const store = {
				tasks: [
					{
						id: 'cron-1', cronExpression: '45 8 * * *', timezone: 'Asia/Shanghai',
						targetAgent: 'a1', targetTeamId: 't1', taskDescription: 'Daily report',
						enabled: true, lastRunAt: null, nextRunAt: staleNextRunAt,
						createdBy: 'user' as const, createdAt: '2026-01-01',
					},
					{
						id: 'cron-2', cronExpression: '0 9 * * *', timezone: 'UTC',
						targetAgent: 'a2', targetTeamId: 't2', taskDescription: 'Other task',
						enabled: true, lastRunAt: null, nextRunAt: staleNextRunAt,
						createdBy: 'user' as const, createdAt: '2026-01-01',
					},
				],
			};
			mockReadFile.mockResolvedValueOnce(JSON.stringify(store));

			const count = await service.recalculateAllNextRunTimes();

			expect(count).toBe(2);
			const saved = JSON.parse(mockWriteFile.mock.calls[mockWriteFile.mock.calls.length - 1][1]);
			// Both tasks should have updated nextRunAt values different from the stale one
			expect(saved.tasks[0].nextRunAt).not.toBe(staleNextRunAt);
			expect(saved.tasks[1].nextRunAt).not.toBe(staleNextRunAt);
		});

		it('should skip disabled tasks during recalculation', async () => {
			const staleNextRunAt = '2026-01-01T00:00:00.000Z';
			const store = {
				tasks: [
					{
						id: 'cron-1', cronExpression: '0 9 * * *', timezone: 'UTC',
						targetAgent: 'a1', targetTeamId: 't1', taskDescription: 'Task',
						enabled: false, lastRunAt: null, nextRunAt: staleNextRunAt,
						createdBy: 'user' as const, createdAt: '2026-01-01',
					},
				],
			};
			mockReadFile.mockResolvedValueOnce(JSON.stringify(store));

			const count = await service.recalculateAllNextRunTimes();

			expect(count).toBe(0);
			// Should not have written (no changes)
			expect(mockWriteFile).not.toHaveBeenCalled();
		});

		it('should not write if no tasks need recalculation', async () => {
			mockReadFile.mockResolvedValueOnce(JSON.stringify({ tasks: [] }));

			const count = await service.recalculateAllNextRunTimes();

			expect(count).toBe(0);
			expect(mockWriteFile).not.toHaveBeenCalled();
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
