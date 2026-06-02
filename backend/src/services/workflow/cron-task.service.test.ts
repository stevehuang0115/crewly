/**
 * Tests for CronTaskService with per-team scoped storage.
 *
 * @module services/workflow/cron-task.service.test
 */

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
	readdir: jest.fn(),
	rename: jest.fn().mockResolvedValue(undefined),
}));

// Mock fs (sync)
jest.mock('fs', () => ({
	existsSync: jest.fn().mockReturnValue(false),
}));

import { readFile, writeFile, readdir, rename } from 'fs/promises';
import { existsSync } from 'fs';

const mockReadFile = jest.mocked(readFile);
const mockWriteFile = jest.mocked(writeFile);
const mockReaddir = jest.mocked(readdir);
const mockExistsSync = jest.mocked(existsSync);
const mockRename = jest.mocked(rename);

/**
 * Helper: set up mockReaddir to return team directories.
 * Also sets existsSync to return true for cron-tasks.json in those teams.
 */
function setupTeamDirs(teamIds: string[]): void {
	mockReaddir.mockResolvedValue(
		teamIds.map(id => ({ name: id, isDirectory: () => true } as any)),
	);
	mockExistsSync.mockImplementation((filePath: any) => {
		const p = String(filePath);
		// Return true for cron-tasks.json inside any of the specified teams
		for (const tid of teamIds) {
			if (p.includes(`/teams/${tid}/cron-tasks.json`)) return true;
		}
		return false;
	});
}

/**
 * Helper: set up mockReadFile to return a store for a specific team path.
 */
function setupTeamStore(teamId: string, tasks: Partial<CronTask>[]): void {
	const storePath = `/tmp/test-crewly/teams/${teamId}/cron-tasks.json`;
	mockReadFile.mockImplementation(async (path: any) => {
		if (String(path) === storePath) {
			return JSON.stringify({ tasks });
		}
		throw new Error('ENOENT');
	});
}

