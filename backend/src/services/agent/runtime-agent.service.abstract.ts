import { promises as fs, existsSync } from 'fs';
import { readFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { SessionCommandHelper } from '../session/index.js';
import { RuntimeType, ADDON_CONSTANTS } from '../../constants.js';
import { getSettingsService } from '../settings/settings.service.js';
import { safeReadJson, atomicWriteJson } from '../../utils/file-io.utils.js';
import { delay } from '../../utils/async.utils.js';
import type { AIRuntime } from '../../types/settings.types.js';

/**
 * Result of MCP configuration operation.
 * Returned by ensureMcpConfig to indicate what was configured.
 */
export interface McpConfigResult {
	/** Whether the config was written successfully */
	success: boolean;
	/** Number of new servers added */
	addedServers: number;
	/** Total servers in the final config */
	totalServers: number;
	/** Names of servers in the final config */
	serverNames: string[];
	/** Error message if success is false */
	error?: string;
}

/**
 * Runtime configuration interface
 */
export interface RuntimeConfig {
	displayName: string;
	initScript: string;
	welcomeMessage: string;
	timeout: number;
	description: string;
}

/**
 * Abstract base class for AI runtime services that handles tmux session initialization,
 * detection, and interaction patterns for different AI CLI tools.
 *
 * Uses Template Method pattern for maximum code reuse while allowing runtime-specific customization.
 */
export abstract class RuntimeAgentService {
	protected logger: ComponentLogger;
	protected sessionHelper: SessionCommandHelper;
	protected projectRoot: string;
	protected runtimeConfig: RuntimeConfig | null = null;

	// State management for detection to prevent concurrent attempts
	private detectionInProgress: Map<string, boolean> = new Map();
	private detectionResults: Map<string, { isRuntimeRunning: boolean; timestamp: number }> =
		new Map();

	constructor(sessionHelper: SessionCommandHelper, projectRoot: string) {
		this.logger = LoggerService.getInstance().createComponentLogger(`${this.constructor.name}`);
		this.sessionHelper = sessionHelper;
		this.projectRoot = projectRoot;
		this.initializeRuntimeConfig();
	}

	// Abstract methods that each concrete runtime MUST implement
	protected abstract getRuntimeType(): RuntimeType;
	protected abstract detectRuntimeSpecific(sessionName: string): Promise<boolean>;
	protected abstract getRuntimeReadyPatterns(): string[];
	protected abstract getRuntimeErrorPatterns(): string[];
	protected abstract getRuntimeExitPatterns(): RegExp[];

	/**
	 * Get patterns that indicate this runtime has exited.
	 * Used by RuntimeExitMonitorService to detect when the CLI process exits.
	 *
	 * @returns Array of RegExp patterns that match runtime exit output
	 */
	getExitPatterns(): RegExp[] {
		return this.getRuntimeExitPatterns();
	}

	/**
	 * Template method for executing runtime initialization script.
	 * Most logic is shared, only runtime-specific parts are delegated to abstract methods.
	 *
	 * @param sessionName - PTY session name
	 * @param targetPath - Working directory for the session
	 * @param runtimeFlags - Optional CLI flags to inject before --dangerously-skip-permissions
	 * @param promptFilePath - Optional path to a prompt file; for non-Claude-Code runtimes,
	 *                         appends --append-system-prompt-file flag
	 * @param agentName - Optional agent name for Claude Code --agent flag (#207)
	 */
	async executeRuntimeInitScript(sessionName: string, targetPath?: string, runtimeFlags?: string[], promptFilePath?: string, agentName?: string): Promise<void> {
		try {
			// Try to get command from user settings first, fallback to init script
			let commands: string[];
			const runtimeType = this.getRuntimeType() as AIRuntime;
			let source: string;

			try {
				const settingsService = getSettingsService();
				const settings = await settingsService.getSettings();
				const userCommand = settings.general.runtimeCommands?.[runtimeType];

				if (userCommand && userCommand.trim()) {
					commands = [userCommand.trim()];
					source = 'settings';
				} else {
					const config = this.getRuntimeConfig();
					commands = await this.loadInitScript(config.initScript);
					source = config.initScript;
				}
			} catch {
				// Settings service unavailable, fallback to init script
				const config = this.getRuntimeConfig();
				commands = await this.loadInitScript(config.initScript);
				source = config.initScript;
			}

			this.logger.info('Executing runtime initialization script', {
				sessionName,
				runtimeType: this.getRuntimeType(),
				source,
				commandCount: commands.length,
				targetPath: targetPath || process.cwd(),
			});

			// Inject runtime flags (e.g. --chrome) before --dangerously-skip-permissions
			let finalCommands = commands;
			if (runtimeFlags && runtimeFlags.length > 0) {
				const flagStr = runtimeFlags.join(' ');
				finalCommands = commands.map(cmd =>
					cmd.replace(
						/--dangerously-skip-permissions/g,
						`${flagStr} --dangerously-skip-permissions`,
					),
				);
				this.logger.info('Injected runtime flags into init commands', {
					sessionName,
					flags: flagStr,
				});
			}

			// #207: Use --agent flag for Claude Code when agentName is provided.
			// Falls back to --append-system-prompt-file for non-Claude-Code runtimes.
			if (agentName) {
				// Sanitize agentName to prevent shell injection via crafted session names
				const safeAgentName = agentName.replace(/["`$\\]/g, '');
				finalCommands = finalCommands.map(cmd => {
					if (cmd.includes('--dangerously-skip-permissions')) {
						return `${cmd} --agent "${safeAgentName}"`;
					}
					return cmd;
				});
				this.logger.info('Injected --agent flag into init commands', {
					sessionName,
					agentName,
				});
			} else if (promptFilePath) {
				finalCommands = finalCommands.map(cmd => {
					if (cmd.includes('--dangerously-skip-permissions')) {
						return `${cmd} --append-system-prompt-file "${promptFilePath}"`;
					}
					return cmd;
				});
				this.logger.info('Injected --append-system-prompt-file into init commands', {
					sessionName,
					promptFilePath,
				});
			}

			// Inject --disallowedTools for Claude Code to prevent plan mode
			// (replaces prompt-level "NEVER use plan mode" instruction to reduce PI signal)
			if (this.getRuntimeType() === 'claude-code') {
				finalCommands = finalCommands.map(cmd => {
					if (cmd.includes('--dangerously-skip-permissions') && !cmd.includes('--disallowedTools')) {
						return `${cmd} --disallowedTools EnterPlanMode,ExitPlanMode`;
					}
					return cmd;
				});
				this.logger.info('Injected --disallowedTools for plan mode prevention', { sessionName });
			}

			// #229: Suppress Gemini CLI auto-updates that kill agent mid-task
			if (this.getRuntimeType() === 'gemini-cli') {
				finalCommands = finalCommands.map(cmd =>
					cmd.startsWith('GEMINI_NO_UPDATE=') ? cmd : `GEMINI_NO_UPDATE=1 ${cmd}`
				);
				this.logger.info('Injected GEMINI_NO_UPDATE=1 to prevent auto-update kills', { sessionName });
			}

			// #234: Codex needs approval bypass for non-interactive operation.
			// #243: Removed --no-update-check — not a valid codex flag, causes startup failure.
			// #246: Do NOT inject --full-auto when -a is already present — the newer
			// Codex CLI uses `-a never` (set in default runtimeCommands) which serves
			// the same purpose. Combining both causes a startup failure.
			if (this.getRuntimeType() === 'codex-cli') {
				finalCommands = finalCommands.map(cmd => {
					if (cmd.includes('codex')) {
						// Only inject --full-auto if neither --full-auto nor -a flag is present
						const hasApprovalFlag = cmd.includes('--full-auto') || / -a /.test(cmd) || cmd.includes('--approval-mode');
						if (!hasApprovalFlag) {
							cmd = cmd.replace(/codex\b/, 'codex --full-auto');
							this.logger.info('Injected --full-auto for Codex CLI (no approval flag present)', { sessionName });
						}
					}
					return cmd;
				});
			}

			// Clear the commandline before execute
			await this.sessionHelper.clearCurrentCommandLine(sessionName);
			await this.sendShellCommandsToSession(sessionName, finalCommands, targetPath);

			this.logger.info('Runtime initialization script completed', {
				sessionName,
				runtimeType: this.getRuntimeType(),
			});
		} catch (error) {
			this.logger.error('Failed to execute runtime initialization script', {
				sessionName,
				runtimeType: this.getRuntimeType(),
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	/**
	 * Template method for detecting if runtime is running.
	 * Handles caching and concurrent access, delegates actual detection to concrete classes.
	 */
	async detectRuntimeWithCommand(
		sessionName: string,
		forceRefresh: boolean = false
	): Promise<boolean> {
		try {
			const cacheKey = `${sessionName}-${this.getRuntimeType()}`;

			// Handle cache
			if (forceRefresh) {
				this.detectionResults.delete(cacheKey);
				this.logger.debug('Cleared cached detection result due to forceRefresh', {
					sessionName,
					runtimeType: this.getRuntimeType(),
				});
			}

			if (!forceRefresh) {
				const cached = this.detectionResults.get(cacheKey);
				if (cached && Date.now() - cached.timestamp < 30000) {
					this.logger.debug('Using cached runtime detection result', {
						sessionName,
						runtimeType: this.getRuntimeType(),
						isRuntimeRunning: cached.isRuntimeRunning,
						age: Date.now() - cached.timestamp,
					});
					return cached.isRuntimeRunning;
				}
			}

			// Check if detection is already in progress
			if (this.detectionInProgress.get(cacheKey)) {
				this.logger.debug('Runtime detection already in progress, waiting for completion', {
					sessionName,
					runtimeType: this.getRuntimeType(),
				});

				let attempts = 0;
				while (this.detectionInProgress.get(cacheKey) && attempts < 30) {
					await delay(500);
					attempts++;
				}

				const result = this.detectionResults.get(cacheKey);
				if (result && Date.now() - result.timestamp < 60000) {
					return result.isRuntimeRunning;
				}
			}

			this.detectionInProgress.set(cacheKey, true);

			this.logger.debug('Starting runtime detection', {
				sessionName,
				runtimeType: this.getRuntimeType(),
				forceRefresh,
			});

			// Delegate actual detection to concrete implementation
			const isRuntimeRunning = await this.detectRuntimeSpecific(sessionName);

			// Cache the result
			this.detectionResults.set(cacheKey, {
				isRuntimeRunning,
				timestamp: Date.now(),
			});

			this.logger.debug('Runtime detection completed', {
				sessionName,
				runtimeType: this.getRuntimeType(),
				isRuntimeRunning,
			});

			return isRuntimeRunning;
		} catch (error) {
			this.logger.error('Error detecting runtime', {
				sessionName,
				runtimeType: this.getRuntimeType(),
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		} finally {
			this.detectionInProgress.set(`${sessionName}-${this.getRuntimeType()}`, false);
		}
	}

	/**
	 * Simplified method for waiting for runtime to be ready.
	 * Checks at regular intervals until timeout, looking for ready patterns in the terminal output.
	 */
	async waitForRuntimeReady(
		sessionName: string,
		timeout: number,
		checkInterval: number = 2000 // Check every 2 seconds
	): Promise<boolean> {
		const startTime = Date.now();

		this.logger.info('Waiting for runtime to be ready', {
			sessionName,
			runtimeType: this.getRuntimeType(),
			timeout,
			checkInterval,
		});

		// Keep checking until timeout
		while (Date.now() - startTime < timeout) {
			try {
				// Capture terminal output
				const output = this.sessionHelper.capturePane(sessionName);

				// Get runtime-specific ready patterns
				const readyPatterns = this.getRuntimeReadyPatterns();

				// Check if any ready pattern is found in the output
				const hasReadySignal = readyPatterns.some((pattern) => output.includes(pattern));

				if (hasReadySignal) {
					const detectedPattern = readyPatterns.find((p) => output.includes(p));
					this.logger.info('Runtime ready pattern detected', {
						sessionName,
						runtimeType: this.getRuntimeType(),
						detectedPattern,
						totalElapsed: Date.now() - startTime,
					});
					return true;
				}

				// Check for error patterns — fail fast instead of waiting for full timeout
				const errorPatterns = this.getRuntimeErrorPatterns();
				const hasError = errorPatterns.some((pattern) => output.includes(pattern));
				if (hasError) {
					const detectedError = errorPatterns.find((p) => output.includes(p));
					this.logger.error('Runtime error pattern detected during startup', {
						sessionName,
						runtimeType: this.getRuntimeType(),
						detectedError,
						totalElapsed: Date.now() - startTime,
					});
					return false;
				}
			} catch (error) {
				this.logger.warn('Error while checking runtime ready signal', {
					sessionName,
					runtimeType: this.getRuntimeType(),
					error: String(error),
				});
			}

			// Wait for next check interval
			await delay(checkInterval);
		}

		// Timeout reached - log last captured output for debugging
		try {
			const lastOutput = this.sessionHelper.capturePane(sessionName);
			const lastLines = lastOutput.split('\n').slice(-10).join('\n');
			this.logger.warn('Timeout waiting for runtime ready signal', {
				sessionName,
				runtimeType: this.getRuntimeType(),
				timeout,
				checkInterval,
				totalElapsed: Date.now() - startTime,
				lastTerminalLines: lastLines,
			});
		} catch {
			this.logger.warn('Timeout waiting for runtime ready signal', {
				sessionName,
				runtimeType: this.getRuntimeType(),
				timeout,
				checkInterval,
				totalElapsed: Date.now() - startTime,
			});
		}
		return false;
	}

	/**
	 * Hook called after the runtime is ready but before prompts are sent.
	 * Override in concrete classes for runtime-specific post-initialization steps
	 * (e.g., Gemini CLI directory allowlist additions).
	 *
	 * Default implementation is a no-op.
	 *
	 * @param sessionName - PTY session name
	 * @param targetProjectPath - Optional target project path for the agent (where MCP configs should be written).
	 *                            Falls back to this.projectRoot if not provided.
	 */
	async postInitialize(sessionName: string, targetProjectPath?: string, additionalAllowlistPaths?: string[], browserAutomationOverride?: boolean): Promise<void> {
		// No-op by default — override in concrete classes
		this.logger.debug('postInitialize (no-op)', { sessionName, runtimeType: this.getRuntimeType() });
	}

	/**
	 * Clear cached detection results for a session
	 */
	clearDetectionCache(sessionName: string): void {
		const cacheKey = `${sessionName}-${this.getRuntimeType()}`;
		this.detectionResults.delete(cacheKey);
		this.detectionInProgress.set(cacheKey, false);
		this.logger.debug('Cleared runtime detection cache', {
			sessionName,
			runtimeType: this.getRuntimeType(),
		});
	}

	/**
	 * Get runtime configuration
	 */
	getRuntimeConfiguration(): RuntimeConfig | null {
		return this.runtimeConfig;
	}

	// Protected helper methods for concrete classes to use

	/**
	 * Ensure MCP server configuration exists at the given config file path.
	 *
	 * Reads `enableBrowserAutomation` from settings, builds the required MCP servers
	 * list, reads any existing config at `configFilePath`, merge-only adds missing
	 * servers, and writes the result back via `atomicWriteJson`.
	 *
	 * Parent directories of `configFilePath` are created automatically with
	 * `fs.mkdir({ recursive: true })`.
	 *
	 * Preserves any existing user-configured MCP servers (never overwrites).
	 * Errors are non-fatal and logged as warnings.
	 *
	 * @param configFilePath - Absolute path to the MCP config JSON file
	 *                         (e.g., `/project/.mcp.json` or `/project/.gemini/settings.json`)
	 * @param projectPath - Project directory path, used only for log context
	 * @param browserAutomationOverride - Per-agent override for browser automation.
	 *                                    When provided, takes precedence over global settings.
	 *                                    `undefined` means use global setting.
	 */
	protected async ensureMcpConfig(
		configFilePath: string,
		projectPath: string,
		browserAutomationOverride?: boolean,
	): Promise<McpConfigResult> {
		try {
			// Check if browser automation is enabled
			let enableBrowserAutomation = true;
			let browserProfile = {
				headless: true,
				stealth: false,
				humanDelayMinMs: 300,
				humanDelayMaxMs: 1200,
			};
			try {
				const settingsService = getSettingsService();
				const settings = await settingsService.getSettings();
				enableBrowserAutomation = settings.skills.enableBrowserAutomation;
				if (settings.skills.browserProfile) {
					browserProfile = settings.skills.browserProfile;
				}
			} catch {
				// Settings service unavailable — default to enabled
				this.logger.warn('Could not read settings for browser automation flag, defaulting to enabled');
			}

			// Per-agent override takes precedence over global setting
			if (browserAutomationOverride !== undefined) {
				this.logger.info('Using per-agent browser automation override', {
					globalSetting: enableBrowserAutomation,
					override: browserAutomationOverride,
				});
				enableBrowserAutomation = browserAutomationOverride;
			}

			// Build required MCP servers
			const requiredServers: Record<string, { command: string; args: string[] }> = {};

			// Skip Playwright injection when Crewly Pro addon is installed
			// (Pro addon provides its own WS Browser Bridge for browser control)
			const proAddonInstalled = this.isProAddonInstalled();
			if (proAddonInstalled) {
				this.logger.info('Crewly Pro addon detected — skipping Playwright MCP injection', { projectPath });
			}

			if (enableBrowserAutomation && !proAddonInstalled) {
				const mcpPackage = browserProfile.stealth
					? '@mcp-world/playwright-mcp-world@latest'
					: '@playwright/mcp@latest';
				const args = [mcpPackage];
				if (browserProfile.headless) {
					args.push('--headless');
				}
				// Provide profile hints for MCP forks that support anti-bot options.
				if (browserProfile.stealth) {
					args.push('--stealth');
				}
				args.push('--human-delay-min', String(browserProfile.humanDelayMinMs));
				args.push('--human-delay-max', String(browserProfile.humanDelayMaxMs));

				requiredServers['playwright'] = {
					command: 'npx',
					args,
				};
			}

			// If no servers to configure, skip
			if (Object.keys(requiredServers).length === 0) {
				this.logger.info('No MCP servers to configure (browser automation disabled)', {
					runtimeType: this.getRuntimeType(),
					projectPath,
				});
				return { success: true, addedServers: 0, totalServers: 0, serverNames: [] };
			}

			// Ensure parent directory exists (handles .gemini/ and similar)
			const parentDir = path.dirname(configFilePath);
			await fs.mkdir(parentDir, { recursive: true });

			// Read existing config (preserves user config)
			const existing = await safeReadJson<Record<string, unknown>>(configFilePath, {});
			const existingMcpServers = (existing['mcpServers'] as Record<string, unknown>) || {};

			// Merge: only add servers that don't already exist (don't overwrite user config)
			let added = 0;
			for (const [name, config] of Object.entries(requiredServers)) {
				if (!existingMcpServers[name]) {
					existingMcpServers[name] = config;
					added++;
				}
			}

			// Write back merged config
			const merged = { ...existing, mcpServers: existingMcpServers };
			await atomicWriteJson(configFilePath, merged);

			const serverNames = Object.keys(existingMcpServers);

			this.logger.info('MCP config ensured', {
				runtimeType: this.getRuntimeType(),
				projectPath,
				configFilePath,
				addedServers: added,
				totalServers: serverNames.length,
				serverNames,
				enableBrowserAutomation,
				browserProfile,
			});

			return { success: true, addedServers: added, totalServers: serverNames.length, serverNames };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			// Non-fatal: agent can still work without MCP servers
			this.logger.warn('Failed to ensure MCP config (non-fatal)', {
				runtimeType: this.getRuntimeType(),
				projectPath,
				configFilePath,
				error: errorMessage,
			});
			return { success: false, addedServers: 0, totalServers: 0, serverNames: [], error: errorMessage };
		}
	}

	/**
	 * Verify MCP config file exists and contains expected servers.
	 *
	 * Reads the config file back after write and checks that the expected
	 * server names are present. Non-fatal — logs warnings on failure.
	 *
	 * @param configFilePath - Absolute path to the MCP config JSON file
	 * @param expectedServers - Server names expected to be present (e.g. ['playwright'])
	 * @returns True if all expected servers are present, false otherwise
	 */
	protected async verifyMcpConfig(configFilePath: string, expectedServers: string[]): Promise<boolean> {
		try {
			const config = await safeReadJson<Record<string, unknown>>(configFilePath, {});
			const mcpServers = (config['mcpServers'] as Record<string, unknown>) || {};
			const presentServers = Object.keys(mcpServers);
			const missing = expectedServers.filter(s => !presentServers.includes(s));

			if (missing.length > 0) {
				this.logger.warn('MCP config verification failed: missing servers', {
					configFilePath,
					expectedServers,
					presentServers,
					missing,
				});
				return false;
			}

			this.logger.info('MCP config verification passed', {
				configFilePath,
				servers: presentServers,
			});
			return true;
		} catch (error) {
			this.logger.warn('MCP config verification error (non-fatal)', {
				configFilePath,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	/**
	 * Check if the Crewly Pro addon is installed.
	 *
	 * Pro addon provides its own WS Browser Bridge, so Playwright MCP
	 * should not be injected when it is present.
	 *
	 * @returns True if crewly-pro addon manifest exists
	 */
	protected isProAddonInstalled(): boolean {
		try {
			const addonsDir = path.join(os.homedir(), '.crewly', ADDON_CONSTANTS.PATHS.ADDONS_DIR);
			const manifestPath = path.join(addonsDir, ADDON_CONSTANTS.PRO_ADDON.NAME, ADDON_CONSTANTS.MANIFEST_FILE);
			return existsSync(manifestPath);
		} catch {
			return false;
		}
	}

	/**
	 * Initialize runtime configuration from config file
	 */
	private async initializeRuntimeConfig(): Promise<void> {
		try {
			const configPath = path.join(this.projectRoot, 'config', 'runtime_scripts', 'runtime-config.json');
			const configContent = await readFile(configPath, 'utf8');
			const config = JSON.parse(configContent);

			const runtimeKey = this.getRuntimeType();
			this.runtimeConfig = config.runtimes[runtimeKey] || null;

			if (this.runtimeConfig) {
				this.logger.info('Runtime configuration loaded', {
					runtimeType: runtimeKey,
					initScript: this.runtimeConfig.initScript,
				});
			} else {
				this.logger.error('Runtime configuration not found', {
					runtimeType: runtimeKey,
					availableRuntimes: Object.keys(config.runtimes),
				});
			}
		} catch (error) {
			const isNotFound = error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
			if (isNotFound) {
				this.logger.debug('Runtime config not found, using fallback', { runtimeType: this.getRuntimeType() });
			} else {
				this.logger.error('Failed to load runtime configurations', {
					runtimeType: this.getRuntimeType(),
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/**
	 * Get runtime configuration with fallback
	 */
	protected getRuntimeConfig(): RuntimeConfig {
		if (!this.runtimeConfig) {
			this.logger.warn('Runtime config not loaded, using fallback', {
				runtimeType: this.getRuntimeType(),
			});
			return {
				displayName: this.getRuntimeType(),
				initScript: 'initialize_claude.sh', // Default fallback
				welcomeMessage: 'Welcome',
				timeout: 120000,
				description: `Default ${this.getRuntimeType()} configuration`,
			};
		}
		return this.runtimeConfig;
	}

	/**
	 * Load initialization script commands from file
	 */
	protected async loadInitScript(scriptName: string): Promise<string[]> {
		const scriptPath = path.join(this.projectRoot, 'config', 'runtime_scripts', scriptName);
		const scriptContent = await readFile(scriptPath, 'utf8');
		return scriptContent
			.trim()
			.split('\n')
			.filter((line) => {
				const trimmed = line.trim();
				return trimmed && !trimmed.startsWith('#');
			});
	}

	/**
	 * Send shell commands to session
	 */
	protected async sendShellCommandsToSession(
		sessionName: string,
		commands: string[],
		targetPath?: string
	): Promise<void> {
		// Change to target directory first
		// #222: Prefer projectRoot over process.cwd() to avoid wrong CWD
		const cdPath = targetPath || this.projectRoot || process.cwd();
		this.logger.info('Changing directory before runtime init', {
			sessionName,
			runtimeType: this.getRuntimeType(),
			cdPath,
		});

		// Send cd command (includes Enter automatically)
		await this.sessionHelper.sendMessage(sessionName, `cd "${cdPath}"`);
		await delay(500);

		// Send each command
		for (const command of commands) {
			this.logger.info('Sending command to session', {
				sessionName,
				runtimeType: this.getRuntimeType(),
				command,
			});

			// Send command (includes Enter automatically)
			await this.sessionHelper.sendMessage(sessionName, command);
			await delay(500);
		}
	}
}
