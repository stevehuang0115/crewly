import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * Project reference module — tells the agent how to access project knowledge.
 *
 * Provides references to SOPs, OKR, tasks/tickets, and project specs.
 * Contains "how-to" instructions only — actual SOP content is loaded
 * as context at runtime.
 *
 * Sources: Path B Section 3 (SOP context reference).
 */
export class ProjectReferenceModule implements PromptModule {
	name = 'project_references';
	priority = 7;
	maxTokens = 400;
	compactable = true;

	/**
	 * Include when agent has a project path.
	 */
	shouldInclude(config: ModuleConfig): boolean {
		return !!config.projectPath;
	}

	/**
	 * Build the project reference section with instructions on
	 * how to access SOPs, project goals, and specifications.
	 *
	 * @param config - Module configuration with project path
	 * @returns Formatted markdown project reference section
	 */
	async build(config: ModuleConfig): Promise<string> {
		return `## Project References

### Standards
- Follow established code style and conventions
- TypeScript strict mode, aim for 80%+ test coverage
- Follow secure coding practices (parameterized queries, input sanitization, output encoding)
- Descriptive commit messages, atomic commits

### SOPs
Load relevant Standard Operating Procedures for your current task:
\`\`\`bash
bash ${config.agentSkillsPath}/core/get-sops/execute.sh '{"context":"<describe your current task>","role":"${config.role}"}'
\`\`\`

### Project Knowledge
- Project specs: \`${config.projectPath}/.crewly/specs/\`
- Active goals: \`${config.projectPath}/.crewly/goals/goals.md\`
- Task management: \`${config.projectPath}/.crewly/tasks/\`
- Knowledge base: \`${config.projectPath}/.crewly/knowledge/\``;
	}
}
