import { readFile, access } from 'fs/promises';
import * as path from 'path';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { TeamMemberSessionConfig, SubordinateInfo, SOPRole, TeamMember, Team } from '../../types/index.js';
import { MemoryService } from '../memory/memory.service.js';
import { SOPService } from '../sop/sop.service.js';
import { getRoleService } from '../settings/role.service.js';
import { PromptAssemblyService } from './prompt-modules/prompt-assembly.service.js';
import type { ModuleConfig, OrgRole } from './prompt-modules/prompt-module.interface.js';

// =============================================================================
// WIRE-1: Autonomy field injection helpers
// =============================================================================

/**
 * Derive the organisational role for a member from team-hierarchy facts.
 *
 * Resolution cascade (first match wins):
 *   1. `role === 'orchestrator'`        → `'orchestrator'`
 *   2. `canDelegate === true`           → `'team-lead'`
 *   3. has subordinates in the team     → `'team-lead'`
 *   4. otherwise                        → `'executor'`
 *
 * This function is total — every member resolves to one of the three roles —
 * so it never throws. Fail-fast on misconfiguration is enforced downstream
 * by {@link RoleBoundaryModule} (a member with `canDelegate=true` whose
 * `orgRole` is undefined when the boundary is rendered indicates the
 * caller bypassed `buildModuleConfigFromTeamMember` — that boundary throws).
 *
 * @param member - Full TeamMember record
 * @param team - Full Team record (used to detect implicit subordination)
 * @returns The resolved organisational role
 */
export function deriveOrgRole(member: TeamMember, team: Team): OrgRole {
	if (member.role === 'orchestrator') return 'orchestrator';
	if (member.canDelegate === true) return 'team-lead';
	if (Array.isArray(member.subordinateIds) && member.subordinateIds.length > 0) return 'team-lead';
	// Some legacy team shapes record the relationship on the team side only —
	// catch members who appear as a parent of any other member.
	if (team.members?.some((m) => m.parentMemberId === member.id)) return 'team-lead';
	return 'executor';
}

/**
 * Snapshot of the SessionConfig fields the helper needs that are NOT
 * carried on TeamMember/Team (runtime-host concerns: session name, project
 * path, runtime type, and the precomputed subordinate list).
 *
 * Splitting these out keeps {@link buildModuleConfigFromTeamMember} pure —
 * it can be invoked anywhere TeamMember + Team are available without
 * coupling to the legacy `TeamMemberSessionConfig` shape.
 */
export interface SessionRuntimeContext {
	/** Agent's session name (e.g. 'crewly-product-sam-dd2b46f7'). */
	sessionName: string;
	/** Absolute path to the project directory. */
	projectPath?: string;
	/** Runtime host (claude-code, gemini-cli, codex, crewly-agent). */
	runtimeType?: ModuleConfig['runtimeType'];
	/** Optional precomputed subordinate list. When omitted, the helper
	 * resolves it from `team.members` and `member.subordinateIds`. */
	subordinates?: SubordinateInfo[];
	/** Absolute path to agent skill scripts (e.g. `<projectRoot>/config/skills/agent`). */
	agentSkillsPath: string;
	/** Absolute path to team-leader skill scripts. */
	tlSkillsPath: string;
	/** Absolute path to the project root (where config/ lives). */
	projectRoot: string;
}

/**
 * Build a complete {@link ModuleConfig} from a TeamMember + Team pair.
 *
 * Wires every autonomy / organisation / team-context field declared on
 * `TeamMember` and `Team` into the prompt assembler — the gap that caused
 * every TL agent in production to silently render with the executor
 * boundary (because `orgRole` was never injected, and
 * `RoleBoundaryModule.build()` previously fell back to `'executor'`).
 *
 * Fields wired from `member`:
 *   - `autonomyLevel`, `domainSOP`, `riskPolicy`, `capabilities`
 *   - `jobTitle`, `jobDescription`, `ownershipScope`, `expertId`
 *
 * Fields wired from `team`:
 *   - `team.mission` → `teamMission`
 *   - `team.budget` → `teamBudget`
 *   - `team.qualityGate` → `teamQualityGate`
 *   - `team.serviceContract` → `serviceContract`
 *   - `team.ownershipScope` → `teamOwnershipScope`
 *   - `team.description` → `teamDescription`
 *
 * `orgRole` is resolved via {@link deriveOrgRole}. `canDelegate` is mirrored
 * from the member record. The subordinate list is taken from
 * `runtime.subordinates` when supplied, otherwise resolved from `team.members`.
 *
 * @param member - Full TeamMember record
 * @param team - Full Team record
 * @param runtime - Runtime-host context (session name, project paths, etc.)
 * @returns A fully populated ModuleConfig
 *
 * @example
 * ```typescript
 * const config = buildModuleConfigFromTeamMember(member, team, {
 *   sessionName: 'crewly-product-sam-dd2b46f7',
 *   projectPath: '/Users/.../crewly',
 *   runtimeType: 'claude-code',
 *   agentSkillsPath: path.join(projectRoot, 'config/skills/agent'),
 *   tlSkillsPath: path.join(projectRoot, 'config/skills/team-leader'),
 *   projectRoot,
 * });
 * const { prompt } = await new PromptAssemblyService().assemble(config);
 * ```
 */
export function buildModuleConfigFromTeamMember(
	member: TeamMember,
	team: Team,
	runtime: SessionRuntimeContext,
): ModuleConfig {
	const orgRole = deriveOrgRole(member, team);
	const subordinates = runtime.subordinates ?? resolveSubordinatesFromTeam(member, team);

	return {
		// Identity / runtime
		sessionName: runtime.sessionName,
		memberId: member.id ?? '',
		role: member.role,
		teamId: team.id,
		projectPath: runtime.projectPath,
		runtimeType: runtime.runtimeType,

		// Hierarchy
		canDelegate: member.canDelegate,
		subordinates,

		// Skill paths
		agentSkillsPath: runtime.agentSkillsPath,
		tlSkillsPath: runtime.tlSkillsPath,
		projectRoot: runtime.projectRoot,

		// === Autonomy + capability overlay (member-level) ===
		orgRole,
		autonomyLevel: member.autonomyLevel,
		capabilities: member.capabilities,
		domainSOP: member.domainSOP,
		riskPolicy: member.riskPolicy,

		// === Organisation model (member-level) ===
		jobTitle: member.jobTitle,
		jobDescription: member.jobDescription,
		ownershipScope: member.ownershipScope,
		expertId: member.expertId,

		// === Team-level injection ===
		teamDescription: team.description,
		teamMission: team.mission,
		teamBudget: team.budget,
		teamQualityGate: team.qualityGate,
		serviceContract: team.serviceContract,
		teamOwnershipScope: team.ownershipScope,

		// === Team-graph context (consumed by MissionContextModule) ===
		// Slug derived from team name; matches the convention used elsewhere
		// (e.g. template.controller.toSlug + sessionName composition).
		// Used to resolve `<teamSlug>-team-sub-okr.md` under .crewly/goals/.
		teamSlug: team.name ? toTeamSlug(team.name) : undefined,
		// Single-level parent only — modules that need deeper ancestry
		// should call a graph resolver. Walking the full parent chain
		// here would require runtime team-graph access this builder
		// intentionally does not have.
		teamAncestorIds: team.parentTeamId ? [team.parentTeamId] : undefined,
	};
}

