/**
 * `crewly doctor` — environment health report.
 *
 * Answers "why does this install not work?" in one screen: where the package
 * lives, which node runs it, whether the native modules (node-pty,
 * better-sqlite3) are built and loadable, whether the C++ toolchain needed to
 * rebuild them is present (server-install finding 11), and — on Linux — whether
 * the user service will survive logout.
 *
 * It also checks what agents need to do anything at all (#779): the jq and
 * curl the skills call, at least one AI runtime (Claude Code / Codex / Gemini
 * CLI) that is installed AND logged in, and that the skill marketplace the
 * installer uses is reachable. Every failure names the command that fixes it,
 * and any failure makes the command exit non-zero instead of claiming a pass.
 *
 * @module cli/commands/doctor
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import chalk from 'chalk';
import { CREWLY_CONSTANTS, MARKETPLACE_CONSTANTS } from '../../../config/index.js';
import { resolvePackageRoot } from '../utils/package-root.js';
import { checkNativeToolchain, isOnPath } from '../utils/native-toolchain.js';
import { checkRuntimeAuth, type RuntimeAuthStatus } from '../utils/runtime-auth.js';
import { getLingerState } from './service.js';
import { REQUIRED_SYSTEM_TOOLS, type SystemToolInfo } from './onboard.js';

/** Severity of a doctor line. */
export type DoctorStatus = 'ok' | 'warn' | 'fail';

/** One line of the report. */
export interface DoctorCheck {
	/** Short label (e.g. "node-pty"). */
	name: string;
	status: DoctorStatus;
	/** Detail shown after the label. */
	detail: string;
	/** Optional remediation printed indented under the line. */
	hint?: string;
}

/** Injection points so the report is testable without a real install. */
export interface DoctorDeps {
	/** Package root override (defaults to {@link resolvePackageRoot}). */
	packageRoot?: string | null;
	/** Attempts to load a native module by name; throws when it cannot. */
	tryLoad?: (moduleName: string, packageRoot: string) => void;
	/** PATH lookup for the toolchain check. */
	which?: (bin: string) => boolean;
	/** Platform override. */
	platform?: NodeJS.Platform;
	/** Home directory override. */
	homeDir?: string;
	/** Linger lookup (Linux only). */
	lingerState?: () => Promise<'yes' | 'no' | null>;
	/** Effective user id lookup (defaults to `process.getuid`; absent on Windows). */
	getuid?: () => number;
	/** Environment override (defaults to `process.env`). */
	env?: NodeJS.ProcessEnv;
	/** Reachability probe for the marketplace check (defaults to an HTTPS GET). */
	probeUrl?: UrlProbe;
}

/** Result of probing one URL. */
export interface UrlProbeResult {
	ok: boolean;
	/** `HTTP 200`, `ENOTFOUND`, `timeout`, ... */
	detail: string;
}

/** Fetches a URL and reports whether it answered 2xx. Never throws. */
export type UrlProbe = (url: string, timeoutMs: number) => Promise<UrlProbeResult>;

/** Timeout for each marketplace reachability probe (ms). */
const MARKETPLACE_PROBE_TIMEOUT_MS = 5_000;

/**
 * Marketplace sources the installer and `crewly install` fetch skills from
 * (see `fetchRegistry` in utils/marketplace.ts).
 */
const MARKETPLACE_SOURCES = [
	{ label: 'GitHub skills registry', url: MARKETPLACE_CONSTANTS.PUBLIC_REGISTRY_URL },
	{ label: 'crewlyai.com registry', url: `${MARKETPLACE_CONSTANTS.PREMIUM_BASE_URL}${MARKETPLACE_CONSTANTS.PREMIUM_REGISTRY_ENDPOINT}` },
] as const;

/**
 * System tools the agent skills call. jq comes from onboarding's required
 * list (#768); curl is how every skill reaches the Crewly API.
 */
