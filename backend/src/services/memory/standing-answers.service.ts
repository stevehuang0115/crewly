/**
 * StandingAnswersService — question-anchored pages kept current from memory.
 *
 * Memory is a flat pile (in this repo: ~330 decisions, ~190 gotchas, ~120
 * patterns) that agents must `recall`, and recall rarely hits at startup.
 * A standing-answer page is the settled answer to one recurring question
 * ("What decisions are in force?"), written by an agent from the entries
 * behind it and read at boot as a plain file (#816). The idea is the
 * "mental models" of vectorize-io/hindsight, copied as an idea only.
 *
 * Page file:
 *
 * ```
 * ---
 * question: "What decisions are in force?"
 * last_refreshed: 2026-09-26T15:00:00.000Z
 * watermark: 2026-09-26T14:58:12.000Z
 * ---
 *
 * ## Prompt assembly
 * New prompt content must be a prompt module ...
 *
 * Sources: dec:0f3c..., dec:9a1b...
 * ```
 *
 * - `watermark` is the newest timestamp among the page's in-scope memory
 *   entries when it was last written. A page is **stale** when an in-scope
 *   entry is newer than its watermark.
 * - Every section cites the entries it was built from. Writes go through
 *   {@link StandingAnswersService.writeSection}, which checks each citation
 *   against the page's sources and masks anything that looks like a secret.
 * - A section's **basis is invalidated** when a cited entry was deleted or
 *   is no longer in force (superseded, expired, resolved). The watermark
 *   does not move for these, so they are checked on every read
 *   ({@link findInvalidatedSections}) and also make the page need a refresh.
 * - No LLM runs here. The only writer is an agent working a refresh
 *   WorkItem (see standing-refresh.service.ts), raised only when the
 *   watermark moves.
 *
 * @module services/memory/standing-answers.service
 */

import path from 'path';
import { promises as fs } from 'fs';
import { MEMORY_CONSTANTS, STANDING_ANSWERS_CONSTANTS } from '../../constants.js';
import { getCrewlyHomePath, resolveProjectDataDir } from '../core/crewly-home.utils.js';
import { redactSensitive } from '../wiki/wiki-redaction.js';
import { atomicWriteFile, ensureDir } from '../../utils/file-io.utils.js';
import { isHiddenFromDefaultRecall } from './role-knowledge-eligibility.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Whose knowledge a page summarises. */
export type StandingScope = 'project' | 'agent';

/** Which memory collection a page is built from. */
export type StandingSource = 'decisions' | 'gotchas' | 'user_preferences' | 'agent_memory';

/** A standing-answer page definition. */
export interface StandingPageDef {
	/** Stable page id; also the file name for project pages (`<id>.md`). */
	id: string;
	scope: StandingScope;
	/** The recurring question the page answers. */
	question: string;
	source: StandingSource;
}

/** One memory entry a page may be built from, normalised across sources. */
export interface StandingSourceEntry {
	/** Citation token, `<kind>:<id>` (kinds: dec, got, pref, mem). */
	cite: string;
	title: string;
	text: string;
	/** Newest relevant timestamp of the entry (ISO); drives the watermark. */
	at: string;
	/**
	 * False for superseded/deprecated decisions, resolved gotchas, and
	 * superseded or expired memories ({@link isHiddenFromDefaultRecall}).
	 */
	inForce: boolean;
	/** Citation of the entry that replaced this one, when recorded (#884). */
	supersededBy?: string;
}

/** Why a cited entry no longer supports a section. */
export type InvalidCiteReason = 'deleted' | 'not_in_force';

/** One citation a section can no longer rely on. */
export interface InvalidCite {
	cite: string;
	reason: InvalidCiteReason;
}

/** A section at least one of whose cited entries is gone or no longer in force. */
export interface InvalidatedSection {
	heading: string;
	invalidCites: InvalidCite[];
}

/** One `## heading` section of a page. */
export interface StandingSection {
	heading: string;
	body: string;
	cites: string[];
}

/** A parsed page file. */
export interface StandingPage {
	question?: string;
	lastRefreshed?: string;
	watermark?: string;
	sections: StandingSection[];
}

