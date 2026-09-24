/**
 * Crewly service management command.
 *
 * Installs, uninstalls, and checks the status of Crewly as a platform-native
 * background service:
 *
 * **macOS** — Login Item `.command` file (runs inside Terminal.app)
 *   Why not a LaunchAgent plist? macOS TCC grants permissions based on the
 *   "responsible process." LaunchAgent children do NOT inherit Full Disk
 *   Access, so they cannot access ~/Desktop/ or other protected directories.
 *   A `.command` file runs inside Terminal.app whose TCC permissions propagate
 *   to child processes. It also sources the user's shell profile, picking up
 *   NVM/Homebrew paths that LaunchAgents miss.
 *
 * **Linux** — systemd user service (`systemctl --user`)
 *   No TCC equivalent on Linux, so a standard systemd unit file works.
 *   The service sources the user's shell profile for NVM/PATH consistency.
 */

import { exec, execSync, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import { CREWLY_CONSTANTS } from '../../../config/index.js';
import { resolvePackageRoot } from '../utils/package-root.js';
import {
	SKIP_DRAIN_SIGNAL_GAP_MS,
	describeReadiness,
	fetchRestartReadiness,
	isPidAlive,
	resolveRestartDrainMs,
	resolveShutdownBudgetMs,
	waitForPidExit,
} from '../utils/safe-shutdown.js';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/** Directory where service files are stored (~/.crewly) */
const SERVICE_DIR = path.join(os.homedir(), CREWLY_CONSTANTS.PATHS.CREWLY_HOME);

/** Path to the service log directory */
const LOG_DIR = path.join(SERVICE_DIR, 'logs');

/** Path to the PID file used to prevent duplicate instances */
const PID_FILE = path.join(SERVICE_DIR, 'crewly.pid');

// ---------------------------------------------------------------------------
// macOS constants
// ---------------------------------------------------------------------------

/** Label used for the macOS Login Item */
const LOGIN_ITEM_NAME = 'Crewly Backend';

/** Path to the generated .command file (macOS) */
const COMMAND_FILE_PATH = path.join(SERVICE_DIR, 'crewly-start.command');

/** Legacy LaunchAgent plist label */
const LEGACY_PLIST_LABEL = 'com.crewly.backend';

/** Legacy LaunchAgent plist path */
const LEGACY_PLIST_PATH = path.join(
	os.homedir(),
	'Library',
	'LaunchAgents',
	`${LEGACY_PLIST_LABEL}.plist`,
);

// ---------------------------------------------------------------------------
// Linux constants
// ---------------------------------------------------------------------------

/** systemd user unit directory */
const SYSTEMD_USER_DIR = path.join(os.homedir(), '.config', 'systemd', 'user');

/** systemd service unit name */
const SYSTEMD_UNIT_NAME = 'crewly.service';

/** Full path to the systemd unit file */
const SYSTEMD_UNIT_PATH = path.join(SYSTEMD_USER_DIR, SYSTEMD_UNIT_NAME);

/** Path to the wrapper script used by the systemd service */
const SYSTEMD_WRAPPER_PATH = path.join(SERVICE_DIR, 'crewly-start.sh');

/** Optional env file (KEY=VALUE lines) sourced by the wrappers and loaded by systemd. */
const SERVICE_ENV_FILE_NAME = 'service.env';

/** Absolute path to the optional service env file (~/.crewly/service.env) */
const SERVICE_ENV_PATH = path.join(SERVICE_DIR, SERVICE_ENV_FILE_NAME);

/** Shell-side path to the service env file (uses $HOME so the wrapper stays portable). */
const SERVICE_ENV_SHELL_PATH = `$HOME/${CREWLY_CONSTANTS.PATHS.CREWLY_HOME}/${SERVICE_ENV_FILE_NAME}`;

// ---------------------------------------------------------------------------
// Service environment capture (finding 9)
// ---------------------------------------------------------------------------

/**
 * Environment captured at install time and written verbatim into the wrapper
 * scripts. systemd (and launchd) never source interactive shell profiles —
 * Ubuntu's stock `.bashrc` returns on its first lines for non-interactive
 * shells — so anything the wrapper needs must be spelled out explicitly.
 */
export interface ServiceEnvironment {
	/** Absolute path of the node binary that is running the installer. */
	nodeBin: string;
	/** npm global bin directory (where `crewly`, `claude`, etc. are linked), or null if unknown. */
	npmGlobalBin: string | null;
	/** PATH of the installing shell. */
	path: string;
}

/**
 * Capture the node binary, npm global bin dir and PATH of the current shell.
 *
 * Best-effort: `npm prefix -g` may be unavailable (no npm on PATH); the
 * wrapper then relies on the node dir + captured PATH alone.
 *
 * @returns The captured environment
 */
export function captureServiceEnvironment(): ServiceEnvironment {
	let npmGlobalBin: string | null = null;
	try {
		const prefix = execSync('npm prefix -g', { encoding: 'utf-8', timeout: 10_000 }).trim();
		if (prefix) npmGlobalBin = path.join(prefix, 'bin');
	} catch {
		// npm not on PATH — fall back to node dir + PATH
	}
	return {
		nodeBin: process.execPath,
		npmGlobalBin,
		path: process.env.PATH ?? '',
	};
}

/**
 * Render the explicit-environment block shared by both wrapper scripts.
 *
 * Exports a PATH that leads with the npm global bin dir and the node dir,
 * pins `NODE_BIN` to an absolute path, and sources `~/.crewly/service.env`
 * when present (the documented place for `DEFAULT_RUNTIME`,
 * `CREWLY_API_TOKEN`, `CREWLY_WEB_PORT`, ...).
 *
 * @param env - Environment captured at install time
 * @returns Shell snippet
 */
function renderEnvironmentBlock(env: ServiceEnvironment): string {
	const nodeDir = path.dirname(env.nodeBin);
	const pathParts = [env.npmGlobalBin, nodeDir, env.path].filter((p): p is string => !!p);
	const mergedPath = [...new Set(pathParts.join(':').split(':').filter(Boolean))].join(':');
	return `# Explicit environment captured by \`crewly service install\` — service managers do not
# source interactive shell profiles (Ubuntu's .bashrc returns early when PS1 is unset),
# so PATH and the node binary are written here verbatim. Re-run
# \`crewly service install --force\` after changing node versions.
export PATH="${mergedPath}"
NODE_BIN="${env.nodeBin}"
if [ ! -x "$NODE_BIN" ]; then NODE_BIN="$(command -v node)"; fi

# Optional overrides: put KEY=VALUE lines (DEFAULT_RUNTIME, CREWLY_API_TOKEN,
# CREWLY_WEB_PORT, ...) in ${SERVICE_ENV_SHELL_PATH}
SERVICE_ENV="${SERVICE_ENV_SHELL_PATH}"
if [ -f "$SERVICE_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$SERVICE_ENV"
  set +a
fi`;
}

// ---------------------------------------------------------------------------
// Shared shell snippet: native module arch check
// ---------------------------------------------------------------------------

/**
 * Shell snippet embedded in wrapper scripts that detects architecture
 * mismatches between the running node binary and native modules (e.g.
 * node-pty). If a mismatch is found, runs `npm rebuild` automatically
 * before starting the backend — preventing the ERR_DLOPEN_FAILED crash
 * that occurs when node-pty was compiled for x86_64 but node is arm64
 * (or vice versa).
 */
const NATIVE_MODULE_CHECK = `# Auto-rebuild native modules if node arch doesn't match compiled binaries
PTY_NODE="node_modules/node-pty/build/Release/pty.node"
if [ -f "$PTY_NODE" ]; then
  NODE_ARCH=$("\${NODE_BIN:-node}" -p "process.arch")
  PTY_ARCH=$(file "$PTY_NODE" | grep -o 'arm64\\|x86_64' | head -1)
  # Normalize: node uses "x64", file uses "x86_64"
  if [ "$NODE_ARCH" = "x64" ]; then NODE_ARCH="x86_64"; fi
  if [ "$NODE_ARCH" = "arm64" ] && [ "$PTY_ARCH" = "x86_64" ]; then
    echo "$(date): Architecture mismatch (node=arm64, pty.node=x86_64). Rebuilding..." | tee -a "$LOG_DIR/service.log" 2>/dev/null
    npm rebuild node-pty 2>&1 | tee -a "$LOG_DIR/service.log" 2>/dev/null
  elif [ "$NODE_ARCH" = "x86_64" ] && [ "$PTY_ARCH" = "arm64" ]; then
    echo "$(date): Architecture mismatch (node=x86_64, pty.node=arm64). Rebuilding..." | tee -a "$LOG_DIR/service.log" 2>/dev/null
    npm rebuild node-pty 2>&1 | tee -a "$LOG_DIR/service.log" 2>/dev/null
  fi
fi`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ServiceOptions {
	force?: boolean;
	session?: string;
	app?: boolean;
	lines?: string;
	follow?: boolean;
	/** Target version for upgrade (e.g. "1.4.48" or "latest") */
	version?: string;
	/**
	 * restart/stop/upgrade: do not wait for agents mid-turn — send a second
	 * SIGTERM so the backend skips its drain (interrupted turns are resumed
	 * after the next start).
	 */
	now?: boolean;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Entry point for the `crewly service` subcommand.
 *
 * Dispatches to install / uninstall / status based on the positional argument.
 * Platform detection routes to macOS or Linux implementations.
 *
 * @param action - One of "install", "uninstall", or "status"
 * @param options - Command options (e.g. --force)
 */
export async function serviceCommand(
	action: string,
	options: ServiceOptions,
): Promise<void> {
	switch (action) {
		case 'install':
			await installService(options);
			break;
		case 'uninstall':
			await uninstallService();
			break;
		case 'status':
			await serviceStatus();
			break;
		case 'restart':
			await restartService(options);
			break;
		case 'stop':
			await stopService(options);
			break;
		case 'start':
			await startService();
			break;
		case 'upgrade':
			await upgradeService(options);
			break;
		case 'logs':
			await serviceLogs(options);
			break;
		default:
			console.log(chalk.red(`Unknown action: ${action}`));
			console.log(
				chalk.gray('Usage: crewly service <install|uninstall|status|restart|stop|start|upgrade|logs>'),
			);
			process.exit(1);
	}
}

// ===========================================================================
// Install
// ===========================================================================

/**
 * Installs Crewly as a platform-native background service.
 *
 * On macOS: creates a .command Login Item.
 * On Linux: creates a systemd user service.
 *
 * @param options - Install options (--force to overwrite existing)
 */
async function installService(options: ServiceOptions): Promise<void> {
	assertSupportedPlatform();

	console.log(chalk.blue('Installing Crewly as a background service...'));

	const projectRoot = findProjectRoot();
	if (!projectRoot) {
		console.log(
			chalk.red(
				'Could not find the Crewly package root from the CLI location, the entry script, or the current directory.',
			),
		);
		process.exit(1);
	}

	fs.mkdirSync(LOG_DIR, { recursive: true });

	if (process.platform === 'darwin') {
		await installDarwin(projectRoot, options);
	} else {
		await installLinux(projectRoot, options);
	}
}

// ===========================================================================
// Uninstall
// ===========================================================================

/**
 * Removes the Crewly background service for the current platform.
 */
async function uninstallService(): Promise<void> {
	assertSupportedPlatform();

	console.log(chalk.blue('Uninstalling Crewly service...'));

	if (process.platform === 'darwin') {
		await uninstallDarwin();
	} else {
		await uninstallLinux();
	}

	// Kill running process (shared)
	await killServiceProcess();

	console.log(chalk.green('Crewly service uninstalled.'));
}

// ===========================================================================
// Status
// ===========================================================================

/**
 * Shows the current state of the Crewly background service.
 */
async function serviceStatus(): Promise<void> {
	assertSupportedPlatform();

	console.log(chalk.blue('Crewly Service Status'));
	console.log(chalk.gray('='.repeat(40)));

	if (process.platform === 'darwin') {
		await statusDarwin();
	} else {
		await statusLinux();
	}
}

// ===========================================================================
// macOS implementation
// ===========================================================================

/**
 * macOS install: creates .command file and registers as Login Item.
 *
 * @param projectRoot - Absolute path to the Crewly project directory
 * @param options - Install options
 */
async function installDarwin(
	projectRoot: string,
	options: ServiceOptions,
): Promise<void> {
	await migrateLegacyLaunchAgent();

	if (fs.existsSync(COMMAND_FILE_PATH) && !options.force) {
		console.log(chalk.yellow('Service is already installed.'));
		console.log(
			chalk.gray('Use --force to overwrite, or run "crewly service status".'),
		);
		return;
	}

	const commandFileContent = generateCommandFile(projectRoot, captureServiceEnvironment());
	fs.writeFileSync(COMMAND_FILE_PATH, commandFileContent, { mode: 0o755 });
	console.log(chalk.green(`  Created ${COMMAND_FILE_PATH}`));

	await registerLoginItem();

	console.log('');
	console.log(chalk.green('Crewly service installed successfully!'));
	console.log('');
	console.log(chalk.gray('How it works:'));
	console.log(
		chalk.gray(
			'  - On login, Terminal.app opens the .command file automatically',
		),
	);
	console.log(
		chalk.gray(
			'  - Terminal.app has Full Disk Access, so child processes can access ~/Desktop/',
		),
	);
	console.log(
		chalk.gray(
			'  - Your shell profile is sourced, and PATH/node are also captured explicitly',
		),
	);
	console.log(
		chalk.gray(`  - Extra env (DEFAULT_RUNTIME, CREWLY_API_TOKEN, ...): ${SERVICE_ENV_PATH}`),
	);
	console.log('');
	console.log(
		chalk.cyan('To start now: open ' + COMMAND_FILE_PATH),
	);
}

/**
 * macOS uninstall: removes Login Item and .command file.
 */
async function uninstallDarwin(): Promise<void> {
	await removeLoginItem();

	if (fs.existsSync(COMMAND_FILE_PATH)) {
		fs.unlinkSync(COMMAND_FILE_PATH);
		console.log(chalk.green(`  Removed ${COMMAND_FILE_PATH}`));
	}

	await migrateLegacyLaunchAgent();
}

/**
 * macOS status: checks .command file, Login Item, running process, legacy plist.
 */
async function statusDarwin(): Promise<void> {
	const commandExists = fs.existsSync(COMMAND_FILE_PATH);
	console.log(
		commandExists
			? chalk.green('  .command file: Installed')
			: chalk.red('  .command file: Not found'),
	);

	const isRegistered = await isLoginItemRegistered();
	console.log(
		isRegistered
			? chalk.green('  Login Item: Registered')
			: chalk.red('  Login Item: Not registered'),
	);

	const pid = getRunningPid();
	if (pid) {
		console.log(chalk.green(`  Process: Running (PID ${pid})`));
	} else {
		console.log(chalk.yellow('  Process: Not running'));
	}

	const hasLegacy = fs.existsSync(LEGACY_PLIST_PATH);
	if (hasLegacy) {
		console.log(
			chalk.yellow(
				'  Legacy LaunchAgent plist found — run "crewly service install" to migrate',
			),
		);
	}

	console.log('');
	if (commandExists && isRegistered && pid) {
		console.log(chalk.green('Service is fully operational.'));
	} else if (commandExists && isRegistered) {
		console.log(chalk.yellow('Service is installed but not running.'));
		console.log(chalk.gray(`  Start with: open ${COMMAND_FILE_PATH}`));
	} else {
		console.log(chalk.red('Service is not installed.'));
		console.log(chalk.gray('  Install with: crewly service install'));
	}
}

// ===========================================================================
// Linux implementation
// ===========================================================================

/**
 * Linux install: creates wrapper script and systemd user service unit.
 *
 * @param projectRoot - Absolute path to the Crewly project directory
 * @param options - Install options
 */
async function installLinux(
	projectRoot: string,
	options: ServiceOptions,
): Promise<void> {
	if (fs.existsSync(SYSTEMD_UNIT_PATH) && !options.force) {
		console.log(chalk.yellow('Service is already installed.'));
		console.log(
			chalk.gray('Use --force to overwrite, or run "crewly service status".'),
		);
		return;
	}

	// 1. Write the wrapper script with the environment captured explicitly
	const wrapperContent = generateLinuxWrapper(projectRoot, captureServiceEnvironment());
	fs.writeFileSync(SYSTEMD_WRAPPER_PATH, wrapperContent, { mode: 0o755 });
	console.log(chalk.green(`  Created ${SYSTEMD_WRAPPER_PATH}`));

	// 2. Write the systemd unit file
	fs.mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
	const unitContent = generateSystemdUnit(projectRoot);
	fs.writeFileSync(SYSTEMD_UNIT_PATH, unitContent);
	console.log(chalk.green(`  Created ${SYSTEMD_UNIT_PATH}`));

	// 3. Reload systemd and enable the service
	try {
		await execAsync('systemctl --user daemon-reload');
		await execAsync(`systemctl --user enable ${SYSTEMD_UNIT_NAME}`);
		console.log(chalk.green('  Enabled systemd user service'));
	} catch (error) {
		console.log(chalk.yellow('  Could not enable service via systemctl.'));
		console.log(
			chalk.gray(
				'  Run manually: systemctl --user daemon-reload && systemctl --user enable crewly',
			),
		);
	}

	// 4. Keep the user manager alive after logout (finding 10)
	await enableLinger();

	console.log('');
	console.log(chalk.green('Crewly service installed successfully!'));
	console.log('');
	console.log(chalk.gray('How it works:'));
	console.log(
		chalk.gray('  - systemd manages the Crewly process as a user service'),
	);
	console.log(
		chalk.gray('  - Auto-restarts on crash (5s delay)'),
	);
	console.log(
		chalk.gray('  - PATH and the node binary are captured into the wrapper (systemd does not source shell profiles)'),
	);
	console.log(
		chalk.gray(`  - Extra env (DEFAULT_RUNTIME, CREWLY_API_TOKEN, ...): ${SERVICE_ENV_PATH}`),
	);
	console.log('');
	console.log(
		chalk.cyan(
			`To start now: systemctl --user start ${SYSTEMD_UNIT_NAME}`,
		),
	);
}

/**
 * Linux uninstall: stops and disables the systemd service, removes files.
 */
async function uninstallLinux(): Promise<void> {
	// Stop and disable the service
	try {
		await execAsync(`systemctl --user stop ${SYSTEMD_UNIT_NAME} 2>/dev/null`);
		await execAsync(`systemctl --user disable ${SYSTEMD_UNIT_NAME} 2>/dev/null`);
		console.log(chalk.green('  Stopped and disabled systemd service'));
	} catch {
		console.log(chalk.gray('  systemd service was not running'));
	}

	// Remove unit file
	if (fs.existsSync(SYSTEMD_UNIT_PATH)) {
		fs.unlinkSync(SYSTEMD_UNIT_PATH);
		console.log(chalk.green(`  Removed ${SYSTEMD_UNIT_PATH}`));
	}

	// Remove wrapper script
	if (fs.existsSync(SYSTEMD_WRAPPER_PATH)) {
		fs.unlinkSync(SYSTEMD_WRAPPER_PATH);
		console.log(chalk.green(`  Removed ${SYSTEMD_WRAPPER_PATH}`));
	}

	// Reload systemd
	try {
		await execAsync('systemctl --user daemon-reload');
	} catch {
		// Non-critical
	}
}

/**
 * Linux status: checks systemd unit, service state, and running process.
 */
async function statusLinux(): Promise<void> {
	// Check unit file
	const unitExists = fs.existsSync(SYSTEMD_UNIT_PATH);
	console.log(
		unitExists
			? chalk.green('  Unit file: Installed')
			: chalk.red('  Unit file: Not found'),
	);

	// Check systemd service state
	const serviceState = await getSystemdState();
	if (serviceState === 'active') {
		console.log(chalk.green('  systemd: Active (running)'));
	} else if (serviceState === 'enabled') {
		console.log(chalk.yellow('  systemd: Enabled (not running)'));
	} else if (serviceState === 'inactive') {
		console.log(chalk.yellow('  systemd: Inactive'));
	} else {
		console.log(chalk.red('  systemd: Not registered'));
	}

	// Check PID
	const pid = getRunningPid();
	if (pid) {
		console.log(chalk.green(`  Process: Running (PID ${pid})`));
	} else {
		console.log(chalk.yellow('  Process: Not running'));
	}

	// Check linger (finding 10)
	const linger = await getLingerState();
	if (linger === 'yes') {
		console.log(chalk.green('  Linger: Enabled (survives logout)'));
	} else if (linger === 'no') {
		console.log(chalk.yellow(`  Linger: Disabled — run: loginctl enable-linger ${os.userInfo().username}`));
	} else {
		console.log(chalk.gray('  Linger: Unknown (loginctl unavailable)'));
	}

	console.log('');
	if (unitExists && serviceState === 'active' && pid) {
		console.log(chalk.green('Service is fully operational.'));
	} else if (unitExists && serviceState) {
		console.log(chalk.yellow('Service is installed but not running.'));
		console.log(
			chalk.gray(`  Start with: systemctl --user start ${SYSTEMD_UNIT_NAME}`),
		);
	} else {
		console.log(chalk.red('Service is not installed.'));
		console.log(chalk.gray('  Install with: crewly service install'));
	}
}

// ===========================================================================
// Linux helpers
// ===========================================================================

/**
 * Generates the systemd unit file content.
 *
 * Uses a wrapper script as ExecStart that carries an explicitly captured
 * PATH/node binary (shell profiles are not sourced under systemd). The
 * optional `~/.crewly/service.env` is loaded both by systemd
 * (`EnvironmentFile=-`, missing file tolerated) and by the wrapper.
 *
 * @param projectRoot - Absolute path to the Crewly project directory
 * @returns The systemd unit file content
 */
export function generateSystemdUnit(projectRoot: string): string {
	return `[Unit]
Description=Crewly Backend Service
After=network.target

[Service]
Type=simple
ExecStart=${SYSTEMD_WRAPPER_PATH}
WorkingDirectory=${projectRoot}
Restart=on-failure
RestartSec=5
# Safe restart: SIGTERM only the main process (the crewly CLI, which forwards
# it to the backend) instead of the whole cgroup — the default would kill
# every agent runtime at once, before the backend can drain their turns.
KillMode=mixed
# The backend waits up to CREWLY_RESTART_DRAIN_MS for agents mid-turn; do not
# SIGKILL before that plus the shutdown margin.
TimeoutStopSec=${Math.ceil(resolveShutdownBudgetMs(process.env) / 1000)}
Environment=NODE_ENV=development
EnvironmentFile=-%h/${CREWLY_CONSTANTS.PATHS.CREWLY_HOME}/${SERVICE_ENV_FILE_NAME}

StandardOutput=append:${LOG_DIR}/service.log
StandardError=append:${LOG_DIR}/service.log

[Install]
WantedBy=default.target
`;
}

/**
 * Generates the Linux wrapper script used as the systemd ExecStart.
 *
 * Exports the PATH/node binary captured at install time (finding 9: sourcing
 * `.bashrc` is a no-op under systemd on Ubuntu), sources the optional
 * `~/.crewly/service.env`, runs the native-module arch check and execs node.
 *
 * @param projectRoot - Absolute path to the Crewly project directory
 * @param env - Environment captured at install time (defaults to the current process)
 * @returns The shell script content
 */
export function generateLinuxWrapper(
	projectRoot: string,
	env: ServiceEnvironment = captureServiceEnvironment(),
): string {
	return `#!/bin/bash
# Crewly Backend Service wrapper for systemd
# Carries an explicit PATH/node captured at install time, then starts the backend.

# ~/.profile is safe to source non-interactively (unlike .bashrc); best-effort only.
if [ -f "$HOME/.profile" ]; then
  source "$HOME/.profile" 2>/dev/null || true
fi

${renderEnvironmentBlock(env)}

export NODE_ENV="\${NODE_ENV:-development}"

CREWLY_DIR="${projectRoot}"
PIDFILE="$HOME/${CREWLY_CONSTANTS.PATHS.CREWLY_HOME}/crewly.pid"

# cd on each systemd restart to handle directory inode changes after
# npm install -g replaces the install directory. (#244)
cd "$CREWLY_DIR" || { echo "Cannot cd to $CREWLY_DIR"; exit 1; }

${NATIVE_MODULE_CHECK}

echo "$(date): Starting Crewly backend ($NODE_BIN $("$NODE_BIN" --version))..."

# Write PID file for status checks
echo $$ > "$PIDFILE"

exec "$NODE_BIN" dist/cli/cli/src/index.js start
`;
}

/**
 * Enable lingering for the current user so the systemd user manager — and
 * the Crewly service under it — survives the SSH session ending.
 *
 * Without `loginctl enable-linger`, a `systemctl --user` service is torn
 * down when the user's last session closes, which on a server is the normal
 * path right after install (finding 10). Best-effort: failures (no
 * loginctl, no polkit authority, non-systemd box) are reported with the
 * manual command and never abort the install.
 *
 * @param user - User to enable lingering for (defaults to the current user)
 * @returns true when linger was enabled (or already on), false otherwise
 */
export async function enableLinger(user: string = os.userInfo().username): Promise<boolean> {
	const manual = `loginctl enable-linger ${user}`;
	try {
		await execAsync(manual);
	} catch (error) {
		const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
		console.log(chalk.yellow('  Could not enable linger — the service will stop when you log out.'));
		console.log(chalk.gray(`  (${reason})`));
		console.log(chalk.gray(`  Run manually: ${manual}`));
		return false;
	}

	// Verify — enable-linger exits 0 in some containers without taking effect.
	try {
		const { stdout } = await execAsync(`loginctl show-user ${user} --property=Linger --value`);
		if (stdout.trim() === 'no') {
			console.log(chalk.yellow('  Linger is still off — the service will stop when you log out.'));
			console.log(chalk.gray(`  Run manually: ${manual}`));
			return false;
		}
	} catch {
		// show-user unavailable (older systemd) — trust the enable call
	}

	console.log(chalk.green(`  Enabled linger for ${user} (service survives logout)`));
	return true;
}

/**
 * Read the linger state of the current user via loginctl.
 *
 * @param user - User to query (defaults to the current user)
 * @returns "yes", "no", or null when loginctl is unavailable
 */
export async function getLingerState(user: string = os.userInfo().username): Promise<'yes' | 'no' | null> {
	try {
		const { stdout } = await execAsync(`loginctl show-user ${user} --property=Linger --value`);
		const v = stdout.trim();
		return v === 'yes' || v === 'no' ? v : null;
	} catch {
		return null;
	}
}

/**
 * Queries systemd for the current state of the crewly service.
 *
 * @returns "active", "enabled", "inactive", or null if not registered
 */
export async function getSystemdState(): Promise<string | null> {
	try {
		const { stdout } = await execAsync(
			`systemctl --user is-active ${SYSTEMD_UNIT_NAME} 2>/dev/null`,
		);
		const state = stdout.trim();
		if (state === 'active') return 'active';
		return 'inactive';
	} catch {
		// is-active returns non-zero for inactive/unknown
	}

	try {
		const { stdout } = await execAsync(
			`systemctl --user is-enabled ${SYSTEMD_UNIT_NAME} 2>/dev/null`,
		);
		if (stdout.trim() === 'enabled') return 'enabled';
	} catch {
		// is-enabled returns non-zero if not found
	}

	return null;
}

// ===========================================================================
// macOS helpers
// ===========================================================================

/**
 * Generates the content of the .command wrapper script (macOS).
 *
 * The script sources the user's shell profile (for NVM/PATH), additionally
 * exports the PATH/node captured at install time and the optional
 * `~/.crewly/service.env`, prevents duplicate instances via a PID file, and
 * auto-restarts on crash.
 *
 * @param projectRoot - Absolute path to the Crewly project directory
 * @param env - Environment captured at install time (defaults to the current process)
 * @returns The shell script content
 */
export function generateCommandFile(
	projectRoot: string,
	env: ServiceEnvironment = captureServiceEnvironment(),
): string {
	return `#!/bin/bash
# Crewly Backend Service — runs inside Terminal.app for FDA inheritance
# Registered as a macOS Login Item for auto-start on boot.
#
# Terminal.app's TCC permissions propagate to child processes,
# allowing access to ~/Desktop/ and other protected directories.

set -euo pipefail

# Source shell profile to pick up NVM, PATH, etc.
if [ -f "$HOME/.zshrc" ]; then
  source "$HOME/.zshrc" 2>/dev/null || true
elif [ -f "$HOME/.bashrc" ]; then
  source "$HOME/.bashrc" 2>/dev/null || true
fi

${renderEnvironmentBlock(env)}

export NODE_ENV="\${NODE_ENV:-development}"

CREWLY_DIR="${projectRoot}"
LOG_DIR="$HOME/${CREWLY_CONSTANTS.PATHS.CREWLY_HOME}/logs"
PIDFILE="$HOME/${CREWLY_CONSTANTS.PATHS.CREWLY_HOME}/crewly.pid"

mkdir -p "$LOG_DIR"

# Prevent duplicate instances
if [ -f "$PIDFILE" ]; then
  OLD_PID=$(cat "$PIDFILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Crewly already running (PID $OLD_PID). Exiting."
    exit 0
  fi
fi

echo "$(date): Starting Crewly backend ($NODE_BIN $("$NODE_BIN" --version))..." | tee -a "$LOG_DIR/service.log"

# Run in foreground so Terminal keeps the tab open; restart on crash
while true; do
  # cd inside the loop so the cwd is refreshed after npm install -g replaces
  # the directory (new inode). Without this, the stale cwd causes ENOENT on
  # every process.cwd() call in Node. (#244)
  cd "$CREWLY_DIR" || { echo "Cannot cd to $CREWLY_DIR"; exit 1; }

  ${NATIVE_MODULE_CHECK}

  # Check if port is already in use before starting (prevents restart loop
  # when another instance grabbed the port after a graceful shutdown)
  WEB_PORT=\${CREWLY_WEB_PORT:-8787}
  if lsof -iTCP:"\$WEB_PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "$(date): Port \$WEB_PORT already in use — another instance is running. Exiting wrapper." | tee -a "$LOG_DIR/service.log"
    rm -f "$PIDFILE"
    exit 0
  fi

  "$NODE_BIN" dist/cli/cli/src/index.js start >> "$LOG_DIR/service.log" 2>&1 &
  NODE_PID=$!
  echo "$NODE_PID" > "$PIDFILE"
  wait "$NODE_PID" || true
  EXIT_CODE=$?
  echo "$(date): Crewly exited with code $EXIT_CODE, restarting in 5s..." | tee -a "$LOG_DIR/service.log"
  sleep 5
done
`;
}

/**
 * Registers the .command file as a macOS Login Item via osascript.
 *
 * @throws Error if osascript fails
 */
async function registerLoginItem(): Promise<void> {
	try {
		await execAsync(
			`osascript -e 'tell application "System Events" to make login item at end with properties {path:"${COMMAND_FILE_PATH}", hidden:false, name:"${LOGIN_ITEM_NAME}"}'`,
		);
		console.log(chalk.green('  Registered as Login Item'));
	} catch (error) {
		console.log(chalk.yellow('  Could not register Login Item automatically.'));
		console.log(
			chalk.gray(
				'  Add manually: System Settings → General → Login Items → add ' +
					COMMAND_FILE_PATH,
			),
		);
	}
}

/**
 * Removes the Crewly Login Item via osascript.
 */
async function removeLoginItem(): Promise<void> {
	try {
		await execAsync(
			`osascript -e 'tell application "System Events" to delete login item "${LOGIN_ITEM_NAME}"'`,
		);
		console.log(chalk.green('  Removed Login Item'));
	} catch {
		console.log(chalk.gray('  Login Item was not registered (nothing to remove)'));
	}
}

/**
 * Checks whether the Crewly Login Item is currently registered.
 *
 * @returns true if registered
 */
export async function isLoginItemRegistered(): Promise<boolean> {
	try {
		const { stdout } = await execAsync(
			`osascript -e 'tell application "System Events" to get the name of every login item'`,
		);
		return stdout.includes(LOGIN_ITEM_NAME);
	} catch {
		return false;
	}
}

/**
 * Detects and removes a legacy LaunchAgent plist (com.crewly.backend).
 *
 * Unloads the service via launchctl before removing the file.
 */
async function migrateLegacyLaunchAgent(): Promise<void> {
	if (!fs.existsSync(LEGACY_PLIST_PATH)) {
		return;
	}

	console.log(chalk.yellow('  Found legacy LaunchAgent plist, migrating...'));

	try {
		await execAsync(
			`launchctl bootout gui/$(id -u)/${LEGACY_PLIST_LABEL} 2>/dev/null`,
		);
		console.log(chalk.green('  Unloaded legacy LaunchAgent'));
	} catch {
		// Already unloaded
	}

	try {
		fs.unlinkSync(LEGACY_PLIST_PATH);
		console.log(chalk.green(`  Removed ${LEGACY_PLIST_PATH}`));
	} catch {
		console.log(
			chalk.yellow(
				`  Could not remove ${LEGACY_PLIST_PATH} — please delete manually`,
			),
		);
	}

	const legacyScript = path.join(SERVICE_DIR, 'crewly-service.sh');
	if (fs.existsSync(legacyScript)) {
		try {
			fs.unlinkSync(legacyScript);
			console.log(chalk.green('  Removed legacy crewly-service.sh'));
		} catch {
			// Non-critical
		}
	}
}

// ===========================================================================
// Restart
// ===========================================================================

/**
 * Print who is mid-turn before stopping, so the operator knows why the stop
 * may take a while (the backend drains in-flight agent turns first).
 */
async function printRestartReadiness(): Promise<void> {
	const readiness = await fetchRestartReadiness();
	if (!readiness) return;
	for (const line of describeReadiness(readiness, resolveRestartDrainMs(process.env))) {
		console.log(chalk.gray(`  ${line}`));
	}
}

/**
 * Send SIGTERM to a pid; with `skipDrain`, send a second one after the
 * backend's dedup window so it stops waiting for agents.
 *
 * @param pid - Process to signal
 * @param skipDrain - Also send the "stop waiting" signal
 * @returns False if the process could not be signalled
 */
async function signalStop(pid: number, skipDrain: boolean): Promise<boolean> {
	try {
		process.kill(pid, 'SIGTERM');
	} catch {
		return false;
	}
	if (skipDrain) {
		await new Promise((r) => setTimeout(r, SKIP_DRAIN_SIGNAL_GAP_MS));
		try {
			process.kill(pid, 'SIGTERM');
			console.log(chalk.yellow('  --now: asked the backend not to wait for agents mid-turn'));
		} catch {
			// Already gone.
		}
	}
	return true;
}

/**
 * Wait for a stopped process to exit, within the drain budget.
 *
 * @param pid - Process id
 * @returns True if it exited
 */
async function waitForStopped(pid: number): Promise<boolean> {
	const budgetMs = resolveShutdownBudgetMs(process.env);
	console.log(chalk.gray(`  Waiting for agents to finish their current turn (up to ${Math.round(budgetMs / 1000)}s; --now skips)...`));
	const exited = await waitForPidExit(pid, budgetMs, {
		isAlive: isPidAlive,
		onProgress: (waitedMs) => console.log(chalk.gray(`  ...still draining (${Math.round(waitedMs / 1000)}s)`)),
	});
	if (!exited) {
		console.log(chalk.yellow(`  Process ${pid} is still running after ${Math.round(budgetMs / 1000)}s.`));
	}
	return exited;
}

/**
 * On Linux with --now, ask the running unit to skip its drain before
 * systemctl stops it: two SIGTERMs to the main process (the CLI forwards
 * both; the backend reads the second as "stop waiting").
 */
async function skipDrainLinux(): Promise<void> {
	const cmd = `systemctl --user kill --kill-whom=main --signal=SIGTERM ${SYSTEMD_UNIT_NAME}`;
	try {
		await execAsync(cmd);
		await new Promise((r) => setTimeout(r, SKIP_DRAIN_SIGNAL_GAP_MS));
		await execAsync(cmd);
		console.log(chalk.yellow('  --now: asked the backend not to wait for agents mid-turn'));
	} catch {
		// Not running — systemctl below reports the state.
	}
}

/**
 * Restarts the Crewly service.
 *
 * The backend drains in-flight agent turns on SIGTERM (up to
 * CREWLY_RESTART_DRAIN_MS, default 120s), so this waits for the old process
 * to exit before reporting or re-launching. `--now` skips the drain; turns
 * cut off are resumed after the restart.
 *
 * On macOS, checks whether the service wrapper (while-true loop) is the
 * parent of the running node process. If so, the wrapper auto-restarts.
 * If the process was started via `npm run dev` or another method (parent is
 * PID 1 / launchd), kills it and launches via the .command wrapper directly.
 *
 * On Linux, uses `systemctl --user restart` (blocks until stopped; the unit's
 * TimeoutStopSec covers the drain).
 *
 * @param options - `now` to skip the drain
 */
async function restartService(options: ServiceOptions = {}): Promise<void> {
	assertSupportedPlatform();
	await printRestartReadiness();

	if (process.platform === 'linux') {
		if (options.now) await skipDrainLinux();
		try {
			await execAsync(`systemctl --user restart ${SYSTEMD_UNIT_NAME}`);
			console.log(chalk.green('Crewly service restarted.'));
		} catch {
			console.log(chalk.red('Failed to restart service via systemctl.'));
			console.log(chalk.gray(`  Try: systemctl --user restart ${SYSTEMD_UNIT_NAME}`));
		}
		return;
	}

	// macOS: kill the node process, then ensure it comes back up
	const pid = getRunningPid();
	if (!pid) {
		console.log(chalk.yellow('Crewly service is not running. Starting it...'));
		await startService();
		return;
	}

	// Check if the wrapper loop is the parent (PPID > 1 means a shell wrapper)
	let hasWrapper = false;
	try {
		const { stdout } = await execAsync(`ps -o ppid= -p ${pid}`);
		const ppid = parseInt(stdout.trim(), 10);
		hasWrapper = !isNaN(ppid) && ppid > 1;
	} catch {
		// Could not determine parent
	}

	if (!(await signalStop(pid, options.now === true))) {
		console.log(chalk.red('Failed to send signal to the process.'));
		return;
	}
	console.log(chalk.green(`Sent SIGTERM to node process (PID ${pid}).`));

	const exited = await waitForStopped(pid);

	if (hasWrapper) {
		console.log(chalk.gray(exited
			? 'The service wrapper will auto-restart in ~5 seconds.'
			: 'The service wrapper restarts it once it exits.'));
	} else if (exited) {
		console.log(chalk.gray('No service wrapper detected. Re-launching...'));
		await startService();
	} else {
		console.log(chalk.yellow('Not re-launching while the old process is still running. Run "crewly service start" once it exits.'));
	}
}

// ===========================================================================
// Stop
// ===========================================================================

/**
 * Stops the Crewly service completely, including the restart wrapper.
 *
 * Waits for the backend to drain in-flight agent turns (see restartService);
 * `--now` skips the drain.
 *
 * On macOS, kills both the node process and its parent bash wrapper
 * (the `while true` loop) to prevent automatic restart. The wrapper only
 * waits on the node process, so stopping it does not cut the drain short.
 * On Linux, uses `systemctl --user stop`.
 *
 * @param options - `now` to skip the drain
 */
async function stopService(options: ServiceOptions = {}): Promise<void> {
	assertSupportedPlatform();
	await printRestartReadiness();

	if (process.platform === 'linux') {
		if (options.now) await skipDrainLinux();
		try {
			await execAsync(`systemctl --user stop ${SYSTEMD_UNIT_NAME}`);
			console.log(chalk.green('Crewly service stopped.'));
		} catch {
			console.log(chalk.red('Failed to stop service via systemctl.'));
			console.log(chalk.gray(`  Try: systemctl --user stop ${SYSTEMD_UNIT_NAME}`));
		}
		if (fs.existsSync(PID_FILE)) {
			fs.unlinkSync(PID_FILE);
		}
		return;
	}

	// macOS: kill node process, then kill parent wrapper
	const pid = getRunningPid();
	if (!pid) {
		console.log(chalk.yellow('Crewly service is not running.'));
		return;
	}

	// Find the parent PID (the bash while-true wrapper)
	let parentPid: number | null = null;
	try {
		const { stdout } = await execAsync(`ps -o ppid= -p ${pid}`);
		const ppid = parseInt(stdout.trim(), 10);
		if (!isNaN(ppid) && ppid > 1) {
			parentPid = ppid;
		}
	} catch {
		// Could not determine parent — will just kill node process
	}

	// Kill the parent wrapper first so it cannot restart the process once it
	// exits. The wrapper is only waiting on node; the drain carries on.
	if (parentPid) {
		try {
			process.kill(parentPid, 'SIGTERM');
			console.log(chalk.green(`  Stopped wrapper process (PID ${parentPid})`));
		} catch {
			console.log(chalk.gray('  Wrapper process was already stopped'));
		}
	} else {
		console.log(chalk.yellow('  Could not find wrapper process. The service may auto-restart.'));
		console.log(chalk.gray('  To fully stop, close the Terminal.app tab running crewly-start.command'));
	}

	if (await signalStop(pid, options.now === true)) {
		console.log(chalk.green(`  Stopping node process (PID ${pid})`));
		await waitForStopped(pid);
	} else {
		console.log(chalk.gray('  Node process was already stopped'));
	}

	// Clean up PID file
	if (fs.existsSync(PID_FILE)) {
		fs.unlinkSync(PID_FILE);
	}

	console.log(chalk.green('Crewly service stopped.'));
}

// ===========================================================================
// Start
// ===========================================================================

/**
 * Starts the Crewly service if not already running.
 *
 * Checks the PID file for a running process, clears stale PID files,
 * and launches the service using the platform-native method:
 * - macOS: `open` the .command file (opens in Terminal.app)
 * - Linux: `systemctl --user start`
 *
 * @throws Error if the service is not installed
 */
async function startService(): Promise<void> {
	assertSupportedPlatform();

	// Check if already running
	const pid = getRunningPid();
	if (pid) {
		console.log(chalk.yellow(`Crewly service is already running (PID ${pid}).`));
		return;
	}

	// Clear stale PID file
	if (fs.existsSync(PID_FILE)) {
		fs.unlinkSync(PID_FILE);
	}

	if (process.platform === 'darwin') {
		if (!fs.existsSync(COMMAND_FILE_PATH)) {
			console.log(chalk.red('Service is not installed. Run "crewly service install" first.'));
			process.exit(1);
		}

		try {
			await execAsync(`open "${COMMAND_FILE_PATH}"`);
			console.log(chalk.green('Crewly service started (opened .command in Terminal.app).'));
		} catch (error) {
			console.log(chalk.red('Failed to open .command file.'));
			console.log(chalk.gray(`  Try manually: open ${COMMAND_FILE_PATH}`));
		}
	} else {
		// Linux
		if (!fs.existsSync(SYSTEMD_UNIT_PATH)) {
			console.log(chalk.red('Service is not installed. Run "crewly service install" first.'));
			process.exit(1);
		}

		try {
			await execAsync(`systemctl --user start ${SYSTEMD_UNIT_NAME}`);
			console.log(chalk.green('Crewly service started via systemd.'));
		} catch {
			console.log(chalk.red('Failed to start service via systemctl.'));
			console.log(chalk.gray(`  Try: systemctl --user start ${SYSTEMD_UNIT_NAME}`));
		}
	}
}

// ===========================================================================
// Upgrade
// ===========================================================================

/**
 * Upgrades the Crewly installation and regenerates service files.
 *
 * Steps:
 * 1. Stop the running service
 * 2. Run `npm install -g crewly@<version>` (defaults to "latest")
 * 3. Regenerate the .command / systemd wrapper with the new project root
 * 4. Restart the service
 *
 * @param options - Upgrade options (--version to specify target version)
 */
async function upgradeService(options: ServiceOptions): Promise<void> {
	assertSupportedPlatform();

	const targetVersion = options.version || 'latest';

	console.log(chalk.blue(`Upgrading Crewly to ${targetVersion}...`));

	// 1. Stop the service — and wait for it: npm must not replace the files
	// under a backend that is still draining agent turns, and startService
	// refuses to start while the old process is alive.
	console.log(chalk.gray('  Stopping service...'));
	await stopService(options);

	// 2. Run npm install -g
	console.log(chalk.gray(`  Installing crewly@${targetVersion}...`));
	try {
		const { stdout, stderr } = await execAsync(
			`npm install -g crewly@${targetVersion}`,
			{ timeout: 120_000 },
		);
		if (stdout) console.log(chalk.gray(`  ${stdout.trim()}`));
		if (stderr && !stderr.includes('npm warn')) {
			console.log(chalk.yellow(`  ${stderr.trim()}`));
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.log(chalk.red(`  npm install failed: ${msg}`));
		console.log(chalk.gray('  The service was stopped but not upgraded. Start it manually.'));
		process.exit(1);
	}

	// 3. Regenerate service files with fresh project root
	const newProjectRoot = findProjectRoot();
	if (!newProjectRoot) {
		console.log(chalk.yellow('  Could not detect new project root. Skipping service file regeneration.'));
		console.log(chalk.gray('  Run "crewly service install --force" to regenerate manually.'));
	} else {
		console.log(chalk.gray('  Regenerating service files...'));
		fs.mkdirSync(LOG_DIR, { recursive: true });

		if (process.platform === 'darwin') {
			const commandFileContent = generateCommandFile(newProjectRoot, captureServiceEnvironment());
			fs.writeFileSync(COMMAND_FILE_PATH, commandFileContent, { mode: 0o755 });
			console.log(chalk.green(`  Updated ${COMMAND_FILE_PATH}`));
		} else {
			const wrapperContent = generateLinuxWrapper(newProjectRoot, captureServiceEnvironment());
			fs.writeFileSync(SYSTEMD_WRAPPER_PATH, wrapperContent, { mode: 0o755 });
			console.log(chalk.green(`  Updated ${SYSTEMD_WRAPPER_PATH}`));

			try {
				await execAsync('systemctl --user daemon-reload');
			} catch {
				// Non-critical
			}
		}
	}

	// 4. Restart
	console.log(chalk.gray('  Starting service...'));
	await startService();

	console.log('');
	console.log(chalk.green(`Crewly upgraded to ${targetVersion} and restarted.`));
}

// ===========================================================================
// Logs
// ===========================================================================

/**
 * Displays or follows Crewly service logs.
 *
 * By default shows the last N lines of the main service log.
 * Use --session <name> for agent session logs, --app for today's app log,
 * and --follow for real-time tailing.
 *
 * @param options - Log viewing options (session, app, follow, lines)
 */
async function serviceLogs(options: ServiceOptions): Promise<void> {
	const numLines = parseInt(options.lines || '50', 10);

	let logFile: string;

	if (options.session) {
		logFile = resolveSessionLogFile(options.session);
	} else if (options.app) {
		const today = new Date().toISOString().split('T')[0];
		logFile = path.join(LOG_DIR, `crewly-${today}.log`);
		if (!fs.existsSync(logFile)) {
			console.log(chalk.red(`Today's app log not found: crewly-${today}.log`));
			listAvailableAppLogs();
			return;
		}
	} else {
		logFile = path.join(LOG_DIR, 'service.log');
		if (!fs.existsSync(logFile)) {
			console.log(chalk.red('Service log not found.'));
			console.log(chalk.gray('Is the service installed? Run: crewly service status'));
			return;
		}
	}

	console.log(chalk.blue(`Crewly Logs: ${path.basename(logFile)}`));
	console.log(chalk.gray('='.repeat(50)));

	if (options.follow) {
		const tailProc = spawn('tail', ['-n', numLines.toString(), '-f', logFile], {
			stdio: 'inherit',
		});

		process.on('SIGINT', () => {
			tailProc.kill('SIGTERM');
			process.exit(0);
		});

		await new Promise<void>((resolve) => {
			tailProc.on('close', () => resolve());
		});
	} else {
		try {
			const { stdout } = await execAsync(`tail -n ${numLines} "${logFile}"`);
			if (stdout.trim()) {
				console.log(stdout.trimEnd());
			} else {
				console.log(chalk.gray('(log file is empty)'));
			}
		} catch {
			console.log(chalk.red('Failed to read log file.'));
		}
	}
}

/**
 * Resolve the log file path for a session name, supporting partial matching.
 *
 * @param sessionName - Exact or partial session name
 * @returns Absolute path to the session log file
 */
function resolveSessionLogFile(sessionName: string): string {
	const sessionLogDir = path.join(LOG_DIR, 'sessions');
	const exactPath = path.join(sessionLogDir, `${sessionName}.log`);

	if (fs.existsSync(exactPath)) {
		return exactPath;
	}

	// Fuzzy match: find files containing the session name
	if (fs.existsSync(sessionLogDir)) {
		const candidates = fs.readdirSync(sessionLogDir)
			.filter(f => f.endsWith('.log') && f.includes(sessionName));

		if (candidates.length === 1) {
			console.log(chalk.gray(`Matched session: ${candidates[0].replace('.log', '')}`));
			return path.join(sessionLogDir, candidates[0]);
		}

		if (candidates.length > 1) {
			console.log(chalk.yellow(`Multiple sessions match "${sessionName}":`));
			candidates.forEach(c => console.log(chalk.gray(`  ${c.replace('.log', '')}`)));
			console.log(chalk.gray('Please specify a more exact name.'));
			process.exit(1);
		}
	}

	// No match found
	console.log(chalk.red(`Session log not found: ${sessionName}`));
	listAvailableSessionLogs();
	process.exit(1);
}

/**
 * List available session log files.
 */
function listAvailableSessionLogs(): void {
	const sessionLogDir = path.join(LOG_DIR, 'sessions');
	if (!fs.existsSync(sessionLogDir)) return;

	const sessions = fs.readdirSync(sessionLogDir)
		.filter(f => f.endsWith('.log'))
		.map(f => f.replace('.log', ''));

	if (sessions.length === 0) {
		console.log(chalk.gray('No session logs available.'));
		return;
	}

	console.log(chalk.gray('Available sessions:'));
	sessions.forEach(s => console.log(chalk.gray(`  ${s}`)));
}

/**
 * List available daily app log files.
 */
function listAvailableAppLogs(): void {
	if (!fs.existsSync(LOG_DIR)) return;

	const appLogs = fs.readdirSync(LOG_DIR)
		.filter(f => f.startsWith('crewly-') && f.endsWith('.log'))
		.slice(-5);

	if (appLogs.length > 0) {
		console.log(chalk.gray('Available app logs:'));
		appLogs.forEach(l => console.log(chalk.gray(`  ${l}`)));
	}
}

// ===========================================================================
// Shared helpers
// ===========================================================================

/**
 * Asserts the current platform is macOS or Linux. Exits with an error
 * message on unsupported platforms (e.g. Windows).
 */
function assertSupportedPlatform(): void {
	if (process.platform !== 'darwin' && process.platform !== 'linux') {
		console.log(
			chalk.red(
				`Service management is not supported on ${process.platform}. Supported: macOS, Linux.`,
			),
		);
		process.exit(1);
	}
}

/**
 * Finds the Crewly package root the CLI is running from.
 *
 * Anchors on the CLI's own module location and the entry script before the
 * cwd, so `crewly service install` works from any directory after a global
 * npm install (finding 8) instead of demanding the operator `cd` into
 * `/usr/lib/node_modules/crewly` first.
 *
 * @returns Absolute path to the package root, or null if not found
 */
export function findProjectRoot(): string | null {
	return resolvePackageRoot();
}

/**
 * Reads the PID file and verifies the process is still alive.
 * Falls back to detecting the process by port if the PID file is stale
 * (e.g. when Crewly was started via `npm run dev` instead of the service wrapper).
 *
 * @returns The PID if the process is running, or null
 */
export function getRunningPid(): number | null {
	// 1. Try PID file first
	if (fs.existsSync(PID_FILE)) {
		try {
			const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
			if (!isNaN(pid)) {
				process.kill(pid, 0);
				return pid;
			}
		} catch {
			// PID file is stale — fall through to port detection
		}
	}

	// 2. Fall back to detecting by port (covers npm run dev, manual starts, etc.)
	return getRunningPidByPort();
}

/**
 * Detects the PID of a process listening on the Crewly web port.
 * Uses `lsof` to find the listener, which works for any start method.
 *
 * @returns The PID if a process is listening on the port, or null
 */
export function getRunningPidByPort(): number | null {
	const port = process.env.CREWLY_WEB_PORT || '8787';
	try {
		const result = execSync(
			`lsof -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`,
			{ encoding: 'utf-8', timeout: 5000 },
		).trim();
		const pid = parseInt(result.split('\n')[0], 10);
		return isNaN(pid) ? null : pid;
	} catch {
		return null;
	}
}

/**
 * Kills the running service process identified by the PID file.
 */
async function killServiceProcess(): Promise<void> {
	const pid = getRunningPid();
	if (pid) {
		try {
			process.kill(pid, 'SIGTERM');
			console.log(chalk.green(`  Stopped running process (PID ${pid})`));
		} catch {
			console.log(chalk.gray('  Process was already stopped'));
		}
	}

	if (fs.existsSync(PID_FILE)) {
		fs.unlinkSync(PID_FILE);
	}
}
