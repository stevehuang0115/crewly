/**
 * `crewly harness` and `crewly login <claude|codex|antigravity>`.
 *
 * - `crewly harness` prints each harness (installed version, newer version,
 *   login state), the orchestrator's harness and the system tools.
 * - `crewly login <name>` logs a harness in with the same broker the web
 *   setup page uses: it prints the sign-in link (open it on any device) and
 *   reads Claude's code from this terminal. When Crewly is running, the
 *   session lives in the backend, so it can also be finished from the web
 *   app or phone.
 *
 * @module cli/commands/harness
 */

import chalk from 'chalk';
import { createInterface } from 'readline';
import { describeInstallCommand, getHarnessDefinition, resolveHarnessAlias } from '../../../backend/src/services/harness/harness-registry.js';
import type { HarnessService } from '../../../backend/src/services/harness/harness.service.js';
import { CLI_CONSTANTS } from '../constants.js';
import { createCliHarnessService, pickLoginDriver, type LoginDriver } from '../utils/harness-engine.js';
import { createReadlineIO, type PromptIO } from '../utils/prompt-io.js';
import { loginHarness, printHarnessOverview, type LoginOutcome, type SetupTiming } from './harness-setup.js';

/** Options for `crewly login`. */
export interface LoginCommandOptions {
	/** Login method id (`subscription`, `device`, `api_key`) */
	method?: string;
	/** Log in again even when already logged in */
	force?: boolean;
	/** Never prompt (hand the login to the web app / phone when possible) */
	yes?: boolean;
}

/** Injectable dependencies (tests). */
export interface HarnessCommandDeps {
	service?: HarnessService;
	io?: PromptIO;
	getDriver?: () => Promise<LoginDriver>;
	timing?: SetupTiming;
	/** Stdin is a terminal */
	interactive?: boolean;
}

/** Error thrown when stdin closes during `crewly login`. */
export class LoginInputClosedError extends Error {
	constructor() {
		super('Input closed before the login finished');
		this.name = 'LoginInputClosedError';
	}
}

/**
 * `crewly harness`: print harness status.
 *
 * @param deps - Injectable dependencies
 * @returns Exit code
 */
export async function harnessCommand(deps: HarnessCommandDeps = {}): Promise<number> {
	const service = deps.service ?? createCliHarnessService();
	const io = deps.io ?? { ask: async () => '', askSecret: async () => '', log: (line: string) => console.log(line) };
	const overview = await service.getOverview();
	io.log(chalk.bold('Harnesses'));
	printHarnessOverview(io, overview);
	io.log('');
	io.log(`Orchestrator harness: ${overview.orcHarness ?? chalk.gray('not chosen yet (crewly onboard)')}`);
	return CLI_CONSTANTS.EXIT_CODES.SUCCESS;
}

/**
 * `crewly login <name>`: log a harness in.
 *
 * @param name - `claude`, `codex`, `antigravity` / `agy` (or a full harness id)
 * @param options - Command options
 * @param deps - Injectable dependencies
 * @returns Exit code
 */
export async function loginCommand(name: string, options: LoginCommandOptions = {}, deps: HarnessCommandDeps = {}): Promise<number> {
	const harnessId = resolveHarnessAlias(name);
	if (!harnessId) {
		console.log(chalk.red(`Unknown harness "${name}". Use: crewly login claude | codex | antigravity`));
		return CLI_CONSTANTS.EXIT_CODES.INVALID_ARGS;
	}
	const service = deps.service ?? createCliHarnessService();
	const interactive = options.yes !== true && (deps.interactive ?? process.stdin.isTTY === true);
	let rl: ReturnType<typeof createInterface> | null = null;
	let io: PromptIO;
	if (deps.io) {
		io = deps.io;
	} else {
		rl = createInterface({ input: process.stdin, output: process.stdout });
		io = createReadlineIO(rl, () => new LoginInputClosedError());
	}
	const getDriver = deps.getDriver ?? (() => pickLoginDriver(service));

	let outcome: LoginOutcome = 'failed';
	try {
		const status = await service.getStatus(harnessId);
		if (!status.installed) {
			const def = getHarnessDefinition(harnessId);
			io.log(chalk.red(`${status.displayName} is not installed. Run \`crewly onboard\`${def ? ` or: ${describeInstallCommand(def)}` : ''}`));
			return CLI_CONSTANTS.EXIT_CODES.ERROR;
		}
		io.log(chalk.bold(`Logging in to ${status.displayName}`));
		outcome = await loginHarness(io, service, getDriver, status, {
			interactive,
			force: options.force,
			method: options.method,
			timing: deps.timing,
		});
	} catch (error) {
		if (!(error instanceof LoginInputClosedError)) throw error;
		io.log(chalk.yellow('Input closed; login not finished.'));
		outcome = 'failed';
	} finally {
		rl?.close();
		service.broker.shutdown();
	}
	return outcome === 'failed' ? CLI_CONSTANTS.EXIT_CODES.ERROR : CLI_CONSTANTS.EXIT_CODES.SUCCESS;
}
