import { LoggerService, ComponentLogger } from '../../core/logger.service.js';
import {
	PromptModule,
	ModuleConfig,
	ModuleBuildResult,
	AssemblyReport,
	TruncatedModuleInfo,
	estimateTokens,
} from './prompt-module.interface.js';
import { IdentityModule } from './identity.module.js';
import { SoulModule } from './soul.module.js';
import { ExpertProfileModule } from './expert-profile.module.js';
import { SkillsReferenceModule } from './skills-reference.module.js';
import { MemoryReferenceModule } from './memory-reference.module.js';
import { TeamReferenceModule } from './team-reference.module.js';
import { ProjectReferenceModule } from './project-reference.module.js';
import { UserProfileReferenceModule } from './user-profile-reference.module.js';
import { LearningReferenceModule } from './learning-reference.module.js';
import { CommunicationModule } from './communication.module.js';
import { RecoveryModule } from './recovery.module.js';
import { LifecycleModule } from './lifecycle.module.js';
import { RoleBoundaryModule } from './role-boundary.module.js';
import { CapabilityOverlayModule } from './capability-overlay.module.js';
import { DomainSOPModule } from './domain-sop.module.js';
import { RiskPolicyModule } from './risk-policy.module.js';
import { TeamNormsModule } from './team-norms.module.js';

/**
 * Default total token budget for all prompt modules combined.
 * Increased from 25000 to 28000 for Architecture Upgrade modules.
 * Role Boundary (~800 tokens, non-compactable) is the only guaranteed addition.
 * SOP/Risk/Capability are conditional and compactable.
 */
const DEFAULT_TOKEN_BUDGET = 28000;

/**
 * Separator between prompt modules in assembled output.
 */
const MODULE_SEPARATOR = '\n\n---\n\n';

/**
 * When trimming a module to fit budget, reduce to this fraction of maxTokens first.
 */
const TRIM_FRACTION = 0.5;

/**
 * Module names that are included in eval mode.
 * All other modules are skipped to reduce prompt size and cost during eval runs.
 */
const EVAL_MODE_CORE_MODULES: ReadonlySet<string> = new Set([
	'identity',
	'soul',
	'role-boundary',
	'recovery',
]);

/**
 * Internal build result with module reference for truncation.
 */
interface InternalBuildResult extends ModuleBuildResult {
	compactable: boolean;
	priority: number;
}

