/**
 * Keeps wiki entity pages in step with the App records they describe.
 *
 * A team keeps its customers (people, projects, products) in a Crewly App.
 * The wiki's entity pages are what gets attached to a message that names
 * one of them (wiki-record-attach.service.ts), so a page copied once goes
 * stale the day the App record changes. A vault lists the App collections
 * to copy in `record-sources.json`; this service turns each record into one
 * entity page and rewrites the page when the record changed.
 *
 * No model is involved: fields are rendered as they are. The App stays the
 * record of truth. Anything written on a page under a `## Notes` heading is
 * kept across syncs; pages of deleted records are left in place.
 *
 * @module services/wiki/wiki-record-sync.service
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { WIKI_RECORD_ATTACH_CONSTANTS, WIKI_RECORD_SYNC_CONSTANTS } from '../../constants.js';
import type { WikiIngestInput, WikiIngestOutcome } from './wiki-ingest.service.js';

/** One App collection copied into a vault. */
export interface RecordSource {
	appId: string;
	collection: string;
	/** Entity folder under `llm-curated/` (customers, people, projects, products) */
	folder: string;
	/** Fields whose values make the page title, in order */
	titleFields: string[];
	/** Fields whose values are names the record goes by */
	aliasFields: string[];
	/** Fields whose values make the one-line summary */
	summaryFields: string[];
	tags: string[];
}

/** A document as the Apps service lists it. */
export interface AppDoc {
	id: string;
	data: Record<string, unknown>;
}

/** What one record becomes. */
export interface RenderedRecord {
	relativePath: string;
	title: string;
	summary: string;
	aliases: string[];
	body: string;
}

/** Outcome of syncing one vault. */
export interface RecordSyncReport {
	vaultPath: string;
	sources: number;
	written: string[];
	unchanged: number;
	skipped: Array<{ ref: string; reason: string }>;
	errors: string[];
}

/** What the service needs from the rest of the backend (injectable). */
export interface RecordSyncDeps {
	/**
	 * The agent a vault's records are read as: its team lead. The App's own
	 * access rule then decides (publisher, teammate or collaborator), so a
	 * vault cannot list another team's App and have it copied in.
	 */
	readerFor: (vaultPath: string) => Promise<string | null>;
	/** One page of a collection, read as `agentSession`: `{ docs, next }` */
	listDocs: (appId: string, collection: string, opts: { limit: number; after?: string }, agentSession: string) => Promise<unknown>;
	/** Write a page */
	ingest: (input: WikiIngestInput) => Promise<WikiIngestOutcome>;
	logger?: { info: (message: string, meta?: Record<string, unknown>) => void; warn: (message: string, meta?: Record<string, unknown>) => void };
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ALIAS_SPLIT = /[（）()[\]/,，、;；|]+/;

/**
 * Read a list of non-empty strings.
 *
 * @param value - Config value
 * @returns The strings (possibly none)
 */
function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim()) : [];
}

/**
 * Read a vault's `record-sources.json`.
 *
 * @param vaultPath - Vault root
 * @returns Valid sources and what was wrong with the rest; both empty when the file is absent
 *
 * @example
 * ```json
 * { "sources": [ { "appId": "au35rbdmzt", "collection": "customers", "folder": "customers",
 *   "titleFields": ["company", "name"], "aliasFields": ["company", "name"], "summaryFields": ["stage", "nextStep"] } ] }
 * ```
 */
