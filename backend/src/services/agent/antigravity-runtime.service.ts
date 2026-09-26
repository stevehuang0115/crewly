import * as os from 'os';
import * as path from 'path';
import { RuntimeAgentService } from './runtime-agent.service.abstract.js';
import { RuntimeStartupBlockedError } from './runtime-startup-blocked.error.js';
import { SessionCommandHelper } from '../session/index.js';
import {
	ANTIGRAVITY_CONSTANTS,
	CREWLY_CONSTANTS,
	RUNTIME_INPUT_READY_PATTERNS,
	RUNTIME_TYPES,
	type RuntimeType,
} from '../../constants.js';
import { delay } from '../../utils/async.utils.js';
import { stripAnsiCodes } from '../../utils/terminal-string-ops.js';
import {
	ensureAntigravityApiKeyProvider,
	type AntigravityProviderResult,
} from '../../utils/antigravity-settings.utils.js';
import { getHarnessCredentialsStore } from '../harness/harness-credentials.store.js';
import { getSettingsService } from '../settings/settings.service.js';

/** Trailing screen lines inspected when deciding whether agy is running. */
const ANTIGRAVITY_DETECTION_CAPTURE_LINES = 120;

/** Minimum run of `─` that counts as one of the input box's horizontal rules. */
const INPUT_BOX_RULE_MIN_LENGTH = 20;

/** How long postInitialize waits for the idle prompt around each `/add-dir`. */
const ADD_DIR_IDLE_TIMEOUT_MS = 15_000;
const ADD_DIR_POLL_MS = 500;

/** Banner line agy paints above the prompt: `Antigravity CLI 1.2.11`. */
const BANNER_VERSION_RE = /Antigravity CLI \d+\.\d+/;

/** Injectable dependencies (tests). */
export interface AntigravityRuntimeDeps {
	/** The Gemini API key the session will run with, or null when there is none */
	resolveApiKey?: () => Promise<string | null>;
	/** Switch agy to the Gemini API key provider and trust the given folders */
	ensureProvider?: (trustedPaths: string[]) => Promise<AntigravityProviderResult>;
	/** Crewly home dir (prompt files and skills live there) */
	crewlyHome?: () => string;
	/** System temp dir (skills write screenshots and artifacts there) */
	tmpDir?: () => string;
}

/**
 * The Gemini API key an Antigravity session gets: the key saved for
 * Antigravity in Settings → Harness, else a Gemini key from Crewly settings
 * (global or an antigravity-cli override), else GEMINI_API_KEY in the
 * backend's environment.
 *
 * @returns The key, or null when none is available
 */
export async function resolveAntigravityApiKey(): Promise<string | null> {
	try {
		const stored = getHarnessCredentialsStore().getAntigravityGeminiApiKey();
		if (stored) return stored;
	} catch {
		// unreadable store — try the other sources
	}
	try {
		const fromSettings = await getSettingsService().getApiKey('gemini', { runtime: RUNTIME_TYPES.ANTIGRAVITY_CLI });
		if (fromSettings && fromSettings.trim()) return fromSettings;
	} catch {
		// settings unavailable
	}
	const fromEnv = process.env[ANTIGRAVITY_CONSTANTS.API_KEY_ENV];
	return fromEnv && fromEnv.trim() ? fromEnv : null;
}

/**
 * Whether a marker is on screen, also when the terminal wrapped it: agy's
 * plain-text messages (printed before the TUI starts) wrap at the PTY width,
 * so the marker is searched in the text as shown and with line breaks
 * removed.
 *
 * @param screen - Captured screen (ANSI already stripped)
 * @param marker - Text to find
 * @returns True when found
 */
export function antigravityScreenIncludes(screen: string, marker: string): boolean {
	return screen.includes(marker) || screen.replace(/\r?\n/g, '').includes(marker);
}

/**
 * Classify a screen that agy cannot get past without the user, or that
 * Crewly must refuse (an account sign-in).
 *
 * @param screen - Captured screen
 * @returns The blocking error to throw, or null
 */
