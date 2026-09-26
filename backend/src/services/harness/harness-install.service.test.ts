/**
 * Tests for harness installs: npm with the EACCES → user-prefix fallback,
 * async jobs with a log, one install per harness (exec calls mocked).
 */

import * as fs from 'fs';
import { HarnessInstallError, HarnessInstallService, isAllowedInstallerUrl, isPermissionError } from './harness-install.service.js';
import { getHarnessDefinition, type ScriptInstallSpec } from './harness-registry.js';
import type { CommandResult, RunCommand, RunCommandOptions } from './harness.types.js';

/** A runner that answers each call from a queue and records the calls. */
function queuedRun(results: Array<Partial<CommandResult> & { output?: string }>): jest.MockedFunction<RunCommand> {
	const queue = [...results];
	return jest.fn(async (_cmd: string, _args: readonly string[], options?: RunCommandOptions) => {
		const next = queue.shift() ?? { code: 0 };
		if (next.output) options?.onOutput?.(next.output);
		return { code: next.code === undefined ? 0 : next.code, stdout: next.stdout ?? next.output ?? '', stderr: next.stderr ?? '', error: next.error };
	});
}

describe('isPermissionError', () => {
	it('recognises npm permission failures', () => {
		expect(isPermissionError('npm ERR! code EACCES')).toBe(true);
		expect(isPermissionError('Error: EPERM: operation not permitted')).toBe(true);
		expect(isPermissionError('Permission denied')).toBe(true);
		expect(isPermissionError('npm ERR! 404 Not Found')).toBe(false);
	});
});

