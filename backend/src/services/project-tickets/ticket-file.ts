/**
 * Project ticket file format — parse and edit one `<ID>-<slug>.md` file
 * (specs/2026-09-28-project-tickets.md §2).
 *
 * The file is owned by humans as much as by Crewly: people edit the body
 * freely, add frontmatter keys, write comments. So the writer here never
 * re-renders a file. It edits in place:
 * - frontmatter: only the keys in {@link OWNED_TICKET_FIELDS} are set, through
 *   the `yaml` Document API, so unknown keys, key order and comments survive;
 *   when no owned key changes, the frontmatter bytes are kept as they were;
 * - body: lines are appended to the `## Log` section, and the Description /
 *   Acceptance sections are replaced only when a caller explicitly asks.
 * Everything else is preserved byte-for-byte.
 *
 * @module services/project-tickets/ticket-file
 */

import { Document, parseDocument, isMap } from 'yaml';
import { PROJECT_TICKET_CONSTANTS } from '../../constants.js';
import {
  OWNED_TICKET_FIELDS,
  isProjectTicketStatus,
  normalizeProjectTicketPriority,
  type ProjectTicketCriterion,
  type ProjectTicketFields,
} from '../../types/project-ticket.types.js';

/** `---` frontmatter at the very start of the file (optional BOM). */
const FRONTMATTER_RE = /^(\uFEFF?---[ \t]*\r?\n)(?:([\s\S]*?)\r?\n)?(---[ \t]*)(\r?\n|$)/;

/** Ticket ids: `<KEY>-<n>` */
export const TICKET_ID_RE = /^[A-Za-z0-9]+-\d+$/;

