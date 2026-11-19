import { killWindowsProcessTree, hasNonShellDescendant, parseNetstatPeer, parseWindowsProcessRows, WINDOWS_PROCESS_QUERY_ARGS } from './windows-process.utils.js';

const TABLE = [
	'4 0 System',
	'7744 1040 "C:\\Program Files\\nodejs\\node.exe" C:\\npm\\crewly\\dist\\backend\\backend\\src\\index.js',
	'3412 7744 "C:\\Program Files\\Git\\bin\\bash.exe"',
	'9052 3412 "C:\\Program Files\\Git\\bin\\..\\usr\\bin\\bash.exe"',
	'5948 7744 \\\\?\\C:\\Windows\\system32\\conhost.exe --headless --width 160',
	'4628 7744 "C:\\Program Files\\Git\\bin\\bash.exe"',
	'9436 4628 "C:\\Program Files\\Git\\bin\\..\\usr\\bin\\bash.exe"',
	'9900 9436 "C:\\Program Files\\nodejs\\node.exe" C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js --session-id x',
].join('\r\n');

describe('parseWindowsProcessRows', () => {
	it('reads pid, ppid and the command line, CRLF included', () => {
		const rows = parseWindowsProcessRows(TABLE);
		expect(rows).toHaveLength(8);
		expect(rows[1]).toEqual({ pid: 7744, ppid: 1040, command: '"C:\\Program Files\\nodejs\\node.exe" C:\\npm\\crewly\\dist\\backend\\backend\\src\\index.js' });
		expect(rows[0]).toEqual({ pid: 4, ppid: 0, command: 'System' });
	});

	it('ignores lines that are not rows', () => {
		expect(parseWindowsProcessRows('\r\nGet-CimInstance : Access denied\r\n')).toEqual([]);
	});
});

describe('hasNonShellDescendant', () => {
	const rows = parseWindowsProcessRows(TABLE);

	it('is false for an idle session: only the Git Bash launcher chain and conhost', () => {
		expect(hasNonShellDescendant(rows, 3412)).toBe(false);
	});

	it('is true when the runtime runs under the real bash', () => {
		expect(hasNonShellDescendant(rows, 4628)).toBe(true);
	});

	it('is false for a pid with no children or not in the table', () => {
		expect(hasNonShellDescendant(rows, 9900)).toBe(false);
		expect(hasNonShellDescendant(rows, 123456)).toBe(false);
	});
});

describe('parseNetstatPeer', () => {
	const NETSTAT = [
		'  Proto  Local Address          Foreign Address        State           PID',
		'  TCP    0.0.0.0:8787           0.0.0.0:0              LISTENING       7744',
		'  TCP    127.0.0.1:8787         127.0.0.1:51000        ESTABLISHED     7744',
		'  TCP    127.0.0.1:51000        127.0.0.1:8787         ESTABLISHED     9900',
		'  TCP    [::1]:51001            [::1]:8787             ESTABLISHED     4321',
		'  UDP    0.0.0.0:51000          *:*                                    111',
	].join('\r\n');

	it('returns the owner of the client end, IPv4 and IPv6', () => {
		expect(parseNetstatPeer(NETSTAT, 51000, 8787)).toBe(9900);
		expect(parseNetstatPeer(NETSTAT, 51001, 8787)).toBe(4321);
	});

	it('never returns the server end or an unrelated row', () => {
		expect(parseNetstatPeer(NETSTAT, 8787, 51000)).toBe(7744);
		expect(parseNetstatPeer(NETSTAT, 52000, 8787)).toBeNull();
	});
});

describe('WINDOWS_PROCESS_QUERY_ARGS', () => {
	it('runs PowerShell without a profile and prints pid, ppid, command line', () => {
		expect(WINDOWS_PROCESS_QUERY_ARGS.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
		expect(WINDOWS_PROCESS_QUERY_ARGS[3]).toContain('Win32_Process');
	});
});

describe('killWindowsProcessTree', () => {
	it('ends the whole tree by force, from the root pid', () => {
		const calls: Array<[string, string[]]> = [];
		const ok = killWindowsProcessTree(3412, (file, args) => {
			calls.push([file, args]);
			return { status: 0 };
		});
		expect(ok).toBe(true);
		expect(calls).toEqual([['taskkill', ['/PID', '3412', '/T', '/F']]]);
	});

	it('does nothing for pid 0 (ConPTY has not started the shell yet) or a bad pid', () => {
		const run = jest.fn(() => ({ status: 0 }));
		expect(killWindowsProcessTree(0, run)).toBe(false);
		expect(killWindowsProcessTree(-5, run)).toBe(false);
		expect(run).not.toHaveBeenCalled();
	});

	it('reports failure when taskkill fails or cannot be run', () => {
		expect(killWindowsProcessTree(10, () => ({ status: 128 }))).toBe(false);
		expect(
			killWindowsProcessTree(10, () => {
				throw new Error('ENOENT');
			}),
		).toBe(false);
	});
});
