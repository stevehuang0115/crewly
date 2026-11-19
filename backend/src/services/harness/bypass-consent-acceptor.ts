/**
 * Chooses "Yes, I accept" on Claude Code's Bypass Permissions consent, after
 * the owner said so.
 *
 * Claude Code shows that consent the first time `--dangerously-skip-permissions`
 * is used on a computer. Every Crewly agent runs in that mode, so a new
 * machine cannot start an agent until someone answers it. The answer is the
 * owner's; this module only presses the key once the owner has replied
 * (runtime-consent.service.ts). It runs `claude` in a short-lived terminal of
 * its own (in an empty temp folder, which it trusts when asked), answers the
 * one screen it knows, and ends the process. Both menus list "No, exit" first
 * with no numbers, so it moves down, checks the highlight is on the option it
 * wants, and only then presses Enter. It reads a rendered virtual screen, since
 * a Windows console sends only the cells that changed.
 *
 * @module services/harness/bypass-consent-acceptor
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as pty from 'node-pty';
import { RUNTIME_CONSENT_CONSTANTS } from '../../constants.js';
import { showsBypassConsentMenu } from '../agent/runtime-startup-screen.js';
import { findExecutable } from '../../utils/find-executable.utils.js';
import { killWindowsProcessTree } from '../../utils/windows-process.utils.js';
import { stripNestedClaudeSessionEnv } from '../agent/runtime-session-recovery.js';
import { withHarnessPath } from './harness-exec.utils.js';
import { PtyTerminalBuffer } from '../session/pty/pty-terminal-buffer.js';

/**
 * How the attempt ended.
 *
 * - `accepted`: the consent screen was shown and "Yes, I accept" was chosen.
 * - `not_shown`: Claude Code started without showing the consent (already
 *   accepted, or it is showing something else first).
 * - `failed`: Claude Code is not installed, exited, or kept showing the consent.
 */
export type BypassConsentOutcome = 'accepted' | 'not_shown' | 'failed';

/** Result of {@link acceptBypassConsent}. */
export interface BypassConsentResult {
	outcome: BypassConsentOutcome;
	/** Short reason for logs (never screen content) */
	detail: string;
}

/** The slice of a PTY the acceptor uses. */
export interface ConsentPty {
	pid: number;
	write(data: string): void;
	kill(): void;
	onData(listener: (data: string) => void): unknown;
	onExit(listener: (event: { exitCode: number }) => void): unknown;
}

/** Injectable dependencies. */
export interface BypassConsentDeps {
	/** Starts the terminal (default: node-pty) */
	spawnPty?: (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ConsentPty;
	/** Finds the `claude` executable (default: PATH lookup with the harness PATH) */
	findClaude?: (env: NodeJS.ProcessEnv) => string | null;
	env?: NodeJS.ProcessEnv;
	/** Creates the empty folder `claude` runs in (default: a fresh temp folder) */
	makeWorkDir?: () => string;
	/** Removes that folder afterwards */
	removeWorkDir?: (dir: string) => void;
	platform?: NodeJS.Platform;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** Ends everything the terminal started (default: taskkill on Windows) */
	killTree?: (pid: number) => void;
}

/**
 * Whether the consent screen is in a piece of terminal output.
 *
 * @param text - Normalised terminal text
 * @returns True when the consent menu is the last thing printed
 */
export function hasBypassConsent(text: string): boolean {
	return showsBypassConsentMenu(text);
}

/**
 * The command line for `claude`: a `.cmd` / `.bat` shim (npm install on
 * Windows) cannot be started directly and goes through `cmd.exe`.
 *
 * @param file - Resolved executable
 * @param platform - Platform
 * @returns Executable and arguments
 */
export function consentCommand(file: string, platform: NodeJS.Platform): { file: string; args: string[] } {
	const args = [RUNTIME_CONSENT_CONSTANTS.CLAUDE_FLAG];
	if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(file)) return { file: 'cmd.exe', args: ['/d', '/s', '/c', file, ...args] };
	return { file, args };
}

/**
 * Run `claude --dangerously-skip-permissions` once and choose "Yes, I accept"
 * on the consent screen. Call this only after the owner agreed.
 *
 * @param deps - Injectable dependencies
 * @returns How it ended
 *
 * @example
 * ```ts
 * const { outcome } = await acceptBypassConsent();
 * if (outcome !== 'failed') await resumer.resume(waitingSessions);
 * ```
 */