export function readRecordSources(vaultPath: string): { sources: RecordSource[]; problems: string[] } {
	const file = path.join(vaultPath, WIKI_RECORD_SYNC_CONSTANTS.SOURCES_FILENAME);
	if (!existsSync(file)) return { sources: [], problems: [] };
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, 'utf8'));
	} catch (error) {
		return { sources: [], problems: [`${WIKI_RECORD_SYNC_CONSTANTS.SOURCES_FILENAME} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
	}
	const list = (raw as { sources?: unknown } | null)?.sources;
	if (!Array.isArray(list)) return { sources: [], problems: ['"sources" must be a list'] };
	const sources: RecordSource[] = [];
	const problems: string[] = [];
	const folders: readonly string[] = WIKI_RECORD_ATTACH_CONSTANTS.ENTITY_FOLDERS;
	list.forEach((entry, index) => {
		const e = (entry ?? {}) as Record<string, unknown>;
		const appId = typeof e['appId'] === 'string' ? e['appId'] : '';
		const collection = typeof e['collection'] === 'string' ? e['collection'] : '';
		const folder = typeof e['folder'] === 'string' ? e['folder'] : '';
		const titleFields = stringList(e['titleFields']);
		if (!SAFE_NAME.test(appId) || !SAFE_NAME.test(collection)) return void problems.push(`source ${index}: appId and collection are required`);
		if (!folders.includes(folder)) return void problems.push(`source ${index}: folder must be one of ${folders.join(', ')}`);
		if (titleFields.length === 0) return void problems.push(`source ${index}: titleFields is required`);
		sources.push({ appId, collection, folder, titleFields, aliasFields: stringList(e['aliasFields']), summaryFields: stringList(e['summaryFields']), tags: stringList(e['tags']) });
	});
	return { sources, problems };
}

/**
 * A value as one line of text.
 *
 * @param value - Field value
 * @returns Text, or '' for nothing
 */
function inline(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) return value.map(inline).filter(Boolean).join(', ');
	if (typeof value === 'object') {
		return Object.entries(value as Record<string, unknown>)
			.map(([k, v]) => [k, inline(v)] as const)
			.filter(([, v]) => v)
			.map(([k, v]) => `${k}: ${v}`)
			.join('; ');
	}
	return '';
}

/**
 * One list item for an entry of an array field. A small object of plain
 * values (a timeline entry) reads as its values in order.
 *
 * @param item - Array entry
 * @returns Text, or ''
 */
function listItem(item: unknown): string {
	if (item && typeof item === 'object' && !Array.isArray(item)) {
		const values = Object.values(item as Record<string, unknown>);
		if (values.length <= 3 && values.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))) {
			return values.map(inline).filter(Boolean).join(' ');
		}
	}
	return inline(item);
}

/**
 * Clip a field so one huge value (an embedded image) cannot fill the page.
 *
 * @param text - Field text
 * @returns The text, clipped
 */
function clip(text: string): string {
	const max = WIKI_RECORD_SYNC_CONSTANTS.FIELD_MAX_CHARS;
	return text.length > max ? `${text.slice(0, max)} …` : text;
}

/**
 * A file-name-safe slug for a document id.
 *
 * @param id - Document id
 * @returns The slug, or '' when nothing usable is left
 */
function slugOf(id: string): string {
	return id.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

/**
 * The names found in a field value: the value itself and its parts
 * ("RoboHub (Xin)" gives both).
 *
 * @param value - Field value
 * @returns Candidate names
 */
function namesIn(value: unknown): string[] {
	const texts = Array.isArray(value) ? value.map(inline) : [inline(value)];
	return texts
		.flatMap((text) => [text, ...text.split(ALIAS_SPLIT)])
		.map((name) => name.trim())
		.filter((name) => name.length >= WIKI_RECORD_SYNC_CONSTANTS.ALIAS_MIN_CHARS && name.length <= WIKI_RECORD_SYNC_CONSTANTS.ALIAS_MAX_CHARS);
}

/**
 * Turn one App record into an entity page.
 *
 * @param source - The collection it came from
 * @param doc - The record
 * @returns The page, or null when the record has no usable id or title
 */
export function renderRecord(source: RecordSource, doc: AppDoc): RenderedRecord | null {
	const slug = slugOf(doc.id);
	const data = doc.data ?? {};
	const titleParts = source.titleFields.map((field) => inline(data[field])).filter(Boolean);
	if (!slug || titleParts.length === 0) return null;
	const title = [...new Set(titleParts)].join(' · ').slice(0, WIKI_RECORD_SYNC_CONSTANTS.TITLE_MAX_CHARS);
	const summary = (source.summaryFields.map((field) => inline(data[field])).filter(Boolean).join('; ') || title).slice(0, WIKI_RECORD_SYNC_CONSTANTS.SUMMARY_MAX_CHARS);
	const aliases = [...new Set(source.aliasFields.flatMap((field) => namesIn(data[field])))];

	const facts: string[] = [];
	const sections: string[] = [];
	for (const [key, value] of Object.entries(data)) {
		if (key.startsWith('_')) continue;
		if (Array.isArray(value) && value.some((item) => item && typeof item === 'object')) {
			const items = value.map(listItem).filter(Boolean).map((item) => `- ${clip(item)}`);
			if (items.length > 0) sections.push(`## ${key}\n${items.join('\n')}`);
			continue;
		}
		const text = clip(inline(value));
		if (!text) continue;
		if (text.length <= WIKI_RECORD_SYNC_CONSTANTS.INLINE_FIELD_MAX_CHARS && !text.includes('\n')) facts.push(`- **${key}**: ${text}`);
		else sections.push(`## ${key}\n${text}`);
	}
	const footer = `_Copied from the App record ${source.appId} / ${source.collection} / ${doc.id}. The App is the record of truth; change it there._`;
	const body = [facts.join('\n'), ...sections, footer].filter(Boolean).join('\n\n');
	return { relativePath: `llm-curated/${source.folder}/${slug}.md`, title, summary, aliases, body };
}

/**
 * The parts of an existing page this service cares about.
 *
 * @param file - Absolute page path
 * @returns The body below the front matter and title, and the hand-written notes; null when the page does not exist
 */
