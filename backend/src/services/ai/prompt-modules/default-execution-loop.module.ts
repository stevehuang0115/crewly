import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * Default Execution Loop block.
 *
 * P1-Fix-6 — Per spec
 * `.crewly/specs/2026-05-03-agent-improvement-plan.md` lines 330-348 (Fix 6),
 * this module emits the canonical 8-step Default Execution Loop that replaces
 * the passive "Ready for tasks — wait for me to send you work" closer that
 * was duplicated across 17 role prompts.
 *
 * Why a module (not just per-role markdown)?
 * - Default execution behavior must be byte-identical across every agent.
 *   A module guarantees this instead of relying on 17+ role prompts staying
 *   in sync as the loop evolves.
 * - The text is small (~13 lines) and behavioral-mandate, so it must not
 *   be truncated under budget pressure → `compactable = false` (Trusted Zone).
 * - Sits at priority 3.8 — final entry in the authority cluster, between
 *   LazyAntiPatterns (priority 3.7) and MemoryReference (priority 4). The
 *   full authority cluster reads: identity → soul → recovery → role-
 *   boundary → decision-rights → request-contract → lazy-anti-patterns
 *   → default-execution-loop → memory-reference. Order is intentional:
 *   contract (what we owe) → anti-patterns (what to avoid) → execution
 *   loop (how to actively operate). An agent reads "who am I, what are my
 *   limits, what can I decide, what NOT to do, how do I operate by default"
 *   before any data context.
 *
 * Static role prompts under `config/roles/{role}/prompt.md` ALSO contain the
 * same 8 steps verbatim — this is intentional belt-and-suspenders coverage
 * for the legacy `prompt-builder.service.ts` load path which does not run
 * through `PromptAssemblyService`. The two paths produce different prompts
 * for different runtimes; both must carry the contract.
 *
 * Net-zero offset: the 1-line passive closer ("Ready for tasks — wait for
 * me to send you work") was deleted from all 17 role prompts where it
 * previously sat. The active 8-step loop displaces the passive closer
 * across the entire fleet — semantic offset rather than literal LOC offset.
 */
export class DefaultExecutionLoopModule implements PromptModule {
	name = 'default-execution-loop';
	priority = 3.8;
	maxTokens = 200;
	compactable = false;

	/**
	 * Always include — every agent needs a default execution behavior. The
	 * loop is identical across roles because the meta-rule is universal:
	 * when assigned a task, do not wait passively, loop until done/blocked/
	 * reassigned. Role-specific escalation destinations are already encoded
	 * in the Decision Rights / Escalation Chain modules.
	 *
	 * @param _config - Unused; the inclusion rule is universal
	 * @returns Always true
	 */
	shouldInclude(_config: ModuleConfig): boolean {
		return true;
	}

	/**
	 * Build the Default Execution Loop section.
	 *
	 * Output is byte-identical regardless of role — see the class JSDoc for
	 * why universality is intentional. The 8 steps are verbatim per spec
	 * `.crewly/specs/2026-05-03-agent-improvement-plan.md` lines 334-348.
	 *
	 * @param _config - Module configuration (unused; content is static)
	 * @returns Formatted markdown block with one H2 section:
	 *   `## Default Execution Loop`
	 */
	async build(_config: ModuleConfig): Promise<string> {
		return [
			'## Default Execution Loop',
			'',
			'When assigned a task, do not wait passively.',
			'',
			'Loop until done, blocked, or explicitly reassigned:',
			'1. Restate the expected outcome in one sentence.',
			'2. Identify the fastest safe path to produce a usable result.',
			'3. Execute immediately.',
			'4. Run cheapest meaningful validation.',
			'5. If validation fails, fix and retry.',
			'6. If blocked by missing goal/outcome/eval, escalate to your TL.',
			'7. If blocked by implementation detail, decide reasonably and continue.',
			'8. Report only when you have a result, blocker, or decision exceeding your authority.',
		].join('\n');
	}
}
