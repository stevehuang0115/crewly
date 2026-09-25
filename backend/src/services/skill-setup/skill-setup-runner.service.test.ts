import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CommandResult, RunCommandOptions } from '../harness/harness.types.js';
import type { SkillSetupManifest } from './skill-setup-manifest.js';
import { SkillSetupRunner, formatSize, type DownloadFile, type SkillSetupRunnerDeps } from './skill-setup-runner.service.js';

/** A recorded child-process call. */
interface Call {
	argv: string[];
	env?: NodeJS.ProcessEnv;
}

/** Handler deciding what a fake command does. */
type Handler = (argv: string[], options: RunCommandOptions) => Partial<CommandResult> | undefined;

let tmp: string;
let crewlyHome: string;
let homeDir: string;
let fakeBin: string;
let skillDir: string;
let calls: Call[];
let handler: Handler;

/**
 * Create an executable file.
 *
 * @param dir - Directory
 * @param name - File name
 * @returns Absolute path
 */
function makeExec(dir: string, name: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
	fs.chmodSync(file, 0o755);
	return file;
}

/** Fake RunCommand: records the call, then asks the current handler. */
const fakeRun = async (command: string, args: readonly string[], options: RunCommandOptions = {}): Promise<CommandResult> => {
	const argv = [command, ...args];
	calls.push({ argv, env: options.env });
	const out = handler(argv, options) ?? {};
	return { code: out.code === undefined ? 0 : out.code, stdout: out.stdout ?? '', stderr: out.stderr ?? '', error: out.error };
};

/**
 * Build a runner wired to the temp dirs and fakes.
 *
 * @param overrides - Extra deps
 * @returns Runner
 */
function makeRunner(overrides: SkillSetupRunnerDeps = {}): SkillSetupRunner {
	return new SkillSetupRunner({
		run: fakeRun,
		osFamily: () => 'darwin',
		isRoot: () => false,
		crewlyHome: () => crewlyHome,
		homeDir: () => homeDir,
		env: { PATH: fakeBin },
		extraCommandDirs: [],
		brewCandidates: [],
		pid: 4242,
		isPidAlive: () => false,
		freeBytes: () => null,
		sleep: async () => undefined,
		...overrides,
	});
}

/** Commands run so far, joined for easy matching. */
const ran = (): string[] => calls.map((c) => c.argv.map((a) => path.basename(a) === a ? a : path.basename(a)).join(' '));

