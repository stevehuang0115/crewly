/**
 * Tests for the scheduled commands runner.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ScheduledCommandsService,
	defaultIsPidAlive,
	parseScheduledCommands,
	type ScheduledCommand,
} from './scheduled-commands.service.js';
import { OWNER_AUTH_CONSTANTS, SCHEDULED_COMMANDS } from '../../constants.js';
import { resetOwnerAuthSecretForTesting, verifyInternalCredential } from '../core/owner-auth.service.js';

const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const entry = (over: Partial<ScheduledCommand> = {}): ScheduledCommand => ({
	name: 'web-release',
	cwd: '/work/web',
	command: 'bash',
	args: ['scripts/release.sh', '--if-changed', '--live'],
	intervalMinutes: 5,
	...over,
});

/** A fake child: has a pid, an unref spy and an event emitter for 'error'. */
function fakeChild(pid?: number) {
	const c = new EventEmitter() as EventEmitter & { pid?: number; unref: ReturnType<typeof vi.fn> };
	c.pid = pid;
	c.unref = vi.fn();
	return c;
}

describe('parseScheduledCommands', () => {
	it('keeps a valid entry and defaults args and enabled', () => {
		const r = parseScheduledCommands(
			JSON.stringify([{ name: 'a', cwd: '/x', command: 'echo', intervalMinutes: 5 }]),
		);
		expect(r.entries).toEqual([
			{ name: 'a', cwd: '/x', command: 'echo', args: [], intervalMinutes: 5, lockFile: undefined },
		]);
		expect(r.warnings).toEqual([]);
	});

	it('does not return a disabled entry but counts it', () => {
		const r = parseScheduledCommands(
			JSON.stringify([{ name: 'a', cwd: '/x', command: 'echo', intervalMinutes: 5, enabled: false }]),
		);
		expect(r.entries).toHaveLength(0);
		expect(r.disabled).toBe(1);
	});

	it('expands ~ in cwd and lockFile', () => {
		const r = parseScheduledCommands(
			JSON.stringify([{ name: 'a', cwd: '~/w', command: 'echo', intervalMinutes: 1, lockFile: '~/l' }]),
		);
		expect(r.entries[0].cwd).toBe(path.join(os.homedir(), 'w'));
		expect(r.entries[0].lockFile).toBe(path.join(os.homedir(), 'l'));
	});

	it.each([
		['invalid JSON', '{nope'],
		['not an array', '{"a":1}'],
	])('%s gives 0 entries and one warning', (_n, text) => {
		const r = parseScheduledCommands(text);
		expect(r.entries).toHaveLength(0);
		expect(r.warnings).toHaveLength(1);
	});

	it.each([
		['bad name', { name: 'a b', cwd: '/x', command: 'e', intervalMinutes: 5 }],
		['no command', { name: 'a', cwd: '/x', intervalMinutes: 5 }],
		['relative cwd', { name: 'a', cwd: 'x', command: 'e', intervalMinutes: 5 }],
		['non-string args', { name: 'a', cwd: '/x', command: 'e', args: [1], intervalMinutes: 5 }],
		['interval below minimum', { name: 'a', cwd: '/x', command: 'e', intervalMinutes: 0.5 }],
		['string interval', { name: 'a', cwd: '/x', command: 'e', intervalMinutes: '5' }],
		['relative lockFile', { name: 'a', cwd: '/x', command: 'e', intervalMinutes: 5, lockFile: 'l' }],
	])('rejects %s with a warning', (_n, bad) => {
		const r = parseScheduledCommands(JSON.stringify([bad]));
		expect(r.entries).toHaveLength(0);
		expect(r.warnings).toHaveLength(1);
	});

	it('rejects a duplicate name but keeps the first', () => {
		const e = { name: 'a', cwd: '/x', command: 'e', intervalMinutes: 5 };
		const r = parseScheduledCommands(JSON.stringify([e, e]));
		expect(r.entries).toHaveLength(1);
		expect(r.warnings).toHaveLength(1);
	});
});