/** A level-1 or level-2 markdown heading line. */
const HEADING_RE = /^(#{1,2})\s+(.+?)\s*#*\s*$/;

/** A fenced code block delimiter line. */
const FENCE_RE = /^\s*(```|~~~)/;

/** Checkbox / bullet lines of the acceptance section. */
const CHECKBOX_RE = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/;
const BULLET_RE = /^\s*[-*]\s+(.*)$/;

/** Placeholder written into an empty section. */
const EMPTY_SECTION_TEXT = '_None yet._';

/** A successfully parsed ticket file. */
export interface ParsedTicketFile {
  /** The owned fields, validated and normalised */
  fields: ProjectTicketFields;
  /** Frontmatter keys the service does not own */
  extra: Record<string, unknown>;
  /** Everything after the closing `---` line, verbatim */
  body: string;
  /** Text of the Description section (trimmed) */
  description: string;
  /** Acceptance criteria */
  acceptance: ProjectTicketCriterion[];
  /** Log lines (without the leading `- `) */
  log: string[];
}

/** Parse outcome: a ticket, or why the file is not one. */
export type ParseTicketResult = { ok: true; file: ParsedTicketFile } | { ok: false; error: string };

/** Changes applied by {@link applyTicketChanges}. */
export interface TicketChanges {
  /** Owned frontmatter fields to set */
  fields?: Partial<ProjectTicketFields>;
  /** Replace the Description section content */
  description?: string;
  /** Replace the Acceptance criteria section content */
  acceptance?: ProjectTicketCriterion[];
  /** Lines to append to the Log section (without `- `) */
  logLines?: string[];
}

/** Content of a brand-new ticket file. */
export interface NewTicketContent {
  fields: ProjectTicketFields;
  description: string;
  acceptance: ProjectTicketCriterion[];
  logLines: string[];
}

interface SplitFile {
  prefix: string;
  yamlText: string;
  closer: string;
  closerEol: string;
  body: string;
  eol: string;
}

interface SectionRange {
  /** Heading text */
  title: string;
  /** Index of the heading line's first character */
  start: number;
  /** Index just past the heading text (before its line break) */
  headingEnd: number;
  /** Index where the section content begins (after the heading's line break) */
  contentStart: number;
  /** Index where the next level-1/2 heading begins, or body length */
  end: number;
}

/**
 * Split a file into frontmatter and body.
 *
 * @param content - Whole file
 * @returns The parts, or null when there is no frontmatter
 */
function splitFrontmatter(content: string): SplitFile | null {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return null;
  return {
    prefix: m[1],
    yamlText: m[2] ?? '',
    closer: m[3],
    closerEol: m[4],
    body: content.slice(m[0].length),
    eol: content.includes('\r\n') ? '\r\n' : '\n',
  };
}

/**
 * Read an optional string field (null/absent → null; numbers are stringified).
 *
 * @param value - Raw frontmatter value
 * @param name - Field name (for the error)
 * @returns The string or null
 * @throws When the value is neither a string, a number nor null
 */
function optionalString(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  throw new Error(`${name} must be a string`);
}

/**
 * Read the optional `deferUntil` field. YAML parses a bare `2026-11-01` as a
 * Date, so a Date is turned back into `YYYY-MM-DD` (or ISO when it has a time).
 *
 * @param value - Raw frontmatter value
 * @returns The date text or null
 */
function optionalDate(value: unknown): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

/**
 * Read the labels field: a list, or a comma-separated string.
 *
 * @param value - Raw frontmatter value
 * @returns Labels (trimmed, non-empty)
 */
function readLabels(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return list.map((l) => String(l).trim()).filter((l) => l.length > 0);
}

/**
 * Validate and normalise the owned fields of a frontmatter object.
 *
 * @param data - Frontmatter as plain JS
 * @returns The fields
 * @throws When a required field is missing or invalid
 */
function readFields(data: Record<string, unknown>): ProjectTicketFields {
  const id = data.id;
  if (typeof id !== 'string' || !TICKET_ID_RE.test(id)) throw new Error('id must look like KEY-12');
  const title = data.title;
  if (typeof title !== 'string' || title.trim().length === 0) throw new Error('title is required');
  if (!isProjectTicketStatus(data.status)) {
    throw new Error(`status must be one of ${PROJECT_TICKET_CONSTANTS.STATUSES.join(', ')}`);
  }
  const priority =
    data.priority === undefined || data.priority === null
      ? PROJECT_TICKET_CONSTANTS.DEFAULT_PRIORITY
      : normalizeProjectTicketPriority(data.priority);
  if (!priority) throw new Error('priority must be P0, P1, P2 or P3');
  const ownerReview = data.ownerReview === true || data.ownerReview === 'true';
  return {
    id,
    title: title.trim(),
    status: data.status,
    priority,
    assignee: optionalString(data.assignee, 'assignee'),
    team: optionalString(data.team, 'team'),
    labels: readLabels(data.labels),
    ownerReview,
    createdAt: optionalString(data.createdAt, 'createdAt') ?? '',
    updatedAt: optionalString(data.updatedAt, 'updatedAt') ?? '',
    workItemId: optionalString(data.workItemId, 'workItemId'),
    requestId: optionalString(data.requestId, 'requestId'),
    source: optionalString(data.source, 'source'),
    migratedFrom: optionalString(data.migratedFrom, 'migratedFrom'),
    deferUntil: optionalDate(data.deferUntil),
  };
}

/**
 * Locate the level-1/2 sections of a markdown body, ignoring headings inside
 * fenced code blocks.
 *
 * @param body - Markdown body
 * @returns Sections in order
 */
function locateSections(body: string): SectionRange[] {
  const sections: SectionRange[] = [];
  let inFence = false;
  let pos = 0;
  while (pos <= body.length) {
    const nl = body.indexOf('\n', pos);
    const lineEnd = nl === -1 ? body.length : nl;
    const rawLine = body.slice(pos, lineEnd);
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
    } else if (!inFence) {
      const h = HEADING_RE.exec(line);
      if (h) {
        if (sections.length > 0) sections[sections.length - 1].end = pos;
        sections.push({
          title: h[2].trim(),
          start: pos,
          headingEnd: pos + line.length,
          contentStart: nl === -1 ? body.length : nl + 1,
          end: body.length,
        });
      }
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return sections;
}

/**
 * Find a section by heading text (case-insensitive).
 *
 * @param body - Markdown body
 * @param title - Heading text
 * @returns The section, or undefined
 */
function findSection(body: string, title: string): SectionRange | undefined {
  const want = title.toLowerCase();
  return locateSections(body).find((s) => s.title.toLowerCase() === want);
}

/**
 * Parse the acceptance criteria lines of a section.
 *
 * @param text - Section content
 * @returns Criteria
 */
function parseCriteria(text: string): ProjectTicketCriterion[] {
  const out: ProjectTicketCriterion[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cb = CHECKBOX_RE.exec(line);
    if (cb) {
      out.push({ text: cb[2].trim(), done: cb[1].toLowerCase() === 'x' });
      continue;
    }
    const b = BULLET_RE.exec(line);
    if (b && b[1].trim()) out.push({ text: b[1].trim(), done: false });
  }
  return out;
}

/**
 * Render acceptance criteria as checkbox lines.
 *
 * @param criteria - Criteria
 * @param eol - Line ending
 * @returns Section content
 */
export function renderCriteria(criteria: readonly ProjectTicketCriterion[], eol = '\n'): string {
  if (criteria.length === 0) return EMPTY_SECTION_TEXT;
  return criteria.map((c) => `- [${c.done ? 'x' : ' '}] ${c.text.replace(/\r?\n/g, ' ').trim()}`).join(eol);
}

/**
 * Read a section's text (trimmed) from a body.
 *
 * @param body - Markdown body
 * @param title - Heading text
 * @returns Content, or '' when the section is absent
 */
function sectionText(body: string, title: string): string {
  const s = findSection(body, title);
  return s ? body.slice(s.contentStart, s.end).trim() : '';
}

/**
 * Parse a ticket file. Never throws: an unreadable file comes back as
 * `{ ok: false, error }` so callers can skip it with a warning.
 *
 * @param content - Whole file content
 * @returns The parsed ticket, or the reason it is not one
 *
 * @example
 * ```typescript
 * const r = parseTicketFile(await fs.readFile(p, 'utf8'));
 * if (r.ok) console.log(r.file.fields.status);
 * ```
 */
export function parseTicketFile(content: string): ParseTicketResult {
  const split = splitFrontmatter(content);
  if (!split) return { ok: false, error: 'missing YAML frontmatter' };
  const doc = parseDocument(split.yamlText);
  if (doc.errors.length > 0) return { ok: false, error: `invalid YAML: ${doc.errors[0].message.split('\n')[0]}` };
  const data: unknown = doc.toJS();
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, error: 'frontmatter must be a mapping' };
  }
  let fields: ProjectTicketFields;
  try {
    fields = readFields(data as Record<string, unknown>);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const owned = new Set<string>(OWNED_TICKET_FIELDS);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (!owned.has(k)) extra[k] = v;
  }
  const { SECTIONS } = PROJECT_TICKET_CONSTANTS;
  const description = sectionText(split.body, SECTIONS.DESCRIPTION);
  const acceptanceText = sectionText(split.body, SECTIONS.ACCEPTANCE);
  const logText = sectionText(split.body, SECTIONS.LOG);
  return {
    ok: true,
    file: {
      fields,
      extra,
      body: split.body,
      description: description === EMPTY_SECTION_TEXT ? '' : description,
      acceptance: acceptanceText === EMPTY_SECTION_TEXT ? [] : parseCriteria(acceptanceText),
      log: logText
        .split(/\r?\n/)
        .filter((l) => /^\s*-\s+/.test(l))
        .map((l) => l.replace(/^\s*-\s+/, '')),
    },
  };
}

/**
 * Whether two owned-field values are equal (arrays compared element-wise).
 *
 * @param a - Current value
 * @param b - New value
 * @returns True when unchanged
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return (a ?? null) === (b ?? null);
}

/**
 * Set one owned key on a YAML document (flow style for arrays).
 *
 * @param doc - Document
 * @param key - Field name
 * @param value - New value
 */
function setField(doc: Document, key: string, value: unknown): void {
  if (Array.isArray(value)) {
    doc.set(key, doc.createNode(value, { flow: true }));
  } else {
    doc.set(key, value === undefined ? null : value);
  }
}

/**
 * Append lines to the Log section (creating it at the end when missing).
 *
 * @param body - Markdown body
 * @param lines - Lines without `- `
 * @param eol - Line ending
 * @returns New body
 */
function appendLog(body: string, lines: readonly string[], eol: string): string {
  if (lines.length === 0) return body;
  const rendered = lines.map((l) => `- ${l.replace(/\r?\n/g, ' ')}`).join(eol);
  const sec = findSection(body, PROJECT_TICKET_CONSTANTS.SECTIONS.LOG);
  if (!sec) {
    const lead = body.length === 0 ? eol : body.endsWith('\n') ? eol : eol + eol;
    return `${body}${lead}## ${PROJECT_TICKET_CONSTANTS.SECTIONS.LOG}${eol}${eol}${rendered}${eol}`;
  }
  const content = body.slice(sec.contentStart, sec.end);
  const trimmedLen = content.replace(/\s+$/, '').length;
  if (trimmedLen === 0) {
    // Empty section: put the lines right under the heading, keep what followed.
    const tail = body.slice(sec.headingEnd);
    const needsEol = sec.end === body.length && !/\n/.test(tail);
    return `${body.slice(0, sec.headingEnd)}${eol}${eol}${rendered}${needsEol ? eol : ''}${tail}`;
  }
  const at = sec.contentStart + trimmedLen;
  return `${body.slice(0, at)}${eol}${rendered}${body.slice(at)}`;
}

