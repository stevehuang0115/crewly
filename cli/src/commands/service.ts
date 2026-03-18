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

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import { CREWLY_CONSTANTS } from '../../../config/index.js';

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
  NODE_ARCH=$(node -p "process.arch")
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
			await restartService();
			break;
		case 'stop':
			await stopService();
			break;
		case 'logs':
			await serviceLogs(options);
			break;
		default:
			console.log(chalk.red(`Unknown action: ${action}`));
			console.log(
				chalk.gray('Usage: crewly service <install|uninstall|status|restart|stop|logs>'),
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
				'Could not find Crewly project root. Run this from within the Crewly directory.',
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

	const commandFileContent = generateCommandFile(projectRoot);
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
			'  - Your shell profile is sourced, so NVM/Homebrew paths are available',
		),
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

	// 1. Write the wrapper script (sources shell profile for NVM/PATH)
	const wrapperContent = generateLinuxWrapper(projectRoot);
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
		chalk.gray('  - Shell profile sourced for NVM/PATH'),
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
 * Uses a wrapper script as ExecStart so the user's shell profile is sourced,
 * ensuring NVM and other PATH additions are available.
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
Environment=NODE_ENV=development

StandardOutput=append:${LOG_DIR}/service.log
StandardError=append:${LOG_DIR}/service.log

[Install]
WantedBy=default.target
`;
}

/**
 * Generates the Linux wrapper script that sources the shell profile
 * before starting node, ensuring NVM/PATH are available.
 *
 * @param projectRoot - Absolute path to the Crewly project directory
 * @returns The shell script content
 */
export function generateLinuxWrapper(projectRoot: string): string {
	return `#!/bin/bash
# Crewly Backend Service wrapper for systemd
# Sources shell profile for NVM/PATH, then starts the backend.

# Source shell profile for NVM, PATH, etc.
if [ -f "$HOME/.bashrc" ]; then
  source "$HOME/.bashrc" 2>/dev/null || true
elif [ -f "$HOME/.profile" ]; then
  source "$HOME/.profile" 2>/dev/null || true
fi

export NODE_ENV="development"

CREWLY_DIR="${projectRoot}"
PIDFILE="$HOME/${CREWLY_CONSTANTS.PATHS.CREWLY_HOME}/crewly.pid"

cd "$CREWLY_DIR" || { echo "Cannot cd to $CREWLY_DIR"; exit 1; }

${NATIVE_MODULE_CHECK}

echo "$(date): Starting Crewly backend (node $(node --version))..."

# Write PID file for status checks
echo $$ > "$PIDFILE"

exec node dist/cli/cli/src/index.js start
`;
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
 * The script sources the user's shell profile (for NVM/PATH), prevents
 * duplicate instances via a PID file, and auto-restarts on crash.
 *
 * @param projectRoot - Absolute path to the Crewly project directory
 * @returns The shell script content
 */
export function generateCommandFile(projectRoot: string): string {
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

export NODE_ENV="development"

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

cd "$CREWLY_DIR" || { echo "Cannot cd to $CREWLY_DIR"; exit 1; }

echo "$(date): Starting Crewly backend (node $(node --version))..." | tee -a "$LOG_DIR/service.log"

# Run in foreground so Terminal keeps the tab open; restart on crash
while true; do
  ${NATIVE_MODULE_CHECK}

  node dist/cli/cli/src/index.js start >> "$LOG_DIR/service.log" 2>&1 &
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
 * Restarts the Crewly service by killing the node process.
 *
 * On macOS, the wrapper's `while true` loop detects the exit and
 * automatically restarts the node process after 5 seconds.
 * On Linux, uses `systemctl --user restart`.
 */
async function restartService(): Promise<void> {
	assertSupportedPlatform();

	if (process.platform === 'linux') {
		try {
			await execAsync(`systemctl --user restart ${SYSTEMD_UNIT_NAME}`);
			console.log(chalk.green('Crewly service restarted.'));
		} catch {
			console.log(chalk.red('Failed to restart service via systemctl.'));
			console.log(chalk.gray(`  Try: systemctl --user restart ${SYSTEMD_UNIT_NAME}`));
		}
		return;
	}

	// macOS: kill the node process; the wrapper loop auto-restarts in 5s
	const pid = getRunningPid();
	if (!pid) {
		console.log(chalk.yellow('Crewly service is not running.'));
		return;
	}

	try {
		process.kill(pid, 'SIGTERM');
		console.log(chalk.green(`Sent SIGTERM to node process (PID ${pid}).`));
		console.log(chalk.gray('The service wrapper will auto-restart in ~5 seconds.'));
	} catch {
		console.log(chalk.red('Failed to send signal to the process.'));
	}
}

// ===========================================================================
// Stop
// ===========================================================================

/**
 * Stops the Crewly service completely, including the restart wrapper.
 *
 * On macOS, kills both the node process and its parent bash wrapper
 * (the `while true` loop) to prevent automatic restart.
 * On Linux, uses `systemctl --user stop`.
 */
async function stopService(): Promise<void> {
	assertSupportedPlatform();

	if (process.platform === 'linux') {
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

	// Kill the node process first
	try {
		process.kill(pid, 'SIGTERM');
		console.log(chalk.green(`  Stopped node process (PID ${pid})`));
	} catch {
		console.log(chalk.gray('  Node process was already stopped'));
	}

	// Kill the parent wrapper to prevent restart
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

	// Clean up PID file
	if (fs.existsSync(PID_FILE)) {
		fs.unlinkSync(PID_FILE);
	}

	console.log(chalk.green('Crewly service stopped.'));
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
 * Finds the Crewly project root by walking up from cwd looking for
 * a package.json with `"name": "crewly"`.
 *
 * @returns Absolute path to the project root, or null if not found
 */
export function findProjectRoot(): string | null {
	let current = process.cwd();

	while (true) {
		const pkgPath = path.join(current, 'package.json');
		if (fs.existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
				if (pkg.name === 'crewly') {
					return current;
				}
			} catch {
				// Malformed package.json — keep searching
			}
		}

		const parent = path.dirname(current);
		if (parent === current) {
			return null;
		}
		current = parent;
	}
}

/**
 * Reads the PID file and verifies the process is still alive.
 *
 * @returns The PID if the process is running, or null
 */
export function getRunningPid(): number | null {
	if (!fs.existsSync(PID_FILE)) {
		return null;
	}

	try {
		const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
		if (isNaN(pid)) {
			return null;
		}

		process.kill(pid, 0);
		return pid;
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
