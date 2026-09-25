/**
 * Skill setup runner — performs a skill's `setup` block, idempotently.
 *
 * Every step is checked first and reported "already satisfied" when it is,
 * so running setup twice is cheap and changes nothing the second time. A step
 * that is missing is installed and then checked again; "installed" is only
 * reported when the re-check passes.
 *
 * Safety properties (specs/skill-auto-install.md):
 * - **Never hangs on a password prompt.** Every child gets a closed stdin;
 *   apt-get runs only as root or through `sudo -n` (passwordless sudo). With
 *   neither, the step fails at once with a message saying what to run by hand.
 * - **Downloads are verified before they are used.** A file is streamed to a
 *   temp name next to its destination, its size and sha256 are compared with
 *   the manifest, and only then renamed into place. A mismatch deletes the
 *   temp file and fails the step.
 * - **One setup per skill at a time.** Concurrent calls in this process share
 *   one run; another process (the CLI while the backend installs) waits on a
 *   lock file under `$CREWLY_HOME/skill-setup/locks/`. A lock whose pid is
 *   gone, or that is older than LOCK_STALE_MS, is reclaimed.
 * - **Everything is logged** to `$CREWLY_HOME/logs/skill-setup/<skill>.log`,
 *   including the full output of every install command.
 *
 * @module services/skill-setup/skill-setup-runner.service
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SKILL_SETUP_CONSTANTS } from '../../constants.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { resolveExecutable, runCommand } from '../harness/harness-exec.utils.js';
import type { RunCommand } from '../harness/harness.types.js';
import {
	DEST_PREFIXES,
	recipeFor,
	type CommandStep,
	type FileStep,
	type OsFamily,
	type PythonStep,
	type SkillSetupManifest,
	type SkillSetupStep,
} from './skill-setup-manifest.js';

/** Final state of one step. */
export type StepStatus = 'satisfied' | 'installed' | 'missing' | 'failed' | 'skipped';

/** Progress phases reported while a step runs, plus its final state. */
export type ProgressPhase = 'checking' | 'installing' | 'downloading' | 'waiting' | StepStatus;

/** A progress event (also written to the log). */
export interface SetupProgressEvent {
	skillId: string;
	/** Step id, or `setup` for whole-run events */
	stepId: string;
	phase: ProgressPhase;
	message: string;
}

/** Outcome of one step. */
export interface StepResult {
	id: string;
	type: SkillSetupStep['type'];
	status: StepStatus;
	message: string;
	optional: boolean;
}

/** Outcome of a setup run. */
export interface SetupResult {
	skillId: string;
	/** True when every required step is satisfied or installed */
	success: boolean;
	/** True when nothing was installed (checks only) */
	checkOnly: boolean;
	steps: StepResult[];
	/** Log file path (empty for check-only runs, which do not log) */
	logFile: string;
	durationMs: number;
	/** Message of the first required step that failed or is missing */
	error?: string;
}

/** Input to {@link SkillSetupRunner.runSetup}. */
export interface RunSetupInput {
	/** Skill id (used for the lock, log and default venv name) */
	skillId: string;
	/** Absolute skill directory (install scripts are resolved inside it) */
	skillDir: string;
	manifest: SkillSetupManifest;
	/** Only check; never install (no lock, no log) */
	checkOnly?: boolean;
	onProgress?: (event: SetupProgressEvent) => void;
}

/** Size and hash of a downloaded file. */
export interface DownloadResult {
	bytes: number;
	sha256: string;
}

/**
 * Download `url` to `destPath`, hashing as it streams.
 *
 * @param url - Source URL
 * @param destPath - File to write (created/truncated)
 * @param onBytes - Called with the running byte count
 * @param stallTimeoutMs - Abort when no bytes arrive for this long
 * @returns Bytes written and their sha256
 * @throws On HTTP errors, stalls and write errors
 */
export type DownloadFile = (
	url: string,
	destPath: string,
	onBytes: (received: number) => void,
	stallTimeoutMs: number,
) => Promise<DownloadResult>;

