/**
 * Tests for the process cleanup utility.
 *
 * Validates zombie process detection and cleanup via lsof and ps.
 *
 * @module cli/utils/process-cleanup.test
 */

const mockExecSync = jest.fn();

jest.mock('child_process', () => ({
	execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import { killZombieProcesses, selectOrphanedTestPids } from './process-cleanup.js';

describe('killZombieProcesses', () => {
	let killSpy: jest.SpyInstance;
	let logFn: jest.Mock;

	beforeEach(() => {
		jest.clearAllMocks();
		killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
		logFn = jest.fn();
	});

	afterEach(() => {
		killSpy.mockRestore();
	});

	it('should do nothing when no zombie processes exist', () => {
		// Both lsof and ps find nothing
		mockExecSync.mockImplementation((cmd: string) => {
			throw new Error('exit code 1');
		});

		killZombieProcesses(8787, logFn);

		// No kills should have been attempted
		expect(killSpy).not.toHaveBeenCalled();
		expect(logFn).not.toHaveBeenCalled();
	});

	it('should kill processes found holding the port via lsof', () => {
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes('lsof')) {
				return '12345\n67890\n';
			}
			if (cmd.includes('ps -eo')) {
				throw new Error('exit code 1');
			}
			return '';
		});

		killZombieProcesses(8787, logFn);

		// Should SIGTERM then SIGKILL both PIDs
		expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
		expect(killSpy).toHaveBeenCalledWith(67890, 'SIGTERM');
		expect(killSpy).toHaveBeenCalledWith(12345, 'SIGKILL');
		expect(killSpy).toHaveBeenCalledWith(67890, 'SIGKILL');
		expect(logFn).toHaveBeenCalledWith(expect.stringContaining('2 zombie'));
	});

	it('should kill stale backend processes found via ps', () => {
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes('lsof')) {
				throw new Error('exit code 1');
			}
			if (cmd.includes('ps -eo')) {
				return '  11111 node dist/backend/backend/src/index.js\n  22222 node --expose-gc dist/backend/backend/src/index.js\n';
			}
			return '';
		});

		killZombieProcesses(8787, logFn);

		expect(killSpy).toHaveBeenCalledWith(11111, 'SIGKILL');
		expect(killSpy).toHaveBeenCalledWith(22222, 'SIGKILL');
		expect(logFn).toHaveBeenCalledWith(expect.stringContaining('2 stale'));
	});

	it('should not kill its own process', () => {
		const myPid = process.pid;

		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes('lsof')) {
				return `${myPid}\n99999\n`;
			}
			if (cmd.includes('ps -eo')) {
				return `  ${myPid} node dist/backend/backend/src/index.js\n`;
			}
			return '';
		});

		killZombieProcesses(8787, logFn);

		// Should kill 99999 but NOT our own PID
		expect(killSpy).toHaveBeenCalledWith(99999, 'SIGTERM');
		expect(killSpy).not.toHaveBeenCalledWith(myPid, 'SIGTERM');
		expect(killSpy).not.toHaveBeenCalledWith(myPid, 'SIGKILL');
	});

	it('should handle already-dead processes gracefully', () => {
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes('lsof')) {
				return '12345\n';
			}
			if (cmd.includes('ps -eo')) {
				throw new Error('exit code 1');
			}
			return '';
		});

		// Simulate process.kill throwing ESRCH (no such process)
		killSpy.mockImplementation(() => {
			const err = new Error('ESRCH') as NodeJS.ErrnoException;
			err.code = 'ESRCH';
			throw err;
		});

		// Should not throw
		expect(() => killZombieProcesses(8787, logFn)).not.toThrow();
	});

	it('should use the correct port in lsof command', () => {
		mockExecSync.mockImplementation((cmd: string) => {
			throw new Error('exit code 1');
		});

		killZombieProcesses(3000, logFn);

		expect(mockExecSync).toHaveBeenCalledWith(
			'lsof -ti :3000',
			expect.objectContaining({ encoding: 'utf8', timeout: 5000 })
		);
	});

	it('should use default console.log when no logFn provided', () => {
		const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes('lsof')) {
				return '12345\n';
			}
			if (cmd.includes('ps -eo')) {
				throw new Error('exit code 1');
			}
			return '';
		});

		killZombieProcesses(8787);

		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('1 zombie'));
		consoleSpy.mockRestore();
	});
});

describe('selectOrphanedTestPids', () => {
	it('kills only test runners whose parent is gone, plus their worker pool — never a live pipeline run', () => {
		// pid 1 owns 500 (orphaned vitest main); 501/502 are its workers.
		// 700 is `make → npm(699) → vitest`: live parent chain, hands off.
		// 800's parent is a systemd --user subreaper (adopted orphan).
		const rows: Array<[number, number]> = [
			[500, 1],
			[501, 500],
			[502, 500],
			[700, 699],
			[800, 4242],
		];
		const isOrphan = (ppid: number) => ppid === 1 || ppid === 4242;
		expect(selectOrphanedTestPids(rows, isOrphan).sort()).toEqual([500, 501, 502, 800]);
	});

	it('returns nothing when every run has a live parent', () => {
		expect(selectOrphanedTestPids([[700, 699], [701, 700]], () => false)).toEqual([]);
	});
});
