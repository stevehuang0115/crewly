/**
 * Tests for the daily memory-consolidation scheduler.
 *
 * @module services/ai/self-improvement/consolidation-scheduler.service.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConsolidationSchedulerService } from './consolidation-scheduler.service.js';
import type { ConsolidationReport } from './memory-consolidation.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build an empty consolidation report fixture.
 *
 * @param memoriesAnalyzed - Number of memories to report
 * @returns Report
 */
function report(memoriesAnalyzed = 0): ConsolidationReport {
	return { patterns: [], insights: [], consolidatedAt: '2026-09-18T00:00:00.000Z', memoriesAnalyzed };
}

describe('ConsolidationSchedulerService', () => {
	let tmpDir: string;
	let statePath: string;
	let logger: { info: jest.Mock; warn: jest.Mock; debug: jest.Mock };

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-consol-'));
		statePath = path.join(tmpDir, 'nested', 'self-improvement-state.json');
		logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn() };
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
		ConsolidationSchedulerService.setInstance(null);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe('readState / isDue', () => {
		it('is due when no state file exists', () => {
			const s = new ConsolidationSchedulerService({
				consolidate: jest.fn(),
				listActiveSessions: jest.fn(async () => []),
				statePath,
				logger,
			});
			expect(s.readState()).toEqual({ lastConsolidationAt: null, lastConsolidatedSessions: [], lastErrors: {} });
			expect(s.isDue()).toBe(true);
		});

		it('is due when the state file is corrupt', () => {
			fs.mkdirSync(path.dirname(statePath), { recursive: true });
			fs.writeFileSync(statePath, '{not json');
			const s = new ConsolidationSchedulerService({
				consolidate: jest.fn(),
				listActiveSessions: jest.fn(async () => []),
				statePath,
				logger,
			});
			expect(s.isDue()).toBe(true);
		});

		it('is not due when the last sweep is younger than the interval, and due once older', () => {
			const fixedNow = Date.parse('2026-09-18T12:00:00.000Z');
			fs.mkdirSync(path.dirname(statePath), { recursive: true });
			fs.writeFileSync(
				statePath,
				JSON.stringify({ lastConsolidationAt: new Date(fixedNow - DAY_MS / 2).toISOString() })
			);
			const recent = new ConsolidationSchedulerService({
				consolidate: jest.fn(),
				listActiveSessions: jest.fn(async () => []),
				statePath,
				now: () => fixedNow,
				logger,
			});
			expect(recent.isDue()).toBe(false);

			fs.writeFileSync(
				statePath,
				JSON.stringify({ lastConsolidationAt: new Date(fixedNow - DAY_MS - 1).toISOString() })
			);
			expect(recent.isDue()).toBe(true);
		});
	});

	describe('runOnce', () => {
		it('consolidates every active session, de-duplicated, and persists state', async () => {
			const consolidate = jest.fn(async (s: string) => report(s === 'a' ? 3 : 0));
			const fixedNow = Date.parse('2026-09-18T12:00:00.000Z');
			const s = new ConsolidationSchedulerService({
				consolidate,
				listActiveSessions: jest.fn(async () => ['a', 'b', 'a']),
				statePath,
				now: () => fixedNow,
				logger,
			});

			const result = await s.runOnce();

			expect(consolidate).toHaveBeenCalledTimes(2);
			expect(result).toEqual({
				consolidated: ['a', 'b'],
				failed: {},
				finishedAt: '2026-09-18T12:00:00.000Z',
			});
			expect(JSON.parse(fs.readFileSync(statePath, 'utf-8'))).toEqual({
				lastConsolidationAt: '2026-09-18T12:00:00.000Z',
				lastConsolidatedSessions: ['a', 'b'],
				lastErrors: {},
			});
			expect(s.isDue()).toBe(false);
		});

		it('keeps going when one session fails and records the error', async () => {
			const consolidate = jest.fn(async (s: string) => {
				if (s === 'bad') throw new Error('unreadable memory');
				return report();
			});
			const s = new ConsolidationSchedulerService({
				consolidate,
				listActiveSessions: jest.fn(async () => ['good', 'bad', 'also-good']),
				statePath,
				logger,
			});

			const result = await s.runOnce();

			expect(result?.consolidated).toEqual(['good', 'also-good']);
			expect(result?.failed).toEqual({ bad: 'unreadable memory' });
			expect(s.readState().lastErrors).toEqual({ bad: 'unreadable memory' });
			expect(logger.info).toHaveBeenCalledWith(
				'Memory consolidation sweep finished',
				expect.objectContaining({ consolidated: 2, failed: 1 })
			);
		});

		it('survives a failing session lister (empty sweep, still stamps state)', async () => {
			const s = new ConsolidationSchedulerService({
				consolidate: jest.fn(),
				listActiveSessions: jest.fn(async () => {
					throw new Error('teams.json missing');
				}),
				statePath,
				logger,
			});
			const result = await s.runOnce();
			expect(result?.consolidated).toEqual([]);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('could not list active sessions'),
				expect.objectContaining({ error: 'teams.json missing' })
			);
			expect(fs.existsSync(statePath)).toBe(true);
		});

		it('refuses to overlap: a second runOnce while one is in flight returns null', async () => {
			let release: () => void = () => undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const s = new ConsolidationSchedulerService({
				consolidate: jest.fn(async () => {
					await gate;
					return report();
				}),
				listActiveSessions: jest.fn(async () => ['a']),
				statePath,
				logger,
			});
			const first = s.runOnce();
			// Let the first run reach the consolidate() await before the second call.
			await Promise.resolve();
			await Promise.resolve();
			expect(await s.runOnce()).toBeNull();
			release();
			expect((await first)?.consolidated).toEqual(['a']);
		});
	});

	describe('start / stop', () => {
		it('runs a boot catch-up after the boot delay when due, then on the interval', async () => {
			const consolidate = jest.fn(async () => report());
			const s = new ConsolidationSchedulerService({
				consolidate,
				listActiveSessions: jest.fn(async () => ['a']),
				statePath,
				intervalMs: 1000,
				bootDelayMs: 100,
				logger,
			});

			s.start();
			expect(consolidate).not.toHaveBeenCalled();

			await jest.advanceTimersByTimeAsync(100);
			expect(consolidate).toHaveBeenCalledTimes(1);

			await jest.advanceTimersByTimeAsync(1000);
			expect(consolidate).toHaveBeenCalledTimes(2);

			s.stop();
			await jest.advanceTimersByTimeAsync(5000);
			expect(consolidate).toHaveBeenCalledTimes(2);
		});

		it('skips the boot run when the last sweep is fresh', async () => {
			fs.mkdirSync(path.dirname(statePath), { recursive: true });
			fs.writeFileSync(statePath, JSON.stringify({ lastConsolidationAt: new Date().toISOString() }));
			const consolidate = jest.fn(async () => report());
			const s = new ConsolidationSchedulerService({
				consolidate,
				listActiveSessions: jest.fn(async () => ['a']),
				statePath,
				intervalMs: 1000,
				bootDelayMs: 0,
				logger,
			});
			s.start();
			await jest.advanceTimersByTimeAsync(10);
			expect(consolidate).not.toHaveBeenCalled();
			s.stop();
		});

		it('start is idempotent', () => {
			const s = new ConsolidationSchedulerService({
				consolidate: jest.fn(),
				listActiveSessions: jest.fn(async () => []),
				statePath,
				bootDelayMs: 0,
				logger,
			});
			s.start();
			s.start();
			expect(jest.getTimerCount()).toBe(2); // one boot timeout + one interval
			s.stop();
			expect(jest.getTimerCount()).toBe(0);
		});
	});

	describe('singleton slot', () => {
		it('registers and clears the process-wide instance', () => {
			const s = new ConsolidationSchedulerService({
				consolidate: jest.fn(),
				listActiveSessions: jest.fn(async () => []),
				statePath,
				logger,
			});
			expect(ConsolidationSchedulerService.getInstance()).toBeNull();
			ConsolidationSchedulerService.setInstance(s);
			expect(ConsolidationSchedulerService.getInstance()).toBe(s);
		});
	});
});