/** Where to look: a project, an agent session, or both. */
export interface StandingLocation {
	projectPath?: string;
	sessionName?: string;
}

/** A page definition resolved against the disk and its sources. */
export interface StandingPageStatus {
	def: StandingPageDef;
	filePath: string;
	/** Parsed page, or undefined when the file does not exist. */
	page?: StandingPage;
	/** Newest in-scope entry timestamp now, or null when there are no entries. */
	currentWatermark: string | null;
	/** In-scope entries examined. */
	entriesInScope: number;
	/** In-scope entries newer than the page's watermark (all of them when it has none). */
	newerEntries: number;
	/** True when the page is missing, has no watermark, or has newer entries. */
	stale: boolean;
	/**
	 * Sections whose basis was invalidated (a cited entry deleted, superseded,
	 * expired or resolved). Non-empty means the page needs a refresh even when
	 * it is not stale, since retractions do not move the watermark (#914).
	 */
	invalidatedSections: InvalidatedSection[];
}

/** Input to {@link StandingAnswersService.writeSection}. */
export interface WriteSectionInput extends StandingLocation {
	pageId: string;
	heading: string;
	/** Section body; an empty body removes the section. */
	body: string;
	/** Citations (`dec:<id>` …); at least one unless removing. */
	cites: string[];
}

/** Result of a section write. */
export interface WriteSectionResult {
	filePath: string;
	watermark: string | null;
	removed: boolean;
	/** True when something that looked like a secret was masked out. */
	masked: boolean;
}

/** Error codes for rejected writes. */
export type StandingErrorCode = 'unknown_page' | 'invalid_input' | 'unknown_cite' | 'missing_cite';

/** A write rejected for a reason the caller can fix. */
export class StandingAnswersError extends Error {
	constructor(public readonly code: StandingErrorCode, message: string) {
		super(message);
		this.name = 'StandingAnswersError';
	}
}

// ---------------------------------------------------------------------------
// Page definitions
// ---------------------------------------------------------------------------

/** Project-scope pages, under `<project>/.crewly/wiki/llm-curated/standing/`. */
export const PROJECT_STANDING_PAGES: readonly StandingPageDef[] = [
	{ id: 'decisions-in-force', scope: 'project', question: 'What decisions are in force?', source: 'decisions' },
	{ id: 'open-gotchas', scope: 'project', question: 'Which gotchas are still open?', source: 'gotchas' },
	{ id: 'owner-preferences', scope: 'project', question: 'What does the owner prefer?', source: 'user_preferences' },
];

/** The agent page, at `<CREWLY_HOME>/agents/<session>/standing.md`. */
export const AGENT_STANDING_PAGE: StandingPageDef = {
	id: STANDING_ANSWERS_CONSTANTS.AGENT_PAGE_ID,
	scope: 'agent',
	question: 'What is my unfinished work, and what is blocking it?',
	source: 'agent_memory',
};

/**
 * Look up a page definition by id.
 *
 * @param pageId - Page id
 * @returns The definition, or undefined
 */
export function findStandingPageDef(pageId: string): StandingPageDef | undefined {
	return [...PROJECT_STANDING_PAGES, AGENT_STANDING_PAGE].find((d) => d.id === pageId);
}

// ---------------------------------------------------------------------------
// Pure helpers: parse / serialise / edit / watermark
// ---------------------------------------------------------------------------

const SOURCES_PREFIX = 'Sources:';
const FRONTMATTER_FENCE = '---';

/**
 * Parse one frontmatter value: JSON-quoted strings are decoded, anything
 * else is taken verbatim (trimmed).
 */
function parseFrontmatterValue(raw: string): string {
	const v = raw.trim();
	if (v.startsWith('"')) {
		try {
			return JSON.parse(v) as string;
		} catch {
			return v.replace(/^"|"$/g, '');
		}
	}
	return v;
}

/**
 * Parse a standing page file.
 *
 * Tolerant of hand edits: unknown frontmatter keys are ignored, text before
 * the first `## ` heading is ignored, and a section's trailing
 * `Sources: a, b` line becomes its citations.
 *
 * @param raw - File contents
 * @returns The parsed page
 */
