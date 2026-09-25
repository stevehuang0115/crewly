/**
 * Runtime Adapter Layer
 *
 * Provides a unified, pluggable interface for managing AI runtime sessions.
 * Each adapter encapsulates the full lifecycle of a specific runtime (Claude Code,
 * Gemini CLI, Codex): starting a session, writing input, reading output, and stopping.
 *
 * This replaces the need to coordinate between ISessionBackend, SessionCommandHelper,
 * and RuntimeAgentService manually — the adapter handles it all.
 *
 * @module services/runtime-adapter
 */

import { RUNTIME_TYPES, RUNTIME_COMPACT_COMMANDS, type RuntimeType } from '../constants.js';
import { RuntimeAgentService } from './agent/runtime-agent.service.abstract.js';
import { RuntimeServiceFactory } from './agent/runtime-service.factory.js';
import {
	type ISessionBackend,
	getSessionBackendSync,
	createSessionCommandHelper,
	type SessionCommandHelper,
} from './session/index.js';

// ========================= Types =========================

/**
 * Configuration for starting a new agent session via a runtime adapter.
 *
 * @example
 * ```typescript
 * const config: RuntimeAdapterConfig = {
 *   sessionName: 'dev-agent-1',
 *   projectPath: '/home/user/my-project',
 *   runtimeFlags: ['--chrome'],
 *   promptFilePath: '/tmp/prompt.md',
 * };
 * ```
 */
export interface RuntimeAdapterConfig {
	/** Unique name for the PTY session */
	sessionName: string;
	/** Working directory for the agent */
	projectPath: string;
	/** Optional CLI flags injected before --dangerously-skip-permissions */
	runtimeFlags?: string[];
	/** Optional path to a system prompt file */
	promptFilePath?: string;
	/** Optional environment variables to set in the session shell */
	env?: Record<string, string>;
}

/**
 * Unified interface for AI runtime adapters.
 *
 * Each implementation wraps a specific runtime CLI (Claude Code, Gemini CLI, Codex)
 * and provides a consistent API for managing agent sessions. Adapters handle the
 * full lifecycle: session creation, runtime initialization, I/O, and teardown.
 *
 * @example
 * ```typescript
 * const adapter = getRuntimeAdapter('claude-code');
 *
 * await adapter.start({ sessionName: 'agent-1', projectPath: '/project' });
 * await adapter.write('agent-1', 'Hello, build a REST API');
 * const output = await adapter.getOutput('agent-1');
 * await adapter.stop('agent-1');
 * ```
 */
export interface RuntimeAdapter {
	/** The runtime type this adapter handles */
	readonly runtimeType: RuntimeType;

	/** Human-readable display name for this runtime */
	readonly displayName: string;

	/**
	 * Start a new agent session.
	 *
	 * Creates a PTY session, sets environment variables, and launches the
	 * runtime CLI with the specified configuration.
	 *
	 * @param config - Session configuration
	 * @throws Error if session creation or runtime initialization fails
	 */
	start(config: RuntimeAdapterConfig): Promise<void>;

	/**
	 * Stop an agent session and clean up resources.
	 *
	 * @param sessionName - Name of the session to stop
	 * @throws Error if session does not exist
	 */
	stop(sessionName: string): Promise<void>;

	/**
	 * Write data to an agent session's stdin.
	 *
	 * @param sessionName - Name of the target session
	 * @param data - Data to write (sent via the session's shell)
	 * @throws Error if session does not exist
	 */
	write(sessionName: string, data: string): Promise<void>;

	/**
	 * Get recent output from an agent session.
	 *
	 * @param sessionName - Name of the target session
	 * @param lines - Number of recent lines to capture (default: 50)
	 * @returns Captured terminal output as a string
	 * @throws Error if session does not exist
	 */
	getOutput(sessionName: string, lines?: number): Promise<string>;

	/**
	 * Check if a session is currently running.
	 *
	 * @param sessionName - Name of the session to check
	 * @returns True if the session exists and is active
	 */
	isRunning(sessionName: string): boolean;

	/**
	 * Wait for the runtime CLI to become ready after initialization.
	 *
	 * Polls the session output for runtime-specific ready patterns.
	 *
	 * @param sessionName - Name of the session to monitor
	 * @param timeout - Maximum wait time in milliseconds (default: 60000)
	 * @returns True if runtime became ready within timeout, false otherwise
	 */
	waitForReady(sessionName: string, timeout?: number): Promise<boolean>;

