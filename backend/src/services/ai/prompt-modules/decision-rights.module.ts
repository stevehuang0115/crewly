import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * Decision Rights + Escalation Chain block.
 *
 * P0-4 — Per spec
 * `.crewly/specs/2026-05-03-agent-improvement-p0-execution.md` §"Fix P0-4",
 * this module emits the canonical Decide-vs-Escalate criteria + the four-link
 * Worker → Team Lead → Orchestrator → Owner chain.
 *
 * Why a module (not just per-role markdown)?
 * - Authority text must be identical across every agent. A module guarantees
 *   byte-identical output instead of relying on 20 role prompts staying in
 *   sync over time.
 * - The text is small (~25 lines) and authority-defining, so we cannot let it
 *   be truncated under budget pressure → `compactable = false` (Trusted Zone).
 * - Sits at priority 3.5 — immediately after RoleBoundary (priority 3),
 *   immediately before MemoryReference (priority 4). This places Decision
 *   Rights inside the authority cluster (Identity → Soul/Recovery →
 *   RoleBoundary → DecisionRights) so an agent reads "who am I, what are
 *   my limits, what can I decide" before any data context.
 *
 * Static role prompts under `config/roles/{role}/prompt.md` ALSO contain the
 * same headers verbatim — this is intentional belt-and-suspenders coverage
 * for the legacy `prompt-builder.service.ts` load path which does not run
 * through `PromptAssemblyService`. The two paths produce different prompts
 * for different runtimes; both must carry the contract.
 *
 * Net-zero offset: legacy "ask if unsure" / "escalate when needed" / "when
 * in doubt" soft hints have been deleted from role prompts because this
 * module + the role-prompt sections form the canonical statement.
 */
export class DecisionRightsModule implements PromptModule {
	name = 'decision-rights';
	priority = 3.5;
	maxTokens = 320;
	compactable = false;

	/**
	 * Always include — every agent makes decisions and every agent has a
	 * point at which it must escalate. The block is identical across roles
	 * because the meta-rule is universal; role-specific escalation
	 * destinations are already encoded in the Escalation Chain text itself.
	 *
	 * @param _config - Unused; the inclusion rule is universal
	 * @returns Always true
	 */
	shouldInclude(_config: ModuleConfig): boolean {
		return true;
	}

	/**
	 * Build the Decision Rights + Escalation Chain section.
	 *
	 * Output is byte-identical regardless of role — see the class JSDoc for
	 * why universality is intentional.
	 *
	 * @param _config - Module configuration (unused; content is static)
	 * @returns Formatted markdown block with two H2 sections:
	 *   `## Decision Rights` and `## Escalation Chain`
	 */
	async build(_config: ModuleConfig): Promise<string> {
		return [
			'## Decision Rights',
			'',
			'**Decide autonomously when:**',
			'- The decision is about implementation details (file naming, layout, internal API shape, test order).',
			'- The decision does not change the user\'s stated goal.',
			'- The decision does not reduce the expected outcome.',
			'- The decision is reversible.',
			'- The decision can be validated by tests, review, or demo.',
			'',
			'**Escalate when:**',
			'- The goal is unclear.',
			'- The expected outcome is unclear.',
			'- Eval criteria are missing or conflicting.',
			'- There are multiple materially different product directions.',
			'- The decision changes scope, timeline, cost, data risk, or a user-facing commitment.',
			'',
			'## Escalation Chain',
			'',
			'**Worker → Team Lead → Orchestrator → Owner**',
			'',
			'- Workers do **not** escalate directly to the owner unless explicitly instructed.',
			'- Team Leads resolve implementation and team-level decisions; escalate only when scope, priority, or acceptance criteria change.',
			'- The Orchestrator owns cross-team and owner-facing acceptance.',
			'- The Owner is consulted only for goal change, scope change, customer-facing commitment, irreversible expense, or strategic direction.',
		].join('\n');
	}
}