function readExisting(file: string): { body: string; notes: string } | null {
	if (!existsSync(file)) return null;
	const text = readFileSync(file, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
	const at = text.search(new RegExp(`^${WIKI_RECORD_SYNC_CONSTANTS.NOTES_HEADING}\\b`, 'm'));
	return at < 0 ? { body: text, notes: '' } : { body: text.slice(0, at), notes: text.slice(at).trimEnd() };
}

/** Copies App records into wiki entity pages. */
export class WikiRecordSyncService {
	/**
	 * @param deps - Dependencies
	 */
	constructor(private readonly deps: RecordSyncDeps) {}

	/**
	 * Every document of a collection, up to the cap.
	 *
	 * @param source - The collection
	 * @param reader - Agent the records are read as
	 * @returns The documents
	 */
	private async allDocs(source: RecordSource, reader: string): Promise<AppDoc[]> {
		const docs: AppDoc[] = [];
		let after: string | undefined;
		while (docs.length < WIKI_RECORD_SYNC_CONSTANTS.MAX_DOCS) {
			const page = (await this.deps.listDocs(source.appId, source.collection, { limit: WIKI_RECORD_SYNC_CONSTANTS.PAGE_SIZE, ...(after ? { after } : {}) }, reader)) as {
				docs?: unknown;
				next?: unknown;
			} | null;
			const batch = Array.isArray(page?.docs) ? page.docs : [];
			for (const entry of batch) {
				const e = (entry ?? {}) as { id?: unknown; _id?: unknown; data?: unknown };
				const id = typeof e.id === 'string' ? e.id : typeof e._id === 'string' ? e._id : '';
				if (id && e.data && typeof e.data === 'object') docs.push({ id, data: e.data as Record<string, unknown> });
			}
			const next = typeof page?.next === 'string' && page.next ? page.next : undefined;
			if (!next || next === after || batch.length === 0) break;
			after = next;
		}
		return docs;
	}

	/**
	 * Copy the records a vault lists into its entity pages. A page whose
	 * content is already current is not rewritten.
	 *
	 * @param vaultPath - Vault root
	 * @returns What was written, left alone or skipped; never throws
	 */
	async syncVault(vaultPath: string): Promise<RecordSyncReport> {
		const { sources, problems } = readRecordSources(vaultPath);
		const report: RecordSyncReport = { vaultPath, sources: sources.length, written: [], unchanged: 0, skipped: [], errors: [...problems] };
		if (sources.length === 0) return report;
		const reader = await this.deps.readerFor(vaultPath).catch(() => null);
		if (!reader) {
			report.errors.push('This vault has no team lead to read App records as; nothing was copied.');
			return report;
		}
		for (const source of sources) {
			const ref = `${source.appId}/${source.collection}`;
			let docs: AppDoc[];
			try {
				docs = await this.allDocs(source, reader);
			} catch (error) {
				report.errors.push(`${ref}: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			for (const doc of docs) {
				const page = renderRecord(source, doc);
				if (!page) {
					report.skipped.push({ ref: `${ref}/${doc.id}`, reason: 'no id or title' });
					continue;
				}
				const existing = readExisting(path.join(vaultPath, page.relativePath));
				if (existing?.body.includes(page.body)) {
					report.unchanged++;
					continue;
				}
				try {
					const outcome = await this.deps.ingest({
						vaultPath,
						sourceType: 'spec_file',
						sourceRef: `app:${ref}/${doc.id}`,
						sourceBody: existing?.notes ? `${page.body}\n\n${existing.notes}` : page.body,
						callerSession: WIKI_RECORD_SYNC_CONSTANTS.CALLER,
						targetRelativePath: page.relativePath,
						title: page.title,
						summary: page.summary,
						keepBecause: 'hard_fact',
						aliases: page.aliases,
						tags: source.tags,
						replace: true,
					});
					if (outcome.ok) report.written.push(page.relativePath);
					else report.skipped.push({ ref: `${ref}/${doc.id}`, reason: outcome.reason });
				} catch (error) {
					report.errors.push(`${ref}/${doc.id}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
		if (report.sources > 0 || report.errors.length > 0) {
			this.deps.logger?.info('App records copied into the wiki', {
				vaultPath,
				written: report.written.length,
				unchanged: report.unchanged,
				skipped: report.skipped.length,
				errors: report.errors.length,
			});
		}
		return report;
	}

	/**
	 * Sync several vaults, one after another.
	 *
	 * @param vaultPaths - Vault roots
	 * @returns One report per vault that lists sources (or has a broken list)
	 */
	async syncVaults(vaultPaths: string[]): Promise<RecordSyncReport[]> {
		const reports: RecordSyncReport[] = [];
		for (const vaultPath of vaultPaths) {
			const report = await this.syncVault(vaultPath);
			if (report.sources > 0 || report.errors.length > 0) reports.push(report);
		}
		return reports;
	}
}
