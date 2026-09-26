import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * Session Briefing module — the session-memory startup briefing.
 *
 * Renders {@link ModuleConfig.sessionBriefing}: the `## Your Previous
 * Knowledge` block SessionMemoryService builds from the last session
 * summary, agent and project memory, today's log, active goals and recent
 * learnings. Registration generated it for every agent but the default
 * modular-prompt path discarded it (#816); the caller now passes it through
 * the module config instead.
 *
 * Priority 1.6 places it right after Active Work (1.5) and before the
 * recovery protocol (2): state first, supplementary memory second, then the
 * instructions that refer to both.
 *
 * Compactable: it is supplementary context (each section already capped at
 * 2 000 chars by the service), so under budget pressure it may be trimmed.
 * Its low priority number means the assembler trims it last among
 * compactable modules.
 */
export class SessionBriefingModule implements PromptModule {
	name = 'session-briefing';
	priority = 1.6;
	maxTokens = 3000;
	compactable = true;

	/**
	 * Included only when the caller supplied a non-empty briefing.
	 *
	 * @param config - Module configuration
	 * @returns true when `sessionBriefing` has content
	 */
	shouldInclude(config: ModuleConfig): boolean {
		return Boolean(config.sessionBriefing?.trim());
	}

	/**
	 * Return the pre-rendered briefing unchanged (trimmed).
	 *
	 * @param config - Module configuration
	 * @returns The briefing markdown, or '' when absent
	 */
	async build(config: ModuleConfig): Promise<string> {
		return config.sessionBriefing?.trim() ?? '';
	}
}
