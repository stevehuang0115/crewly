/**
 * Crewly Upgrade Command
 *
 * Provides a convenient way to check for and install the latest version
 * of Crewly from npm. Supports a --check flag for dry-run inspection
 * and --pro flag for installing Pro addon from a local tarball.
 *
 * @module cli/commands/upgrade
 */

import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';
import { checkForUpdate, printUpdateNotification } from '../utils/version-check.js';
import { ADDON_CONSTANTS } from '../../../config/constants.js';

/**
 * Options for the upgrade command
 */
interface UpgradeOptions {
	/** When true, only check for updates without installing */
	check?: boolean;
	/** When true, install the Pro addon instead of upgrading core */
	pro?: boolean;
	/** Cloud API token for downloading Pro addon */
	token?: string;
	/** Local path to a .tar.gz addon file */
	source?: string;
}

/**
 * Parsed manifest.json from a Pro addon package
 */
interface AddonManifest {
	/** Addon display name */
	name: string;
	/** Semantic version string */
	version: string;
}

/**
 * Resolves the path to the crewly home directory (~/.crewly)
 *
 * @returns Absolute path to ~/.crewly
 */
function getCrewlyHome(): string {
	return join(homedir(), '.crewly');
}

/**
 * Installs the Pro addon from a local tarball.
 *
 * Extracts the tarball into ~/.crewly/addons/crewly-pro/ and verifies
 * that a valid manifest.json exists in the extracted output.
 *
 * @param tarballPath - Absolute path to the .tar.gz file
 * @throws Error if tarball does not exist, extraction fails, or manifest is missing
 */
export async function installProAddon(tarballPath: string): Promise<void> {
	if (!existsSync(tarballPath)) {
		console.error(chalk.red(`Tarball not found: ${tarballPath}`));
		process.exit(1);
	}

	const crewlyHome = getCrewlyHome();
	const addonsDir = join(crewlyHome, ADDON_CONSTANTS.PATHS.ADDONS_DIR);
	const addonDir = join(addonsDir, ADDON_CONSTANTS.PRO_ADDON.NAME);

	// Create addons directory if it doesn't exist
	mkdirSync(addonDir, { recursive: true });

	console.log(chalk.blue(`Extracting Pro addon from ${tarballPath}...`));

	try {
		execSync(`tar xzf "${tarballPath}" -C "${addonDir}"`, { stdio: 'pipe' });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		console.error(chalk.red(`Failed to extract tarball: ${message}`));
		process.exit(1);
	}

	// Verify manifest exists
	const manifestPath = join(addonDir, ADDON_CONSTANTS.MANIFEST_FILE);
	if (!existsSync(manifestPath)) {
		console.error(chalk.red(`Invalid addon: ${ADDON_CONSTANTS.MANIFEST_FILE} not found in extracted files.`));
		process.exit(1);
	}

	// Read and display manifest info
	const manifest: AddonManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
	console.log(chalk.green(`Pro addon installed successfully: ${manifest.name} v${manifest.version}`));
}

/**
 * Runs the upgrade command.
 *
 * With --check: queries npm for the latest version and prints the result.
 * With --pro: installs the Pro addon from a local tarball or Cloud API.
 * Without flags: runs `npm install -g crewly@latest` to upgrade in place.
 *
 * @param options - Command options
 */
export async function upgradeCommand(options: UpgradeOptions): Promise<void> {
	if (options.check) {
		console.log(chalk.blue('Checking for updates...'));

		const result = await checkForUpdate();

		if (result.updateAvailable && result.latestVersion) {
			printUpdateNotification(result.currentVersion, result.latestVersion);
		} else if (result.latestVersion) {
			console.log(chalk.green(`You are on the latest version (v${result.currentVersion}).`));
		} else {
			console.log(chalk.yellow('Unable to check for updates. Please try again later.'));
		}
		return;
	}

	if (options.pro) {
		await handleProUpgrade(options);
		return;
	}

	console.log(chalk.blue('Upgrading Crewly to the latest version...'));

	const child = spawn('npm', ['install', '-g', 'crewly@latest'], {
		stdio: 'inherit',
		shell: true,
	});

	child.on('error', (error) => {
		console.error(chalk.red('Failed to start upgrade process:'), error.message);
		process.exit(1);
	});

	child.on('exit', (code) => {
		if (code === 0) {
			console.log(chalk.green('Crewly upgraded successfully!'));
		} else {
			console.error(
				chalk.red('Upgrade failed. Try running manually: npm install -g crewly@latest')
			);
			process.exit(code ?? 1);
		}
	});
}

/**
 * Handles the --pro upgrade flow.
 *
 * Resolves the tarball source in priority order:
 * 1. If --token provided, log that Cloud API is not yet available and fall back to local
 * 2. If --source provided, use that path directly
 * 3. Otherwise, look for default tarball at ~/.crewly/downloads/crewly-pro.tar.gz
 *
 * @param options - Command options containing pro, token, and source fields
 */
async function handleProUpgrade(options: UpgradeOptions): Promise<void> {
	if (options.token) {
		console.log(chalk.yellow('Cloud API download is not yet available. Falling back to local installation.'));
	}

	let tarballPath: string;

	if (options.source) {
		tarballPath = options.source;
	} else {
		const crewlyHome = getCrewlyHome();
		tarballPath = join(
			crewlyHome,
			ADDON_CONSTANTS.PATHS.DOWNLOADS_DIR,
			ADDON_CONSTANTS.PRO_ADDON.DEFAULT_TARBALL
		);
		console.log(chalk.blue(`Looking for default tarball at ${tarballPath}`));
	}

	await installProAddon(tarballPath);
}