export const DOCTOR_SYSTEM_TOOLS: readonly SystemToolInfo[] = [
	...REQUIRED_SYSTEM_TOOLS,
	{
		displayName: 'curl',
		command: 'curl',
		versionFlag: '--version',
		reason: 'Agent skills call the Crewly API with curl.',
		install: { macos: 'brew install curl', linux: 'sudo apt-get install -y curl   (Fedora: sudo dnf install -y curl)' },
	},
];

/**
 * Fresh-install checks for the Claude Code runtime (Mia's pre-validation,
 * 2026-09-23): Claude refuses `--dangerously-skip-permissions` as root unless
 * `IS_SANDBOX=1`. Its first-run / login check lives in utils/runtime-auth.ts.
 */
const CLAUDE_SETUP = {
	/** Env var that lets Claude accept the permissions flag under root. */
	SANDBOX_ENV: 'IS_SANDBOX',
	BIN: 'claude',
} as const;

/** Native modules whose loadability decides whether Crewly can start. */
const NATIVE_MODULES = ['node-pty', 'better-sqlite3'] as const;

/**
 * Default native-module loader: a CJS `require` anchored at the package root
 * so the resolver finds the package's own `node_modules/`.
 *
 * @param moduleName - Bare module name
 * @param packageRoot - Crewly package root
 */
function defaultTryLoad(moduleName: string, packageRoot: string): void {
	const req = createRequire(pathToFileURL(path.join(packageRoot, 'package.json')).href);
	req(moduleName);
}

/**
 * Default URL probe: HTTPS GET with a timeout; the body is discarded.
 *
 * @param url - URL to fetch
 * @param timeoutMs - Timeout
 * @returns Whether it answered 2xx, and why not
 */
export async function defaultProbeUrl(url: string, timeoutMs: number): Promise<UrlProbeResult> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		await res.body?.cancel().catch(() => undefined);
		return { ok: res.ok, detail: `HTTP ${res.status}` };
	} catch (error) {
		const err = error as { name?: string; message?: string; cause?: { code?: string } };
		if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { ok: false, detail: `timeout after ${Math.round(timeoutMs / 1000)}s` };
		return { ok: false, detail: err?.cause?.code ?? err?.message ?? String(error) };
	}
}

/**
 * Checks for the runtimes: one line per installed runtime, plus a `runtime`
 * line that fails when none is installed and logged in.
 *
 * @param statuses - Claude, Codex, Gemini login state
 * @returns Checks
 */
export function runtimeChecks(statuses: readonly RuntimeAuthStatus[]): DoctorCheck[] {
	const checks: DoctorCheck[] = [];
	for (const rt of statuses) {
		if (!rt.installed) continue;
		if (rt.loggedIn) {
			checks.push({ name: rt.id, status: 'ok', detail: rt.detail });
		} else if (rt.id === 'claude' && rt.detail.startsWith('installed but never set up')) {
			// Wording from #782, kept so the first-run hint stays recognisable.
			checks.push({
				name: rt.id,
				status: 'warn',
				detail: 'installed but never set up — Claude agents will stop at its theme and login screens',
				hint: 'Run `claude` once in a terminal, choose a theme and log in, then start the team.',
			});
		} else {
			checks.push({ name: rt.id, status: 'warn', detail: rt.detail, hint: rt.fix });
		}
	}
	const ready = statuses.filter((rt) => rt.loggedIn);
	if (ready.length > 0) {
		checks.push({ name: 'runtime', status: 'ok', detail: `ready: ${ready.map((rt) => rt.displayName).join(', ')}` });
	} else {
		// Installed-but-logged-out first: finishing a login is the shortest fix.
		const ordered = [...statuses].sort((a, b) => Number(b.installed) - Number(a.installed));
		checks.push({
			name: 'runtime',
			status: 'fail',
			detail: `no AI runtime is installed and logged in — agents cannot start (${statuses.map((rt) => `${rt.displayName}: ${rt.detail}`).join('; ')})`,
			hint: `Set up one: ${ordered.map((rt) => `${rt.displayName}: ${rt.fix}`).join('  |  ')}`,
		});
	}
	return checks;
}

/**
 * Marketplace reachability check.
 *
 * @param probe - URL probe
 * @returns One check: ok (all sources), warn (some), fail (none)
 */
