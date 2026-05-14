import { spawn, ChildProcess } from 'child_process';
import chalk from 'chalk';
import open from 'open';
import axios from 'axios';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import {
  ORCHESTRATOR_SETUP_TIMEOUT,
  DEFAULT_WEB_PORT,
  API_ENDPOINTS,
  CREWLY_HOME_DIR,
  PROCESS_EXIT_CODES,
  SERVER_CONSTANTS,
} from '../constants.js';
import { checkForUpdate, printUpdateNotification } from '../utils/version-check.js';
import { killZombieProcesses } from '../utils/process-cleanup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Finds the Crewly package root by walking up from a starting directory,
 * looking for a package.json with `"name": "crewly"`.
 *
 * Works in both dev mode (cli/src/commands/) and compiled mode (dist/cli/cli/src/commands/).
 *
 * @param startDir - Directory to start searching from.
 * @returns The absolute path to the package root directory.
 * @throws Error if no matching package.json is found.
 */
function findPackageRoot(startDir: string): string {
	let current = path.resolve(startDir);

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
			throw new Error(
				'Could not find Crewly package root (no package.json with name "crewly" found in any parent directory)'
			);
		}
		current = parent;
	}
}

interface StartOptions {
	port?: string;
	browser?: boolean;
	headless?: boolean;
	autoUpgrade?: boolean;
}

