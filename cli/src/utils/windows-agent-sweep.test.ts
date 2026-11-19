/**
 * Tests for the Windows orphaned-agent sweep: which processes count as
 * Crewly agents, which tree roots are selected, and that nothing else is.
 */

import {
	WINDOWS_AGENT_TABLE_COMMAND,
	collectStartedTree,
	isCrewlyAgentCommand,
	isShellCommand,
	parseWindowsAgentTable,
	selectOrphanedAgentTreeRoots,
	sweepOrphanedWindowsAgents,
	type StartedProcessRow,
} from './windows-agent-sweep.js';

const SETTINGS = '--settings "C:/Users/me/.crewly/runtime/control-plane/crewly-orc.settings.json"';
/** A Claude Code launched by Crewly, as Windows lists it. */
const AGENT = `"C:\\Users\\me\\.local\\bin\\claude.exe" --dangerously-skip-permissions --agent "crewly-orc" --disallowedTools EnterPlanMode,ExitPlanMode ${SETTINGS}`;
const OUTER_BASH = '"C:\\Program Files\\Git\\bin\\bash.exe" --login -i';
const INNER_BASH = '"C:\\Program Files\\Git\\bin\\..\\usr\\bin\\bash.exe" --login -i';
const BACKEND = '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\crewly\\dist\\backend\\backend\\src\\index.js';

/**
 * Build a row.
 *
 * @param pid - Process id
 * @param ppid - Parent pid
 * @param startedAt - Start time (any increasing number)
 * @param command - Command line
 * @returns The row
 */
const row = (pid: number, ppid: number, startedAt: number, command: string): StartedProcessRow => ({ pid, ppid, startedAt, command });

/**
 * Pids selected from a table.
 *
 * @param rows - Process table
 * @param protectedPids - Pids never selected
 * @returns Selected root pids
 */
const selected = (rows: StartedProcessRow[], protectedPids: number[] = []): number[] =>
	selectOrphanedAgentTreeRoots(rows, new Set(protectedPids)).map((r) => r.pid);

describe('isCrewlyAgentCommand', () => {
	it.each([
		[AGENT],
		['claude.exe --dangerously-skip-permissions --settings C:\\Users\\me\\.crewly\\runtime\\control-plane\\web-alice-1a2b.settings.json'],
		['node.exe C:\\npm\\claude\\cli.js --settings=/c/Users/me/.crewly/runtime/control-plane/x.settings.json --dangerously-skip-permissions'],
		['claude --dangerously-skip-permissions --settings "C:/Users/John Doe/.crewly/runtime/control-plane/crewly-orc.settings.json"'],
	])('matches a Crewly launch: %s', (command) => {
		expect(isCrewlyAgentCommand(command)).toBe(true);
	});

	it.each([
		['claude.exe'],
		['"C:\\Users\\me\\.local\\bin\\claude.exe"'],
		['claude.exe remote-control'],
		['claude.exe remote-control --name crewly'],
		['claude.exe --dangerously-skip-permissions'],
		['claude.exe --dangerously-skip-permissions --agent "crewly-orc"'],
		['claude.exe --resume 1234 --settings C:\\Users\\me\\.claude\\settings.json --dangerously-skip-permissions'],
		[`claude.exe ${SETTINGS}`],
		['claude.exe --dangerously-skip-permissions --add-dir C:/Users/me/.crewly/runtime/control-plane'],
		['notepad.exe C:\\Users\\me\\.crewly\\runtime\\control-plane\\crewly-orc.settings.json'],
		[OUTER_BASH],
		[BACKEND],
		[''],
	])('does not match: %s', (command) => {
		expect(isCrewlyAgentCommand(command)).toBe(false);
	});
});

describe('isShellCommand', () => {
	it.each([[OUTER_BASH], [INNER_BASH], ['bash.exe'], ['bash --login'], ['C:\\Git\\usr\\bin\\sh.exe -c x'], ['C:\\Program Files\\Git\\bin\\bash.exe --login -i']])(
		'is a shell: %s',
		(command) => expect(isShellCommand(command)).toBe(true),
	);

	it.each([[AGENT], [BACKEND], ['powershell.exe -NoProfile'], ['"C:\\tools\\rbash-helper.exe"'], ['node.exe C:\\x\\bash'], ['']])(
		'is not a shell: %s',
		(command) => expect(isShellCommand(command)).toBe(false),
	);
});

