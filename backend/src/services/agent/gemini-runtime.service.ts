import { promises as fsPromises } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RuntimeAgentService } from './runtime-agent.service.abstract.js';
import { SessionCommandHelper } from '../session/index.js';
import { CREWLY_CONSTANTS, RUNTIME_TYPES, GEMINI_FAILURE_PATTERNS, type RuntimeType } from '../../constants.js';
import { delay } from '../../utils/async.utils.js';

/**
 * Gemini CLI specific runtime service implementation.
 * Handles Gemini CLI initialization, detection, and interaction patterns.
 */
export class GeminiRuntimeService extends RuntimeAgentService {
	constructor(sessionHelper: SessionCommandHelper, projectRoot: string) {
		super(sessionHelper, projectRoot);
	}

	/**
	 * Gemini CLI can show an interactive trust gate on first launch:
	 * "Do you trust this folder?".
	 * Auto-accept the default "Trust folder" option so startup does not stall.
	 */
	async waitForRuntimeReady(
		sessionName: string,
		timeout: number,
		checkInterval: number = 2000
	): Promise<boolean> {
		const startTime = Date.now();
		let trustPromptAttempts = 0;

		this.logger.info('Waiting for runtime to be ready', {
			sessionName,
			runtimeType: this.getRuntimeType(),
			timeout,
			checkInterval,
		});

		while (Date.now() - startTime < timeout) {
			try {
				const output = this.sessionHelper.capturePane(sessionName);

				if (this.isGeminiTrustPrompt(output)) {
					trustPromptAttempts++;
					this.logger.info('Gemini trust prompt detected during startup, auto-confirming', {
						sessionName,
						attempt: trustPromptAttempts,
					});

					// Always use Enter to accept the currently selected default option.
					// Typing "1" can leak into the normal input box after Gemini restarts.
					await this.sessionHelper.sendEnter(sessionName);
					await delay(1000);
					continue;
				}

				const readyPatterns = this.getRuntimeReadyPatterns();
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

			await delay(checkInterval);
		}

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

	protected getRuntimeType(): RuntimeType {
		return RUNTIME_TYPES.GEMINI_CLI;
	}

	/**
	 * Gemini CLI specific detection using '/' command
	 */
	protected async detectRuntimeSpecific(sessionName: string): Promise<boolean> {
		// Send a simple command to test if Gemini CLI is running.
		// Do NOT use clearCurrentCommandLine — it sends Ctrl+C which triggers
		// /quit at an empty Gemini CLI prompt, and Ctrl+U which is ignored.
		// Do NOT send Escape — it defocuses the Ink TUI input box permanently.

		// Capture the output before checking
		const beforeOutput = this.sessionHelper.capturePane(sessionName, 20);
		// Send the '/' key to detect changes (triggers command palette)
		await this.sessionHelper.sendKey(sessionName, '/');
		await delay(2000);

		// Capture the output after sending '/'
		const afterOutput = this.sessionHelper.capturePane(sessionName, 20);

		// Clear the '/' by sending Backspace (safe in TUI — just deletes the character)
		await this.sessionHelper.sendKey(sessionName, 'Backspace');
		await delay(500);

		const hasOutputChange = afterOutput.length - beforeOutput.length > 5;

		this.logger.debug('Gemini detection completed', {
			sessionName,
			hasOutputChange,
			beforeLength: beforeOutput.length,
			afterLength: afterOutput.length,
		});

		return hasOutputChange;
	}

	/**
	 * Gemini CLI specific ready patterns
	 */
	protected getRuntimeReadyPatterns(): string[] {
		return [
			'Type your message',
			'shell mode',
			'gemini>',
			'Ready for input',
			'Model loaded',
			'context left)',
		];
	}

	private isGeminiTrustPrompt(output: string): boolean {
		return /Do you trust this folder\?/i.test(output)
			&& /Trust folder/i.test(output);
	}

	/**
	 * Gemini CLI specific exit patterns for runtime exit detection.
	 *
	 * Includes both clean exit patterns (e.g. "Agent powering down") and
	 * failure patterns that indicate the CLI is stuck or crashed and needs
	 * recovery (e.g. API quota exhaustion, network errors).
	 *
	 * @returns Array of RegExp patterns that match runtime exit or failure output
	 */
	protected getRuntimeExitPatterns(): RegExp[] {
		return [
			// Clean exit patterns
			/Agent powering down/i,
			/Interaction Summary/,
			// Gemini CLI failure/stuck patterns — CLI may crash or become
			// unresponsive when these errors occur, requiring a restart
			...GEMINI_FAILURE_PATTERNS,
		];
	}

	/**
	 * Gemini CLI specific error patterns
	 */
	protected getRuntimeErrorPatterns(): string[] {
		const commonErrors = ['Permission denied', 'No such file or directory'];
		return [
			...commonErrors,
			'command not found: gemini',
			'API key not found',
			'Authentication failed',
			'Invalid API key',
			'Rate limit exceeded',
		];
	}

	/**
	 * Post-initialization hook for Gemini CLI.
	 * Adds ~/.crewly to the directory allowlist and ensures MCP server
	 * configuration (e.g., playwright) is present in the project directory.
	 *
	 * @param sessionName - PTY session name
	 * @param targetProjectPath - Optional target project path for MCP config.
	 *                            Falls back to this.projectRoot if not provided.
	 */
	async postInitialize(sessionName: string, targetProjectPath?: string, additionalAllowlistPaths?: string[]): Promise<void> {
		const effectiveProjectPath = targetProjectPath || this.projectRoot;
		const crewlyHome = path.join(os.homedir(), CREWLY_CONSTANTS.PATHS.CREWLY_HOME);
		this.logger.info('Gemini CLI post-init: adding paths to directory allowlist', {
			sessionName,
			crewlyHome,
			projectRoot: this.projectRoot,
			targetProjectPath: effectiveProjectPath,
			additionalPaths: additionalAllowlistPaths?.length ?? 0,
		});

		// Ensure MCP servers (e.g., playwright) are configured before the agent starts.
		// This is done before the allowlist step because it's a filesystem operation
		// that doesn't depend on the CLI being ready for interactive commands.
		await this.ensureGeminiMcpConfig(effectiveProjectPath);

		// Ensure GOOGLE_GENAI_API_KEY is in the project .env file
		await this.ensureGeminiEnvFile(effectiveProjectPath);

		// Ensure required paths are trusted by Gemini CLI before /directory add.
		// Include the system temp directory so agents can read temp files
		// (e.g. screenshots saved to /tmp by skills like rednote-reader).
		const tempDir = os.tmpdir();
		const pathsToAdd = [crewlyHome, this.projectRoot, tempDir];
		if (effectiveProjectPath !== this.projectRoot) {
			pathsToAdd.push(effectiveProjectPath);
		}

		// Merge additional paths (e.g. orchestrator's existing project paths)
		// so ALL /directory add commands run before the registration prompt.
		if (additionalAllowlistPaths?.length) {
			for (const p of additionalAllowlistPaths) {
				if (!pathsToAdd.includes(p)) {
					pathsToAdd.push(p);
				}
			}
		}

		await this.ensureGeminiTrustedFolders(pathsToAdd);

		// Wait for Gemini CLI's async auto-update check to complete before
		// sending commands. The auto-update notification (e.g., "Automatic
		// update failed") appears shortly after startup and can interfere
		// with slash command processing if we send /directory add too early.
		await delay(3000);

		const result = await this.addMultipleProjectsToAllowlist(sessionName, pathsToAdd);

		if (!result.success) {
			this.logger.warn('Failed to add paths to Gemini CLI allowlist (non-fatal)', {
				sessionName,
				results: result.results,
			});
		}

		// Do not return to caller until Gemini is back at a clean prompt.
		// Otherwise the immediate "Read the file ..." instruction can race with
		// an in-flight slash command and get concatenated in the input box.
		await this.waitForSlashQueueToDrain(sessionName);
	}

	/**
	 * Ensure Gemini CLI MCP server configuration exists in the project directory.
	 *
	 * Creates or merges `.gemini/settings.json` with required MCP servers.
	 * Delegates to the shared `ensureMcpConfig` in the base class.
	 *
	 * @param projectPath - Project directory where `.gemini/settings.json` will be created
	 */
	async ensureGeminiMcpConfig(projectPath: string): Promise<void> {
		const settingsPath = path.join(projectPath, '.gemini', 'settings.json');
		await this.ensureMcpConfig(settingsPath, projectPath);
	}

	/**
	 * Ensure the project root `.env` file contains GEMINI_API_KEY.
	 * Gemini CLI reads this key from `.env` in the working directory.
	 * If the key exists in the process environment but not in `.env`, append it.
	 * Also ensures `.gitignore` includes `.env` to prevent accidental commits.
	 *
	 * @param projectPath - Project directory where `.env` will be created/updated
	 */
	private async ensureGeminiEnvFile(projectPath: string): Promise<void> {
		const apiKey = process.env.GEMINI_API_KEY;
		if (!apiKey) {
			this.logger.debug('GEMINI_API_KEY not found in process environment, skipping .env setup');
			return;
		}

		const envPath = path.join(projectPath, '.env');
		const envLine = `GEMINI_API_KEY="${apiKey}"`;

		try {
			// Check if .env already contains the key
			let existingContent: string | null = null;
			try {
				existingContent = await fsPromises.readFile(envPath, 'utf8');
			} catch {
				// File doesn't exist yet
			}

			if (existingContent !== null) {
				if (existingContent.includes('GEMINI_API_KEY=')) {
					this.logger.debug('GEMINI_API_KEY already present in .env', { projectPath });
					return;
				}
				// Append to existing .env
				const separator = existingContent.endsWith('\n') ? '' : '\n';
				await fsPromises.appendFile(envPath, `${separator}${envLine}\n`);
			} else {
				// Create new .env
				await fsPromises.writeFile(envPath, `${envLine}\n`);
			}
			this.logger.info('Added GEMINI_API_KEY to .env', { projectPath });
		} catch (error) {
			this.logger.warn('Failed to write GEMINI_API_KEY to .env (non-fatal)', {
				projectPath,
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}

		// Ensure .gitignore includes .env
		try {
			const gitignorePath = path.join(projectPath, '.gitignore');
			let gitignoreContent: string | null = null;
			try {
				gitignoreContent = await fsPromises.readFile(gitignorePath, 'utf8');
			} catch {
				// File doesn't exist yet
			}

			if (gitignoreContent !== null) {
				if (!gitignoreContent.split('\n').some(line => line.trim() === '.env')) {
					const separator = gitignoreContent.endsWith('\n') ? '' : '\n';
					await fsPromises.appendFile(gitignorePath, `${separator}.env\n`);
					this.logger.info('Added .env to .gitignore', { projectPath });
				}
			} else {
				await fsPromises.writeFile(gitignorePath, '.env\n');
				this.logger.info('Created .gitignore with .env entry', { projectPath });
			}
		} catch (error) {
			this.logger.warn('Failed to update .gitignore (non-fatal)', {
				projectPath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Ensure Gemini trusted folders contain the required paths.
	 * Gemini blocks `/directory add` for paths that are not pre-trusted.
	 */
	private async ensureGeminiTrustedFolders(paths: string[]): Promise<void> {
		const trustedFoldersPath = path.join(os.homedir(), '.gemini', 'trustedFolders.json');
		const normalizedPaths = [...new Set(paths.map((p) => path.resolve(p)))];

		try {
			let trustedFolders: Record<string, string> = {};
			try {
				const raw = await fsPromises.readFile(trustedFoldersPath, 'utf8');
				const parsed = JSON.parse(raw);
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					trustedFolders = parsed as Record<string, string>;
				}
			} catch (readError) {
				// Missing file is expected on first run; malformed content is reset.
				if ((readError as NodeJS.ErrnoException)?.code !== 'ENOENT') {
					this.logger.warn('Failed to read Gemini trusted folders, resetting file', {
						trustedFoldersPath,
						error: readError instanceof Error ? readError.message : String(readError),
					});
				}
			}

			let changed = false;
			for (const folderPath of normalizedPaths) {
				if (trustedFolders[folderPath] !== 'TRUST_FOLDER') {
					trustedFolders[folderPath] = 'TRUST_FOLDER';
					changed = true;
				}
			}

			if (!changed) return;

			await fsPromises.mkdir(path.dirname(trustedFoldersPath), { recursive: true });
			await fsPromises.writeFile(trustedFoldersPath, `${JSON.stringify(trustedFolders, null, 2)}\n`, 'utf8');
			this.logger.info('Gemini trusted folders updated', {
				trustedFoldersPath,
				addedCount: normalizedPaths.length,
			});
		} catch (error) {
			this.logger.warn('Failed to update Gemini trusted folders (non-fatal)', {
				trustedFoldersPath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Check if Gemini CLI is installed and configured
	 */
	async checkGeminiInstallation(): Promise<{
		isInstalled: boolean;
		version?: string;
		message: string;
	}> {
		try {
			// This would check if Gemini CLI is available
			// Could run: gemini --version or similar
			return {
				isInstalled: true,
				message: 'Gemini CLI is available',
			};
		} catch (error) {
			return {
				isInstalled: false,
				message: 'Gemini CLI not found or not configured',
			};
		}
	}

	/**
	 * Initialize Gemini in an existing session
	 */
	async initializeGeminiInSession(sessionName: string): Promise<{
		success: boolean;
		message: string;
	}> {
		try {
			await this.executeRuntimeInitScript(sessionName);
			return {
				success: true,
				message: 'Gemini CLI initialized successfully',
			};
		} catch (error) {
			return {
				success: false,
				message: error instanceof Error ? error.message : 'Failed to initialize Gemini CLI',
			};
		}
	}

	/**
	 * Add a single project path to Gemini CLI allowlist
	 * Uses '/directory add' command after Gemini CLI is running
	 */
	async addProjectToAllowlist(
		sessionName: string,
		projectPath: string
	): Promise<{
		success: boolean;
		message: string;
	}> {
		const maxAttempts = 3;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				this.logger.info('Adding project to Gemini CLI allowlist', {
					sessionName,
					projectPath,
					attempt,
				});

				// Send Enter to dismiss any pending notification (e.g., "Automatic
				// update failed") that may overlay the TUI input and swallow the
				// slash command. Enter on an empty `> ` prompt is a safe no-op.
				// Do NOT send Escape (defocuses TUI permanently) or Ctrl+C
				// (triggers /quit on empty prompt).
				await this.sessionHelper.sendEnter(sessionName);
				await delay(1000);

				// Capture output before sending to verify the command was processed.
				// Use 100 lines (not 20) because Gemini CLI TUI has a fixed layout:
				// messages area at top, input box + status at bottom (~15-20 lines).
				// The "/directory add" success message appears in the upper messages
				// area via addItem(), so 20 lines only captures the unchanging bottom.
				const beforeOutput = this.sessionHelper.capturePane(sessionName, 100);
				const alreadyAllowlistedBeforeSend = this.isPathAlreadyAllowlisted(beforeOutput, projectPath);
				if (alreadyAllowlistedBeforeSend) {
					this.logger.info('Project already in Gemini CLI workspace, skipping /directory add', {
						sessionName,
						projectPath,
						attempt,
					});
					return {
						success: true,
						message: `Project path ${projectPath} is already in Gemini CLI workspace`,
					};
				}

				// Send the directory add command
				// Add a trailing space as sometimes Gemini CLI needs it to delimit the path properly
				const addCommand = `/directory add ${projectPath} `;
				await this.sessionHelper.sendMessage(sessionName, addCommand);

				// Wait for command to complete
				await delay(2000);

				// Verify: check if output changed (slash commands produce confirmation)
				const afterOutput = this.sessionHelper.capturePane(sessionName, 100);
				const outputChanged = beforeOutput !== afterOutput;
				// Do not treat the literal "/directory add ..." input text as confirmation.
				// "directory" alone is too broad and causes false positives when the
				// command is still stuck in the prompt.
				const hasConfirmation = /added|✓|success/i.test(afterOutput);
				const alreadyAllowlistedAfterSend = this.isPathAlreadyAllowlisted(afterOutput, projectPath);
				const slashQueueBlocked = /slash commands cannot be queued/i.test(afterOutput);
				const stuckAtPrompt = this.isTextLikelyStuckAtPrompt(afterOutput, addCommand);

				// Gemini CLI can drop Enter while still accepting typed text, which causes
				// subsequent commands to concatenate in the same input box. If we detect
				// that the command text is still at the prompt, press Enter again before
				// retrying so we do not append the next command to the same line.
				if (stuckAtPrompt) {
					this.logger.warn('Directory add command appears stuck at prompt, re-pressing Enter', {
						sessionName,
						projectPath,
						attempt,
					});
					await this.sessionHelper.sendEnter(sessionName);
					await delay(500);
					await this.sessionHelper.sendEnter(sessionName);
					await delay(1500);

					const recoveredOutput = this.sessionHelper.capturePane(sessionName, 100);
					const recoveredHasConfirmation = /added|✓|success/i.test(recoveredOutput);
					const recoveredAlreadyAllowlisted = this.isPathAlreadyAllowlisted(recoveredOutput, projectPath);
					const stillStuck = this.isTextLikelyStuckAtPrompt(recoveredOutput, addCommand);
					if (recoveredHasConfirmation || recoveredAlreadyAllowlisted || !stillStuck) {
						this.logger.info('Project added to Gemini CLI allowlist after Enter recovery', {
							sessionName,
							projectPath,
							attempt,
							recoveredHasConfirmation,
							recoveredAlreadyAllowlisted,
						});
						return {
							success: true,
							message: `Project path ${projectPath} added to Gemini CLI allowlist`,
						};
					}
				}

				// Gemini can report queue contention when commands are fired too quickly.
				// Treat this as a hard retry signal and do not mark success.
				if (slashQueueBlocked) {
					this.logger.warn('Gemini CLI slash command queue is busy, retrying /directory add', {
						sessionName,
						projectPath,
						attempt,
					});
					await delay(2000);
					continue;
				}

				// Only accept explicit confirmation signals. Generic output changes
				// are too noisy in Gemini's TUI and can produce false positives.
				if ((hasConfirmation || alreadyAllowlistedAfterSend) && !stuckAtPrompt) {
					this.logger.info('Project added to Gemini CLI allowlist (verified)', {
						sessionName,
						projectPath,
						attempt,
						hasConfirmation,
						alreadyAllowlistedAfterSend,
					});
					return {
						success: true,
						message: `Project path ${projectPath} added to Gemini CLI allowlist`,
					};
				}

				this.logger.warn('Directory add command may not have been processed, retrying', {
					sessionName,
					projectPath,
					attempt,
					outputChanged,
				});

				// Wait before retry to let any notification/overlay clear
				await delay(2000);
			} catch (error) {
				this.logger.error('Failed to add project to Gemini CLI allowlist', {
					sessionName,
					projectPath,
					attempt,
					error: error instanceof Error ? error.message : String(error),
				});

				if (attempt === maxAttempts) {
					return {
						success: false,
						message: `Failed to add project path to allowlist: ${
							error instanceof Error ? error.message : String(error)
						}`,
					};
				}
			}
		}

		return {
			success: false,
			message: `Failed to add project path to allowlist after ${maxAttempts} attempts`,
		};
	}

	/**
	 * Heuristic to detect text that is still sitting in Gemini's input box.
	 * This indicates the message was typed but Enter was not processed.
	 */
	private isTextLikelyStuckAtPrompt(terminalOutput: string, message: string): boolean {
		if (!terminalOutput || !message) return false;
		const snippet = message.replace(/\s+/g, ' ').trim();
		if (!snippet) return false;
		const bottomText = terminalOutput
			.split('\n')
			.slice(-15)
			.join(' ')
			.replace(/\s+/g, ' ')
			.trim();
		return bottomText.includes(snippet);
	}

	/**
	 * Detect whether Gemini CLI output indicates a path is already allowlisted.
	 */
	private isPathAlreadyAllowlisted(terminalOutput: string, projectPath: string): boolean {
		if (!terminalOutput || !projectPath) return false;
		const normalizedOutput = terminalOutput.replace(/\s+/g, ' ');
		const normalizedPath = projectPath.replace(/\s+/g, ' ');
		const hasAlreadyMarker = /already in (the )?workspace|already added|already allowed/i.test(normalizedOutput);
		return hasAlreadyMarker && normalizedOutput.includes(normalizedPath);
	}

	/**
	 * Add multiple project paths to Gemini CLI allowlist
	 * Attempts a single batched slash command first, then falls back to
	 * per-path commands for resiliency.
	 */
	async addMultipleProjectsToAllowlist(
		sessionName: string,
		projectPaths: string[]
	): Promise<{
		success: boolean;
		message: string;
		results: Array<{ path: string; success: boolean; error?: string }>;
	}> {
		const uniqueProjectPaths = [...new Set(projectPaths)];
		const results: Array<{ path: string; success: boolean; error?: string }> = [];
		let successCount = 0;

		this.logger.info('Adding multiple projects to Gemini CLI allowlist', {
			sessionName,
			projectCount: uniqueProjectPaths.length,
			projectPaths: uniqueProjectPaths,
		});

		// Fast path: Gemini CLI supports `/directory add path1,path2,...`.
		// Use this first to avoid queueing many slash commands back-to-back.
		if (uniqueProjectPaths.length > 1) {
			const batchResult = await this.addProjectsToAllowlistBatch(sessionName, uniqueProjectPaths);
			if (batchResult.success) {
				for (const projectPath of uniqueProjectPaths) {
					results.push({ path: projectPath, success: true });
				}
				successCount = uniqueProjectPaths.length;

				this.logger.info('Completed adding multiple projects via batch command', {
					sessionName,
					totalProjects: uniqueProjectPaths.length,
				});

				return {
					success: true,
					message: `Added ${successCount}/${uniqueProjectPaths.length} projects to Gemini CLI allowlist`,
					results,
				};
			}

			this.logger.warn('Batch /directory add failed, falling back to per-path commands', {
				sessionName,
				reason: batchResult.message,
			});
		}

		for (const projectPath of uniqueProjectPaths) {
			try {
				const result = await this.addProjectToAllowlist(sessionName, projectPath);
				if (result.success) {
					successCount++;
					results.push({ path: projectPath, success: true });
				} else {
					results.push({
						path: projectPath,
						success: false,
						error: result.message,
					});
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				results.push({
					path: projectPath,
					success: false,
					error: errorMessage,
				});
			}

			// Keep spacing between slash commands to reduce queue contention in Gemini CLI.
			await delay(1500);
		}

		const message = `Added ${successCount}/${uniqueProjectPaths.length} projects to Gemini CLI allowlist`;

		this.logger.info('Completed adding multiple projects to Gemini CLI allowlist', {
			sessionName,
			totalProjects: uniqueProjectPaths.length,
			successCount,
			failureCount: uniqueProjectPaths.length - successCount,
		});

		return {
			success: successCount > 0,
			message,
			results,
		};
	}

	/**
	 * Send a single batched `/directory add` command with comma-separated paths.
	 */
	private async addProjectsToAllowlistBatch(
		sessionName: string,
		projectPaths: string[]
	): Promise<{ success: boolean; message: string }> {
		const maxAttempts = 2;
		const commandPayload = projectPaths.join(',');
		const batchCommand = `/directory add ${commandPayload} `;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				await this.sessionHelper.sendEnter(sessionName);
				await delay(1000);

				const beforeOutput = this.sessionHelper.capturePane(sessionName, 120);
				const allAlreadyPresent = projectPaths.every((p) =>
					this.isPathAlreadyAllowlisted(beforeOutput, p)
				);
				if (allAlreadyPresent) {
					return {
						success: true,
						message: 'All paths are already in Gemini CLI workspace',
					};
				}

				await this.sessionHelper.sendMessage(sessionName, batchCommand);
				await delay(2500);

				const afterOutput = this.sessionHelper.capturePane(sessionName, 120);
				const hasQueueWarning = /slash commands cannot be queued/i.test(afterOutput);
				const stuckAtPrompt = this.isTextLikelyStuckAtPrompt(afterOutput, batchCommand);
				const hasConfirmation = /added|✓|success/i.test(afterOutput);
				const allPresentAfter = projectPaths.every((p) =>
					this.isPathAlreadyAllowlisted(afterOutput, p)
				);

				if (hasQueueWarning) {
					await delay(2000);
					continue;
				}

				if (stuckAtPrompt) {
					await this.sessionHelper.sendEnter(sessionName);
					await delay(500);
					await this.sessionHelper.sendEnter(sessionName);
					await delay(1500);

					const recoveredOutput = this.sessionHelper.capturePane(sessionName, 120);
					const recoveredConfirmation = /added|✓|success/i.test(recoveredOutput);
					const recoveredAllPresent = projectPaths.every((p) =>
						this.isPathAlreadyAllowlisted(recoveredOutput, p)
					);
					const stillStuck = this.isTextLikelyStuckAtPrompt(recoveredOutput, batchCommand);

					if ((recoveredConfirmation || recoveredAllPresent) && !stillStuck) {
						return { success: true, message: 'Batch directory add command succeeded' };
					}
				}

				if ((hasConfirmation || allPresentAfter) && !stuckAtPrompt) {
					return { success: true, message: 'Batch directory add command succeeded' };
				}
			} catch (error) {
				if (attempt === maxAttempts) {
					return {
						success: false,
						message: error instanceof Error ? error.message : String(error),
					};
				}
			}
		}

		return {
			success: false,
			message: 'Batch directory add command not confirmed',
		};
	}

	/**
	 * Wait until Gemini's slash-command queue is idle and the prompt is ready
	 * for normal text input.
	 */
	private async waitForSlashQueueToDrain(sessionName: string): Promise<void> {
		const maxChecks = 8;
		for (let check = 1; check <= maxChecks; check++) {
			const output = this.sessionHelper.capturePane(sessionName, 120);
			const hasQueueWarning = /slash commands cannot be queued/i.test(output);
			const hasReadyPrompt = this.getRuntimeReadyPatterns().some((pattern) => output.includes(pattern));
			const addCommandStuck = this.isTextLikelyStuckAtPrompt(output, '/directory add');

			if (hasReadyPrompt && !hasQueueWarning && !addCommandStuck) {
				this.logger.debug('Gemini slash command queue appears idle', {
					sessionName,
					check,
				});
				return;
			}

			// If command text still sits in the input box, submit/clear it so the
			// next non-slash instruction is not appended to the same line.
			if (addCommandStuck || hasQueueWarning) {
				this.logger.debug('Gemini slash queue not idle yet, nudging prompt with Enter', {
					sessionName,
					check,
					hasQueueWarning,
					addCommandStuck,
				});
				await this.sessionHelper.sendEnter(sessionName);
			}

			await delay(1000);
		}

		this.logger.warn('Timed out waiting for Gemini slash queue to drain (continuing anyway)', {
			sessionName,
		});
	}
}