/** Injectable dependencies. */
export interface SkillSetupRunnerDeps {
	run?: RunCommand;
	download?: DownloadFile;
	osFamily?: () => OsFamily;
	isRoot?: () => boolean;
	crewlyHome?: () => string;
	homeDir?: () => string;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	pid?: number;
	isPidAlive?: (pid: number) => boolean;
	/** Free bytes on the filesystem holding `dir`, or null when unknown */
	freeBytes?: (dir: string) => number | null;
	sleep?: (ms: number) => Promise<void>;
	lockPollMs?: number;
	lockWaitMs?: number;
	/** Directories searched for commands after PATH (default: Homebrew + system dirs) */
	extraCommandDirs?: readonly string[];
	/** Where to look for `brew` when it is not on PATH */
	brewCandidates?: readonly string[];
}

/** How apt-get is run on this machine, or why it cannot be. */
type AptAccess = { command: string; prefix: string[] } | { error: string };

/** The one-line command a person would run for an apt install. */
const aptHint = (packages: string[]): string => `sudo apt-get install -y ${packages.join(' ')}`;

/**
 * Detect the OS family.
 *
 * @returns `darwin`, `debian` (Linux with /etc/debian_version) or `linux`
 */
export function detectOsFamily(): OsFamily {
	if (process.platform === 'darwin') return 'darwin';
	return fs.existsSync(SKILL_SETUP_CONSTANTS.DEBIAN_MARKER_FILE) ? 'debian' : 'linux';
}

/**
 * Whether a pid belongs to a running process.
 *
 * @param pid - Process id
 * @returns True when signal 0 can be delivered (or is refused with EPERM)
 */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Free bytes on the filesystem holding a directory.
 *
 * @param dir - An existing directory
 * @returns Bytes available to this user, or null when statfs is unavailable
 */
function defaultFreeBytes(dir: string): number | null {
	try {
		const stats = fs.statfsSync(dir);
		return Number(stats.bavail) * Number(stats.bsize);
	} catch {
		return null;
	}
}

/**
 * Download with fetch, streaming to disk and hashing on the way.
 *
 * @param url - Source URL (redirects are followed)
 * @param destPath - Destination file
 * @param onBytes - Progress callback (running byte count)
 * @param stallTimeoutMs - Abort after this long without data
 * @returns Bytes and sha256
 * @throws On HTTP errors, stalls and write errors
 */
export const defaultDownload: DownloadFile = async (url, destPath, onBytes, stallTimeoutMs) => {
	const controller = new AbortController();
	let stallTimer: NodeJS.Timeout | null = null;
	const arm = (): void => {
		if (stallTimer) clearTimeout(stallTimer);
		stallTimer = setTimeout(() => controller.abort(new Error(`download stalled for ${stallTimeoutMs} ms`)), stallTimeoutMs);
	};
	arm();
	const hash = createHash('sha256');
	let bytes = 0;
	const out = fs.createWriteStream(destPath);
	try {
		const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
		if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
		const reader = res.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			arm();
			hash.update(value);
			bytes += value.length;
			if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
			onBytes(bytes);
		}
		await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
		return { bytes, sha256: hash.digest('hex') };
	} catch (error) {
		out.destroy();
		const reason = controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : error;
		throw reason instanceof Error ? reason : new Error(String(reason));
	} finally {
		if (stallTimer) clearTimeout(stallTimer);
	}
};

/** Error raised when another process holds a skill's setup lock for too long. */
export class SetupLockTimeoutError extends Error {
	/**
	 * @param skillId - Skill whose lock is held
	 * @param holderPid - Pid recorded in the lock file
	 */
	constructor(
		public readonly skillId: string,
		public readonly holderPid: number,
	) {
		super(`Another setup of ${skillId} is still running (pid ${holderPid}); gave up waiting for it`);
		this.name = 'SetupLockTimeoutError';
	}
}

/** Runs setup manifests. */
export class SkillSetupRunner {
	private readonly run: RunCommand;
	private readonly download: DownloadFile;
	private readonly osFamily: () => OsFamily;
	private readonly isRoot: () => boolean;
	private readonly crewlyHome: () => string;
	private readonly homeDir: () => string;
	private readonly env: NodeJS.ProcessEnv;
	private readonly now: () => number;
	private readonly pid: number;
	private readonly pidAlive: (pid: number) => boolean;
	private readonly freeBytes: (dir: string) => number | null;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly lockPollMs: number;
	private readonly lockWaitMs: number;
	private readonly extraCommandDirs: readonly string[];
	private readonly brewCandidates: readonly string[];
	/** Setup runs in flight in this process, by skill id */
	private readonly inflight = new Map<string, Promise<SetupResult>>();

