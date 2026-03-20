import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * Memory reference module — tells the agent how to access and store memories.
 *
 * Consolidates memory routing rules and session recovery protocol
 * into a single module. Contains "how-to" instructions, not actual data.
 *
 * Sources: Path A Steps 8+9, Path B Section 7.
 */
export class MemoryReferenceModule implements PromptModule {
	name = 'memory_references';
	priority = 4;
	maxTokens = 500;
	compactable = false;

	/**
	 * Always included — memory access is fundamental to agent continuity.
	 */
	shouldInclude(_config: ModuleConfig): boolean {
		return true;
	}

	/**
	 * Build the memory reference section with routing rules
	 * that tell the agent where to store different types of knowledge.
	 *
	 * @param config - Module configuration
	 * @returns Formatted markdown memory reference section
	 */
	async build(_config: ModuleConfig): Promise<string> {
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
}
