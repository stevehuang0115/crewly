import { PromptModule, ModuleConfig } from './prompt-module.interface.js';
import { STANDING_ANSWERS_CONSTANTS } from '../../../constants.js';
import {
	StandingAnswersService,
	type StandingPageStatus,
} from '../../memory/standing-answers.service.js';
import { redactSensitive } from '../../wiki/wiki-redaction.js';
import { LoggerService, type ComponentLogger } from '../../core/logger.service.js';

/** Heading of the section this module emits. */
export const STANDING_ANSWERS_HEADING = '## Standing Answers';

/**
 * Render the Standing Answers section from page statuses, under the prompt cap.
 *
 * Pages with no sections are skipped. The agent page comes first (what I
 * owe), then project pages. A stale page is labelled with how many newer
 * memories it has not absorbed. Each page body is capped at
 * `PROMPT_PAGE_MAX_CHARS`; pages that would push the section past
 * `PROMPT_MAX_CHARS` are named in a "not shown" line instead. The result is
 * never longer than `PROMPT_MAX_CHARS`. Secrets are masked on the way out
 * even though writes already mask them (a page can be hand-edited).
 *
 * @param statuses - Page statuses from {@link StandingAnswersService}
 * @param maxChars - Section cap (default `PROMPT_MAX_CHARS`)
 * @returns Section markdown, or '' when no page has content
 *
 * @example
 * ```typescript
 * const md = renderStandingAnswers(await service.listPageStatuses({ projectPath, sessionName }));
 * ```
 */
export function renderStandingAnswers(
	statuses: readonly StandingPageStatus[],
	maxChars: number = STANDING_ANSWERS_CONSTANTS.PROMPT_MAX_CHARS,
): string {
	const withContent = statuses
		.filter((s) => (s.page?.sections.length ?? 0) > 0)
		.sort((a, b) => (a.def.scope === b.def.scope ? 0 : a.def.scope === 'agent' ? -1 : 1));
	if (withContent.length === 0) return '';

	const header = [
		STANDING_ANSWERS_HEADING,
		'',
		'Settled answers kept current from memory. Use them before calling recall; a page marked **STALE** has not absorbed the newest memories, so recall for anything recent.',
	].join('\n');

	const blocks: string[] = [];
	const notShown: StandingPageStatus[] = [];
	let used = header.length;

	for (const status of withContent) {
		const block = renderPage(status);
		// +2 for the blank line joining blocks; keep room for the not-shown line.
		if (used + 2 + block.length > maxChars) {
			notShown.push(status);
			continue;
		}
		blocks.push(block);
		used += 2 + block.length;
	}

	let out = [header, ...blocks].join('\n\n');
	if (notShown.length) {
		const line = `_Not shown (prompt cap): ${notShown.map((s) => `"${s.def.question}" — ${s.filePath}`).join('; ')}_`;
		out = `${out}\n\n${line}`;
	}
	// Absolute guarantee: the cap holds even for a pathological not-shown line.
	return out.length > maxChars ? `${out.slice(0, maxChars - 1)}…` : out;
}

/**
 * Render one page: question, freshness line, then its sections (demoted to
 * `####`), body capped at `PROMPT_PAGE_MAX_CHARS`.
 */
function renderPage(status: StandingPageStatus): string {
	const page = status.page!;
	const refreshed = page.lastRefreshed ? page.lastRefreshed.slice(0, 10) : 'never';
	const freshness = status.stale
		? `**STALE** — ${status.newerEntries} newer memor${status.newerEntries === 1 ? 'y' : 'ies'} since this page was refreshed (${refreshed}); treat it as possibly outdated.`
		: `_${status.def.scope} · refreshed ${refreshed}_`;

	let body = page.sections.map((s) => `#### ${s.heading}\n${s.body}`).join('\n\n');
	body = redactSensitive(body);
	const cap = STANDING_ANSWERS_CONSTANTS.PROMPT_PAGE_MAX_CHARS;
	if (body.length > cap) {
		body = `${body.slice(0, cap)}\n… (truncated; full page: ${status.filePath})`;
	}
	return [`### ${redactSensitive(page.question ?? status.def.question)}`, freshness, '', body].join('\n');
}

/**
 * Standing Answers module — boot-time settled knowledge (#816).
 *
 * Reads the project's standing pages and the agent's own page as plain
 * files (no retrieval, no LLM), marks a page STALE when newer in-scope
 * memories exist, and renders them under a hard character cap so an agent
 * can answer "what decisions are in force / what's unfinished" without
 * calling recall.
 *
 * Priority 1.7: after Active Work (1.5) and the session briefing (1.6),
 * before the recovery protocol (2). Compactable — it is reference material,
 * and the assembler may trim it under budget pressure; its own cap
 * (`PROMPT_MAX_CHARS` ≈ 2 000 tokens) keeps it well inside `maxTokens`.
 * Fail-soft: any read error yields '' rather than breaking assembly.
 */
export class StandingAnswersModule implements PromptModule {
	name = 'standing-answers';
	priority = 1.7;
	maxTokens = Math.ceil(STANDING_ANSWERS_CONSTANTS.PROMPT_MAX_CHARS / 4);
	compactable = true;

	private readonly logger: ComponentLogger;

	/**
	 * @param service - Page reader (injectable for tests)
	 */
	constructor(private readonly service: StandingAnswersService = new StandingAnswersService()) {
		this.logger = LoggerService.getInstance().createComponentLogger('StandingAnswersModule');
	}

	/**
	 * Included when there is a project or a session to read pages for.
	 *
	 * @param config - Module configuration
	 * @returns true when `projectPath` or `sessionName` is set
	 */
	shouldInclude(config: ModuleConfig): boolean {
		return Boolean(config.projectPath || config.sessionName);
	}

	/**
	 * Read the pages and render the section.
	 *
	 * @param config - Module configuration (`projectPath`, `sessionName`)
	 * @returns Section markdown, or '' when no page has content or reading fails
	 */
	async build(config: ModuleConfig): Promise<string> {
		try {
			const statuses = await this.service.listPageStatuses({
				projectPath: config.projectPath,
				sessionName: config.sessionName,
			});
			const md = renderStandingAnswers(statuses);
			this.logger.debug('Standing answers rendered', {
				sessionName: config.sessionName,
				pagesExamined: statuses.length,
				pagesWithContent: statuses.filter((s) => (s.page?.sections.length ?? 0) > 0).length,
				stale: statuses.filter((s) => s.page && s.stale).map((s) => s.def.id),
				chars: md.length,
			});
			return md;
		} catch (err) {
			this.logger.warn('Standing answers could not be read — skipping', {
				sessionName: config.sessionName,
				error: err instanceof Error ? err.message : String(err),
			});
			return '';
		}
	}
}