export async function marketplaceCheck(probe: UrlProbe): Promise<DoctorCheck> {
	const results = await Promise.all(
		MARKETPLACE_SOURCES.map(async (source) => ({ ...source, result: await probe(source.url, MARKETPLACE_PROBE_TIMEOUT_MS) })),
	);
	const up = results.filter((r) => r.result.ok);
	const down = results.filter((r) => !r.result.ok);
	const describe = (list: typeof results): string => list.map((r) => `${r.label} ${r.url}: ${r.result.detail}`).join('; ');
	if (down.length === 0) {
		return { name: 'marketplace', status: 'ok', detail: `reachable (${up.map((r) => r.label).join(', ')})` };
	}
	const fixHint = `Check the network / proxy / firewall, then test with: curl -fsSI ${down[0].url}  — and retry: crewly install --all`;
	if (up.length === 0) {
		return {
			name: 'marketplace',
			status: 'fail',
			detail: `unreachable — skills cannot be installed or updated (${describe(down)})`,
			hint: fixHint,
		};
	}
	return { name: 'marketplace', status: 'warn', detail: `partly reachable — ${describe(down)}`, hint: fixHint };
}

/**
 * Build the list of checks without printing anything.
 *
 * @param deps - Injection points
 * @returns Ordered checks
 */
export async function collectDoctorChecks(deps: DoctorDeps = {}): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];
	const platform = deps.platform ?? process.platform;
	const homeDir = deps.homeDir ?? os.homedir();
	const packageRoot = deps.packageRoot === undefined ? resolvePackageRoot() : deps.packageRoot;

	// 1. Package root
	if (!packageRoot) {
		checks.push({
			name: 'package',
			status: 'fail',
			detail: 'could not locate the Crewly package root',
			hint: 'Reinstall with: npm install -g crewly',
		});
		return checks;
	}
	let version = 'unknown';
	try {
		version = (JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8')) as { version?: string }).version ?? 'unknown';
	} catch {
		// keep 'unknown'
	}
	checks.push({ name: 'package', status: 'ok', detail: `crewly ${version} at ${packageRoot}` });

	// 2. Node
	checks.push({ name: 'node', status: 'ok', detail: `${process.version} (${process.execPath}, ${process.platform}-${process.arch})` });

	// 2b. User — Claude Code agents cannot launch as root. Other runtimes
	// (e.g. Codex on a server) do run as root, so this only fails when claude
	// is installed; otherwise it is a warning.
	const env = deps.env ?? process.env;
	const which = deps.which ?? isOnPath;
	const claudeInstalled = which(CLAUDE_SETUP.BIN);
	const uid = (deps.getuid ?? process.getuid)?.();
	if (uid === 0 && env[CLAUDE_SETUP.SANDBOX_ENV] !== '1') {
		checks.push({
			name: 'user',
			status: claudeInstalled ? 'fail' : 'warn',
			detail: 'running as root — Claude Code refuses to start agents under root/sudo',
			hint: 'Run Crewly as a normal (non-root) user.',
		});
	} else {
		checks.push({ name: 'user', status: 'ok', detail: uid === 0 ? `root, allowed by ${CLAUDE_SETUP.SANDBOX_ENV}=1` : 'not root' });
	}

	// 2c. System tools the skills call (jq, curl)
	for (const tool of DOCTOR_SYSTEM_TOOLS) {
		if (which(tool.command)) {
			checks.push({ name: tool.displayName, status: 'ok', detail: 'found' });
		} else {
			checks.push({
				name: tool.displayName,
				status: 'fail',
				detail: `not found — ${tool.reason}`,
				hint: platform === 'darwin' ? tool.install.macos : tool.install.linux,
			});
		}
	}

	// 3. Native modules
	const tryLoad = deps.tryLoad ?? defaultTryLoad;
	for (const mod of NATIVE_MODULES) {
		try {
			tryLoad(mod, packageRoot);
			checks.push({ name: mod, status: 'ok', detail: 'loads' });
		} catch (error) {
			const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
			checks.push({
				name: mod,
				status: 'fail',
				detail: `cannot load — ${reason}`,
				hint: `Rebuild with: cd ${packageRoot} && npm rebuild ${mod}`,
			});
		}
	}

	// 4. Build toolchain (forced: report even when currently built, as a warning)
	const toolchain = checkNativeToolchain({ packageRoot, which: deps.which, force: true });
	if (toolchain.missing.length === 0) {
		checks.push({ name: 'toolchain', status: 'ok', detail: 'g++, make, python3 available for native rebuilds' });
	} else {
		const needsBuild = !toolchain.nodePty.built && !toolchain.nodePty.prebuilt;
		checks.push({
			name: 'toolchain',
			status: needsBuild ? 'fail' : 'warn',
			detail: `missing ${toolchain.missing.join(', ')} — node-pty ${needsBuild ? 'cannot be compiled' : 'cannot be rebuilt on upgrade'}`,
			hint: toolchain.installHint,
		});
	}

	// 4b. AI runtimes: at least one installed AND logged in. Claude's first-run
	// check (#782) is part of its login check.
	checks.push(...runtimeChecks(checkRuntimeAuth({ which, homeDir, env })));

	// 4c. Marketplace the installer and `crewly install` fetch skills from
	checks.push(await marketplaceCheck(deps.probeUrl ?? defaultProbeUrl));

	// 5. Service environment
	const serviceEnv = path.join(homeDir, CREWLY_CONSTANTS.PATHS.CREWLY_HOME, 'service.env');
	checks.push({
		name: 'service.env',
		status: 'ok',
		detail: fs.existsSync(serviceEnv) ? `present (${serviceEnv})` : `not present (optional; create ${serviceEnv} for DEFAULT_RUNTIME, CREWLY_API_TOKEN, ...)`,
	});

	// 6. Linger (Linux user services die at logout without it)
	if (platform === 'linux') {
		const linger = await (deps.lingerState ?? getLingerState)();
		if (linger === 'yes') {
			checks.push({ name: 'linger', status: 'ok', detail: 'enabled — user service survives logout' });
		} else if (linger === 'no') {
			checks.push({
				name: 'linger',
				status: 'warn',
				detail: 'disabled — the service stops when your session ends',
				hint: `loginctl enable-linger ${os.userInfo().username}`,
			});
		} else {
			checks.push({ name: 'linger', status: 'warn', detail: 'unknown (loginctl unavailable)' });
		}
	}

	return checks;
}