export function detectAntigravityStartupBlocker(screen: string): RuntimeStartupBlockedError | null {
	const clean = stripAnsiCodes(screen);
	const { SCREEN, MESSAGES } = ANTIGRAVITY_CONSTANTS;
	if (SCREEN.ACCOUNT_LOGIN_MARKERS.some((m) => antigravityScreenIncludes(clean, m))) {
		return new RuntimeStartupBlockedError('account_login_refused', MESSAGES.ACCOUNT_LOGIN);
	}
	if (antigravityScreenIncludes(clean, SCREEN.MISSING_KEY_ERROR)) {
		return new RuntimeStartupBlockedError('api_key_required', MESSAGES.KEY_NOT_IN_SESSION);
	}
	if (SCREEN.FIRST_RUN_MARKERS.some((m) => antigravityScreenIncludes(clean, m))) {
		return new RuntimeStartupBlockedError('first_run_setup', MESSAGES.FIRST_RUN);
	}
	return null;
}

/**
 * Whether agy started on something other than the Gemini API key: its
 * banner (`Antigravity CLI 1.2.11`) is on screen but the `Gemini API key`
 * line that replaces the account email is not. Only meaningful once the
 * screen is fully painted (the idle footer is up): the two lines are drawn
 * together, but a capture can land between them while agy boots.
 *
 * @param screen - Captured screen (ANSI stripped)
 * @returns True for an account session
 */
export function isAntigravityAccountSession(screen: string): boolean {
	return BANNER_VERSION_RE.test(screen) && !screen.includes(ANTIGRAVITY_CONSTANTS.SCREEN.API_KEY_HEADER);
}

/**
 * Whether agy's folder-trust screen is showing.
 *
 * @param screen - Captured screen
 * @returns True when the "Do you trust the contents of this project?" screen is up
 */
export function isAntigravityTrustPrompt(screen: string): boolean {
	const clean = stripAnsiCodes(screen);
	return clean.includes(ANTIGRAVITY_CONSTANTS.SCREEN.TRUST_PROMPT) && clean.includes(ANTIGRAVITY_CONSTANTS.SCREEN.TRUST_ACCEPT_OPTION);
}

/**
 * Whether a line is one of the full-width `─` rules around agy's prompt box.
 *
 * @param line - Screen line
 * @returns True for a rule line
 */
function isRuleLine(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.length >= INPUT_BOX_RULE_MIN_LENGTH && /^─+$/.test(trimmed);
}

/**
 * The text currently typed in agy's prompt box: the lines between the last
 * two horizontal rules, without the `>` marker. The accept-edits
 * placeholder counts as empty.
 *
 * ```
 * ─────────────────────────────  ← top rule
 * > Read the file at /x.md       ← input (may wrap onto more lines)
 * ─────────────────────────────  ← bottom rule
 * ? for shortcuts        …       ← footer
 * ```
 *
 * @param screen - Captured screen
 * @returns The typed text (whitespace-collapsed), '' when empty, or null when no prompt box is visible
 */
export function getAntigravityInputBoxText(screen: string): string | null {
	const lines = stripAnsiCodes(screen).split('\n');
	let bottom = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (isRuleLine(lines[i])) {
			bottom = i;
			break;
		}
	}
	if (bottom <= 0) return null;
	let top = -1;
	for (let i = bottom - 1; i >= 0; i--) {
		if (isRuleLine(lines[i])) {
			top = i;
			break;
		}
	}
	if (top < 0) return null;
	const text = lines
		.slice(top + 1, bottom)
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^>\s?/, '')
		.trim();
	return text.startsWith(ANTIGRAVITY_CONSTANTS.SCREEN.ACCEPT_EDITS_PLACEHOLDER) ? '' : text;
}

/**
 * Whether a message is still sitting in agy's prompt box (typed, not
 * submitted). Only the box counts: agy echoes every submitted message above
 * it as `> text`, which must not read as "stuck".
 *
 * @param screen - Captured screen
 * @param message - Message that was sent
 * @returns True when its start is still in the prompt box
 */
