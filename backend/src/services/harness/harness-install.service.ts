/**
 * Harness install as an async job with a log.
 *
 * - npm harnesses: `npm install -g <pkg>@latest`. When the global prefix is
 *   not writable (EACCES / EPERM), the install is retried once under the
 *   user-owned prefix `<crewlyHome>/npm-global` (`npm install -g --prefix …`);
 *   its `bin` dir is on the PATH of everything Crewly spawns
 *   (harness-exec.utils). No sudo, no shell profile edits.
 * - Script harnesses (Antigravity CLI, which has no npm package): the vendor's
 *   official installer is downloaded over https from exactly the registry URL
 *   (`https://antigravity.google/cli/install.sh`; redirects refused, size
 *   capped, must be a `#!` script), written to a private temp dir and run
 *   with bash — the same as the documented `curl -fsSL … | bash`. The
 *   installer verifies the binary's SHA-512 itself and puts `agy` in
 *   `~/.local/bin`, which is on the harness PATH. When the binary is already
 *   installed the job runs its own updater (`agy update`) instead.
 *
 * One install runs per harness at a time: starting a second one while the
 * first is running returns the running job.
 *
 * @module services/harness/harness-install.service
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HARNESS_CONSTANTS } from '../../constants.js';
import { buildHarnessPath, buildNpmPath, getUserNpmPrefix, resolveExecutable, runCommand } from './harness-exec.utils.js';
import { getHarnessDefinition, type HarnessDefinition, type ScriptInstallSpec } from './harness-registry.js';
import { SILENT_HARNESS_LOGGER, type HarnessId, type HarnessLogger, type InstallJob, type RunCommand } from './harness.types.js';

/** Downloads an installer script; rejects on any failure. */
export type FetchScript = (url: string) => Promise<string>;

/**
 * Whether a URL is one Crewly may download an installer from: https, and
 * exactly the URL the registry names.
 *
 * @param url - Candidate URL
 * @param spec - The harness's script install spec
 * @returns True when allowed
 */
export function isAllowedInstallerUrl(url: string, spec: ScriptInstallSpec): boolean {
	try {
		const parsed = new URL(url);
		const expected = new URL(spec.scriptUrl);
		return parsed.protocol === 'https:' && parsed.href === expected.href;
	} catch {
		return false;
	}
}

/**
 * Default installer download: https only, no redirects, size-capped.
 *
 * @param url - Installer URL
 * @returns Script text
 * @throws Error on a non-2xx status, a redirect, a timeout or an oversized body
 */