describe('parseWindowsAgentTable', () => {
	it('reads pid, ppid, start time and command line, with or without a command line', () => {
		const out = `0 0 0 \r\n4 0 133760000000000000 \r\n812 4 133760000000000100 ${OUTER_BASH}\r\n  900 812 133760000000000200 ${AGENT}\r\n\r\nnot a row\r\n`;
		expect(parseWindowsAgentTable(out)).toEqual([
			row(0, 0, 0, ''),
			row(4, 0, 133760000000000000, ''),
			row(812, 4, 133760000000000100, OUTER_BASH),
			row(900, 812, 133760000000000200, AGENT),
		]);
	});

	it('asks PowerShell for the creation time', () => {
		expect(WINDOWS_AGENT_TABLE_COMMAND).toContain('CreationDate.ToFileTimeUtc()');
	});
});

describe('selectOrphanedAgentTreeRoots', () => {
	it.each<[string, StartedProcessRow[], number[]]>([
		[
			'an orphaned session: the outer shell is the root',
			[row(10, 4000, 100, OUTER_BASH), row(11, 10, 101, INNER_BASH), row(12, 11, 102, AGENT), row(13, 12, 103, 'node.exe mcp-server.js')],
			[10],
		],
		[
			'many orphaned sessions: one root each',
			[
				row(10, 4000, 100, OUTER_BASH), row(11, 10, 101, INNER_BASH), row(12, 11, 102, AGENT),
				row(20, 4000, 110, OUTER_BASH), row(21, 20, 111, INNER_BASH), row(22, 21, 112, AGENT),
			],
			[10, 20],
		],
		[
			'an agent wrapped in node: one root, not two',
			[row(10, 4000, 100, OUTER_BASH), row(12, 10, 102, `node.exe cli.js --dangerously-skip-permissions ${SETTINGS}`), row(13, 12, 103, AGENT)],
			[10],
		],
		['an orphaned agent with no shell: the agent itself', [row(12, 4000, 102, AGENT)], [12]],
		[
			"the shell's parent pid was reused by a younger, unrelated process: still orphaned, the newcomer untouched",
			[row(4000, 1, 500, 'chrome.exe'), row(10, 4000, 100, OUTER_BASH), row(12, 10, 102, AGENT)],
			[10],
		],
		[
			"the agent's parent pid was reused by a younger, unrelated shell: only the agent",
			[row(10, 1, 500, OUTER_BASH), row(12, 10, 102, AGENT)],
			[12],
		],
		[
			'agents of a live backend (e.g. on another port) are left alone',
			[row(5, 1, 50, BACKEND), row(10, 5, 100, OUTER_BASH), row(11, 10, 101, INNER_BASH), row(12, 11, 102, AGENT)],
			[],
		],
		[
			'a live and an orphaned session side by side: only the orphan',
			[
				row(5, 1, 50, BACKEND), row(10, 5, 100, OUTER_BASH), row(12, 10, 102, AGENT),
				row(20, 4000, 60, OUTER_BASH), row(22, 20, 62, AGENT),
			],
			[20],
		],
		[
			'launched by some other live process (a terminal): left alone',
			[row(7, 1, 50, 'WindowsTerminal.exe'), row(10, 7, 100, OUTER_BASH), row(12, 10, 102, AGENT)],
			[],
		],
		['start times unknown: cannot tell, left alone', [row(10, 4000, 0, OUTER_BASH), row(12, 10, 0, AGENT)], []],
		[
			"the user's own Claude Code sessions are never selected, orphaned or not",
			[
				row(30, 4000, 100, OUTER_BASH), row(31, 30, 101, '"C:\\Users\\me\\.local\\bin\\claude.exe"'),
				row(40, 4001, 100, 'claude.exe remote-control'),
				row(50, 4002, 100, OUTER_BASH), row(51, 50, 101, 'claude.exe --dangerously-skip-permissions --resume'),
				row(60, 4003, 100, 'claude.exe --settings C:\\Users\\me\\.claude\\settings.json'),
			],
			[],
		],
		[
			"orphaned agents next to the user's own sessions: only the agents' trees",
			[
				row(10, 4000, 100, OUTER_BASH), row(11, 10, 101, INNER_BASH), row(12, 11, 102, AGENT),
				row(30, 4000, 100, OUTER_BASH), row(31, 30, 101, 'claude.exe'),
				row(40, 4000, 100, 'claude.exe remote-control'),
			],
			[10],
		],
		['an orphaned shell with no agent under it is not identifiable and is left', [row(10, 4000, 100, OUTER_BASH), row(11, 10, 101, INNER_BASH)], []],
		['an empty table', [], []],
	])('%s', (_name, rows, expected) => {
		expect(selected(rows)).toEqual(expected);
	});

	it('never selects this process or its ancestors (crewly stop run from inside an agent)', () => {
		const rows = [
			row(10, 4000, 100, OUTER_BASH), row(12, 10, 102, AGENT), row(14, 12, 104, INNER_BASH), row(15, 14, 105, 'node.exe crewly stop'),
			row(20, 4000, 110, OUTER_BASH), row(22, 20, 112, AGENT),
		];
		expect(selected(rows, [15, 14, 12, 10])).toEqual([20]);
		// The agent is not an ancestor, but its shell is: the shell is not climbed into.
		expect(selected([row(10, 4000, 100, OUTER_BASH), row(12, 10, 102, AGENT)], [10])).toEqual([]);
	});
});

