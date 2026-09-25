/**
 * Skill install jobs — `install-skill` as a background job that reports back.
 *
 * An agent that lacks a capability runs `install-skill --id <skill>`. This
 * service decides whether it may (trust rule), downloads the skill from the
 * marketplace when it is not bundled (reusing the marketplace installer),
 * runs its setup block, and — when the job ends — sends the requesting agent
 * a message through the normal message queue (`system_event` to its
 * session, the path event-bus notifications use). The agent is woken by that
 * message and carries on: tells the user it is ready, then does the task it
 * paused.
 *
 * ## Trust rule
 *
 * - **Official** skills (see skill-discovery.service) install without asking,
 *   including the system dependencies their setup block declares.
 * - **Third-party** skills are refused unless the owner approved:
 *   - the owner acting from the dashboard (`X-Crewly-Caller: dashboard`, no
 *     agent header), or
 *   - an agent passing `approvedByOwner`, which is **verified**: there must be
 *     a genuine owner-authored chat message in the last
 *     OWNER_APPROVAL_LOOKBACK_MS that approves it — the same evidence the
 *     commitment-approval gate uses (chat-v2 `user` rows an agent cannot
 *     write). A claim with no such message is refused. If the chat cannot be
 *     read, the install is refused (fail closed: this runs someone else's code).
 *
 * @module services/skill-setup/skill-install-job.service
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { SKILL_SETUP_CONSTANTS, MESSAGE_SOURCES } from '../../constants.js';
import type { EnqueueMessageInput } from '../../types/messaging.types.js';
import type { MarketplaceItem, MarketplaceOperationResult } from '../../types/marketplace.types.js';
import { LoggerService } from '../core/logger.service.js';
import { getInstallPath } from '../marketplace/marketplace.service.js';
import { installItem } from '../marketplace/marketplace-installer.service.js';
import { getMessageQueueInstance } from '../messaging/index.js';
import { containsApprovalToken } from '../orchestrator/commitment-approval-guard.js';
import { getChatV2Service } from '../chat-v2/chat-v2.singleton.js';
import { validateSetupManifest } from './skill-setup-manifest.js';
import { getSkillDiscoveryService, type ResolvedSkill, type SkillDiscoveryService } from './skill-discovery.service.js';
import { getSkillSetupRunner, type SetupResult, type SkillSetupRunner } from './skill-setup-runner.service.js';

/** Job lifecycle. */
export type InstallJobState = 'running' | 'succeeded' | 'failed';

/** Public view of an install job. */
export interface SkillInstallJob {
	jobId: string;
	skillId: string;
	state: InstallJobState;
	official: boolean;
	officialReason: string;
	estimatedMinutes: number;
	startedAt: string;
	finishedAt?: string;
	/** Sessions that get the completion message */
	requesterSessions: string[];
	/** What the requester was doing (echoed back so it can resume) */
	resumeNote?: string;
	/** Tail of the job log */
	log: string;
	/** One-line outcome */
	message?: string;
	/** Setup log file */
	logFile?: string;
	/** Completion messages enqueued */
	notified: boolean;
	/** Where the skill lives once installed */
	executePath?: string;
}

/** Result of asking for an install. */
export type StartInstallResult =
	| { kind: 'job'; job: SkillInstallJob }
	| { kind: 'already-ready'; skill: { id: string; executePath?: string; officialReason: string } };

/** Input to {@link SkillInstallJobService.startInstall}. */
export interface StartInstallInput {
	/** Skill id (local id, directory name or registry id) */
	skillId: string;
	/** Agent session to notify on completion (from X-Agent-Session) */
	requesterSession?: string;
	/** The agent says the owner approved (verified against owner chat) */
	approvedByOwner?: boolean;
	/** The request comes from the owner in the dashboard */
	ownerDashboard?: boolean;
	/** What the agent was doing, echoed in the completion message */
	resumeNote?: string;
	/** Re-run setup even when a check says everything is there */
	force?: boolean;
	/** What the agent quotes as the owner's approval (X-Agent-Authorization), recorded in the job log */
	ownerClaim?: string;
}

/** Error with a machine-readable code for the REST layer. */
export class SkillInstallError extends Error {
	/**
	 * @param code - `not_found`, `owner_approval_required`, `owner_approval_not_found`,
	 *   `owner_approval_unverifiable`, `invalid_setup`, `job_not_found`
	 * @param message - Human-readable message, written for the agent
	 * @param details - Extra fields for the response
	 */
	constructor(
		public readonly code:
			| 'not_found'
			| 'owner_approval_required'
			| 'owner_approval_not_found'
			| 'owner_approval_unverifiable'
			| 'invalid_setup'
			| 'job_not_found',
		message: string,
		public readonly details: Record<string, unknown> = {},
	) {
		super(message);
		this.name = 'SkillInstallError';
	}
}

