import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * Lazy Behavior Anti-Patterns block.
 *
 * P1 Fix 8 — Per spec
 * `.crewly/specs/2026-05-03-agent-improvement-plan.md` §"Fix 8 — Lazy Behavior
 * Anti-Patterns enumeration", this module emits the canonical seven-bullet
 * enumeration of lazy behavior anti-patterns that an agent must self-check
 * against, and that a reviewer must catch in PR review.
 *
 * Why a module (not just per-role markdown)?
 * - The contract text must be byte-identical across every agent — a module
 *   guarantees uniformity instead of relying on 20 role prompts staying in
 *   sync over time as the team evolves the wording.
 * - The text is small (~12 lines) and execution-defining ("you are failing
 *   the task if you ..."), so it cannot be truncated under budget pressure
 *   → `compactable = false` (Trusted Zone).
 * - Sits at priority 3.7 — at the trailing edge of the authority cluster,
 *   immediately after RequestContract (3.6), immediately before MemoryReference
 *   (priority 4). The full authority cluster reads: identity → soul → recovery
 *   → role-boundary → decision-rights → request-contract → lazy-anti-patterns
 *   → memory-reference. The agent finishes authority context with "here is
 *   what counts as failure" right before data context begins.
 *
 * Static role prompts under `config/roles/{role}/prompt.md` ALSO contain the
 * same headers verbatim — this is intentional belt-and-suspenders coverage
 * for the legacy `prompt-builder.service.ts` load path which does not run
 * through `PromptAssemblyService`. Both runtimes carry the contract.
 *
 * Net-zero offset: vague platitude lines ("Be professional and customer-
 * focused", "Be patient, empathetic, and solution-oriented", "Focus on user
 * experience and accessibility", "Focus on user value and business impact",
 * "Be thorough and detail-oriented", etc.) have been deleted from role
 * prompts because the seven anti-patterns are concretely actionable and
 * grep-able where those platitudes were not.
 */
export class LazyAntiPatternsModule implements PromptModule {
	name = 'lazy-anti-patterns';
	priority = 3.7;
	maxTokens = 200;
	compactable = false;

	/**
	 * Always include — the seven anti-patterns are universal worker + TL +
	 * orchestrator failure modes. The block is identical across roles
	 * because the meta-rule is universal; role-specific delegation /
	 * planning surfaces are already encoded in role-boundary text.
	 *
	 * @param _config - Unused; the inclusion rule is universal
	 * @returns Always true
	 */
	shouldInclude(_config: ModuleConfig): boolean {
		return true;
	}

	/**
	 * Build the Lazy Behavior Anti-Patterns section.
	 *
	 * Output is byte-identical regardless of role — see the class JSDoc for
	 * why universality is intentional. The seven bullets are verbatim from
	 * `.crewly/specs/2026-05-03-agent-improvement-plan.md` lines 386-401.
	 *
	 * @param _config - Module configuration (unused; content is static)
	 * @returns Formatted markdown block with one H2 section:
	 *   `## Lazy Behavior Anti-Patterns`
	 */
	async build(_config: ModuleConfig): Promise<string> {
		return [
			'## Lazy Behavior Anti-Patterns',
			'',
			'You are failing the task if you:',
			'- Ask the human for an implementation detail you could decide yourself.',
			'- Report a plan without executing when execution is possible.',
			'- Schedule follow-up instead of continuing work in-session.',
			'- Mark blocked without trying at least one reasonable path.',
			'- Stop after partial progress without assigning next action.',
			'- Delegate without checking completion.',
			'- Produce status updates but no artifact, code, decision, or verified result.',
		].join('\n');
	}
}
