import { LoggerService, ComponentLogger } from '../../core/logger.service.js';
import { estimateTokens } from './prompt-module.interface.js';

/**
 * Configuration for a context loader.
 */
export interface ContextLoaderConfig {
	/** Agent ID (session name) */
	agentId: string;
	/** Agent's role */
	role: string;
	/** Project path */
	projectPath?: string;
	/** Team ID */
	teamId?: string;
}

/**
 * Result of loading a context module.
 */
export interface ContextLoadResult {
	/** Context module name */
	name: string;
	/** Loaded content */
	content: string;
	/** Estimated token count */
	estimatedTokens: number;
	/** When this context was loaded */
	loadedAt: Date;
}

/**
 * A context loader function that retrieves dynamic data for a context module.
 */
export type ContextLoader = (config: ContextLoaderConfig) => Promise<string>;

/**
 * Default total token budget for all context modules combined.
 */
const DEFAULT_CONTEXT_BUDGET = 15000;

/**
 * Service that manages runtime context assembly for agents.
 *
 * Unlike prompt modules (static, assembled once at startup), context modules
 * contain dynamic data that can be refreshed mid-session. Context is compactable
 * by F13 ContextWindowMonitor.
 *
 * Responsibilities:
 * - Registers context loaders for different data sources
 * - Loads and assembles context on demand
 * - Supports mid-session refresh without full rebuild
 * - Enforces context token budgets
 * - Tracks loaded context for cache/refresh management
 *
 * @example
 * ```typescript
 * const contextService = new ContextAssemblyService();
 *
 * contextService.registerLoader('memory', async (config) => {
 *   const memoryService = MemoryService.getInstance();
 *   return memoryService.getFullContext(config.agentId, config.projectPath);
 * });
 *
 * const context = await contextService.loadAll({
 *   agentId: 'crewly-dev-001',
 *   role: 'developer',
 *   projectPath: '/path/to/project',
 * });
 * ```
 */
export class ContextAssemblyService {
	private logger: ComponentLogger;
	private loaders: Map<string, ContextLoader> = new Map();
	private cache: Map<string, ContextLoadResult> = new Map();
	private totalTokenBudget: number;

	constructor(tokenBudget: number = DEFAULT_CONTEXT_BUDGET) {
		this.logger = LoggerService.getInstance().createComponentLogger('ContextAssemblyService');
		this.totalTokenBudget = tokenBudget;
	}

	/**
	 * Register a context loader for a named context module.
	 *
	 * @param name - Context module name (e.g., 'memory', 'team_context')
	 * @param loader - Async function that loads context data
	 */
	registerLoader(name: string, loader: ContextLoader): void {
		this.loaders.set(name, loader);
	}

	/**
	 * Remove a registered context loader.
	 *
	 * @param name - Context module name to remove
	 */
	removeLoader(name: string): void {
		this.loaders.delete(name);
		this.cache.delete(name);
	}

	/**
	 * Get names of all registered loaders.
	 *
	 * @returns Array of registered loader names
	 */
	getLoaderNames(): string[] {
		return Array.from(this.loaders.keys());
	}