/**
 * Render one check as a coloured line (plus optional hint line).
 *
 * @param check - The check
 * @returns Lines to print
 */
export function formatDoctorCheck(check: DoctorCheck): string[] {
	const icon = check.status === 'ok' ? chalk.green('✓') : check.status === 'warn' ? chalk.yellow('⚠') : chalk.red('✗');
	const lines = [`${icon} ${chalk.bold(check.name.padEnd(14))} ${check.detail}`];
	if (check.hint) lines.push(chalk.gray(`    → ${check.hint}`));
	return lines;
}

/**
 * `crewly doctor` entry point. Prints the report and sets a non-zero exit
 * code when any check failed; "All checks passed" only when nothing failed
 * or warned.
 *
 * @param deps - Injection points (tests); the CLI passes none
 */
export async function doctorCommand(deps: DoctorDeps = {}): Promise<void> {
	console.log(chalk.blue('Crewly Doctor'));
	console.log(chalk.gray('='.repeat(50)));

	const checks = await collectDoctorChecks(deps);
	for (const check of checks) {
		for (const line of formatDoctorCheck(check)) console.log(line);
	}

	const failed = checks.filter((c) => c.status === 'fail').length;
	const warned = checks.filter((c) => c.status === 'warn').length;
	console.log('');
	if (failed > 0) {
		console.log(chalk.red(`${failed} problem(s) found${warned ? `, ${warned} warning(s)` : ''}.`));
		process.exitCode = 1;
	} else if (warned > 0) {
		console.log(chalk.yellow(`No blocking problems, ${warned} warning(s).`));
	} else {
		console.log(chalk.green('All checks passed.'));
	}
}
