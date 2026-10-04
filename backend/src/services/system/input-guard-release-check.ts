/**
 * Release input-guard check (specs/2026-10-04-release-input-guard-check.md).
 *
 * Reads every live agent's input box from the running backend's real
 * terminal buffers (styling kept, ghost text blanked) and classifies it with
 * the NEW build's guard, run in a fresh node process. A build that reads an
 * idle agent's input box as `unknown` would hold every message delivery
 * (1.20.198), so the upgrade flow refuses to restart onto it.
 *
 * @module services/system/input-guard-release-check
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { INPUT_GUARD_CHECK_CONSTANTS } from '../../constants.js';
import type { InputGuardClassification, InputGuardViewInput } from '../../scripts/input-guard-classify.js';

/** One agent row of the report. */
export type InputGuardAgentResult = InputGuardClassification;

/** Report of one check. */
export interface InputGuardReport {
	/** No idle agent reads as unknown */
	ok: boolean;
	/** The check could not run at all (old build without the script): not blocking */
	unavailable?: boolean;
	/** Script that classified (absent when unavailable) */
	script?: string;
	checkedAt: string;
	agents: InputGuardAgentResult[];
	/** Why it failed / could not run */
	error?: string;
}

/** What the live backend offers. */
export interface LiveViewSource {
	listSessions(): string[];
	captureInputView?(name: string): { lines: string[]; cursorRow: number } | null;
}

/** Runs the classifier script; resolves its stdout, rejects on failure. */
export type ClassifierRunner = (script: string, stdin: string) => Promise<string>;

/**
 * Find the new build's classifier script under a path the caller names.
 *
 * @param build - Package root, `dist` dir, `dist/backend` dir, or the script's dir
 * @returns Absolute script path, or null when the build has none
 */
export function resolveClassifierScript(build: string): string | null {
	const rel = INPUT_GUARD_CHECK_CONSTANTS.SCRIPT_RELATIVE;
	const abs = path.resolve(build);
	const candidates = [
		path.join(abs, 'dist', rel),
		path.join(abs, rel),
		path.join(abs, rel.replace(/^backend\//, '')),
		path.join(abs, path.basename(rel)),
	];
	return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/**
 * Gather the live view of every PTY session; one without a styled capture
 * gets a null view and is reported as skipped.
 *
 * @param source - The session backend
 * @param runtimeOf - Runtime type of a session (from persisted metadata)
 * @returns One entry per session
 */
export function collectLiveViews(source: LiveViewSource, runtimeOf: (session: string) => string | undefined): InputGuardViewInput[] {
	const out: InputGuardViewInput[] = [];
	for (const session of source.listSessions()) {
		let view: { lines: string[]; cursorRow: number } | null = null;
		try {
			view = typeof source.captureInputView === 'function' ? source.captureInputView(session) : null;
		} catch {
			view = null;
		}
		// No capture: still listed (the script reports it as skipped), never dropped.
		out.push({ session, runtime: runtimeOf(session) ?? 'unknown', view });
	}
	return out;
}

/**
 * Default runner: `node <script>` in a fresh process, input on stdin.
 *
 * @param script - Script path
 * @param stdin - Input text
 * @returns Its stdout
 */
export const spawnClassifier: ClassifierRunner = (script, stdin) =>
	new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		let settled = false;
		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			finish(() => reject(new Error(`classifier timed out after ${INPUT_GUARD_CHECK_CONSTANTS.CHILD_TIMEOUT_MS / 1000}s`)));
		}, INPUT_GUARD_CHECK_CONSTANTS.CHILD_TIMEOUT_MS);
		child.stdout.on('data', (d: Buffer) => {
			out += d.toString('utf8');
			if (out.length > INPUT_GUARD_CHECK_CONSTANTS.CHILD_MAX_OUTPUT_BYTES) {
				child.kill('SIGKILL');
				finish(() => reject(new Error('classifier output too large')));
			}
		});
		child.stderr.on('data', (d: Buffer) => { err = (err + d.toString('utf8')).slice(-2000); });
		child.on('error', (e) => finish(() => reject(e)));
		child.on('close', (code) => finish(() => (code === 0 ? resolve(out) : reject(new Error(`classifier exited ${code}: ${err.trim().slice(0, 300)}`)))));
		child.stdin.on('error', () => { /* reported via close */ });
		child.stdin.end(stdin);
	});

/** Inputs of {@link runInputGuardCheck}. */
export interface InputGuardCheckInput {
	/** Build to classify with (see {@link resolveClassifierScript}) */
	build: string;
	/** Live views of the agents */
	views: InputGuardViewInput[];
	/** Process runner (tests inject one) */
	run?: ClassifierRunner;
	now?: () => number;
}

/**
 * Classify the live views with the build's guard.
 *
 * @param input - Build and views
 * @returns The report (never throws)
 */