export const defaultFetchScript: FetchScript = async (url) => {
	const response = await fetch(url, {
		redirect: 'error',
		signal: AbortSignal.timeout(HARNESS_CONSTANTS.ANTIGRAVITY.INSTALL_SCRIPT_FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
	const text = await response.text();
	if (Buffer.byteLength(text, 'utf8') > HARNESS_CONSTANTS.ANTIGRAVITY.INSTALL_SCRIPT_MAX_BYTES) {
		throw new Error('Download failed: installer is larger than expected');
	}
	return text;
};

/** Injectable dependencies. */
export interface HarnessInstallDeps {
	run?: RunCommand;
	env?: NodeJS.ProcessEnv;
	/** Creates the user prefix dir */
	mkdirp?: (dir: string) => void;
	now?: () => number;
	idFactory?: () => string;
	logger?: HarnessLogger;
	/** Called after a successful install (e.g. to refresh status caches) */
	onInstalled?: (harnessId: HarnessId) => void;
	/** Downloads a vendor installer script (script harnesses) */
	fetchScript?: FetchScript;
	/** PATH lookup of an installed harness binary (script harnesses update in place) */
	resolveCommand?: (command: string) => string | null;
}

/** Error with a machine-readable code, for the REST layer. */
export class HarnessInstallError extends Error {
	/**
	 * @param code - `unknown_harness` or `job_not_found`
	 * @param message - Human-readable message
	 */
	constructor(
		public readonly code: 'unknown_harness' | 'job_not_found',
		message: string,
	) {
		super(message);
		this.name = 'HarnessInstallError';
	}
}

/** Internal job record. */
interface JobRecord extends InstallJob {
	finishedAt: number | null;
	/** Settles when the job finishes (set right after the record is created) */
	done: Promise<InstallJob> | null;
}

/**
 * Whether npm output says the global prefix is not writable.
 *
 * @param output - npm stdout + stderr
 * @returns True for EACCES / EPERM / permission denied
 */
export function isPermissionError(output: string): boolean {
	const lower = output.toLowerCase();
	return HARNESS_CONSTANTS.PERMISSION_ERROR_PATTERNS.some((pattern) => lower.includes(pattern.toLowerCase()));
}

/** Runs and tracks harness install jobs. */
export class HarnessInstallService {
	private readonly run: RunCommand;
	private readonly env: NodeJS.ProcessEnv;
	private readonly mkdirp: (dir: string) => void;
	private readonly now: () => number;
	private readonly idFactory: () => string;
	private readonly logger: HarnessLogger;
	private readonly onInstalled?: (harnessId: HarnessId) => void;
	private readonly fetchScript: FetchScript;
	private readonly resolveCommand: (command: string) => string | null;
	private readonly jobs = new Map<string, JobRecord>();

	/**
	 * @param deps - Injectable dependencies (all optional)
	 */
	constructor(deps: HarnessInstallDeps = {}) {
		this.run = deps.run ?? runCommand;
		this.env = deps.env ?? process.env;
		this.mkdirp = deps.mkdirp ?? ((dir) => fs.mkdirSync(dir, { recursive: true }));
		this.now = deps.now ?? Date.now;
		this.idFactory = deps.idFactory ?? randomUUID;
		this.logger = deps.logger ?? SILENT_HARNESS_LOGGER;
		this.onInstalled = deps.onInstalled;
		this.fetchScript = deps.fetchScript ?? defaultFetchScript;
		this.resolveCommand = deps.resolveCommand ?? ((command) => resolveExecutable(command, buildHarnessPath(this.env.PATH)));
	}

	/**
	 * Start installing (or updating) a harness.
	 *
	 * @param harnessId - Harness id
	 * @returns The new job, or the job already running for this harness
	 * @throws HarnessInstallError `unknown_harness`
	 */
	startInstall(harnessId: string): InstallJob {
		const def = getHarnessDefinition(harnessId);
		if (!def) throw new HarnessInstallError('unknown_harness', `Unknown harness: ${harnessId}`);
		this.pruneFinished();
		const running = [...this.jobs.values()].find((job) => job.harnessId === def.id && job.state === 'running');
		if (running) return this.toPublic(running);

		const record: JobRecord = {
			jobId: this.idFactory(),
			harnessId: def.id,
			state: 'running',
			log: '',
			usedUserPrefix: false,
			finishedAt: null,
			done: null,
		};
		this.jobs.set(record.jobId, record);
		record.done = this.execute(record, def);
		return this.toPublic(record);
	}

	/**
	 * Look up a job.
	 *
	 * @param jobId - Job id
	 * @returns The job
	 * @throws HarnessInstallError `job_not_found`
	 */
	getJob(jobId: string): InstallJob {
		const record = this.jobs.get(jobId);
		if (!record) throw new HarnessInstallError('job_not_found', `Install job not found: ${jobId}`);
		return this.toPublic(record);
	}

	/**
	 * Wait for a job to finish (CLI).
	 *
	 * @param jobId - Job id
	 * @returns The finished job
	 * @throws HarnessInstallError `job_not_found`
	 */
	async waitForJob(jobId: string): Promise<InstallJob> {
		const record = this.jobs.get(jobId);
		if (!record) throw new HarnessInstallError('job_not_found', `Install job not found: ${jobId}`);
		if (record.done) await record.done;
		return this.toPublic(record);
	}

	/**
	 * Run the install for a harness and record the outcome.
	 *
	 * @param record - Job record (mutated)
	 * @param def - Harness definition
	 * @returns The finished job
	 */
	private async execute(record: JobRecord, def: HarnessDefinition): Promise<InstallJob> {
		try {
			const ok = def.install.kind === 'npm'
				? await this.installNpm(record, def.install.npmPackage)
				: await this.installScript(record, def, def.install);
			record.state = ok ? 'succeeded' : 'failed';
			this.append(record, ok ? '\nInstalled.\n' : '\nInstall failed.\n');
			if (ok) this.onInstalled?.(record.harnessId);
		} catch (error) {
			record.state = 'failed';
			this.append(record, `\n${error instanceof Error ? error.message : String(error)}\n`);
		}
		record.finishedAt = this.now();
		this.logger.info('Harness install finished', { harnessId: record.harnessId, state: record.state, usedUserPrefix: record.usedUserPrefix });
		return this.toPublic(record);
	}

	/**
	 * Install with the vendor's official script, or update in place when the
	 * binary is already there.
	 *
	 * @param record - Job record (mutated)
	 * @param def - Harness definition
	 * @param spec - Script install spec
	 * @returns True on success
	 */
	private async installScript(record: JobRecord, def: HarnessDefinition, spec: ScriptInstallSpec): Promise<boolean> {
		const env = { ...this.env, PATH: buildHarnessPath(this.env.PATH) };
		const installed = this.resolveCommand(def.command);
		if (installed) {
			this.append(record, `$ ${def.command} ${spec.updateArgs.join(' ')}\n`);
			const result = await this.run(installed, spec.updateArgs, {
				env,
				timeoutMs: HARNESS_CONSTANTS.INSTALL_TIMEOUT_MS,
				onOutput: (chunk) => this.append(record, chunk),
			});
			if (result.code !== 0 && result.error) this.append(record, `\n${result.error}\n`);
			return result.code === 0;
		}

		if (!isAllowedInstallerUrl(spec.scriptUrl, spec)) {
			this.append(record, `Refusing to download an installer from ${spec.scriptUrl}\n`);
			return false;
		}
		const shell = HARNESS_CONSTANTS.ANTIGRAVITY.INSTALL_SHELL;
		this.append(record, `$ curl -fsSL ${spec.scriptUrl} | ${shell}\n`);
		const script = await this.fetchScript(spec.scriptUrl);
		if (!script.startsWith('#!')) {
			this.append(record, 'The downloaded installer is not a shell script; not running it.\n');
			return false;
		}
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-harness-install-'));
		const file = path.join(dir, 'install.sh');
		try {
			fs.writeFileSync(file, script, { mode: 0o700 });
			const result = await this.run(shell, [file], {
				env,
				timeoutMs: HARNESS_CONSTANTS.INSTALL_TIMEOUT_MS,
				onOutput: (chunk) => this.append(record, chunk),
			});
			if (result.code !== 0 && result.error) this.append(record, `\n${result.error}\n`);
			return result.code === 0;
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	/**
	 * Run npm, falling back to the user prefix on a permission error.
	 *
	 * @param record - Job record (mutated)
	 * @param npmPackage - Package to install
	 * @returns True on success
	 */
	private async installNpm(record: JobRecord, npmPackage: string): Promise<boolean> {
		const spec = `${npmPackage}@latest`;
		const env = { ...this.env, PATH: buildNpmPath(this.env.PATH) };
		this.append(record, `$ npm install -g ${spec}\n`);
		const first = await this.run('npm', ['install', '-g', spec], {
			env,
			timeoutMs: HARNESS_CONSTANTS.INSTALL_TIMEOUT_MS,
			onOutput: (chunk) => this.append(record, chunk),
		});
		let ok = first.code === 0;
		if (!ok && isPermissionError(`${first.stdout}\n${first.stderr}\n${first.error ?? ''}`)) {
			const prefix = getUserNpmPrefix();
			this.mkdirp(prefix);
			record.usedUserPrefix = true;
			this.append(record, `\nNo permission to write the global npm prefix; installing under ${prefix} instead.\n`);
			this.append(record, `$ npm install -g --prefix ${prefix} ${spec}\n`);
			const second = await this.run('npm', ['install', '-g', '--prefix', prefix, spec], {
				env,
				timeoutMs: HARNESS_CONSTANTS.INSTALL_TIMEOUT_MS,
				onOutput: (chunk) => this.append(record, chunk),
			});
			ok = second.code === 0;
			if (!ok && second.error) this.append(record, `\n${second.error}\n`);
		} else if (!ok && first.error) {
			this.append(record, `\n${first.error}\n`);
		}
		return ok;
	}

	/**
	 * Append to a job log, keeping only the tail.
	 *
	 * @param record - Job record
	 * @param text - Text to append
	 */
	private append(record: JobRecord, text: string): void {
		const next = record.log + text;
		const max = HARNESS_CONSTANTS.INSTALL_LOG_MAX_CHARS;
		record.log = next.length > max ? next.slice(next.length - max) : next;
	}

	/** Forget finished jobs older than the retention window. */
	private pruneFinished(): void {
		const cutoff = this.now() - HARNESS_CONSTANTS.INSTALL_JOB_RETENTION_MS;
		for (const [id, job] of this.jobs) {
			if (job.finishedAt !== null && job.finishedAt < cutoff) this.jobs.delete(id);
		}
	}

	/**
	 * Public view of a job.
	 *
	 * @param record - Job record
	 * @returns Contract shape
	 */
	private toPublic(record: JobRecord): InstallJob {
		return {
			jobId: record.jobId,
			harnessId: record.harnessId,
			state: record.state,
			log: record.log,
			usedUserPrefix: record.usedUserPrefix,
		};
	}
}
