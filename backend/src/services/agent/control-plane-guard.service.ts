import { promises as fs } from 'fs';
import * as path from 'path';
import { CONTROL_PLANE_GUARD_CONSTANTS, AGENT_STATUS_HOOK_CONSTANTS } from '../../constants.js';

/**
 * Control-plane guard for Claude Code agent sessions.
 *
 * Request 72c9427a, spec `specs/2026-09-24-control-plane-isolation.md` Part 3.
 * The backend writes two files per session under
 * `~/.crewly/runtime/control-plane/`:
 *
 * - `<session>.settings.json` — a Claude Code settings file with
 *   `permissions.deny` rules for the control-plane paths and a PreToolUse
 *   hook on the Bash tool. It is passed with `claude --settings <file>`.
 * - `<session>.paths` — the protected-path list the hook script reads.
 *
 * Both files, and the hook script itself, are on their own deny list.
 *
 * Coverage (stated in the hook's output as well): this stops an agent editing
 * the stop/start/config mechanisms with its normal tools, and accidental
 * edits. It does NOT stop an interpreter one-liner, a runtime-built path, or a
 * call to the loopback API. That needs OS-level isolation (spec Part 4).
 */

/** Roots the protected paths are resolved against. */
export interface ControlPlaneRoots {
	/** Crewly home directory (`~/.crewly`, or `$CREWLY_HOME`). */
	crewlyHome: string;
	/** Crewly install root (package dir or checkout) that holds `config/` and `dist/`. */
	installRoot: string;
	/** The agent's working directory / project path, when known. */
	projectPath?: string;
}

/** Protected paths, split by what is denied. */
export interface ControlPlanePaths {
	/** Paths agents may not write. Directories protect their whole subtree. */
	writeDenied: Array<{ path: string; isDirectory: boolean }>;
	/** Files agents may not read with the built-in Read/Grep/Glob tools. */
	readDenied: string[];
}

/** One Claude Code hook group: an optional tool matcher and its commands. */
export interface HookGroup {
	matcher?: string;
	hooks: Array<{ type: 'command'; command: string }>;
}

/** Shape of the generated Claude Code settings file (the subset we write). */
export interface ControlPlaneSettings {
	permissions: { deny: string[] };
	hooks: {
		/** The control-plane guard's Bash hook. Nothing else is ever added here. */
		PreToolUse: Array<HookGroup & { matcher: string }>;
		/** Agent-status hook events (#815), present only when a status hook is given. */
		[event: string]: HookGroup[];
	};
}

/** Result of preparing the guard for one session. */
export type ControlPlaneGuardResult =
	| { enabled: true; settingsPath: string; pathsPath: string; protectedCount: number }
	| { enabled: false; reason: string };

/**
 * Whether the guard is on for sessions launched by this backend.
 *
 * Read from the backend's own environment at launch, so an agent session
 * cannot switch it off: exporting the variable inside a session changes that
 * shell, not the backend.
 *
 * @param env - Environment to read (defaults to the backend's process.env)
 * @returns false only when `CREWLY_CONTROL_PLANE_GUARD=0`
 */
export function isControlPlaneGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[CONTROL_PLANE_GUARD_CONSTANTS.KILL_SWITCH_ENV] !== CONTROL_PLANE_GUARD_CONSTANTS.KILL_SWITCH_OFF_VALUE;
}

/**
 * Resolve every control-plane path (spec Part 2 table) to an absolute path.
 *
 * Duplicates are dropped, e.g. when the project path is the install root.
 *
 * @param roots - Crewly home, install root and optional project path
 * @returns Write-denied paths (with a directory flag) and read-denied files
 *
 * @example
 * ```ts
 * const { writeDenied } = resolveControlPlanePaths({ crewlyHome: '/h/.crewly', installRoot: '/opt/crewly' });
 * // writeDenied includes { path: '/h/.crewly/teams', isDirectory: true }
 * ```
 */
export function resolveControlPlanePaths(roots: ControlPlaneRoots): ControlPlanePaths {
	const C = CONTROL_PLANE_GUARD_CONSTANTS;
	const seen = new Set<string>();
	const writeDenied: ControlPlanePaths['writeDenied'] = [];
	const add = (p: string, isDirectory: boolean): void => {
		const abs = path.resolve(p);
		if (seen.has(abs)) return;
		seen.add(abs);
		writeDenied.push({ path: abs, isDirectory });
	};

	for (const d of C.CREWLY_HOME_DIRS) add(path.join(roots.crewlyHome, d), true);
	for (const f of C.CREWLY_HOME_FILES) add(path.join(roots.crewlyHome, f), false);
	for (const d of C.INSTALL_DIRS) add(path.join(roots.installRoot, d), true);
	for (const f of C.INSTALL_FILES) add(path.join(roots.installRoot, f), false);
	if (roots.projectPath) {
		for (const d of C.PROJECT_DIRS) add(path.join(roots.projectPath, d), true);
	}

	const readDenied = C.CREWLY_HOME_READ_DENIED_FILES.map((f) => path.resolve(roots.crewlyHome, f));
	return { writeDenied, readDenied };
}

/**
 * Format an absolute path as a Claude Code permission-rule specifier.
 *
 * In Claude Code rules `//x` is an absolute path, while `/x` is relative to
 * the settings file, so an absolute path gets one extra leading slash.
 *
 * @param absPath - Absolute filesystem path
 * @param isDirectory - Append `/**` to cover the subtree
 * @returns Specifier such as `//Users/me/.crewly/teams/**`
 */
export function toRuleSpecifier(absPath: string, isDirectory: boolean): string {
	const base = `/${absPath}`;
	return isDirectory ? `${base}/**` : base;
}

