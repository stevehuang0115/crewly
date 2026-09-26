/**
 * Harness setup steps shared by `crewly onboard`, `crewly login` and
 * `crewly harness`: detect the harnesses, choose the orchestrator's one,
 * install it, record the choice, and log in.
 *
 * Everything goes through the backend's harness engine (see
 * cli/utils/harness-engine), so the CLI and the web setup page behave the
 * same. The owner is assumed NOT to be at the machine: nothing here opens a
 * local browser; login URLs and codes are printed so they can be opened on a
 * phone, and in non-interactive mode (`--yes`) nothing ever prompts.
 *
 * @module cli/commands/harness-setup
 */

import chalk from 'chalk';
import { HARNESS_CONSTANTS } from '../../../backend/src/constants.js';
import { describeInstallCommand, getBrokerLoginMethod, getHarnessDefinition, resolveHarnessAlias } from '../../../backend/src/services/harness/harness-registry.js';
import type { HarnessService } from '../../../backend/src/services/harness/harness.service.js';
import {
	isTerminalLoginState,
	type HarnessId,
	type HarnessOverview,
	type HarnessStatus,
	type LoginSession,
} from '../../../backend/src/services/harness/harness.types.js';
import { getLoginRules } from '../../../backend/src/services/harness/login-rules.js';
import { CLI_CONSTANTS } from '../constants.js';
import { createDetachedLoginDriver, type LoginDriver } from '../utils/harness-engine.js';

/** Prompting and output, injected by the caller (readline in production). */
export interface SetupIO {
	/** Ask a question; resolves with the trimmed answer */
	ask(question: string): Promise<string>;
	/** Ask without echoing the answer (API keys); falls back to `ask` */
	askSecret?(question: string): Promise<string>;
	/** Print a line */
	log(line: string): void;
}

/** How a login step ended. */
export type LoginOutcome =
	| 'succeeded'
	| 'already_logged_in'
	/** Started in the backend; the owner finishes it from the web app / phone */
	| 'pending'
	| 'skipped'
	| 'failed';

/** Timing knobs (tests shrink them). */
export interface SetupTiming {
	pollIntervalMs: number;
	urlWaitMs: number;
	screenFallbackMs: number;
	maxWaitMs: number;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
}

/** Default timing. */
export const DEFAULT_SETUP_TIMING: SetupTiming = {
	pollIntervalMs: CLI_CONSTANTS.HARNESS_SETUP.POLL_INTERVAL_MS,
	urlWaitMs: CLI_CONSTANTS.HARNESS_SETUP.URL_WAIT_MS,
	screenFallbackMs: CLI_CONSTANTS.HARNESS_SETUP.SCREEN_FALLBACK_MS,
	maxWaitMs: HARNESS_CONSTANTS.LOGIN.TIMEOUT_MS + CLI_CONSTANTS.HARNESS_SETUP.WAIT_GRACE_MS,
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: Date.now,
};

/**
 * Whether an answer means yes (empty = the default).
 *
 * @param answer - User input
 * @param defaultYes - Value for an empty answer
 * @returns True for yes
 */
export function isYes(answer: string, defaultYes: boolean): boolean {
	const value = answer.trim().toLowerCase();
	if (value === '') return defaultYes;
	return value === 'y' || value === 'yes';
}

/**
 * One status line for a harness.
 *
 * @param status - Harness status
 * @param isOrc - Whether it is the orchestrator's harness
 * @returns Printable line (no colours)
 */
export function describeHarness(status: HarnessStatus, isOrc = false): string {
	const install = status.installed
		? `v${status.version ?? '?'}${status.updateAvailable && status.latestVersion ? ` (update: v${status.latestVersion})` : ''}`
		: `not installed${status.latestVersion ? ` (latest v${status.latestVersion})` : ''}`;
	const login =
		status.loginState === 'logged_in'
			? `logged in${status.loginSource ? ` (${status.loginSource})` : ''}`
			: status.loginState === 'logged_out'
				? 'not logged in'
				: 'login unknown';
	return `${status.displayName.padEnd(12)} ${install.padEnd(34)} ${login}${isOrc ? '   ← orchestrator' : ''}`;
}

