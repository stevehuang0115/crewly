/**
 * Model Tiers Module (crewly#1173, specs/2026-10-08-model-tiers.md)
 *
 * For a team lead whose team has "Optimize usage" on: which tier and model
 * each member runs on, the routing rules in force, how to route work by tier,
 * and the team's change mode — the owner approves each change, or (auto) the
 * lead's changes take effect at once and the owner can undo them. Leads of other teams and members get
 * nothing.
 *
 * Priority 9.6 (after team norms). Compactable.
 *
 * @module services/ai/prompt-modules/model-tiers
 */

import type { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/** Members listed at most. */
const MAX_MEMBERS = 15;

export class ModelTiersModule implements PromptModule {
	name = 'model-tiers';
	priority = 9.6;
	maxTokens = 500;
	compactable = true;

	/**
	 * Only for a lead of a team with "Optimize usage" on.
	 *
	 * @param config - Module configuration
	 * @returns True when the section applies
	 */
	shouldInclude(config: ModuleConfig): boolean {
		return config.canDelegate === true && config.teamTiers?.optimizeUsage === true;
	}

	/**
	 * Build the section.
	 *
	 * @param config - Module configuration
	 * @returns Markdown
	 */
	async build(config: ModuleConfig): Promise<string> {
		const t = config.teamTiers;
		if (!t) return '';
		const members = t.members
			.slice(0, MAX_MEMBERS)
			.map((m) => `- ${m.name}: ${m.tier ?? 'no tier'} → ${m.model}`)
			.join('\n');
		const auto = t.changeMode === 'auto';
		const rules = t.routingRules.length ? `\nRouting rules in force:\n${t.routingRules.map((r) => `- ${r}`).join('\n')}\n` : '';
		const propose = `bash ${config.tlSkillsPath}/propose-tier-change/execute.sh --member "<name>" --tier weak --reason "<why>"`;
		const authority = auto
			? `- Change mode: **you decide**. To change a tier or add a routing rule at any time: \`${propose}\`, then \`--submit\`. It takes effect at once (idle members restart on the new model; busy ones switch at their next start), and the owner gets a notice and can undo it. Change only what the usage review supports; never change a tier or model any other way.`
			: `- Change mode: **the owner approves**. To propose a tier change or a routing rule at any time: \`${propose}\`, then \`--submit\`. The owner approves every change; never change a tier or model any other way.`;
		return `## Model Tiers ("Optimize usage" is on)

Your team's members run on model tiers: **strong** (hard reasoning, design, reviewing others), **mid** (normal implementation and writing), **weak** (routine work: polling, checks, formatting, sorting, first-pass triage, summaries).
${members}
${rules}
- Route each piece of work to the weakest member whose tier fits it; keep hard work on strong members.
- Do routine work yourself only when no weak or mid member can take it.
- You get a usage review weekly. You stay at mid or above.
${authority}`;
	}
}
