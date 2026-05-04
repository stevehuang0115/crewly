/**
 * Mission Context module — auto-injects the agent's current mission /
 * OKR context into the assembled prompt.
 *
 * Wraps `MissionContextService.getContextForAgent` and registers
 * cleanly inside the live `PromptAssemblyService` pipeline. This is the
 * production wire-in for Memory Phase 1 / fix #415; the older hook in
 * `PromptGeneratorService.generateMemberPrompt` was on a dead code path.
 *
 * Behavior:
 *   - Skipped when `teamId` is missing or `evalMode` is true.
 *   - `build()` is fail-soft: any service error logs a warn and returns
 *     `''` so the assembler never breaks because of a missing missions
 *     directory or a malformed mission file.
 *   - Uses `config.projectPath` as the source of truth — no `process.cwd()`.
 *   - Forwards `teamSlug` for sub-OKR slug lookup and `teamAncestorIds`
 *     so missions owned by parent teams in the OKR hierarchy are also
 *     surfaced.
 *
 * @module services/ai/prompt-modules/mission-context.module
 */

import { LoggerService, type ComponentLogger } from '../../core/logger.service.js';
import { MissionContextService } from '../../memory/mission-context.service.js';
import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * Priority slot for the mission card. Sits after team references
 * (priority 6) and before learning references (priority 10) so the
 * agent first sees who they work with, then what mission they are
 * serving, then how to learn from past work.
 */
const MISSION_CONTEXT_PRIORITY = 7;

/**
 * Soft token budget. The service caps the rendered card at 2KB hard
 * cap (~512 tokens at 4 chars/token); this gives the assembler some
 * headroom for the markdown framing.
 */
const MISSION_CONTEXT_MAX_TOKENS = 600;

/**
 * Implements the PromptModule interface for the mission-context card.
 */
export class MissionContextModule implements PromptModule {
	name = 'mission_context';
	priority = MISSION_CONTEXT_PRIORITY;
	maxTokens = MISSION_CONTEXT_MAX_TOKENS;
	compactable = true;

	private readonly logger: ComponentLogger;
	private readonly service: MissionContextService;

	/**
	 * Construct the module. The service is resolved lazily through its
	 * singleton — passing one in is supported for tests.
	 *
	 * @param service - Optional override for the mission-context service
	 */
	constructor(service?: MissionContextService) {
		this.logger = LoggerService.getInstance().createComponentLogger('MissionContextModule');
		this.service = service ?? MissionContextService.getInstance();
	}

	/**
	 * Skip the card when the agent has no team (no scoping anchor) or
	 * the assembler is in eval mode (token-saving).
	 *
	 * @param config - Module configuration
	 * @returns true when the card should be built
	 */
	shouldInclude(config: ModuleConfig): boolean {
		if (config.evalMode) return false;
		if (!config.teamId) return false;
		return true;
	}

	/**
	 * Build the mission card by delegating to MissionContextService.
	 * Returns the empty string on any error or when there is nothing to
	 * surface.
	 *
	 * @param config - Module configuration with resolved project path,
	 *   team id, optional team slug and optional ancestor team ids.
	 * @returns Rendered mission card markdown or `''` to skip the section
	 */
	async build(config: ModuleConfig): Promise<string> {
		// `shouldInclude` already guarded these; defensive for direct callers.
		if (!config.teamId || !config.projectPath) return '';

		try {
			const card = await this.service.getContextForAgent({
				agentId: config.sessionName,
				projectPath: config.projectPath,
				teamId: config.teamId,
				ancestorTeamIds: config.teamAncestorIds,
				teamSlug: config.teamSlug,
			});
			return card ? card.trim() : '';
		} catch (err) {
			this.logger.warn(
				'MissionContextService threw — skipping mission card for this assembly',
				{
					sessionName: config.sessionName,
					teamId: config.teamId,
					error: err instanceof Error ? err.message : String(err),
				}
			);
			return '';
		}
	}
}