/**
 * Print every harness and the required system tools.
 *
 * @param io - Output
 * @param overview - Engine overview
 */
export function printHarnessOverview(io: SetupIO, overview: HarnessOverview): void {
	for (const status of overview.harnesses) {
		const line = describeHarness(status, status.id === overview.orcHarness);
		io.log(`    ${status.installed ? chalk.green('✓') : chalk.gray('·')} ${line}`);
	}
	for (const tool of overview.systemTools) {
		io.log(tool.installed ? chalk.gray(`    ✓ ${tool.id}`) : chalk.yellow(`    ✖ ${tool.id} missing — ${tool.installHint}`));
	}
}

/**
 * Choose the orchestrator's harness.
 *
 * Non-interactive: the preset (`--harness`), else Claude Code.
 *
 * @param io - Prompting
 * @param overview - Engine overview
 * @param options - `interactive`, `preset` (id or alias)
 * @returns Harness id
 * @throws Error when the preset is not a harness
 */
export async function chooseOrcHarness(
	io: SetupIO,
	overview: HarnessOverview,
	options: { interactive: boolean; preset?: string },
): Promise<HarnessId> {
	if (options.preset) {
		const resolved = resolveHarnessAlias(options.preset);
		if (!resolved) throw new Error(`Unknown harness "${options.preset}" (use claude, codex or gemini)`);
		return resolved;
	}
	const fallback = HARNESS_CONSTANTS.DEFAULT_ORC_HARNESS;
	if (!options.interactive) return fallback;

	io.log('  Which harness should the orchestrator use?');
	overview.harnesses.forEach((status, index) => {
		const tag = status.id === fallback ? chalk.green(' (recommended)') : '';
		const detectOnly = status.loginMethods.length === 0 ? chalk.gray(' — log in yourself by running it once') : '';
		io.log(`    ${index + 1}. ${status.displayName}${tag}${detectOnly}`);
	});
	const defaultIndex = Math.max(0, overview.harnesses.findIndex((status) => status.id === fallback)) + 1;
	for (;;) {
		const answer = await io.ask(`  Enter choice (1-${overview.harnesses.length}) [${defaultIndex}]: `);
		if (answer.trim() === '') return overview.harnesses[defaultIndex - 1].id;
		const index = Number.parseInt(answer, 10);
		if (index >= 1 && index <= overview.harnesses.length) return overview.harnesses[index - 1].id;
		const byName = resolveHarnessAlias(answer);
		if (byName) return byName;
		io.log(chalk.yellow(`  Please enter a number from 1 to ${overview.harnesses.length}.`));
	}
}

/**
 * Install or update the harness when it is missing or outdated.
 *
 * Interactive mode asks first (default yes for a missing harness, no for an
 * update); `--yes` installs a missing harness and applies updates.
 *
 * @param io - Prompting
 * @param service - Harness engine
 * @param status - Current status
 * @param options - `interactive`
 * @returns True when the harness is installed afterwards
 */
export async function ensureHarnessInstalled(
	io: SetupIO,
	service: HarnessService,
	status: HarnessStatus,
	options: { interactive: boolean },
): Promise<boolean> {
	const missing = !status.installed;
	if (!missing && !status.updateAvailable) {
		io.log(chalk.green(`  ✓ ${status.displayName} v${status.version ?? '?'} is installed`));
		return true;
	}
	const def = getHarnessDefinition(status.id);
	const installCommand = def ? describeInstallCommand(def) : status.displayName;
	const what = missing ? `Install ${status.displayName}` : `Update ${status.displayName} v${status.version} → v${status.latestVersion}`;
	if (options.interactive) {
		const answer = await io.ask(`  ${what} (${installCommand})? [${missing ? 'Y/n' : 'y/N'}] `);
		if (!isYes(answer, missing)) {
			io.log(chalk.gray(missing ? `  Skipped. Install it later: ${installCommand}` : '  Keeping the installed version.'));
			return !missing;
		}
	} else {
		io.log(chalk.blue(`  ${what}…`));
	}
	const job = service.startInstall(status.id);
	const done = await service.install.waitForJob(job.jobId);
	if (done.state === 'succeeded') {
		io.log(chalk.green(`  ✓ ${status.displayName} ${missing ? 'installed' : 'updated'}${done.usedUserPrefix ? ' (under ~/.crewly/npm-global: no permission for the global npm folder)' : ''}`));
		return true;
	}
	const tail = done.log.trim().split('\n').slice(-8).join('\n    ');
	io.log(chalk.red(`  ✖ ${what} failed:`));
	io.log(chalk.gray(`    ${tail}`));
	return !missing;
}