	/**
	 * @param deps - Injectable dependencies (all optional)
	 */
	constructor(deps: SkillSetupRunnerDeps = {}) {
		this.run = deps.run ?? runCommand;
		this.download = deps.download ?? defaultDownload;
		this.osFamily = deps.osFamily ?? detectOsFamily;
		this.isRoot = deps.isRoot ?? (() => typeof process.getuid === 'function' && process.getuid() === 0);
		this.crewlyHome = deps.crewlyHome ?? getCrewlyHomePath;
		this.homeDir = deps.homeDir ?? os.homedir;
		this.env = deps.env ?? process.env;
		this.now = deps.now ?? Date.now;
		this.pid = deps.pid ?? process.pid;
		this.pidAlive = deps.isPidAlive ?? isPidAlive;
		this.freeBytes = deps.freeBytes ?? defaultFreeBytes;
		this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.lockPollMs = deps.lockPollMs ?? SKILL_SETUP_CONSTANTS.LOCK_POLL_MS;
		this.lockWaitMs = deps.lockWaitMs ?? SKILL_SETUP_CONSTANTS.LOCK_WAIT_MS;
		this.extraCommandDirs = deps.extraCommandDirs ?? SKILL_SETUP_CONSTANTS.EXTRA_COMMAND_DIRS;
		this.brewCandidates = deps.brewCandidates ?? SKILL_SETUP_CONSTANTS.BREW_CANDIDATES;
	}

	/**
	 * Path of a skill's setup log.
	 *
	 * @param skillId - Skill id
	 * @returns `$CREWLY_HOME/logs/skill-setup/<id>.log`
	 */
	logFileFor(skillId: string): string {
		return path.join(this.crewlyHome(), SKILL_SETUP_CONSTANTS.LOG_DIR, `${skillId}.log`);
	}

	/**
	 * Expand `~/` and `$CREWLY_HOME/` in a manifest path.
	 *
	 * @param p - Manifest path
	 * @returns Absolute path
	 */
	expandPath(p: string): string {
		if (p.startsWith(DEST_PREFIXES[0])) return path.join(this.homeDir(), p.slice(DEST_PREFIXES[0].length));
		if (p.startsWith(DEST_PREFIXES[1])) return path.join(this.crewlyHome(), p.slice(DEST_PREFIXES[1].length));
		return p;
	}

	/**
	 * Perform (or only check) a setup manifest.
	 *
	 * Concurrent calls for the same skill in this process share one run.
	 *
	 * @param input - Skill id, directory, manifest, mode and progress callback
	 * @returns Per-step results; never rejects for step failures
	 *
	 * @example
	 * ```ts
	 * const result = await runner.runSetup({ skillId: 'transcribe-audio', skillDir, manifest });
	 * if (!result.success) console.error(result.error, 'see', result.logFile);
	 * ```
	 */
	runSetup(input: RunSetupInput): Promise<SetupResult> {
		if (input.checkOnly) return this.execute(input);
		const running = this.inflight.get(input.skillId);
		if (running) return running;
		const promise = this.execute(input).finally(() => this.inflight.delete(input.skillId));
		this.inflight.set(input.skillId, promise);
		return promise;
	}

