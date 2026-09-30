import {
	AgentProcessOriginService,
	parseProcessTable,
	readProcessTable,
	resolveProcessOrigin,
	type ProcessEntry,
} from './agent-process-origin.service.js';
import { AGENT_ORIGIN_CONSTANTS } from '../../constants.js';

/**
 * The steamfun-ops shape: the orc's TUI started the shared daemon, which was
 * re-parented to init; Avery's skill ran under the daemon. With --no-daemon,
 * Avery's skill runs under her own TUI → her PTY shell.
 */
const TABLE: Map<number, ProcessEntry> = new Map([
	[100, { ppid: 1, args: '-bash' }], // orc PTY shell
	[101, { ppid: 100, args: 'codex -a never -s danger-full-access' }], // orc TUI
	[200, { ppid: 1, args: '-bash' }], // avery PTY shell
	[201, { ppid: 200, args: 'codex -a never -s danger-full-access' }], // avery TUI (on the daemon)
	// The daemon is still the child of the TUI that started it (the orc's).
	[300, { ppid: 101, args: '/root/.codex/packages/app-server-daemon/releases/0.159.2/bin/codex app-server --listen unix:// --managed-daemon' }],
	[301, { ppid: 300, args: '/bin/bash -lc bash reply-channel/execute.sh' }],
	[302, { ppid: 301, args: 'bash reply-channel/execute.sh' }], // avery's skill via the daemon
	[400, { ppid: 200, args: 'codex --no-daemon -a never -s danger-full-access' }], // avery TUI, fixed
	[401, { ppid: 400, args: '/bin/bash -lc bash reply-channel/execute.sh' }],
	[402, { ppid: 401, args: 'bash reply-channel/execute.sh' }],
]);
const SESSIONS = new Map([
	[100, 'crewly-orc'],
	[200, 'steamfun-portal-team-avery-member-1'],
]);

describe('resolveProcessOrigin', () => {
	it('finds the agent PTY a skill runs under', () => {
		expect(resolveProcessOrigin(402, TABLE, SESSIONS)).toEqual({ session: 'steamfun-portal-team-avery-member-1', viaSharedDaemon: false });
	});

	it('does not credit the daemon\'s parent (the orc) with a skill the shared daemon ran', () => {
		expect(resolveProcessOrigin(302, TABLE, SESSIONS)).toEqual({ session: null, viaSharedDaemon: true });
	});

	it('returns null for an unknown pid', () => {
		expect(resolveProcessOrigin(999, TABLE, SESSIONS)).toEqual({ session: null, viaSharedDaemon: false });
	});

	it('stops on a parent loop', () => {
		const loop = new Map<number, ProcessEntry>([
			[10, { ppid: 11, args: 'a' }],
			[11, { ppid: 10, args: 'b' }],
		]);
		expect(resolveProcessOrigin(10, loop, SESSIONS)).toEqual({ session: null, viaSharedDaemon: false });
	});

	it('gives up after MAX_ANCESTRY_DEPTH parents', () => {
		const deep = new Map<number, ProcessEntry>();
		const n = AGENT_ORIGIN_CONSTANTS.MAX_ANCESTRY_DEPTH + 5;
		for (let i = 2; i < n; i++) deep.set(i + 1, { ppid: i, args: 'x' });
		expect(resolveProcessOrigin(n, deep, new Map([[2, 'far-away']]))).toEqual({ session: null, viaSharedDaemon: false });
	});
});

describe('parseProcessTable', () => {
	it('parses ps -Ao pid=,ppid=,args= output', () => {
		const table = parseProcessTable('    1     0 /sbin/init\n  402   401 bash reply-channel/execute.sh --x\n  garbage\n  7 1\n');
		expect(table.get(1)).toEqual({ ppid: 0, args: '/sbin/init' });
		expect(table.get(402)).toEqual({ ppid: 401, args: 'bash reply-channel/execute.sh --x' });
		expect(table.get(7)).toEqual({ ppid: 1, args: '' });
		expect(table.size).toBe(3);
	});
});

describe('readProcessTable', () => {
	it('reads the real process table, including this process and its parent', async () => {
		const table = await readProcessTable();
		expect(table.get(process.pid)?.ppid).toBe(process.ppid);
	});
});

describe('AgentProcessOriginService', () => {
	it('resolves through the process table and caches per pid', async () => {
		const readTable = jest.fn().mockResolvedValue(TABLE);
		let t = 0;
		const service = new AgentProcessOriginService({ readTable, listSessionPids: () => SESSIONS, now: () => t });
		await expect(service.resolve(402)).resolves.toEqual({ session: 'steamfun-portal-team-avery-member-1', viaSharedDaemon: false });
		await service.resolve(402);
		expect(readTable).toHaveBeenCalledTimes(1);
		t += AGENT_ORIGIN_CONSTANTS.RESULT_CACHE_TTL_MS;
		await service.resolve(402);
		expect(readTable).toHaveBeenCalledTimes(2);
	});

	it('skips ps when there are no agent sessions', async () => {
		const readTable = jest.fn();
		const service = new AgentProcessOriginService({ readTable, listSessionPids: () => new Map() });
		await expect(service.resolve(402)).resolves.toEqual({ session: null, viaSharedDaemon: false });
		expect(readTable).not.toHaveBeenCalled();
	});
});