export function parseStandingPage(raw: string): StandingPage {
	const page: StandingPage = { sections: [] };
	let lines = raw.replace(/\r\n/g, '\n').split('\n');

	if (lines[0]?.trim() === FRONTMATTER_FENCE) {
		const end = lines.findIndex((l, i) => i > 0 && l.trim() === FRONTMATTER_FENCE);
		if (end > 0) {
			for (const line of lines.slice(1, end)) {
				const m = /^([a-z_]+):(.*)$/.exec(line);
				if (!m) continue;
				const value = parseFrontmatterValue(m[2]);
				if (m[1] === 'question') page.question = value;
				else if (m[1] === 'last_refreshed') page.lastRefreshed = value;
				else if (m[1] === 'watermark') page.watermark = value;
			}
			lines = lines.slice(end + 1);
		}
	}

	let current: StandingSection | null = null;
	const bodyLines: string[] = [];
	const flush = (): void => {
		if (!current) return;
		const kept = [...bodyLines];
		while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
		const last = kept[kept.length - 1]?.trim() ?? '';
		if (last.startsWith(SOURCES_PREFIX)) {
			current.cites = last
				.slice(SOURCES_PREFIX.length)
				.split(',')
				.map((c) => c.trim())
				.filter(Boolean);
			kept.pop();
		}
		current.body = kept.join('\n').trim();
		page.sections.push(current);
	};

	for (const line of lines) {
		const h = /^## (.+)$/.exec(line);
		if (h) {
			flush();
			current = { heading: h[1].trim(), body: '', cites: [] };
			bodyLines.length = 0;
		} else if (current) {
			bodyLines.push(line);
		}
	}
	flush();
	return page;
}

/**
 * Serialise a page back to its file form.
 *
 * @param page - Page to write
 * @returns File contents
 */
export function serializeStandingPage(page: StandingPage): string {
	const fm = [FRONTMATTER_FENCE];
	if (page.question !== undefined) fm.push(`question: ${JSON.stringify(page.question)}`);
	if (page.lastRefreshed) fm.push(`last_refreshed: ${page.lastRefreshed}`);
	if (page.watermark) fm.push(`watermark: ${page.watermark}`);
	fm.push(FRONTMATTER_FENCE);

	const sections = page.sections.map((s) => {
		const parts = [`## ${s.heading}`, '', s.body];
		if (s.cites.length) parts.push('', `${SOURCES_PREFIX} ${s.cites.join(', ')}`);
		return parts.join('\n');
	});
	return `${fm.join('\n')}\n\n${sections.join('\n\n')}\n`;
}

/**
 * Replace, append or remove one section (matched by heading, case-insensitive).
 *
 * @param page - Page to edit (not mutated)
 * @param section - New section; an empty body removes the heading
 * @returns The edited page and whether a section was removed
 */
export function upsertSection(page: StandingPage, section: StandingSection): { page: StandingPage; removed: boolean } {
	const key = section.heading.trim().toLowerCase();
	const idx = page.sections.findIndex((s) => s.heading.trim().toLowerCase() === key);
	const sections = [...page.sections];
	if (!section.body.trim()) {
		if (idx >= 0) sections.splice(idx, 1);
		return { page: { ...page, sections }, removed: idx >= 0 };
	}
	if (idx >= 0) sections[idx] = section;
	else sections.push(section);
	return { page: { ...page, sections }, removed: false };
}

/**
 * The newest timestamp among entries, as ISO, or null for none.
 *
 * @param entries - Source entries
 * @returns ISO watermark or null
 */
export function computeWatermark(entries: readonly StandingSourceEntry[]): string | null {
	let best = Number.NEGATIVE_INFINITY;
	for (const e of entries) {
		const t = Date.parse(e.at);
		if (Number.isFinite(t) && t > best) best = t;
	}
	return Number.isFinite(best) ? new Date(best).toISOString() : null;
}

/**
 * Count entries strictly newer than a watermark (all, when there is none).
 *
 * @param entries - Source entries
 * @param watermark - Page watermark (ISO) or undefined
 * @returns Number of newer entries
 */
export function countNewer(entries: readonly StandingSourceEntry[], watermark: string | undefined): number {
	const w = watermark ? Date.parse(watermark) : Number.NaN;
	if (!Number.isFinite(w)) return entries.length;
	return entries.filter((e) => Date.parse(e.at) > w).length;
}