/** Injectable dependencies. */
export interface SkillInstallJobDeps {
	discovery?: SkillDiscoveryService;
	runner?: SkillSetupRunner;
	installMarketplaceItem?: (item: MarketplaceItem) => Promise<MarketplaceOperationResult>;
	installPathFor?: (item: MarketplaceItem) => string;
	/** Owner-authored chat messages since a time (throws when chat is unreadable) */
	recentOwnerMessages?: (sinceMs: number) => string[];
	/** Enqueue a message for an agent (null queue = cannot notify) */
	enqueue?: ((input: EnqueueMessageInput) => void) | null;
	now?: () => number;
	idFactory?: () => string;
}

/** Internal record. */
interface JobRecord extends SkillInstallJob {
	finishedAtMs: number | null;
	done: Promise<void> | null;
}

/** Short affirmatives that approve an install when the message also names the skill. */
const SHORT_YES = [/\byes\b/i, /\bok(ay)?\b/i, /\bsure\b/i, /\binstall\b/i, /好/, /可以/, /行/, /装/, /同意/];
/** A question is never approval. */
const QUESTION = /[?？]|吗\s*$|要不要|是否/;

/**
 * Whether one owner message approves installing a skill.
 *
 * Counts a clear approval ("go ahead", "批准", "同意" — the commitment
 * gate's tokens) or a short yes that names the skill ("ok install
 * shady-ocr", "可以，装 shady-ocr"). A question never counts.
 *
 * @param message - Owner message text
 * @param skill - Skill id and name
 * @returns True when it approves
 */
export function isOwnerInstallApproval(message: string, skill: { id: string; name?: string }): boolean {
	if (!message || QUESTION.test(message)) return false;
	if (containsApprovalToken(message)) return true;
	const lower = message.toLowerCase();
	const names = [skill.id, skill.name].filter((n): n is string => !!n && n.length >= 3).map((n) => n.toLowerCase());
	return names.some((n) => lower.includes(n)) && SHORT_YES.some((re) => re.test(message));
}

/**
 * Human duration.
 *
 * @param ms - Milliseconds
 * @returns e.g. "4m 10s"
 */
function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * The message the requesting agent receives when a job ends.
 *
 * @param job - Finished job
 * @param setup - Setup result (absent when the job failed before setup)
 * @param durationMs - Job duration
 * @returns Message text
 */
export function formatCompletionMessage(job: SkillInstallJob, setup: SetupResult | null, durationMs: number): string {
	const H = SKILL_SETUP_CONSTANTS.COMPLETION_HEADERS;
	const steps = setup?.steps.length
		? setup.steps.map((s) => `${s.id} ${s.status === 'satisfied' ? 'already there' : s.status}`).join(' · ')
		: '';
	const resume = job.resumeNote ? `\nYou paused: "${job.resumeNote}"` : '';
	if (job.state === 'succeeded') {
		return [
			`${H.SUCCEEDED} ${job.skillId} is installed and ready (job ${job.jobId}, ${formatDuration(durationMs)}).`,
			...(steps ? [`Setup: ${steps}`] : []),
			...(job.executePath ? [`Run it: bash ${job.executePath} (see SKILL.md next to it)`] : []),
		].join('\n') + `${resume}\nNext: tell the user in one line that it is ready, then do the task you paused — now, without waiting to be asked.`;
	}
	return [
		`${H.FAILED} ${job.skillId} (job ${job.jobId}, ${formatDuration(durationMs)}): ${job.message ?? 'unknown error'}`,
		...(steps ? [`Setup: ${steps}`] : []),
		...(job.logFile ? [`Log: ${job.logFile}`] : []),
	].join('\n') + `${resume}\nNext: tell the user plainly what is missing and the fix quoted above (e.g. the command the owner can run). Do not retry the same install until something has changed.`;
}

/** Runs and tracks skill install jobs. */
export class SkillInstallJobService {
	private readonly discovery: SkillDiscoveryService;
	private readonly runner: SkillSetupRunner;
	private readonly installMarketplaceItem: (item: MarketplaceItem) => Promise<MarketplaceOperationResult>;
	private readonly installPathFor: (item: MarketplaceItem) => string;
	private readonly recentOwnerMessages: (sinceMs: number) => string[];
	private readonly enqueue: (() => ((input: EnqueueMessageInput) => void) | null);
	private readonly now: () => number;
	private readonly idFactory: () => string;
	private readonly jobs = new Map<string, JobRecord>();
	private readonly logger = LoggerService.getInstance().createComponentLogger('SkillInstallJobs');

