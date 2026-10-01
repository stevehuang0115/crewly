/**
 * Runtime smoke test — prove a runtime really works on this machine by
 * running one agent on it end to end.
 *
 * Through the backend's own REST API (the calls the dashboard makes):
 *
 * 1. `create_team` — temp project + team `zz-runtime-smoke-<runtime>` with
 *    one member on the runtime (a leftover of the same name is removed first).
 * 2. `start_member` — start it (as the owner's dashboard would).
 * 3. `agent_ready` — wait until it registered. Antigravity's first-run Terms
 *    screen fails the test with "Antigravity needs its terms accepted once"
 *    and the screen text — Crewly never accepts terms for the owner.
 * 4. `send_task` — `echo ok > <file>` with bash, then reply with a token.
 * 5. `bash` — the file holds `ok`.
 * 6. `reply` — the token `SMOKE-ok-<nonce>` shows in the agent's output. The
 *    task never contains that string verbatim (only its parts), so an echo
 *    of the task does not count.
 * 7. `cleanup` — stop and delete the team and the project (always).
 *
 * Bounded by 5 minutes. specs/2026-10-01-runtime-fallback.md
 *
 * @module services/runtime-fallback/runtime-smoke-test.service
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ANTIGRAVITY_CONSTANTS, RUNTIME_FALLBACK_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';
import { normalizeTerminalOutput } from '../harness/login-rules.js';
import { KNOWN_RUNTIMES } from './runtime-fallback.types.js';

const S = RUNTIME_FALLBACK_CONSTANTS.SMOKE;

/** Steps, in order. */
export type SmokeStep = 'create_team' | 'start_member' | 'agent_ready' | 'send_task' | 'bash' | 'reply' | 'cleanup';

/** Result of one smoke test. */
export interface SmokeTestResult {
	runtime: string;
	passed: boolean;
	/** The step that failed */
	failedStep?: SmokeStep;
	/** Owner-facing reason (English) */
	error?: string;
	/** Steps that passed, in order */
	steps: Array<{ step: SmokeStep; ok: boolean; ms: number; detail?: string }>;
	/** Last screen text (on failure, and for the Terms screen) */
	screen?: string;
	durationMs: number;
}

/** A job (POST returns its id; GET reads it). */
export interface SmokeTestJob {
	jobId: string;
	runtime: string;
	state: 'running' | 'done';
	startedAt: string;
	result?: SmokeTestResult;
}

/** The REST calls the smoke test makes (the default talks to the local API). */
export interface SmokeApi {
	listTeams(): Promise<Array<{ id: string; name: string }>>;
	listProjects(): Promise<Array<{ id: string; name: string }>>;
	createProject(name: string, projectPath: string): Promise<string>;
	deleteProject(projectId: string): Promise<void>;
	createTeam(body: Record<string, unknown>): Promise<{ id: string; memberId: string }>;
	startMember(teamId: string, memberId: string): Promise<{ ok: boolean; error?: string }>;
	getMember(teamId: string, memberId: string): Promise<{ agentStatus: string; sessionName: string } | null>;
	capture(sessionName: string, lines: number): Promise<string>;
	deliver(sessionName: string, message: string): Promise<{ ok: boolean; error?: string }>;
	stopTeam(teamId: string): Promise<void>;
	deleteTeam(teamId: string): Promise<void>;
}

/** Dependencies. */
export interface SmokeTestDeps {
	api: SmokeApi;
	/** Scratch root for the project + proof files */
	workRoot?: string;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	nonce?: () => string;
	timeoutMs?: number;
	pollMs?: number;
}

/** Agent statuses that mean "registered and ready". */
const READY_STATUSES = new Set(['active']);

/**
 * Whether a screen shows Antigravity's first-run (Terms) screens.
 *
 * @param screen - Screen text
 * @returns True when the Terms / onboarding screen is up
 */
export function showsAntigravityTerms(screen: string): boolean {
	// Wrapped lines lose the space at the break: compare without whitespace too.
	const bare = screen.replace(/\s+/g, '');
	return ANTIGRAVITY_CONSTANTS.SCREEN.FIRST_RUN_MARKERS.some((m) => screen.includes(m) || bare.includes(m.replace(/\s+/g, '')));
}

/**
 * The task the smoke agent gets.
 *
 * @param file - Proof file to write with bash
 * @param nonce - Code for the reply token
 * @returns Message text (never contains `SMOKE-ok-<nonce>` verbatim)
 */
