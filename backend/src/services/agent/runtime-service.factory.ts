import { RuntimeAgentService } from './runtime-agent.service.abstract.js';
import { ClaudeRuntimeService } from './claude-runtime.service.js';
import { GeminiRuntimeService } from './gemini-runtime.service.js';
import { CodexRuntimeService } from './codex-runtime.service.js';
import { CrewlyAgentExternalRuntimeService } from './crewly-agent/crewly-agent-external-runtime.service.js';
import {
	SessionCommandHelper,
	createSessionCommandHelper,
	getSessionBackendSync,
	createSessionBackend,
	type ISessionBackend,
} from '../session/index.js';
import { RUNTIME_TYPES, type RuntimeType } from '../../constants.js';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';

/**
 * Factory for creating runtime-specific service instances.
 * Implements factory pattern to encapsulate runtime service creation logic.
 */
export class RuntimeServiceFactory {
	// Cache instances to avoid creating multiple services for the same runtime type
	private static instanceCache: Map<string, RuntimeAgentService> = new Map();
	// Cache the session helper to reuse across runtime service creations
	private static sessionHelperCache: SessionCommandHelper | null = null;
	// Logger for the factory
	private static logger: ComponentLogger = LoggerService.getInstance().createComponentLogger('RuntimeServiceFactory');

	/**
	 * Get or create a SessionCommandHelper, using lazy initialization.
	 * This is the recommended way to get the helper for runtime service creation.
	 */
	private static getOrCreateSessionHelper(): SessionCommandHelper {
		if (this.sessionHelperCache) {
			return this.sessionHelperCache;
		}

		// Try to get existing backend first
		let backend = getSessionBackendSync();
		if (!backend) {
			// This shouldn't happen in normal operation as backend should be initialized
			// Throw an error to indicate initialization problem
			throw new Error(
				'Session backend not initialized. Call createSessionBackend() first.'
			);
		}

		this.sessionHelperCache = createSessionCommandHelper(backend);
		return this.sessionHelperCache;
	}

	/**
	 * Create a runtime service instance for the specified runtime type.
	 * Automatically gets or creates the SessionCommandHelper.
	 *
	 * @param runtimeType - The type of runtime to create
	 * @param _legacyParam - Ignored legacy parameter for backwards compatibility
	 * @param projectRoot - The project root directory
	 */
	static create(
		runtimeType: RuntimeType,
		_legacyParam: unknown,
		projectRoot: string
	): RuntimeAgentService {
		// Get the session helper (ignoring legacy parameter)
		const sessionHelper = this.getOrCreateSessionHelper();

		// Create a cache key that includes all constructor parameters
		const cacheKey = `${runtimeType}-${projectRoot}`;

		// Return cached instance if available
		if (this.instanceCache.has(cacheKey)) {
			const cachedInstance = this.instanceCache.get(cacheKey)!;
			return cachedInstance;
		}

		// Create new instance based on runtime type
		let runtimeService: RuntimeAgentService;

		switch (runtimeType) {
			case RUNTIME_TYPES.CLAUDE_CODE:
				runtimeService = new ClaudeRuntimeService(sessionHelper, projectRoot);
				break;

			case RUNTIME_TYPES.GEMINI_CLI:
				runtimeService = new GeminiRuntimeService(sessionHelper, projectRoot);
				break;

			case RUNTIME_TYPES.CODEX_CLI:
				runtimeService = new CodexRuntimeService(sessionHelper, projectRoot);
				break;

			case RUNTIME_TYPES.CREWLY_AGENT:
				runtimeService = new CrewlyAgentExternalRuntimeService(sessionHelper, projectRoot);
				break;

			default:
				// Fallback to Claude Code for unknown runtime types
				this.logger.warn('Unknown runtime type, falling back to Claude Code', { runtimeType });
				runtimeService = new ClaudeRuntimeService(sessionHelper, projectRoot);
				break;
		}

		// Cache the instance
		this.instanceCache.set(cacheKey, runtimeService);

		return runtimeService;
	}