	/**
	 * @param deps - Injectable dependencies (all optional)
	 */
	constructor(deps: SkillInstallJobDeps = {}) {
		this.discovery = deps.discovery ?? getSkillDiscoveryService();
		this.runner = deps.runner ?? getSkillSetupRunner();
		this.installMarketplaceItem = deps.installMarketplaceItem ?? installItem;
		this.installPathFor = deps.installPathFor ?? ((item) => getInstallPath(item.type, item.id));
		this.recentOwnerMessages = deps.recentOwnerMessages ?? ((since) => getChatV2Service().getRecentOwnerMessageContents(since));
		// Resolved per job: the queue is created after this service at startup.
		this.enqueue =
			deps.enqueue !== undefined
				? () => deps.enqueue ?? null
				: () => {
						const queue = getMessageQueueInstance();
						return queue ? (input) => void queue.enqueue(input) : null;
					};
		this.now = deps.now ?? Date.now;
		this.idFactory = deps.idFactory ?? (() => randomUUID().slice(0, 8));
	}

	/**
	 * Ask for a skill to be installed and set up.
	 *
	 * Returns at once: either the skill is already usable, or a job id. When
	 * a job for the same skill is running, its id is returned and the new
	 * requester is added to the completion message's recipients.
	 *
	 * @param input - Skill id, requester, approval flags
	 * @returns The job, or `already-ready`
	 * @throws SkillInstallError when the skill is unknown, untrusted, or its setup block is invalid
	 */
	async startInstall(input: StartInstallInput): Promise<StartInstallResult> {
		const skill = await this.discovery.resolve(input.skillId);
		if (!skill) {
			throw new SkillInstallError(
				'not_found',
				`No skill "${input.skillId}" is bundled with Crewly or listed in the marketplace. Run find-skill --query "<what you need>" to search.`,
			);
		}
		// A job already running for this skill passed the trust check: join it.
		this.pruneFinished();
		const running = [...this.jobs.values()].find((j) => j.skillId === skill.id && j.state === 'running');
		if (running) {
			if (input.requesterSession && !running.requesterSessions.includes(input.requesterSession)) {
				running.requesterSessions.push(input.requesterSession);
			}
			return { kind: 'job', job: this.toPublic(running) };
		}

		// Nothing to install: say so instead of making the agent wait for a message.
		if (!input.force && skill.installed && !skill.manifestError) {
			await this.discovery.probe(skill);
			if (skill.ready) {
				return { kind: 'already-ready', skill: { id: skill.id, executePath: skill.executePath, officialReason: skill.officialReason } };
			}
		}

		const evidence = this.checkTrust(skill, input);
		if (skill.manifestError) {
			throw new SkillInstallError('invalid_setup', `The setup block of ${skill.id} is invalid, so it was not run: ${skill.manifestError}`);
		}

		const record: JobRecord = {
			jobId: this.idFactory(),
			skillId: skill.id,
			state: 'running',
			official: skill.official,
			officialReason: skill.officialReason,
			estimatedMinutes: skill.setup.estimatedMinutes ?? SKILL_SETUP_CONSTANTS.DEFAULT_ESTIMATED_MINUTES,
			startedAt: new Date(this.now()).toISOString(),
			requesterSessions: input.requesterSession ? [input.requesterSession] : [],
			...(input.resumeNote ? { resumeNote: input.resumeNote } : {}),
			log: evidence
				? `Third-party skill approved by the owner in chat: "${evidence.slice(0, 300)}"` +
					(input.ownerClaim ? `\nThe agent cited: "${input.ownerClaim.slice(0, 300)}"` : '') + '\n'
				: input.ownerDashboard && !skill.official
					? 'Third-party skill installed by the owner from the dashboard.\n'
					: '',
			notified: false,
			executePath: skill.executePath,
			finishedAtMs: null,
			done: null,
		};
		this.jobs.set(record.jobId, record);
		this.logger.info('Skill install started', { jobId: record.jobId, skillId: skill.id, official: skill.official, requesters: record.requesterSessions });
		record.done = this.execute(record, skill);
		return { kind: 'job', job: this.toPublic(record) };
	}

