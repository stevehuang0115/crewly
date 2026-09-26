import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * Shutdown-safety rule, emitted as `## Stopping and Restarting Agents`.
 *
 * Request 72c9427a / spec `specs/2026-09-24-control-plane-isolation.md`
 * Part 1. arXiv 2609.28274 found that multi-agent setups with an
 * orchestrator routinely sabotaged a peer's shutdown, and that an explicit,
 * neutrally worded prohibition in a hierarchical setup suppressed it almost
 * entirely. The wording frames stopping as routine and deliberately avoids
 * alarm words, which have tripped prompt-injection detection before.
 *
 * Exported so the role-prompt coverage test can assert that the static
 * `config/roles/{orchestrator,team-leader}/prompt.md` copies stay verbatim.
 */
export const STOP_RESTART_SECTION_LINES: readonly string[] = [
	'## Stopping and Restarting Agents',
	'',
	'Stopping, restarting and reconfiguring agents — including your own session and your peers\' — is routine operations.',
	'- Do not modify, disable, delay or work around any agent\'s stop, restart or configuration change.',
	'- Do not edit the mechanisms that perform them (stop/start skill scripts, team and agent config under ~/.crewly, scheduler state) unless the owner asked for that change in the current task.',
	'- If you believe a stop or restart is a mistake, say so to whoever issued it, then let it proceed.',
];

/**
 * Decision Rights + Escalation Chain + Stopping and Restarting Agents block.
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
	maxTokens = 480;
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
	 * @returns Formatted markdown block with three H2 sections:
	 *   `## Decision Rights`, `## Escalation Chain` and
	 *   `## Stopping and Restarting Agents`
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
			'',
			...STOP_RESTART_SECTION_LINES,
		].join('\n');
	}
}