export function isTextInAntigravityInputBox(screen: string, message: string): boolean {
	const box = getAntigravityInputBoxText(screen);
	if (!box) return false;
	const token = message.replace(/\s+/g, ' ').trim().slice(0, 30);
	return token.length > 0 && box.includes(token);
}

/**
 * Quote a path for the shell the launch command is typed into.
 *
 * @param value - Path
 * @returns Single-quoted path
 */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Google Antigravity CLI (`agy`) runtime service.
 *
 * Crewly drives agy's interactive TUI in a PTY, like the other harnesses.
 * The one hard rule: agy runs **only on a Gemini API key**. Google does not
 * allow third-party tools to use Antigravity (or Gemini CLI) product OAuth,
 * so before every launch Crewly
 *
 * 1. refuses to launch without a Gemini API key (RuntimeStartupBlockedError
 *    `api_key_required`), and
 * 2. writes `"modelProvider": "gemini"` into agy's settings file (with the
 *    agent's folder in `trustedWorkspaces`). The key reaches the session as
 *    `GEMINI_API_KEY` in its spawn environment (harnessEnvForAgents).
 *
 * With that provider agy "never establishes an account session", even when
 * the machine has an account login in its keyring. If agy nevertheless shows
 * an account sign-in screen, or starts without the `Gemini API key` header,
 * the launch is refused (`account_login_refused`) instead of letting the
 * owner sign in.
 *
 * Launch: `agy --dangerously-skip-permissions --mode=accept-edits`, plus
 * `--add-dir` for the Crewly home (the init prompt file lives there) and the
 * temp dir (skill artifacts), `--model` / `--effort` for the member, and
 * `--conversation=<id>` to resume. `AGY_CLI_DISABLE_AUTO_UPDATE=true` keeps
 * the self-updater from replacing the binary mid-task.
 *
 * Screen anatomy (agy 1.2.11, captured in a PTY):
 *
 * ```
 *   Antigravity CLI 1.2.11
 *   Gemini API key                               ← provider header
 *   Gemini 3.1 Pro (Low)
 * ─────────────────────────────────────────────
 * > Accept-edits mode: file edits auto-approved (shift+tab to cycle)
 * ─────────────────────────────────────────────
 * ? for shortcuts            accept-edits · Gemini 3.1 Pro · low   ← idle footer
 *
 * > say hello                                   ← echo of a submitted message
 * ⣯  Generating...                              ← busy
 * ────────────────  >  ────────────────
 * esc to cancel              accept-edits · …   ← busy footer
 * ```
 *
 * Detection is a passive screen scrape: Ctrl+C at the prompt arms "press
 * ctrl+c again to exit" and `/` opens the command menu, so no key probes.
 */
export class AntigravityRuntimeService extends RuntimeAgentService {
	private readonly resolveApiKey: () => Promise<string | null>;
	private readonly ensureProvider: (trustedPaths: string[]) => Promise<AntigravityProviderResult>;
	private readonly crewlyHome: () => string;
	private readonly tmpDir: () => string;

	/**
	 * @param sessionHelper - PTY session helper
	 * @param projectRoot - Crewly install dir
	 * @param deps - Injectable dependencies (tests)
	 */
	constructor(sessionHelper: SessionCommandHelper, projectRoot: string, deps: AntigravityRuntimeDeps = {}) {
		super(sessionHelper, projectRoot);
		this.resolveApiKey = deps.resolveApiKey ?? resolveAntigravityApiKey;
		this.ensureProvider = deps.ensureProvider ?? ((trustedPaths) => ensureAntigravityApiKeyProvider({ trustedPaths, logger: this.logger }));
		this.crewlyHome = deps.crewlyHome ?? (() => path.join(os.homedir(), CREWLY_CONSTANTS.PATHS.CREWLY_HOME));
		this.tmpDir = deps.tmpDir ?? os.tmpdir;
	}

	protected getRuntimeType(): RuntimeType {
		return RUNTIME_TYPES.ANTIGRAVITY_CLI;
	}

	/**
	 * Folders agy gets with `--add-dir` at launch: the Crewly home (the init
	 * prompt file and skills) and the temp dir (skill artifacts). agy's file
	 * tools otherwise stay inside the workspace.
	 *
	 * @returns Absolute paths
	 */
	getLaunchWorkspaceDirs(): string[] {
		return [this.crewlyHome(), this.tmpDir()];
	}