export async function startCommand(options: StartOptions) {
	const webPort = parseInt(options.port || DEFAULT_WEB_PORT.toString());
	const headless = options.headless === true;
	const openBrowser = headless ? false : options.browser !== false;

	if (headless) {
		console.log(chalk.blue('🚀 Starting Crewly in headless mode (API-only)...'));
	} else {
		console.log(chalk.blue('🚀 Starting Crewly...'));
	}
	console.log(chalk.gray(`Web Port: ${webPort}`));
	if (headless) {
		console.log(chalk.gray('Mode: headless (API-only, no frontend)'));
	}

	try {
		// 1. Ensure ~/.crewly directory exists
		await ensureCrewlyHome();

		// 2. Check if services are already running
		const alreadyRunning = await checkIfRunning(webPort);
		if (alreadyRunning) {
			console.log(chalk.yellow('⚠️  Crewly is already running'));
			if (openBrowser) {
				console.log(chalk.blue('🌐 Opening dashboard...'));
				await open(`http://localhost:${webPort}`);
			}
			return;
		}

		// 2b. Kill any zombie processes from previous runs
		killZombieProcesses(webPort, (msg) => console.log(chalk.yellow(msg)));

		// 3. Start backend server
		console.log(chalk.blue('📡 Starting backend server...'));
		const backendProcess = await startBackendServer(webPort, headless);

		// 4. Wait for servers to be ready
		console.log(chalk.blue('⏳ Waiting for servers to initialize...'));
		await waitForServer(webPort);

		// 5. Setup orchestrator session (non-blocking)
		setupOrchestratorSessionAsync(webPort);

		// 6. Open browser to dashboard immediately
		if (openBrowser) {
			console.log(chalk.blue('🌐 Opening dashboard...'));
			await open(`http://localhost:${webPort}`);
		}

		// Check if any agent skills are available (bundled or marketplace)
		const projectRoot = findPackageRoot(__dirname);
		const bundledSkillsDir = path.join(projectRoot, 'config', 'skills', 'agent');
		const marketplaceSkillsDir = path.join(os.homedir(), '.crewly', 'marketplace', 'skills');
		const hasBundledSkills = fs.existsSync(bundledSkillsDir) &&
			fs.readdirSync(bundledSkillsDir).some(d => d !== '_common' && fs.statSync(path.join(bundledSkillsDir, d)).isDirectory());
		const hasMarketplaceSkills = fs.existsSync(marketplaceSkillsDir) &&
			fs.readdirSync(marketplaceSkillsDir).some(d => d !== '_common' && fs.statSync(path.join(marketplaceSkillsDir, d)).isDirectory());

		if (!hasBundledSkills && !hasMarketplaceSkills) {
			console.log(chalk.yellow('⚠  No agent skills installed. Run \'crewly install --all\' to get started.'));
		}

		console.log(chalk.green('✅ Crewly started successfully!'));
		if (headless) {
			console.log(chalk.cyan(`📡 API: http://localhost:${webPort}/api`));
			console.log(chalk.cyan(`🏥 Health: http://localhost:${webPort}/health`));
		} else {
			console.log(chalk.cyan(`📊 Dashboard: http://localhost:${webPort}`));
		}
		console.log(chalk.cyan(`⚡ WebSocket: ws://localhost:${webPort}`));
		console.log(chalk.gray(`🎯 Orchestrator: Setting up in background...`));
		console.log('');
		console.log(chalk.yellow('Press Ctrl+C to stop all services'));

		// Non-blocking version check
		checkForUpdate().then(result => {
			if (result.updateAvailable && result.latestVersion) {
				if (options.autoUpgrade) {
					console.log(chalk.blue('Auto-upgrading Crewly...'));
					const upgradeChild = spawn('npm', ['install', '-g', 'crewly@latest'], {
						stdio: 'inherit',
						shell: true,
					});
					upgradeChild.on('exit', (code: number | null) => {
						if (code === 0) {
							console.log(chalk.green('Crewly auto-upgraded successfully! Restart to use the new version.'));
						} else {
							console.error(chalk.red('Auto-upgrade failed. Run `crewly upgrade` manually.'));
						}
					});
				} else {
					printUpdateNotification(result.currentVersion, result.latestVersion);
				}
			}
		}).catch(() => { /* silently ignore version check errors */ });

		// 7. Monitor for shutdown signals and run restart loop.
		// Use a mutable array so the shutdown handler always kills the current process.
		const activeProcesses: ChildProcess[] = [backendProcess];
		setupShutdownHandlers(activeProcesses);

		// Restart loop: respawn backend when it exits with RESTART_REQUESTED
		let currentBackend = backendProcess;
		while (true) {
			const exitCode = await waitForExit(currentBackend);

			if (exitCode === PROCESS_EXIT_CODES.RESTART_REQUESTED) {
				console.log(chalk.blue('🔄 Backend requested restart, respawning in 1.5s...'));
				// Small delay to let OS reclaim the port
				await new Promise((r) => setTimeout(r, 1500));

				currentBackend = await startBackendServer(webPort, headless);
				// Update the mutable reference so Ctrl+C kills the new process
				activeProcesses[0] = currentBackend;

				console.log(chalk.blue('⏳ Waiting for server to come back up...'));
				await waitForServer(webPort);
				console.log(chalk.green('✅ Backend restarted successfully'));
				continue;
			}

			// Non-restart exit
			console.log(chalk.yellow(`\nBackend process exited (code: ${exitCode})`));
			break;
		}

		// Backend died permanently — exit CLI
		process.exit(1);
	} catch (error) {
		console.error(
			chalk.red('❌ Failed to start Crewly:'),
			error instanceof Error ? error.message : error
		);
		process.exit(1);
	}
}

async function setupOrchestratorSession(webPort: number): Promise<void> {
	try {
		// Call the backend API to setup orchestrator session
		const response = await axios.post(
			`http://localhost:${webPort}${API_ENDPOINTS.ORCHESTRATOR_SETUP}`,
			{},
			{
				timeout: ORCHESTRATOR_SETUP_TIMEOUT
			}
		);

		if (response.data.success) {
			console.log(chalk.green('✅ Orchestrator session ready'));
		} else {
			console.log(
				chalk.yellow(
					`⚠️  Orchestrator setup warning: ${response.data.message || 'Unknown issue'}`
				)
			);
		}
	} catch (error) {
		console.log(
			chalk.yellow(
				'⚠️  Could not setup orchestrator session - it will be created when needed'
			)
		);
		console.log(
			chalk.gray(`   Error: ${error instanceof Error ? error.message : 'Unknown error'}`)
		);
	}
}

