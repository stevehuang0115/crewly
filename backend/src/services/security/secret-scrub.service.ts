/**
 * One-time scrub of secrets already written to disk.
 *
 * Before #806 Crewly typed `export GEMINI_API_KEY=…` (and other keys) into
 * agent shells, so keys sit in ~/.crewly/logs/sessions/*.log, in the gzipped
 * rotations under ~/.crewly/logs/archive/, and in the user's shell history.
 * This service runs every such file through the same redactor the live
 * session-log writer uses (utils/secret-redactor).
 *
 * - Dry run by default: reports what WOULD be masked; nothing is written.
 * - Reports counts only — never a secret value, never a matched line.
 * - Idempotent: a second `apply` finds 0 (masks are never re-masked) and
 *   rewrites nothing.
 * - Files are read and written as bytes (latin1): zsh stores history
 *   "metafied" (not valid UTF-8), so a UTF-8 round trip would corrupt it.
 *   Every pattern is ASCII, so byte-wise matching is exact.
 * - Rewrites are atomic (temp file + rename) and keep the file mode.
 *
 * Used by `crewly security scrub-logs [--apply]`.
 *
 * @module services/security/secret-scrub.service
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { gunzipSync, gzipSync } from 'zlib';
import { LOG_ROTATION_CONSTANTS, SECRET_SCRUB_CONSTANTS } from '../../constants.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { collectSecretEnvValues, type SecretEnvValue } from '../../utils/secret-env.js';
import { redactSecretsWithCount } from '../../utils/secret-redactor.js';

/** Which kind of file a scrub target is. */
export type ScrubTargetKind = 'session-log' | 'session-log-archive' | 'shell-history';

/** Per-file outcome (path + counts only, never content). */
export interface ScrubFileResult {
	/** Absolute path */
	path: string;
	/** Kind of file */
	kind: ScrubTargetKind;
	/** Secrets found (dry run) or masked (apply) */
	secrets: number;
	/** Whether the file was rewritten */
	rewritten: boolean;
	/** Error message when the file could not be read/written (no content) */
	error?: string;
}

/** Totals for one scrub run. */
export interface ScrubSummary {
	/** True when files were rewritten; false for a dry run */
	applied: boolean;
	/** Files examined */
	filesScanned: number;
	/** Files that contain (dry run) / contained (apply) at least one secret */
	filesWithSecrets: number;
	/** Files rewritten */
	filesRewritten: number;
	/** Total secrets found or masked */
	secrets: number;
	/** Files that could not be processed */
	errors: number;
	/** Per-file detail */
	files: ScrubFileResult[];
}

/** Options for a scrub run. */
export interface ScrubOptions {
	/** Rewrite files (default false: dry run) */
	apply?: boolean;
	/** CREWLY_HOME override (default getCrewlyHomePath()) */
	crewlyHome?: string;
	/** Home directory whose shell history is scrubbed (default os.homedir()) */
	homeDir?: string;
	/** Also scrub shell history files (default true) */
	includeShellHistory?: boolean;
	/** Env maps whose secret-named values are masked by exact value (default [process.env]) */
	envs?: ReadonlyArray<Record<string, string | undefined>>;
}

/** A file to scrub. */
interface ScrubTarget {
	path: string;
	kind: ScrubTargetKind;
}

/**
 * Collects exact secret values from settings.json `apiKeys` (every string
 * leaf) so keys that were typed into shells are masked even when their
 * shape is unknown. Read directly from the file: no settings service side
 * effects (migrations) in a scrub.
 *
 * @param crewlyHome - CREWLY_HOME path
 * @returns Secret values, labelled SETTINGS_<PATH>
 */
export async function collectSettingsSecretValues(crewlyHome: string): Promise<SecretEnvValue[]> {
	let raw: string;
	try {
		raw = await fs.readFile(path.join(crewlyHome, SECRET_SCRUB_CONSTANTS.SETTINGS_FILE), 'utf8');
	} catch {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	const apiKeys = (parsed as { apiKeys?: unknown } | null)?.apiKeys;
	const env: Record<string, string> = {};
	const walk = (node: unknown, trail: string[]): void => {
		if (typeof node === 'string') {
			// Name ends in _API_KEY so collectSecretEnvValues treats it as secret
			env[`SETTINGS_${trail.join('_').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_API_KEY`] = node;
		} else if (node && typeof node === 'object') {
			for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, [...trail, k]);
		}
	};
	walk(apiKeys, []);
	return collectSecretEnvValues(env);
}

/**
 * Lists the files a scrub covers: session logs, their gzipped rotations and
 * (optionally) the user's shell history files. Missing files are skipped.
 *
 * @param crewlyHome - CREWLY_HOME path
 * @param homeDir - User home directory
 * @param includeShellHistory - Include shell history files
 * @returns Existing regular files to scrub
 */