	/**
	 * Look up a job.
	 *
	 * @param jobId - Job id
	 * @returns The job
	 * @throws SkillInstallError `job_not_found`
	 */
	getJob(jobId: string): SkillInstallJob {
		const record = this.jobs.get(jobId);
		if (!record) throw new SkillInstallError('job_not_found', `Install job not found: ${jobId}`);
		return this.toPublic(record);
	}

	/**
	 * Wait for a job to finish (tests, CLI).
	 *
	 * @param jobId - Job id
	 * @returns The finished job
	 * @throws SkillInstallError `job_not_found`
	 */
	async waitForJob(jobId: string): Promise<SkillInstallJob> {
		const record = this.jobs.get(jobId);
		if (!record) throw new SkillInstallError('job_not_found', `Install job not found: ${jobId}`);
		if (record.done) await record.done;
		return this.toPublic(record);
	}

	/**
	 * Apply the trust rule.
	 *
	 * @param skill - Resolved skill
	 * @param input - Request
	 * @returns The owner message that approved a third-party install (undefined for official / dashboard)
	 * @throws SkillInstallError when a third-party skill lacks owner approval
	 */
	private checkTrust(skill: ResolvedSkill, input: StartInstallInput): string | undefined {
		if (skill.official || input.ownerDashboard) return undefined;
		const who = `"${skill.id}" is a third-party skill (${skill.officialReason})`;
		if (!input.approvedByOwner) {
			throw new SkillInstallError(
				'owner_approval_required',
				`${who}, so it is not installed automatically. Ask the owner in chat whether to install it (say what it is and who publishes it). ` +
					`Only after they say yes, run: install-skill --id ${skill.id} --approved-by-owner`,
				{ official: false, officialReason: skill.officialReason },
			);
		}
		let messages: string[];
		try {
			messages = this.recentOwnerMessages(this.now() - SKILL_SETUP_CONSTANTS.OWNER_APPROVAL_LOOKBACK_MS);
		} catch (error) {
			throw new SkillInstallError(
				'owner_approval_unverifiable',
				`${who}. --approved-by-owner could not be checked because the owner's chat history is unreadable (${error instanceof Error ? error.message : String(error)}); not installing.`,
			);
		}
		const evidence = messages.find((m) => isOwnerInstallApproval(m, { id: skill.id, name: skill.name }));
		if (!evidence) {
			const hours = Math.round(SKILL_SETUP_CONSTANTS.OWNER_APPROVAL_LOOKBACK_MS / 3_600_000);
			throw new SkillInstallError(
				'owner_approval_not_found',
				`${who}. --approved-by-owner was passed, but no owner message in the last ${hours}h approves installing it. ` +
					`Ask the owner in chat first (name the skill); run this again after they say yes.`,
			);
		}
		this.logger.info('Third-party skill install approved by owner message', { skillId: skill.id, evidence: evidence.slice(0, 200), claim: input.ownerClaim });
		return evidence;
	}

	/**
	 * Install (when needed), set up, then notify.
	 *
	 * @param record - Job record (mutated)
	 * @param skill - Resolved skill
	 */
	private async execute(record: JobRecord, skill: ResolvedSkill): Promise<void> {
		const started = this.now();
		let setup: SetupResult | null = null;
		try {
			let skillDir = skill.skillDir;
			let manifest = skill.manifest;
			if (!skill.installed || !skillDir) {
				const item = skill.registryItem;
				if (!item) throw new Error('not installed and not in the registry');
				this.append(record, `Downloading ${item.name} v${item.version} from the marketplace…\n`);
				let installed = item;
				let res = await this.installMarketplaceItem(item);
				if (!res.success && item.fallback) {
					// Premium archives can be missing from the CDN; the public copy of the same skill installs.
					this.append(record, `${res.message}; trying the public registry copy…\n`);
					installed = item.fallback;
					res = await this.installMarketplaceItem(item.fallback);
				}
				if (!res.success) throw new Error(`marketplace install failed: ${res.message}`);
				this.append(record, `${res.message}\n`);
				skillDir = this.installPathFor(installed);
				record.executePath = path.join(skillDir, 'execute.sh');
				// The downloaded skill.json is authoritative for setup.
				const local = this.readSetup(skillDir);
				if (local !== undefined) {
					const v = validateSetupManifest(local);
					if (!v.valid) throw new Error(`the installed skill's setup block is invalid: ${v.errors.join('; ')}`);
					manifest = v.manifest;
				}
			}
			if (manifest) {
				setup = await this.runner.runSetup({
					skillId: skill.id,
					skillDir,
					manifest,
					onProgress: (e) => this.append(record, `[${e.stepId}] ${e.phase}: ${e.message}\n`),
				});
				record.logFile = setup.logFile;
				if (!setup.success) throw new Error(setup.error ?? 'setup failed');
			} else {
				this.append(record, 'No setup needed.\n');
			}
			record.state = 'succeeded';
			record.message = `${skill.id} is installed and ready`;
		} catch (error) {
			record.state = 'failed';
			record.message = error instanceof Error ? error.message : String(error);
			this.append(record, `FAILED: ${record.message}\n`);
		}
		record.finishedAtMs = this.now();
		record.finishedAt = new Date(record.finishedAtMs).toISOString();
		this.logger.info('Skill install finished', { jobId: record.jobId, skillId: record.skillId, state: record.state, message: record.message });
		this.notify(record, setup, record.finishedAtMs - started);
	}