	/**
	 * Load a single context module by name.
	 *
	 * @param name - Context module name
	 * @param config - Loader configuration
	 * @param useCache - Whether to return cached result if available (default: false)
	 * @returns Context load result or null if loader not found
	 */
	async load(
		name: string,
		config: ContextLoaderConfig,
		useCache: boolean = false
	): Promise<ContextLoadResult | null> {
		if (useCache && this.cache.has(name)) {
			return this.cache.get(name) || null;
		}

		const loader = this.loaders.get(name);
		if (!loader) {
			this.logger.warn(`No context loader registered for '${name}'`);
			return null;
		}

		try {
			const content = await loader(config);
			const result: ContextLoadResult = {
				name,
				content: content || '',
				estimatedTokens: estimateTokens(content || ''),
				loadedAt: new Date(),
			};
			this.cache.set(name, result);

			this.logger.debug(`Context '${name}' loaded`, {
				agentId: config.agentId,
				tokens: result.estimatedTokens,
			});

			return result;
		} catch (error) {
			this.logger.error(`Context loader '${name}' failed`, {
				agentId: config.agentId,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	/**
	 * Load all registered context modules and assemble into a single string.
	 *
	 * @param config - Loader configuration
	 * @returns Assembled context string
	 */
	async loadAll(config: ContextLoaderConfig): Promise<string> {
		const results: ContextLoadResult[] = [];
		let totalTokens = 0;

		for (const [name, loader] of this.loaders.entries()) {
			try {
				const content = await loader(config);
				if (content && content.trim()) {
					const tokens = estimateTokens(content);

					// Skip if adding this context would exceed budget
					if (totalTokens + tokens > this.totalTokenBudget) {
						this.logger.info(`Context '${name}' skipped (budget exceeded)`, {
							agentId: config.agentId,
							currentTokens: totalTokens,
							contextTokens: tokens,
							budget: this.totalTokenBudget,
						});
						continue;
					}

					const result: ContextLoadResult = {
						name,
						content: content.trim(),
						estimatedTokens: tokens,
						loadedAt: new Date(),
					};
					results.push(result);
					this.cache.set(name, result);
					totalTokens += tokens;
				}
			} catch (error) {
				this.logger.error(`Context loader '${name}' failed`, {
					agentId: config.agentId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		this.logger.info('Context assembly complete', {
			agentId: config.agentId,
			loaderCount: results.length,
			totalTokens,
			budget: this.totalTokenBudget,
			modules: results.map((r) => r.name),
		});

		return results.map((r) => r.content).join('\n\n---\n\n');
	}

	/**
	 * Refresh a specific context module (reload from source).
	 *
	 * @param name - Context module name to refresh
	 * @param config - Loader configuration
	 * @returns Refreshed context or null
	 */
	async refresh(name: string, config: ContextLoaderConfig): Promise<ContextLoadResult | null> {
		this.cache.delete(name);
		return this.load(name, config, false);
	}

	/**
	 * Clear all cached context data.
	 */
	clearCache(): void {
		this.cache.clear();
	}

	/**
	 * Get cached context by name (without reloading).
	 *
	 * @param name - Context module name
	 * @returns Cached result or null
	 */
	getCached(name: string): ContextLoadResult | null {
		return this.cache.get(name) || null;
	}

	/**
	 * Get or set the total token budget.
	 *
	 * @param budget - Optional new budget to set
	 * @returns Current token budget
	 */
	tokenBudget(budget?: number): number {
		if (budget !== undefined) {
			this.totalTokenBudget = budget;
		}
		return this.totalTokenBudget;
	}

	/**
	 * Refresh context with a reduced budget — triggered by ContextWindowMonitorService
	 * (Feature F13) when context window usage exceeds the compaction threshold (80%).
	 *
	 * Only reloads the highest-priority loaders that fit within the reduced budget.
	 * Loaders are loaded in registration order; once budget is exhausted, remaining
	 * loaders are skipped.
	 *
	 * Integration: ContextWindowMonitorService calls this via
	 * `contextAssembly.compactRefresh(config, reducedBudget)` when usage > 80%.
	 *
	 * @param config - Loader configuration
	 * @param reducedBudget - Reduced token budget for compacted context
	 * @returns Assembled context string within reduced budget
	 */
	async compactRefresh(
		config: ContextLoaderConfig,
		reducedBudget: number
	): Promise<string> {
		const originalBudget = this.totalTokenBudget;
		this.totalTokenBudget = reducedBudget;

		this.logger.info('Compact refresh triggered', {
			agentId: config.agentId,
			originalBudget,
			reducedBudget,
		});

		// Clear cache to force fresh loads
		this.clearCache();

		const result = await this.loadAll(config);

		// Restore original budget
		this.totalTokenBudget = originalBudget;

		return result;
	}
}
