import { LoggerService, ComponentLogger } from '../../core/logger.service.js';
import {
	PromptModule,
	ModuleConfig,
	ModuleBuildResult,
	estimateTokens,
} from './prompt-module.interface.js';
import { IdentityModule } from './identity.module.js';
import { SkillsReferenceModule } from './skills-reference.module.js';
import { MemoryReferenceModule } from './memory-reference.module.js';
import { TeamReferenceModule } from './team-reference.module.js';
import { ProjectReferenceModule } from './project-reference.module.js';

/**
 * Default total token budget for all prompt modules combined.
 * Modules exceeding this budget are skipped (compactable ones only).
 */
const DEFAULT_TOKEN_BUDGET = 25000;

/**
 * Separator between prompt modules in assembled output.
 */
const MODULE_SEPARATOR = '\n\n---\n\n';

/**
 * Service that orchestrates the assembly of prompt modules into a complete agent prompt.
 *
 * Responsibilities:
 * - Registers and manages prompt modules
 * - Assembles modules in priority order
 * - Enforces per-module and total token budgets
 * - Supports Trusted Zone (non-compactable) vs Flexible Zone (compactable) modules
 * - Works across all runtime types (claude-code, gemini-cli, crewly-agent)
 *
 * @example
 * ```typescript
 * const assembler = new PromptAssemblyService();
 * const prompt = await assembler.assemble({
 *   sessionName: 'crewly-dev-001',
 *   memberId: 'uuid-123',
 *   role: 'developer',
 *   projectPath: '/path/to/project',
 *   agentSkillsPath: '/path/to/skills/agent',
 *   tlSkillsPath: '/path/to/skills/team-leader',
 *   projectRoot: '/path/to/project',
 * });
 * ```
 */
export class PromptAssemblyService {
	private logger: ComponentLogger;
	private modules: PromptModule[] = [];
	private totalTokenBudget: number;

	constructor(tokenBudget: number = DEFAULT_TOKEN_BUDGET) {
		this.logger = LoggerService.getInstance().createComponentLogger('PromptAssemblyService');
		this.totalTokenBudget = tokenBudget;
		this.registerDefaultModules();
	}

	/**
	 * Register the default set of prompt modules.
	 * Called automatically in constructor. Additional modules
	 * can be added via addModule().
	 */
	private registerDefaultModules(): void {
		this.modules = [
			new IdentityModule(),
			new MemoryReferenceModule(),
			new SkillsReferenceModule(),
			new TeamReferenceModule(),
			new ProjectReferenceModule(),
		];
	}

	/**
	 * Add a custom prompt module to the assembly pipeline.
	 *
	 * @param module - Module to add
	 */
	addModule(module: PromptModule): void {
		this.modules.push(module);
	}

	/**
	 * Remove a module by name.
	 *
	 * @param name - Name of the module to remove
	 */
	removeModule(name: string): void {
		this.modules = this.modules.filter((m) => m.name !== name);
	}

	/**
	 * Get all registered modules (for inspection/testing).
	 *
	 * @returns Array of registered prompt modules
	 */
	getModules(): PromptModule[] {
		return [...this.modules];
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
	 * Assemble all applicable prompt modules into a single prompt string.
	 *
	 * Modules are processed in priority order (lowest number first).
	 * Non-compactable modules are always included (Trusted Zone).
	 * Compactable modules are skipped if the token budget is exceeded (Flexible Zone).
	 *
	 * @param config - Configuration with all context needed by modules
	 * @returns Assembled prompt string with all module sections
	 */
	async assemble(config: ModuleConfig): Promise<string> {
		const results: ModuleBuildResult[] = [];
		let totalTokens = 0;

		// Sort modules by priority (ascending — lower number = higher priority)
		const sorted = [...this.modules].sort((a, b) => a.priority - b.priority);

		for (const module of sorted) {
			// Check if module should be included
			if (!module.shouldInclude(config)) {
				this.logger.debug(`Module '${module.name}' skipped (shouldInclude=false)`, {
					sessionName: config.sessionName,
				});
				continue;
			}

			// Check token budget for compactable modules
			if (module.compactable && totalTokens + module.maxTokens > this.totalTokenBudget) {
				this.logger.info(`Module '${module.name}' skipped (token budget exceeded)`, {
					sessionName: config.sessionName,
					currentTokens: totalTokens,
					moduleMaxTokens: module.maxTokens,
					budget: this.totalTokenBudget,
				});
				continue;
			}

			try {
				const content = await module.build(config);
				if (content && content.trim()) {
					const tokens = estimateTokens(content);
					results.push({
						name: module.name,
						content: content.trim(),
						estimatedTokens: tokens,
					});
					totalTokens += tokens;

					this.logger.debug(`Module '${module.name}' built`, {
						sessionName: config.sessionName,
						tokens,
						totalTokens,
					});
				}
			} catch (error) {
				this.logger.error(`Module '${module.name}' failed to build`, {
					sessionName: config.sessionName,
					error: error instanceof Error ? error.message : String(error),
				});
				// Non-compactable modules failing is critical
				if (!module.compactable) {
					throw error;
				}
				// Compactable modules failing is logged but not fatal
			}
		}

		this.logger.info('Prompt assembly complete', {
			sessionName: config.sessionName,
			moduleCount: results.length,
			totalTokens,
			budget: this.totalTokenBudget,
			modules: results.map((r) => r.name),
		});

		return results.map((r) => r.content).join(MODULE_SEPARATOR);
	}

	/**
	 * Assemble modules and return detailed results with per-module metadata.
	 * Useful for debugging and token budget analysis.
	 *
	 * @param config - Configuration with all context needed by modules
	 * @returns Array of module build results with token estimates
	 */
	async assembleWithDetails(config: ModuleConfig): Promise<{
		prompt: string;
		modules: ModuleBuildResult[];
		totalTokens: number;
	}> {
		const results: ModuleBuildResult[] = [];
		let totalTokens = 0;

		const sorted = [...this.modules].sort((a, b) => a.priority - b.priority);

		for (const module of sorted) {
			if (!module.shouldInclude(config)) continue;

			if (module.compactable && totalTokens + module.maxTokens > this.totalTokenBudget) {
				continue;
			}

			try {
				const content = await module.build(config);
				if (content && content.trim()) {
					const tokens = estimateTokens(content);
					results.push({
						name: module.name,
						content: content.trim(),
						estimatedTokens: tokens,
					});
					totalTokens += tokens;
				}
			} catch (error) {
				if (!module.compactable) throw error;
			}
		}

		return {
			prompt: results.map((r) => r.content).join(MODULE_SEPARATOR),
			modules: results,
			totalTokens,
		};
	}
}
