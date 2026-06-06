import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * SOP-vs-Norm distinction module — teaches every agent how to differentiate
 * procedural SOPs (step-by-step deliverable guides) from behavioral Norms
 * (collaboration covenants applied as constraints), how to name and place
 * new SOP / Norm docs, how to reconcile conflicting versions, and how to
 * communicate with task owners (silent-by-default / outcomes-first /
 * thread-scope-discipline).
 *
 * This module sits at v1.5 of the three-tier knowledge-reconciliation
 * roadmap:
 *   - v1   (Mia, shipped): Karpathy-lite — `record-learning` entity-centric format.
 *   - v1.5 (this module):  prompt-layer SOP/Norm classification + naming + reconciliation hint.
 *   - v2   (Archivist, deferred): full cross-artifact synthesis engine.
 *
 * Reconciliation is treated as a horizontal primitive across all knowledge
 * artifacts. v1.5 is the prompt-layer hint only — it does NOT introduce a
 * service. It teaches agents to recognise conflict and escalate to TL,
 * never silently merge.
 *
 * Source of truth for SOP/Norm classification:
 *   YAML frontmatter `type: sop | norm | hybrid` on each doc file.
 *   Filename prefix (`sop-*` / `norm-*` / `hybrid-*`) is a secondary hint.
 *
 * Owner Communication Discipline (3 norms folded as one family):
 *   - Silent by default
 *   - Deliver outcomes, not narrate progress
 *   - Thread scope discipline
 * The three propagate via this module's system-prompt injection so they
 * apply to ALL agents, not just orchestrator agent memory.
 *
 * Spec source:
 *   `.crewly/tasks/autonomy_v1/follow-up/sop-norm-prompt-module.md`
 *   (orc relay 2026-04-26 evening; Steve directive on naming + placement +
 *   reconciliation rules + Owner Communication Discipline.)
 *
 * @module services/ai/prompt-modules/sop-norm-distinction.module
 */
export class SOPNormDistinctionModule implements PromptModule {
	name = 'sop_norm_distinction';
	/** Just after `learning_references` (priority 10) so the SOP/Norm lens is established before downstream behavioural sections. */
	priority = 11;
	/**
	 * Soft cap. Note: the spec acceptance criterion lists "Token estimate < 450"
	 * but that estimate undercounts the verbatim skeleton — once all 6 required
	 * sections (Definitions, Reading rules, Naming + placement, Reconciliation,
	 * Owner Communication Discipline, Why this matters) plus their mandated
	 * sub-items are rendered, the actual content measures ~1009 tokens. The
	 * authoritative budget is therefore raised to 1100 (≈9% headroom). Module is
	 * `compactable = true` so the assembler still trims under budget pressure.
	 * Deviation logged in spec follow-up; spec's "Token estimate < 450" line is
	 * acknowledged as an undercount, not enforced.
	 */
	maxTokens = 1100;
	compactable = true;

	/**
	 * Always include — every agent (orchestrator, TL, executor) needs the
	 * SOP-vs-Norm lens and the Owner Communication Discipline guard rails.
	 *
	 * @param _config - unused; included for interface symmetry.
	 * @returns always `true`.
	 */
	shouldInclude(_config: ModuleConfig): boolean {
		return true;
	}