/**
 * Print what the owner has to do for a login session (URL, code, message).
 *
 * @param io - Output
 * @param session - Current session
 * @param shown - What was already printed (mutated)
 */
function printSessionNews(io: SetupIO, session: LoginSession, shown: { url?: string; code?: string; message?: string }): void {
	if (session.url && session.url !== shown.url) {
		shown.url = session.url;
		io.log('');
		io.log('  Open this link on any device — your phone is fine:');
		io.log(chalk.cyan(`    ${session.url}`));
	}
	if (session.userCode && session.userCode !== shown.code) {
		shown.code = session.userCode;
		io.log(`  Then enter this one-time code: ${chalk.bold(session.userCode)}`);
	}
	if (session.message && session.message !== shown.message && !isTerminalLoginState(session.state)) {
		shown.message = session.message;
		io.log(chalk.yellow(`  ${session.message}`));
	}
}

/**
 * Drive a broker login to its end (or hand it off, non-interactive).
 *
 * @param io - Prompting and output
 * @param driver - Where the session lives
 * @param harnessId - Harness
 * @param method - Broker login method
 * @param options - `interactive`; timing for tests
 * @returns Outcome
 */
export async function driveBrokerLogin(
	io: SetupIO,
	driver: LoginDriver,
	harnessId: HarnessId,
	method: string,
	options: { interactive: boolean; timing?: SetupTiming },
): Promise<LoginOutcome> {
	const timing = options.timing ?? DEFAULT_SETUP_TIMING;
	// Non-interactive runs never wait for the owner: the session lives on in
	// the backend or in a background process, so print the link and return.
	const handOff = !options.interactive && driver.where !== 'in-process';
	let session = await driver.start(harnessId, method);
	const startedAt = timing.now();
	const shown: { url?: string; code?: string; message?: string } = {};
	let screenShown = false;
	let waitingNoted = false;

	for (;;) {
		printSessionNews(io, session, shown);
		if (!waitingNoted && !handOff && (shown.url || shown.code) && !session.needsInput && !isTerminalLoginState(session.state)) {
			waitingNoted = true;
			io.log(chalk.gray('  Waiting for the sign-in to finish (up to 15 minutes; Ctrl+C to stop)…'));
		}

		if (isTerminalLoginState(session.state)) {
			if (session.state === 'succeeded') {
				io.log(chalk.green(`  ✓ ${session.message ?? 'Logged in.'}`));
				return 'succeeded';
			}
			io.log(chalk.red(`  ✖ Login ${session.state.replace('_', ' ')}${session.message ? `: ${session.message}` : ''}`));
			if (session.state === 'failed' && session.screen) io.log(chalk.gray(`    Last screen:\n${indent(session.screen)}`));
			return 'failed';
		}

		if (handOff && (shown.url || shown.code || session.needsInput)) {
			io.log('');
			if (driver.where === 'detached') {
				io.log('  Finish on your phone or any browser. The sign-in keeps waiting in the background until the code expires');
				io.log(`  (15 minutes) and saves the login by itself — no need to keep this terminal open. Check with \`crewly harness\`.`);
			} else {
				io.log(`  Finish on your phone or any browser: ${session.needsInput ? 'paste the code you get into Crewly → Setup (web app or phone app) — it shows this same login.' : 'Crewly picks the login up by itself.'}`);
			}
			return 'pending';
		}

		if (session.needsInput && options.interactive) {
			const answer = await io.ask('  Paste the code from the sign-in page here: ');
			if (answer.trim() === '') continue;
			session = await driver.input(session.id, answer.trim());
			continue;
		}

		const elapsed = timing.now() - startedAt;
		if (!screenShown && !shown.url && !shown.code && elapsed >= timing.screenFallbackMs && session.screen) {
			screenShown = true;
			io.log(chalk.yellow('  No sign-in link found yet. This is what the login command shows:'));
			io.log(chalk.gray(indent(session.screen)));
		}
		if ((handOff && elapsed >= timing.urlWaitMs) || elapsed >= timing.maxWaitMs) {
			// A backend session stays for Crewly → Setup; anything else would be left dangling.
			if (driver.where !== 'backend') await driver.cancel(session.id).catch(() => undefined);
			io.log(chalk.yellow(handOff ? '  The login did not show a link in time; finish it from Crewly → Setup.' : '  Stopped waiting for the login.'));
			return handOff ? 'pending' : 'failed';
		}
		await timing.sleep(timing.pollIntervalMs);
		session = await driver.get(session.id);
	}
}

