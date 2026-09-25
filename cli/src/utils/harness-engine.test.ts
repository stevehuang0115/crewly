/**
 * Tests for the CLI's access to the harness engine: in-process service,
 * backend-vs-in-process login driver, and the backend REST driver.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import type { HarnessService } from '../../../backend/src/services/harness/harness.service.js';
import {
	createBackendLoginDriver,
	createDetachedLoginDriver,
	createCliHarnessService,
	createInProcessLoginDriver,
	getBackendPort,
	isBackendRunning,
	localBackendUrl,
	pickLoginDriver,
	type HttpJson,
} from './harness-engine.js';

const SESSION = { id: 's1', harnessId: 'claude-code', method: 'subscription', state: 'awaiting_user', url: 'https://x', userCode: null, needsInput: true, message: null, screen: '', startedAt: '', updatedAt: '' };

describe('backend location', () => {
	it('uses WEB_PORT or the default port', () => {
		expect(getBackendPort({ WEB_PORT: '9001' })).toBe(9001);
		expect(getBackendPort({ WEB_PORT: 'nope' })).toBeGreaterThan(0);
		expect(getBackendPort({})).toBeGreaterThan(0);
		expect(localBackendUrl(9001)).toBe('http://localhost:9001');
	});

	it('isBackendRunning checks /health and never throws', async () => {
		const up: HttpJson = jest.fn(async () => ({ status: 200, body: { status: 'healthy', homeId: 'mine' } }));
		expect(await isBackendRunning(9001, up, 'mine')).toBe(true);
		expect(up).toHaveBeenCalledWith('GET', 'http://localhost:9001/health');
		expect(await isBackendRunning(9001, async () => ({ status: 503, body: { homeId: 'mine' } }), 'mine')).toBe(false);
		expect(await isBackendRunning(9001, async () => { throw new Error('ECONNREFUSED'); }, 'mine')).toBe(false);
	});

	it("isBackendRunning ignores a backend serving another Crewly home (another Unix user's, on the same port)", async () => {
		expect(await isBackendRunning(8787, async () => ({ status: 200, body: { status: 'healthy', homeId: 'root-home' } }), 'mine')).toBe(false);
		// Too old to say which home it serves: not trusted either.
		expect(await isBackendRunning(8787, async () => ({ status: 200, body: { status: 'healthy' } }), 'mine')).toBe(false);
		expect(await isBackendRunning(8787, async () => ({ status: 200, body: null }), 'mine')).toBe(false);
	});
});

describe('login drivers', () => {
	it('backend driver calls the /api/harness contract and unwraps data', async () => {
		const http = jest.fn<ReturnType<HttpJson>, Parameters<HttpJson>>(async () => ({ status: 200, body: { success: true, data: SESSION } }));
		const driver = createBackendLoginDriver('http://localhost:8787', http);
		expect(driver.where).toBe('backend');
		expect(await driver.start('claude-code', 'subscription')).toEqual(SESSION);
		await driver.get('s1');
		await driver.input('s1', 'code#state');
		await driver.cancel('s1');
		expect(http.mock.calls).toEqual([
			['POST', 'http://localhost:8787/api/harness/claude-code/login', { method: 'subscription' }],
			['GET', 'http://localhost:8787/api/harness/login/s1'],
			['POST', 'http://localhost:8787/api/harness/login/s1/input', { text: 'code#state' }],
			['POST', 'http://localhost:8787/api/harness/login/s1/cancel'],
		]);
	});

	it('backend driver surfaces API errors', async () => {
		const driver = createBackendLoginDriver('http://localhost:8787', async () => ({ status: 409, body: { success: false, error: 'Codex is not installed' } }));
		await expect(driver.start('codex-cli', 'device')).rejects.toThrow('Codex is not installed');
		const bare = createBackendLoginDriver('http://localhost:8787', async () => ({ status: 500, body: null }));
		await expect(bare.get('s1')).rejects.toThrow('HTTP 500');
	});

	it('in-process driver delegates to the service broker', async () => {
		const service = {
			startLogin: jest.fn(() => SESSION),
			broker: { get: jest.fn(() => SESSION), input: jest.fn(() => SESSION), cancel: jest.fn(() => SESSION) },
		} as unknown as HarnessService;
		const driver = createInProcessLoginDriver(service);
		expect(driver.where).toBe('in-process');
		await driver.start('claude-code', 'subscription');
		await driver.get('s1');
		await driver.input('s1', 'x');
		await driver.cancel('s1');
		expect(service.startLogin).toHaveBeenCalledWith('claude-code', 'subscription');
		expect(service.broker.input).toHaveBeenCalledWith('s1', 'x');
	});

	it('pickLoginDriver prefers the running backend', async () => {
		const service = {} as HarnessService;
		expect((await pickLoginDriver(service, { port: 8787, homeId: 'mine', http: async () => ({ status: 200, body: { homeId: 'mine' } }) })).where).toBe('backend');
		expect((await pickLoginDriver(service, { port: 8787, homeId: 'mine', http: async () => ({ status: 200, body: { homeId: 'theirs' } }) })).where).toBe('in-process');
		expect((await pickLoginDriver(service, { port: 8787, homeId: 'mine', http: async () => { throw new Error('down'); } })).where).toBe('in-process');
	});
});

describe('createDetachedLoginDriver', () => {
	let tmp: string;
	let binDir: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-detached-login-'));
		binDir = path.join(tmp, 'bin');
		fs.mkdirSync(binDir);
		const codex = path.join(binDir, 'codex');
		fs.writeFileSync(codex, '#!/bin/sh\n');
		fs.chmodSync(codex, 0o755);
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	/** A fake detached child that "prints" by writing to the log fd. */
	function fakeSpawn(output: string) {
		const child = Object.assign(new EventEmitter(), { pid: 4242 }) as unknown as ChildProcess;
		const spawn = jest.fn((_command: string, _args: readonly string[], options: { logFd: number }) => {
			fs.writeSync(options.logFd, output);
			return child;
		});
		return { child, spawn };
	}

	const CODEX_SCREEN = [
		'Follow these steps to sign in with ChatGPT using device code authorization:',
		'',
		'1. Open this link in your browser and sign in to your account',
		'   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m',
		'',
		'2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m',
		'   \u001b[94mWNEQ-UDYAN\u001b[0m',
		'',
		'Continue only if you started this login in Codex.',
		'',
	].join('\n');

	it('runs `codex login --device-auth` in the background and reads the link and code from its output', async () => {
		const { spawn } = fakeSpawn(CODEX_SCREEN);
		const env = { PATH: binDir, BROWSER: 'true' };
		const driver = createDetachedLoginDriver({} as HarnessService, { spawn, env, logDir: path.join(tmp, 'logs'), homeDir: tmp });
		expect(driver.where).toBe('detached');
		const session = await driver.start('codex-cli', 'device');
		expect(spawn).toHaveBeenCalledWith(path.join(binDir, 'codex'), ['login', '--device-auth'], expect.objectContaining({ env, cwd: tmp }));
		expect(session.state).toBe('awaiting_user');
		expect(session.url).toBe('https://auth.openai.com/codex/device');
		expect(session.userCode).toBe('WNEQ-UDYAN');
		expect(session.needsInput).toBe(false);
		expect(fs.statSync(path.join(tmp, 'logs', 'login-codex-cli.log')).mode & 0o777).toBe(0o600);
	});

	it('reports an exit before any link as failed, and cancel kills the process group', async () => {
		const { child, spawn } = fakeSpawn('');
		const kill = jest.fn();
		const driver = createDetachedLoginDriver({} as HarnessService, { spawn, env: { PATH: binDir }, logDir: path.join(tmp, 'logs'), homeDir: tmp, kill });
		const session = await driver.start('codex-cli', 'device');
		expect(session.state).toBe('starting');
		expect((await driver.cancel(session.id)).state).toBe('cancelled');
		expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');

		const second = await driver.start('codex-cli', 'device');
		child.emit('exit', 1);
		expect((await driver.get(second.id)).state).toBe('failed');
	});

	it('refuses logins that need a typed reply, and harnesses that are not installed', async () => {
		const { spawn } = fakeSpawn('');
		const driver = createDetachedLoginDriver({} as HarnessService, { spawn, env: { PATH: binDir }, logDir: path.join(tmp, 'logs'), homeDir: tmp });
		await expect(driver.start('claude-code', 'subscription')).rejects.toThrow('code typed back');
		const empty = createDetachedLoginDriver({} as HarnessService, { spawn, env: { PATH: path.join(tmp, 'nothing') }, logDir: path.join(tmp, 'logs'), homeDir: tmp });
		await expect(empty.start('codex-cli', 'device')).rejects.toThrow('not installed');
		expect(spawn).not.toHaveBeenCalled();
		await expect(driver.input('x', 'y')).rejects.toThrow('no typed input');
	});
});

describe('createCliHarnessService', () => {
	it('builds an engine with every part', () => {
		const service = createCliHarnessService();
		expect(service.status).toBeDefined();
		expect(service.install).toBeDefined();
		expect(service.broker).toBeDefined();
		expect(service.apiKeys).toBeDefined();
		expect(service.orc).toBeDefined();
	});
});
