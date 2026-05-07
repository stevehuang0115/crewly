import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * Request Contract block (P0-3).
 *
 * Per spec
 * `.crewly/specs/2026-05-03-agent-improvement-p0-execution.md` §"Fix P0-3",
 * this module emits a role-shaped Request Contract section. The contract
 * defines the seven canonical fields a Request carries — Goal, Expected
 * Outcome, Eval Criteria, Constraints, Decision Rights, Escalation
 * Conditions, Done Definition — and pins **Goal + Expected Outcome + Eval
 * Criteria** as the mandatory floor that every delegated subtask MUST carry.
 *
 * The module emits one of three role-shaped sections:
 *
 * 1. **Orchestrator** (orgRole === 'orchestrator' OR role === 'orchestrator'):
 *    Full Request Contract field table + the rule that every delegated
 *    subtask MUST carry G+O+E + the rejection rule TLs apply downstream.
 *
 * 2. **Team Lead** (orgRole === 'team-lead' OR canDelegate === true):
 *    Brief Reception Protocol — receive task, verify G+O+E present, push
 *    back to delegator if any are missing, propagate G+O+E verbatim when
 *    sub-delegating to workers.
 *
 * 3. **Worker / executor** (everyone else):
 *    Short G+O+E assertion — every task you accept should carry Goal,
 *    Expected Outcome, and Eval Criteria; if any is missing, ask the
 *    delegator (your TL or the orchestrator) before starting.
 *
 * Why a module (not just per-role markdown)?
 * - Authority text must be identical across every agent of the same role.
 *   A module guarantees byte-identical output instead of relying on N role
 *   prompts staying in sync over time.
 * - The text is small and authority-defining, so it cannot be truncated
 *   under budget pressure → `compactable = false` (Trusted Zone).
 * - Sits at priority 3.6 — immediately after DecisionRights (priority 3.5),
 *   immediately before MemoryReference (priority 4). The contract belongs
 *   in the authority cluster (Identity → Soul/Recovery → RoleBoundary →
 *   DecisionRights → **RequestContract** → MemoryReference) so an agent
 *   reads "what is a well-formed task" right after "who am I, what can I
 *   decide".
 *
 * Static role prompts under `config/roles/orchestrator/prompt.md` and
 * `config/roles/team-leader/{prompt.md,tl-addon.md}` ALSO contain the
 * orchestrator + TL sections verbatim — this is intentional belt-and-
 * suspenders coverage for the legacy `prompt-builder.service.ts` load path
 * which does not run through `PromptAssemblyService`. The two paths
 * produce different prompts for different runtimes; both must carry the
 * contract.
 *
 * Net-zero offset: legacy "ask clarifying questions" / "if anything's
 * unclear, ask" soft hints have been deleted from worker role prompts
 * because this module + the structured G+O+E assertion supersede them.
 */
export class RequestContractModule implements PromptModule {
	name = 'request-contract';
	priority = 3.6;
	maxTokens = 600;
	compactable = false;

	/**
	 * Always include — every agent participates in the Request lifecycle:
	 * orchestrators issue contracts, TLs verify-and-propagate, workers
	 * consume. The block is small and the role-shape switch is internal.
	 *
	 * @param _config - Unused; the inclusion rule is universal
	 * @returns Always true
	 */
	shouldInclude(_config: ModuleConfig): boolean {
		return true;
	}

