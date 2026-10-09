import { promises as fs } from 'fs';
import * as path from 'path';
import { prepareLiveCheckoutGuard, type LiveCheckoutGuard } from './live-checkout-guard.service.js';
import { CONTROL_PLANE_GUARD_CONSTANTS, AGENT_STATUS_HOOK_CONSTANTS, SUBAGENT_GUARD_CONSTANTS, RUNTIME_INPUT_SAFETY } from '../../constants.js';

/**
 * List the team directories that exist under `<crewlyHome>/teams` right now.
 *
 * The Bash hook needs literal paths, not globs, so protecting exactly
 * `teams/*\/config.json` (spec Part 2) means resolving the `*` at guard-prep
 * time against whatever teams already exist. A team created after this
 * session launched is not yet in the list — out of scope for this fix,
 * flagged in specs/2026-09-24-control-plane-isolation.md's coverage limits.
 *
 * @param crewlyHome - Crewly home directory (`~/.crewly`, or `$CREWLY_HOME`)
 * @returns Directory names under `teams/` (team ids); empty if the directory
 *   does not exist yet (a fresh install with no teams) or cannot be read
 */
async function listExistingTeamIds(crewlyHome: string): Promise<string[]> {
	const teamsDir = path.join(crewlyHome, CONTROL_PLANE_GUARD_CONSTANTS.TEAMS_DIR_NAME);
	try {
		const entries = await fs.readdir(teamsDir, { withFileTypes: true });
		return entries.filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
}

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
	/**
	 * Claude Code prompt suggestions stay off: a faint predicted user message
	 * in an empty input, accepted by Tab, must never reach a harness-driven
	 * session (2026-10-03 phantom owner input). Mirrors the env var set at launch.
	 */
	promptSuggestionEnabled: false;
	hooks: {
		/** The control-plane guard's Bash hook first; the agent-status hook (all tools) after it, when given. */
		PreToolUse: Array<HookGroup & { matcher: string }>;
		/** Agent-status hook events (#815) and subagent-guard events (#852), present only when those hooks are given. */
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
 * @param existingTeamIds - Team directory names to protect `config.json` for
 *   (spec Part 2 protects `teams/*\/config.json`, not the whole `teams/`
 *   subtree — a team directory also holds `norms/`, `wiki/`, `prompts/`,
 *   `sops/` and `cron-tasks.json`, which agents write routinely). Pass the
 *   ids returned by {@link listExistingTeamIds}; defaults to none, so
 *   calling this without them protects no team config (documented, not a
 *   silent gap — `prepareControlPlaneGuard` always supplies them).
 * @returns Write-denied paths (with a directory flag) and read-denied files
 *
 * @example
 * ```ts
 * const { writeDenied } = resolveControlPlanePaths(
 *   { crewlyHome: '/h/.crewly', installRoot: '/opt/crewly' },
 *   ['team-0001'],
 * );
 * // writeDenied includes { path: '/h/.crewly/teams/team-0001/config.json', isDirectory: false }
 * // writeDenied does NOT include '/h/.crewly/teams' itself — reads and
 * // writes to team-0001/wiki, norms, prompts, sops, cron-tasks.json stay allowed.
 * ```
 */
export function resolveControlPlanePaths(
	roots: ControlPlaneRoots,
	existingTeamIds: readonly string[] = [],
): ControlPlanePaths {
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
	for (const teamId of existingTeamIds) {
		add(path.join(roots.crewlyHome, C.TEAMS_DIR_NAME, teamId, C.TEAM_CONFIG_FILE_NAME), false);
	}
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
 * Code takes one `--settings`. It is registered on its own events
 * (Notification, PermissionRequest, Stop, UserPromptSubmit, PreToolUse,
 * PostToolUse, SubagentStart, SubagentStop, SessionStart). On PreToolUse it is a second
 * group after the guard's Bash group, and on the subagent events it sits next
 * to the subagent guard: groups are appended, never replaced, so the guard's
 * entry and the deny list are identical with or without it.
 *
 * @param paths - Resolved control-plane paths
 * @param hookCommand - Shell command that runs the PreToolUse Bash hook
 * @param statusHookCommand - Shell command that runs the agent-status hook; omit to leave it out
 * @param subagentHookCommand - Shell command that runs the subagent guard (#852); omit to leave it out
 * @param credentialGuard - The credential guard (specs/2026-10-04-agent-credential-isolation.md):
 *   its hook command (a PreToolUse group on Bash/Read/Grep/Glob, right after the
 *   control-plane group) and its `Read(...)` deny rules; omit to leave it out
 * @param liveCheckoutGuard - The live-checkout guard hook (a PreToolUse group on
 *   Bash and the file-editing tools); omit to leave it out
 * @returns Settings object ready to serialise
 */
export function buildControlPlaneSettings(
	paths: ControlPlanePaths,
	hookCommand: string,
	statusHookCommand?: string,
	subagentHookCommand?: string,
	credentialGuard?: { hookCommand: string; matcher: string; denyRules: string[] },
	liveCheckoutGuard?: Pick<LiveCheckoutGuard, 'hookCommand' | 'matcher'> | null,
): ControlPlaneSettings {
	const deny: string[] = [];
	for (const { path: p, isDirectory } of paths.writeDenied) {
		deny.push(`Edit(${toRuleSpecifier(p, false)})`);
		if (isDirectory) deny.push(`Edit(${toRuleSpecifier(p, true)})`);
	}
	for (const p of paths.readDenied) deny.push(`Read(${toRuleSpecifier(p, false)})`);
	if (credentialGuard) {
		for (const rule of credentialGuard.denyRules) if (!deny.includes(rule)) deny.push(rule);
	}

	const settings: ControlPlaneSettings = {
		permissions: { deny },
		promptSuggestionEnabled: RUNTIME_INPUT_SAFETY.CLAUDE_CODE_SETTINGS.promptSuggestionEnabled,
		hooks: {
			PreToolUse: [
				{
					matcher: CONTROL_PLANE_GUARD_CONSTANTS.HOOK_TOOL_MATCHER,
					hooks: [{ type: 'command', command: hookCommand }],
				},
			],
		},
	};
	if (credentialGuard) {
		settings.hooks.PreToolUse.push({
			matcher: credentialGuard.matcher,
			hooks: [{ type: 'command', command: credentialGuard.hookCommand }],
		});
	}
	if (liveCheckoutGuard) {
		settings.hooks.PreToolUse.push({
			matcher: liveCheckoutGuard.matcher,
			hooks: [{ type: 'command', command: liveCheckoutGuard.hookCommand }],
		});
	}
	const append = (event: string, group: HookGroup): void => {
		if (event === 'PreToolUse') {
			settings.hooks.PreToolUse.push({ ...group, matcher: group.matcher ?? AGENT_STATUS_HOOK_CONSTANTS.ALL_TOOLS_MATCHER });
			return;
		}
		(settings.hooks[event] ??= []).push(group);
	};
	if (subagentHookCommand) {
		for (const event of SUBAGENT_GUARD_CONSTANTS.EVENTS) {
			append(event, { hooks: [{ type: 'command', command: subagentHookCommand }] });
		}
	}
	if (statusHookCommand) {
		const S = AGENT_STATUS_HOOK_CONSTANTS;
		for (const event of S.EVENTS) {
			const group: HookGroup = { hooks: [{ type: 'command', command: statusHookCommand }] };
			if ((S.TOOL_EVENTS as readonly string[]).includes(event)) group.matcher = S.ALL_TOOLS_MATCHER;
			append(event, group);
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
 * @param credentialGuard - Credential guard hook + deny rules to merge in (optional)
 * @returns Where the files were written, or why the guard is off
 * @throws When the files cannot be written (the caller decides whether to launch unguarded)
 */
export async function prepareControlPlaneGuard(
	sessionName: string,
	roots: ControlPlaneRoots,
	env: NodeJS.ProcessEnv = process.env,
	credentialGuard?: { hookCommand: string; matcher: string; denyRules: string[] },
): Promise<ControlPlaneGuardResult> {
	const C = CONTROL_PLANE_GUARD_CONSTANTS;
	if (!isControlPlaneGuardEnabled(env)) {
		return { enabled: false, reason: `${C.KILL_SWITCH_ENV}=${C.KILL_SWITCH_OFF_VALUE}` };
	}

	const existingTeamIds = await listExistingTeamIds(roots.crewlyHome);
	const paths = resolveControlPlanePaths(roots, existingTeamIds);
	const dir = path.join(roots.crewlyHome, C.RUNTIME_DIR);
	const stem = toSafeFileStem(sessionName);
	const settingsPath = path.join(dir, `${stem}${C.SETTINGS_FILE_SUFFIX}`);
	const pathsPath = path.join(dir, `${stem}${C.PATHS_FILE_SUFFIX}`);
	const hookScript = path.join(roots.installRoot, C.HOOK_SCRIPT);
	const hookCommand = `bash ${shellQuote(hookScript)} ${shellQuote(pathsPath)}`;
	const statusHookCommand = `bash ${shellQuote(path.join(roots.installRoot, AGENT_STATUS_HOOK_CONSTANTS.HOOK_SCRIPT))}`;
	// The subagent guard (#852) has its own kill switch, checked here so a
	// disabled guard is not registered at all.
	const subagentHookCommand =
		env[SUBAGENT_GUARD_CONSTANTS.KILL_SWITCH_ENV] === SUBAGENT_GUARD_CONSTANTS.KILL_SWITCH_OFF_VALUE
			? undefined
			: `bash ${shellQuote(path.join(roots.installRoot, SUBAGENT_GUARD_CONSTANTS.HOOK_SCRIPT))}`;

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
		`${JSON.stringify(buildControlPlaneSettings(paths, hookCommand, statusHookCommand, subagentHookCommand, credentialGuard, prepareLiveCheckoutGuard(roots.installRoot, env)), null, 2)}\n`,
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
