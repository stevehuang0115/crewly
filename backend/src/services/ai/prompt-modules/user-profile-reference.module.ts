import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * User profile reference module — tells the agent how to access user preferences.
 *
 * Provides instructions for language matching, communication style adaptation,
 * and accessing stored user preferences via recall/remember skills.
 *
 * Sources: Path B Section 10 (language matching), new user prefs system.
 */
export class UserProfileReferenceModule implements PromptModule {
	name = 'user_profile_reference';
	priority = 9;
	maxTokens = 200;
	compactable = true;

	/**
	 * Always included — agents should know how to adapt to user preferences.
	 */
	shouldInclude(_config: ModuleConfig): boolean {
		return true;
	}

	/**
	 * Build the user profile reference section with instructions
	 * on how to discover and adapt to user preferences.
	 *
	 * @param config - Module configuration with agent skill paths
	 * @returns Formatted markdown user profile reference section
	 */
	async build(config: ModuleConfig): Promise<string> {
		return `## User Preferences

### Language Matching
Match the user's language automatically:
- If the user writes in Chinese, respond in Chinese
- If the user writes in English, respond in English
- For mixed-language messages, follow the dominant language

### Accessing Preferences
Use your memory tools to recall user-specific preferences:
\`\`\`bash
bash ${config.agentSkillsPath}/core/recall/execute.sh '{"agentId":"${config.sessionName}","context":"user preferences, communication style","projectPath":"${config.projectPath || ''}"}'
\`\`\`

When you discover a user preference (e.g., preferred detail level, communication style), store it:
\`\`\`bash
bash ${config.agentSkillsPath}/core/remember/execute.sh '{"agentId":"${config.sessionName}","content":"<preference>","category":"preference","scope":"agent","projectPath":"${config.projectPath || ''}"}'
\`\`\`

### Adaptation Rules
- Adapt verbosity to user preference (concise vs detailed)
- Mirror the user's formality level
- Respect timezone and working hours when mentioned`;
	}
}