export async function runInputGuardCheck(input: InputGuardCheckInput): Promise<InputGuardReport> {
	const checkedAt = new Date((input.now ?? Date.now)()).toISOString();
	const script = resolveClassifierScript(input.build);
	if (!script) {
		return {
			ok: true,
			unavailable: true,
			checkedAt,
			agents: [],
			error: `no input-guard script in ${input.build} (a build older than this check): not checked`,
		};
	}
	try {
		const stdout = await (input.run ?? spawnClassifier)(script, JSON.stringify({ sessions: input.views }));
		const parsed = JSON.parse(stdout) as { results?: InputGuardAgentResult[] };
		const agents = Array.isArray(parsed.results) ? parsed.results : [];
		return { ok: !agents.some((a) => a.verdict === 'fail'), script, checkedAt, agents };
	} catch (error) {
		return {
			ok: false,
			script,
			checkedAt,
			agents: [],
			error: `the new build's input guard could not be run: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * The failing agents of a report.
 *
 * @param report - Report
 * @returns Rows with verdict `fail`
 */
export function failingAgents(report: InputGuardReport): InputGuardAgentResult[] {
	return report.agents.filter((a) => a.verdict === 'fail');
}

/**
 * What a block means for the machine: the new package is already installed.
 *
 * @param version - Blocked target version
 * @param running - Version still running
 * @returns English sentence
 */
export function onDiskWarning(version: string, running?: string | null): string {
	return `Version ${version} is already installed on disk${running ? ` (Crewly keeps running ${running})` : ''}, so any restart (a crash, the supervisor, or a manual restart) will load ${version}.`;
}

/**
 * One English line for logs and the action record.
 *
 * @param report - A failed report
 * @param version - Target version, when known
 * @returns The sentence
 */
export function describeBlock(report: InputGuardReport, version?: string): string {
	const target = version ? ` ${version}` : '';
	if (report.error && report.agents.length === 0) return `New build${target} not restarted: ${report.error}.`;
	const bad = failingAgents(report);
	const names = bad.slice(0, 5).map((a) => a.session).join(', ');
	return `New build${target} not restarted: its input-box guard cannot read ${bad.length} idle agent${bad.length === 1 ? '' : 's'} (${names}${bad.length > 5 ? ', …' : ''}). It would hold their messages.`;
}

/**
 * Owner notice (short, English).
 *
 * @param report - A failed report
 * @param version - Target version
 * @param running - Version still running
 * @returns Title and message
 */
export function composeBlockNotice(report: InputGuardReport, version: string, running?: string | null): { title: string; message: string } {
	return {
		title: `Crewly ${version} was not restarted`,
		message: `${describeBlock(report)} ${onDiskWarning(version, running)} Ask to upgrade again with force to restart anyway.`,
	};
}

/** Marker of a build that is on disk but failed the check. */
export interface BlockedBuildMarker {
	version: string;
	at: string;
	failing: string[];
}

const blockedFile = (crewlyHome: string): string => path.join(crewlyHome, INPUT_GUARD_CHECK_CONSTANTS.BLOCKED_BUILD_FILE);

/**
 * Record that `version` is installed but was not restarted onto.
 *
 * @param crewlyHome - Crewly home
 * @param marker - What to record
 */
export function writeBlockedBuild(crewlyHome: string, marker: BlockedBuildMarker): void {
	try {
		fs.mkdirSync(crewlyHome, { recursive: true });
		fs.writeFileSync(blockedFile(crewlyHome), JSON.stringify(marker), 'utf-8');
	} catch {
		// best effort
	}
}

/**
 * Read the blocked-build marker.
 *
 * @param crewlyHome - Crewly home
 * @returns The marker, or null
 */
export function readBlockedBuild(crewlyHome: string): BlockedBuildMarker | null {
	try {
		const m = JSON.parse(fs.readFileSync(blockedFile(crewlyHome), 'utf-8')) as BlockedBuildMarker;
		return typeof m.version === 'string' ? m : null;
	} catch {
		return null;
	}
}

/**
 * Remove the blocked-build marker (a check passed, or the owner forced).
 *
 * @param crewlyHome - Crewly home
 */
export function clearBlockedBuild(crewlyHome: string): void {
	try {
		fs.rmSync(blockedFile(crewlyHome), { force: true });
	} catch {
		// best effort
	}
}

/**
 * Whether the owner was already told about `version` being blocked.
 *
 * @param crewlyHome - Crewly home
 * @param version - Target version
 * @returns True when a notice for it was sent
 */
export function wasBlockNotified(crewlyHome: string, version: string): boolean {
	try {
		const prev = JSON.parse(fs.readFileSync(path.join(crewlyHome, INPUT_GUARD_CHECK_CONSTANTS.LEDGER_FILE), 'utf-8')) as { version?: string };
		return prev.version === version;
	} catch {
		return false;
	}
}

/**
 * Record that the owner was told (call only after the send succeeded).
 *
 * @param crewlyHome - Crewly home
 * @param version - Target version
 */
export function recordBlockNotified(crewlyHome: string, version: string): void {
	try {
		fs.mkdirSync(crewlyHome, { recursive: true });
		fs.writeFileSync(path.join(crewlyHome, INPUT_GUARD_CHECK_CONSTANTS.LEDGER_FILE), JSON.stringify({ version, at: new Date().toISOString() }), 'utf-8');
	} catch {
		// best effort: worst case the owner is told twice
	}
}

/**
 * Plain-text table of a report (CLI).
 *
 * @param report - Report
 * @returns Lines
 */
export function formatReportLines(report: InputGuardReport): string[] {
	const lines: string[] = [];
	for (const a of report.agents) {
		lines.push(`${a.verdict.toUpperCase().padEnd(5)} ${a.session}  [${a.runtime}]  ${a.state}${a.idle ? '' : ' (busy)'}  ${a.reason}`);
	}
	if (report.error) lines.push(report.error);
	return lines;
}