describe('collectStartedTree', () => {
	it('takes real descendants and skips a process that merely carries a reused parent pid', () => {
		const root = row(10, 4000, 100, OUTER_BASH);
		const rows = [
			root,
			row(11, 10, 101, INNER_BASH),
			row(12, 11, 102, AGENT),
			row(13, 12, 103, 'node.exe mcp-server.js'),
			row(90, 10, 5, 'explorer.exe'), // older than the root: its parent was an earlier pid 10
			row(91, 10, 0, 'unknown.exe'),
			row(92, 1, 104, 'other.exe'),
		];
		expect(collectStartedTree(rows, root).map((r) => r.pid)).toEqual([10, 11, 12, 13]);
	});
});

describe('sweepOrphanedWindowsAgents', () => {
	const TABLE = [
		`10 4000 100 ${OUTER_BASH}`,
		`11 10 101 ${INNER_BASH}`,
		`12 11 102 ${AGENT}`,
		'30 4000 100 claude.exe remote-control',
		'31 4001 100 claude.exe',
	].join('\r\n');

	/**
	 * Sweep dependencies that record what was killed.
	 *
	 * @param platform - Platform to run as
	 * @param immortal - Pids that survive a kill
	 * @returns The deps and the recorded calls
	 */
	const deps = (platform: NodeJS.Platform, immortal: number[] = []) => {
		const killed: number[] = [];
		const run = jest.fn(async () => TABLE);
		return {
			killed,
			run,
			deps: {
				run,
				kill: async (pid: number) => void killed.push(pid),
				isAlive: async (pid: number) => immortal.includes(pid),
				platform,
			},
		};
	};

	it('ends each orphaned agent tree, and only those processes', async () => {
		const d = deps('win32');
		const result = await sweepOrphanedWindowsAgents(new Set(), d.deps);
		expect(d.run).toHaveBeenCalledWith(WINDOWS_AGENT_TABLE_COMMAND);
		expect(d.killed).toEqual([10, 11, 12]);
		expect(result.ended.map((t) => [t.root.pid, t.processCount])).toEqual([[10, 3]]);
		expect(result.failed).toEqual([]);
	});

	it('reports a tree with a survivor as failed', async () => {
		const d = deps('win32', [12]);
		const result = await sweepOrphanedWindowsAgents(new Set(), d.deps);
		expect(result.ended).toEqual([]);
		expect(result.failed.map((t) => t.root.pid)).toEqual([10]);
	});

	it.each<NodeJS.Platform>(['darwin', 'linux'])('runs nothing and ends nothing on %s', async (platform) => {
		const d = deps(platform);
		expect(await sweepOrphanedWindowsAgents(new Set(), d.deps)).toEqual({ ended: [], failed: [] });
		expect(d.run).not.toHaveBeenCalled();
		expect(d.killed).toEqual([]);
	});

	it('ends nothing when the process table cannot be read', async () => {
		const d = deps('win32');
		d.run.mockRejectedValueOnce(new Error('powershell missing'));
		expect(await sweepOrphanedWindowsAgents(new Set(), d.deps)).toEqual({ ended: [], failed: [] });
		expect(d.killed).toEqual([]);
	});
});
