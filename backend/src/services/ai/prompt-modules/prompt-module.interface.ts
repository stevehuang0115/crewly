import * as fs from 'fs';
import * as path from 'path';

/**
 * Interface for modular prompt components.
 *
 * Each module is responsible for one concern (identity, skills, team, etc.)
 * and produces a markdown string that gets assembled into the final agent prompt.
 *
 * Modules are assembled in priority order (1 = highest, assembled first).
 * Non-compactable modules are never truncated when token budget is tight.
 */

/**
 * Configuration passed to each prompt module during assembly.
 * Contains all the context needed to build module-specific content.
 */
/**
 * Organizational role derived from team hierarchy.
 * Determines role boundary rules and event subscriptions.
 */
export type OrgRole = 'orchestrator' | 'team-lead' | 'executor';

/**
 * Autonomy level controls the decision rights matrix.
 * - directed: Execute assigned tasks only, escalate all ambiguity.
 * - bounded: Make decisions within task/domain scope, log rationale.
 * - domain_autonomous: Monitor domain continuously, make approved decisions without waiting.
 */
export type AutonomyLevel = 'directed' | 'bounded' | 'domain_autonomous';

export interface ModuleConfig {
	/** Agent's session name (e.g. 'crewly-product-sam-217bfbbf') */
	sessionName: string;
	/** Agent's member ID (UUID) */
	memberId: string;
	/** Agent's role (e.g. 'developer', 'orchestrator') */
	role: string;
	/** Team ID this agent belongs to */
	teamId?: string;
	/** Absolute path to the project directory */
	projectPath?: string;
	/** Runtime type determines formatting and injection strategy */
	runtimeType?: 'claude-code' | 'gemini-cli' | 'codex' | 'crewly-agent';
	/** Whether this agent can delegate tasks to subordinates */
	canDelegate?: boolean;
	/** Resolved subordinate details for TL agents */
	subordinates?: SubordinateInfoCompat[];
	/** Absolute path to agent skill scripts */
	agentSkillsPath: string;
	/** Absolute path to team-leader skill scripts */
	tlSkillsPath: string;
	/** Absolute path to the project root (where config/ lives) */
	projectRoot: string;

	// === Architecture Upgrade fields ===

	/** Organizational role derived from team hierarchy (orchestrator, team-lead, executor) */
	orgRole?: OrgRole;
	/** Autonomy level controlling the decision rights matrix */
	autonomyLevel?: AutonomyLevel;
	/** Capability flags (e.g., ['can-decide', 'can-verify']) */
	capabilities?: string[];
	/** Domain SOP name — loads config/domain-sops/{domainSOP}.sop.md */
	domainSOP?: string;
	/** Risk policy name — loads config/risk-policies/{riskPolicy}.policy.md */
	riskPolicy?: string;

	// === Eval mode ===

	/**
	 * When true, the prompt assembler skips non-core modules to reduce token usage
	 * during eval runs. Core modules: identity, soul, role-boundary, recovery.
	 */
	evalMode?: boolean;
}

/**
 * Subordinate info compatible with the existing SubordinateInfo type
 */
export interface SubordinateInfoCompat {
	name: string;
	sessionName: string;
	role: string;
	memberId: string;
}

/**
 * Result of building a single prompt module.
 * Includes the content and metadata for budget tracking.
 */
export interface ModuleBuildResult {
	/** Module name */
	name: string;
	/** Generated markdown content */
	content: string;
	/** Estimated token count of the content */
	estimatedTokens: number;
}

/**
 * Interface that all prompt modules must implement.
 *
 * @example
 * ```typescript
 * class IdentityModule implements PromptModule {
 *   name = 'identity';
 *   priority = 1;
 *   maxTokens = 150;
 *   compactable = false;
 *
 *   shouldInclude(_config: ModuleConfig): boolean { return true; }
 *
 *   async build(config: ModuleConfig): Promise<string> {
 *     return `## Your Identity\n- **Session Name:** ${config.sessionName}`;
 *   }
 * }
 * ```
 */
export interface PromptModule {
	/** Module name (used for logging and debugging) */
	name: string;
	/** Assembly priority (1 = highest, assembled first) */
	priority: number;
	/** Token soft cap for this module */
	maxTokens: number;
	/** Whether this module can be skipped when token budget is tight */
	compactable: boolean;
	/** Condition check — return false to skip this module */
	shouldInclude(config: ModuleConfig): boolean;
	/** Build module content as markdown string */
	build(config: ModuleConfig): Promise<string>;
}

/**
 * Report returned by PromptAssemblyService.assemble() describing
 * token usage and any truncation that occurred.
 */
export interface AssemblyReport {
	/** Total estimated tokens in the final prompt */
	totalTokens: number;
	/** Per-module token breakdown */
	moduleBreakdown: ModuleBuildResult[];
	/** Modules that were truncated or removed to fit budget */
	truncated: TruncatedModuleInfo[];
}

/**
 * Info about a module that was truncated or removed during assembly.
 */
export interface TruncatedModuleInfo {
	/** Module name */
	name: string;
	/** Original estimated tokens before truncation */
	originalTokens: number;
	/** Tokens after truncation (0 if fully removed) */
	finalTokens: number;
	/** What happened: 'trimmed' (to 50%) or 'removed' (dropped entirely) */
	action: 'trimmed' | 'removed';
}

/**
 * Load a role-specific fragment file from config/roles/{role}/fragments/{fragmentName}.md.
 * Returns null if the file doesn't exist.
 *
 * @param projectRoot - Project root path (where config/ lives)
 * @param role - Agent role (e.g. 'orchestrator')
 * @param fragmentName - Fragment file name without .md extension
 * @returns Fragment content string or null
 */
export function loadRoleFragment(
	projectRoot: string,
	role: string,
	fragmentName: string
): string | null {
	try {
		const fragmentPath = path.join(projectRoot, 'config', 'roles', role, 'fragments', `${fragmentName}.md`);
		if (fs.existsSync(fragmentPath)) {
			return fs.readFileSync(fragmentPath, 'utf-8');
		}
	} catch {
		// Fragment not found — fall back to inline content
	}
	return null;
}

/**
 * Estimate token count from a string.
 * Uses the rough heuristic of ~4 characters per token (suitable for English/code mix).
 *
 * @param text - Text to estimate tokens for
 * @returns Estimated token count
 */
export function estimateTokens(text: string): number {
	if (!text) return 0;
	// ~4 chars per token is a reasonable estimate for English + code
	return Math.ceil(text.length / 4);
}