	/**
	 * Detect if the runtime CLI is currently active in a session.
	 *
	 * Uses runtime-specific detection strategies (e.g., sending '/' to trigger
	 * a command palette and checking for output changes).
	 *
	 * @param sessionName - Name of the session to check
	 * @returns True if the runtime is detected as running
	 */
	detectRuntime(sessionName: string): Promise<boolean>;

	/**
	 * Trigger context window compaction for a session.
	 *
	 * Sends the runtime-specific compact/compress command to reduce context usage.
	 * Each runtime handles this differently:
	 * - Claude Code: `/compact` — LLM-based summarization
	 * - Gemini CLI: `/compress` — summarizer persona with context snapshots
	 * - Codex CLI: `/compact` — server-side opaque compaction
	 *
	 * @param sessionName - Name of the session to compact
	 * @returns True if the compact command was sent successfully
	 */
	compact(sessionName: string): Promise<boolean>;
}

// ========================= Base Adapter =========================

/**
 * Base adapter that delegates to the existing RuntimeAgentService and ISessionBackend.
 *
 * Concrete adapters extend this class and provide their runtime type.
 * The base handles all common operations — subclasses only need to override
 * behavior that differs from the default.
 */
abstract class BaseRuntimeAdapter implements RuntimeAdapter {
	abstract readonly runtimeType: RuntimeType;
	abstract readonly displayName: string;

	protected sessionBackend: ISessionBackend;
	protected sessionHelper: SessionCommandHelper;
	protected runtimeService: RuntimeAgentService;

	constructor(
		sessionBackend: ISessionBackend,
		sessionHelper: SessionCommandHelper,
		runtimeService: RuntimeAgentService,
	) {
		this.sessionBackend = sessionBackend;
		this.sessionHelper = sessionHelper;
		this.runtimeService = runtimeService;
	}

	/**
	 * Start a new agent session with the runtime CLI.
	 *
	 * Creates a PTY shell with `env` as its spawn environment, and executes the
	 * runtime initialization script.
	 *
	 * @param config - Session start configuration
	 */
	async start(config: RuntimeAdapterConfig): Promise<void> {
		const { sessionName, projectPath, runtimeFlags, promptFilePath, env } = config;

		// Create the PTY session with its environment at spawn time. Typing
		// `export`s afterwards would echo every value — including API keys —
		// into scrollback and the session log.
		await this.sessionHelper.createSession(sessionName, projectPath, env ? { env } : undefined);

		// Execute runtime-specific initialization
		await this.runtimeService.executeRuntimeInitScript(
			sessionName,
			projectPath,
			runtimeFlags,
			promptFilePath,
		);
	}

	/** @inheritdoc */
	async stop(sessionName: string): Promise<void> {
		await this.sessionBackend.killSession(sessionName);
	}

	/** @inheritdoc */
	async write(sessionName: string, data: string): Promise<void> {
		await this.sessionHelper.sendMessage(sessionName, data);
	}

	/** @inheritdoc */
	async getOutput(sessionName: string, lines?: number): Promise<string> {
		return this.sessionHelper.capturePane(sessionName, lines);
	}

	/** @inheritdoc */
	isRunning(sessionName: string): boolean {
		return this.sessionBackend.sessionExists(sessionName);
	}

	/** @inheritdoc */
	async waitForReady(sessionName: string, timeout: number = 60000): Promise<boolean> {
		return this.runtimeService.waitForRuntimeReady(sessionName, timeout);
	}

	/** @inheritdoc */
	async detectRuntime(sessionName: string): Promise<boolean> {
		return this.runtimeService.detectRuntimeWithCommand(sessionName, true);
	}

	/**
	 * Send the runtime-specific compact command to the session.
	 *
	 * @param sessionName - Name of the session to compact
	 * @returns True if the compact command was sent successfully
	 */
	async compact(sessionName: string): Promise<boolean> {
		if (!this.sessionBackend.sessionExists(sessionName)) {
			return false;
		}

		const command = RUNTIME_COMPACT_COMMANDS[this.runtimeType];
		if (!command) {
			return false;
		}

		const session = this.sessionBackend.getSession(sessionName);
		if (!session) {
			return false;
		}

		session.write(command + '\r');
		return true;
	}
}

// ========================= Concrete Adapters =========================

/**
 * Adapter for Anthropic's Claude Code CLI.
 *
 * Full implementation — Claude Code is the default runtime.
 * Handles Claude-specific initialization, detection (slash command palette),
 * and MCP configuration.
 */
