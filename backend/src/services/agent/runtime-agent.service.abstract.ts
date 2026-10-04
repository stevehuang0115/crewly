import { promises as fs, existsSync } from 'fs';
import { readFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { SessionCommandHelper } from '../session/index.js';
import { RuntimeType, ADDON_CONSTANTS, ANTIGRAVITY_CONSTANTS, RUNTIME_INPUT_READY_PATTERNS, RUNTIME_TYPES } from '../../constants.js';
import {
	stripAnsiCodes,
	isPromptLine,
	containsSpinnerOrWorkingIndicator,
	containsBusyStatusBar,
} from '../../utils/terminal-string-ops.js';
import { getSettingsService } from '../settings/settings.service.js';
import { safeReadJson, atomicWriteJson } from '../../utils/file-io.utils.js';
import { getUserNpmBinDir } from '../harness/harness-exec.utils.js';
import { delay } from '../../utils/async.utils.js';
import type { AIRuntime } from '../../types/settings.types.js';
import { toCodexResumeCommand } from './runtime-session-recovery.js';
import { detectRuntimeCliMissing, isRuntimeStartupBlockedError } from './runtime-startup-blocked.error.js';
import { injectRuntimeFlags } from '../../utils/runtime-model-flags.utils.js';
import { codexSupportsNoDaemon, withCodexNoDaemon, codexSupportsFlag } from './codex-daemon.utils.js';
import {
	isCredentialGuardEnabled,
	prepareCredentialGuard,
	claudeCredentialReadDenyRules,
	codexCredentialGuardArgs,
	withCodexCredentialGuard,
	writeGeminiCredentialGuardSettings,
	syncAntigravityCredentialHook,
	type CredentialGuardFiles,
} from './credential-guard.service.js';
import { CREDENTIAL_GUARD_CONSTANTS } from '../../constants.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { quietShellLine, shellHistoryDisableLine } from '../../utils/shell-history.js';
import { AgentTurnStateService } from '../monitoring/agent-turn-state.js';
import {
	prepareControlPlaneGuard,
	applyControlPlaneSettingsFlag,
} from './control-plane-guard.service.js';

/**
 * Environment variable that stops OpenCode from self-upgrading on launch
 * (https://opencode.ai/docs/cli/). Prefixed onto the init command like
 * `GEMINI_NO_UPDATE=1` is for Gemini (#229).
 */
const OPENCODE_DISABLE_AUTOUPDATE_ENV = 'OPENCODE_DISABLE_AUTOUPDATE';

/** `AGY_CLI_DISABLE_AUTO_UPDATE=true ` — prefixed onto an Antigravity launch command. */
const ANTIGRAVITY_AUTOUPDATE_PREFIX = `${ANTIGRAVITY_CONSTANTS.DISABLE_AUTO_UPDATE_ENV}=${ANTIGRAVITY_CONSTANTS.DISABLE_AUTO_UPDATE_VALUE}`;

/**
 * Result of MCP configuration operation.
 * Returned by ensureMcpConfig to indicate what was configured.
 */
export interface McpConfigResult {
	/** Whether the config was written successfully */
	success: boolean;
	/** Number of new servers added */
	addedServers: number;
	/** Total servers in the final config */
	totalServers: number;
	/** Names of servers in the final config */
	serverNames: string[];
	/** Error message if success is false */
	error?: string;
}

/**
 * Runtime configuration interface
 */
export interface RuntimeConfig {
	displayName: string;
	initScript: string;
	welcomeMessage: string;
	timeout: number;
	description: string;
}

/**
 * Abstract base class for AI runtime services that handles tmux session initialization,
 * detection, and interaction patterns for different AI CLI tools.
 *
 * Uses Template Method pattern for maximum code reuse while allowing runtime-specific customization.
 */
export abstract class RuntimeAgentService {
	protected logger: ComponentLogger;
	protected sessionHelper: SessionCommandHelper;
	protected projectRoot: string;
	protected runtimeConfig: RuntimeConfig | null = null;

	// State management for detection to prevent concurrent attempts
	private detectionInProgress: Map<string, boolean> = new Map();
	private detectionResults: Map<string, { isRuntimeRunning: boolean; timestamp: number }> =
		new Map();

	constructor(sessionHelper: SessionCommandHelper, projectRoot: string) {
		this.logger = LoggerService.getInstance().createComponentLogger(`${this.constructor.name}`);
		this.sessionHelper = sessionHelper;
		this.projectRoot = projectRoot;
		this.initializeRuntimeConfig();
	}

	// Abstract methods that each concrete runtime MUST implement
	protected abstract getRuntimeType(): RuntimeType;
	protected abstract detectRuntimeSpecific(sessionName: string): Promise<boolean>;
	protected abstract getRuntimeReadyPatterns(): string[];
	protected abstract getRuntimeErrorPatterns(): string[];
	protected abstract getRuntimeExitPatterns(): RegExp[];

	/**
	 * Get patterns that indicate this runtime has exited.
	 * Used by RuntimeExitMonitorService to detect when the CLI process exits.
	 *
	 * @returns Array of RegExp patterns that match runtime exit output
	 */
	getExitPatterns(): RegExp[] {
		return this.getRuntimeExitPatterns();
	}

	/**
	 * Apply the control-plane guard to the launch commands (Request 72c9427a).
	 *
	 * For Claude Code, writes the per-session settings file (deny rules plus a
	 * PreToolUse Bash hook) and appends `--settings <file>`. Every runtime logs
	 * one line saying whether it is guarded, so the coverage is visible at
	 * launch. If the files cannot be written, the session still launches, but
	 * unguarded and with an ERROR. Blocking agent start on the guard would turn
	 * a disk error into an outage.
	 *
	 * @param sessionName - PTY session name
	 * @param commands - Launch commands built so far
	 * @param targetPath - Agent working directory, whose `.claude/agents` is protected
	 * @returns The commands, with `--settings` appended when the guard applies
	 */
	protected async applyControlPlaneGuard(sessionName: string, commands: string[], targetPath?: string): Promise<string[]> {
		const runtimeType = this.getRuntimeType();
		if (runtimeType !== RUNTIME_TYPES.CLAUDE_CODE) {
			this.logger.info('Control-plane guard: not available for this runtime (unguarded)', { sessionName, runtimeType });
			return this.applyCredentialGuardNonClaude(sessionName, commands);
		}
		// A new runtime process: its turn state starts clean, and background
		// work the old process launched (and the restart killed) is ignored.
		AgentTurnStateService.getInstance().noteRuntimeStart(sessionName);
		try {
			// The credential guard rides in the same settings file (Claude takes one --settings).
			const cred = this.prepareCredentialGuardFiles(sessionName);
			const guard = await prepareControlPlaneGuard(sessionName, {
				crewlyHome: getCrewlyHomePath(),
				installRoot: this.projectRoot,
				projectPath: targetPath,
			}, process.env, cred ? {
				hookCommand: `bash '${cred.wrappers.claude.replace(/'/g, `'\\''`)}'`,
				matcher: CREDENTIAL_GUARD_CONSTANTS.CLAUDE_MATCHER,
				denyRules: claudeCredentialReadDenyRules(cred.guarded),
			} : undefined);
			if (!guard.enabled) {
				this.logger.warn('Control-plane guard: disabled by kill switch (unguarded)', { sessionName, reason: guard.reason });
				return commands;
			}
			const updated = commands.map((cmd) => applyControlPlaneSettingsFlag(cmd, guard.settingsPath));
			const applied = updated.some((cmd, i) => cmd !== commands[i]);
			this.logger.info(
				applied
					? 'Control-plane guard: active (deny rules + Bash hook via --settings)'
					: 'Control-plane guard: settings written but not injected (command has its own --settings or no --dangerously-skip-permissions)',
				{ sessionName, runtimeType, settingsPath: guard.settingsPath, protectedPaths: guard.protectedCount },
			);
			return updated;
		} catch (error) {
			this.logger.error('Control-plane guard: could not write settings — launching unguarded', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
			return commands;
		}
	}

	/**
	 * Write the credential guard's paths file and wrappers
	 * (specs/2026-10-04-agent-credential-isolation.md, layer 2).
	 *
	 * @param sessionName - PTY session name (for logs)
	 * @returns The files, or null when the guard is off or could not be written
	 */
	protected prepareCredentialGuardFiles(sessionName: string): CredentialGuardFiles | null {
		if (!isCredentialGuardEnabled()) {
			this.logger.warn('Credential guard: disabled by kill switch (agents can read Crewly credential files)', { sessionName });
			return null;
		}
		try {
			return prepareCredentialGuard(getCrewlyHomePath(), this.projectRoot);
		} catch (error) {
			this.logger.error('Credential guard: could not write its files — launching without it', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	/**
	 * Attach the credential guard for runtimes other than Claude Code.
	 *
	 * - Codex: a session PreToolUse hook via `-c`, plus the flag that lets a
	 *   session hook run without a trust prompt (skipped, with a WARN, on a
	 *   Codex that does not know the flag — passing it would stop Codex starting).
	 * - Gemini CLI: `GEMINI_CLI_SYSTEM_SETTINGS_PATH=<file>` with a BeforeTool hook.
	 * - Antigravity: Crewly's entry in agy's global hooks file (agy has no
	 *   per-process hooks path); the script ignores calls from the owner's own agy.
	 * - Anything else (OpenCode): unguarded, logged.
	 *
	 * Never blocks a launch: on any failure the session starts unguarded with a WARN.
	 *
	 * @param sessionName - PTY session name
	 * @param commands - Launch commands
	 * @returns The commands, changed for Codex and Gemini CLI
	 */
	protected async applyCredentialGuardNonClaude(sessionName: string, commands: string[]): Promise<string[]> {
		const runtimeType = this.getRuntimeType();
		if (runtimeType === RUNTIME_TYPES.ANTIGRAVITY_CLI && !isCredentialGuardEnabled()) {
			try { syncAntigravityCredentialHook(null); } catch { /* best effort */ }
		}
		const cred = this.prepareCredentialGuardFiles(sessionName);
		if (!cred) return commands;
		try {
			// Codex: attached after the resume/--no-daemon rewrites (applyCodexCredentialGuard).
			if (runtimeType === RUNTIME_TYPES.CODEX_CLI) return commands;
			if (runtimeType === RUNTIME_TYPES.GEMINI_CLI) {
				const file = writeGeminiCredentialGuardSettings(path.dirname(cred.pathsFile), cred.wrappers.gemini);
				const prefix = `${CREDENTIAL_GUARD_CONSTANTS.GEMINI_SYSTEM_SETTINGS_ENV}='${file.replace(/'/g, `'\\''`)}'`;
				this.logger.info('Credential guard: active (Gemini CLI BeforeTool hook via system settings)', { sessionName });
				return commands.map((cmd) => (cmd.includes(CREDENTIAL_GUARD_CONSTANTS.GEMINI_SYSTEM_SETTINGS_ENV) || !/\bgemini\b/.test(cmd) ? cmd : `${prefix} ${cmd}`));
			}
			if (runtimeType === RUNTIME_TYPES.ANTIGRAVITY_CLI) {
				const result = syncAntigravityCredentialHook(cred.wrappers.antigravity);
				if (result === 'skipped-not-object') {
					this.logger.warn("Credential guard: agy's hooks file is not a JSON object — left alone, agy sessions unguarded", { sessionName });
				} else {
					this.logger.info("Credential guard: active (agy PreToolUse hook in agy's global hooks file)", { sessionName, hooksFile: result });
				}
				return commands;
			}
			this.logger.warn('Credential guard: this runtime has no pre-tool hook Crewly can use (unguarded)', { sessionName, runtimeType });
			return commands;
		} catch (error) {
			this.logger.error('Credential guard: could not be attached — launching without it', {
				sessionName,
				runtimeType,
				error: error instanceof Error ? error.message : String(error),
			});
			return commands;
		}
	}

	/**
	 * Codex part of the credential guard, applied last so the `codex resume`
	 * rewrite has already happened: a session PreToolUse hook via `-c`, plus
	 * the flag that lets it run without a trust prompt. On a Codex that does
	 * not list that flag the session starts unguarded with a WARN (passing an
	 * unknown flag would stop Codex starting).
	 *
	 * @param sessionName - PTY session name
	 * @param commands - Codex launch commands
	 * @returns The commands with the hook arguments added when supported
	 */
	protected async applyCodexCredentialGuard(sessionName: string, commands: string[]): Promise<string[]> {
		const cred = this.prepareCredentialGuardFiles(sessionName);
		if (!cred) return commands;
		try {
			const args = codexCredentialGuardArgs(cred.wrappers.codex);
			if (!args) {
				this.logger.warn('Credential guard: Codex hook path cannot be embedded (quote in path) — unguarded', { sessionName });
				return commands;
			}
			if (!(await codexSupportsFlag(CREDENTIAL_GUARD_CONSTANTS.CODEX_HOOK_TRUST_FLAG))) {
				this.logger.warn(`Credential guard: this Codex has no ${CREDENTIAL_GUARD_CONSTANTS.CODEX_HOOK_TRUST_FLAG} — unguarded (upgrade Codex)`, { sessionName });
				return commands;
			}
			this.logger.info('Credential guard: active (Codex session PreToolUse hook)', { sessionName });
			return commands.map((cmd) => withCodexCredentialGuard(cmd, args));
		} catch (error) {
			this.logger.error('Credential guard: could not be attached to Codex — launching without it', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
			return commands;
		}
	}

	/**
	 * Launch Codex with `--no-daemon` so its shell commands run in this
	 * agent's own process and carry this agent's identity env.
	 *
	 * Without it every Codex TUI on the machine attaches to one shared
	 * `codex app-server` daemon, started by whichever Codex session came
	 * first (usually the orchestrator), and every agent's skills then ran as
	 * that session (see codex-daemon.utils). A Codex too old to know the flag
	 * launches as before, with a WARN, rather than failing to start.
	 *
	 * @param sessionName - PTY session name
	 * @param commands - Codex launch commands built so far
	 * @returns The commands, with `--no-daemon` added when supported
	 */
	protected async keepCodexOffSharedDaemon(sessionName: string, commands: string[]): Promise<string[]> {
		if (!(await codexSupportsNoDaemon())) {
			this.logger.warn('Codex has no --no-daemon flag: this agent may run its commands in a shared app-server with another agent\'s identity', { sessionName });
			return commands;
		}
		const updated = commands.map(withCodexNoDaemon);
		if (updated.some((cmd, i) => cmd !== commands[i])) {
			this.logger.info('Codex launched with --no-daemon (commands keep this agent\'s identity)', { sessionName });
		}
		return updated;
	}

	/**
	 * Template method for executing runtime initialization script.
	 * Most logic is shared, only runtime-specific parts are delegated to abstract methods.
	 *
	 * @param sessionName - PTY session name
	 * @param targetPath - Working directory for the session
	 * @param runtimeFlags - Optional CLI flags to inject after the runtime binary (skill flags, --model/-m …)
	 * @param promptFilePath - Optional path to a prompt file; for non-Claude-Code runtimes,
	 *                         appends --append-system-prompt-file flag
	 * @param agentName - Optional agent name for Claude Code --agent flag (#207)
	 * @param resumeSessionId - Conversation to resume for runtimes whose resume is a
	 *   subcommand rather than a flag (Codex: `codex … ` → `codex resume … <id>`)
	 */
	async executeRuntimeInitScript(sessionName: string, targetPath?: string, runtimeFlags?: string[], promptFilePath?: string, agentName?: string, resumeSessionId?: string): Promise<void> {
		try {
			// Try to get command from user settings first, fallback to init script
			let commands: string[];
			const runtimeType = this.getRuntimeType() as AIRuntime;
			let source: string;

			try {
				const settingsService = getSettingsService();
				const settings = await settingsService.getSettings();
				const userCommand = settings.general.runtimeCommands?.[runtimeType];

				if (userCommand && userCommand.trim()) {
					commands = [userCommand.trim()];
					source = 'settings';
				} else {
					const config = this.getRuntimeConfig();
					commands = await this.loadInitScript(config.initScript);
					source = config.initScript;
				}
			} catch {
				// Settings service unavailable, fallback to init script
				const config = this.getRuntimeConfig();
				commands = await this.loadInitScript(config.initScript);
				source = config.initScript;
			}

			this.logger.info('Executing runtime initialization script', {
				sessionName,
				runtimeType: this.getRuntimeType(),
				source,
				commandCount: commands.length,
				targetPath: targetPath || process.cwd(),
			});

			// Inject runtime flags (skill flags such as --chrome, and the member's
			// model / effort flags) right after the harness binary. This used to
			// anchor on --dangerously-skip-permissions, which silently dropped every
			// flag for Codex / Gemini / OpenCode.
			let finalCommands = commands;
			if (runtimeFlags && runtimeFlags.length > 0) {
				const flagStr = runtimeFlags.join(' ');
				finalCommands = commands.map(cmd => injectRuntimeFlags(cmd, runtimeType, runtimeFlags));
				this.logger.info('Injected runtime flags into init commands', {
					sessionName,
					flags: flagStr,
				});
			}

			// #207: Use --agent flag for Claude Code when agentName is provided.
			// Falls back to --append-system-prompt-file for non-Claude-Code runtimes.
			if (agentName) {
				// Sanitize agentName to prevent shell injection via crafted session names
				const safeAgentName = agentName.replace(/["`$\\]/g, '');
				finalCommands = finalCommands.map(cmd => {
					if (cmd.includes('--dangerously-skip-permissions')) {
						return `${cmd} --agent "${safeAgentName}"`;
					}
					return cmd;
				});
				this.logger.info('Injected --agent flag into init commands', {
					sessionName,
					agentName,
				});
			} else if (promptFilePath) {
				finalCommands = finalCommands.map(cmd => {
					if (cmd.includes('--dangerously-skip-permissions')) {
						return `${cmd} --append-system-prompt-file "${promptFilePath}"`;
					}
					return cmd;
				});
				this.logger.info('Injected --append-system-prompt-file into init commands', {
					sessionName,
					promptFilePath,
				});
			}

			// Inject --disallowedTools for Claude Code to prevent plan mode
			// (replaces prompt-level "NEVER use plan mode" instruction to reduce PI signal)
			if (this.getRuntimeType() === 'claude-code') {
				finalCommands = finalCommands.map(cmd => {
					if (cmd.includes('--dangerously-skip-permissions') && !cmd.includes('--disallowedTools')) {
						return `${cmd} --disallowedTools EnterPlanMode,ExitPlanMode`;
					}
					return cmd;
				});
				this.logger.info('Injected --disallowedTools for plan mode prevention', { sessionName });
			}

			// Request 72c9427a: control-plane guard (spec 2026-09-24 Part 3).
			finalCommands = await this.applyControlPlaneGuard(sessionName, finalCommands, targetPath);

			// #229: Suppress Gemini CLI auto-updates that kill agent mid-task
			if (this.getRuntimeType() === 'gemini-cli') {
				finalCommands = finalCommands.map(cmd =>
					cmd.startsWith('GEMINI_NO_UPDATE=') ? cmd : `GEMINI_NO_UPDATE=1 ${cmd}`
				);
				this.logger.info('Injected GEMINI_NO_UPDATE=1 to prevent auto-update kills', { sessionName });
			}

			// #234: Codex needs approval bypass for non-interactive operation.
			// #243: Removed --no-update-check — not a valid codex flag, causes startup failure.
			// #246: Do NOT inject --full-auto when -a is already present — the newer
			// Codex CLI uses `-a never` (set in default runtimeCommands) which serves
			// the same purpose. Combining both causes a startup failure.
			if (this.getRuntimeType() === 'codex-cli') {
				if (resumeSessionId) {
					finalCommands = finalCommands.map((cmd) => toCodexResumeCommand(cmd, resumeSessionId));
					this.logger.info('Resuming Codex conversation', { sessionName, sessionId: resumeSessionId });
				}
				finalCommands = finalCommands.map(cmd => {
					if (cmd.includes('codex')) {
						// Only inject --full-auto if neither --full-auto nor -a flag is present
						const hasApprovalFlag = cmd.includes('--full-auto') || / -a /.test(cmd) || cmd.includes('--approval-mode');
						if (!hasApprovalFlag) {
							cmd = cmd.replace(/codex\b/, 'codex --full-auto');
							this.logger.info('Injected --full-auto for Codex CLI (no approval flag present)', { sessionName });
						}
					}
					return cmd;
				});
				finalCommands = await this.keepCodexOffSharedDaemon(sessionName, finalCommands);
				// specs/2026-10-04-agent-credential-isolation.md (layer 2)
				finalCommands = await this.applyCodexCredentialGuard(sessionName, finalCommands);
			}

			// #306: OpenCode needs `--auto` to approve permission requests without
			// a human, and OPENCODE_DISABLE_AUTOUPDATE so a background upgrade
			// cannot restart the TUI mid-task (same failure mode as Gemini #229).
			if (this.getRuntimeType() === RUNTIME_TYPES.OPENCODE_CLI) {
				finalCommands = finalCommands.map(cmd => {
					if (/\bopencode\b/.test(cmd) && !/\s--auto\b/.test(cmd)) {
						cmd = cmd.replace(/\bopencode\b/, 'opencode --auto');
						this.logger.info('Injected --auto for OpenCode CLI (no auto-approve flag present)', { sessionName });
					}
					return cmd.startsWith(`${OPENCODE_DISABLE_AUTOUPDATE_ENV}=`)
						? cmd
						: `${OPENCODE_DISABLE_AUTOUPDATE_ENV}=1 ${cmd}`;
				});
				this.logger.info('Injected OPENCODE_DISABLE_AUTOUPDATE=1 to prevent auto-update kills', { sessionName });
			}

			// Antigravity: keep agy's background self-updater from replacing the
			// binary mid-task (same failure mode as Gemini #229 / OpenCode #306).
			// The launch flags themselves (--add-dir, --conversation) come from
			// AntigravityRuntimeService; the Gemini API key comes from the spawn
			// env, never the command line.
			if (this.getRuntimeType() === RUNTIME_TYPES.ANTIGRAVITY_CLI) {
				finalCommands = finalCommands.map(cmd =>
					cmd.startsWith(`${ANTIGRAVITY_CONSTANTS.DISABLE_AUTO_UPDATE_ENV}=`) ? cmd : `${ANTIGRAVITY_AUTOUPDATE_PREFIX} ${cmd}`
				);
				this.logger.info('Injected AGY_CLI_DISABLE_AUTO_UPDATE=true to prevent auto-update restarts', { sessionName });
			}

			// Clear the commandline before execute
			await this.sessionHelper.clearCurrentCommandLine(sessionName);
			await this.sendShellCommandsToSession(sessionName, finalCommands, targetPath);

			this.logger.info('Runtime initialization script completed', {
				sessionName,
				runtimeType: this.getRuntimeType(),
			});
		} catch (error) {
			this.logger.error('Failed to execute runtime initialization script', {
				sessionName,
				runtimeType: this.getRuntimeType(),
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	/**
	 * Template method for detecting if runtime is running.
	 * Handles caching and concurrent access, delegates actual detection to concrete classes.
	 */
	async detectRuntimeWithCommand(
		sessionName: string,
		forceRefresh: boolean = false
	): Promise<boolean> {
		try {
			const cacheKey = `${sessionName}-${this.getRuntimeType()}`;

			// Handle cache
			if (forceRefresh) {
				this.detectionResults.delete(cacheKey);
				this.logger.debug('Cleared cached detection result due to forceRefresh', {
					sessionName,
					runtimeType: this.getRuntimeType(),
				});
			}

			if (!forceRefresh) {
				const cached = this.detectionResults.get(cacheKey);
				if (cached && Date.now() - cached.timestamp < 30000) {
					this.logger.debug('Using cached runtime detection result', {
						sessionName,
						runtimeType: this.getRuntimeType(),
						isRuntimeRunning: cached.isRuntimeRunning,
						age: Date.now() - cached.timestamp,
					});
					return cached.isRuntimeRunning;
				}
			}

			// Check if detection is already in progress
			if (this.detectionInProgress.get(cacheKey)) {
				this.logger.debug('Runtime detection already in progress, waiting for completion', {
					sessionName,
					runtimeType: this.getRuntimeType(),
				});

				let attempts = 0;
				while (this.detectionInProgress.get(cacheKey) && attempts < 30) {
					await delay(500);
					attempts++;
				}

				const result = this.detectionResults.get(cacheKey);
				if (result && Date.now() - result.timestamp < 60000) {
					return result.isRuntimeRunning;
				}
			}

			this.detectionInProgress.set(cacheKey, true);

			this.logger.debug('Starting runtime detection', {
				sessionName,
				runtimeType: this.getRuntimeType(),
				forceRefresh,
			});

			// Delegate actual detection to concrete implementation
			const isRuntimeRunning = await this.detectRuntimeSpecific(sessionName);

			// Cache the result
			this.detectionResults.set(cacheKey, {
				isRuntimeRunning,
				timestamp: Date.now(),
			});

			this.logger.debug('Runtime detection completed', {
				sessionName,
				runtimeType: this.getRuntimeType(),
				isRuntimeRunning,
			});

			return isRuntimeRunning;
		} catch (error) {
			this.logger.error('Error detecting runtime', {
				sessionName,
				runtimeType: this.getRuntimeType(),
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		} finally {
			this.detectionInProgress.set(`${sessionName}-${this.getRuntimeType()}`, false);
		}
	}

	/**
	 * One-question dialogs this runtime can raise at start-up that have a
	 * single right answer for an agent. Matched against the screen with all
	 * whitespace removed (TUIs drop spaces). Override per runtime.
	 *
	 * @returns Known prompts with the keys that answer them
	 */
	protected getKnownPrompts(): readonly KnownRuntimePrompt[] {
		return [];
	}

	/**
	 * If the screen shows one of {@link getKnownPrompts}, answer it.
	 * Called from every wait loop (start-up and before the kickoff), so an
	 * agent never sits on a question nobody is there to answer — the owner
	 * found Kai on steamfun-ops and Nova here stuck on codex's "Working
	 * directory · resume" picker (2026-09-26).
	 *
	 * @param sessionName - Session
	 * @param screen - Captured screen text
	 * @returns True when a prompt was answered
	 */
	async answerKnownPrompt(sessionName: string, screen: string): Promise<boolean> {
		const flat = (screen ?? '').replace(/\s+/g, '');
		for (const prompt of this.getKnownPrompts()) {
			if (!prompt.match.every((re) => re.test(flat))) continue;
			this.logger.info('Known start-up prompt answered', {
				sessionName,
				runtimeType: this.getRuntimeType(),
				prompt: prompt.id,
			});
			for (const key of prompt.keys) {
				if (key === 'Enter') await this.sessionHelper.sendEnter(sessionName);
				else await this.sessionHelper.sendKey(sessionName, key);
				await delay(200);
			}
			return true;
		}
		return false;
	}

	/**
	 * Simplified method for waiting for runtime to be ready.
	 * Checks at regular intervals until timeout, looking for ready patterns in the terminal output.
	 */
	async waitForRuntimeReady(
		sessionName: string,
		timeout: number,
		checkInterval: number = 2000 // Check every 2 seconds
	): Promise<boolean> {
		const startTime = Date.now();

		this.logger.info('Waiting for runtime to be ready', {
			sessionName,
			runtimeType: this.getRuntimeType(),
			timeout,
			checkInterval,
		});

		// Keep checking until timeout
		while (Date.now() - startTime < timeout) {
			try {
				// Capture terminal output
				const output = this.sessionHelper.capturePane(sessionName);

				// A known one-question dialog (e.g. codex's resume directory
				// picker) is answered, not waited out.
				if (await this.answerKnownPrompt(sessionName, output)) {
					await delay(1000);
					continue;
				}

				// Get runtime-specific ready patterns
				const readyPatterns = this.getRuntimeReadyPatterns();

				// Check if any ready pattern is found in the output
				const hasReadySignal = readyPatterns.some((pattern) => output.includes(pattern));

				if (hasReadySignal) {
					const detectedPattern = readyPatterns.find((p) => output.includes(p));
					this.logger.info('Runtime ready pattern detected', {
						sessionName,
						runtimeType: this.getRuntimeType(),
						detectedPattern,
						totalElapsed: Date.now() - startTime,
					});
					return true;
				}

				// A CLI the shell cannot find never becomes ready: fail with the
				// reason instead of waiting out the timeout and every retry.
				const cliMissing = detectRuntimeCliMissing(output, this.getRuntimeType());
				if (cliMissing) throw cliMissing;

				// Check for error patterns — fail fast instead of waiting for full timeout
				const errorPatterns = this.getRuntimeErrorPatterns();
				const hasError = errorPatterns.some((pattern) => output.includes(pattern));
				if (hasError) {
					const detectedError = errorPatterns.find((p) => output.includes(p));
					this.logger.error('Runtime error pattern detected during startup', {
						sessionName,
						runtimeType: this.getRuntimeType(),
						detectedError,
						totalElapsed: Date.now() - startTime,
					});
					return false;
				}
			} catch (error) {
				if (isRuntimeStartupBlockedError(error)) throw error;
				this.logger.warn('Error while checking runtime ready signal', {
					sessionName,
					runtimeType: this.getRuntimeType(),
					error: String(error),
				});
			}

			// Wait for next check interval
			await delay(checkInterval);
		}

		// Timeout reached - log last captured output for debugging
		try {
			const lastOutput = this.sessionHelper.capturePane(sessionName);
			const lastLines = lastOutput.split('\n').slice(-10).join('\n');
			this.logger.warn('Timeout waiting for runtime ready signal', {
				sessionName,
				runtimeType: this.getRuntimeType(),
				timeout,
				checkInterval,
				totalElapsed: Date.now() - startTime,
				lastTerminalLines: lastLines,
			});
		} catch {
			this.logger.warn('Timeout waiting for runtime ready signal', {
				sessionName,
				runtimeType: this.getRuntimeType(),
				timeout,
				checkInterval,
				totalElapsed: Date.now() - startTime,
			});
		}
		return false;
	}

	/**
	 * Whether a captured screen shows the runtime idle at its input prompt —
	 * i.e. it will accept typed input *right now*.
	 *
	 * This is deliberately stricter than `waitForRuntimeReady()`: that method
	 * matches banner text (`OpenAI Codex`, `model:` …) which is already on
	 * screen while the TUI is still booting, so an instruction typed at that
	 * point is swallowed. Registration gates on this predicate instead.
	 *
	 * Base rule: a prompt line for this runtime is visible in the last
	 * `RUNTIME_INPUT_READY_PATTERNS.TAIL_LINES` non-empty lines, and no
	 * spinner / busy status bar / runtime-specific "not ready" marker is
	 * present in that tail. Concrete runtimes extend the marker list via
	 * {@link getNotReadyMarkers}.
	 *
	 * @param screen - Captured terminal screen (ANSI is stripped defensively)
	 * @returns true when the runtime is idle at its prompt
	 */
	isReadyForInput(screen: string): boolean {
		if (!screen || typeof screen !== 'string') return false;
		const clean = stripAnsiCodes(screen);
		const lines = clean.split('\n').filter((line) => line.trim().length > 0);
		if (lines.length === 0) return false;

		const tail = lines.slice(-RUNTIME_INPUT_READY_PATTERNS.TAIL_LINES);
		const runtimeType = this.getRuntimeType();

		const hasPrompt = tail.some((line) => isPromptLine(line, runtimeType));
		if (!hasPrompt) return false;

		const tailText = tail.join('\n');
		if (containsSpinnerOrWorkingIndicator(tailText) || containsBusyStatusBar(tailText)) {
			return false;
		}

		// Whitespace-collapsed, lower-cased so `model:     loading` matches `model: loading`.
		const normalized = tailText.toLowerCase().split(/\s+/).join(' ');
		return !this.getNotReadyMarkers().some((marker) => normalized.includes(marker));
	}

	/**
	 * Runtime-specific substrings (lower-case, whitespace-collapsed) whose
	 * presence in the screen tail means the TUI is not yet accepting input
	 * even though a prompt glyph may already be painted. Override per runtime.
	 *
	 * @returns Markers to treat as "not ready"
	 */
	protected getNotReadyMarkers(): readonly string[] {
		return [];
	}

	/**
	 * Hook called after the runtime is ready but before prompts are sent.
	 * Override in concrete classes for runtime-specific post-initialization steps
	 * (e.g., Gemini CLI directory allowlist additions).
	 *
	 * Default implementation is a no-op.
	 *
	 * @param sessionName - PTY session name
	 * @param targetProjectPath - Optional target project path for the agent (where MCP configs should be written).
	 *                            Falls back to this.projectRoot if not provided.
	 */
	async postInitialize(sessionName: string, targetProjectPath?: string, additionalAllowlistPaths?: string[], browserAutomationOverride?: boolean): Promise<void> {
		// No-op by default — override in concrete classes
		this.logger.debug('postInitialize (no-op)', { sessionName, runtimeType: this.getRuntimeType() });
	}

	/**
	 * Clear cached detection results for a session
	 */
	clearDetectionCache(sessionName: string): void {
		const cacheKey = `${sessionName}-${this.getRuntimeType()}`;
		this.detectionResults.delete(cacheKey);
		this.detectionInProgress.set(cacheKey, false);
		this.logger.debug('Cleared runtime detection cache', {
			sessionName,
			runtimeType: this.getRuntimeType(),
		});
	}

	/**
	 * Get runtime configuration
	 */
	getRuntimeConfiguration(): RuntimeConfig | null {
		return this.runtimeConfig;
	}

	// Protected helper methods for concrete classes to use

	/**
	 * Ensure MCP server configuration exists at the given config file path.
	 *
	 * Reads `enableBrowserAutomation` from settings, builds the required MCP servers
	 * list, reads any existing config at `configFilePath`, merge-only adds missing
	 * servers, and writes the result back via `atomicWriteJson`.
	 *
	 * Parent directories of `configFilePath` are created automatically with
	 * `fs.mkdir({ recursive: true })`.
	 *
	 * Preserves any existing user-configured MCP servers (never overwrites).
	 * Errors are non-fatal and logged as warnings.
	 *
	 * @param configFilePath - Absolute path to the MCP config JSON file
	 *                         (e.g., `/project/.mcp.json` or `/project/.gemini/settings.json`)
	 * @param projectPath - Project directory path, used only for log context
	 * @param browserAutomationOverride - Per-agent override for browser automation.
	 *                                    When provided, takes precedence over global settings.
	 *                                    `undefined` means use global setting.
	 */
	protected async ensureMcpConfig(
		configFilePath: string,
		projectPath: string,
		browserAutomationOverride?: boolean,
	): Promise<McpConfigResult> {
		try {
			// Check if browser automation is enabled
			let enableBrowserAutomation = true;
			let browserProfile = {
				headless: true,
				stealth: false,
				humanDelayMinMs: 300,
				humanDelayMaxMs: 1200,
			};
			try {
				const settingsService = getSettingsService();
				const settings = await settingsService.getSettings();
				enableBrowserAutomation = settings.skills.enableBrowserAutomation;
				if (settings.skills.browserProfile) {
					browserProfile = settings.skills.browserProfile;
				}
			} catch {
				// Settings service unavailable — default to enabled
				this.logger.warn('Could not read settings for browser automation flag, defaulting to enabled');
			}

			// Per-agent override takes precedence over global setting
			if (browserAutomationOverride !== undefined) {
				this.logger.info('Using per-agent browser automation override', {
					globalSetting: enableBrowserAutomation,
					override: browserAutomationOverride,
				});
				enableBrowserAutomation = browserAutomationOverride;
			}

			// Build required MCP servers
			const requiredServers: Record<string, { command: string; args: string[] }> = {};

			// Skip Playwright injection when Crewly Pro addon is installed
			// (Pro addon provides its own Crewly in Chrome bridge for browser control)
			const proAddonInstalled = this.isProAddonInstalled();
			if (proAddonInstalled) {
				this.logger.info('Crewly Pro addon detected — skipping Playwright MCP injection', { projectPath });
			}

			if (enableBrowserAutomation && !proAddonInstalled) {
				const mcpPackage = browserProfile.stealth
					? '@mcp-world/playwright-mcp-world@latest'
					: '@playwright/mcp@latest';
				const args = [mcpPackage];
				if (browserProfile.headless) {
					args.push('--headless');
				}
				// Provide profile hints for MCP forks that support anti-bot options.
				if (browserProfile.stealth) {
					args.push('--stealth');
				}
				args.push('--human-delay-min', String(browserProfile.humanDelayMinMs));
				args.push('--human-delay-max', String(browserProfile.humanDelayMaxMs));

				requiredServers['playwright'] = {
					command: 'npx',
					args,
				};
			}

			// If no servers to configure, skip
			if (Object.keys(requiredServers).length === 0) {
				this.logger.info('No MCP servers to configure (browser automation disabled)', {
					runtimeType: this.getRuntimeType(),
					projectPath,
				});
				return { success: true, addedServers: 0, totalServers: 0, serverNames: [] };
			}

			// Ensure parent directory exists (handles .gemini/ and similar)
			const parentDir = path.dirname(configFilePath);
			await fs.mkdir(parentDir, { recursive: true });

			// Read existing config (preserves user config)
			const existing = await safeReadJson<Record<string, unknown>>(configFilePath, {});
			const existingMcpServers = (existing['mcpServers'] as Record<string, unknown>) || {};

			// Merge: only add servers that don't already exist (don't overwrite user config)
			let added = 0;
			for (const [name, config] of Object.entries(requiredServers)) {
				if (!existingMcpServers[name]) {
					existingMcpServers[name] = config;
					added++;
				}
			}

			// Write back merged config
			const merged = { ...existing, mcpServers: existingMcpServers };
			await atomicWriteJson(configFilePath, merged);

			const serverNames = Object.keys(existingMcpServers);

			this.logger.info('MCP config ensured', {
				runtimeType: this.getRuntimeType(),
				projectPath,
				configFilePath,
				addedServers: added,
				totalServers: serverNames.length,
				serverNames,
				enableBrowserAutomation,
				browserProfile,
			});

			return { success: true, addedServers: added, totalServers: serverNames.length, serverNames };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			// Non-fatal: agent can still work without MCP servers
			this.logger.warn('Failed to ensure MCP config (non-fatal)', {
				runtimeType: this.getRuntimeType(),
				projectPath,
				configFilePath,
				error: errorMessage,
			});
			return { success: false, addedServers: 0, totalServers: 0, serverNames: [], error: errorMessage };
		}
	}

	/**
	 * Verify MCP config file exists and contains expected servers.
	 *
	 * Reads the config file back after write and checks that the expected
	 * server names are present. Non-fatal — logs warnings on failure.
	 *
	 * @param configFilePath - Absolute path to the MCP config JSON file
	 * @param expectedServers - Server names expected to be present (e.g. ['playwright'])
	 * @returns True if all expected servers are present, false otherwise
	 */
	protected async verifyMcpConfig(configFilePath: string, expectedServers: string[]): Promise<boolean> {
		try {
			const config = await safeReadJson<Record<string, unknown>>(configFilePath, {});
			const mcpServers = (config['mcpServers'] as Record<string, unknown>) || {};
			const presentServers = Object.keys(mcpServers);
			const missing = expectedServers.filter(s => !presentServers.includes(s));

			if (missing.length > 0) {
				this.logger.warn('MCP config verification failed: missing servers', {
					configFilePath,
					expectedServers,
					presentServers,
					missing,
				});
				return false;
			}

			this.logger.info('MCP config verification passed', {
				configFilePath,
				servers: presentServers,
			});
			return true;
		} catch (error) {
			this.logger.warn('MCP config verification error (non-fatal)', {
				configFilePath,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	/**
	 * Check if the Crewly Pro addon is installed.
	 *
	 * Pro addon provides its own Crewly in Chrome bridge, so Playwright MCP
	 * should not be injected when it is present.
	 *
	 * @returns True if crewly-pro addon manifest exists
	 */
	protected isProAddonInstalled(): boolean {
		try {
			const addonsDir = path.join(os.homedir(), '.crewly', ADDON_CONSTANTS.PATHS.ADDONS_DIR);
			const manifestPath = path.join(addonsDir, ADDON_CONSTANTS.PRO_ADDON.NAME, ADDON_CONSTANTS.MANIFEST_FILE);
			return existsSync(manifestPath);
		} catch {
			return false;
		}
	}

	/**
	 * Initialize runtime configuration from config file
	 */
	private async initializeRuntimeConfig(): Promise<void> {
		try {
			const configPath = path.join(this.projectRoot, 'config', 'runtime_scripts', 'runtime-config.json');
			const configContent = await readFile(configPath, 'utf8');
			const config = JSON.parse(configContent);

			const runtimeKey = this.getRuntimeType();
			this.runtimeConfig = config.runtimes[runtimeKey] || null;

			if (this.runtimeConfig) {
				this.logger.info('Runtime configuration loaded', {
					runtimeType: runtimeKey,
					initScript: this.runtimeConfig.initScript,
				});
			} else {
				this.logger.error('Runtime configuration not found', {
					runtimeType: runtimeKey,
					availableRuntimes: Object.keys(config.runtimes),
				});
			}
		} catch (error) {
			const isNotFound = error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
			if (isNotFound) {
				this.logger.debug('Runtime config not found, using fallback', { runtimeType: this.getRuntimeType() });
			} else {
				this.logger.error('Failed to load runtime configurations', {
					runtimeType: this.getRuntimeType(),
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/**
	 * Get runtime configuration with fallback
	 */
	protected getRuntimeConfig(): RuntimeConfig {
		if (!this.runtimeConfig) {
			this.logger.warn('Runtime config not loaded, using fallback', {
				runtimeType: this.getRuntimeType(),
			});
			return {
				displayName: this.getRuntimeType(),
				initScript: 'initialize_claude.sh', // Default fallback
				welcomeMessage: 'Welcome',
				timeout: 120000,
				description: `Default ${this.getRuntimeType()} configuration`,
			};
		}
		return this.runtimeConfig;
	}

	/**
	 * Load initialization script commands from file
	 */
	protected async loadInitScript(scriptName: string): Promise<string[]> {
		const scriptPath = path.join(this.projectRoot, 'config', 'runtime_scripts', scriptName);
		const scriptContent = await readFile(scriptPath, 'utf8');
		return scriptContent
			.trim()
			.split('\n')
			.filter((line) => {
				const trimmed = line.trim();
				return trimmed && !trimmed.startsWith('#');
			});
	}

	/**
	 * Send shell commands to session
	 */
	protected async sendShellCommandsToSession(
		sessionName: string,
		commands: string[],
		targetPath?: string
	): Promise<void> {
		// Change to target directory first
		// #222: Prefer projectRoot over process.cwd() to avoid wrong CWD
		const cdPath = targetPath || this.projectRoot || process.cwd();
		this.logger.info('Changing directory before runtime init', {
			sessionName,
			runtimeType: this.getRuntimeType(),
			cdPath,
		});

		// History off first, after the rc files ran (macOS /etc/zshrc sets
		// HISTFILE itself, beating the spawn env): nothing typed below, nor
		// anything the agent runs in this shell, may reach ~/.bash_history or
		// ~/.zsh_history. Every typed line is also space-prefixed.
		const historyOffLine = shellHistoryDisableLine();
		if (historyOffLine) {
			await this.sessionHelper.sendShellLine(sessionName, historyOffLine);
			await delay(300);
		}

		// Send cd command (includes Enter automatically)
		await this.sessionHelper.sendShellLine(sessionName, quietShellLine(`cd "${cdPath}"`));
		await delay(500);

		// The PTY is a login shell: the user's rc files run after Crewly's env
		// is set and can put another `node` first on PATH. Node-based CLIs
		// (codex, gemini, opencode) start with `#!/usr/bin/env node`, so they
		// ran on that one — an Intel node v23 on an Apple-silicon Mac asked for
		// @openai/codex-darwin-x64 and died (2026-09-26, Nova). Put the node
		// Crewly itself runs on, and the user npm prefix, first again here.
		await this.sessionHelper.sendShellLine(sessionName, quietShellLine(runtimePathExport()));
		await delay(300);

		// Send each command
		for (const command of commands) {
			this.logger.info('Sending command to session', {
				sessionName,
				runtimeType: this.getRuntimeType(),
				command,
			});

			// Send command (includes Enter automatically), kept out of history
			await this.sessionHelper.sendShellLine(sessionName, quietShellLine(command));
			await delay(500);
		}
	}
}


/**
 * Shell line that puts the backend's own Node directory and the Crewly user
 * npm prefix first on PATH, after the login shell's rc files ran.
 *
 * @param nodeBinDir - Directory of the Node binary Crewly runs on
 * @returns `export PATH=...` line (single-quoted dirs, `$PATH` kept)
 */
export function runtimePathExport(nodeBinDir: string = path.dirname(process.execPath)): string {
	const dirs = [nodeBinDir, getUserNpmBinDir()].filter((d, i, a) => d && a.indexOf(d) === i);
	const quoted = dirs.map((d) => `'${d.replace(/'/g, `'\\''`)}'`).join(':');
	return `export PATH=${quoted}:"$PATH"`;
}


/** A start-up dialog with one right answer for an unattended agent. */
export interface KnownRuntimePrompt {
	/** Stable id for logs */
	id: string;
	/** All must match the whitespace-stripped screen */
	match: readonly RegExp[];
	/** Keys that answer it ('Enter' or a key name the session helper knows) */
	keys: readonly string[];
}
