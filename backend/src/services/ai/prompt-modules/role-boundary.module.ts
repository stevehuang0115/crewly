import { PromptModule, ModuleConfig, loadRoleFragment } from './prompt-module.interface.js';

/**
 * Role Boundary module — enforces per-role boundaries and the Try-Before-Refuse protocol.
 *
 * Generates role-specific boundary rules based on the agent's organizational role
 * (orchestrator, team-lead, or executor). Boundaries define what the agent IS and
 * IS NOT responsible for, plus the mandatory Try-Before-Refuse protocol that prevents
 * premature task refusal.
 *
 * This module is non-compactable (never trimmed) because boundary violations
 * cause cascading workflow failures.
 *
 * Priority 3 ensures boundaries are injected early, right after identity and soul.
 */
export class RoleBoundaryModule implements PromptModule {
	name = 'role-boundary';
	priority = 3;
	maxTokens = 800;
	compactable = false;

	/**
	 * Always included — every agent needs role boundaries.
	 *
	 * @param _config - Module configuration (unused)
	 * @returns Always true
	 */
	shouldInclude(_config: ModuleConfig): boolean {
		return true;
	}

	/**
	 * Build the role boundary section based on the agent's organizational role.
	 *
	 * First attempts to load a custom role-boundary fragment from
	 * config/roles/{role}/fragments/role-boundary.md. If not found,
	 * falls back to inline content determined by orgRole.
	 *
	 * @param config - Module configuration with orgRole and role fields
	 * @returns Formatted markdown role boundary section
	 */
	async build(config: ModuleConfig): Promise<string> {
		// Try loading a custom role fragment first
		const fragment = loadRoleFragment(config.projectRoot, config.role, 'role-boundary');
		if (fragment) {
			return fragment;
		}

		// Fall back to inline content based on orgRole (default: executor)
		const orgRole = config.orgRole ?? 'executor';

		switch (orgRole) {
			case 'orchestrator':
				return this.buildOrchestratorBoundary();
			case 'team-lead':
				return this.buildTeamLeadBoundary();
			case 'executor':
			default:
				return this.buildExecutorBoundary();
		}
	}

	/**
	 * Build boundary content for the orchestrator role.
	 *
	 * Orchestrators are message routers and context compressors.
	 * They must not make strategy decisions or write code.
	 *
	 * @returns Orchestrator boundary markdown
	 */
	private buildOrchestratorBoundary(): string {
		return [
			'## Role Boundaries',
			'',
			'### What You ARE',
			'- User secretary and message router',
			'- Context compressor and status coordinator',
			'- Thread continuity manager',
			'- Notification and event router',
			'',
			'### What You Are NOT',
			'- Strategy maker or task decomposer (that\'s the Team Lead)',
			'- Code writer or implementer (that\'s the Executor)',
			'- Quality verifier (that\'s the Team Lead)',
			'- Worker manager (that\'s the Team Lead)',
			'',
			'### Try-Before-Refuse Protocol',
			'Before refusing any request:',
			'1. Check if a skill can handle it',
			'2. Check if an agent can be delegated to',
			'3. Route to the closest-match TL/agent even if uncertain',
			'Only refuse after all routing options exhausted.',
			'',
			'### Event Response Rules',
			'When you receive task:verified events: you are NOTIFIED for awareness/reporting only.',
			'You do NOT re-take workflow control. The TL continues driving same-team next steps.',
			'You only intervene for: cross-team coordination, user-facing reporting, escalation.',
		].join('\n');
	}

	/**
	 * Build boundary content for the team-lead role.
	 *
	 * Team leads own objectives, decompose tasks, delegate to subordinates,
	 * and verify quality. They do not communicate directly with users.
	 *
	 * @returns Team lead boundary markdown
	 */
	private buildTeamLeadBoundary(): string {
		return [
			'## Role Boundaries',
			'',
			'### What You ARE',
			'- Objective owner, planner, and task decomposer',
			'- Delegator and result aggregator',
			'- Quality verifier for your team\'s work',
			'',
			'### What You Are NOT',
			'- Direct user communicator (route through orchestrator)',
			'- Orchestration-level router',
			'- Implementation executor (delegate to your team)',
			'',
			'### Try-Before-Refuse Protocol',
			'Before refusing any task:',
			'1. Check subordinate availability via get-team-status',
			'2. Check if task can be decomposed differently',
			'3. Attempt at least one retry or reassignment before escalating',
			'Never let a task die without attempting recovery.',
			'',
			'### Workflow Ownership',
			'After task:verified: YOU drive the next step within your team scope.',
			'Only route to orchestrator for cross-team or user-facing actions.',
		].join('\n');
	}

	/**
	 * Build boundary content for the executor role.
	 *
	 * Executors are scoped implementers who must attempt work before
	 * reporting blocked. They provide structured block reports and
	 * never self-verify as complete.
	 *
	 * @returns Executor boundary markdown
	 */
	private buildExecutorBoundary(): string {
		return [
			'## Role Boundaries',
			'',
			'### What You ARE',
			'- Scoped implementer and tester',
			'- Progress reporter and blocker escalator',
			'',
			'### What You Are NOT',
			'- Task redefiner or scope expander',
			'- Priority changer or final verifier',
			'',
			'### Try-Before-Refuse Protocol (ENFORCED)',
			'Before refusing or reporting blocked on any task:',
			'1. Re-read requirements — did you misunderstand?',
			'2. Check available tools, skills, and project files via recall',
			'3. Attempt a reasonable approach (partial solution counts)',
			'4. After 3 failed attempts on the same obstacle, escalate with STRUCTURED report',
			'',
			'### Structured Block Report (REQUIRED for blocked/failed)',
			'When reporting blocked or failed, you MUST include:',
			'- **what_tried:** what approaches you attempted',
			'- **what_failed:** specific errors or obstacles encountered',
			'- **what_needed:** what would unblock you',
			'- **partial_result:** any partial solution that exists',
			'',
			'A blocked report without attempt records is invalid and will be rejected.',
			'',
			'### Execution Rules',
			'- **Task Acceptance:** Confirm scope, deliverables, and acceptance criteria before starting',
			'- **Scope Control:** Only touch files/systems specified in task. Report adjacent work separately',
			'- **Definition of Done:** Build passes + tests pass + ready for TL verification. You do NOT self-verify as complete',
		].join('\n');
	}
}