/**
 * Service that orchestrates the assembly of prompt modules into a complete agent prompt.
 *
 * Responsibilities:
 * - Registers and manages prompt modules
 * - Assembles modules in priority order
 * - Enforces per-module and total token budgets with 2-stage truncation:
 *   1. First pass: build all Trusted Zone (non-compactable) + Flexible Zone modules
 *   2. If over budget: trim lowest-priority compactable modules to 50% of maxTokens
 *   3. If still over budget: remove lowest-priority compactable modules entirely
 * - Returns AssemblyReport with token breakdown and truncation details
 *
 * @example
 * ```typescript
 * const assembler = new PromptAssemblyService();
 * const { prompt, report } = await assembler.assemble({
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
			new SoulModule(),
			new ExpertProfileModule(),
			new RecoveryModule(),
			new RoleBoundaryModule(),
			new MemoryReferenceModule(),
			new SkillsReferenceModule(),
			new TeamReferenceModule(),
			new CapabilityOverlayModule(),
			new ProjectReferenceModule(),
			new CommunicationModule(),
			new DomainSOPModule(),
			new TeamNormsModule(),
			new UserProfileReferenceModule(),
			new RiskPolicyModule(),
			new LearningReferenceModule(),
			new LifecycleModule(),
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
	 * Uses 2-stage truncation for compactable modules when over budget:
	 * 1. Trim lowest-priority compactable modules to 50% of their content
	 * 2. Remove lowest-priority compactable modules entirely
	 *
	 * Trusted Zone (non-compactable) modules are never truncated or removed.
	 *
	 * @param config - Configuration with all context needed by modules
	 * @returns Object with assembled prompt string and budget report
	 */
	async assemble(config: ModuleConfig): Promise<{ prompt: string; report: AssemblyReport }> {
		const built: InternalBuildResult[] = [];
		const truncated: TruncatedModuleInfo[] = [];

		// Sort modules by priority (ascending — lower number = higher priority)
		const sorted = [...this.modules].sort((a, b) => a.priority - b.priority);

		// Phase 1: Build all applicable modules
		for (const module of sorted) {
			// In eval mode, skip non-core modules to reduce prompt size and cost
			if (config.evalMode && !EVAL_MODE_CORE_MODULES.has(module.name)) {
				this.logger.debug(`Module '${module.name}' skipped (evalMode)`, {
					sessionName: config.sessionName,
				});
				continue;
			}

			if (!module.shouldInclude(config)) {
				this.logger.debug(`Module '${module.name}' skipped (shouldInclude=false)`, {
					sessionName: config.sessionName,
				});
				continue;
			}

			try {
				const content = await module.build(config);
				if (content && content.trim()) {
					const tokens = estimateTokens(content);
					built.push({
						name: module.name,
						content: content.trim(),
						estimatedTokens: tokens,
						compactable: module.compactable,
						priority: module.priority,
					});
				}
			} catch (error) {
				this.logger.error(`Module '${module.name}' failed to build`, {
					sessionName: config.sessionName,
					error: error instanceof Error ? error.message : String(error),
				});
				if (!module.compactable) {
					throw error;
				}
			}
		}

		// Phase 2: Enforce token budget via 2-stage truncation
		let totalTokens = built.reduce((sum, r) => sum + r.estimatedTokens, 0);

		if (totalTokens > this.totalTokenBudget) {
			// Get compactable modules sorted by priority descending (lowest priority first to trim)
			const compactableIndices = built
				.map((r, i) => ({ ...r, index: i }))
				.filter((r) => r.compactable)
				.sort((a, b) => b.priority - a.priority);

			// Stage 1: Trim to 50% of content (lowest priority first)
			for (const item of compactableIndices) {
				if (totalTokens <= this.totalTokenBudget) break;

				const original = built[item.index];
				const trimmedContent = this.trimContent(original.content, TRIM_FRACTION);
				const trimmedTokens = estimateTokens(trimmedContent);
				const savings = original.estimatedTokens - trimmedTokens;

				if (savings > 0) {
					totalTokens -= savings;
					built[item.index] = {
						...original,
						content: trimmedContent,
						estimatedTokens: trimmedTokens,
					};
					truncated.push({
						name: original.name,
						originalTokens: original.estimatedTokens,
						finalTokens: trimmedTokens,
						action: 'trimmed',
					});

					this.logger.info(`Module '${original.name}' trimmed to 50%`, {
						sessionName: config.sessionName,
						originalTokens: original.estimatedTokens,
						trimmedTokens,
						totalTokens,
					});
				}
			}

			// Stage 2: Remove entirely (lowest priority first)
			if (totalTokens > this.totalTokenBudget) {
				// Re-get compactable indices (some may have been trimmed)
				const removable = built
					.map((r, i) => ({ ...r, index: i }))
					.filter((r) => r.compactable)
					.sort((a, b) => b.priority - a.priority);

				for (const item of removable) {
					if (totalTokens <= this.totalTokenBudget) break;

					const original = built[item.index];
					totalTokens -= original.estimatedTokens;

					// Check if already in truncated list (was trimmed in stage 1)
					const existingTruncIdx = truncated.findIndex((t) => t.name === original.name);
					if (existingTruncIdx >= 0) {
						truncated[existingTruncIdx].finalTokens = 0;
						truncated[existingTruncIdx].action = 'removed';
					} else {
						truncated.push({
							name: original.name,
							originalTokens: original.estimatedTokens,
							finalTokens: 0,
							action: 'removed',
						});
					}

					// Mark for removal by zeroing content
					built[item.index] = { ...original, content: '', estimatedTokens: 0 };

					this.logger.info(`Module '${original.name}' removed (budget)`, {
						sessionName: config.sessionName,
						freedTokens: original.estimatedTokens,
						totalTokens,
					});
				}
			}
		}

		// Filter out removed modules and build final output
		const finalResults = built.filter((r) => r.content.length > 0);
		const finalTotalTokens = finalResults.reduce((sum, r) => sum + r.estimatedTokens, 0);

		const report: AssemblyReport = {
			totalTokens: finalTotalTokens,
			moduleBreakdown: finalResults.map((r) => ({
				name: r.name,
				content: r.content,
				estimatedTokens: r.estimatedTokens,
			})),
			truncated,
		};

		this.logger.info('Prompt assembly complete', {
			sessionName: config.sessionName,
			moduleCount: finalResults.length,
			totalTokens: finalTotalTokens,
			budget: this.totalTokenBudget,
			truncatedCount: truncated.length,
			modules: finalResults.map((r) => r.name),
		});

		return {
			prompt: finalResults.map((r) => r.content).join(MODULE_SEPARATOR),
			report,
		};
	}

	/**
	 * Assemble modules and return detailed results with per-module metadata.
	 * Convenience wrapper that returns just the report (same as assemble().report).
	 *
	 * @param config - Configuration with all context needed by modules
	 * @returns Assembly details with prompt, modules, and total tokens
	 */
	async assembleWithDetails(config: ModuleConfig): Promise<{
		prompt: string;
		modules: ModuleBuildResult[];
		totalTokens: number;
		truncated: TruncatedModuleInfo[];
	}> {
		const { prompt, report } = await this.assemble(config);
		return {
			prompt,
			modules: report.moduleBreakdown,
			totalTokens: report.totalTokens,
			truncated: report.truncated,
		};
	}

	/**
	 * Trim content to a target fraction of its original length.
	 * Trims at line boundaries to avoid cutting mid-sentence.
	 *
	 * @param content - Original content string
	 * @param fraction - Target fraction (e.g., 0.5 for 50%)
	 * @returns Trimmed content
	 */
	private trimContent(content: string, fraction: number): string {
		const targetLength = Math.floor(content.length * fraction);
		if (targetLength >= content.length) return content;

		const lines = content.split('\n');
		let accumulated = 0;
		const kept: string[] = [];

		for (const line of lines) {
			if (accumulated + line.length + 1 > targetLength && kept.length > 0) {
				break;
			}
			kept.push(line);
			accumulated += line.length + 1; // +1 for newline
		}

		return kept.join('\n');
	}
}
