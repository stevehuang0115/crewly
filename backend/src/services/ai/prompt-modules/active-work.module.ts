import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * Heading every active-work section starts with. The recovery module refers
 * to the section by this exact heading, so the two must stay in sync.
 */
export const ACTIVE_WORK_HEADING = '## Your Active Work';

/**
 * Render the `## Your Active Work` section from a pre-rendered briefing.
 *
 * Shared by {@link ActiveWorkModule} (modular prompts) and the legacy
 * monolithic registration prompt, so both paths say the same thing when the
 * briefing is missing.
 *
 * @param briefing - Markdown from ActiveWorkBriefingService, or undefined /
 *   empty when it was not generated
 * @param agent - Where the agent's skills live and who it is, used to build
 *   the fetch command in the "not injected" notice
 * @returns The briefing (heading ensured), or the "not injected" notice
 *
 * @example
 * ```typescript
 * renderActiveWorkSection(undefined, { agentSkillsPath, sessionName: 'dev-1', role: 'developer' });
 * // "## Your Active Work\n\n**Not injected into this prompt** ..."
 * ```
 */
export function renderActiveWorkSection(
	briefing: string | undefined,
	agent: { agentSkillsPath: string; sessionName: string; role: string },
): string {
	const body = briefing?.trim();
	if (body) {
		return body.startsWith(ACTIVE_WORK_HEADING) ? body : `${ACTIVE_WORK_HEADING}\n\n${body}`;
	}

	return `${ACTIVE_WORK_HEADING}

**Not injected into this prompt** — the briefing was not generated for this session. This does NOT mean you have no work. Fetch it now, before accepting anything new:
\`\`\`bash
bash ${agent.agentSkillsPath}/core/get-my-active-work/execute.sh --session ${agent.sessionName} --role ${agent.role}
\`\`\``;
}

/**
 * Active Work module — the authoritative "what am I on the hook for" block.
 *
 * Issue #395 injected the active-work briefing (open Requests, active
 * WorkItems, pending reviews, outbound delegations) into the registration
 * prompt. The default modular-prompt path then returned the assembled
 * modules and discarded it (#816), while the recovery module kept telling
 * agents the section was "injected above".
 *
 * This module is the fix: the caller pre-renders the briefing into
 * {@link ModuleConfig.activeWorkBriefing} and the module places it
 * immediately before the recovery protocol (priority 1.5 < recovery's 2),
 * so "above" is literally true. When no briefing was generated — a caller
 * that does not compute one, or generation failed — the module still emits
 * the heading with an explicit "not injected" notice and the skill to run,
 * so the recovery wording is accurate on every path and an absent briefing
 * can never be mistaken for "no work".
 *
 * Non-compactable: this is state, not reference material; trimming it to
 * 50% could drop the one WorkItem the agent was restarted to finish. Size is
 * already bounded by ActiveWorkBriefingService's per-section caps and its
 * compact re-render above the overflow ceiling.
 */
export class ActiveWorkModule implements PromptModule {
	name = 'active-work';
	priority = 1.5;
	maxTokens = 6500;
	compactable = false;

	/**
	 * Always included: either the briefing or the notice that it is missing.
	 *
	 * @param _config - Module configuration (unused)
	 * @returns true
	 */
	shouldInclude(_config: ModuleConfig): boolean {
		return true;
	}

	/**
	 * Render the active-work section.
	 *
	 * @param config - Module configuration; reads `activeWorkBriefing`,
	 *   `agentSkillsPath`, `sessionName` and `role`
	 * @returns See {@link renderActiveWorkSection}
	 */
	async build(config: ModuleConfig): Promise<string> {
		return renderActiveWorkSection(config.activeWorkBriefing, {
			agentSkillsPath: config.agentSkillsPath,
			sessionName: config.sessionName,
			role: config.role,
		});
	}
}
