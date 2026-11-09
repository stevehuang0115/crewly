import * as path from 'path';
import { PromptModule, ModuleConfig, loadRoleFragment } from './prompt-module.interface.js';
import { ACTIVE_WORK_HEADING } from './active-work.module.js';

/**
 * Recovery module — unified session recovery protocol.
 *
 * Consolidates the restart/recovery flow that was previously scattered
 * across prompt-builder.service.ts buildSessionRecoverySection(),
 * agent-registration.service.ts hardcoded commands, role prompts
 * (Session Recovery Protocol), and session-handoff.service.ts.
 *
 * Produces the mandatory startup sequence: get-my-context (one memory search, #857) → active work → register → assess.
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
		// The fragment carries {{ORCHESTRATOR_SKILLS_PATH}} / {{AGENT_SKILLS_PATH}}
		// placeholders (memory skills such as recall live under agent/core, not
		// under the orchestrator namespace — server-install finding 12) plus the
		// session/project placeholders; loadRoleFragment returns the file as-is,
		// so resolve them here exactly like communication.module does.
		if (config.role === 'orchestrator') {
			const fragment = loadRoleFragment(config.projectRoot, config.role, 'recovery');
			if (fragment) {
				const orchestratorSkillsPath = path.join(config.projectRoot, 'config', 'skills', 'orchestrator');
				return fragment
					.replace(/\{\{ORCHESTRATOR_SKILLS_PATH\}\}/g, orchestratorSkillsPath)
					.replace(/\{\{AGENT_SKILLS_PATH\}\}/g, config.agentSkillsPath)
					.replace(/\{\{SESSION_ID\}\}/g, config.sessionName)
					.replace(/\{\{SESSION_NAME\}\}/g, config.sessionName)
					.replace(/\{\{PROJECT_PATH\}\}/g, config.projectPath || config.projectRoot);
			}
		}

		const agentId = config.sessionName;
		const role = config.role;
		const projectPath = config.projectPath || config.projectRoot;
		const skillsPath = config.agentSkillsPath;

		return `## Session Recovery Protocol (MANDATORY)

**IMMEDIATELY after registering**, you MUST execute the following context recovery steps before saying "Ready" or accepting any tasks. This ensures you recover context from previous sessions and avoid repeating work or missing ongoing tasks.

### Step 1: Load your context (one memory search)
\`get-my-context\` runs your memory recall for you and adds goals, focus, today's log,
learnings and your own task timings. Do **not** run \`recall\` separately at startup —
that is the same search twice (#857). If a \`## Standing Answers\` section appears above,
it already answers the recurring questions (decisions in force, open gotchas, your
unfinished work); this step fills in the rest.
\`\`\`bash
bash ${skillsPath}/core/get-my-context/execute.sh '{"agentId":"${agentId}","agentRole":"${role}","projectPath":"${projectPath}","context":"${role} session startup, recent tasks, unfinished work, blockers, key decisions"}'
\`\`\`

### Step 2: Read your active work (authoritative state)
Your current Requests + WorkItems are in the \`${ACTIVE_WORK_HEADING}\` section above
(and, when there is one, your session memory is under \`## Your Previous Knowledge\`).
That section is the source of truth. **State always wins over memory.** If a row
carries a \`(memory: ...)\` annotation, the state value is what you should act on;
the memory note flags a divergence to investigate, not to override the state.

It already lists every task of yours that is still open — do not fetch your task
history (\`get-my-tasks\`) on top of it. For a task you were in the middle of,
\`read-task\` shows its workingNotes (your hypothesis, what you tried, where you left
off): resume from there, don't restart from scratch.

Run this skill now if that section says it was **not injected**, and mid-session if
the briefing was truncated (\`... and X more\` marker) or stale (>5 minutes since
registration, especially after long-running tasks):
\`\`\`bash
bash ${skillsPath}/core/get-my-active-work/execute.sh --session ${agentId} --role ${role}
\`\`\`

### Step 3: Register yourself as active
**CRITICAL:** You MUST call register-self to transition your status from "started" to "active". The system will NOT deliver any messages (Slack, tasks, etc.) to you until you register. Run this BEFORE reporting status:
\`\`\`bash
bash ${skillsPath}/core/register-self/execute.sh '{"sessionName":"${agentId}","role":"${role}"}'
\`\`\`

### Step 4: Assess and report
After reviewing the results from Steps 1-2:
1. **Check for unfinished work** — If you find tasks that were in progress but not completed, note them
2. **Check for pending blockers** — If previous sessions recorded blockers, note them
3. **Report status** — Include a brief summary of recovered context in your first status message

**Do NOT skip these steps.** Context recovery prevents duplicate work and ensures continuity across sessions.`;
	}
}