export async function listScrubTargets(crewlyHome: string, homeDir: string, includeShellHistory: boolean): Promise<ScrubTarget[]> {
	const logsDir = path.join(crewlyHome, LOG_ROTATION_CONSTANTS.LOGS_DIR);
	const targets: ScrubTarget[] = [];

	const listDir = async (dir: string, kind: ScrubTargetKind, accept: (name: string) => boolean): Promise<void> => {
		const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const e of entries) {
			if (e.isFile() && accept(e.name)) targets.push({ path: path.join(dir, e.name), kind });
		}
	};
	await listDir(path.join(logsDir, LOG_ROTATION_CONSTANTS.SESSIONS_LOG_DIR), 'session-log', () => true);
	await listDir(path.join(logsDir, LOG_ROTATION_CONSTANTS.ARCHIVE_DIR), 'session-log-archive', (n) => n.endsWith('.gz'));

	if (includeShellHistory) {
		const seen = new Set<string>();
		const candidates = SECRET_SCRUB_CONSTANTS.SHELL_HISTORY_FILES.map((f) => path.join(homeDir, f));
		for (const p of candidates) {
			if (seen.has(p)) continue;
			seen.add(p);
			const stat = await fs.lstat(p).catch(() => null);
			if (stat?.isFile()) targets.push({ path: p, kind: 'shell-history' });
		}
	}
	return targets;
}

/**
 * Writes a file atomically (temp file in the same directory + rename),
 * keeping the original mode.
 *
 * @param filePath - Target path
 * @param data - New content
 * @param mode - File mode to keep
 */
async function writeAtomic(filePath: string, data: Buffer, mode: number): Promise<void> {
	const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.scrub-${process.pid}-${Date.now()}`);
	try {
		await fs.writeFile(tmp, data, { mode });
		await fs.chmod(tmp, mode);
		await fs.rename(tmp, filePath);
	} catch (err) {
		await fs.rm(tmp, { force: true }).catch(() => undefined);
		throw err;
	}
}

/**
 * Scrubs one file: counts secrets and, when applying, rewrites it if any
 * were found.
 *
 * @param target - File to scrub
 * @param knownSecrets - Exact values to mask
 * @param apply - Rewrite the file
 * @returns Per-file result (counts only)
 */
async function scrubFile(target: ScrubTarget, knownSecrets: readonly SecretEnvValue[], apply: boolean): Promise<ScrubFileResult> {
	const result: ScrubFileResult = { path: target.path, kind: target.kind, secrets: 0, rewritten: false };
	try {
		const stat = await fs.stat(target.path);
		const raw = await fs.readFile(target.path);
		const isGzip = target.kind === 'session-log-archive';
		const bytes = isGzip ? gunzipSync(raw) : raw;
		const { text, count } = redactSecretsWithCount(bytes.toString('latin1'), knownSecrets);
		result.secrets = count;
		if (apply && count > 0) {
			const out = Buffer.from(text, 'latin1');
			await writeAtomic(target.path, isGzip ? gzipSync(out) : out, stat.mode & 0o777);
			result.rewritten = true;
		}
	} catch (err) {
		// The message names the failure only (ENOENT, EACCES, bad gzip…), never content
		result.error = err instanceof Error ? (err as NodeJS.ErrnoException).code ?? err.message : String(err);
	}
	return result;
}

/**
 * Runs the scrub (dry run unless `apply`).
 *
 * @param options - See ScrubOptions
 * @returns Totals and per-file counts — no secret values
 *
 * @example
 * ```ts
 * const dry = await scrubSecretsOnDisk();            // what would change
 * const done = await scrubSecretsOnDisk({ apply: true });
 * ```
 */
export async function scrubSecretsOnDisk(options: ScrubOptions = {}): Promise<ScrubSummary> {
	const apply = options.apply === true;
	const crewlyHome = options.crewlyHome ?? getCrewlyHomePath();
	const homeDir = options.homeDir ?? os.homedir();
	const knownSecrets = mergeSecretValues(
		collectSecretEnvValues(...(options.envs ?? [process.env])),
		await collectSettingsSecretValues(crewlyHome),
	);

	const targets = await listScrubTargets(crewlyHome, homeDir, options.includeShellHistory !== false);
	const files: ScrubFileResult[] = [];
	for (const target of targets) files.push(await scrubFile(target, knownSecrets, apply));

	return {
		applied: apply,
		filesScanned: files.length,
		filesWithSecrets: files.filter((f) => f.secrets > 0).length,
		filesRewritten: files.filter((f) => f.rewritten).length,
		secrets: files.reduce((n, f) => n + f.secrets, 0),
		errors: files.filter((f) => f.error).length,
		files,
	};
}

/**
 * Merges secret-value lists, de-duplicated by value, longest first.
 *
 * @param lists - Lists to merge
 * @returns Merged list
 */
function mergeSecretValues(...lists: ReadonlyArray<readonly SecretEnvValue[]>): SecretEnvValue[] {
	const byValue = new Map<string, SecretEnvValue>();
	for (const list of lists) for (const s of list) if (!byValue.has(s.value)) byValue.set(s.value, s);
	return Array.from(byValue.values()).sort((a, b) => b.value.length - a.value.length);
}