export async function acceptBypassConsent(deps: BypassConsentDeps = {}): Promise<BypassConsentResult> {
	const platform = deps.platform ?? process.platform;
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const env = stripNestedClaudeSessionEnv(withHarnessPath(deps.env ?? process.env));
	const claude = (deps.findClaude ?? ((e) => findExecutable(RUNTIME_CONSENT_CONSTANTS.CLAUDE_BIN, { env: e, platform })))(env);
	if (!claude) return { outcome: 'failed', detail: 'claude_not_found' };

	const command = consentCommand(claude, platform);
	const spawnPty =
		deps.spawnPty ??
		((file, args, options) =>
			pty.spawn(file, args, {
				name: 'xterm-256color',
				cols: RUNTIME_CONSENT_CONSTANTS.PTY_COLS,
				rows: RUNTIME_CONSENT_CONSTANTS.PTY_ROWS,
				cwd: options.cwd,
				env: options.env as { [key: string]: string },
			}));

	// An empty folder of Crewly's own: Claude Code asks to trust the folder
	// before it shows the consent, and trusting this one exposes nothing.
	const makeDir = deps.makeWorkDir ?? (() => fs.mkdtempSync(path.join(os.tmpdir(), RUNTIME_CONSENT_CONSTANTS.WORK_DIR_PREFIX)));
	let workDir: string;
	try {
		workDir = makeDir();
	} catch (error) {
		return { outcome: 'failed', detail: `work_dir_failed: ${error instanceof Error ? error.message : String(error)}` };
	}

	let terminal: ConsentPty | null = null;
	let sawOutput = false;
	let exited = false;
	// A virtual screen, not the bytes since a key: a Windows console redraws
	// only what changed. After Down it sends two cursor moves, a blank and the
	// marker (`ESC[14;2H ESC[15;2H>`), never the option's label again, so the
	// label and its marker can only be read together off a rendered screen
	// (DESKTOP-RIG1SOO, 2026-11-19).
	const display = new PtyTerminalBuffer(RUNTIME_CONSENT_CONSTANTS.PTY_COLS, RUNTIME_CONSENT_CONSTANTS.PTY_ROWS);
	/** What the terminal shows right now. */
	const screen = async (): Promise<string> => {
		await display.flush();
		return display.getContent(RUNTIME_CONSENT_CONSTANTS.PTY_ROWS);
	};
	/**
	 * Move the highlight to the second option, check on screen that the
	 * marker now stands before the expected option, and confirm. Never
	 * presses Enter on an option it did not see highlighted.
	 */
	const chooseSecondOption = async (label: string): Promise<boolean> => {
		if (!terminal) return false;
		await sleep(RUNTIME_CONSENT_CONSTANTS.KEY_DELAY_MS);
		terminal.write(RUNTIME_CONSENT_CONSTANTS.DOWN_KEY);
		const highlighted = new RegExp(`^\\s*${RUNTIME_CONSENT_CONSTANTS.MENU_CURSOR_PATTERN}\\s*${label}\\s*$`, 'm');
		const by = now() + RUNTIME_CONSENT_CONSTANTS.SETTLE_MS;
		while (!highlighted.test(await screen())) {
			if (exited || now() >= by) return false;
			await sleep(RUNTIME_CONSENT_CONSTANTS.POLL_MS);
		}
		terminal.write(RUNTIME_CONSENT_CONSTANTS.ENTER_KEY);
		return true;
	};

	try {
		try {
			terminal = spawnPty(command.file, command.args, { cwd: workDir, env });
		} catch (error) {
			return { outcome: 'failed', detail: `spawn_failed: ${error instanceof Error ? error.message : String(error)}` };
		}
		terminal.onData((data) => {
			sawOutput = true;
			display.write(data);
		});
		terminal.onExit(() => {
			exited = true;
		});

		// 1. Wait for the consent screen, trusting our own empty folder on the way.
		const shownBy = now() + RUNTIME_CONSENT_CONSTANTS.SHOW_TIMEOUT_MS;
		let trusted = false;
		for (;;) {
			const shown = await screen();
			if (hasBypassConsent(shown)) break;
			if (exited) return { outcome: 'failed', detail: 'exited_before_consent' };
			if (now() >= shownBy) return { outcome: sawOutput ? 'not_shown' : 'failed', detail: sawOutput ? 'consent_not_shown' : 'no_output' };
			if (!trusted && shown.includes(RUNTIME_CONSENT_CONSTANTS.TRUST_OPTION)) {
				trusted = true;
				if (!(await chooseSecondOption(RUNTIME_CONSENT_CONSTANTS.TRUST_OPTION))) return { outcome: 'failed', detail: 'trust_not_answered' };
				continue;
			}
			await sleep(RUNTIME_CONSENT_CONSTANTS.POLL_MS);
		}

		// 2. Choose "Yes, I accept".
		if (!(await chooseSecondOption(RUNTIME_CONSENT_CONSTANTS.ACCEPT_OPTION))) {
			return { outcome: 'failed', detail: exited ? 'exited_before_answer' : 'accept_not_highlighted' };
		}
		const goneBy = now() + RUNTIME_CONSENT_CONSTANTS.SETTLE_MS;
		for (;;) {
			await sleep(RUNTIME_CONSENT_CONSTANTS.POLL_MS);
			// "No, exit" ends the process; an accepted consent leaves Claude Code running.
			if (exited) return { outcome: 'failed', detail: 'exited_after_answer' };
			if (now() >= goneBy) {
				if (!hasBypassConsent(await screen())) return { outcome: 'accepted', detail: 'consent_answered' };
				return { outcome: 'failed', detail: 'consent_still_shown' };
			}
		}
	} finally {
		if (terminal && !exited) {
			try {
				if (platform === 'win32') (deps.killTree ?? killWindowsProcessTree)(terminal.pid);
				terminal.kill();
			} catch {
				// Already gone.
			}
		}
		try {
			(deps.removeWorkDir ?? ((dir: string) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })))(workDir);
		} catch {
			// A leftover empty temp folder is harmless.
		}
		display.dispose();
	}
}
