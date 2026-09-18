/**
 * `crewly doctor` — environment health report.
 *
 * Answers "why does this install not work?" in one screen: where the package
 * lives, which node runs it, whether the native modules (node-pty,
 * better-sqlite3) are built and loadable, whether the C++ toolchain needed to
 * rebuild them is present (server-install finding 11), and — on Linux — whether
 * the user service will survive logout.
 *
 * @module cli/commands/doctor
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import chalk from 'chalk';
import { CREWLY_CONSTANTS } from '../../../config/index.js';
import { resolvePackageRoot } from '../utils/package-root.js';
import { checkNativeToolchain } from '../utils/native-toolchain.js';
import { getLingerState } from './service.js';

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
}

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
 * code when any check failed.
 */
export async function doctorCommand(): Promise<void> {
	console.log(chalk.blue('Crewly Doctor'));
	console.log(chalk.gray('='.repeat(50)));

	const checks = await collectDoctorChecks();
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