describe('defaultIsPidAlive', () => {
	it('is true for this process and false for junk', () => {
		expect(defaultIsPidAlive(process.pid)).toBe(true);
		expect(defaultIsPidAlive(0)).toBe(false);
		expect(defaultIsPidAlive(-3)).toBe(false);
		expect(defaultIsPidAlive(2 ** 31 - 2)).toBe(false);
	});
});

describe('ScheduledCommandsService.start', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	const make = (readFile: (f: string) => string, extra: Record<string, unknown> = {}) => {
		const log = logger();
		const spawn = vi.fn(() => fakeChild(4242));
		const svc = new ScheduledCommandsService({
			configPath: '/home/.crewly/scheduled-commands.json',
			logDir: '/home/.crewly/logs',
			logger: log,
			spawn: spawn as never,
			readFile,
			pathExists: () => true,
			openLog: () => 7,
			closeLog: vi.fn(),
			isPidAlive: () => false,
			...extra,
		});
		return { svc, log, spawn };
	};

	it('missing file = 0 jobs, an info line, nothing scheduled', () => {
		const { svc, log, spawn } = make(() => {
			throw Object.assign(new Error('nope'), { code: 'ENOENT' });
		});
		expect(svc.start()).toBe(0);
		expect(log.info).toHaveBeenCalledWith(expect.stringContaining('0 scheduled command(s) loaded'), expect.anything());
		expect(log.warn).not.toHaveBeenCalled();
		vi.advanceTimersByTime(60 * 60_000);
		expect(spawn).not.toHaveBeenCalled();
	});

	it('invalid config = 0 jobs and exactly one warn line', () => {
		const { svc, log, spawn } = make(() => '{bad');
		expect(svc.start()).toBe(0);
		expect(log.warn).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(60 * 60_000);
		expect(spawn).not.toHaveBeenCalled();
	});

	it('logs N loaded and does not run a disabled entry', () => {
		const text = JSON.stringify([
			{ name: 'on', cwd: '/w', command: 'x', intervalMinutes: 5 },
			{ name: 'off', cwd: '/w', command: 'y', intervalMinutes: 5, enabled: false },
		]);
		const { svc, log, spawn } = make(() => text);
		expect(svc.start()).toBe(1);
		expect(log.info).toHaveBeenCalledWith('1 scheduled command(s) loaded', expect.objectContaining({ disabled: 1 }));
		vi.advanceTimersByTime(60 * 60_000);
		expect(spawn.mock.calls.every((c) => (c as unknown[])[0] === 'x')).toBe(true);
		expect(spawn).toHaveBeenCalled();
	});

	it('runs once after the initial delay, then every interval', () => {
		const text = JSON.stringify([{ name: 'a', cwd: '/w', command: 'x', intervalMinutes: 5 }]);
		const { svc, spawn } = make(() => text);
		svc.start();
		vi.advanceTimersByTime(SCHEDULED_COMMANDS.INITIAL_DELAY_MS - 1);
		expect(spawn).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(spawn).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(5 * 60_000);
		// Interval tick at 5 min, plus the initial one: 2 total by 5m30s.
		expect(spawn).toHaveBeenCalledTimes(2);
	});

	it('stop() cancels the schedule', () => {
		const text = JSON.stringify([{ name: 'a', cwd: '/w', command: 'x', intervalMinutes: 5 }]);
		const { svc, spawn } = make(() => text);
		svc.start();
		svc.stop();
		vi.advanceTimersByTime(60 * 60_000);
		expect(spawn).not.toHaveBeenCalled();
	});
});

