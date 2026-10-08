/**
 * Model Tiers Module (crewly#1173, specs/2026-10-08-model-tiers.md)
 *
 * For a team lead whose team has "Optimize usage" on: which tier and model
 * each member runs on, the routing rules the owner approved, and how to route
 * work by tier and propose changes. Leads of other teams and members get
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
		const rules = t.routingRules.length ? `\nRouting rules the owner approved:\n${t.routingRules.map((r) => `- ${r}`).join('\n')}\n` : '';
		return `## Model Tiers ("Optimize usage" is on)

Your team's members run on model tiers: **strong** (hard reasoning, design, reviewing others), **mid** (normal implementation and writing), **weak** (routine work: polling, checks, formatting, sorting, first-pass triage, summaries).
${members}
${rules}
- Route each piece of work to the weakest member whose tier fits it; keep hard work on strong members.
- Do routine work yourself only when no weak or mid member can take it.
- You get a usage review weekly. To propose a tier change or a routing rule at any time: \`bash ${config.tlSkillsPath}/propose-tier-change/execute.sh --member "<name>" --tier weak --reason "<why>"\`, then \`--submit\`. The owner approves every change; never change a tier or model any other way.`;
	}
}