/**
 * Setup orchestrator session asynchronously (fire-and-forget)
 * This allows the browser to open immediately while orchestrator initializes in background
 */
function setupOrchestratorSessionAsync(webPort: number): void {
	// Don't await this - let it run in background
	setupOrchestratorSession(webPort)
		.then(() => {
			// Success message already logged in setupOrchestratorSession
		})
		.catch((error) => {
			// Error message already logged in setupOrchestratorSession
			// Just ensure the process doesn't crash
			console.log(chalk.gray('🎯 Orchestrator setup completed (check messages above)'));
		});
}

async function ensureCrewlyHome(): Promise<void> {
	const crewlyHome = path.join(os.homedir(), CREWLY_HOME_DIR);

	if (!fs.existsSync(crewlyHome)) {
		fs.mkdirSync(crewlyHome, { recursive: true });
		console.log(chalk.green(`📁 Created Crewly home: ${crewlyHome}`));
	}

	// Create default config if it doesn't exist
	const configPath = path.join(crewlyHome, 'config.env');
	if (!fs.existsSync(configPath)) {
		const defaultConfig = `WEB_PORT=${DEFAULT_WEB_PORT}
CREWLY_HOME=${crewlyHome}
DEFAULT_CHECK_INTERVAL=30
AUTO_COMMIT_INTERVAL=30`;
		fs.writeFileSync(configPath, defaultConfig);
		console.log(chalk.green(`⚙️  Created default config: ${configPath}`));
	}
}

async function checkIfRunning(port: number): Promise<boolean> {
	try {
		const response = await axios.get(`http://localhost:${port}/health`, { timeout: 2000 });
		return response.status === 200;
	} catch (error) {
		return false;
	}
}

/**
 * Calculate the Node.js heap size based on available system memory.
 *
 * Allocates HEAP_MEMORY_RATIO (60%) of total RAM, clamped between
 * MIN_HEAP_SIZE_MB and MAX_HEAP_SIZE_MB. Prevents OOM/swapping on
 * low-RAM machines while still allowing generous heaps on large ones.
 *
 * @returns Heap size in megabytes
 */
export function calculateHeapSize(): number {
	const totalMemMB = Math.floor(os.totalmem() / (1024 * 1024));
	const dynamicHeap = Math.floor(totalMemMB * SERVER_CONSTANTS.HEAP_MEMORY_RATIO);
	return Math.max(
		SERVER_CONSTANTS.MIN_HEAP_SIZE_MB,
		Math.min(SERVER_CONSTANTS.MAX_HEAP_SIZE_MB, dynamicHeap),
	);
}

async function startBackendServer(webPort: number, headless = false): Promise<ChildProcess> {
	// Get the project root directory — works in both dev and compiled mode
	const projectRoot = findPackageRoot(__dirname);

	const heapSize = calculateHeapSize();

	const env = {
		...process.env,
		WEB_PORT: webPort.toString(),
		NODE_ENV: process.env.NODE_ENV || 'development',
		...(headless ? { CREWLY_HEADLESS: 'true' } : {}),
	};

	const backendProcess = spawn(
		'node',
		[
			'--expose-gc',
			`--max-old-space-size=${heapSize}`,
			path.join(projectRoot, 'dist/backend/backend/src/index.js'),
		],
		{
			env,
			stdio: 'pipe',
			detached: false,
			cwd: projectRoot,
		}
	);

	backendProcess.stdout?.on('data', (data) => {
		const output = data.toString().trim();
		if (output) {
			console.log(chalk.gray(`[Backend] ${output}`));
		}
	});

	backendProcess.stderr?.on('data', (data) => {
		const output = data.toString().trim();
		if (output) {
			console.error(chalk.red(`[Backend Error] ${output}`));
		}
	});

	backendProcess.on('error', (error) => {
		console.error(chalk.red('Backend process error:'), error);
	});

	backendProcess.on('exit', (code, signal) => {
		if (code !== 0 && code !== PROCESS_EXIT_CODES.RESTART_REQUESTED) {
			console.error(
				chalk.red(`Backend process exited with code ${code} (signal: ${signal})`)
			);
		}
	});

	return backendProcess;
}

