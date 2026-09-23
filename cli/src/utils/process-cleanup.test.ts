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

	/**
	 * A fake machine. Port 8787 is THIS start's port: a stale Crewly backend
	 * (111) still listens there and a browser (333) is connected to it.
	 * Port 8788 is ANOTHER project's live Crewly backend (222). Port 8790 is
	 * held by something that is not Crewly (444).
	 *
	 * The mock answers the scoped commands AND the old broad ones (the
	 * machine-wide `ps | grep dist/backend…` sweep and the client-inclusive
	 * `lsof -ti :<port>`), so a regression to either fails on an assertion
	 * instead of crashing.
	 */
	const BACKEND = '/usr/local/lib/node_modules/crewly/dist/backend/backend/src/index.js';
	const listeners: Record<number, number[]> = { 8787: [111], 8788: [222], 8790: [444] };
	const clients: Record<number, number[]> = { 8787: [333] };
	const commands: Record<number, string> = {
		111: `node --expose-gc --max-old-space-size=4096 ${BACKEND}`,
		222: `node --expose-gc --max-old-space-size=4096 ${BACKEND}`,
		333: '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper',
		444: 'python3 -m http.server 8790',
	};

	function machine(cmd: string): string {
		let m = /^lsof -nP -ti tcp:(\d+) -sTCP:LISTEN$/.exec(cmd);
		if (m) {
			const pids = listeners[Number(m[1])] ?? [];
			if (pids.length === 0) throw new Error('exit code 1');
			return pids.join('\n') + '\n';
		}
		m = /^lsof -ti :(\d+)$/.exec(cmd);
		if (m) {
			const port = Number(m[1]);
			const pids = [...(listeners[port] ?? []), ...(clients[port] ?? [])];
			if (pids.length === 0) throw new Error('exit code 1');
			return pids.join('\n') + '\n';
		}
		m = /^ps -o command= -p (\d+)$/.exec(cmd);
		if (m) {
			const c = commands[Number(m[1])];
			if (!c) throw new Error('no such process');
			return c + '\n';
		}
		if (cmd.includes('ps -eo pid,command') && cmd.includes('dist/backend/backend/src/index.js')) {
			return Object.entries(commands)
				.filter(([, c]) => c.includes('dist/backend/backend/src/index.js'))
				.map(([pid, c]) => `  ${pid} ${c}`)
				.join('\n') + '\n';
		}
		if (cmd.includes('vitest')) throw new Error('exit code 1');
		if (cmd.startsWith('sleep')) return '';
		throw new Error(`unexpected command: ${cmd}`);
	}

	/** Distinct pids that received any signal. */
	function signalledPids(): number[] {
		return [...new Set(killSpy.mock.calls.map((c: unknown[]) => c[0] as number))].sort((x, y) => x - y);
	}

	beforeEach(() => {
		jest.clearAllMocks();
		killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
		logFn = jest.fn();
		mockExecSync.mockImplementation((cmd: string) => machine(cmd));
	});

	afterEach(() => {
		killSpy.mockRestore();
	});

	it("replaces only this port's stale backend: another project's backend on a different port survives", () => {
		killZombieProcesses(8787, logFn);

		// Exactly one process signalled, and it is this port's stale backend.
		expect(signalledPids()).toEqual([111]);
		expect(killSpy).not.toHaveBeenCalledWith(222, expect.anything());
	});

	it('never signals a client that is merely connected to the port', () => {
		killZombieProcesses(8787, logFn);

		expect(killSpy).not.toHaveBeenCalledWith(333, expect.anything());
	});

	it('leaves a non-Crewly process that holds the port alone, and says so', () => {
		killZombieProcesses(8790, logFn);

		expect(signalledPids()).toEqual([]);
		expect(logFn).toHaveBeenCalledWith(expect.stringContaining('not a Crewly backend'));
	});

	it('sends SIGTERM before SIGKILL, and returns the pids it signalled', () => {
		const signalled = killZombieProcesses(8787, logFn);

		expect(killSpy.mock.calls).toEqual([
			[111, 'SIGTERM'],
			[111, 'SIGKILL'],
		]);
		expect(signalled).toEqual([111]);
	});

	it('signals nothing when nothing listens on the port', () => {
		const signalled = killZombieProcesses(9999, logFn);

		expect(signalledPids()).toEqual([]);
		expect(signalled).toEqual([]);
	});

	it('asks lsof for LISTENING sockets on this port only', () => {
		killZombieProcesses(3000, logFn);

		expect(mockExecSync).toHaveBeenCalledWith(
			'lsof -nP -ti tcp:3000 -sTCP:LISTEN',
			expect.objectContaining({ encoding: 'utf8', timeout: 5000 }),
		);
		const cmds = mockExecSync.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(cmds.some((c) => c.includes('ps -eo pid,command'))).toBe(false);
	});

	it('should not kill its own process', () => {
		const myPid = process.pid;
		listeners[7777] = [myPid];
		commands[myPid] = `node ${BACKEND}`;
		try {
			killZombieProcesses(7777, logFn);
			expect(killSpy).not.toHaveBeenCalledWith(myPid, expect.anything());
		} finally {
			delete listeners[7777];
			delete commands[myPid];
		}
	});

	it('should handle already-dead processes gracefully', () => {
		killSpy.mockImplementation(() => {
			const err = new Error('ESRCH') as NodeJS.ErrnoException;
			err.code = 'ESRCH';
			throw err;
		});

		expect(() => killZombieProcesses(8787, logFn)).not.toThrow();
	});

	it('should use default console.log when no logFn provided', () => {
		const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
		killZombieProcesses(8787);
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('stale Crewly backend'));
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