describe('HarnessInstallService', () => {
	const originalHome = process.env.CREWLY_HOME;
	beforeEach(() => {
		process.env.CREWLY_HOME = '/tmp/crewly-install-test';
	});
	afterAll(() => {
		process.env.CREWLY_HOME = originalHome;
	});

	/**
	 * Build a service.
	 *
	 * @param run - Command runner
	 * @param extra - Other deps
	 * @returns Service and mkdir mock
	 */
	function make(run: RunCommand, extra: Partial<ConstructorParameters<typeof HarnessInstallService>[0]> = {}) {
		const mkdirp = jest.fn();
		let n = 0;
		const service = new HarnessInstallService({ run, mkdirp, env: { PATH: '/usr/bin' }, idFactory: () => `job-${++n}`, ...extra });
		return { service, mkdirp };
	}

	it('installs <pkg>@latest globally and logs the output', async () => {
		const run = queuedRun([{ code: 0, output: 'added 1 package\n' }]);
		const onInstalled = jest.fn();
		const { service } = make(run, { onInstalled });
		const job = service.startInstall('codex-cli');
		expect(job).toMatchObject({ jobId: 'job-1', harnessId: 'codex-cli', state: 'running', usedUserPrefix: false });
		const done = await service.waitForJob(job.jobId);
		expect(done.state).toBe('succeeded');
		expect(done.log).toContain('$ npm install -g @openai/codex@latest');
		expect(done.log).toContain('added 1 package');
		expect(run).toHaveBeenCalledWith('npm', ['install', '-g', '@openai/codex@latest'], expect.objectContaining({ timeoutMs: expect.any(Number) }));
		const env = run.mock.calls[0][2]?.env;
		expect(env?.PATH?.split(':')[0]).toBe('/tmp/crewly-install-test/npm-global/bin');
		expect(onInstalled).toHaveBeenCalledWith('codex-cli');
	});

	it('retries under the user prefix when the global prefix is not writable', async () => {
		const run = queuedRun([{ code: 243, output: 'npm ERR! code EACCES\nnpm ERR! syscall mkdir\n' }, { code: 0, output: 'added 1 package\n' }]);
		const { service, mkdirp } = make(run);
		const done = await service.waitForJob(service.startInstall('claude-code').jobId);
		expect(done.state).toBe('succeeded');
		expect(done.usedUserPrefix).toBe(true);
		expect(mkdirp).toHaveBeenCalledWith('/tmp/crewly-install-test/npm-global');
		expect(run.mock.calls[1][1]).toEqual(['install', '-g', '--prefix', '/tmp/crewly-install-test/npm-global', '@anthropic-ai/claude-code@latest']);
		expect(done.log).toContain('installing under /tmp/crewly-install-test/npm-global instead');
	});

	it('fails without a fallback for other npm errors', async () => {
		const run = queuedRun([{ code: 1, output: 'npm ERR! 404 Not Found\n' }]);
		const { service } = make(run);
		const done = await service.waitForJob(service.startInstall('gemini-cli').jobId);
		expect(done).toMatchObject({ state: 'failed', usedUserPrefix: false });
		expect(run).toHaveBeenCalledTimes(1);
		expect(done.log).toContain('Install failed.');
	});

	it('reports a failed fallback and spawn errors', async () => {
		const run = queuedRun([{ code: 1, stderr: 'EACCES' }, { code: null, error: 'spawn npm ENOENT' }]);
		const { service } = make(run);
		const done = await service.waitForJob(service.startInstall('codex-cli').jobId);
		expect(done).toMatchObject({ state: 'failed', usedUserPrefix: true });
		expect(done.log).toContain('spawn npm ENOENT');

		const { service: service2 } = make(queuedRun([{ code: null, error: 'timed out after 1 ms' }]));
		const done2 = await service2.waitForJob(service2.startInstall('codex-cli').jobId);
		expect(done2).toMatchObject({ state: 'failed', usedUserPrefix: false });
		expect(done2.log).toContain('timed out after 1 ms');
	});

	it('records an exception thrown by the runner as a failed job', async () => {
		const run = jest.fn(async () => {
			throw new Error('runner exploded');
		}) as unknown as RunCommand;
		const { service } = make(run);
		const done = await service.waitForJob(service.startInstall('codex-cli').jobId);
		expect(done.state).toBe('failed');
		expect(done.log).toContain('runner exploded');
	});

	it('runs one install per harness at a time', async () => {
		let release: (r: CommandResult) => void = () => undefined;
		const run = jest.fn(() => new Promise<CommandResult>((resolve) => { release = resolve; })) as unknown as RunCommand;
		const { service } = make(run);
		const first = service.startInstall('codex-cli');
		const second = service.startInstall('codex-cli');
		expect(second.jobId).toBe(first.jobId);
		release({ code: 0, stdout: '', stderr: '' });
		await service.waitForJob(first.jobId);
		expect(service.startInstall('codex-cli').jobId).not.toBe(first.jobId);
	});

	it('keeps only the tail of a long log', async () => {
		const run = queuedRun([{ code: 0, output: 'x'.repeat(100_000) }]);
		const { service } = make(run);
		const done = await service.waitForJob(service.startInstall('codex-cli').jobId);
		expect(done.log.length).toBeLessThanOrEqual(64_000);
		expect(done.log.endsWith('Installed.\n')).toBe(true);
	});

	it('forgets finished jobs after the retention window', async () => {
		let now = 0;
		const { service } = make(queuedRun([{ code: 0 }, { code: 0 }]), { now: () => now });
		const job = await service.waitForJob(service.startInstall('codex-cli').jobId);
		expect(service.getJob(job.jobId).state).toBe('succeeded');
		now += 2 * 60 * 60 * 1000;
		service.startInstall('claude-code');
		expect(() => service.getJob(job.jobId)).toThrow(HarnessInstallError);
	});

	describe('Antigravity CLI (official install script)', () => {
		const SCRIPT = '#!/bin/bash\necho "installing agy"\n';

		it('downloads the installer from antigravity.google and runs it with bash from a private temp file', async () => {
			let scriptPath = '';
			let scriptBody = '';
			const run = jest.fn(async (cmd: string, args: readonly string[], options?: RunCommandOptions) => {
				scriptPath = args[0];
				scriptBody = fs.readFileSync(scriptPath, 'utf8');
				expect(fs.statSync(scriptPath).mode & 0o777).toBe(0o700);
				expect(options?.env?.PATH).toContain('.local/bin');
				options?.onOutput?.('Antigravity CLI binary placed successfully\n');
				return { code: 0, stdout: '', stderr: '' };
			});
			const fetchScript = jest.fn(async () => SCRIPT);
			const { service } = make(run, { fetchScript, resolveCommand: () => null });
			const done = await service.waitForJob(service.startInstall('antigravity-cli').jobId);
			expect(fetchScript).toHaveBeenCalledWith('https://antigravity.google/cli/install.sh');
			expect(run).toHaveBeenCalledWith('bash', [scriptPath], expect.anything());
			expect(scriptBody).toBe(SCRIPT);
			expect(fs.existsSync(scriptPath)).toBe(false); // temp dir removed
			expect(done.state).toBe('succeeded');
			expect(done.log).toContain('$ curl -fsSL https://antigravity.google/cli/install.sh | bash');
			expect(done.log).toContain('placed successfully');
			// Never npm: Antigravity has no npm package.
			expect(run.mock.calls.some(([cmd]) => cmd === 'npm')).toBe(false);
		});

		it('updates an installed agy with its own updater instead of re-running the installer', async () => {
			const run = queuedRun([{ code: 0, output: 'Updated.\n' }]);
			const fetchScript = jest.fn(async () => SCRIPT);
			const { service } = make(run, { fetchScript, resolveCommand: (cmd) => (cmd === 'agy' ? '/home/me/.local/bin/agy' : null) });
			const done = await service.waitForJob(service.startInstall('antigravity-cli').jobId);
			expect(run).toHaveBeenCalledWith('/home/me/.local/bin/agy', ['update'], expect.anything());
			expect(fetchScript).not.toHaveBeenCalled();
			expect(done).toMatchObject({ state: 'succeeded' });
			expect(done.log).toContain('$ agy update');
		});

		it('does not run anything that is not a shell script', async () => {
			const run = queuedRun([]);
			const { service } = make(run, { fetchScript: async () => '<html>error page</html>', resolveCommand: () => null });
			const done = await service.waitForJob(service.startInstall('antigravity-cli').jobId);
			expect(done.state).toBe('failed');
			expect(run).not.toHaveBeenCalled();
		});

		it('fails the job when the download fails or the installer exits non-zero', async () => {
			const failedFetch = make(queuedRun([]), { fetchScript: async () => { throw new Error('Download failed: HTTP 503'); }, resolveCommand: () => null });
			const a = await failedFetch.service.waitForJob(failedFetch.service.startInstall('antigravity-cli').jobId);
			expect(a).toMatchObject({ state: 'failed' });
			expect(a.log).toContain('HTTP 503');
			const failedRun = make(queuedRun([{ code: 1, output: 'Security Halt: checksum mismatch\n' }]), { fetchScript: async () => SCRIPT, resolveCommand: () => null });
			const b = await failedRun.service.waitForJob(failedRun.service.startInstall('antigravity-cli').jobId);
			expect(b).toMatchObject({ state: 'failed' });
			expect(b.log).toContain('Security Halt');
		});

		it('only allows the exact https URL the registry names', () => {
			const spec = getHarnessDefinition('antigravity-cli')!.install as ScriptInstallSpec;
			expect(isAllowedInstallerUrl('https://antigravity.google/cli/install.sh', spec)).toBe(true);
			expect(isAllowedInstallerUrl('http://antigravity.google/cli/install.sh', spec)).toBe(false);
			expect(isAllowedInstallerUrl('https://evil.example/cli/install.sh', spec)).toBe(false);
			expect(isAllowedInstallerUrl('https://antigravity.google.evil.example/cli/install.sh', spec)).toBe(false);
			expect(isAllowedInstallerUrl('not a url', spec)).toBe(false);
		});
	});

	it('rejects unknown harnesses and jobs', async () => {
		const { service } = make(queuedRun([]));
		expect(() => service.startInstall('nope')).toThrow(expect.objectContaining({ code: 'unknown_harness' }));
		expect(() => service.getJob('missing')).toThrow(expect.objectContaining({ code: 'job_not_found' }));
		await expect(service.waitForJob('missing')).rejects.toMatchObject({ code: 'job_not_found' });
	});
});