	/**
	 * Run every step (under the lock unless check-only).
	 *
	 * @param input - Run input
	 * @returns The result
	 */
	private async execute(input: RunSetupInput): Promise<SetupResult> {
		const started = this.now();
		const checkOnly = input.checkOnly === true;
		const logFile = checkOnly ? '' : this.logFileFor(input.skillId);
		const emit = (stepId: string, phase: ProgressPhase, message: string): void => {
			if (!checkOnly) this.log(logFile, input.skillId, stepId, `${phase}: ${message}`);
			input.onProgress?.({ skillId: input.skillId, stepId, phase, message });
		};
		const finish = (steps: StepResult[], error?: string): SetupResult => {
			const firstProblem = steps.find((s) => !s.optional && (s.status === 'failed' || s.status === 'missing'));
			const result: SetupResult = {
				skillId: input.skillId,
				success: !error && !firstProblem,
				checkOnly,
				steps,
				logFile,
				durationMs: this.now() - started,
				...(error || firstProblem ? { error: error ?? `${firstProblem?.id}: ${firstProblem?.message}` } : {}),
			};
			if (!checkOnly) emit('setup', result.success ? 'installed' : 'failed', result.success ? `done in ${Math.round(result.durationMs / 1000)}s` : (result.error ?? 'failed'));
			return result;
		};

		let release: (() => void) | null = null;
		if (!checkOnly) {
			emit('setup', 'checking', `setup of ${input.skillId} started (os=${this.osFamily()}, pid=${this.pid})`);
			try {
				release = await this.acquireLock(input.skillId, (message) => emit('setup', 'waiting', message));
			} catch (error) {
				return finish([], error instanceof Error ? error.message : String(error));
			}
		}

		const steps: StepResult[] = [];
		try {
			for (const step of input.manifest.steps) {
				emit(step.id, 'checking', step.description ?? step.type);
				let result: StepResult;
				try {
					result = await this.runStep(step, input, emit);
				} catch (error) {
					result = this.stepResult(step, 'failed', error instanceof Error ? error.message : String(error));
				}
				if (result.status === 'failed' && result.optional) {
					result = { ...result, status: 'skipped', message: `optional, skipped: ${result.message}` };
				} else if (result.status === 'missing' && result.optional) {
					result = { ...result, message: `optional: ${result.message}` };
				}
				steps.push(result);
				emit(step.id, result.status, result.message);
				if (!checkOnly && result.status === 'failed') break;
			}
		} finally {
			release?.();
		}
		return finish(steps);
	}

	/**
	 * Dispatch one step.
	 *
	 * @param step - Step
	 * @param input - Run input
	 * @param emit - Progress emitter
	 * @returns Step result
	 */
	private runStep(
		step: SkillSetupStep,
		input: RunSetupInput,
		emit: (stepId: string, phase: ProgressPhase, message: string) => void,
	): Promise<StepResult> {
		switch (step.type) {
			case 'command':
				return this.runCommandStep(step, input, emit);
			case 'file':
				return this.runFileStep(step, input, emit);
			case 'python':
				return this.runPythonStep(step, input, emit);
		}
	}

	/**
	 * Build a step result.
	 *
	 * @param step - Step
	 * @param status - Final status
	 * @param message - Message
	 * @returns The result
	 */
	private stepResult(step: SkillSetupStep, status: StepStatus, message: string): StepResult {
		return { id: step.id, type: step.type, status, message, optional: step.optional === true };
	}

	/**
	 * PATH used for checks and installs: `$CREWLY_HOME/bin`, the process PATH,
	 * then the usual system and Homebrew dirs (a backend started by launchd or
	 * systemd often lacks /opt/homebrew/bin).
	 *
	 * @returns PATH string
	 */
	private searchPath(): string {
		const entries = [
			path.join(this.crewlyHome(), SKILL_SETUP_CONSTANTS.BIN_DIR),
			...(this.env.PATH ?? '').split(path.delimiter),
			...this.extraCommandDirs,
		].filter((e) => e.length > 0);
		return [...new Set(entries)].join(path.delimiter);
	}