describe('ScheduledCommandsService.runEntry', () => {
	const make = (extra: Record<string, unknown> = {}) => {
		const log = logger();
		const child = fakeChild(4242);
		const spawn = vi.fn(() => child);
		const closeLog = vi.fn();
		const svc = new ScheduledCommandsService({
			configPath: '/c.json',
			logDir: '/home/.crewly/logs',
			logger: log,
			spawn: spawn as never,
			readFile: () => {
				throw new Error('no file');
			},
			pathExists: () => true,
			openLog: () => 9,
			closeLog,
			isPidAlive: () => false,
			...extra,
		});
		return { svc, log, spawn, child, closeLog };
	};

	it('spawns detached, unref, right cwd/args, output to the log fd', () => {
		const { svc, spawn, child, closeLog, log } = make();
		expect(svc.runEntry(entry())).toBe('spawned');
		expect(spawn).toHaveBeenCalledWith('bash', ['scripts/release.sh', '--if-changed', '--live'], {
			cwd: '/work/web',
			detached: true,
			stdio: ['ignore', 9, 9],
			env: expect.objectContaining({ [OWNER_AUTH_CONSTANTS.SCHEDULER_NAME_ENV]: 'web-release' }),
		});
		expect(child.unref).toHaveBeenCalled();
		expect(closeLog).toHaveBeenCalledWith(9);
		expect(log.info).toHaveBeenCalledWith(expect.stringContaining('started'), expect.objectContaining({ pid: 4242 }));
	});

	it('never uses a shell', () => {
		const { svc, spawn } = make();
		svc.runEntry(entry());
		expect((spawn.mock.calls[0] as unknown[])[2]).not.toHaveProperty('shell');
	});

	it('skips while the previous run is alive and says so at debug only', () => {
		const alive = new Set<number>();
		const { svc, spawn, log } = make({ isPidAlive: (p: number) => alive.has(p) });
		expect(svc.runEntry(entry())).toBe('spawned');
		alive.add(4242);
		expect(svc.runEntry(entry())).toBe('skipped-running');
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('skipped'));
		expect(log.info).toHaveBeenCalledTimes(1);
		alive.delete(4242);
		expect(svc.runEntry(entry())).toBe('spawned');
		expect(spawn).toHaveBeenCalledTimes(2);
	});

	it('skips while the lock file holder is alive', () => {
		const { svc, spawn } = make({
			readFile: () => '777\n',
			isPidAlive: (p: number) => p === 777,
		});
		expect(svc.runEntry(entry({ lockFile: '/l' }))).toBe('skipped-lock');
		expect(spawn).not.toHaveBeenCalled();
	});

	it('treats a stale lock pid as dead', () => {
		const { svc, spawn } = make({ readFile: () => '777', isPidAlive: () => false });
		expect(svc.runEntry(entry({ lockFile: '/l' }))).toBe('spawned');
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it('a missing or garbled lock file does not block', () => {
		const { svc } = make({ readFile: () => 'not a pid' });
		expect(svc.runEntry(entry({ lockFile: '/l' }))).toBe('spawned');
	});

	it('does not run when cwd is missing (warn)', () => {
		const { svc, spawn, log } = make({ pathExists: () => false });
		expect(svc.runEntry(entry())).toBe('skipped-no-cwd');
		expect(spawn).not.toHaveBeenCalled();
		expect(log.warn).toHaveBeenCalled();
	});

	it('reports spawn-failed (not started) when there is no pid', () => {
		const { svc, log } = make({ spawn: () => fakeChild(undefined) });
		expect(svc.runEntry(entry())).toBe('spawn-failed');
		expect(log.info).not.toHaveBeenCalled();
		expect(log.error).toHaveBeenCalled();
	});

	it('reports spawn-failed when spawn throws and still closes the fd', () => {
		const { svc, closeLog } = make({
			spawn: () => {
				throw new Error('boom');
			},
		});
		expect(svc.runEntry(entry())).toBe('spawn-failed');
		expect(closeLog).toHaveBeenCalledWith(9);
	});

	it('logs an async child error', () => {
		const { svc, child, log } = make();
		svc.runEntry(entry());
		child.emit('error', new Error('ENOENT'));
		expect(log.error).toHaveBeenCalledWith(expect.stringContaining('failed to start'), { error: 'ENOENT' });
	});
});

describe('ScheduledCommandsService with a real process', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-cmd-'));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('starts the child in its own process group and writes its output to the log', async () => {
		const marker = path.join(dir, 'marker');
		const svc = new ScheduledCommandsService({
			configPath: path.join(dir, 'c.json'),
			logDir: path.join(dir, 'logs'),
			logger: logger(),
		});
		const outcome = svc.runEntry(
			entry({
				name: 'real',
				cwd: dir,
				command: 'sh',
				args: ['-c', `echo hi; ps -o pgid= -p $$ > pgid; sleep 1; touch ${marker}`],
			}),
		);
		expect(outcome).toBe('spawned');
		for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
		expect(fs.existsSync(marker)).toBe(true);
		const childPgid = fs.readFileSync(path.join(dir, 'pgid'), 'utf-8').trim();
		const myPgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)]).toString().trim();
		expect(childPgid).not.toBe(myPgid);
		expect(fs.readFileSync(path.join(dir, 'logs', 'scheduled-real.log'), 'utf-8')).toContain('hi');
	});
});