const ffmpegStep = {
	id: 'ffmpeg',
	type: 'command' as const,
	check: { commands: ['ffmpeg'] },
	install: { darwin: { brew: ['ffmpeg'] }, debian: { apt: ['ffmpeg'] } },
};

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-setup-'));
	homeDir = path.join(tmp, 'home');
	crewlyHome = path.join(homeDir, '.crewly');
	fakeBin = path.join(tmp, 'bin');
	skillDir = path.join(tmp, 'skill');
	fs.mkdirSync(fakeBin, { recursive: true });
	fs.mkdirSync(skillDir, { recursive: true });
	calls = [];
	handler = () => undefined;
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('SkillSetupRunner — command steps', () => {
	it('reports "already satisfied" and installs nothing when the command is present', async () => {
		makeExec(fakeBin, 'ffmpeg');
		const result = await makeRunner().runSetup({ skillId: 's', skillDir, manifest: { steps: [ffmpegStep] } });
		expect(result.success).toBe(true);
		expect(result.steps[0]).toMatchObject({ id: 'ffmpeg', status: 'satisfied' });
		expect(result.steps[0].message).toMatch(/already satisfied/);
		expect(calls).toEqual([]);
	});

	it('finds commands in $CREWLY_HOME/bin and at listed paths', async () => {
		makeExec(path.join(crewlyHome, 'bin'), 'whisper-cli');
		makeExec(path.join(homeDir, '.flopost', 'whisper'), 'other-cli');
		const manifest: SkillSetupManifest = {
			steps: [
				{ id: 'a', type: 'command', check: { commands: ['whisper-cli'] } },
				{ id: 'b', type: 'command', check: { paths: ['~/.flopost/whisper/other-cli'] } },
			],
		};
		const result = await makeRunner().runSetup({ skillId: 's', skillDir, manifest });
		expect(result.steps.map((s) => s.status)).toEqual(['satisfied', 'satisfied']);
	});

	it('installs with brew on macOS, re-checks, and is idempotent on the next run', async () => {
		const brew = makeExec(fakeBin, 'brew');
		handler = (argv) => {
			if (argv[0] === brew && argv[1] === 'install') makeExec(fakeBin, 'ffmpeg');
			return undefined;
		};
		const runner = makeRunner();
		const first = await runner.runSetup({ skillId: 's', skillDir, manifest: { steps: [ffmpegStep] } });
		expect(first.steps[0].status).toBe('installed');
		expect(calls.map((c) => c.argv)).toEqual([[brew, 'install', 'ffmpeg']]);
		expect(calls[0].env?.HOMEBREW_NO_AUTO_UPDATE).toBe('1');

		calls = [];
		const second = await runner.runSetup({ skillId: 's', skillDir, manifest: { steps: [ffmpegStep] } });
		expect(second.steps[0].status).toBe('satisfied');
		expect(calls).toEqual([]);
	});

	it('fails clearly when Homebrew is missing', async () => {
		const result = await makeRunner().runSetup({ skillId: 's', skillDir, manifest: { steps: [ffmpegStep] } });
		expect(result.success).toBe(false);
		expect(result.steps[0].message).toMatch(/Homebrew is not installed.*brew install ffmpeg/);
	});

	it('fails when the install "succeeds" but the check still fails', async () => {
		makeExec(fakeBin, 'brew');
		const result = await makeRunner().runSetup({ skillId: 's', skillDir, manifest: { steps: [ffmpegStep] } });
		expect(result.steps[0]).toMatchObject({ status: 'failed', message: 'the install finished but the check still fails' });
	});

	it('without root or passwordless sudo, fails at once with the command to run — never prompts', async () => {
		makeExec(fakeBin, 'sudo');
		handler = (argv) => (argv[1] === '-n' && argv[2] === 'true' ? { code: 1, stderr: 'sudo: a password is required' } : undefined);
		const result = await makeRunner({ osFamily: () => 'debian' }).runSetup({ skillId: 's', skillDir, manifest: { steps: [ffmpegStep] } });
		expect(result.success).toBe(false);
		expect(result.steps[0].message).toMatch(/not root and has no passwordless sudo/);
		expect(result.steps[0].message).toMatch(/sudo apt-get install -y ffmpeg/);
		expect(ran().some((c) => c.includes('apt-get'))).toBe(false);
		// the only sudo call was the non-interactive probe
		expect(calls.map((c) => c.argv.slice(1))).toEqual([['-n', 'true']]);
	});

	it('without sudo at all, fails with the same clear message', async () => {
		const result = await makeRunner({ osFamily: () => 'debian' }).runSetup({ skillId: 's', skillDir, manifest: { steps: [ffmpegStep] } });
		expect(result.steps[0].message).toMatch(/no passwordless sudo/);
		expect(calls).toEqual([]);
	});

	it('uses `sudo -n` for apt-get when sudo needs no password', async () => {
		const sudo = makeExec(fakeBin, 'sudo');
		handler = (argv) => {
			if (argv.includes('apt-get') && argv.includes('install')) makeExec(fakeBin, 'ffmpeg');
			return undefined;
		};
		const result = await makeRunner({ osFamily: () => 'debian' }).runSetup({ skillId: 's', skillDir, manifest: { steps: [ffmpegStep] } });
		expect(result.steps[0].status).toBe('installed');
		expect(calls[1].argv).toEqual([sudo, '-n', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', '--no-install-recommends', 'ffmpeg']);
	});

	it('as root, runs apt-get directly and retries after apt-get update', async () => {
		let installs = 0;
		handler = (argv) => {
			if (argv[0] === 'apt-get' && argv[1] === 'install') {
				installs += 1;
				if (installs === 1) return { code: 100, stderr: 'E: Unable to locate package ffmpeg' };
				makeExec(fakeBin, 'ffmpeg');
			}
			return undefined;
		};
		const result = await makeRunner({ osFamily: () => 'debian', isRoot: () => true }).runSetup({ skillId: 's', skillDir, manifest: { steps: [ffmpegStep] } });
		expect(result.steps[0].status).toBe('installed');
		expect(calls.map((c) => c.argv.slice(0, 2).join(' '))).toEqual(['apt-get install', 'apt-get update', 'apt-get install']);
	});

	it('falls back from debian to the linux recipe and runs the skill script with CREWLY_SUDO', async () => {
		fs.writeFileSync(path.join(skillDir, 'install-x.sh'), 'exit 0\n');
		handler = (argv) => {
			if (argv[0] === 'bash' && argv[1].endsWith('install-x.sh')) makeExec(path.join(crewlyHome, 'bin'), 'x');
			return undefined;
		};
		const manifest: SkillSetupManifest = {
			steps: [{ id: 'x', type: 'command', check: { commands: ['x'] }, install: { linux: { script: 'install-x.sh' } } }],
		};
		const result = await makeRunner({ osFamily: () => 'debian' }).runSetup({ skillId: 's', skillDir, manifest });
		expect(result.steps[0].status).toBe('installed');
		const scriptCall = calls.find((c) => c.argv[0] === 'bash');
		expect(scriptCall?.env?.CREWLY_SUDO).toBe('unavailable');
		expect(scriptCall?.env?.SKILL_DIR).toBe(skillDir);
		expect(scriptCall?.env?.CREWLY_BIN_DIR).toBe(path.join(crewlyHome, 'bin'));
	});

	it('fails with the manual hint when the OS has no recipe', async () => {
		const manifest: SkillSetupManifest = {
			steps: [{ id: 'x', type: 'command', check: { commands: ['x'] }, install: { darwin: { brew: ['x'] } }, manualHint: 'Build x yourself.' }],
		};
		const result = await makeRunner({ osFamily: () => 'linux' }).runSetup({ skillId: 's', skillDir, manifest });
		expect(result.steps[0].message).toBe('not installed, and there is no automatic install on linux. Build x yourself.');
	});

	it('uses a shell check when given', async () => {
		handler = (argv) => (argv[0] === 'bash' && argv[1] === '-c' ? { code: 0 } : undefined);
		const manifest: SkillSetupManifest = { steps: [{ id: 'fonts', type: 'command', check: { shell: 'fc-list :lang=zh | grep -q .' } }] };
		const result = await makeRunner().runSetup({ skillId: 's', skillDir, manifest });
		expect(result.steps[0].status).toBe('satisfied');
	});

	it('turns an optional failure into "skipped" and keeps going', async () => {
		makeExec(fakeBin, 'ffmpeg');
		const manifest: SkillSetupManifest = {
			steps: [{ id: 'chrome', type: 'command', optional: true, check: { commands: ['chromium'] } }, ffmpegStep],
		};
		const result = await makeRunner({ osFamily: () => 'linux' }).runSetup({ skillId: 's', skillDir, manifest });
		expect(result.success).toBe(true);
		expect(result.steps.map((s) => s.status)).toEqual(['skipped', 'satisfied']);
	});

	it('stops at the first required failure', async () => {
		const manifest: SkillSetupManifest = { steps: [ffmpegStep, { ...ffmpegStep, id: 'second' }] };
		const result = await makeRunner().runSetup({ skillId: 's', skillDir, manifest });
		expect(result.steps).toHaveLength(1);
		expect(result.error).toMatch(/^ffmpeg: Homebrew is not installed/);
	});
});

describe('SkillSetupRunner — file steps', () => {
	const content = Buffer.from('fake model weights');
	const sha = createHash('sha256').update(content).digest('hex');
	const fileStep = {
		id: 'model',
		type: 'file' as const,
		url: 'https://example.com/model.bin',
		sha256: sha,
		sizeBytes: content.length,
		dest: '~/.cache/whisper-models/model.bin',
		alternatives: ['~/.flopost/whisper/model.bin'],
	};
	/** Download fake that writes `data` and reports its real hash. */
	const downloadOf = (data: Buffer): jest.MockedFunction<DownloadFile> =>
		jest.fn<ReturnType<DownloadFile>, Parameters<DownloadFile>>(async (_url, dest, onBytes) => {
			fs.writeFileSync(dest, data);
			onBytes(data.length);
			return { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
		});

	it('downloads to a temp file, verifies, moves into place, then is satisfied without downloading', async () => {
		const download = downloadOf(content);
		const runner = makeRunner({ download });
		const first = await runner.runSetup({ skillId: 's', skillDir, manifest: { steps: [fileStep] } });
		expect(first.steps[0].status).toBe('installed');
		const dest = path.join(homeDir, '.cache/whisper-models/model.bin');
		expect(fs.readFileSync(dest)).toEqual(content);
		expect(download.mock.calls[0][1]).toBe(`${dest}.part-4242`);
		expect(fs.existsSync(`${dest}.part-4242`)).toBe(false);

		const second = await runner.runSetup({ skillId: 's', skillDir, manifest: { steps: [fileStep] } });
		expect(second.steps[0].status).toBe('satisfied');
		expect(download).toHaveBeenCalledTimes(1);
	});

	it('on a checksum mismatch, fails and deletes the download', async () => {
		const download = downloadOf(Buffer.from('tampered weights!!'));
		const result = await makeRunner({ download }).runSetup({ skillId: 's', skillDir, manifest: { steps: [fileStep] } });
		expect(result.success).toBe(false);
		expect(result.steps[0].message).toMatch(/checksum mismatch — expected sha256 [0-9a-f]{64}.*the download was deleted/);
		const dir = path.join(homeDir, '.cache/whisper-models');
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	it('on a download error, fails and cleans the temp file', async () => {
		const download: DownloadFile = jest.fn(async (_url, dest) => {
			fs.writeFileSync(dest, 'partial');
			throw new Error('HTTP 503 Service Unavailable');
		});
		const result = await makeRunner({ download }).runSetup({ skillId: 's', skillDir, manifest: { steps: [fileStep] } });
		expect(result.steps[0].message).toBe('download failed: HTTP 503 Service Unavailable');
		expect(fs.readdirSync(path.join(homeDir, '.cache/whisper-models'))).toEqual([]);
	});

	it('is satisfied by an existing copy at an alternative path', async () => {
		const alt = path.join(homeDir, '.flopost/whisper/model.bin');
		fs.mkdirSync(path.dirname(alt), { recursive: true });
		fs.writeFileSync(alt, content);
		const download = downloadOf(content);
		const result = await makeRunner({ download }).runSetup({ skillId: 's', skillDir, manifest: { steps: [fileStep] } });
		expect(result.steps[0]).toMatchObject({ status: 'satisfied', message: `already satisfied (${alt})` });
		expect(download).not.toHaveBeenCalled();
	});

	it('re-downloads a truncated copy', async () => {
		const dest = path.join(homeDir, '.cache/whisper-models/model.bin');
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, 'short');
		const result = await makeRunner({ download: downloadOf(content) }).runSetup({ skillId: 's', skillDir, manifest: { steps: [fileStep] } });
		expect(result.steps[0].status).toBe('installed');
		expect(fs.readFileSync(dest)).toEqual(content);
	});

	it('refuses to start when the disk is too full', async () => {
		const download = downloadOf(content);
		const result = await makeRunner({ download, freeBytes: () => 3 }).runSetup({ skillId: 's', skillDir, manifest: { steps: [fileStep] } });
		expect(result.steps[0].message).toMatch(/not enough disk space/);
		expect(download).not.toHaveBeenCalled();
	});
});

describe('SkillSetupRunner — python steps', () => {
	const pyStep = { id: 'py', type: 'python' as const, venv: 'pdf-tools', packages: ['pypdf'], imports: ['pypdf'] };

	it('creates the venv under $CREWLY_HOME/venv/<name>, pip installs, and re-checks the import', async () => {
		const python3 = makeExec(fakeBin, 'python3');
		const venvPy = path.join(crewlyHome, 'venv', 'pdf-tools', 'bin', 'python3');
		let pipDone = false;
		handler = (argv) => {
			if (argv[0] === python3 && argv[1] === '-m' && argv[2] === 'venv') makeExec(path.dirname(venvPy), 'python3');
			if (argv[0] === venvPy && argv[2] === 'pip') pipDone = true;
			if (argv[0] === venvPy && argv[1] === '-c') return { code: pipDone ? 0 : 1 };
			return undefined;
		};
		const result = await makeRunner().runSetup({ skillId: 'pdf-tools', skillDir, manifest: { steps: [pyStep] } });
		expect(result.steps[0].status).toBe('installed');
		expect(calls.map((c) => c.argv.slice(1).join(' '))).toEqual([
			`-m venv ${path.join(crewlyHome, 'venv', 'pdf-tools')}`,
			'-m pip install --disable-pip-version-check --quiet pypdf',
			'-c import pypdf',
		]);
	});

	it('is satisfied when the venv already imports the modules', async () => {
		makeExec(path.join(crewlyHome, 'venv', 'pdf-tools', 'bin'), 'python3');
		const result = await makeRunner().runSetup({ skillId: 'x', skillDir, manifest: { steps: [pyStep] } });
		expect(result.steps[0].status).toBe('satisfied');
		expect(calls).toHaveLength(1);
	});

	it('fails with an install hint when python3 is missing', async () => {
		const result = await makeRunner({ osFamily: () => 'debian' }).runSetup({ skillId: 'x', skillDir, manifest: { steps: [pyStep] } });
		expect(result.steps[0].message).toMatch(/python3 is not installed.*sudo apt-get install -y python3 python3-venv/);
	});
});

describe('SkillSetupRunner — check-only mode', () => {
	it('reports missing steps without installing, locking or logging', async () => {
		const runner = makeRunner();
		const result = await runner.runSetup({ skillId: 's', skillDir, manifest: { steps: [ffmpegStep] }, checkOnly: true });
		expect(result).toMatchObject({ success: false, checkOnly: true, logFile: '' });
		expect(result.steps[0].status).toBe('missing');
		expect(calls).toEqual([]);
		expect(fs.existsSync(path.join(crewlyHome, 'skill-setup'))).toBe(false);
		expect(fs.existsSync(runner.logFileFor('s'))).toBe(false);
	});
});

describe('SkillSetupRunner — optional steps in check mode', () => {
	it('labels a missing optional step and does not count it against success', async () => {
		makeExec(fakeBin, 'ffmpeg');
		const manifest: SkillSetupManifest = { steps: [ffmpegStep, { id: 'chrome', type: 'command', optional: true, check: { commands: ['chromium'] } }] };
		const result = await makeRunner().runSetup({ skillId: 's', skillDir, manifest, checkOnly: true });
		expect(result.success).toBe(true);
		expect(result.steps[1]).toMatchObject({ status: 'missing', message: 'optional: not installed (no automatic install on darwin)' });
	});
});

describe('SkillSetupRunner — log and progress', () => {
	it('logs every step and command output to $CREWLY_HOME/logs/skill-setup/<id>.log', async () => {
		const brew = makeExec(fakeBin, 'brew');
		handler = (argv, options) => {
			if (argv[0] === brew) {
				options.onOutput?.('==> Pouring ffmpeg\n');
				makeExec(fakeBin, 'ffmpeg');
			}
			return undefined;
		};
		const events: string[] = [];
		const runner = makeRunner();
		const result = await runner.runSetup({
			skillId: 'transcribe-audio',
			skillDir,
			manifest: { steps: [ffmpegStep] },
			onProgress: (e) => events.push(`${e.stepId}:${e.phase}`),
		});
		expect(result.logFile).toBe(path.join(crewlyHome, 'logs', 'skill-setup', 'transcribe-audio.log'));
		const log = fs.readFileSync(result.logFile, 'utf-8');
		expect(log).toMatch(/\[transcribe-audio\] \[ffmpeg\] installing: brew install ffmpeg/);
		expect(log).toMatch(/==> Pouring ffmpeg/);
		expect(log).toMatch(/\[ffmpeg\] installed:/);
		expect(events).toEqual(['setup:checking', 'ffmpeg:checking', 'ffmpeg:installing', 'ffmpeg:installed', 'setup:installed']);
	});
});

describe('SkillSetupRunner — concurrency', () => {
	it('shares one run between concurrent calls in the same process', async () => {
		const brew = makeExec(fakeBin, 'brew');
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slowRun = async (command: string, args: readonly string[], options?: RunCommandOptions): Promise<CommandResult> => {
			if (command === brew) {
				await gate;
				makeExec(fakeBin, 'ffmpeg');
			}
			return fakeRun(command, args, options);
		};
		const runner = makeRunner({ run: slowRun });
		const a = runner.runSetup({ skillId: 's', skillDir, manifest: { steps: [ffmpegStep] } });
		const b = runner.runSetup({ skillId: 's', skillDir, manifest: { steps: [ffmpegStep] } });
		expect(a).toBe(b);
		release();
		await a;
		expect(calls.filter((c) => c.argv[0] === brew)).toHaveLength(1);
	});

	it('waits for another live process holding the lock, then runs', async () => {
		makeExec(fakeBin, 'ffmpeg');
		const lock = path.join(crewlyHome, 'skill-setup', 'locks', 's.lock');
		fs.mkdirSync(path.dirname(lock), { recursive: true });
		fs.writeFileSync(lock, JSON.stringify({ pid: 999, startedAt: Date.now() }));
		const sleep = jest.fn(async () => {
			fs.unlinkSync(lock); // the other process finishes
		});
		const events: string[] = [];
		const result = await makeRunner({ isPidAlive: (pid) => pid === 999, sleep }).runSetup({
			skillId: 's',
			skillDir,
			manifest: { steps: [ffmpegStep] },
			onProgress: (e) => events.push(e.message),
		});
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(events.some((m) => m.includes('another setup of s is running (pid 999)'))).toBe(true);
		expect(result.success).toBe(true);
		expect(fs.existsSync(lock)).toBe(false);
	});

	it('reclaims a lock left by a dead process', async () => {
		makeExec(fakeBin, 'ffmpeg');
		const lock = path.join(crewlyHome, 'skill-setup', 'locks', 's.lock');
		fs.mkdirSync(path.dirname(lock), { recursive: true });
		fs.writeFileSync(lock, JSON.stringify({ pid: 999, startedAt: Date.now() }));
		const sleep = jest.fn(async () => undefined);
		const result = await makeRunner({ isPidAlive: () => false, sleep }).runSetup({ skillId: 's', skillDir, manifest: { steps: [ffmpegStep] } });
		expect(result.success).toBe(true);
		expect(sleep).not.toHaveBeenCalled();
	});

	it('gives up with a clear error when the lock is held too long', async () => {
		const lock = path.join(crewlyHome, 'skill-setup', 'locks', 's.lock');
		fs.mkdirSync(path.dirname(lock), { recursive: true });
		fs.writeFileSync(lock, JSON.stringify({ pid: 999, startedAt: Date.now() }));
		let t = Date.now();
		const result = await makeRunner({
			isPidAlive: () => true,
			now: () => t,
			sleep: async () => {
				t += 1000;
			},
			lockWaitMs: 2500,
		}).runSetup({ skillId: 's', skillDir, manifest: { steps: [ffmpegStep] } });
		expect(result.success).toBe(false);
		expect(result.error).toBe('Another setup of s is still running (pid 999); gave up waiting for it');
		expect(fs.existsSync(lock)).toBe(true);
	});
});

describe('formatSize', () => {
	it('formats bytes, KB, MB and GB', () => {
		expect(formatSize(12)).toBe('12 B');
		expect(formatSize(2048)).toBe('2.0 KB');
		expect(formatSize(574041195)).toBe('547.4 MB');
		expect(formatSize(3 * 1024 ** 3)).toBe('3.00 GB');
	});
});