/**
 * Sections whose cited entries are no longer all valid (#914).
 *
 * A citation is invalid when no in-scope entry carries it (the entry was
 * deleted, or is no longer in scope) or when its entry is not in force
 * (superseded, deprecated, expired, resolved). Deterministic: no LLM, just
 * a set difference per section.
 *
 * @param page - Parsed page (undefined when missing)
 * @param entries - The page's current source entries
 * @returns One item per affected section, in page order, each naming its invalid citations
 *
 * @example
 * ```typescript
 * findInvalidatedSections(page, entries);
 * // [{ heading: 'Prompts', invalidCites: [{ cite: 'dec:d2', reason: 'not_in_force' }] }]
 * ```
 */
export function findInvalidatedSections(
	page: StandingPage | undefined,
	entries: readonly StandingSourceEntry[],
): InvalidatedSection[] {
	if (!page) return [];
	const byCite = new Map(entries.map((e) => [e.cite, e]));
	const out: InvalidatedSection[] = [];
	for (const section of page.sections) {
		const invalidCites: InvalidCite[] = [];
		for (const cite of section.cites) {
			const entry = byCite.get(cite);
			if (!entry) invalidCites.push({ cite, reason: 'deleted' });
			else if (!entry.inForce) invalidCites.push({ cite, reason: 'not_in_force' });
		}
		if (invalidCites.length) out.push({ heading: section.heading, invalidCites });
	}
	return out;
}

/**
 * A stable key for a page's invalidated citations (sorted, comma-joined),
 * '' when none. The refresh service stores it next to the watermark so a
 * retraction re-raises a refresh once, not on every tick.
 *
 * @param sections - Invalidated sections of one page
 * @returns The key
 */
export function invalidationKey(sections: readonly InvalidatedSection[]): string {
	return [...new Set(sections.flatMap((s) => s.invalidCites.map((c) => c.cite)))].sort().join(',');
}

/**
 * Format invalid citations for display: `dec:x (deleted), got:y (no longer in force)`.
 *
 * @param cites - Invalid citations
 * @returns One-line list
 */
export function formatInvalidCites(cites: readonly InvalidCite[]): string {
	return cites.map((c) => `${c.cite} (${c.reason === 'deleted' ? 'deleted' : 'no longer in force'})`).join(', ');
}

/** Newest of several optional ISO timestamps (ISO), or '' when none parse. */
function newestOf(...values: Array<string | undefined>): string {
	let best = Number.NEGATIVE_INFINITY;
	for (const v of values) {
		const t = v ? Date.parse(v) : Number.NaN;
		if (Number.isFinite(t) && t > best) best = t;
	}
	return Number.isFinite(best) ? new Date(best).toISOString() : '';
}