export function buildSmokeTask(file: string, nonce: string): string {
	return [
		'Crewly runtime smoke test. Do exactly these two steps and nothing else:',
		`1. With your bash / shell tool, run this command: echo ok > ${file}`,
		`2. Reply with one line made of: the word SMOKE, a dash, the text that file now contains, a dash, and the code ${nonce}` +
			' (for code 1234 and file text "hi" the line would be SMOKE-hi-1234). Send it with your reply / report-status skill' +
			' (status done), or as your answer if you have no such skill.',
	].join('\n');
}

/** Runs smoke tests and keeps their jobs. */
export class RuntimeSmokeTestService {
	private readonly jobs = new Map<string, SmokeTestJob>();
	private readonly running = new Map<string, Promise<SmokeTestResult>>();
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;

	/**
	 * @param deps - Dependencies
	 */
	constructor(private readonly deps: SmokeTestDeps) {
		this.now = deps.now ?? (() => Date.now());
		this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	}

	/**
	 * Start a smoke test (one per runtime at a time).
	 *
	 * @param runtime - Runtime id
	 * @returns The job and a promise of its result
	 * @throws Error for an unknown runtime
	 */
	start(runtime: string): { job: SmokeTestJob; done: Promise<SmokeTestResult> } {
		if (!KNOWN_RUNTIMES.includes(runtime)) throw new Error(`Unknown runtime: ${runtime}`);
		this.prune();
		const existing = [...this.jobs.values()].find((j) => j.runtime === runtime && j.state === 'running');
		if (existing) return { job: existing, done: this.running.get(existing.jobId) as Promise<SmokeTestResult> };
		const job: SmokeTestJob = { jobId: `smoke-${runtime}-${randomBytes(4).toString('hex')}`, runtime, state: 'running', startedAt: new Date(this.now()).toISOString() };
		this.jobs.set(job.jobId, job);
		const done = this.run(runtime).then((result) => {
			job.state = 'done';
			job.result = result;
			this.running.delete(job.jobId);
			return result;
		});
		this.running.set(job.jobId, done);
		return { job, done };
	}

	/**
	 * A job by id.
	 *
	 * @param jobId - Job id
	 * @returns Job, or null
	 */
	get(jobId: string): SmokeTestJob | null {
		return this.jobs.get(jobId) ?? null;
	}

	private prune(): void {
		for (const [id, job] of this.jobs) {
			if (job.state === 'done' && this.now() - Date.parse(job.startedAt) > S.JOB_TTL_MS) this.jobs.delete(id);
		}
	}