	/**
	 * Create a runtime service without caching (for testing or special cases).
	 * Automatically gets or creates the SessionCommandHelper.
	 *
	 * @param runtimeType - The type of runtime to create
	 * @param _legacyParam - Ignored legacy parameter for backwards compatibility
	 * @param projectRoot - The project root directory
	 */
	static createFresh(
		runtimeType: RuntimeType,
		_legacyParam: unknown,
		projectRoot: string
	): RuntimeAgentService {
		const sessionHelper = this.getOrCreateSessionHelper();

		switch (runtimeType) {
			case RUNTIME_TYPES.CLAUDE_CODE:
				return new ClaudeRuntimeService(sessionHelper, projectRoot);

			case RUNTIME_TYPES.GEMINI_CLI:
				return new GeminiRuntimeService(sessionHelper, projectRoot);

			case RUNTIME_TYPES.CODEX_CLI:
				return new CodexRuntimeService(sessionHelper, projectRoot);

			case RUNTIME_TYPES.CREWLY_AGENT:
				return new CrewlyAgentExternalRuntimeService(sessionHelper, projectRoot);

			default:
				// Fallback to Claude Code for unknown runtime types
				this.logger.warn('Unknown runtime type, falling back to Claude Code', { runtimeType });
				return new ClaudeRuntimeService(sessionHelper, projectRoot);
		}
	}

	/**
	 * Get available runtime types
	 */
	static getAvailableRuntimeTypes(): RuntimeType[] {
		return [
			RUNTIME_TYPES.CLAUDE_CODE,
			RUNTIME_TYPES.GEMINI_CLI,
			RUNTIME_TYPES.CODEX_CLI,
			RUNTIME_TYPES.CREWLY_AGENT,
		];
	}

	/**
	 * Clear cached instances (useful for testing or when configuration changes)
	 */
	static clearCache(): void {
		this.instanceCache.clear();
		this.sessionHelperCache = null;
	}

	/**
	 * Clear cached instance for a specific runtime type and project
	 */
	static clearCacheFor(runtimeType: RuntimeType, projectRoot: string): void {
		const cacheKey = `${runtimeType}-${projectRoot}`;
		this.instanceCache.delete(cacheKey);
	}

	/**
	 * Get cached instance count (useful for debugging/monitoring)
	 */
	static getCachedInstanceCount(): number {
		return this.instanceCache.size;
	}

	/**
	 * Check if a runtime type is supported
	 */
	static isRuntimeTypeSupported(runtimeType: string): runtimeType is RuntimeType {
		return this.getAvailableRuntimeTypes().includes(runtimeType as RuntimeType);
	}

	/**
	 * Set a custom session helper for testing purposes.
	 * This allows injecting a mock SessionCommandHelper.
	 *
	 * @param sessionHelper - The session helper to use
	 */
	static setSessionHelperForTesting(sessionHelper: SessionCommandHelper | null): void {
		this.sessionHelperCache = sessionHelper;
	}

	/**
	 * Create a runtime service with an explicit session helper (for testing).
	 *
	 * @param runtimeType - The type of runtime to create
	 * @param sessionHelper - The session helper to use
	 * @param projectRoot - The project root directory
	 */
	static createWithHelper(
		runtimeType: RuntimeType,
		sessionHelper: SessionCommandHelper,
		projectRoot: string
	): RuntimeAgentService {
		switch (runtimeType) {
			case RUNTIME_TYPES.CLAUDE_CODE:
				return new ClaudeRuntimeService(sessionHelper, projectRoot);

			case RUNTIME_TYPES.GEMINI_CLI:
				return new GeminiRuntimeService(sessionHelper, projectRoot);

			case RUNTIME_TYPES.CODEX_CLI:
				return new CodexRuntimeService(sessionHelper, projectRoot);

			case RUNTIME_TYPES.CREWLY_AGENT:
				return new CrewlyAgentExternalRuntimeService(sessionHelper, projectRoot);

			default:
				this.logger.warn('Unknown runtime type, falling back to Claude Code', { runtimeType });
				return new ClaudeRuntimeService(sessionHelper, projectRoot);
		}
	}
}