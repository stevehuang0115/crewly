import { PromptModule, ModuleConfig } from './prompt-module.interface.js';
import { AttentionService } from '../self-improvement/attention.service.js';
import { PredictionCalibrationService } from '../self-improvement/prediction-calibration.service.js';
import type { MemoryConsolidationService } from '../self-improvement/memory-consolidation.service.js';
import { createMemoryConsolidationService } from '../self-improvement/agent-memory-provider.js';
import { SELF_IMPROVEMENT_CONSTANTS } from '../../../constants.js';

/**
 * Per-agent self-improvement readers the module consults when building
 * the "Your self-model" card. Injectable for tests.
 */
export interface SelfModelReaders {
	attention: Pick<AttentionService, 'getAttention'>;
	predictions: Pick<PredictionCalibrationService, 'getPredictions'>;
	consolidation: Pick<MemoryConsolidationService, 'getReport'>;
}

/**
 * Memory reference module — tells the agent how to access and store memories.
 *
 * Consolidates memory routing rules and session recovery protocol
 * into a single module. Contains "how-to" instructions, not actual data —
 * with one deliberate exception: a small, bounded "Your self-model" card
 * (focus items, suppressed topics, consolidation insights, calibration
 * score) is appended when the agent has any such data on disk, so the
 * self-improvement services actually shape behaviour instead of only being
 * written to.
 *
 * Sources: Path A Steps 8+9, Path B Section 7.
 */
export class MemoryReferenceModule implements PromptModule {
	name = 'memory_references';
	priority = 4;
	maxTokens = 500;
	compactable = false;

	private readonly readers: SelfModelReaders;

	/**
	 * @param readers - Optional self-improvement readers (defaults to disk-backed services)
	 */
	constructor(readers?: SelfModelReaders) {
		this.readers = readers ?? {
			attention: new AttentionService(),
			predictions: new PredictionCalibrationService(),
			consolidation: createMemoryConsolidationService(),
		};
	}

	/**
	 * Always included — memory access is fundamental to agent continuity.
	 */
	shouldInclude(_config: ModuleConfig): boolean {
		return true;
	}

	/**
	 * Build the memory reference section with routing rules
	 * that tell the agent where to store different types of knowledge,
	 * followed by the agent's self-model card when any data exists.
	 *
	 * @param config - Module configuration
	 * @returns Formatted markdown memory reference section
	 */
	async build(config: ModuleConfig): Promise<string> {
		const routing = `## Memory Routing Rules

When you learn something worth remembering, store it in the **right place**:

| What you learned | Where to store it | How |
|---|---|---|
| Team conventions, coding standards, project patterns, shared decisions | Crewly knowledge (project-wide) | \`remember\` with \`scope: "project"\`, \`category: "pattern"\` or \`"decision"\` |
| User preferences, working style, role-specific tips | Crewly knowledge (agent-specific) | \`remember\` with \`scope: "agent"\`, \`category: "preference"\` or \`"fact"\` |
| Gotchas, bugs, workarounds discovered during work | Crewly knowledge (project-wide) | \`remember\` with \`scope: "project"\`, \`category: "gotcha"\` |
| Temporary task notes, in-progress state, scratch data | Project files or Claude native memory | Write to a file in the project, or keep in your conversation context |

**Rules of thumb:**
- If another agent or a future session would benefit → use \`remember\` with \`scope: "project"\`
- If only YOU would benefit in future sessions → use \`remember\` with \`scope: "agent"\`
- If it's only useful right now → keep it in your conversation context or a scratch file
- **Never store secrets, credentials, or tokens** in any memory system`;

		const selfModel = await this.buildSelfModelSection(config.sessionName);
		return selfModel ? `${routing}\n\n${selfModel}` : routing;
	}

	/**
	 * Build the bounded self-model card, or an empty string when the agent
	 * has no focus, suppressed topics, insights or resolved predictions.
	 * Any read failure yields an empty string — the prompt must never fail
	 * because a self-improvement file is unreadable.
	 *
	 * @param sessionName - Agent session name
	 * @returns Markdown section (≤ MAX_CHARS) or ''
	 */
	async buildSelfModelSection(sessionName: string): Promise<string> {
		const { PROMPT } = SELF_IMPROVEMENT_CONSTANTS;
		try {
			const [attention, predictions, report] = await Promise.all([
				this.readers.attention.getAttention(sessionName),
				this.readers.predictions.getPredictions(sessionName),
				this.readers.consolidation.getReport(sessionName),
			]);

			const focus = (attention.focus ?? []).slice(0, PROMPT.MAX_FOCUS_ITEMS);
			const suppressed = (attention.suppressed ?? []).slice(0, PROMPT.MAX_SUPPRESSED_ITEMS);
			const insights = (report.insights ?? []).slice(0, PROMPT.MAX_INSIGHTS);
			const resolvedCount = (predictions.predictions ?? []).filter((p) => p.resolvedAt !== undefined).length;

			const lines: string[] = [];
			if (focus.length > 0) lines.push(`- **Focus:** ${focus.join('; ')}`);
			if (suppressed.length > 0) lines.push(`- **Ignore:** ${suppressed.join('; ')}`);
			if (insights.length > 0) {
				lines.push(`- **Insights:** ${insights.map((i) => i.insight).join(' | ')}`);
			}
			if (resolvedCount > 0) {
				const score = predictions.calibrationScore;
				lines.push(`- **Calibration:** ${score.toFixed(2)} (${resolvedCount} resolved) — ${this.calibrationGuidance(score)}`);
			}

			if (lines.length === 0) return '';

			const section = `## Your Self-Model\n${lines.join('\n')}`;
			return section.length > PROMPT.MAX_CHARS ? `${section.slice(0, PROMPT.MAX_CHARS - 1)}…` : section;
		} catch {
			return '';
		}
	}

	/**
	 * One line of guidance keyed off the calibration score.
	 *
	 * @param score - Calibration score (0-1)
	 * @returns Guidance sentence
	 */
	private calibrationGuidance(score: number): string {
		const { PROMPT } = SELF_IMPROVEMENT_CONSTANTS;
		if (score < PROMPT.LOW_CALIBRATION) {
			return 'your confidence has been running ahead of your accuracy; state lower confidence and verify before committing.';
		}
		if (score >= PROMPT.HIGH_CALIBRATION) {
			return 'well calibrated; keep recording predictions so this stays honest.';
		}
		return 'reasonably calibrated; hedge when the evidence is thin.';
	}
}
