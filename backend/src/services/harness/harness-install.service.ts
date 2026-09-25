/**
 * Harness install — `npm install -g <pkg>@latest` as an async job.
 *
 * When the global prefix is not writable (EACCES / EPERM), the install is
 * retried once under the user-owned prefix `<crewlyHome>/npm-global`
 * (`npm install -g --prefix …`); its `bin` dir is on the PATH of everything
 * Crewly spawns (harness-exec.utils). No sudo, no shell profile edits.
 *
 * One install runs per harness at a time: starting a second one while the
 * first is running returns the running job.
 *
 * @module services/harness/harness-install.service
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { HARNESS_CONSTANTS } from '../../constants.js';
import { buildNpmPath, getUserNpmPrefix, runCommand } from './harness-exec.utils.js';
import { getHarnessDefinition } from './harness-registry.js';
import { SILENT_HARNESS_LOGGER, type HarnessId, type HarnessLogger, type InstallJob, type RunCommand } from './harness.types.js';

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
		record.done = this.execute(record, def.npmPackage);
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
	 * Run npm, falling back to the user prefix on a permission error.
	 *
	 * @param record - Job record (mutated)
	 * @param npmPackage - Package to install
	 * @returns The finished job
	 */
	private async execute(record: JobRecord, npmPackage: string): Promise<InstallJob> {
		const spec = `${npmPackage}@latest`;
		const env = { ...this.env, PATH: buildNpmPath(this.env.PATH) };
		try {
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