/**
 * Wait for a backend process to exit and return the exit code.
 *
 * @param proc - The child process to wait for
 * @returns The exit code (or null if killed by signal)
 */
function waitForExit(proc: ChildProcess): Promise<number | null> {
	return new Promise<number | null>((resolve) => {
		proc.on('exit', (code) => resolve(code));
	});
}

async function waitForServer(port: number, maxAttempts: number = 30): Promise<void> {
	for (let i = 0; i < maxAttempts; i++) {
		try {
			await axios.get(`http://localhost:${port}/health`, { timeout: 1000 });
			return;
		} catch (error) {
			if (i === maxAttempts - 1) {
				throw new Error('Server failed to start within timeout');
			}
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}
}

/**
 * Set up signal handlers for graceful shutdown.
 * Uses a mutable array so the restart loop can update the active process.
 *
 * The parent process must outlive its children long enough for the SIGKILL
 * escalation timer to actually fire. The previous implementation exited
 * the parent after a fixed 1s while scheduling SIGKILL at 5s — when the
 * parent exited, the timer died with it and any backend that hadn't
 * fully shut down in 1s was left as an orphan with PPID=1 still
 * consuming resources. We now await each child's 'exit' event and only
 * exit the parent once every child is gone (or 8s elapsed, whichever
 * comes first).
 *
 * Re-entry: once cleanup runs, repeated signals are ignored. Without
 * this guard, a second SIGINT during shutdown would re-run the
 * already-in-flight kill sequence and call `process.exit(0)` twice.
 *
 * @param activeProcesses - Mutable array of processes to kill on shutdown
 */
function setupShutdownHandlers(activeProcesses: ChildProcess[]): void {
	let cleaningUp = false;

	const cleanup = (): void => {
		if (cleaningUp) {
			return;
		}
		cleaningUp = true;
		console.log(chalk.yellow('\n🛑 Shutting down Crewly...'));

		const waits: Promise<void>[] = [];
		for (const proc of activeProcesses) {
			if (!proc || proc.killed || proc.exitCode !== null) {
				continue;
			}
			console.log(chalk.gray(`Stopping Backend server...`));

			waits.push(
				new Promise<void>((resolve) => {
					let settled = false;
					const done = (): void => {
						if (settled) return;
						settled = true;
						resolve();
					};

					proc.once('exit', done);

					try {
						proc.kill('SIGTERM');
					} catch {
						// Child already gone — fine.
						done();
						return;
					}

					// Escalate to SIGKILL after 5s if SIGTERM didn't take.
					const sigkillTimer = setTimeout(() => {
						if (!proc.killed && proc.exitCode === null) {
							try {
								proc.kill('SIGKILL');
							} catch {
								/* already dead */
							}
						}
					}, 5000);

					// Hard cap on the wait so parent always exits eventually.
					const hardTimer = setTimeout(() => {
						console.warn(
							chalk.red('Backend did not exit within 8s of SIGTERM; exiting parent anyway'),
						);
						done();
					}, 8000);

					proc.once('exit', () => {
						clearTimeout(sigkillTimer);
						clearTimeout(hardTimer);
					});
				}),
			);
		}

		Promise.all(waits)
			.catch(() => {
				/* individual exits resolve, never reject */
			})
			.finally(() => {
				console.log(chalk.green('✅ Crewly stopped'));
				process.exit(0);
			});
	};

	process.on('SIGTERM', cleanup);
	process.on('SIGINT', cleanup);
	process.on('SIGUSR1', cleanup);
	process.on('SIGUSR2', cleanup);
}