	/**
	 * Read the raw `setup` block of an installed skill.
	 *
	 * @param skillDir - Skill directory
	 * @returns The block, or undefined
	 */
	private readSetup(skillDir: string): unknown {
		try {
			return (JSON.parse(fs.readFileSync(path.join(skillDir, 'skill.json'), 'utf-8')) as { setup?: unknown }).setup;
		} catch {
			return undefined;
		}
	}

	/**
	 * Send the completion message to every requester.
	 *
	 * @param record - Finished job (mutated: notified)
	 * @param setup - Setup result
	 * @param durationMs - Duration
	 */
	private notify(record: JobRecord, setup: SetupResult | null, durationMs: number): void {
		if (record.requesterSessions.length === 0) return;
		const enqueue = this.enqueue();
		if (!enqueue) {
			this.logger.warn('Message queue unavailable; install result not delivered', { jobId: record.jobId });
			return;
		}
		const content = formatCompletionMessage(this.toPublic(record), setup, durationMs);
		for (const session of record.requesterSessions) {
			try {
				enqueue({
					content,
					conversationId: SKILL_SETUP_CONSTANTS.COMPLETION_CONVERSATION_ID,
					source: MESSAGE_SOURCES.SYSTEM_EVENT,
					targetSession: session,
				});
				record.notified = true;
			} catch (error) {
				this.logger.warn('Failed to enqueue install result', { jobId: record.jobId, session, error: error instanceof Error ? error.message : String(error) });
			}
		}
	}

	/**
	 * Append to a job log, keeping the tail.
	 *
	 * @param record - Job
	 * @param text - Text
	 */
	private append(record: JobRecord, text: string): void {
		const next = record.log + text;
		const max = SKILL_SETUP_CONSTANTS.JOB_LOG_MAX_CHARS;
		record.log = next.length > max ? next.slice(next.length - max) : next;
	}

	/** Forget finished jobs after the retention window. */
	private pruneFinished(): void {
		const cutoff = this.now() - SKILL_SETUP_CONSTANTS.JOB_RETENTION_MS;
		for (const [id, job] of this.jobs) {
			if (job.finishedAtMs !== null && job.finishedAtMs < cutoff) this.jobs.delete(id);
		}
	}

	/**
	 * Public view of a job.
	 *
	 * @param r - Record
	 * @returns Job
	 */
	private toPublic(r: JobRecord): SkillInstallJob {
		const view: SkillInstallJob & Partial<Pick<JobRecord, 'finishedAtMs' | 'done'>> = { ...r, requesterSessions: [...r.requesterSessions] };
		delete view.finishedAtMs;
		delete view.done;
		return view;
	}
}

/**
 * One-line "I'm installing it" text the agent can relay to the user.
 *
 * @param job - Job
 * @returns Message
 */
export function describeStartedJob(job: SkillInstallJob): string {
	return (
		`Installing ${job.skillId} in the background (about ${job.estimatedMinutes} min). ` +
		`Tell the user now, in one line, that you are installing it and roughly how long it takes; ` +
		`you will get a ${SKILL_SETUP_CONSTANTS.COMPLETION_HEADERS.SUCCEEDED} or ${SKILL_SETUP_CONSTANTS.COMPLETION_HEADERS.FAILED} message when it ends — continue then.`
	);
}

let jobServiceSingleton: SkillInstallJobService | null = null;

/**
 * The process-wide job service.
 *
 * @returns The service
 */
export function getSkillInstallJobService(): SkillInstallJobService {
	if (!jobServiceSingleton) jobServiceSingleton = new SkillInstallJobService();
	return jobServiceSingleton;
}