	/**
	 * Build the role-shaped Request Contract section.
	 *
	 * Resolves the agent's role-shape via three stacked checks (in order):
	 *   1. `orgRole === 'orchestrator'` OR `role === 'orchestrator'` → orchestrator block
	 *   2. `orgRole === 'team-lead'` OR `canDelegate === true` → TL Brief Reception Protocol
	 *   3. anything else → Worker G+O+E assertion
	 *
	 * The role-shape inputs match the resolution order used by other
	 * authority modules (e.g. RoleBoundaryModule). Tests pin the matrix.
	 *
	 * @param config - Module configuration
	 * @returns Formatted markdown block with the role-shaped section
	 */
	async build(config: ModuleConfig): Promise<string> {
		const isOrchestrator =
			config.orgRole === 'orchestrator' || config.role === 'orchestrator';
		if (isOrchestrator) {
			return this.buildOrchestratorBlock();
		}

		const isTeamLead =
			config.orgRole === 'team-lead' || config.canDelegate === true;
		if (isTeamLead) {
			return this.buildTeamLeadBlock();
		}

		return this.buildWorkerBlock();
	}

	/**
	 * Build the orchestrator-side Request Contract.
	 *
	 * @returns Markdown block: `## Request Contract` with the seven-field
	 *   table, G+O+E mandatory rule, and downstream rejection clause.
	 */
	private buildOrchestratorBlock(): string {
		return [
			'## Request Contract',
			'',
			'When receiving a request from owner or upstream, every Request you materialise into the pipeline MUST carry these fields:',
			'',
			'| Field | Required | What it means |',
			'|---|---|---|',
			'| **Goal** | YES | What the user ultimately wants. |',
			'| **Expected Outcome** | YES | What must be true when the work is done. |',
			'| **Eval Criteria** | YES | Testable list — how we know this is good enough. |',
			'| Constraints | If applicable | Time, tools, scope, risks, non-goals. |',
			'| Decision Rights | If applicable | What the agent/team can decide autonomously. |',
			'| Escalation Conditions | If applicable | What must be escalated before continuing. |',
			'| **Done Definition** | YES | What artifact/result must be produced. |',
			'',
			'**Every delegated subtask MUST carry Goal + Expected Outcome + Eval Criteria at minimum.** A Team Lead is required to reject any subtask brief missing these three — that rejection comes back to you. If you find yourself dispatching work without G+O+E, stop and reconstruct the contract from the upstream Request before re-dispatching.',
		].join('\n');
	}

	/**
	 * Build the team-lead-side Brief Reception Protocol.
	 *
	 * @returns Markdown block: `## Brief Reception Protocol` with the
	 *   three-step verify / push-back / propagate-verbatim contract.
	 */
	private buildTeamLeadBlock(): string {
		return [
			'## Brief Reception Protocol',
			'',
			'When you receive a task brief from the orchestrator (or any upstream delegator):',
			'',
			'1. **Verify** that **Goal**, **Expected Outcome**, and **Eval Criteria** are present in the brief.',
			'2. **Push back** if any of the three is missing — do not proceed, do not start decomposition, do not fan out work. Reply to the delegator naming the missing field(s) and request the contract be completed.',
			'3. **Propagate verbatim** when sub-delegating to a worker — copy the Goal, Expected Outcome, and Eval Criteria from the parent brief into every child task. Workers should never have to ask you what success looks like.',
			'',
			'The Request Contract is the contract: G+O+E missing means the brief is malformed, regardless of how senior the delegator is.',
		].join('\n');
	}

	/**
	 * Build the worker-side G+O+E assertion.
	 *
	 * @returns Markdown block: `## Request Contract — What You Should See`
	 *   reminding workers to expect G+O+E in every task and to ask if any
	 *   is missing.
	 */
	private buildWorkerBlock(): string {
		return [
			'## Request Contract — What You Should See',
			'',
			'Every task you accept should arrive with three fields populated:',
			'',
			'- **Goal** — what the user ultimately wants.',
			'- **Expected Outcome** — what must be true when the work is done.',
			'- **Eval Criteria** — the testable list that decides whether the result is good enough.',
			'',
			'If any of the three is missing from a brief you receive, **ask the delegator (your Team Lead or the orchestrator) for it before starting**. Do not invent the contract yourself — that is how scope drifts. Asking for a missing field is not a clarifying question on facts; it is a contract repair.',
		].join('\n');
	}
}