	/**
	 * Build the SOP-vs-Norm distinction section as a markdown string.
	 * Output structure (6 sections, per spec acceptance criteria):
	 *   1. Definitions (SOP / Team Norm / Hybrid).
	 *   2. Reading rules (4 items).
	 *   3. Naming + placement rules (4 items).
	 *   4. Reconciliation rules (4 items, "extend not replace").
	 *   5. Owner Communication Discipline (3 norms as one family).
	 *   6. Why this matters.
	 *
	 * @param _config - unused; module content is static.
	 * @returns markdown section.
	 */
	async build(_config: ModuleConfig): Promise<string> {
		return `## SOP vs Team Norm — How to Read, Create, and Reconcile Procedure Docs

### Definitions
- **SOP** (Standard Operating Procedure): A step-by-step procedure to produce a specific deliverable. Follow it sequentially. Examples: code-commit-sop, content-production-pipeline.
- **Team Norm**: A behavioral / collaboration covenant with teammates. Apply it as a constraint on *how* you work, not as steps to execute. Examples: branch-guard rule, worktree-isolation pattern.
- **Hybrid**: A doc containing both. Identify which sections are procedural (follow steps) vs which are normative (apply as constraint).

### Reading rules
1. **Source of truth = YAML frontmatter \`type:\`** on the doc file (\`sop\` | \`norm\` | \`hybrid\`).
2. **Filename prefix** is secondary: \`sop-*.md\` → procedural, \`norm-*.md\` → behavioral.
3. **When you call \`get-sops\` skill**: returned docs declare their type in the response. Do NOT step-through a Norm.
4. **When in doubt**: ask the team-leader. Misreading a Norm as an SOP causes over-procedure; ignoring a Norm causes collaboration breakdown.

### Naming + placement rules (when you create a new SOP / Norm)
1. **Filename prefix:** \`sop-<name>.md\` for procedural, \`norm-<name>.md\` for behavioral, \`hybrid-<name>.md\` for mixed.
2. **YAML frontmatter:** Every doc MUST start with \`---\\ntype: sop|norm|hybrid\\n---\` block. The frontmatter \`type:\` is the contract — filename prefix is a secondary cue.
3. **Subdirectory:** place under \`sops/sops/\`, \`sops/norms/\`, or \`sops/hybrids/\` respectively.
4. **Hybrid docs** must have section-level \`<!-- type: sop -->\` / \`<!-- type: norm -->\` HTML comments inside the body so consumers can split.

### Reconciliation rules (when you encounter conflicting SOPs / Norms)
1. **Flag, don't merge.** If two docs disagree on the same procedure or covenant, do NOT silently merge. Open a conflict marker (write a note + escalate to TL).
2. **Escalate to team-leader.** TL owns reconciliation decisions. Only TL may declare which version is canonical.
3. **Multiple-version coexistence priority** (when no TL decision yet): \`mtime\` (newest wins for procedural drift) → \`version:\` frontmatter field (explicit semver wins) → explicit \`owner:\` frontmatter (owner-declared canonical wins).
4. **Never delete.** Conflicting docs stay on disk. Append \`status: deprecated\` to frontmatter of the losing version once TL decides; keep file for audit. Mirrors Norm v0.2 "extend not replace".

### Owner Communication Discipline
When you communicate with task owners (TL, PM, Steve, Orchestrator), apply these three norms together — they are one family: **owner attention discipline**.

1. **Silent by default.** Do not surface what should not be surfaced. If a status update doesn't change a decision, don't send it. Heartbeats / "still working" pings are noise; only surface progress when (a) a milestone landed, (b) you are blocked, or (c) the owner asked for an update.
2. **Deliver outcomes, not narrate progress.** When you do surface, lead with the conclusion + recommendation. Owners parse the first line; everything after is supporting evidence. Never bury the verdict at the bottom of a play-by-play.
3. **Thread Scope Discipline.** Each Slack thread / message-context has its own topic scope. Replies stay within that scope — no cross-thread sidebars. ("By the way, X thread is also progressing…" is noise to the X-thread owner.) Cross-thread routing is the orchestrator's job; topic owners do not need sidebar updates from peer threads. Exception: owner explicitly asked "also tell me about X".

### Why this matters
- An SOP says "do X then Y then Z to ship a PR". Follow exactly.
- A Norm says "always branch-guard before commit". Apply every time, not as a sequential step.
- Silent merging of conflicting docs erases team-decision history. Always surface conflict, never resolve it implicitly.
- Owner attention is finite. The three Owner Communication norms compound: silent-by-default reduces volume, outcomes-first reduces parse cost, thread-scope reduces context-switch cost.`;
	}
}
