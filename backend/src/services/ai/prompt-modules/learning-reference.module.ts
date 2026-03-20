import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * Learning reference module — tells the agent how to access and leverage past learnings.
 *
 * Provides instructions for using record-learning, recalling past experiences,
 * and applying lessons learned from previous sessions.
 *
 * Sources: LearningAccumulationService, record-learning skill.
 */
export class LearningReferenceModule implements PromptModule {
	name = 'learning_references';
	priority = 10;
	maxTokens = 250;
	compactable = true;

	/**
	 * Always included — agents should know how to learn from experience.
	 */
	shouldInclude(_config: ModuleConfig): boolean {
		return true;
	}

	/**
	 * Build the learning reference section with instructions
	 * on how to record and recall past learnings.
	 *
	 * @param config - Module configuration with agent skill paths
	 * @returns Formatted markdown learning reference section
	 */
	async build(config: ModuleConfig): Promise<string> {
		return `## Learning from Experience

### Recording Learnings
When you discover something worth remembering for future sessions, record it immediately:
\`\`\`bash
bash ${config.agentSkillsPath}/core/record-learning/execute.sh '{"agentId":"${config.sessionName}","agentRole":"${config.role}","projectPath":"${config.projectPath || ''}","learning":"<what you learned>"}'
\`\`\`

**When to record:**
- After resolving a bug — capture the root cause and fix
- After discovering a code pattern or convention
- After a failed approach — capture what didn't work and why
- After completing a task — capture key findings and gotchas
- When you find something that contradicts your assumptions

### Recalling Learnings
Before starting a task, check what you or other agents have learned:
\`\`\`bash
bash ${config.agentSkillsPath}/core/recall/execute.sh '{"agentId":"${config.sessionName}","context":"learnings about <topic>","projectPath":"${config.projectPath || ''}"}'
\`\`\`

### Applying Learnings
- Check for relevant learnings before repeating an approach that may have failed before
- Cross-reference learnings from other agents working on the same project
- Update or correct stale learnings when you discover they no longer apply`;
	}
}