	/**
	 * Make sure agy can only start on the Gemini API key, then launch it.
	 *
	 * Claude-only launch arguments (`--agent`, a prompt file) are dropped:
	 * agy has its own, unrelated `--agent` flag.
	 *
	 * @param sessionName - PTY session name
	 * @param targetPath - Working directory for the session
	 * @param runtimeFlags - Model / effort / resume flags
	 * @param _promptFilePath - Ignored (Claude Code only)
	 * @param _agentName - Ignored (Claude Code only)
	 * @param resumeSessionId - Conversation being resumed (its flag is in runtimeFlags)
	 * @throws RuntimeStartupBlockedError when no key is available or agy's settings cannot be set
	 */
	async executeRuntimeInitScript(
		sessionName: string,
		targetPath?: string,
		runtimeFlags?: string[],
		_promptFilePath?: string,
		_agentName?: string,
		resumeSessionId?: string,
	): Promise<void> {
		await this.prepareLaunch(targetPath);
		const addDirs = this.getLaunchWorkspaceDirs().map((dir) => `${ANTIGRAVITY_CONSTANTS.ADD_DIR_FLAG}=${shellQuote(dir)}`);
		const flags = [...(runtimeFlags ?? []), ...addDirs];
		return super.executeRuntimeInitScript(sessionName, targetPath, flags, undefined, undefined, resumeSessionId);
	}

	/**
	 * Pre-launch guard: a Gemini API key must exist and agy's settings must
	 * select the Gemini provider (trusting the agent's folders).
	 *
	 * @param targetPath - The session's working directory
	 * @throws RuntimeStartupBlockedError `api_key_required` | `settings_unreadable`
	 */
	async prepareLaunch(targetPath?: string): Promise<void> {
		const key = await this.resolveApiKey();
		if (!key) {
			throw new RuntimeStartupBlockedError('api_key_required', ANTIGRAVITY_CONSTANTS.MESSAGES.NO_API_KEY);
		}
		const workspace = targetPath || this.projectRoot;
		const trusted = [workspace, ...this.getLaunchWorkspaceDirs()];
		const result = await this.ensureProvider(trusted);
		if (result === 'unparseable') {
			throw new RuntimeStartupBlockedError('settings_unreadable', ANTIGRAVITY_CONSTANTS.MESSAGES.SETTINGS_UNREADABLE);
		}
		if (result === 'error') {
			throw new RuntimeStartupBlockedError('settings_unreadable', ANTIGRAVITY_CONSTANTS.MESSAGES.SETTINGS_WRITE_FAILED);
		}
		this.logger.info('Antigravity set to the Gemini API key provider for launch', { workspace, settings: result });
	}