/** Shorten text for a one-line listing. */
function excerpt(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Raw shapes read from the memory JSON files (only the fields used). */
interface RawDecision { id?: string; title?: string; decision?: string; decidedAt?: string; status?: string; outcomeRecordedAt?: string; supersededBy?: string; ttl?: string }
interface RawGotcha { id?: string; title?: string; problem?: string; solution?: string; createdAt?: string; resolved?: boolean; resolvedAt?: string }
interface RawPattern { id?: string; title?: string; description?: string; category?: string; createdAt?: string }
interface RawKnowledge { id?: string; content?: string; createdAt?: string; superseded?: boolean; supersededBy?: string; ttl?: string }

/**
 * Reads, checks and writes standing-answer pages.
 *
 * Stateless apart from its paths; every call reads the files fresh, which
 * keeps the boot-time read honest (no cache can hide a newer memory).
 */
export class StandingAnswersService {
	private readonly crewlyHome: string;

	/**
	 * @param options - `crewlyHome` overrides {@link getCrewlyHomePath} (tests)
	 */
	constructor(options: { crewlyHome?: string } = {}) {
		this.crewlyHome = options.crewlyHome ?? getCrewlyHomePath();
	}

	/**
	 * File path of a page for a location.
	 *
	 * @param def - Page definition
	 * @param loc - Project path (project pages) or session name (agent page)
	 * @returns Absolute path, or null when the location lacks what the scope needs
	 */
	pagePath(def: StandingPageDef, loc: StandingLocation): string | null {
		if (def.scope === 'project') {
			if (!loc.projectPath) return null;
			return path.join(resolveProjectDataDir(loc.projectPath), STANDING_ANSWERS_CONSTANTS.PROJECT_DIR, `${def.id}.md`);
		}
		if (!loc.sessionName || !isSafeSegment(loc.sessionName)) return null;
		return path.join(this.crewlyHome, MEMORY_CONSTANTS.PATHS.AGENTS_DIR, loc.sessionName, STANDING_ANSWERS_CONSTANTS.AGENT_FILE);
	}

	/**
	 * Load the memory entries a page is built from. Missing or unreadable
	 * files yield an empty list (a fresh project has no memory yet).
	 *
	 * @param def - Page definition
	 * @param loc - Location
	 * @returns Normalised entries, newest first
	 */
	async loadSourceEntries(def: StandingPageDef, loc: StandingLocation): Promise<StandingSourceEntry[]> {
		let entries: StandingSourceEntry[] = [];
		if (def.scope === 'project' && loc.projectPath) {
			const dir = path.join(resolveProjectDataDir(loc.projectPath), MEMORY_CONSTANTS.PATHS.KNOWLEDGE_DIR);
			if (def.source === 'decisions') {
				const raw = await readJsonArray<RawDecision>(path.join(dir, MEMORY_CONSTANTS.PROJECT_FILES.DECISIONS));
				entries = raw
					.filter((d) => d.id && !isCompletionRecord(d))
					.map((d) => ({
						cite: `dec:${d.id}`,
						title: d.title ?? '',
						text: d.decision ?? '',
						at: newestOf(d.decidedAt, d.outcomeRecordedAt),
						inForce: d.status !== 'superseded' && d.status !== 'deprecated' && !isHiddenFromDefaultRecall(d),
						...(d.supersededBy ? { supersededBy: `dec:${d.supersededBy}` } : {}),
					}));
			} else if (def.source === 'gotchas') {
				const raw = await readJsonArray<RawGotcha>(path.join(dir, MEMORY_CONSTANTS.PROJECT_FILES.GOTCHAS));
				entries = raw
					.filter((g) => g.id)
					.map((g) => ({
						cite: `got:${g.id}`,
						title: g.title ?? '',
						text: [g.problem, g.solution ? `Fix: ${g.solution}` : ''].filter(Boolean).join(' '),
						at: newestOf(g.createdAt, g.resolvedAt),
						inForce: !g.resolved,
					}));
			} else if (def.source === 'user_preferences') {
				const raw = await readJsonArray<RawPattern>(path.join(dir, MEMORY_CONSTANTS.PROJECT_FILES.PATTERNS));
				entries = raw
					.filter((p) => p.id && p.category === 'user_preference')
					.map((p) => ({ cite: `pref:${p.id}`, title: p.title ?? '', text: p.description ?? '', at: newestOf(p.createdAt), inForce: true }));
			}
		} else if (def.scope === 'agent' && def.source === 'agent_memory' && loc.sessionName && isSafeSegment(loc.sessionName)) {
			const file = path.join(this.crewlyHome, MEMORY_CONSTANTS.PATHS.AGENTS_DIR, loc.sessionName, MEMORY_CONSTANTS.AGENT_FILES.MEMORY);
			const memory = await readJsonObject<{ roleKnowledge?: RawKnowledge[] }>(file);
			entries = (memory?.roleKnowledge ?? [])
				.filter((k) => k.id && !(k.content ?? '').startsWith(STANDING_ANSWERS_CONSTANTS.COMPLETED_LEARNING_PREFIX))
				.map((k) => ({
					cite: `mem:${k.id}`,
					title: excerpt(k.content ?? '', 80),
					text: k.content ?? '',
					at: newestOf(k.createdAt),
					inForce: !isHiddenFromDefaultRecall(k),
				}));
		}
		return entries.filter((e) => e.at).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
	}

	/**
	 * Resolve a page against the disk and its sources.
	 *
	 * @param def - Page definition
	 * @param loc - Location
	 * @returns Status, or null when the location cannot hold this page
	 */
	async getPageStatus(def: StandingPageDef, loc: StandingLocation): Promise<StandingPageStatus | null> {
		const filePath = this.pagePath(def, loc);
		if (!filePath) return null;
		const [raw, entries] = await Promise.all([readText(filePath), this.loadSourceEntries(def, loc)]);
		const page = raw === null ? undefined : parseStandingPage(raw);
		const newerEntries = countNewer(entries, page?.watermark);
		return {
			invalidatedSections: findInvalidatedSections(page, entries),
			def,
			filePath,
			page,
			currentWatermark: computeWatermark(entries),
			entriesInScope: entries.length,
			newerEntries,
			stale: !page || !page.watermark || newerEntries > 0,
		};
	}

	/**
	 * Status of every page a location can hold: the project pages when a
	 * project path is given, the agent page when a session is given.
	 *
	 * @param loc - Location
	 * @returns Statuses, project pages first
	 */
	async listPageStatuses(loc: StandingLocation): Promise<StandingPageStatus[]> {
		const defs = [...(loc.projectPath ? PROJECT_STANDING_PAGES : []), ...(loc.sessionName ? [AGENT_STANDING_PAGE] : [])];
		const all = await Promise.all(defs.map((d) => this.getPageStatus(d, loc)));
		return all.filter((s): s is StandingPageStatus => s !== null);
	}

	/**
	 * Write one section of a page (section-level edit).
	 *
	 * Validates the heading and body, requires every citation to name an
	 * entry in the page's sources, masks secrets, then stamps
	 * `last_refreshed` and moves `watermark` to the sources' current
	 * watermark. Creates the page (with its question) when missing.
	 *
	 * @param input - Page, location, section and citations
	 * @returns Where it was written and the new watermark
	 * @throws StandingAnswersError for an unknown page, bad input, or a
	 *   citation that is missing or does not resolve
	 */
	async writeSection(input: WriteSectionInput): Promise<WriteSectionResult> {
		const def = findStandingPageDef(input.pageId);
		if (!def) {
			throw new StandingAnswersError('unknown_page', `Unknown standing page "${input.pageId}". Known: ${[...PROJECT_STANDING_PAGES, AGENT_STANDING_PAGE].map((d) => d.id).join(', ')}`);
		}
		const loc: StandingLocation = def.scope === 'project' ? { projectPath: input.projectPath } : { sessionName: input.sessionName };
		const filePath = this.pagePath(def, loc);
		if (!filePath) {
			throw new StandingAnswersError('invalid_input', def.scope === 'project' ? 'projectPath is required for a project page' : 'a valid sessionName is required for the agent page');
		}

		const heading = input.heading.trim();
		if (!heading || heading.length > STANDING_ANSWERS_CONSTANTS.HEADING_MAX_CHARS || /[\r\n]/.test(heading)) {
			throw new StandingAnswersError('invalid_input', `heading must be one line of 1-${STANDING_ANSWERS_CONSTANTS.HEADING_MAX_CHARS} characters`);
		}
		const body = input.body.replace(/\r\n/g, '\n').trim();
		if (body.length > STANDING_ANSWERS_CONSTANTS.SECTION_MAX_CHARS) {
			throw new StandingAnswersError('invalid_input', `body is ${body.length} characters; the cap is ${STANDING_ANSWERS_CONSTANTS.SECTION_MAX_CHARS}. Summarise — a standing answer is not a log.`);
		}
		if (/^(#{1,2} |---\s*$|Sources:)/m.test(body)) {
			throw new StandingAnswersError('invalid_input', 'body must not contain "# "/"## " headings, "---" lines or a "Sources:" line (use ### for sub-headings; citations go in cites)');
		}

		const cites = [...new Set(input.cites.map((c) => c.trim()).filter(Boolean))];
		const entries = await this.loadSourceEntries(def, loc);
		if (body) {
			if (cites.length === 0) {
				throw new StandingAnswersError('missing_cite', 'cite at least one entry the section is built from');
			}
			if (cites.length > STANDING_ANSWERS_CONSTANTS.MAX_CITES_PER_SECTION) {
				throw new StandingAnswersError('invalid_input', `at most ${STANDING_ANSWERS_CONSTANTS.MAX_CITES_PER_SECTION} citations per section`);
			}
			const known = new Set(entries.map((e) => e.cite));
			const unknown = cites.filter((c) => !known.has(c));
			if (unknown.length) {
				throw new StandingAnswersError('unknown_cite', `not in this page's sources (${def.source}): ${unknown.join(', ')}`);
			}
		}

		const maskedBody = redactSensitive(body);
		const maskedHeading = redactSensitive(heading);
		const raw = await readText(filePath);
		const existing: StandingPage = raw === null ? { sections: [] } : parseStandingPage(raw);
		const { page, removed } = upsertSection(existing, { heading: maskedHeading, body: maskedBody, cites: body ? cites : [] });
		const watermark = computeWatermark(entries);
		const next: StandingPage = {
			...page,
			question: existing.question ?? def.question,
			lastRefreshed: new Date().toISOString(),
			watermark: watermark ?? undefined,
		};

		await ensureDir(path.dirname(filePath));
		await atomicWriteFile(filePath, serializeStandingPage(next));
		return { filePath, watermark, removed, masked: maskedBody !== body || maskedHeading !== heading };
	}

	/**
	 * The brief for a refresh WorkItem: the question, the current sections,
	 * and the in-scope entries to use (newer than the watermark first), with
	 * secrets masked and each entry's citation token.
	 *
	 * @param status - The page's status
	 * @param loc - Location (for the skill command)
	 * @param agentSkillsPath - Absolute path of the agent skills directory
	 * @returns Markdown brief
	 */
	async buildRefreshBrief(status: StandingPageStatus, loc: StandingLocation, agentSkillsPath: string): Promise<string> {
		const entries = await this.loadSourceEntries(status.def, loc);
		const w = status.page?.watermark ? Date.parse(status.page.watermark) : Number.NaN;
		const newer = entries.filter((e) => !Number.isFinite(w) || Date.parse(e.at) > w);
		const older = entries.filter((e) => Number.isFinite(w) && Date.parse(e.at) <= w && e.inForce);
		const shown = [...newer, ...older].slice(0, STANDING_ANSWERS_CONSTANTS.BRIEF_MAX_ENTRIES);
		const where = status.def.scope === 'project' ? `--project ${shellQuote(loc.projectPath ?? '')}` : `--session ${loc.sessionName}`;

		const lines = [
			'# Standing Answer Refresh',
			'',
			`**Question:** ${status.def.question}`,
			`**Page:** \`${status.def.id}\` (${status.def.scope}) — \`${status.filePath}\``,
			`**Watermark:** ${status.page?.watermark ?? 'none (page not written yet)'} → ${status.currentWatermark ?? 'none'} · ${status.newerEntries} newer entr${status.newerEntries === 1 ? 'y' : 'ies'} of ${status.entriesInScope} in scope`,
			'',
			'Answer the question as it stands NOW: what is in force, not a log of what happened. One `## section` per topic. Remove a section (empty body) when what it says is no longer true — a decision superseded, a gotcha resolved.',
			'',
			'## Current sections',
			...(status.page?.sections.length ? status.page.sections.map((s) => `- ${s.heading} (${s.cites.length} source${s.cites.length === 1 ? '' : 's'})${invalidNote(status, s.heading)}`) : ['- (none)']),
			'',
			`## Entries (${shown.length} shown of ${entries.length}; entries newer than the watermark first, then older ones still in force; newest first within each group, full UTC timestamps)`,
			'When two entries on the same topic disagree, the one with the later timestamp is in force: write the page from it and drop the earlier state. A "waiting on X" or "pending" state may already be settled elsewhere (another thread, the mailbox): verify it in that primary source before writing it as pending.',
			...shown.map((e) => `- \`${e.cite}\` · ${e.at}${e.inForce ? '' : e.supersededBy ? ` · NOT IN FORCE (superseded by \`${e.supersededBy}\`)` : ' · NOT IN FORCE'} · ${redactSensitive(excerpt(`${e.title} — ${e.text}`, STANDING_ANSWERS_CONSTANTS.BRIEF_ENTRY_MAX_CHARS))}`),
			...possibleSupersedeLines(shown),
			'',
			'## Write each changed section (do not edit the file by hand — the skill checks citations and masks secrets)',
			'```bash',
			`bash ${agentSkillsPath}/core/standing-update/execute.sh --page ${status.def.id} ${where} --heading "<section heading>" --body-file <file> --cites "<cite>,<cite>"`,
			'```',
			`Body ≤ ${STANDING_ANSWERS_CONSTANTS.SECTION_MAX_CHARS} chars, cite every entry you used. Mark this WorkItem done with a one-line summary when the page answers the question.`,
		];
		return lines.join('\n');
	}
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

/** Words too common to signal a shared topic. */
const TOPIC_STOPWORDS = new Set(['that', 'this', 'with', 'from', 'have', 'will', 'were', 'been', 'into', 'than', 'then', 'they', 'them', 'their', 'there', 'what', 'when', 'which', 'would', 'should', 'could', 'about', 'after', 'before', 'still', 'only', 'also', 'more', 'some', 'does', 'done', 'just', 'over', 'each', 'very']);

/** Lower-case topic words (4+ letters, not stopwords) of an entry. */
function topicWords(e: StandingSourceEntry): Set<string> {
	const words = `${e.title} ${e.text}`.toLowerCase().match(/[\p{L}\p{N}$]{4,}/gu) ?? [];
	return new Set(words.filter((w) => !TOPIC_STOPWORDS.has(w)));
}

/**
 * Pairs of in-force entries from the same UTC day that share a topic: the
 * later one may replace the earlier one without a supersede link (#884).
 * Returned as brief lines so the refresher checks their order.
 *
 * @param entries - Entries shown in the brief
 * @returns Brief lines (empty when there is nothing to flag)
 */
export function possibleSupersedeLines(entries: StandingSourceEntry[]): string[] {
	const live = entries.filter((e) => e.inForce);
	const words = live.map(topicWords);
	const lines: string[] = [];
	for (let i = 0; i < live.length; i++) {
		for (let j = i + 1; j < live.length; j++) {
			if (live[i].at.slice(0, 10) !== live[j].at.slice(0, 10)) continue;
			let shared = 0;
			for (const w of words[i]) if (words[j].has(w)) shared++;
			if (shared < STANDING_ANSWERS_CONSTANTS.SUPERSEDE_MIN_SHARED_WORDS) continue;
			const [later, earlier] = Date.parse(live[i].at) >= Date.parse(live[j].at) ? [live[i], live[j]] : [live[j], live[i]];
			lines.push(`- POSSIBLE SUPERSEDE: \`${later.cite}\` (${later.at}) may replace \`${earlier.cite}\` (${earlier.at}); same day, same topic. Check the order before merging them.`);
		}
	}
	return lines.length ? ['', '### Check these pairs', ...lines] : [];
}

/** ' — BASIS INVALIDATED: …' for a section whose citations were retracted, else ''. */
function invalidNote(status: StandingPageStatus, heading: string): string {
	const hit = status.invalidatedSections.find((s) => s.heading === heading);
	return hit ? ` — BASIS INVALIDATED: ${formatInvalidCites(hit.invalidCites)}; rewrite it from what is in force, or remove it` : '';
}

/** True for a decision entry that is really a task-completion record. */
function isCompletionRecord(d: RawDecision): boolean {
	const prefix = STANDING_ANSWERS_CONSTANTS.COMPLETED_DECISION_PREFIX;
	return (d.title ?? '').startsWith(prefix) || (d.decision ?? '').startsWith(prefix);
}

/** A session name usable as one path segment. */
function isSafeSegment(value: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..';
}

/** Single-quote a value for a bash command line. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Read a UTF-8 file, or null when it does not exist / cannot be read. */
async function readText(file: string): Promise<string | null> {
	try {
		return await fs.readFile(file, 'utf8');
	} catch {
		return null;
	}
}

/** Read a JSON array file; anything else (missing, corrupt, not an array) is []. */
async function readJsonArray<T>(file: string): Promise<T[]> {
	const raw = await readText(file);
	if (raw === null) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed as T[]) : [];
	} catch {
		return [];
	}
}

/** Read a JSON object file, or null. */
async function readJsonObject<T>(file: string): Promise<T | null> {
	const raw = await readText(file);
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : null;
	} catch {
		return null;
	}
}
