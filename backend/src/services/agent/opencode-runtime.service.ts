import { RuntimeAgentService } from './runtime-agent.service.abstract.js';
import { SessionCommandHelper } from '../session/index.js';
import { RUNTIME_TYPES, RUNTIME_INPUT_READY_PATTERNS, type RuntimeType } from '../../constants.js';

/**
 * Number of trailing screen lines inspected when deciding whether the
 * OpenCode TUI has launched. Matches the Codex sibling so both TUIs get the
 * same look-back window.
 */
const OPENCODE_DETECTION_CAPTURE_LINES = 120;

/**
 * OpenCode CLI (https://opencode.ai) runtime service — issue #306.
 *
 * OpenCode is an open-source TUI coding agent that can drive any
 * provider/model. Crewly launches it inside a PTY exactly like Codex:
 *
 * - `opencode --auto` opens the TUI in the cwd with every permission request
 *   that is not explicitly denied auto-approved (the danger-mode equivalent
 *   of Claude Code's `--dangerously-skip-permissions`).
 * - It reads `AGENTS.md` in the project root as its instruction file, the
 *   same convention Codex uses, so agent-registration provisions the same
 *   `agent-agents-md.md` template for it.
 * - Provider credentials live in `~/.local/share/opencode/auth.json`
 *   (`opencode auth login`) or come from the usual env vars
 *   (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`), which
 *   agent-registration already injects for every PTY runtime.
 *
 * Screen anatomy (OpenCode 1.x, opentui renderer) that the detection
 * patterns below key on:
 *
 * ```
 * ┃  Ask anything… "Fix a TODO in the codebase"     ← empty input placeholder
 * ┃  Build auto · claude-sonnet-4 Anthropic          ← agent / model meta line
 * ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
 *   ~/project              tab agents  ctrl+p commands   ← idle footer
 *   ■■⬝⬝⬝⬝ esc interrupt   tab agents  ctrl+p commands   ← busy footer
 * ```
 *
 * The input box stays on screen while the model runs, so "busy" is signalled
 * by the `esc interrupt` hint rather than by a missing prompt — see
 * {@link getNotReadyMarkers}.
 */
export class OpenCodeRuntimeService extends RuntimeAgentService {
	constructor(sessionHelper: SessionCommandHelper, projectRoot: string) {
		super(sessionHelper, projectRoot);
	}

	protected getRuntimeType(): RuntimeType {
		return RUNTIME_TYPES.OPENCODE_CLI;
	}

	/**
	 * OpenCode runtime detection.
	 *
	 * Passive screen scrape only — no key probes. Like Codex, OpenCode treats
	 * Ctrl+C at the prompt as "exit" (twice) and `/` opens the command
	 * palette, so an active probe would corrupt or kill the session.
	 *
	 * @param sessionName - PTY session name
	 * @returns true when an OpenCode ready pattern is on screen
	 */
	protected async detectRuntimeSpecific(sessionName: string): Promise<boolean> {
		const output = this.sessionHelper.capturePane(sessionName, OPENCODE_DETECTION_CAPTURE_LINES);
		const readyPatterns = this.getRuntimeReadyPatterns();
		const hasReadySignal = readyPatterns.some((pattern) => output.includes(pattern));

		this.logger.debug('OpenCode detection completed', {
			sessionName,
			hasReadySignal,
		});

		return hasReadySignal;
	}

	/**
	 * Text that is on screen once the OpenCode TUI has launched.
	 *
	 * The OpenCode logo is drawn with block glyphs (no greppable word), and
	 * the literal `opencode` is already in the scrollback from the launch
	 * command itself, so the patterns are the placeholder / footer strings the
	 * TUI paints. The `/connect` footer is included so a launched-but-
	 * unauthenticated TUI still counts as "launched" (login detection takes
	 * it from there).
	 *
	 * @returns OpenCode-specific ready patterns
	 */
	protected getRuntimeReadyPatterns(): string[] {
		return [
			'Ask anything',
			'tab agents',
			'ctrl+p commands',
			'esc interrupt',
			'Get started /connect',
			'Connect a provider',
		];
	}

	/**
	 * OpenCode keeps its input box on screen while the model runs and while
	 * the provider dialog is open, so the placeholder alone is not proof of
	 * an idle prompt — these markers veto readiness.
	 *
	 * @returns OpenCode-specific "not ready" markers
	 */
	protected getNotReadyMarkers(): readonly string[] {
		return RUNTIME_INPUT_READY_PATTERNS.OPENCODE_CLI.NOT_READY_MARKERS;
	}

	/**
	 * OpenCode exit patterns for RuntimeExitMonitorService.
	 *
	 * OpenCode normally returns to the shell silently (the process-alive poll
	 * in the monitor catches that), so these cover the cases that DO print
	 * something: an explicit exit message, a session end, and a yargs
	 * argument error (e.g. an older `opencode` that does not know `--auto`),
	 * which exits immediately with `Unknown argument: auto`.
	 *
	 * @returns OpenCode-specific exit patterns
	 */
	protected getRuntimeExitPatterns(): RegExp[] {
		return [
			/opencode.*exited/i,
			/Session\s+ended/i,
			/Unknown arguments?:/i,
		];
	}

	/**
	 * OpenCode error patterns — fail `waitForRuntimeReady()` fast instead of
	 * sitting out the whole boot timeout.
	 *
	 * @returns OpenCode-specific error patterns
	 */
	protected getRuntimeErrorPatterns(): string[] {
		const commonErrors = ['Permission denied', 'No such file or directory'];
		return [
			...commonErrors,
			'command not found: opencode',
			'opencode: command not found',
			'Unknown argument',
			'ProviderAuthError',
			'ProviderModelNotFoundError',
			'Invalid API key',
			'invalid_api_key',
			'Rate limit exceeded',
			'rate_limit_exceeded',
		];
	}

	/**
	 * Check if OpenCode CLI is installed and configured.
	 *
	 * Mirrors the Codex sibling: the actual binary check lives in the CLI
	 * `init` wizard / `doctor`; this reports availability for the API.
	 *
	 * @returns Installation status
	 */
	async checkOpenCodeInstallation(): Promise<{
		isInstalled: boolean;
		version?: string;
		message: string;
	}> {
		try {
			return {
				isInstalled: true,
				message: 'OpenCode CLI is available',
			};
		} catch {
			return {
				isInstalled: false,
				message: 'OpenCode CLI not found or not configured',
			};
		}
	}

	/**
	 * Initialize OpenCode in an existing session.
	 *
	 * @param sessionName - PTY session name
	 * @returns Initialization result
	 */
	async initializeOpenCodeInSession(sessionName: string): Promise<{
		success: boolean;
		message: string;
	}> {
		try {
			await this.executeRuntimeInitScript(sessionName);
			return {
				success: true,
				message: 'OpenCode CLI initialized successfully',
			};
		} catch (error) {
			return {
				success: false,
				message:
					error instanceof Error
						? error.message
						: 'Failed to initialize OpenCode CLI',
			};
		}
	}
}