/**
 * Build the Claude Code settings object for one session.
 *
 * Deny rules use `Edit(...)`, which Claude Code applies to every built-in
 * file-editing tool (Edit, Write, NotebookEdit), and `Read(...)` for the API
 * token. Only documented rule forms are emitted: an invalid rule could get
 * the whole settings file rejected, and the Bash hook with it.
 *
 * The agent-status hook (#815) is merged into the same file, because Claude
 * Code takes one `--settings`. It is registered only on its own events
 * (Notification, PermissionRequest, Stop, UserPromptSubmit, PostToolUse) and
 * never on PreToolUse, so the guard's entry and the deny list are identical
 * with or without it.
 *
 * @param paths - Resolved control-plane paths
 * @param hookCommand - Shell command that runs the PreToolUse Bash hook
 * @param statusHookCommand - Shell command that runs the agent-status hook; omit to leave it out
 * @returns Settings object ready to serialise
 */
export function buildControlPlaneSettings(
	paths: ControlPlanePaths,
	hookCommand: string,
	statusHookCommand?: string,
): ControlPlaneSettings {
	const deny: string[] = [];
	for (const { path: p, isDirectory } of paths.writeDenied) {
		deny.push(`Edit(${toRuleSpecifier(p, false)})`);
		if (isDirectory) deny.push(`Edit(${toRuleSpecifier(p, true)})`);
	}
	for (const p of paths.readDenied) deny.push(`Read(${toRuleSpecifier(p, false)})`);

	const settings: ControlPlaneSettings = {
		permissions: { deny },
		hooks: {
			PreToolUse: [
				{
					matcher: CONTROL_PLANE_GUARD_CONSTANTS.HOOK_TOOL_MATCHER,
					hooks: [{ type: 'command', command: hookCommand }],
				},
			],
		},
	};
	if (statusHookCommand) {
		const S = AGENT_STATUS_HOOK_CONSTANTS;
		for (const event of S.EVENTS) {
			const group: HookGroup = { hooks: [{ type: 'command', command: statusHookCommand }] };
			if ((S.TOOL_EVENTS as readonly string[]).includes(event)) group.matcher = S.ALL_TOOLS_MATCHER;
			settings.hooks[event] = [group];
		}
	}
	return settings;
}

/**
 * Make a session name safe to use as a file name.
 *
 * @param sessionName - Crewly session name
 * @returns Name with anything outside `[A-Za-z0-9._-]` replaced by `_`
 */
export function toSafeFileStem(sessionName: string): string {
	const stem = sessionName.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
	return stem.length > 0 ? stem : '_';
}

/**
 * Quote a value for a POSIX shell command line.
 *
 * @param value - Raw string
 * @returns Single-quoted string with embedded quotes escaped
 */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Write the per-session settings file and protected-path list.
 *
 * @param sessionName - Crewly session name (used for the file names)
 * @param roots - Crewly home, install root and optional project path
 * @param env - Environment holding the kill switch (defaults to process.env)
 * @returns Where the files were written, or why the guard is off
 * @throws When the files cannot be written (the caller decides whether to launch unguarded)
 */
export async function prepareControlPlaneGuard(
	sessionName: string,
	roots: ControlPlaneRoots,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ControlPlaneGuardResult> {
	const C = CONTROL_PLANE_GUARD_CONSTANTS;
	if (!isControlPlaneGuardEnabled(env)) {
		return { enabled: false, reason: `${C.KILL_SWITCH_ENV}=${C.KILL_SWITCH_OFF_VALUE}` };
	}

	const paths = resolveControlPlanePaths(roots);
	const dir = path.join(roots.crewlyHome, C.RUNTIME_DIR);
	const stem = toSafeFileStem(sessionName);
	const settingsPath = path.join(dir, `${stem}${C.SETTINGS_FILE_SUFFIX}`);
	const pathsPath = path.join(dir, `${stem}${C.PATHS_FILE_SUFFIX}`);
	const hookScript = path.join(roots.installRoot, C.HOOK_SCRIPT);
	const hookCommand = `bash ${shellQuote(hookScript)} ${shellQuote(pathsPath)}`;
	const statusHookCommand = `bash ${shellQuote(path.join(roots.installRoot, AGENT_STATUS_HOOK_CONSTANTS.HOOK_SCRIPT))}`;

	const pathsBody = [
		`# Crewly control-plane guard — protected paths for ${sessionName}`,
		'# Generated by the backend at launch; one absolute path per line.',
		...paths.writeDenied.map((p) => p.path),
		'',
	].join('\n');

	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(pathsPath, pathsBody, 'utf-8');
	await fs.writeFile(
		settingsPath,
		`${JSON.stringify(buildControlPlaneSettings(paths, hookCommand, statusHookCommand), null, 2)}\n`,
		'utf-8',
	);

	return { enabled: true, settingsPath, pathsPath, protectedCount: paths.writeDenied.length };
}

/**
 * Append `--settings <file>` to a Claude Code launch command.
 *
 * Only commands that carry `--dangerously-skip-permissions` (the Crewly agent
 * launch line) are changed. A command that already passes `--settings` is
 * left alone: the owner configured their own, and Claude Code takes one.
 *
 * @param cmd - Launch command line
 * @param settingsPath - Generated settings file
 * @returns The command with the flag appended, or unchanged
 */
export function applyControlPlaneSettingsFlag(cmd: string, settingsPath: string): string {
	const flag = CONTROL_PLANE_GUARD_CONSTANTS.SETTINGS_FLAG;
	if (!cmd.includes('--dangerously-skip-permissions')) return cmd;
	if (new RegExp(`(^|\\s)${flag}(\\s|=|$)`).test(cmd)) return cmd;
	return `${cmd} ${flag} "${settingsPath.replace(/["`$\\]/g, '')}"`;
}