/**
 * Replace (or insert) a section's content. Insertion goes before the Log
 * section, else at the end.
 *
 * @param body - Markdown body
 * @param title - Heading text
 * @param content - New content (without heading)
 * @param eol - Line ending
 * @returns New body
 */
function replaceSection(body: string, title: string, content: string, eol: string): string {
  const text = content.trim().length > 0 ? content.trim() : EMPTY_SECTION_TEXT;
  const sec = findSection(body, title);
  if (sec) {
    const hasNext = sec.end < body.length;
    return `${body.slice(0, sec.contentStart)}${sec.contentStart === body.length ? eol : ''}${eol}${text}${eol}${hasNext ? eol : ''}${body.slice(sec.end)}`;
  }
  const block = `## ${title}${eol}${eol}${text}${eol}`;
  const log = findSection(body, PROJECT_TICKET_CONSTANTS.SECTIONS.LOG);
  if (log) return `${body.slice(0, log.start)}${block}${eol}${body.slice(log.start)}`;
  const lead = body.length === 0 ? eol : body.endsWith('\n') ? eol : eol + eol;
  return `${body}${lead}${block}`;
}

/**
 * Apply changes to a ticket file, touching only owned frontmatter keys and
 * the sections asked for.
 *
 * @param content - Current file content
 * @param changes - What to change
 * @returns New file content (identical to `content` when nothing changes)
 * @throws When the file has no parseable frontmatter mapping
 *
 * @example
 * ```typescript
 * const next = applyTicketChanges(text, { fields: { status: 'ready' }, logLines: ['… · owner · ready'] });
 * ```
 */