	/**
	 * Run one smoke test.
	 *
	 * @param runtime - Runtime id
	 * @returns Result (never throws)
	 */
	async run(runtime: string): Promise<SmokeTestResult> {
		const api = this.deps.api;
		const started = this.now();
		const deadline = started + (this.deps.timeoutMs ?? S.TIMEOUT_MS);
		const pollMs = this.deps.pollMs ?? S.POLL_MS;
		const name = `${S.TEAM_PREFIX}${runtime}`;
		const nonce = this.deps.nonce?.() ?? randomBytes(3).toString('hex');
		const workDir = path.join(this.deps.workRoot ?? path.join(os.tmpdir(), 'crewly-runtime-smoke'), `${runtime}-${nonce}`);
		const proofFile = path.join(workDir, `smoke-${nonce}.txt`);
		const token = `SMOKE-ok-${nonce}`;
		const steps: SmokeTestResult['steps'] = [];
		let teamId: string | null = null;
		let projectId: string | null = null;
		let sessionName = '';
		let screen = '';
		let stepStart = this.now();

		const pass = (step: SmokeStep, detail?: string): void => {
			steps.push({ step, ok: true, ms: this.now() - stepStart, ...(detail ? { detail } : {}) });
			stepStart = this.now();
		};
		const readScreen = async (): Promise<string> => {
			if (!sessionName) return screen;
			try {
				const text = await api.capture(sessionName, S.CAPTURE_LINES);
				if (text) screen = normalizeTerminalOutput(text).text;
			} catch {
				// keep the last screen
			}
			return screen;
		};

		let failure: { step: SmokeStep; error: string } | null = null;
		const fail = (step: SmokeStep, error: string): void => {
			failure = { step, error };
			steps.push({ step, ok: false, ms: this.now() - stepStart, detail: error });
		};
		const termsCheck = (text: string): boolean => runtime === RUNTIME_TYPES.ANTIGRAVITY_CLI && showsAntigravityTerms(text);
		const TERMS = 'Antigravity needs its terms accepted once';

		try {
			// 1. Team (and a scratch project so the agent never works in a real one)
			await this.removeLeftovers(name);
			fs.mkdirSync(workDir, { recursive: true });
			projectId = await api.createProject(name, workDir);
			const created = await api.createTeam({
				name,
				description: 'Temporary team for a runtime smoke test (deleted afterwards).',
				projectIds: [projectId],
				members: [
					{
						name: S.MEMBER_NAME,
						role: S.MEMBER_ROLE,
						runtimeType: runtime,
						systemPrompt: 'You are a smoke-test agent. Do exactly what each message asks and nothing else.',
					},
				],
			});
			teamId = created.id;
			pass('create_team', name);

			// 2. Start
			const startResult = await api.startMember(created.id, created.memberId);
			const member = await api.getMember(created.id, created.memberId).catch(() => null);
			sessionName = member?.sessionName ?? '';
			if (!startResult.ok) {
				const text = await readScreen();
				if (termsCheck(text) || /first-run screens|Terms of Service/i.test(startResult.error ?? '')) fail('start_member', TERMS);
				else fail('start_member', startResult.error ?? 'The member did not start');
				return this.result(runtime, started, steps, failure, screen);
			}
			pass('start_member');

			// 3. Registered (watch for the Terms screen meanwhile)
			let ready = false;
			while (this.now() < deadline) {
				const m = await api.getMember(created.id, created.memberId).catch(() => null);
				if (m?.sessionName) sessionName = m.sessionName;
				if (termsCheck(await readScreen())) {
					fail('agent_ready', TERMS);
					return this.result(runtime, started, steps, failure, screen);
				}
				if (m && READY_STATUSES.has(m.agentStatus)) {
					ready = true;
					break;
				}
				await this.sleep(pollMs);
			}
			if (!ready) {
				fail('agent_ready', 'The agent did not register in time');
				await readScreen();
				return this.result(runtime, started, steps, failure, screen);
			}
			pass('agent_ready', sessionName);

			// 4. Task
			const delivered = await api.deliver(sessionName, buildSmokeTask(proofFile, nonce));
			if (!delivered.ok) {
				fail('send_task', delivered.error ?? 'The task could not be delivered');
				await readScreen();
				return this.result(runtime, started, steps, failure, screen);
			}
			pass('send_task');

			// 5. bash ran, 6. reply came back
			let bashOk = false;
			let replied = false;
			while (this.now() < deadline && !(bashOk && replied)) {
				if (!bashOk && readProof(proofFile) === 'ok') {
					bashOk = true;
					pass('bash');
				}
				const text = await readScreen();
				if (termsCheck(text)) {
					fail(bashOk ? 'reply' : 'bash', TERMS);
					return this.result(runtime, started, steps, failure, screen);
				}
				if (!replied && (text.includes(token) || text.replace(/\s+/g, '').includes(token))) replied = true;
				if (bashOk && replied) break;
				await this.sleep(pollMs);
			}
			if (!bashOk) fail('bash', `The agent did not run "echo ok" with bash (no ${path.basename(proofFile)})`);
			else if (!replied) fail('reply', `No reply with the token ${token}`);
			else pass('reply', token);
			if (failure) await readScreen();
			return this.result(runtime, started, steps, failure, screen);
		} catch (err) {
			const step: SmokeStep = !teamId ? 'create_team' : !sessionName ? 'start_member' : 'send_task';
			fail(step, err instanceof Error ? err.message : String(err));
			return this.result(runtime, started, steps, failure, screen);
		} finally {
			stepStart = this.now();
			const cleanupErrors: string[] = [];
			if (teamId) {
				await api.stopTeam(teamId).catch((e: unknown) => cleanupErrors.push(String(e)));
				await api.deleteTeam(teamId).catch((e: unknown) => cleanupErrors.push(String(e)));
			}
			if (projectId) await api.deleteProject(projectId).catch((e: unknown) => cleanupErrors.push(String(e)));
			try {
				fs.rmSync(workDir, { recursive: true, force: true });
			} catch {
				// scratch only
			}
			steps.push({ step: 'cleanup', ok: cleanupErrors.length === 0, ms: this.now() - stepStart, ...(cleanupErrors.length ? { detail: cleanupErrors.join('; ') } : {}) });
		}
	}