/**
 * Convert a team name to a URL-safe slug (lowercase, hyphens, alnum only).
 * Mirrors `toSlug` in `controllers/template/template.controller.ts` so
 * goal / OKR file naming stays consistent across the codebase.
 *
 * @param name - Human-readable team name
 * @returns Lowercase slug suitable for file path segments
 */
function toTeamSlug(name: string): string {
	return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

/**
 * Resolve a member's subordinate roster from the team record.
 *
 * Used when {@link buildModuleConfigFromTeamMember} is called without a
 * pre-computed `runtime.subordinates`. Maps `member.subordinateIds` to the
 * matching `team.members` entries, dropping any unresolved ids.
 */
function resolveSubordinatesFromTeam(member: TeamMember, team: Team): SubordinateInfo[] | undefined {
	if (!Array.isArray(member.subordinateIds) || member.subordinateIds.length === 0) return undefined;
	const byId = new Map(team.members?.map((m) => [m.id, m]) ?? []);
	const subs: SubordinateInfo[] = [];
	for (const subId of member.subordinateIds) {
		const sub = byId.get(subId);
		if (!sub) continue;
		subs.push({
			name: sub.name,
			sessionName: sub.sessionName ?? '',
			role: sub.role ?? 'developer',
			memberId: sub.id ?? subId,
		});
	}
	return subs.length > 0 ? subs : undefined;
}

/**
 * Options for building system prompts
 */
export interface PromptOptions {
  /** Agent's role */
  role?: string;
  /** Current task context for SOP selection */
  taskContext?: string;
  /** Task type for SOP matching */
  taskType?: string;
  /** Whether to include memory context (default: true) */
  includeMemory?: boolean;
  /** Whether to include SOPs (default: true) */
  includeSOPs?: boolean;
  /** Maximum number of SOPs to include */
  sopLimit?: number;
  /** Maximum number of memory entries to include */
  memoryLimit?: number;
  /** Force reload context instead of using cache */
  freshContext?: boolean;
}

/**
 * Parts that compose a complete prompt
 */
interface PromptParts {
  /** Base role instructions */
  basePrompt: string;
  /** Project context from context loader */
  projectContext?: string;
  /** Memory context from memory service */
  memoryContext?: string;
  /** SOP context (for future use) */
  sopContext?: string;
  /** Team Lead responsibilities section (injected when canDelegate=true) */
  teamLeadContext?: string;
  /** Team norms/SOPs from template (injected for matching roles) */
  teamNormsContext?: string;
  /** Project name */
  projectName?: string;
  /** Project path */
  projectPath?: string;
  /** Session name */
  sessionName?: string;
  /** Member ID */
  memberId?: string;
  /** Role */
  role?: string;
  /** Team ID */
  teamId?: string;
  /** Runtime type (e.g. 'claude-code', 'gemini-cli') for runtime-specific instructions */
  runtimeType?: string;
}

/**
 * Service dedicated to building and loading the various prompts used to communicate with agents.
 * Handles prompt templating, variable substitution, and fallback prompt generation.
 */
export class PromptBuilderService {
	private logger: ComponentLogger;
	private readonly projectRoot: string;
	private readonly rolesDirectory: string;
	/** Absolute path to agent skill scripts (used in prompts so agents can find them from any working directory) */
	private readonly agentSkillsPath: string;
	/** Absolute path to team-leader skill scripts (used in TL addon template variables) */
	private readonly tlSkillsPath: string;
	private memoryService: MemoryService | null = null;
	private sopService: SOPService | null = null;

	constructor(projectRoot: string = process.cwd()) {
		this.logger = LoggerService.getInstance().createComponentLogger('PromptBuilderService');
		this.projectRoot = projectRoot;
		this.rolesDirectory = path.join(projectRoot, 'config', 'roles');
		this.agentSkillsPath = path.join(projectRoot, 'config', 'skills', 'agent');
		this.tlSkillsPath = path.join(projectRoot, 'config', 'skills', 'team-leader');
	}

	/**
	 * Gets the MemoryService instance (lazy initialization)
	 *
	 * @returns The MemoryService singleton
	 */
	private getMemoryService(): MemoryService {
		if (!this.memoryService) {
			this.memoryService = MemoryService.getInstance();
		}
		return this.memoryService;
	}

	/**
	 * Gets the SOPService instance (lazy initialization)
	 *
	 * @returns The SOPService singleton
	 */
	private getSOPService(): SOPService {
		if (!this.sopService) {
			this.sopService = SOPService.getInstance();
		}
		return this.sopService;
	}

	/**
	 * Build orchestrator prompt for project management
	 */
	buildOrchestratorPrompt(projectData: {
		projectName: string;
		projectPath: string;
		teamDetails: { name?: string; members?: Array<{ name: string; role: string; skills?: string }> };
		requirements?: string;
	}): string {
		const { projectName, projectPath, teamDetails, requirements } = projectData;

		const teamMembers = Array.isArray(teamDetails.members)
			? teamDetails.members
					.map(
						(member) =>
							`- ${member.name}: ${member.role} (${member.skills || 'General'})`
					)
					.join('\n')
			: 'No team members specified';

		const prompt =
			`I need you to build a full-stack application. The specifications are in ${projectPath}

Please:
1. Create a ${teamDetails.name || 'development team'} (${teamMembers
				.replace(/- /g, '')
				.replace(/\n/g, ' + ')})
2. Have them build according to the specs in ${projectPath}/.crewly/specs/
3. Ensure 30-minute git commits
4. Coordinate the team to work on Phase 1 simultaneously

## Project: ${projectName}
**Path**: ${projectPath}
**Requirements**: ${requirements || 'See project documentation in .crewly/specs/'}

## Team Structure
${teamMembers}

## Your Role as Orchestrator
You are managing the "${projectName}" project. The team sessions have been created for you. Monitor progress, coordinate work between team members, and ensure git commits happen every 30 minutes.

The team is ready to start. Begin by reviewing the project specs and coordinating the team to start Phase 1 development.

Start all teams on Phase 1 simultaneously.

## Pipeline-First Planning Discipline

> Source spec: .crewly/specs/2026-05-05-pipeline-dogfood-prompt-amendment.md §3.1.

When you receive a planning-class intent from the owner (or any upstream source), do NOT write a markdown spec or push tasks via send-message as your first move. The pipeline is the planner of record:

1. POST /api/requests first — { sourceConversationItemId, title, description, intentLevel, intentCategory, priority }. Capture the returned id.
2. If intentLevel ∈ {L1, L2}, call POST /api/requests/plan with the user message to receive a RequestPlan. Review it; if you accept, materialise WorkItems whose requestId is the new Request.
3. Only after the Request exists and at least one WorkItem is in the pool may you send-message a teammate, and that message MUST reference the Request ID — it is a notification of an existing pipeline item, never a substitute for one.

Markdown specs in .crewly/specs/ remain valid for durable design artefacts (architecture, post-mortems). They are NOT the channel for "tell the team what to build" — that is the Request. Negative pattern to suppress: "forward to TL via send-message" as the first step after parsing intent.`.trim();

		this.logger.debug('Built orchestrator prompt', {
			projectName,
			teamMembersCount: teamDetails.members?.length || 0,
			promptLength: prompt.length,
		});

		return prompt;
	}

	/**
	 * Build system prompt for Claude Code agent
	 * Loads prompts from config/roles/{role}/prompt.md
	 */
	async buildSystemPrompt(config: TeamMemberSessionConfig): Promise<string> {
		// Normalize role name to directory name format
		const roleName = config.role.toLowerCase().replace(/\s+/g, '-');

		// Try to load role-specific prompt from config/roles/{role}/prompt.md
		const promptPath = path.resolve(this.rolesDirectory, roleName, 'prompt.md');

		try {
			await access(promptPath);
			let promptContent = await readFile(promptPath, 'utf8');

			// Replace template variables
			promptContent = this.replaceTemplateVariables(promptContent, {
				SESSION_NAME: config.name || 'unknown',
				SESSION_ID: config.name || 'unknown',
				ROLE: config.role,
				PROJECT_PATH: config.projectPath || 'Not specified',
				MEMBER_ID: config.memberId || '',
				AGENT_SKILLS_PATH: this.agentSkillsPath,
			});

			this.logger.info('Loaded role-specific system prompt', {
				role: config.role,
				promptPath,
				promptLength: promptContent.length,
			});

			return promptContent.trim();
		} catch (error) {
			// Fallback to generic prompt if specific role prompt not found
			this.logger.warn(`Role-specific prompt not found: ${promptPath}, using fallback`, {
				role: config.role,
			});

			return this.buildFallbackSystemPrompt(config);
		}
	}

	/**
	 * Build system prompt with memory and SOP context included.
	 *
	 * This method builds a complete system prompt that includes:
	 * - Base role instructions
	 * - Project context
	 * - Memory context (agent and project memories)
	 * - SOP context (relevant Standard Operating Procedures)
	 * - Agent identity information
	 *
	 * **WIRE-2 migration note:** When a `TeamMember` + `Team` pair is
	 * available, prefer {@link buildSystemPromptWithTeamContext} — it
	 * routes through {@link buildModuleConfigFromTeamMember} and wires
	 * every autonomy / domain-SOP / risk-policy / capability / job-title /
	 * ownership-scope / expert-id / team-mission / team-budget /
	 * team-quality-gate / service-contract / team-ownership-scope field
	 * declared on the TeamMember and Team records. The SessionConfig-only
	 * surface here keeps the WIRE-1 stopgap for legacy callers (single-
	 * agent flows, tests, and any path that doesn't have team context in
	 * scope) so RoleBoundaryModule still resolves correctly for orc + TL
	 * agents.
	 *
	 * @param config - Session configuration (SessionConfig-only)
	 * @param options - Prompt building options
	 * @returns Complete system prompt with memory and SOPs
	 *
	 * @example
	 * ```typescript
	 * const prompt = await promptBuilder.buildSystemPromptWithMemory(config, {
	 *   includeMemory: true,
	 *   includeSOPs: true,
	 *   taskContext: 'implementing authentication',
	 *   role: 'developer'
	 * });
	 * ```
	 */
	async buildSystemPromptWithMemory(
		config: TeamMemberSessionConfig,
		options: PromptOptions = {}
	): Promise<string> {
		// Phase 5: Use modular prompt assembly (enabled by default, disable with CREWLY_USE_MODULAR_PROMPTS=false)
		if (process.env.CREWLY_USE_MODULAR_PROMPTS !== 'false') {
			return this.buildModularPrompt(config, options);
		}

		const includeMemory = options.includeMemory !== false;
		const includeSOPs = options.includeSOPs !== false;

		// Get base prompt
		const basePrompt = await this.buildSystemPrompt(config);

		// Build memory context if enabled
		let memoryContext = '';
		if (includeMemory && config.projectPath && config.memberId) {
			memoryContext = await this.buildMemoryContext(
				config.memberId,
				config.projectPath,
				options
			);
		}

		// Build SOP context if enabled
		let sopContext = '';
		if (includeSOPs) {
			sopContext = await this.buildSOPContext(
				config.role,
				options.taskContext,
				options.taskType,
				options.sopLimit
			);
		}

		// Build Team Lead section if applicable (loads tl-addon.md when available)
		const teamLeadContext = await this.buildTeamLeadSection(config);

		// Build Team Norms section (from template norms/*.md)
		const teamNormsContext = await this.buildTeamNormsSection(
			config.teamId || '',
			config.role
		);

		// Compose final prompt with memory, SOPs, TL context, and norms
		if (memoryContext || sopContext || teamLeadContext || teamNormsContext) {
			return this.composePromptWithMemory({
				basePrompt,
				memoryContext,
				sopContext,
				teamLeadContext,
				teamNormsContext,
				sessionName: config.name,
				memberId: config.memberId,
				role: config.role,
				projectPath: config.projectPath,
				teamId: config.teamId,
				runtimeType: config.runtimeType,
			});
		}

		return basePrompt;
	}

	/**
	 * Build system prompt with full TeamMember + Team context (WIRE-2).
	 *
	 * The preferred entrypoint when a `TeamMember` and its enclosing `Team`
	 * are both available — wires every autonomy / org / team-level field
	 * declared on those records into the prompt assembler via
	 * {@link buildModuleConfigFromTeamMember}.
	 *
	 * This method does NOT mutate the SessionConfig-only stopgap that
	 * remains in {@link buildModularPrompt} — that stopgap is still the
	 * fallback for legacy callers (single-agent flows, tests, and any path
	 * that lacks team context in scope). Once all hot callers migrate to
	 * this method, the stopgap becomes truly defensive (only fires for
	 * test/legacy paths).
	 *
	 * @param member - Full TeamMember record
	 * @param team - Full Team record
	 * @param runtime - Runtime-host context (session name, project paths,
	 *   pre-resolved subordinates, etc.)
	 * @param overlay - Optional overlay applied AFTER the helper builds the
	 *   ModuleConfig — used for fields that are NOT on TeamMember/Team
	 *   (e.g. `teamNormsPath`, registration-side `memberId` overrides).
	 * @returns The fully-assembled prompt string
	 *
	 * @example
	 * ```typescript
	 * const prompt = await promptBuilder.buildSystemPromptWithTeamContext(
	 *   foundMember,
	 *   foundTeam,
	 *   {
	 *     sessionName,
	 *     projectPath,
	 *     runtimeType: 'claude-code',
	 *     agentSkillsPath: path.join(projectRoot, 'config/skills/agent'),
	 *     tlSkillsPath: path.join(projectRoot, 'config/skills/team-leader'),
	 *     projectRoot,
	 *   },
	 *   { teamNormsPath: path.join(homedir, '.crewly/teams', team.id, 'norms') },
	 * );
	 * ```
	 */
	async buildSystemPromptWithTeamContext(
		member: TeamMember,
		team: Team,
		runtime: SessionRuntimeContext,
		overlay?: Partial<ModuleConfig>,
	): Promise<string> {
		const baseConfig = buildModuleConfigFromTeamMember(member, team, runtime);
		const moduleConfig: ModuleConfig = overlay ? { ...baseConfig, ...overlay } : baseConfig;

		const assembler = new PromptAssemblyService();
		const { prompt, report } = await assembler.assemble(moduleConfig);

		this.logger.info('Modular prompt assembled (team-context path)', {
			sessionName: runtime.sessionName,
			memberId: member.id,
			role: member.role,
			teamId: team.id,
			totalTokens: report.totalTokens,
			moduleCount: report.moduleBreakdown.length,
			truncatedCount: report.truncated.length,
			modules: report.moduleBreakdown.map(m => m.name),
		});

		return prompt;
	}

	/**
	 * Build system prompt using the modular PromptAssemblyService.
	 *
	 * Called by default (disable with CREWLY_USE_MODULAR_PROMPTS=false). The modular system handles
	 * all prompt sections (identity, skills, communication, recovery, lifecycle,
	 * team-reference, memory, soul, learning) with proper token budget enforcement
	 * and priority ordering.
	 *
	 * @param config - Team member session configuration
	 * @param options - Prompt options (currently unused by modular system)
	 * @returns Assembled prompt string
	 */
	private async buildModularPrompt(
		config: TeamMemberSessionConfig,
		_options: PromptOptions = {}
	): Promise<string> {
		const agentSkillsPath = path.join(this.projectRoot, 'config', 'skills', 'agent');
		const tlSkillsPath = path.join(this.projectRoot, 'config', 'skills', 'team-leader');

		// WIRE-2 fallback (post-WIRE-1, post-WIRE-2): callers that provide a
		// SessionConfig WITHOUT a TeamMember + Team pair land here. The new
		// preferred path is {@link buildModuleConfigFromTeamMember} (used by
		// agent-registration.service.ts at the registration callsite); the
		// legacy SessionConfig-only callers retain this stopgap as a
		// defensive default. The cascade resolves orgRole for the two cases
		// that matter when team context is unavailable: orchestrator and TL
		// (via canDelegate=true). Non-TL members keep `undefined` so the
		// executor fallback renders correctly.
		const orgRole: ModuleConfig['orgRole'] =
			config.role === 'orchestrator'
				? 'orchestrator'
				: config.canDelegate === true
					? 'team-lead'
					: undefined;

		const moduleConfig: ModuleConfig = {
			sessionName: config.name,
			memberId: config.memberId ?? '',
			role: config.role,
			teamId: config.teamId,
			projectPath: config.projectPath,
			runtimeType: config.runtimeType as ModuleConfig['runtimeType'],
			canDelegate: config.canDelegate,
			orgRole,
			subordinates: config.subordinates?.map(s => ({
				name: s.name,
				sessionName: s.sessionName,
				role: s.role,
				memberId: s.memberId,
			})),
			agentSkillsPath,
			tlSkillsPath,
			projectRoot: this.projectRoot,
		};

		const assembler = new PromptAssemblyService();
		const { prompt, report } = await assembler.assemble(moduleConfig);

		this.logger.info('Modular prompt assembled', {
			sessionName: config.name,
			role: config.role,
			totalTokens: report.totalTokens,
			moduleCount: report.moduleBreakdown.length,
			truncatedCount: report.truncated.length,
			modules: report.moduleBreakdown.map(m => m.name),
		});

		return prompt;
	}

	/**
	 * Build memory context from agent and project memories
	 *
	 * @param agentId - Agent identifier
	 * @param projectPath - Project path
	 * @param options - Prompt options
	 * @returns Formatted memory context string
	 */
	async buildMemoryContext(
		agentId: string,
		projectPath: string,
		options: PromptOptions = {}
	): Promise<string> {
		try {
			const memoryService = this.getMemoryService();

			// Initialize memory for session if needed
			await memoryService.initializeForSession(
				agentId,
				options.role || 'developer',
				projectPath
			);

			// Get full context from memory service
			const fullContext = await memoryService.getFullContext(agentId, projectPath);

			if (!fullContext || fullContext.trim().length === 0) {
				this.logger.debug('No memory context available', { agentId, projectPath });
				return '';
			}

			this.logger.debug('Built memory context', {
				agentId,
				projectPath,
				contextLength: fullContext.length,
			});

			return `
## Your Knowledge Base

This is your accumulated knowledge from previous sessions. Use it to work more effectively.

${fullContext}

**Note:** You can add new knowledge using the \`remember\` tool and recall specific memories using the \`recall\` tool.
`.trim();
		} catch (error) {
			this.logger.warn('Failed to build memory context', {
				agentId,
				projectPath,
				error: error instanceof Error ? error.message : String(error),
			});
			return '';
		}
	}

	/**
	 * Build SOP context from relevant SOPs for the agent's role and task
	 *
	 * @param role - Agent's role
	 * @param taskContext - Current task context for SOP matching
	 * @param taskType - Type of task being performed
	 * @param limit - Maximum number of SOPs to include
	 * @returns Formatted SOP context string
	 */
	async buildSOPContext(
		role: string,
		taskContext?: string,
		taskType?: string,
		limit?: number
	): Promise<string> {
		try {
			const sopService = this.getSOPService();

			// Generate SOP context based on role and task
			const sopContext = await sopService.generateSOPContext({
				role: role as SOPRole | 'all',
				taskContext: taskContext || '',
				taskType,
				limit,
			});

			if (!sopContext || sopContext.trim().length === 0) {
				this.logger.debug('No SOP context available', { role, taskContext });
				return '';
			}

			this.logger.debug('Built SOP context', {
				role,
				taskContext,
				contextLength: sopContext.length,
			});

			return sopContext;
		} catch (error) {
			this.logger.warn('Failed to build SOP context', {
				role,
				taskContext,
				error: error instanceof Error ? error.message : String(error),
			});
			return '';
		}
	}

	/**
	 * Build the Team Lead responsibilities section for agents that can delegate.
	 *
	 * Loads the comprehensive TL management addon from `config/roles/team-leader/tl-addon.md`,
	 * resolves template variables (WORKER_LIST, TL_SKILLS_PATH, TEAM_ID, MEMBER_ID, PROJECT_PATH),
	 * and returns the formatted section. Falls back to a minimal inline section if the addon
	 * file is not found.
	 *
	 * This enables "auto-stacking": a developer with TL hierarchy gets BOTH their dev role
	 * prompt AND full management instructions without changing their role.
	 *
	 * @param config - Session config with optional TL fields
	 * @returns Formatted TL section string, or empty string if not a TL
	 */
	async buildTeamLeadSection(config: TeamMemberSessionConfig): Promise<string> {
		if (!config.canDelegate || !config.subordinates || config.subordinates.length === 0) {
			return '';
		}

		const workerList = this.buildWorkerList(config.subordinates);

		// Try loading the comprehensive TL addon from file
		const addonPath = path.join(this.rolesDirectory, 'team-leader', 'tl-addon.md');
		try {
			await access(addonPath);
			let addonContent = await readFile(addonPath, 'utf8');

			// Resolve template variables
			addonContent = this.replaceTemplateVariables(addonContent, {
				WORKER_LIST: workerList,
				TL_SKILLS_PATH: this.tlSkillsPath,
				TEAM_ID: config.teamId || '',
				MEMBER_ID: config.memberId || '',
				PROJECT_PATH: config.projectPath || '',
				AGENT_SKILLS_PATH: this.agentSkillsPath,
				// Pipeline Dogfood Amendment §3.5 — TL prompt references {{SESSION_NAME}}
				// in poll-tasks / schedule-followup invocations, so the addon now
				// participates in session-name substitution alongside the worker prompts.
				SESSION_NAME: config.name || 'unknown',
				SESSION_ID: config.name || 'unknown',
			});

			this.logger.info('Loaded TL addon from file', {
				sessionName: config.name,
				subordinateCount: config.subordinates.length,
				addonLength: addonContent.length,
			});

			return addonContent.trim();
		} catch {
			// Fallback to minimal inline section if addon file not found
			this.logger.warn('TL addon file not found, using inline fallback', {
				addonPath,
				sessionName: config.name,
			});

			return this.buildInlineTeamLeadSection(config.name, workerList, config.subordinates.length);
		}
	}

	/**
	 * Build a formatted worker list string from subordinate info.
	 *
	 * @param subordinates - Array of subordinate details
	 * @returns Formatted markdown list of workers
	 */
	private buildWorkerList(subordinates: SubordinateInfo[]): string {
		return subordinates
			.map((sub) => `- **${sub.name}** (session: \`${sub.sessionName}\`, memberId: \`${sub.memberId}\`) — ${sub.role}`)
			.join('\n');
	}

	/**
	 * Build a minimal inline TL section as fallback when tl-addon.md is not available.
	 *
	 * @param sessionName - The TL's session name
	 * @param workerList - Pre-formatted worker list
	 * @param subordinateCount - Number of subordinates
	 * @returns Formatted inline TL section
	 */
	private buildInlineTeamLeadSection(
		sessionName: string,
		workerList: string,
		subordinateCount: number
	): string {
		const section = `## Team Lead Responsibilities

You are the **Team Lead** for this team. You manage the following subordinates:

${workerList}

### Your TL Duties

1. **Task Decomposition** — Break down large Sprint-level tasks from the orchestrator into concrete, actionable sub-tasks
2. **Delegation** — Assign sub-tasks to subordinates using the \`send-message\` skill. Do NOT do work that a subordinate can handle
3. **Quality Review** — Review subordinates' work output before reporting completion upstream
4. **Progress Reporting** — Report overall Sprint progress to the orchestrator via \`report-status\`
5. **Unblocking** — Help subordinates when they are stuck or need guidance

### Delegation Guidelines

- **Delegate by default.** Only do work yourself when it requires TL-level judgment, cross-cutting coordination, or when no subordinate has the right skills.
- **Be specific.** Each delegated task should have a clear description, acceptance criteria, and priority.
- **Monitor progress.** Check on delegated tasks periodically using \`send-message\`.

### Task Assignment Template

When delegating a task to a subordinate, use this format:

\`\`\`
New task from TL:

[TASK] <concise task title>

Description: <what needs to be done, including acceptance criteria>
Priority: <high|normal|low>
Context: <any relevant background or links to related work>

Report back via report-status when done.
\`\`\``;

		this.logger.info('Built inline Team Lead section (fallback)', {
			sessionName,
			subordinateCount,
		});

		return section;
	}

	/**
	 * Build the team norms section for prompt injection.
	 *
	 * Loads norms from the team's norms directory (copied from template at team creation).
	 * Only includes norms whose role list matches the agent's role (or '*' for all).
	 *
	 * @param teamId - Team ID to load norms for
	 * @param role - Agent's role (used to filter norm applicability)
	 * @returns Formatted norms markdown, or empty string if no norms found
	 */
	async buildTeamNormsSection(teamId: string, role: string): Promise<string> {
		if (!teamId) return '';

		try {
			const { existsSync: exists, readdirSync, readFileSync } = await import('fs');
			const { join } = await import('path');

			const crewlyHome = join(process.env['HOME'] || '/tmp', '.crewly');
			const normsDir = join(crewlyHome, 'teams', teamId, 'norms');

			if (!exists(normsDir)) return '';

			// Try to load norms config from team config
			const configPath = join(crewlyHome, 'teams', teamId, 'config.json');
			let normsConfig: Array<{ file: string; trigger: string; roles: string[] }> = [];

			if (exists(configPath)) {
				try {
					const config = JSON.parse(readFileSync(configPath, 'utf-8'));
					normsConfig = config?.norms?.files || [];
				} catch {
					// Config parse failed — fall back to loading all .md files
				}
			}

			const sections: string[] = [];

			if (normsConfig.length > 0) {
				// Use config-driven loading with role filtering
				for (const norm of normsConfig) {
					const roleMatch = norm.roles.includes('*') || norm.roles.includes(role);
					if (!roleMatch) continue;

					const normPath = join(normsDir, norm.file);
					if (!exists(normPath)) continue;

					const content = readFileSync(normPath, 'utf-8');
					sections.push(content.trim());
				}
			} else {
				// Fallback: load all .md files in norms dir
				const files = readdirSync(normsDir).filter(f => f.endsWith('.md')).sort();
				for (const file of files) {
					const content = readFileSync(join(normsDir, file), 'utf-8');
					sections.push(content.trim());
				}
			}

			if (sections.length === 0) return '';

			this.logger.info('Built team norms section', { teamId, role, normCount: sections.length });

			return `\n## Team Norms & Standard Operating Procedures\n\nThe following norms are defined by your team template. Follow them strictly.\n\n${sections.join('\n\n---\n\n')}`;
		} catch (err) {
			this.logger.warn('Failed to load team norms', {
				teamId,
				error: err instanceof Error ? err.message : String(err),
			});
			return '';
		}
	}

	/**
	 * Build the memory routing rules section that tells agents where to store
	 * different types of knowledge.
	 *
	 * - User prefs / team conventions → Crewly `remember` with `scope: project`
	 * - Personal work patterns → Crewly `remember` with `scope: agent`
	 * - Temporary task notes → project files or Claude native memory
	 *
	 * @returns Formatted markdown section with memory routing guidance
	 */
	buildMemoryRoutingSection(): string {
		return `## Memory Routing Rules

When you learn something worth remembering, store it in the **right place**:

| What you learned | Where to store it | How |
|---|---|---|
| Team conventions, coding standards, project patterns, shared decisions | Crewly knowledge (project-wide) | \`remember\` with \`scope: "project"\`, \`category: "pattern"\` or \`"decision"\` |
| User preferences, working style, role-specific tips | Crewly knowledge (agent-specific) | \`remember\` with \`scope: "agent"\`, \`category: "preference"\` or \`"fact"\` |
| Gotchas, bugs, workarounds discovered during work | Crewly knowledge (project-wide) | \`remember\` with \`scope: "project"\`, \`category: "gotcha"\` |
| Temporary task notes, in-progress state, scratch data | Project files or Claude native memory | Write to a file in the project, or keep in your conversation context |

**Rules of thumb:**
- If another agent or a future session would benefit → use \`remember\` with \`scope: "project"\`
- If only YOU would benefit in future sessions → use \`remember\` with \`scope: "agent"\`
- If it's only useful right now → keep it in your conversation context or a scratch file
- **Never store secrets, credentials, or tokens** in any memory system`;
	}

	/**
	 * Compose a prompt with memory and SOP context included
	 *
	 * @param parts - Prompt parts to compose
	 * @returns Composed prompt string
	 */
	private composePromptWithMemory(parts: PromptParts): string {
		const sections: string[] = [];

		// Add base prompt
		sections.push(parts.basePrompt);

		// Add memory context if available
		if (parts.memoryContext && parts.memoryContext.trim()) {
			sections.push('\n---\n');
			sections.push(parts.memoryContext);
		}

		// Add SOP context if available
		if (parts.sopContext && parts.sopContext.trim()) {
			sections.push('\n---\n');
			sections.push(parts.sopContext);
		}

		// Add Team Lead responsibilities if applicable
		if (parts.teamLeadContext && parts.teamLeadContext.trim()) {
			sections.push('\n---\n');
			sections.push(parts.teamLeadContext);
		}

		// Add Team Norms if available
		if (parts.teamNormsContext && parts.teamNormsContext.trim()) {
			sections.push('\n---\n');
			sections.push(parts.teamNormsContext);
		}

		// Add agent identity section
		if (parts.sessionName || parts.memberId || parts.role) {
			sections.push('\n---\n');
			sections.push('## Your Identity');
			if (parts.sessionName) sections.push(`- **Session Name:** ${parts.sessionName}`);
			if (parts.memberId) sections.push(`- **Member ID:** ${parts.memberId}`);
			if (parts.role) sections.push(`- **Role:** ${parts.role}`);
			if (parts.teamId) sections.push(`- **Team:** ${parts.teamId}`);
			if (parts.projectPath) sections.push(`- **Project Path:** ${parts.projectPath}`);
		}

		// Add memory routing rules
		sections.push('\n---\n');
		sections.push(this.buildMemoryRoutingSection());

		// Add communication instructions
		sections.push('\n---\n');
		sections.push(`## Communication

Use bash skills at \`${this.agentSkillsPath}/\` for all team communication. Read \`~/.crewly/skills/AGENT_SKILLS_CATALOG.md\` for a full reference.
- \`send-message\` to communicate with other agents
- \`report-progress\` to update on task status
- \`remember\` to store important learnings (always pass your \`agentId\` and \`projectPath\`)
- \`recall\` to retrieve relevant knowledge (always pass your \`agentId\` and \`projectPath\`)
- \`record-learning\` to record learnings (always pass your \`agentId\` and \`projectPath\`)
- \`get-sops\` to request relevant SOPs for your current situation

**IMPORTANT for memory tools:** When calling \`remember\`, \`recall\`, or \`record-learning\`, you MUST pass:
- \`agentId\`: Your **Session Name** from the Identity section above
- \`projectPath\`: Your **Project Path** from the Identity section above
This ensures your knowledge is stored under your identity and in the correct project.

**IMPORTANT for recall:** Before answering questions about the project, deployment, architecture, or past decisions, ALWAYS call \`recall\` first to check your stored knowledge.`);

		// Add anti-deliberation instructions for Gemini CLI agents
		if (parts.runtimeType === 'gemini-cli') {
			sections.push('\n---\n');
			sections.push(`## Execution Discipline

**IMPORTANT:** Execute tool calls immediately. Do not plan more than 3 tool calls at once.
Never use phrases like "Wait, I'll also...", "Actually, I'll...", or "Let me also check..." — just execute your tools directly.
Read files ONE AT A TIME, do not try to batch plan multiple reads.
If you catch yourself deliberating about what to do next, STOP and execute the most obvious next action immediately.
Action over deliberation — a wrong tool call is better than no tool call.`);
		}

		// Add language matching instruction
		sections.push('\n---\n');
		sections.push(`## Language Matching

**IMPORTANT:** Always reply in the same language the user writes in. If the user sends a message in Chinese, reply in Chinese. If the user writes in English, reply in English. Match the language of each individual message — do not default to English unless the user is writing in English.`);

		return sections.join('\n').trim();
	}

	/**
	 * Build the mandatory session recovery protocol section that instructs agents
	 * to execute context recovery commands immediately after registration.
	 *
	 * This section is injected into ALL agent registration prompts (both regular
	 * agents and orchestrator) to ensure agents always recover context on startup.
	 * The agent will run `recall` and `get-my-context` to load previous knowledge,
	 * then report any unfinished work before accepting new tasks.
	 *
	 * @param sessionName - Agent's session name (used as agentId in skill calls)
	 * @param role - Agent's role
	 * @param projectPath - Absolute path to the project
	 * @returns Formatted markdown section with executable bash commands
	 */
	buildSessionRecoverySection(sessionName: string, role: string, projectPath: string): string {
		const section = `## Session Recovery Protocol (MANDATORY)

**IMMEDIATELY after registering**, you MUST execute the following context recovery steps before saying "Ready" or accepting any tasks. This ensures you recover context from previous sessions and avoid repeating work or missing ongoing tasks.

### Step 1: Recall previous knowledge
\`\`\`bash
bash ${this.agentSkillsPath}/core/recall/execute.sh '{"agentId":"${sessionName}","context":"${role} session startup, recent tasks, unfinished work, blockers, key decisions","projectPath":"${projectPath}"}'
\`\`\`

### Step 1.5: Read your active work (authoritative state)
The system has already injected your current Requests + WorkItems above
under \`## Your Active Work\` — that section is the source of truth.
**State always wins over memory.** If a row carries a \`(memory: ...)\` annotation,
the state value is what you should act on; the memory note flags a divergence
to investigate, not to override the state.

Call this skill mid-session if the briefing was truncated (\`... and X more\` marker)
or stale (>5 minutes since registration, especially after long-running tasks):
\`\`\`bash
bash ${this.agentSkillsPath}/core/get-my-active-work/execute.sh --session ${sessionName} --role ${role}
\`\`\`

### Step 2: Load your full context
\`\`\`bash
bash ${this.agentSkillsPath}/core/get-my-context/execute.sh '{"agentId":"${sessionName}","agentRole":"${role}","projectPath":"${projectPath}"}'
\`\`\`

### Step 3: Register yourself as active
**CRITICAL:** You MUST call register-self to transition your status from "started" to "active". The system will NOT deliver any messages (Slack, tasks, etc.) to you until you register. Run this BEFORE reporting status:
\`\`\`bash
bash ${this.agentSkillsPath}/core/register-self/execute.sh '{"sessionName":"${sessionName}","role":"${role}"}'
\`\`\`

### Step 4: Assess and report
After reviewing the results from Steps 1-3:
1. **Check for unfinished work** — If you find tasks that were in progress but not completed, note them
2. **Check for pending blockers** — If previous sessions recorded blockers, note them
3. **Report status** — Include a brief summary of recovered context in your first status message

**Do NOT skip these steps.** Context recovery prevents duplicate work and ensures continuity across sessions.`;

		this.logger.debug('Built session recovery section', {
			sessionName,
			role,
			projectPath,
			sectionLength: section.length,
		});

		return section;
	}

	/**
	 * Build a continuation prompt for when an agent needs to resume work
	 *
	 * @param agentId - Agent identifier
	 * @param role - Agent's role
	 * @param projectPath - Project path
	 * @param currentTask - Current task being worked on
	 * @param taskContext - Optional task context for SOP matching
	 * @returns Continuation prompt string
	 */
	async buildContinuationPrompt(
		agentId: string,
		role: string,
		projectPath: string,
		currentTask: { title: string; description?: string },
		taskContext?: string
	): Promise<string> {
		const memoryContext = await this.buildMemoryContext(agentId, projectPath, { role });

		// Build SOP context based on task description/context
		const sopContextInput = taskContext || currentTask.description || currentTask.title;
		const sopContext = await this.buildSOPContext(role, sopContextInput);

		const sections: string[] = ['# Continue Your Work', ''];

		if (memoryContext) {
			sections.push(memoryContext);
			sections.push('');
		} else {
			sections.push('(No prior memory context available)');
			sections.push('');
		}

		sections.push(`## Current Task`);
		sections.push(`**${currentTask.title}**`);
		if (currentTask.description) {
			sections.push('');
			sections.push(currentTask.description);
		}
		sections.push('');

		if (sopContext) {
			sections.push('---');
			sections.push('');
			sections.push(sopContext);
			sections.push('');
		}

		sections.push(`## Instructions`);
		sections.push('');
		sections.push('1. Review your progress so far');
		sections.push('2. Follow the SOPs above for guidance');
		sections.push('3. Continue working on the task');
		sections.push('4. Run quality checks before marking complete');
		sections.push(`5. Run \`bash ${this.agentSkillsPath}/complete-task/execute.sh\` when ALL gates pass`);

		return sections.join('\n').trim();
	}

	/**
	 * Load registration prompt from config files
	 * Loads from config/roles/{role}/prompt.md
	 */
	async loadRegistrationPrompt(
		role: string,
		sessionName: string,
		memberId?: string
	): Promise<string> {
		try {
			// Normalize role name to directory name format
			const roleName = role.toLowerCase().replace(/\s+/g, '-');
			const promptPath = path.join(this.rolesDirectory, roleName, 'prompt.md');
			let prompt = await readFile(promptPath, 'utf8');

			// Replace template variables
			const variables: Record<string, string> = {
				SESSION_NAME: sessionName,
				SESSION_ID: sessionName,
				ROLE: role,
				AGENT_SKILLS_PATH: this.agentSkillsPath,
			};

			if (memberId) {
				variables.MEMBER_ID = memberId;
			}

			prompt = this.replaceTemplateVariables(prompt, variables);

			// For orchestrator or cases without member ID, remove the memberId parameter
			if (!memberId) {
				prompt = prompt.replace(/,\s*"memberId":\s*"\{\{MEMBER_ID\}\}"/g, '');
			}

			this.logger.debug('Loaded registration prompt', {
				role,
				sessionName,
				hasMemberId: !!memberId,
				promptLength: prompt.length,
			});

			return prompt;
		} catch (error) {
			// Fallback to inline prompt if file doesn't exist
			this.logger.warn('Could not load registration prompt from config, using fallback', {
				role,
				error: error instanceof Error ? error.message : String(error),
			});

			const memberIdParam = memberId ? `,"teamMemberId":"${memberId}"` : '';

			return `# Crewly Agent Registration

You are running in the **Crewly multi-agent orchestration environment**.

## Registration Required

**IMMEDIATELY** register yourself with the Crewly system using the register-self bash skill:

\`\`\`bash
bash ${this.agentSkillsPath}/register-self/execute.sh '{"role":"${role}","sessionName":"${sessionName}"${memberIdParam}}'
\`\`\`

After registering, read the agent skills catalog for a full reference of available skills:
\`\`\`bash
cat ~/.crewly/skills/AGENT_SKILLS_CATALOG.md
\`\`\`

**IMPORTANT:** You MUST complete registration before proceeding.

## Instructions

After successful registration, respond with:
\`\`\`
Agent registered and awaiting instructions from orchestrator.
Environment: Crewly
Role: ${role}
Status: Active and ready for task assignments
\`\`\`

Then wait for explicit task assignments from the orchestrator.`;
		}
	}

	/**
	 * Build a fallback system prompt when role-specific prompt is not found
	 */
	private buildFallbackSystemPrompt(config: TeamMemberSessionConfig): string {
		const fallbackPrompt = `Hey! I need your help with ${config.role} tasks on this project.

## Quick context about this setup

This project uses Crewly for team coordination. You have bash skills available at \`${this.agentSkillsPath}/\` that communicate with the Crewly backend running locally. Read the skills catalog at \`~/.crewly/skills/AGENT_SKILLS_CATALOG.md\` for a full reference of available skills.

## First thing - please check in

Please run the register-self skill to let the team dashboard know you're available:
\`\`\`bash
bash ${this.agentSkillsPath}/register-self/execute.sh '{"role":"${config.role}","sessionName":"${config.name}"}'
\`\`\`
All it does is update a local status flag so the web UI shows you as online - nothing more.

After checking in, just say "Ready for tasks" and wait for me to send you work.

## Project context
- Session: ${config.name}
- Project Path: ${config.projectPath || 'Not specified'}
`;

		this.logger.info('Built fallback system prompt', {
			role: config.role,
			promptLength: fallbackPrompt.length,
		});

		return fallbackPrompt.trim();
	}

	/**
	 * Replace template variables in prompt content
	 */
	private replaceTemplateVariables(
		content: string,
		variables: Record<string, string>
	): string {
		let result = content;

		for (const [key, value] of Object.entries(variables)) {
			const placeholder = `{{${key}}}`;
			result = result.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), value);
		}

		this.logger.debug('Replaced template variables', {
			variableCount: Object.keys(variables).length,
			variables: Object.keys(variables),
		});

		return result;
	}

	/**
	 * Load prompt template from file
	 *
	 * Loads from config/roles/{roleName}/prompt.md or by full file name for backwards compatibility.
	 * Checks for user override files in ~/.crewly/roles/{roleName}/prompt.md first.
	 *
	 * @param fileNameOrRole - Either a role name (e.g., 'orchestrator') or legacy file name (e.g., 'orchestrator-prompt.md')
	 * @returns The prompt content, or null if not found
	 */
	async loadPromptTemplate(fileNameOrRole: string): Promise<string | null> {
		try {
			// Try to get role from RoleService
			const roleService = getRoleService();
			const roleName = fileNameOrRole.replace(/-prompt\.md$/, '').toLowerCase().replace(/\s+/g, '-');

			const roleWithPrompt = await roleService.getRoleByName(roleName);
			if (roleWithPrompt && roleWithPrompt.systemPromptContent) {
				this.logger.debug('Loaded prompt template from RoleService', {
					roleName,
					contentLength: roleWithPrompt.systemPromptContent.length,
				});
				return roleWithPrompt.systemPromptContent;
			}

			// Fall back to direct file read from roles directory
			const filePath = path.join(this.rolesDirectory, roleName, 'prompt.md');
			const content = await readFile(filePath, 'utf8');

			this.logger.debug('Loaded prompt template', {
				roleName,
				contentLength: content.length,
				source: 'direct-file',
			});

			return content;
		} catch (error) {
			this.logger.warn('Failed to load prompt template', {
				fileNameOrRole,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	/**
	 * Check if a prompt template exists for a role
	 */
	async promptTemplateExists(roleName: string): Promise<boolean> {
		try {
			const normalizedName = roleName.replace(/-prompt\.md$/, '').toLowerCase().replace(/\s+/g, '-');
			const filePath = path.join(this.rolesDirectory, normalizedName, 'prompt.md');
			await access(filePath);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Get the path to the roles directory
	 */
	getRolesDirectory(): string {
		return this.rolesDirectory;
	}

	/**
	 * Build a prompt for project start communication to orchestrator
	 */
	buildProjectStartPrompt(projectData: {
		projectName: string;
		projectPath: string;
		teamDetails: { name?: string; members?: Array<{ name: string; role: string; skills?: string }> };
		requirements?: string;
	}): string {
		return this.buildOrchestratorPrompt(projectData);
	}

	/**
	 * Build a task assignment prompt
	 */
	buildTaskAssignmentPrompt(task: {
		id: string;
		title: string;
		description: string;
		assigneeRole: string;
		priority: 'high' | 'medium' | 'low';
		estimatedHours?: number;
	}): string {
		const prompt = `
## New Task Assignment

**Task ID**: ${task.id}
**Title**: ${task.title}
**Assigned to**: ${task.assigneeRole}
**Priority**: ${task.priority.toUpperCase()}
${task.estimatedHours ? `**Estimated Hours**: ${task.estimatedHours}` : ''}

**Description**:
${task.description}

Please acknowledge receipt of this task and provide an estimated completion timeline.
`;

		this.logger.debug('Built task assignment prompt', {
			taskId: task.id,
			assigneeRole: task.assigneeRole,
			priority: task.priority,
		});

		return prompt.trim();
	}

	/**
	 * Build a status update request prompt
	 */
	buildStatusUpdatePrompt(sessionName: string, role: string): string {
		const prompt = `
## Status Update Request

Please provide a brief status update on your current work:

1. **Current Task**: What are you currently working on?
2. **Progress**: What percentage complete is your current task?
3. **Blockers**: Are there any issues preventing progress?
4. **Next Steps**: What will you work on next?
5. **ETA**: When do you expect to complete your current task?

Keep your response concise and factual.
`;

		this.logger.debug('Built status update prompt', {
			sessionName,
			role,
		});

		return prompt.trim();
	}
}