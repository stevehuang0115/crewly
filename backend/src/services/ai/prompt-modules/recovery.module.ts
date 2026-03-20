import { PromptModule, ModuleConfig, loadRoleFragment } from './prompt-module.interface.js';

/**
 * Recovery module — unified session recovery protocol.
 *
 * Consolidates the restart/recovery flow that was previously scattered
 * across prompt-builder.service.ts buildSessionRecoverySection(),
 * agent-registration.service.ts hardcoded commands, role prompts
 * (Session Recovery Protocol), and session-handoff.service.ts.
 *
 * Produces the mandatory startup sequence: recall → get-my-context → assess.
 * This module is non-compactable because skipping recovery causes
 * duplicate work and lost context.
 *
 * Sources: Path A Step 9, prompt-builder buildSessionRecoverySection(),
 *          developer/prompt.md §Session Recovery Protocol.
 */
export class RecoveryModule implements PromptModule {
	name = 'recovery';
	priority = 2;
	maxTokens = 600;
	compactable = false;

	/**
	 * Always included — every agent needs session recovery.
	 */
	shouldInclude(_config: ModuleConfig): boolean {
		return true;
	}

	/**
	 * Build the session recovery protocol with executable bash commands.
	 *
	 * @param config - Module configuration with agent identity
	 * @returns Formatted markdown recovery section
	 */
	async build(config: ModuleConfig): Promise<string> {
		// Try loading role-specific fragment (orchestrator has a different startup flow)
		if (config.role === 'orchestrator') {
			const fragment = loadRoleFragment(config.projectRoot, config.role, 'recovery');
			if (fragment) {
				return fragment;
			}
		}

		const agentId = config.sessionName;
		const role = config.role;
		const projectPath = config.projectPath || config.projectRoot;
		const skillsPath = config.agentSkillsPath;

		return `## Session Recovery Protocol (MANDATORY)

**IMMEDIATELY after registering**, you MUST execute the following context recovery steps before saying "Ready" or accepting any tasks. This ensures you recover context from previous sessions and avoid repeating work or missing ongoing tasks.

### Step 1: Recall previous knowledge
\`\`\`bash
bash ${skillsPath}/core/recall/execute.sh '{"agentId":"${agentId}","context":"${role} session startup, recent tasks, unfinished work, blockers, key decisions","projectPath":"${projectPath}"}'
\`\`\`

### Step 2: Load your full context
\`\`\`bash
bash ${skillsPath}/core/get-my-context/execute.sh '{"agentId":"${agentId}","agentRole":"${role}","projectPath":"${projectPath}"}'
\`\`\`

### Step 3: Assess and report
After reviewing the results from Steps 1 and 2:
1. **Check for unfinished work** — If you find tasks that were in progress but not completed, note them
2. **Check for pending blockers** — If previous sessions recorded blockers, note them
3. **Report status** — Include a brief summary of recovered context in your first status message

**Do NOT skip these steps.** Context recovery prevents duplicate work and ensures continuity across sessions.`;
	}
}