describe('the scheduler credential in a child\'s environment (CREW-312)', () => {
	const run = (name = 'web-release') => {
		const log = logger();
		const spawn = vi.fn(() => fakeChild(4242));
		const openLog = vi.fn(() => 9);
		const svc = new ScheduledCommandsService({
			configPath: '/c.json',
			logDir: '/home/.crewly/logs',
			logger: log,
			spawn: spawn as never,
			readFile: () => {
				throw new Error('no file');
			},
			pathExists: () => true,
			openLog,
			closeLog: vi.fn(),
			isPidAlive: () => false,
		});
		expect(svc.runEntry(entry({ name }))).toBe('spawned');
		const env = ((spawn.mock.calls[0] as unknown[])[2] as { env: Record<string, string> }).env;
		return { env, log, openLog };
	};

	beforeEach(() => resetOwnerAuthSecretForTesting());

	it('hands the child a credential this backend verifies as the scheduler purpose, and its entry name', () => {
		const { env } = run('my-job');
		expect(verifyInternalCredential(env[OWNER_AUTH_CONSTANTS.SCHEDULER_CREDENTIAL_ENV])).toBe('scheduler');
		expect(env[OWNER_AUTH_CONSTANTS.SCHEDULER_NAME_ENV]).toBe('my-job');
	});

	it('keeps the rest of the environment (PATH, HOME) so the command still runs', () => {
		const { env } = run();
		expect(env.PATH).toBe(process.env.PATH);
		expect(env.HOME).toBe(process.env.HOME);
	});

	it('never writes the credential to a log line or to the file system (it only goes into the child\'s env)', () => {
		const { env, log, openLog } = run();
		const credential = env[OWNER_AUTH_CONSTANTS.SCHEDULER_CREDENTIAL_ENV];
		expect(credential.length).toBeGreaterThan(10);
		const logged = JSON.stringify([log.debug.mock.calls, log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
		expect(logged).not.toContain(credential);
		// The only file the runner opens is the child's log, by path.
		expect(openLog.mock.calls.map((c) => String((c as unknown[])[0]))).toEqual(['/home/.crewly/logs/scheduled-web-release.log']);
	});

	it('is not an agent session and not the owner token: no badge, session name or API token is added', () => {
		const { env } = run();
		const added = Object.keys(env).filter((k) => !(k in process.env));
		expect(added.sort()).toEqual([OWNER_AUTH_CONSTANTS.SCHEDULER_CREDENTIAL_ENV, OWNER_AUTH_CONSTANTS.SCHEDULER_NAME_ENV].sort());
	});
});