describe('CronTaskService', () => {
	let service: CronTaskService;

	beforeEach(() => {
		jest.clearAllMocks();
		CronTaskService.resetInstance();
		service = new CronTaskService('/tmp/test-crewly');
		mockReadFile.mockRejectedValue(new Error('ENOENT'));
		mockReaddir.mockResolvedValue([]);
		mockExistsSync.mockReturnValue(false);
	});

	afterEach(() => {
		service.stop();
	});

	// ===== Pure function tests (unchanged) =====

	describe('parseCronField', () => {
		it('should return null for wildcard', () => {
			expect(parseCronField('*', 0, 59)).toBeNull();
		});

		it('should parse single number', () => {
			expect(parseCronField('5', 0, 59)).toEqual(new Set([5]));
		});

		it('should parse range (1-5)', () => {
			expect(parseCronField('1-5', 0, 6)).toEqual(new Set([1, 2, 3, 4, 5]));
		});

		it('should parse list (1,3,5)', () => {
			expect(parseCronField('1,3,5', 0, 6)).toEqual(new Set([1, 3, 5]));
		});

		it('should parse step values (*/15)', () => {
			expect(parseCronField('*/15', 0, 59)).toEqual(new Set([0, 15, 30, 45]));
		});

		it('should parse range with step (10-30/5)', () => {
			expect(parseCronField('10-30/5', 0, 59)).toEqual(new Set([10, 15, 20, 25, 30]));
		});
	});

	describe('getNextRunTime', () => {
		it('should calculate next run for daily cron', () => {
			const result = getNextRunTime('0 9 * * *', 'UTC', new Date('2026-03-20T08:00:00Z'));
			expect(new Date(result).getUTCHours()).toBe(9);
		});

		it('should throw for invalid cron expression', () => {
			expect(() => getNextRunTime('invalid', 'UTC')).toThrow('Invalid cron expression');
		});

		it('should use timezone for field matching (Asia/Shanghai = UTC+8)', () => {
			const result = getNextRunTime('0 9 * * *', 'Asia/Shanghai', new Date('2026-03-20T00:00:00Z'));
			expect(new Date(result).toISOString()).toBe('2026-03-20T01:00:00.000Z');
		});

		// #678 fire-time hardening: a bad/empty timezone must NOT throw (it would
		// crash the whole evaluateTasks tick and stall every cron) — it falls
		// back to UTC and still computes a real schedule-aligned time.
		it('does NOT throw on an invalid timezone — falls back to UTC', () => {
			const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
			const result = getNextRunTime('0 9 * * *', 'Not/AZone', new Date('2026-03-20T08:00:00Z'));
			expect(new Date(result).getUTCHours()).toBe(9); // UTC-aligned, not drifted
			warn.mockRestore();
		});

		it('treats empty timezone as UTC', () => {
			const result = getNextRunTime('0 9 * * *', '', new Date('2026-03-20T08:00:00Z'));
			expect(new Date(result).getUTCHours()).toBe(9);
		});

		it('matches a midnight cron (0 0 * * *) instead of drifting', () => {
			const result = getNextRunTime('0 0 * * *', 'UTC', new Date('2026-03-20T08:00:00Z'));
			const d = new Date(result);
			expect(d.getUTCHours()).toBe(0);
			expect(d.getUTCMinutes()).toBe(0);
			expect(d.getUTCDate()).toBe(21); // next midnight, properly aligned
		});

		it('alerts (does not silently drift) on an impossible expression (Feb 31)', () => {
			const err = jest.spyOn(console, 'error').mockImplementation(() => {});
			const after = new Date('2026-03-20T08:00:00Z');
			const result = getNextRunTime('0 0 31 2 *', 'UTC', after);
			expect(err).toHaveBeenCalled(); // loud alert, no silent drift
			// Returns a value (eval loop never throws) — the now+24h fallback.
			expect(new Date(result).getTime()).toBe(after.getTime() + 24 * 60 * 60 * 1000);
			err.mockRestore();
		});
	});

	describe('getDatePartsInTimezone', () => {
		it('should return UTC parts for UTC timezone', () => {
			const parts = getDatePartsInTimezone(new Date('2026-03-20T14:30:00Z'), 'UTC');
			expect(parts.hour).toBe(14);
			expect(parts.minute).toBe(30);
		});

		it('should return Shanghai parts (UTC+8)', () => {
			const parts = getDatePartsInTimezone(new Date('2026-03-20T14:30:00Z'), 'Asia/Shanghai');
			expect(parts.hour).toBe(22);
		});
	});

	// ===== Per-team storage tests =====

	describe('getStoreFile', () => {
		it('should return team-specific path', () => {
			const file = service.getStoreFile('team-abc');
			expect(file).toBe('/tmp/test-crewly/teams/team-abc/cron-tasks.json');
		});
	});

	describe('create', () => {
		it('should create a task and save to team-specific file', async () => {
			const task = await service.create({
				cronExpression: '0 9 * * *',
				timezone: 'UTC',
				targetAgent: 'agent-1',
				targetTeamId: 'team-alpha',
				taskDescription: 'Daily report',
			});

			expect(task.id).toMatch(/^cron-/);
			expect(task.targetTeamId).toBe('team-alpha');
			expect(task.enabled).toBe(true);

			// Should write to team-specific path
			expect(mockWriteFile).toHaveBeenCalledWith(
				'/tmp/test-crewly/teams/team-alpha/cron-tasks.json',
				expect.any(String),
				'utf-8',
			);
		});
	});

	describe('list (aggregated across teams)', () => {
		it('should return tasks from all teams', async () => {
			setupTeamDirs(['team-a', 'team-b']);

			mockReadFile.mockImplementation(async (path: any) => {
				const p = String(path);
				if (p.includes('team-a')) return JSON.stringify({ tasks: [{ id: 'cron-1', targetAgent: 'a1', targetTeamId: 'team-a', enabled: true }] });
				if (p.includes('team-b')) return JSON.stringify({ tasks: [{ id: 'cron-2', targetAgent: 'a2', targetTeamId: 'team-b', enabled: true }] });
				throw new Error('ENOENT');
			});

			const tasks = await service.list();
			expect(tasks).toHaveLength(2);
			expect(tasks.map(t => t.id).sort()).toEqual(['cron-1', 'cron-2']);
		});

		it('should filter by targetAgent across teams', async () => {
			setupTeamDirs(['team-a', 'team-b']);

			mockReadFile.mockImplementation(async (path: any) => {
				const p = String(path);
				if (p.includes('team-a')) return JSON.stringify({ tasks: [{ id: 'cron-1', targetAgent: 'a1', targetTeamId: 'team-a', enabled: true }] });
				if (p.includes('team-b')) return JSON.stringify({ tasks: [{ id: 'cron-2', targetAgent: 'a2', targetTeamId: 'team-b', enabled: true }] });
				throw new Error('ENOENT');
			});

			const tasks = await service.list({ targetAgent: 'a1' });
			expect(tasks).toHaveLength(1);
			expect(tasks[0].id).toBe('cron-1');
		});
	});

	describe('getByTeam', () => {
		it('should return tasks for a specific team only', async () => {
			mockReadFile.mockImplementation(async (path: any) => {
				if (String(path).includes('team-a')) {
					return JSON.stringify({ tasks: [
						{ id: 'cron-1', targetAgent: 'a1', targetTeamId: 'team-a', enabled: true },
						{ id: 'cron-2', targetAgent: 'a2', targetTeamId: 'team-a', enabled: false },
					] });
				}
				throw new Error('ENOENT');
			});

			const tasks = await service.getByTeam('team-a');
			expect(tasks).toHaveLength(2);
		});

		it('should apply filters', async () => {
			mockReadFile.mockImplementation(async (path: any) => {
				if (String(path).includes('team-a')) {
					return JSON.stringify({ tasks: [
						{ id: 'cron-1', targetAgent: 'a1', targetTeamId: 'team-a', enabled: true },
						{ id: 'cron-2', targetAgent: 'a2', targetTeamId: 'team-a', enabled: false },
					] });
				}
				throw new Error('ENOENT');
			});

			const tasks = await service.getByTeam('team-a', { enabled: true });
			expect(tasks).toHaveLength(1);
			expect(tasks[0].id).toBe('cron-1');
		});

		it('should return empty array for unknown team', async () => {
			const tasks = await service.getByTeam('team-unknown');
			expect(tasks).toHaveLength(0);
		});
	});

	describe('delete (searches across teams)', () => {
		it('should find and delete task from correct team file', async () => {
			setupTeamDirs(['team-a', 'team-b']);

			mockReadFile.mockImplementation(async (path: any) => {
				const p = String(path);
				if (p.includes('team-a')) return JSON.stringify({ tasks: [{ id: 'cron-1', targetTeamId: 'team-a' }] });
				if (p.includes('team-b')) return JSON.stringify({ tasks: [{ id: 'cron-2', targetTeamId: 'team-b' }, { id: 'cron-3', targetTeamId: 'team-b' }] });
				throw new Error('ENOENT');
			});

			const deleted = await service.delete('cron-2');
			expect(deleted).toBe(true);

			// Should write to team-b's file with cron-2 removed
			const writeCall = mockWriteFile.mock.calls.find(c => String(c[0]).includes('team-b'));
			expect(writeCall).toBeDefined();
			const saved = JSON.parse(writeCall![1] as string);
			expect(saved.tasks).toHaveLength(1);
			expect(saved.tasks[0].id).toBe('cron-3');
		});

		it('should return false for unknown ID', async () => {
			setupTeamDirs(['team-a']);
			mockReadFile.mockResolvedValue(JSON.stringify({ tasks: [] }));

			const deleted = await service.delete('cron-unknown');
			expect(deleted).toBe(false);
		});
	});

	describe('update (searches across teams)', () => {
		it('should find and update task in correct team file', async () => {
			setupTeamDirs(['team-a']);

			mockReadFile.mockImplementation(async (path: any) => {
				if (String(path).includes('team-a')) {
					return JSON.stringify({ tasks: [{
						id: 'cron-1', cronExpression: '0 9 * * *', timezone: 'UTC',
						targetAgent: 'a1', targetTeamId: 'team-a', taskDescription: 'Old',
						enabled: true, nextRunAt: null, lastRunAt: null,
						createdBy: 'user', createdAt: '2026-01-01',
					}] });
				}
				throw new Error('ENOENT');
			});

			const updated = await service.update('cron-1', { taskDescription: 'New' });
			expect(updated?.taskDescription).toBe('New');
		});

		it('should return null for unknown ID', async () => {
			setupTeamDirs([]);
			const result = await service.update('cron-unknown', { taskDescription: 'test' });
			expect(result).toBeNull();
		});
	});

	describe('evaluateTasks (per-team)', () => {
		it('should evaluate tasks across all teams', async () => {
			const executedTasks: CronTask[] = [];
			service.setExecutionCallback(async (task) => { executedTasks.push(task); });

			setupTeamDirs(['team-a']);
			const pastTime = new Date(Date.now() - 60000).toISOString();

			mockReadFile.mockImplementation(async (path: any) => {
				if (String(path).includes('team-a')) {
					return JSON.stringify({ tasks: [{
						id: 'cron-1', cronExpression: '0 9 * * *', timezone: 'UTC',
						targetAgent: 'a1', targetTeamId: 'team-a', taskDescription: 'Run',
						enabled: true, lastRunAt: null, nextRunAt: pastTime,
						createdBy: 'user', createdAt: '2026-01-01',
					}] });
				}
				throw new Error('ENOENT');
			});

			await service.evaluateTasks();

			expect(executedTasks).toHaveLength(1);
			expect(executedTasks[0].id).toBe('cron-1');

			// Should save to team-a's file
			const writeCall = mockWriteFile.mock.calls.find(c => String(c[0]).includes('team-a'));
			expect(writeCall).toBeDefined();
		});

		it('should skip disabled tasks', async () => {
			const executedTasks: CronTask[] = [];
			service.setExecutionCallback(async (task) => { executedTasks.push(task); });

			setupTeamDirs(['team-a']);
			const pastTime = new Date(Date.now() - 60000).toISOString();

			mockReadFile.mockResolvedValue(JSON.stringify({ tasks: [{
				id: 'cron-1', cronExpression: '0 9 * * *', timezone: 'UTC',
				targetAgent: 'a1', targetTeamId: 'team-a', taskDescription: 'Run',
				enabled: false, nextRunAt: pastTime,
				createdBy: 'user', createdAt: '2026-01-01', lastRunAt: null,
			}] }));

			await service.evaluateTasks();
			expect(executedTasks).toHaveLength(0);
		});

		// #678 gate: the composition root no longer wires agentStatusCallback /
		// agentStartCallback — cron now ALWAYS executes (enqueues a WorkItem) and
		// the task pool owns offline delivery + recovery. Guard that a due task
		// fires regardless of agent liveness when no status callback is set.
		it('executes a due task with NO agent-status callback (always enqueues — #678)', async () => {
			const executedTasks: CronTask[] = [];
			service.setExecutionCallback(async (task) => { executedTasks.push(task); });
			// intentionally NO setAgentStatusCallback / setAgentStartCallback

			setupTeamDirs(['team-a']);
			const pastTime = new Date(Date.now() - 60000).toISOString();
			mockReadFile.mockImplementation(async (path: any) => {
				if (String(path).includes('team-a')) {
					return JSON.stringify({ tasks: [{
						id: 'cron-always-1', cronExpression: '0 9 * * *', timezone: 'UTC',
						targetAgent: 'offline-agent', targetTeamId: 'team-a', taskDescription: 'Run',
						enabled: true, lastRunAt: null, nextRunAt: pastTime,
						createdBy: 'user', createdAt: '2026-01-01',
					}] });
				}
				throw new Error('ENOENT');
			});

			await service.evaluateTasks();
			expect(executedTasks).toHaveLength(1);
			expect(executedTasks[0].id).toBe('cron-always-1');
		});

		// Issue #305 regression gate: an offline agent that auto-start
		// successfully wakes up must be allowed to receive the cron task
		// once it reports ready. Previously the executionCallback fired
		// immediately after the start callback returned, before the agent
		// had fully booted, and the message was lost.
		it('waits for agent to become ready after auto-start before executing', async () => {
			const executedTasks: CronTask[] = [];
			service.setExecutionCallback(async (task) => { executedTasks.push(task); });

			// Agent starts offline, then becomes online on the 2nd status check.
			let statusCheckCount = 0;
			service.setAgentStatusCallback(async () => {
				statusCheckCount++;
				return statusCheckCount >= 2;
			});
			let startCalled = false;
			service.setAgentStartCallback(async () => {
				startCalled = true;
				return true;
			});

			setupTeamDirs(['team-a']);
			const pastTime = new Date(Date.now() - 60000).toISOString();
			mockReadFile.mockImplementation(async (path: any) => {
				if (String(path).includes('team-a')) {
					return JSON.stringify({ tasks: [{
						id: 'cron-readiness-1', cronExpression: '0 9 * * *', timezone: 'UTC',
						targetAgent: 'a1', targetTeamId: 'team-a', taskDescription: 'Run',
						enabled: true, lastRunAt: null, nextRunAt: pastTime,
						createdBy: 'user', createdAt: '2026-01-01',
					}] });
				}
				throw new Error('ENOENT');
			});

			await service.evaluateTasks();

			expect(startCalled).toBe(true);
			expect(executedTasks).toHaveLength(1);
			expect(executedTasks[0].id).toBe('cron-readiness-1');
		});

		// Issue #305: when the agent never reports ready within the wait
		// window, the task must be skipped with `lastSkippedAt` set and
		// a `lastSkipReason` distinguishable from "never ran" — not
		// silently dropped.
		//
		// Updated 2026-05-28 (#611): a single readiness failure is now a
		// TRANSIENT skip — `nextRunAt` is pushed forward and the slot
		// retries up to 3x. Only after the budget is exhausted does the
		// task receive the permanent `agent_offline_retries_exhausted`
		// skip mark. This test now seeds `transientSkipAttempts: 2` so
		// the next failure IS the third attempt, exercising the
		// permanent-skip path.
		it('skips with lastSkipReason="agent_offline_retries_exhausted" after the 3rd transient failure', async () => {
			const executedTasks: CronTask[] = [];
			service.setExecutionCallback(async (task) => { executedTasks.push(task); });

			// Agent never reports ready, status callback always returns false.
			service.setAgentStatusCallback(async () => false);
			service.setAgentStartCallback(async () => true); // kicks off, never becomes ready

			setupTeamDirs(['team-a']);
			const pastTime = new Date(Date.now() - 60000).toISOString();
			mockReadFile.mockImplementation(async (path: any) => {
				if (String(path).includes('team-a')) {
					return JSON.stringify({ tasks: [{
						id: 'cron-stuck-1', cronExpression: '0 9 * * *', timezone: 'UTC',
						targetAgent: 'a1', targetTeamId: 'team-a', taskDescription: 'Run',
						enabled: true, lastRunAt: null, nextRunAt: pastTime,
						createdBy: 'user', createdAt: '2026-01-01',
						// Seed the retry counter so THIS failure is the
						// budget-exhausting third attempt.
						transientSkipAttempts: 2,
					}] });
				}
				throw new Error('ENOENT');
			});

			// Patch the timeout to keep the test fast — the real value is 15s.
			// We rely on the readiness poll loop honoring the deadline; reducing
			// it via a module-level patch isn't necessary because the test
			// already exits via the polling loop with status=false repeatedly
			// until deadline. To keep this test fast, mock setTimeout to no-op
			// the inter-poll delay and override Date.now to fast-forward.
			const realNow = Date.now;
			let fakeNow = realNow();
			jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);
			const origSetTimeout = global.setTimeout;
			(global as any).setTimeout = (cb: () => void) => {
				fakeNow += 500; // each poll fast-forwards 500ms
				cb();
				return 0 as any;
			};

			try {
				await service.evaluateTasks();
			} finally {
				(global as any).setTimeout = origSetTimeout;
				(Date.now as jest.Mock).mockRestore();
			}

			expect(executedTasks).toHaveLength(0);
			// Confirm the persisted task carries the skip reason.
			const writeCall = mockWriteFile.mock.calls.find(c => String(c[0]).includes('team-a'));
			expect(writeCall).toBeDefined();
			const written = JSON.parse(writeCall![1] as string);
			expect(written.tasks[0].lastSkippedAt).toBeTruthy();
			expect(written.tasks[0].lastSkipReason).toBe('agent_offline_retries_exhausted');
			expect(written.tasks[0].lastRunAt).toBeNull();
			// Counter resets to 0 so the next slot starts with a fresh budget.
			expect(written.tasks[0].transientSkipAttempts).toBe(0);
		});

		// #611 — first attempt at agent_offline_not_ready: TRANSIENT skip.
		// nextRunAt is pushed forward by the linear backoff and the slot
		// will retry. `lastSkippedAt` / `lastSkipReason` must NOT be set
		// because nothing has been permanently skipped yet.
		it('first agent_offline_not_ready is TRANSIENT — pushes nextRunAt, bumps transientSkipAttempts, no lastSkip mutation (#611)', async () => {
			const executedTasks: CronTask[] = [];
			service.setExecutionCallback(async (task) => { executedTasks.push(task); });
			service.setAgentStatusCallback(async () => false);
			service.setAgentStartCallback(async () => true);

			setupTeamDirs(['team-a']);
			const pastTime = new Date(Date.now() - 60000).toISOString();
			const originalNextRun = pastTime;
			mockReadFile.mockImplementation(async (path: any) => {
				if (String(path).includes('team-a')) {
					return JSON.stringify({ tasks: [{
						id: 'cron-retry-1', cronExpression: '0 9 * * *', timezone: 'UTC',
						targetAgent: 'a1', targetTeamId: 'team-a', taskDescription: 'Run',
						enabled: true, lastRunAt: null, nextRunAt: originalNextRun,
						createdBy: 'user', createdAt: '2026-01-01',
					}] });
				}
				throw new Error('ENOENT');
			});

			const realNow = Date.now;
			let fakeNow = realNow();
			jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);
			const origSetTimeout = global.setTimeout;
			(global as any).setTimeout = (cb: () => void) => {
				fakeNow += 500;
				cb();
				return 0 as any;
			};

			try {
				await service.evaluateTasks();
			} finally {
				(global as any).setTimeout = origSetTimeout;
				(Date.now as jest.Mock).mockRestore();
			}

			expect(executedTasks).toHaveLength(0);
			const writeCall = mockWriteFile.mock.calls.find(c => String(c[0]).includes('team-a'));
			expect(writeCall).toBeDefined();
			const written = JSON.parse(writeCall![1] as string);
			expect(written.tasks[0].transientSkipAttempts).toBe(1);
			// Critical: NO permanent-skip mutation on the first attempt.
			expect(written.tasks[0].lastSkippedAt).toBeFalsy();
			expect(written.tasks[0].lastSkipReason).toBeFalsy();
			expect(written.tasks[0].lastRunAt).toBeNull();
			// nextRunAt moved forward (transient retry) — NOT back to the
			// original past time. We don't assert exact ms since clocks
			// drift, but it must be in the future relative to pastTime.
			expect(new Date(written.tasks[0].nextRunAt).getTime()).toBeGreaterThan(
				new Date(originalNextRun).getTime(),
			);
		});

		// #611 — counter resets on successful execution so the next slot
		// starts with a fresh retry budget. Without this reset, a string
		// of bad-luck runs would chain attempt-counts across firings.
		it('resets transientSkipAttempts to 0 after a successful execution (#611)', async () => {
			const executedTasks: CronTask[] = [];
			service.setExecutionCallback(async (task) => { executedTasks.push(task); });
			service.setAgentStatusCallback(async () => true); // agent IS online

			setupTeamDirs(['team-a']);
			const pastTime = new Date(Date.now() - 60000).toISOString();
			mockReadFile.mockImplementation(async (path: any) => {
				if (String(path).includes('team-a')) {
					return JSON.stringify({ tasks: [{
						id: 'cron-ran-1', cronExpression: '0 9 * * *', timezone: 'UTC',
						targetAgent: 'a1', targetTeamId: 'team-a', taskDescription: 'Run',
						enabled: true, lastRunAt: null, nextRunAt: pastTime,
						createdBy: 'user', createdAt: '2026-01-01',
						// Seed a non-zero counter — must end at 0 after the run.
						transientSkipAttempts: 2,
					}] });
				}
				throw new Error('ENOENT');
			});

			await service.evaluateTasks();

			expect(executedTasks).toHaveLength(1);
			const writeCall = mockWriteFile.mock.calls.find(c => String(c[0]).includes('team-a'));
			expect(writeCall).toBeDefined();
			const written = JSON.parse(writeCall![1] as string);
			expect(written.tasks[0].lastRunAt).toBeTruthy();
			expect(written.tasks[0].transientSkipAttempts).toBe(0);
		});

		// #611 — non-transient skip reasons (no callback wired) MUST go
		// straight to permanent skip with no retry-counter bump. We don't
		// want to delay "you literally cannot start this agent" with a
		// retry budget that will exhaust to the same outcome.
		it('agent_offline_no_callback is NOT a transient skip — permanent immediately (#611)', async () => {
			const executedTasks: CronTask[] = [];
			service.setExecutionCallback(async (task) => { executedTasks.push(task); });
			service.setAgentStatusCallback(async () => false);
			// Deliberately NO setAgentStartCallback → triggers agent_offline_no_callback.

			setupTeamDirs(['team-a']);
			const pastTime = new Date(Date.now() - 60000).toISOString();
			mockReadFile.mockImplementation(async (path: any) => {
				if (String(path).includes('team-a')) {
					return JSON.stringify({ tasks: [{
						id: 'cron-nocb-1', cronExpression: '0 9 * * *', timezone: 'UTC',
						targetAgent: 'a1', targetTeamId: 'team-a', taskDescription: 'Run',
						enabled: true, lastRunAt: null, nextRunAt: pastTime,
						createdBy: 'user', createdAt: '2026-01-01',
					}] });
				}
				throw new Error('ENOENT');
			});

			await service.evaluateTasks();

			expect(executedTasks).toHaveLength(0);
			const writeCall = mockWriteFile.mock.calls.find(c => String(c[0]).includes('team-a'));
			expect(writeCall).toBeDefined();
			const written = JSON.parse(writeCall![1] as string);
			expect(written.tasks[0].lastSkipReason).toBe('agent_offline_no_callback');
			expect(written.tasks[0].lastSkippedAt).toBeTruthy();
			// No transient-retry pathway means no counter bump.
			expect(written.tasks[0].transientSkipAttempts ?? 0).toBe(0);
		});
	});

	describe('migrateGlobalToTeamScoped', () => {
		/** Helper: set up existsSync so global file exists but .migrated does not */
		function setupGlobalExists(): void {
			mockExistsSync.mockImplementation((p: any) => {
				const s = String(p);
				if (s.endsWith('.migrated')) return false;
				if (s.endsWith('cron-tasks.json') && !s.includes('teams')) return true;
				return false;
			});
		}

		it('should skip if global file does not exist', async () => {
			mockExistsSync.mockReturnValue(false);

			const count = await service.migrateGlobalToTeamScoped();
			expect(count).toBe(0);
		});

		it('should skip if .migrated file already exists', async () => {
			mockExistsSync.mockImplementation((p: any) => {
				return String(p).endsWith('.migrated');
			});

			const count = await service.migrateGlobalToTeamScoped();
			expect(count).toBe(0);
		});

		it('should migrate team tasks but keep orchestrator tasks in global', async () => {
			setupGlobalExists();

			const globalStore = {
				tasks: [
					{ id: 'cron-1', targetTeamId: 'team-a', targetAgent: 'a1' },
					{ id: 'cron-2', targetTeamId: 'orchestrator', targetAgent: 'crewly-orc' },
					{ id: 'cron-3', targetTeamId: 'team-a', targetAgent: 'a2' },
					{ id: 'cron-4', targetTeamId: 'team-b', targetAgent: 'b1' },
				],
			};

			mockReadFile.mockImplementation(async (path: any) => {
				const p = String(path);
				if (p === '/tmp/test-crewly/cron-tasks.json') return JSON.stringify(globalStore);
				throw new Error('ENOENT');
			});

			const count = await service.migrateGlobalToTeamScoped();

			// Only team tasks are counted as migrated (3), not orchestrator (1)
			expect(count).toBe(3);

			// team-a should have 2 tasks
			const teamAWrite = mockWriteFile.mock.calls.find(c => String(c[0]).includes('team-a'));
			expect(teamAWrite).toBeDefined();
			expect(JSON.parse(teamAWrite![1] as string).tasks).toHaveLength(2);

			// team-b should have 1 task
			const teamBWrite = mockWriteFile.mock.calls.find(c => String(c[0]).includes('team-b'));
			expect(teamBWrite).toBeDefined();
			expect(JSON.parse(teamBWrite![1] as string).tasks).toHaveLength(1);

			// Global file should be rewritten with only orchestrator task
			const globalWrite = mockWriteFile.mock.calls.find(c =>
				String(c[0]) === '/tmp/test-crewly/cron-tasks.json',
			);
			expect(globalWrite).toBeDefined();
			const globalTasks = JSON.parse(globalWrite![1] as string).tasks;
			expect(globalTasks).toHaveLength(1);
			expect(globalTasks[0].id).toBe('cron-2');
			expect(globalTasks[0].targetTeamId).toBe('orchestrator');
		});

		it('should create .migrated marker file', async () => {
			setupGlobalExists();
			mockReadFile.mockImplementation(async (path: any) => {
				if (String(path) === '/tmp/test-crewly/cron-tasks.json') {
					return JSON.stringify({ tasks: [{ id: 'cron-1', targetTeamId: 'team-a', targetAgent: 'a1' }] });
				}
				throw new Error('ENOENT');
			});

			await service.migrateGlobalToTeamScoped();

			// Should write .migrated marker
			const markerWrite = mockWriteFile.mock.calls.find(c =>
				String(c[0]).endsWith('.migrated'),
			);
			expect(markerWrite).toBeDefined();
		});

		it('should not duplicate tasks that already exist in team file', async () => {
			setupGlobalExists();

			mockReadFile.mockImplementation(async (path: any) => {
				const p = String(path);
				if (p === '/tmp/test-crewly/cron-tasks.json') return JSON.stringify({ tasks: [{ id: 'cron-1', targetTeamId: 'team-a', targetAgent: 'a1' }] });
				if (p.includes('team-a')) return JSON.stringify({ tasks: [{ id: 'cron-1', targetTeamId: 'team-a', targetAgent: 'a1' }] });
				throw new Error('ENOENT');
			});

			await service.migrateGlobalToTeamScoped();

			const teamAWrite = mockWriteFile.mock.calls.find(c => String(c[0]).includes('team-a'));
			expect(JSON.parse(teamAWrite![1] as string).tasks).toHaveLength(1);
		});

		it('should handle all-orchestrator tasks (nothing migrated, all kept in global)', async () => {
			setupGlobalExists();
			mockReadFile.mockImplementation(async (path: any) => {
				if (String(path) === '/tmp/test-crewly/cron-tasks.json') {
					return JSON.stringify({ tasks: [
						{ id: 'cron-1', targetTeamId: 'orchestrator', targetAgent: 'crewly-orc' },
						{ id: 'cron-2', targetTeamId: 'orchestrator', targetAgent: 'crewly-orc' },
					] });
				}
				throw new Error('ENOENT');
			});

			const count = await service.migrateGlobalToTeamScoped();
			expect(count).toBe(0);

			// Global file should still have both orchestrator tasks
			const globalWrite = mockWriteFile.mock.calls.find(c =>
				String(c[0]) === '/tmp/test-crewly/cron-tasks.json',
			);
			expect(globalWrite).toBeDefined();
			expect(JSON.parse(globalWrite![1] as string).tasks).toHaveLength(2);
		});
	});

	describe('orchestrator tasks in global store', () => {
		it('should save orchestrator-targeted tasks to global file', async () => {
			await service.create({
				cronExpression: '0 9 * * *',
				targetAgent: 'crewly-orc',
				targetTeamId: 'orchestrator',
				taskDescription: 'Daily health check',
			});

			// Should write to global file, not a team file
			const globalWrite = mockWriteFile.mock.calls.find(c =>
				String(c[0]) === '/tmp/test-crewly/cron-tasks.json',
			);
			expect(globalWrite).toBeDefined();

			const teamWrite = mockWriteFile.mock.calls.find(c =>
				String(c[0]).includes('/teams/'),
			);
			expect(teamWrite).toBeUndefined();
		});

		it('should include global orchestrator tasks in list()', async () => {
			setupTeamDirs(['team-a']);

			mockReadFile.mockImplementation(async (path: any) => {
				const p = String(path);
				if (p === '/tmp/test-crewly/cron-tasks.json') {
					return JSON.stringify({ tasks: [{ id: 'cron-orc', targetAgent: 'crewly-orc', targetTeamId: 'orchestrator', enabled: true }] });
				}
				if (p.includes('team-a')) {
					return JSON.stringify({ tasks: [{ id: 'cron-team', targetAgent: 'a1', targetTeamId: 'team-a', enabled: true }] });
				}
				throw new Error('ENOENT');
			});

			const tasks = await service.list();
			expect(tasks).toHaveLength(2);
			expect(tasks.map(t => t.id).sort()).toEqual(['cron-orc', 'cron-team']);
		});

		it('should delete orchestrator tasks from global file', async () => {
			setupTeamDirs([]);

			mockReadFile.mockImplementation(async (path: any) => {
				if (String(path) === '/tmp/test-crewly/cron-tasks.json') {
					return JSON.stringify({ tasks: [
						{ id: 'cron-orc-1', targetTeamId: 'orchestrator' },
						{ id: 'cron-orc-2', targetTeamId: 'orchestrator' },
					] });
				}
				throw new Error('ENOENT');
			});

			const deleted = await service.delete('cron-orc-1');
			expect(deleted).toBe(true);

			const globalWrite = mockWriteFile.mock.calls.find(c =>
				String(c[0]) === '/tmp/test-crewly/cron-tasks.json',
			);
			expect(globalWrite).toBeDefined();
			const remaining = JSON.parse(globalWrite![1] as string).tasks;
			expect(remaining).toHaveLength(1);
			expect(remaining[0].id).toBe('cron-orc-2');
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
			service.start();
			expect(service.isRunning()).toBe(true);
			service.stop();
		});
	});
});