	/** Remove a team / project left over from an earlier run. */
	private async removeLeftovers(name: string): Promise<void> {
		const api = this.deps.api;
		for (const team of (await api.listTeams().catch(() => [])).filter((t) => t.name === name)) {
			await api.stopTeam(team.id).catch(() => undefined);
			await api.deleteTeam(team.id).catch(() => undefined);
		}
		for (const project of (await api.listProjects().catch(() => [])).filter((p) => p.name === name)) {
			await api.deleteProject(project.id).catch(() => undefined);
		}
	}

	private result(
		runtime: string,
		started: number,
		steps: SmokeTestResult['steps'],
		failure: { step: SmokeStep; error: string } | null,
		screen: string,
	): SmokeTestResult {
		const tail = screen.split('\n').slice(-S.SCREEN_LINES).join('\n').trim();
		return {
			runtime,
			passed: failure === null,
			...(failure ? { failedStep: failure.step, error: failure.error } : {}),
			steps,
			...(failure && tail ? { screen: tail } : {}),
			durationMs: this.now() - started,
		};
	}
}

/**
 * Read the proof file.
 *
 * @param file - Path
 * @returns Its trimmed text, or null
 */
function readProof(file: string): string | null {
	try {
		return fs.readFileSync(file, 'utf-8').trim();
	} catch {
		return null;
	}
}

/** Fetch-based client for the local API (the default {@link SmokeApi}). */
export class LocalSmokeApi implements SmokeApi {
	/**
	 * @param baseUrl - e.g. http://127.0.0.1:8787
	 * @param token - Crewly API token
	 */
	constructor(
		private readonly baseUrl: () => string,
		private readonly token: () => string,
	) {}

	private async call<T>(method: string, route: string, body?: unknown): Promise<T> {
		const res = await fetch(`${this.baseUrl()}/api${route}`, {
			method,
			headers: {
				'content-type': 'application/json',
				'x-crewly-token': this.token(),
				// The owner's dashboard: the wake / commitment gates are for agents.
				'x-crewly-caller': 'dashboard',
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});
		const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string; data?: unknown };
		if (!res.ok || json.success === false) throw new Error(json.error ?? `${method} ${route} → HTTP ${res.status}`);
		return json as T;
	}

	async listTeams(): Promise<Array<{ id: string; name: string }>> {
		const r = await this.call<{ data: Array<{ id: string; name: string }> }>('GET', '/teams');
		return r.data ?? [];
	}

	async listProjects(): Promise<Array<{ id: string; name: string }>> {
		const r = await this.call<{ data: Array<{ id: string; name: string }> }>('GET', '/projects');
		return r.data ?? [];
	}

	async createProject(name: string, projectPath: string): Promise<string> {
		const r = await this.call<{ data: { id: string } }>('POST', '/projects', { name, path: projectPath, description: 'Runtime smoke test (temporary)' });
		return r.data.id;
	}

	async deleteProject(projectId: string): Promise<void> {
		await this.call('DELETE', `/projects/${encodeURIComponent(projectId)}`);
	}

	async createTeam(body: Record<string, unknown>): Promise<{ id: string; memberId: string }> {
		const r = await this.call<{ data: { id: string; members: Array<{ id: string }> } }>('POST', '/teams', body);
		return { id: r.data.id, memberId: r.data.members[0].id };
	}

	async startMember(teamId: string, memberId: string): Promise<{ ok: boolean; error?: string }> {
		try {
			await this.call('POST', `/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberId)}/start`, {});
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	async getMember(teamId: string, memberId: string): Promise<{ agentStatus: string; sessionName: string } | null> {
		const r = await this.call<{ data: { members: Array<{ id: string; agentStatus: string; sessionName: string }> } }>('GET', `/teams/${encodeURIComponent(teamId)}`);
		const m = r.data.members.find((x) => x.id === memberId);
		return m ? { agentStatus: m.agentStatus, sessionName: m.sessionName } : null;
	}

	async capture(sessionName: string, lines: number): Promise<string> {
		const r = await this.call<{ data: { output?: string } | string }>('GET', `/terminal/${encodeURIComponent(sessionName)}/output?lines=${lines}`);
		return typeof r.data === 'string' ? r.data : r.data?.output ?? '';
	}

	async deliver(sessionName: string, message: string): Promise<{ ok: boolean; error?: string }> {
		try {
			await this.call('POST', `/terminal/${encodeURIComponent(sessionName)}/deliver`, { message });
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	async stopTeam(teamId: string): Promise<void> {
		await this.call('POST', `/teams/${encodeURIComponent(teamId)}/stop`, {});
	}

	async deleteTeam(teamId: string): Promise<void> {
		await this.call('DELETE', `/teams/${encodeURIComponent(teamId)}`);
	}
}