export function applyTicketChanges(content: string, changes: TicketChanges): string {
  const split = splitFrontmatter(content);
  if (!split) throw new Error('missing YAML frontmatter');
  const { eol } = split;

  let yamlOut = split.yamlText;
  let frontmatterChanged = false;
  if (changes.fields && Object.keys(changes.fields).length > 0) {
    const doc = parseDocument(split.yamlText);
    if (doc.errors.length > 0 || !isMap(doc.contents)) throw new Error('frontmatter is not a YAML mapping');
    const current = doc.toJS() as Record<string, unknown>;
    for (const key of OWNED_TICKET_FIELDS) {
      if (!(key in changes.fields)) continue;
      const value = changes.fields[key];
      if (sameValue(current[key], value)) continue;
      setField(doc, key, value);
      frontmatterChanged = true;
    }
    if (frontmatterChanged) {
      yamlOut = doc.toString({ lineWidth: 0 }).replace(/\n$/, '').replace(/\n/g, eol);
    }
  }

  let body = split.body;
  const { SECTIONS } = PROJECT_TICKET_CONSTANTS;
  if (changes.description !== undefined) body = replaceSection(body, SECTIONS.DESCRIPTION, changes.description, eol);
  if (changes.acceptance !== undefined) {
    body = replaceSection(body, SECTIONS.ACCEPTANCE, renderCriteria(changes.acceptance, eol), eol);
  }
  if (changes.logLines && changes.logLines.length > 0) body = appendLog(body, changes.logLines, eol);

  if (!frontmatterChanged && body === split.body) return content;
  const closerEol = split.closerEol === '' && body.length > 0 ? eol : split.closerEol;
  const yamlBlock = yamlOut.length > 0 ? `${yamlOut}${eol}` : '';
  return `${split.prefix}${yamlBlock}${split.closer}${closerEol}${body}`;
}

/**
 * Render a brand-new ticket file.
 *
 * @param content - Fields, description, criteria and the first log lines
 * @returns File content
 */
export function renderNewTicketFile(content: NewTicketContent): string {
  const doc = new Document({});
  for (const key of OWNED_TICKET_FIELDS) {
    const value = content.fields[key];
    if ((key === 'migratedFrom' || key === 'deferUntil') && (value === null || value === undefined)) continue;
    setField(doc, key, value);
  }
  const yamlText = doc.toString({ lineWidth: 0 });
  const { SECTIONS } = PROJECT_TICKET_CONSTANTS;
  const description = content.description.trim().length > 0 ? content.description.trim() : EMPTY_SECTION_TEXT;
  const logLines = content.logLines.map((l) => `- ${l.replace(/\r?\n/g, ' ')}`).join('\n');
  return [
    '---',
    yamlText.replace(/\n$/, ''),
    '---',
    '',
    `## ${SECTIONS.DESCRIPTION}`,
    '',
    description,
    '',
    `## ${SECTIONS.ACCEPTANCE}`,
    '',
    renderCriteria(content.acceptance),
    '',
    `## ${SECTIONS.LOG}`,
    '',
    logLines,
    '',
  ].join('\n');
}

/**
 * A file-name slug for a title (`Export as CSV!` → `export-as-csv`).
 *
 * @param title - Ticket title
 * @returns Slug (never empty)
 */
export function slugifyTitle(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PROJECT_TICKET_CONSTANTS.MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'ticket';
}

/**
 * Format one Log line: `<iso> · <actor> · <message>`.
 *
 * @param actor - Who did it (`owner`, a session name, `system`)
 * @param message - What happened
 * @param at - Timestamp (defaults to now)
 * @returns The line (without `- `)
 */
export function formatLogLine(actor: string, message: string, at: string = new Date().toISOString()): string {
  return `${at} · ${actor} · ${message.replace(/\r?\n/g, ' ').trim()}`;
}