	/**
	 * Environment for child processes.
	 *
	 * @param extra - Additional variables
	 * @returns Environment
	 */
	private childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
		return {
			...this.env,
			PATH: this.searchPath(),
			CREWLY_HOME: this.crewlyHome(),
			CREWLY_BIN_DIR: path.join(this.crewlyHome(), SKILL_SETUP_CONSTANTS.BIN_DIR),
			HOMEBREW_NO_AUTO_UPDATE: '1',
			HOMEBREW_NO_ENV_HINTS: '1',
			NONINTERACTIVE: '1',
			DEBIAN_FRONTEND: 'noninteractive',
			...extra,
		};
	}

	/**
	 * Run a command, streaming its output into the log.
	 *
	 * @param logFile - Log file ('' = do not log)
	 * @param skillId - Skill id
	 * @param stepId - Step id
	 * @param command - Executable
	 * @param args - Arguments
	 * @param timeoutMs - Timeout
	 * @param env - Environment
	 * @returns Exit code and combined output
	 */
	private async exec(
		logFile: string,
		skillId: string,
		stepId: string,
		command: string,
		args: string[],
		timeoutMs: number,
		env: NodeJS.ProcessEnv = this.childEnv(),
	): Promise<{ ok: boolean; output: string }> {
		if (logFile) this.log(logFile, skillId, stepId, `$ ${[command, ...args].join(' ')}`);
		const result = await this.run(command, args, {
			env,
			timeoutMs,
			onOutput: logFile ? (chunk) => this.appendRaw(logFile, chunk) : undefined,
		});
		const output = `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`.trim();
		return { ok: result.code === 0, output };
	}

	/**
	 * What satisfies a command check, if anything.
	 *
	 * @param step - Command step
	 * @returns A description of the match, or null
	 */
	private async commandPresent(step: CommandStep): Promise<string | null> {
		const searchPath = this.searchPath();
		for (const command of step.check.commands ?? []) {
			const found = resolveExecutable(command, searchPath);
			if (found) return found;
		}
		for (const p of step.check.paths ?? []) {
			const abs = this.expandPath(p);
			try {
				fs.accessSync(abs, fs.constants.X_OK);
				return abs;
			} catch {
				// not there — try the next one
			}
		}
		if (step.check.shell) {
			const res = await this.run('bash', ['-c', step.check.shell], {
				env: this.childEnv(),
				timeoutMs: SKILL_SETUP_CONSTANTS.CHECK_TIMEOUT_MS,
			});
			if (res.code === 0) return 'check passed';
		}
		return null;
	}

	/**
	 * How this process can run apt-get.
	 *
	 * @param packages - Packages (for the hint)
	 * @returns The command + argument prefix, or an error message
	 */
	private async aptAccess(packages: string[]): Promise<AptAccess> {
		if (this.isRoot()) return { command: 'apt-get', prefix: [] };
		const sudo = resolveExecutable('sudo', this.searchPath());
		if (sudo) {
			const probe = await this.run(sudo, ['-n', 'true'], { env: this.childEnv(), timeoutMs: SKILL_SETUP_CONSTANTS.CHECK_TIMEOUT_MS });
			if (probe.code === 0) return { command: sudo, prefix: ['-n', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get'] };
		}
		return {
			error:
				`installing ${packages.join(', ')} needs root (apt-get), and this process is not root and has no passwordless sudo, ` +
				`so Crewly did not try (it would hang on a password prompt). Ask the owner to run: ${aptHint(packages)} — then run the setup again.`,
		};
	}

	/**
	 * The value handed to install scripts in CREWLY_SUDO: '' (root),
	 * 'sudo -n' (passwordless sudo) or 'unavailable'.
	 *
	 * @returns Sudo mode
	 */
	private async sudoMode(): Promise<string> {
		if (this.isRoot()) return '';
		const sudo = resolveExecutable('sudo', this.searchPath());
		if (!sudo) return 'unavailable';
		const probe = await this.run(sudo, ['-n', 'true'], { env: this.childEnv(), timeoutMs: SKILL_SETUP_CONSTANTS.CHECK_TIMEOUT_MS });
		return probe.code === 0 ? 'sudo -n' : 'unavailable';
	}

	/**
	 * Check, install and re-check a command dependency.
	 *
	 * @param step - Command step
	 * @param input - Run input
	 * @param emit - Progress emitter
	 * @returns Step result
	 */
	private async runCommandStep(
		step: CommandStep,
		input: RunSetupInput,
		emit: (stepId: string, phase: ProgressPhase, message: string) => void,
	): Promise<StepResult> {
		const present = await this.commandPresent(step);
		if (present) return this.stepResult(step, 'satisfied', `already satisfied (${present})`);
		const family = this.osFamily();
		const recipe = recipeFor(step, family);
		if (input.checkOnly) return this.stepResult(step, 'missing', `not installed${recipe ? '' : ` (no automatic install on ${family})`}`);
		if (!recipe) {
			return this.stepResult(step, 'failed', `not installed, and there is no automatic install on ${family}${step.manualHint ? `. ${step.manualHint}` : ''}`);
		}
		const logFile = this.logFileFor(input.skillId);

		if (recipe.brew || recipe.brewCask) {
			if (this.isRoot()) return this.stepResult(step, 'failed', 'Homebrew refuses to run as root; run the setup as the normal user');
			const brew = resolveExecutable('brew', this.searchPath()) ?? this.brewCandidates.find((c) => fs.existsSync(c));
			if (!brew) {
				const pkgs = [...(recipe.brew ?? []), ...(recipe.brewCask ?? [])].join(' ');
				return this.stepResult(step, 'failed', `Homebrew is not installed. Install it from https://brew.sh, then run: brew install ${pkgs}`);
			}
			if (recipe.brew?.length) {
				emit(step.id, 'installing', `brew install ${recipe.brew.join(' ')}`);
				const res = await this.exec(logFile, input.skillId, step.id, brew, ['install', ...recipe.brew], SKILL_SETUP_CONSTANTS.PACKAGE_INSTALL_TIMEOUT_MS);
				if (!res.ok) return this.stepResult(step, 'failed', `brew install ${recipe.brew.join(' ')} failed: ${tail(res.output)}`);
			}
			if (recipe.brewCask?.length) {
				emit(step.id, 'installing', `brew install --cask ${recipe.brewCask.join(' ')}`);
				const res = await this.exec(logFile, input.skillId, step.id, brew, ['install', '--cask', ...recipe.brewCask], SKILL_SETUP_CONSTANTS.PACKAGE_INSTALL_TIMEOUT_MS);
				if (!res.ok) return this.stepResult(step, 'failed', `brew install --cask ${recipe.brewCask.join(' ')} failed: ${tail(res.output)}`);
			}
		}

		if (recipe.apt?.length) {
			const access = await this.aptAccess(recipe.apt);
			if ('error' in access) return this.stepResult(step, 'failed', access.error);
			emit(step.id, 'installing', `apt-get install -y ${recipe.apt.join(' ')}`);
			const installArgs = [...access.prefix, 'install', '-y', '--no-install-recommends', ...recipe.apt];
			let res = await this.exec(logFile, input.skillId, step.id, access.command, installArgs, SKILL_SETUP_CONSTANTS.PACKAGE_INSTALL_TIMEOUT_MS);
			if (!res.ok) {
				// A fresh machine or container often has no package lists yet.
				emit(step.id, 'installing', 'apt-get update, then retry');
				await this.exec(logFile, input.skillId, step.id, access.command, [...access.prefix, 'update'], SKILL_SETUP_CONSTANTS.PACKAGE_INSTALL_TIMEOUT_MS);
				res = await this.exec(logFile, input.skillId, step.id, access.command, installArgs, SKILL_SETUP_CONSTANTS.PACKAGE_INSTALL_TIMEOUT_MS);
			}
			if (!res.ok) return this.stepResult(step, 'failed', `apt-get install ${recipe.apt.join(' ')} failed: ${tail(res.output)}`);
		}

		if (recipe.script) {
			const script = path.join(input.skillDir, recipe.script);
			if (!fs.existsSync(script)) return this.stepResult(step, 'failed', `install script ${recipe.script} is missing from ${input.skillDir}`);
			emit(step.id, 'installing', `bash ${recipe.script}`);
			const env = this.childEnv({ SKILL_DIR: input.skillDir, CREWLY_SUDO: await this.sudoMode() });
			fs.mkdirSync(path.join(this.crewlyHome(), SKILL_SETUP_CONSTANTS.BIN_DIR), { recursive: true });
			const res = await this.exec(logFile, input.skillId, step.id, 'bash', [script], SKILL_SETUP_CONSTANTS.SCRIPT_INSTALL_TIMEOUT_MS, env);
			if (!res.ok) return this.stepResult(step, 'failed', `${recipe.script} failed: ${tail(res.output)}`);
		}

		const after = await this.commandPresent(step);
		return after
			? this.stepResult(step, 'installed', `installed (${after})`)
			: this.stepResult(step, 'failed', 'the install finished but the check still fails');
	}

	/**
	 * Check, download, verify and place a file.
	 *
	 * @param step - File step
	 * @param input - Run input
	 * @param emit - Progress emitter
	 * @returns Step result
	 */
	private async runFileStep(
		step: FileStep,
		input: RunSetupInput,
		emit: (stepId: string, phase: ProgressPhase, message: string) => void,
	): Promise<StepResult> {
		const dest = this.expandPath(step.dest);
		for (const candidate of [dest, ...(step.alternatives ?? []).map((p) => this.expandPath(p))]) {
			try {
				// Size, not sha256: hashing a 500 MB model on every probe is too slow.
				// The sha256 was checked when Crewly downloaded it.
				if (fs.statSync(candidate).size === step.sizeBytes) return this.stepResult(step, 'satisfied', `already satisfied (${candidate})`);
			} catch {
				// not there — try the next one
			}
		}
		if (input.checkOnly) return this.stepResult(step, 'missing', `not downloaded (${formatSize(step.sizeBytes)})`);

		const dir = path.dirname(dest);
		fs.mkdirSync(dir, { recursive: true });
		const free = this.freeBytes(dir);
		const needed = Math.ceil(step.sizeBytes * (1 + SKILL_SETUP_CONSTANTS.DOWNLOAD_FREE_SPACE_MARGIN));
		if (free !== null && free < needed) {
			return this.stepResult(step, 'failed', `not enough disk space in ${dir}: need ${formatSize(needed)}, have ${formatSize(free)}`);
		}

		const tmp = `${dest}.part-${this.pid}`;
		emit(step.id, 'downloading', `${step.url} (${formatSize(step.sizeBytes)}) → ${dest}`);
		let lastStep = -1;
		let result: DownloadResult;
		try {
			result = await this.download(
				step.url,
				tmp,
				(received) => {
					const pct = Math.floor((received / step.sizeBytes) * 100);
					const bucket = Math.floor(pct / SKILL_SETUP_CONSTANTS.DOWNLOAD_PROGRESS_STEP_PERCENT);
					if (bucket > lastStep) {
						lastStep = bucket;
						emit(step.id, 'downloading', `${Math.min(pct, 100)}% (${formatSize(received)})`);
					}
				},
				SKILL_SETUP_CONSTANTS.DOWNLOAD_STALL_TIMEOUT_MS,
			);
		} catch (error) {
			removeQuietly(tmp);
			return this.stepResult(step, 'failed', `download failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (result.bytes !== step.sizeBytes || result.sha256 !== step.sha256) {
			removeQuietly(tmp);
			return this.stepResult(
				step,
				'failed',
				`checksum mismatch — expected sha256 ${step.sha256} (${step.sizeBytes} bytes), got ${result.sha256} (${result.bytes} bytes); the download was deleted`,
			);
		}
		fs.renameSync(tmp, dest);
		return this.stepResult(step, 'installed', `downloaded and verified (${dest})`);
	}

	/**
	 * Check, create and fill a Python virtualenv.
	 *
	 * @param step - Python step
	 * @param input - Run input
	 * @param emit - Progress emitter
	 * @returns Step result
	 */
	private async runPythonStep(
		step: PythonStep,
		input: RunSetupInput,
		emit: (stepId: string, phase: ProgressPhase, message: string) => void,
	): Promise<StepResult> {
		const venvDir = path.join(this.crewlyHome(), SKILL_SETUP_CONSTANTS.VENV_DIR, step.venv ?? input.skillId);
		const py = path.join(venvDir, 'bin', 'python3');
		const importsOk = async (): Promise<boolean> => {
			if (!fs.existsSync(py)) return false;
			const res = await this.run(py, ['-c', `import ${step.imports.join(', ')}`], {
				env: this.childEnv(),
				timeoutMs: SKILL_SETUP_CONSTANTS.CHECK_TIMEOUT_MS,
			});
			return res.code === 0;
		};
		if (await importsOk()) return this.stepResult(step, 'satisfied', `already satisfied (${venvDir})`);
		if (input.checkOnly) return this.stepResult(step, 'missing', `Python packages missing: ${step.packages.join(' ')}`);

		const logFile = this.logFileFor(input.skillId);
		if (!fs.existsSync(py)) {
			const python3 = resolveExecutable('python3', this.searchPath());
			if (!python3) {
				const hint = this.osFamily() === 'darwin' ? 'brew install python' : aptHint(['python3', 'python3-venv']);
				return this.stepResult(step, 'failed', `python3 is not installed. Install it (${hint}) and run the setup again`);
			}
			emit(step.id, 'installing', `python3 -m venv ${venvDir}`);
			const res = await this.exec(logFile, input.skillId, step.id, python3, ['-m', 'venv', venvDir], SKILL_SETUP_CONSTANTS.PACKAGE_INSTALL_TIMEOUT_MS);
			if (!res.ok) {
				const hint = this.osFamily() === 'darwin' ? '' : ` (on Debian/Ubuntu: ${aptHint(['python3-venv'])})`;
				return this.stepResult(step, 'failed', `could not create the venv${hint}: ${tail(res.output)}`);
			}
		}
		emit(step.id, 'installing', `pip install ${step.packages.join(' ')}`);
		const pip = await this.exec(
			logFile,
			input.skillId,
			step.id,
			py,
			['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', ...step.packages],
			SKILL_SETUP_CONSTANTS.PACKAGE_INSTALL_TIMEOUT_MS,
		);
		if (!pip.ok) return this.stepResult(step, 'failed', `pip install failed: ${tail(pip.output)}`);
		return (await importsOk())
			? this.stepResult(step, 'installed', `installed into ${venvDir}`)
			: this.stepResult(step, 'failed', `pip finished but \`import ${step.imports.join(', ')}\` still fails`);
	}

	/**
	 * Take the per-skill lock file, waiting while another live process holds it.
	 *
	 * @param skillId - Skill id
	 * @param onWait - Called once when the lock is busy
	 * @returns A release function
	 * @throws SetupLockTimeoutError when the holder does not finish in lockWaitMs
	 */
	private async acquireLock(skillId: string, onWait: (message: string) => void): Promise<() => void> {
		const dir = path.join(this.crewlyHome(), SKILL_SETUP_CONSTANTS.STATE_DIR, SKILL_SETUP_CONSTANTS.LOCKS_SUBDIR);
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `${skillId}.lock`);
		const deadline = this.now() + this.lockWaitMs;
		let announced = false;
		for (;;) {
			try {
				const fd = fs.openSync(file, 'wx');
				fs.writeSync(fd, JSON.stringify({ pid: this.pid, startedAt: this.now() }));
				fs.closeSync(fd);
				return () => {
					try {
						const holder = JSON.parse(fs.readFileSync(file, 'utf-8')) as { pid?: number };
						if (holder.pid === this.pid) fs.unlinkSync(file);
					} catch {
						// already gone
					}
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			}
			let holder: { pid?: number; startedAt?: number } | null = null;
			try {
				holder = JSON.parse(fs.readFileSync(file, 'utf-8')) as { pid?: number; startedAt?: number };
			} catch {
				holder = null;
			}
			const stale =
				!holder ||
				typeof holder.pid !== 'number' ||
				!this.pidAlive(holder.pid) ||
				typeof holder.startedAt !== 'number' ||
				this.now() - holder.startedAt > SKILL_SETUP_CONSTANTS.LOCK_STALE_MS;
			if (stale) {
				removeQuietly(file);
				continue;
			}
			const holderPid = holder?.pid ?? -1;
			if (this.now() >= deadline) throw new SetupLockTimeoutError(skillId, holderPid);
			if (!announced) {
				announced = true;
				onWait(`another setup of ${skillId} is running (pid ${holderPid}); waiting for it to finish`);
			}
			await this.sleep(this.lockPollMs);
		}
	}

	/**
	 * Append a timestamped line to a log file.
	 *
	 * @param logFile - Log file
	 * @param skillId - Skill id
	 * @param stepId - Step id
	 * @param message - Message
	 */
	private log(logFile: string, skillId: string, stepId: string, message: string): void {
		this.appendRaw(logFile, `[${new Date(this.now()).toISOString()}] [${skillId}] [${stepId}] ${message}\n`);
	}

	/**
	 * Append text to a log file (best effort).
	 *
	 * @param logFile - Log file
	 * @param text - Text
	 */
	private appendRaw(logFile: string, text: string): void {
		try {
			fs.mkdirSync(path.dirname(logFile), { recursive: true });
			fs.appendFileSync(logFile, text);
		} catch {
			// Logging must never break a setup.
		}
	}
}

/**
 * Last part of command output, for a one-line failure message.
 *
 * @param output - Combined output
 * @returns Up to the last 300 characters, single-spaced
 */
function tail(output: string): string {
	const flat = output.replace(/\s+/g, ' ').trim();
	return flat.length > 300 ? `…${flat.slice(-300)}` : flat || '(no output)';
}

/**
 * Human-readable byte size.
 *
 * @param bytes - Size
 * @returns e.g. "547.4 MB"
 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Delete a file, ignoring errors.
 *
 * @param file - Path
 */
function removeQuietly(file: string): void {
	try {
		fs.unlinkSync(file);
	} catch {
		// already gone
	}
}

let runnerSingleton: SkillSetupRunner | null = null;

/**
 * The process-wide runner (shares in-flight runs across callers).
 *
 * @returns The runner
 */
export function getSkillSetupRunner(): SkillSetupRunner {
	if (!runnerSingleton) runnerSingleton = new SkillSetupRunner();
	return runnerSingleton;
}