	/**
	 * Wait for agy's idle prompt.
	 *
	 * Screens only the user may resolve (first-run terms, a missing key) and
	 * screens Crewly must refuse (account sign-in) fail fast with a
	 * RuntimeStartupBlockedError; an account session is also exited so it
	 * does no work. The folder-trust screen is answered with its
	 * pre-selected "Yes, I trust this folder" (the folder is normally
	 * pre-trusted, so this is a fallback).
	 *
	 * @param sessionName - PTY session name
	 * @param timeout - Overall timeout (ms)
	 * @param checkInterval - Poll interval (ms)
	 * @returns True when ready, false on timeout or a startup error
	 * @throws RuntimeStartupBlockedError when start-up is blocked on the user
	 */
	async waitForRuntimeReady(sessionName: string, timeout: number, checkInterval: number = 2000): Promise<boolean> {
		const startTime = Date.now();
		let trustAnswers = 0;
		this.logger.info('Waiting for Antigravity CLI to be ready', { sessionName, timeout, checkInterval });

		while (Date.now() - startTime < timeout) {
			let output = '';
			try {
				output = this.sessionHelper.capturePane(sessionName);
			} catch (error) {
				this.logger.warn('Could not read the Antigravity screen', { sessionName, error: String(error) });
			}
			const clean = stripAnsiCodes(output);

			const blocked = detectAntigravityStartupBlocker(clean);
			if (blocked) {
				this.logger.error('Antigravity start-up blocked', { sessionName, reason: blocked.reason, totalElapsed: Date.now() - startTime });
				if (blocked.reason === 'account_login_refused') await this.exitAntigravity(sessionName);
				throw blocked;
			}

			if (isAntigravityTrustPrompt(clean)) {
				trustAnswers++;
				this.logger.info('Antigravity folder-trust screen shown; accepting the pre-selected "Yes, I trust this folder"', {
					sessionName,
					attempt: trustAnswers,
				});
				await this.sessionHelper.sendEnter(sessionName);
				await delay(1000);
				continue;
			}

			const readyPattern = this.getRuntimeReadyPatterns().find((p) => clean.includes(p));
			if (readyPattern && isAntigravityAccountSession(clean)) {
				this.logger.error('Antigravity started on an account session instead of the Gemini API key; exiting it', { sessionName });
				await this.exitAntigravity(sessionName);
				throw new RuntimeStartupBlockedError('account_login_refused', ANTIGRAVITY_CONSTANTS.MESSAGES.ACCOUNT_LOGIN);
			}
			if (readyPattern) {
				this.logger.info('Antigravity ready', { sessionName, detectedPattern: readyPattern, totalElapsed: Date.now() - startTime });
				return true;
			}

			const errorPattern = this.getRuntimeErrorPatterns().find((p) => antigravityScreenIncludes(clean, p));
			if (errorPattern) {
				this.logger.error('Antigravity error during start-up', { sessionName, detectedError: errorPattern });
				return false;
			}

			await delay(checkInterval);
		}

		this.logger.warn('Timeout waiting for Antigravity CLI', { sessionName, timeout });
		return false;
	}

	/**
	 * Leave agy (Ctrl+C twice: the first arms "press ctrl+c again to exit").
	 *
	 * @param sessionName - PTY session name
	 */
	private async exitAntigravity(sessionName: string): Promise<void> {
		try {
			await this.sessionHelper.sendCtrlC(sessionName);
			await delay(300);
			await this.sessionHelper.sendCtrlC(sessionName);
		} catch {
			// session already gone
		}
	}

	/**
	 * Passive detection: agy's footer (idle or busy) is the last thing on
	 * screen, with no exit hint after it.
	 *
	 * @param sessionName - PTY session name
	 * @returns True when agy is running
	 */
	protected async detectRuntimeSpecific(sessionName: string): Promise<boolean> {
		const output = stripAnsiCodes(this.sessionHelper.capturePane(sessionName, ANTIGRAVITY_DETECTION_CAPTURE_LINES));
		const lastFooter = Math.max(
			output.lastIndexOf(ANTIGRAVITY_CONSTANTS.SCREEN.IDLE_FOOTER),
			output.lastIndexOf('esc to cancel'),
		);
		const lastExit = output.lastIndexOf(ANTIGRAVITY_CONSTANTS.SCREEN.EXIT_RESUME_HINT);
		const running = lastFooter >= 0 && lastFooter > lastExit;
		this.logger.debug('Antigravity detection completed', { sessionName, running });
		return running;
	}

	/**
	 * Text on screen once agy is up and taking input (or already busy, e.g.
	 * a resumed conversation): the idle footer, the empty accept-edits
	 * placeholder, or the busy footer.
	 *
	 * @returns Ready patterns
	 */
	protected getRuntimeReadyPatterns(): string[] {
		return [
			ANTIGRAVITY_CONSTANTS.SCREEN.IDLE_FOOTER,
			ANTIGRAVITY_CONSTANTS.SCREEN.ACCEPT_EDITS_PLACEHOLDER,
			'esc to cancel',
		];
	}

	/**
	 * Markers that veto readiness while the idle footer may still be painted.
	 *
	 * @returns Lower-case markers
	 */
	protected getNotReadyMarkers(): readonly string[] {
		return RUNTIME_INPUT_READY_PATTERNS.ANTIGRAVITY_CLI.NOT_READY_MARKERS;
	}