export class ClaudeCodeAdapter extends BaseRuntimeAdapter {
	readonly runtimeType = RUNTIME_TYPES.CLAUDE_CODE;
	readonly displayName = 'Claude Code';

	/**
	 * Start a Claude Code session.
	 *
	 * Extends the base start with Claude-specific post-initialization
	 * (MCP server configuration).
	 *
	 * @param config - Session start configuration
	 */
	async start(config: RuntimeAdapterConfig): Promise<void> {
		await super.start(config);
		await this.runtimeService.postInitialize(config.sessionName, config.projectPath);
	}
}

/**
 * Adapter for Google's Gemini CLI.
 *
 * Stub implementation — basic structure in place for future development.
 * Uses the base adapter behavior which delegates to GeminiRuntimeService.
 */
export class GeminiCliAdapter extends BaseRuntimeAdapter {
	readonly runtimeType = RUNTIME_TYPES.GEMINI_CLI;
	readonly displayName = 'Gemini CLI';
}

/**
 * Adapter for OpenAI's Codex CLI.
 *
 * Stub implementation — basic structure in place for future development.
 * Uses the base adapter behavior which delegates to CodexRuntimeService.
 */
export class CodexAdapter extends BaseRuntimeAdapter {
	readonly runtimeType = RUNTIME_TYPES.CODEX_CLI;
	readonly displayName = 'OpenAI Codex';
}

/**
 * Adapter for the OpenCode CLI (opencode.ai, issue #306).
 *
 * Uses the base adapter behavior which delegates to OpenCodeRuntimeService.
 */
export class OpenCodeAdapter extends BaseRuntimeAdapter {
	readonly runtimeType = RUNTIME_TYPES.OPENCODE_CLI;
	readonly displayName = 'OpenCode';
}

// ========================= Factory =========================

/**
 * Creates a RuntimeAdapter for the specified runtime type.
 *
 * Uses the existing RuntimeServiceFactory and session backend to construct
 * the appropriate adapter. Requires the session backend to be initialized
 * first (via createSessionBackend()).
 *
 * @param runtimeType - The runtime type ('claude-code', 'gemini-cli', 'codex-cli', 'opencode-cli')
 * @param projectRoot - The project root directory (for runtime config resolution)
 * @returns A RuntimeAdapter instance for the specified runtime
 * @throws Error if session backend is not initialized or runtime type is unknown
 *
 * @example
 * ```typescript
 * const adapter = getRuntimeAdapter('claude-code', '/home/user/project');
 * await adapter.start({ sessionName: 'agent-1', projectPath: '/project' });
 * ```
 */
export function getRuntimeAdapter(
	runtimeType: RuntimeType,
	projectRoot: string,
): RuntimeAdapter {
	const backend = getSessionBackendSync();
	if (!backend) {
		throw new Error(
			'Session backend not initialized. Call createSessionBackend() before getRuntimeAdapter().',
		);
	}

	const sessionHelper = createSessionCommandHelper(backend);
	const runtimeService = RuntimeServiceFactory.createWithHelper(
		runtimeType,
		sessionHelper,
		projectRoot,
	);

	switch (runtimeType) {
		case RUNTIME_TYPES.CLAUDE_CODE:
			return new ClaudeCodeAdapter(backend, sessionHelper, runtimeService);

		case RUNTIME_TYPES.GEMINI_CLI:
			return new GeminiCliAdapter(backend, sessionHelper, runtimeService);

		case RUNTIME_TYPES.CODEX_CLI:
			return new CodexAdapter(backend, sessionHelper, runtimeService);

		case RUNTIME_TYPES.OPENCODE_CLI:
			return new OpenCodeAdapter(backend, sessionHelper, runtimeService);

		default: {
			// Fallback to Claude Code for unrecognized types
			const fallbackService = RuntimeServiceFactory.createWithHelper(
				RUNTIME_TYPES.CLAUDE_CODE,
				sessionHelper,
				projectRoot,
			);
			return new ClaudeCodeAdapter(backend, sessionHelper, fallbackService);
		}
	}
}

/**
 * Returns the list of all supported runtime types.
 *
 * @returns Array of RuntimeType values
 */
export function getSupportedRuntimeTypes(): RuntimeType[] {
	return RuntimeServiceFactory.getAvailableRuntimeTypes();
}

/**
 * Checks whether a given string is a supported runtime type.
 *
 * @param value - The string to check
 * @returns True if the value is a valid RuntimeType
 */
export function isSupportedRuntime(value: string): value is RuntimeType {
	return RuntimeServiceFactory.isRuntimeTypeSupported(value);
}