/**
 * Indent every line of a block.
 *
 * @param text - Text
 * @returns Indented text
 */
function indent(text: string): string {
	return text
		.split('\n')
		.map((line) => `      ${line}`)
		.join('\n');
}

/**
 * Log a harness in: pick a method, then broker or API key.
 *
 * Non-interactive (`--yes`) never prompts. It starts a brokered login only
 * when someone can finish it without this terminal: through the running
 * backend (the web app / phone see the session), or a device-code login
 * that needs no reply. Otherwise it prints how to finish later.
 *
 * @param io - Prompting and output
 * @param service - Harness engine (API keys, status)
 * @param getDriver - Resolves the login driver
 * @param status - Current harness status
 * @param options - `interactive`, `force` (log in again), `method`, timing
 * @returns Outcome
 */
export async function loginHarness(
	io: SetupIO,
	service: HarnessService,
	getDriver: () => Promise<LoginDriver>,
	status: HarnessStatus,
	options: { interactive: boolean; force?: boolean; method?: string; timing?: SetupTiming; detachedDriver?: () => LoginDriver },
): Promise<LoginOutcome> {
	if (status.loginMethods.length === 0) {
		io.log(chalk.gray(`  ${status.displayName}: Crewly does not log it in. Run \`${getHarnessDefinition(status.id)?.command}\` once and sign in.`));
		return 'skipped';
	}
	if (status.loginState === 'logged_in' && !options.force) {
		if (!options.interactive) {
			io.log(chalk.green(`  ✓ ${status.displayName} is already logged in${status.loginSource ? ` (${status.loginSource})` : ''}`));
			return 'already_logged_in';
		}
		const again = await io.ask(`  ${status.displayName} is already logged in (${status.loginSource ?? 'found'}). Log in again? [y/N] `);
		if (!isYes(again, false)) return 'already_logged_in';
	}

	let method = options.method ?? getBrokerLoginMethod(status.id)?.id ?? status.loginMethods[0].id;
	if (options.interactive && !options.method && status.loginMethods.length > 1) {
		io.log(`  How do you want to log in to ${status.displayName}?`);
		status.loginMethods.forEach((m, index) => io.log(`    ${index + 1}. ${m.label}`));
		const answer = await io.ask(`  Enter choice (1-${status.loginMethods.length}) [1]: `);
		const index = Number.parseInt(answer, 10);
		method = index >= 1 && index <= status.loginMethods.length ? status.loginMethods[index - 1].id : status.loginMethods[0].id;
	}
	const methodDef = status.loginMethods.find((m) => m.id === method);
	if (!methodDef) {
		io.log(chalk.red(`  ✖ ${status.displayName} has no "${method}" login.`));
		return 'failed';
	}

	if (methodDef.kind === 'api_key') {
		if (!options.interactive) {
			io.log(chalk.gray(`  Skipped: an API key has to be pasted. Run \`crewly login ${cliAlias(status.id)}\` or use Crewly → Setup.`));
			return 'skipped';
		}
		const key = await (io.askSecret ?? io.ask)(`  Paste your ${methodDef.label} (not shown): `);
		if (key.trim() === '') {
			io.log(chalk.gray('  Skipped.'));
			return 'skipped';
		}
		try {
			const after = await service.submitApiKey(status.id, key);
			io.log(chalk.green(`  ✓ ${status.displayName} ${after.loginState === 'logged_in' ? 'is logged in' : 'key saved'}`));
			return 'succeeded';
		} catch (error) {
			io.log(chalk.red(`  ✖ ${error instanceof Error ? error.message : String(error)}`));
			return 'failed';
		}
	}

	let driver = await getDriver();
	const needsReply = Boolean(getLoginRules(status.id, method)?.inputPromptPattern);
	if (!options.interactive && driver.where === 'in-process') {
		if (needsReply) {
			io.log(chalk.gray(`  Login skipped (--yes): ${status.displayName}'s sign-in needs a code typed back.`));
			io.log(chalk.gray(`  Finish it from your phone: start Crewly (\`crewly start\`) and open Crewly → Setup, or run \`crewly login ${cliAlias(status.id)}\`.`));
			return 'skipped';
		}
		// A device-code login needs no reply: run it in the background so
		// --yes prints the code and returns instead of waiting 15 minutes.
		driver = (options.detachedDriver ?? (() => createDetachedLoginDriver(service)))();
	}
	if (driver.where === 'backend') io.log(chalk.gray('  (Crewly is running: this login is also visible in Crewly → Setup on the web and phone.)'));
	try {
		return await driveBrokerLogin(io, driver, status.id, method, { interactive: options.interactive, timing: options.timing });
	} catch (error) {
		io.log(chalk.red(`  ✖ ${error instanceof Error ? error.message : String(error)}`));
		return 'failed';
	}
}