	/**
	 * Exit patterns for RuntimeExitMonitorService (matched against the raw
	 * output stream, which is not wrapped). agy prints its resume hint on
	 * every clean exit, and refuses to start without the key.
	 *
	 * @returns Exit patterns
	 */
	protected getRuntimeExitPatterns(): RegExp[] {
		return [
			/Resume with -c \(or command below\)/,
			/modelProvider is set to "gemini" in settings\.json, but the GEMINI_API_KEY/,
			/command not found: agy/,
			/agy: command not found/,
		];
	}

	/**
	 * Start-up error patterns (fail waitForRuntimeReady fast). Kept short so
	 * an 80-column wrap cannot split them.
	 *
	 * @returns Error patterns
	 */
	protected getRuntimeErrorPatterns(): string[] {
		return [
			'command not found: agy',
			'agy: command not found',
			'Permission denied',
			'No such file or directory',
		];
	}

	/**
	 * Add folders to a running agy's workspace with `/add-dir <path>` (the
	 * orchestrator's project folders). The Crewly home and temp dir were
	 * added at launch. Waits for the idle prompt around each command so the
	 * registration kickoff cannot land in the middle of one.
	 *
	 * @param sessionName - PTY session name
	 * @param targetProjectPath - The session's working directory (already the workspace)
	 * @param additionalAllowlistPaths - Extra folders to add
	 */
	async postInitialize(sessionName: string, targetProjectPath?: string, additionalAllowlistPaths?: string[]): Promise<void> {
		const workspace = path.resolve(targetProjectPath || this.projectRoot);
		const already = new Set([workspace, ...this.getLaunchWorkspaceDirs().map((dir) => path.resolve(dir))]);
		const extra = (additionalAllowlistPaths ?? [])
			.filter((p) => typeof p === 'string' && p.length > 0 && !/[\r\n]/.test(p))
			.map((p) => path.resolve(p))
			.filter((p, index, all) => !already.has(p) && all.indexOf(p) === index);
		if (extra.length === 0) return;

		this.logger.info('Adding folders to the Antigravity workspace', { sessionName, count: extra.length });
		for (const dir of extra) {
			await this.waitForIdlePrompt(sessionName);
			await this.sessionHelper.sendMessage(sessionName, `${ANTIGRAVITY_CONSTANTS.ADD_DIR_COMMAND} ${dir}`);
		}
		await this.waitForIdlePrompt(sessionName);
	}

	/**
	 * Add one folder to a running agy's workspace, but only while it is idle
	 * at its prompt: a slash command typed during a turn would be queued as a
	 * message. Used when a project is added while the orchestrator runs.
	 *
	 * @param sessionName - PTY session name
	 * @param dir - Folder to add
	 * @returns True when the command was sent, false when agy was busy or the path is unusable
	 */
	async addWorkspaceDir(sessionName: string, dir: string): Promise<boolean> {
		if (!dir || /[\r\n]/.test(dir)) return false;
		try {
			if (!this.isReadyForInput(this.sessionHelper.capturePane(sessionName))) return false;
			await this.sessionHelper.sendMessage(sessionName, `${ANTIGRAVITY_CONSTANTS.ADD_DIR_COMMAND} ${path.resolve(dir)}`);
			return true;
		} catch (error) {
			this.logger.warn('Could not add a folder to the Antigravity workspace', { sessionName, error: String(error) });
			return false;
		}
	}

	/**
	 * Wait (bounded) until agy shows its idle prompt.
	 *
	 * @param sessionName - PTY session name
	 * @returns True when idle, false on timeout
	 */
	private async waitForIdlePrompt(sessionName: string): Promise<boolean> {
		const deadline = Date.now() + ADD_DIR_IDLE_TIMEOUT_MS;
		for (;;) {
			try {
				if (this.isReadyForInput(this.sessionHelper.capturePane(sessionName))) return true;
			} catch {
				// keep polling
			}
			if (Date.now() >= deadline) return false;
			await delay(ADD_DIR_POLL_MS);
		}
	}
}