/**
 * Short CLI name for a harness (`claude`, `codex`, `gemini`).
 *
 * @param id - Harness id
 * @returns Alias
 */
export function cliAlias(id: HarnessId): string {
	const entry = Object.entries(HARNESS_CONSTANTS.CLI_ALIASES).find(([, value]) => value === id);
	return entry ? entry[0] : id;
}

/** Result of {@link runHarnessSetup}. */
export interface HarnessSetupResult {
	harnessId: HarnessId;
	installed: boolean;
	login: LoginOutcome;
}

/**
 * The whole harness step of onboarding: detect → choose → install → record → log in.
 *
 * Only the orchestrator's harness is installed.
 *
 * @param io - Prompting and output
 * @param service - Harness engine
 * @param getDriver - Resolves the login driver
 * @param options - `interactive`, `preset` harness, `loginHeader` printed before the login, timing
 * @returns What was set up
 */
export async function runHarnessSetup(
	io: SetupIO,
	service: HarnessService,
	getDriver: () => Promise<LoginDriver>,
	options: { interactive: boolean; preset?: string; loginHeader?: string; timing?: SetupTiming },
): Promise<HarnessSetupResult> {
	io.log('  Detecting harnesses…');
	const overview = await service.getOverview();
	printHarnessOverview(io, overview);
	io.log('');

	const harnessId = await chooseOrcHarness(io, overview, { interactive: options.interactive, preset: options.preset });
	const status = overview.harnesses.find((s) => s.id === harnessId) ?? (await service.getStatus(harnessId));
	io.log(chalk.green(`  ✓ Orchestrator harness: ${status.displayName}`));

	const installed = await ensureHarnessInstalled(io, service, status, { interactive: options.interactive });
	await service.setOrcHarness(harnessId);
	io.log('');

	if (!installed) {
		if (options.loginHeader) io.log(options.loginHeader);
		io.log(chalk.gray(`  Log in after installing: crewly login ${cliAlias(harnessId)}`));
		return { harnessId, installed, login: 'skipped' };
	}
	if (options.loginHeader) io.log(options.loginHeader);
	const fresh = await service.getStatus(harnessId);
	const login = await loginHarness(io, service, getDriver, fresh, { interactive: options.interactive, timing: options.timing });
	return { harnessId, installed, login };
}
