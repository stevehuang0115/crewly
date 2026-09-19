/**
 * The page contract of the LLM-wiki.
 *
 * A vault page is markdown with YAML frontmatter. Two fields make a page a
 * piece of knowledge rather than a bookmark: `summary` (the one-line
 * conclusion — what this means for us) and `keep_because` (the reason it
 * earns a place at all). Without them a write goes to `log.md`, not to a
 * page. This module parses/serialises that shape and applies the gate;
 * everything else (index, history, supersede) builds on it.
 *
 * @module services/wiki/wiki-page
 */

import { parse as parseYAML, stringify as stringifyYAML } from 'yaml';
import { WIKI_KB_CONSTANTS, type WikiKeepBecause } from '../../constants.js';

/** Frontmatter every page carries (agents set the first block; the system fills the rest). */
export interface WikiPageFrontmatter {
  title: string;
  /** One-line conclusion: what this page means for the team/project. */
  summary: string;
  keep_because: WikiKeepBecause;
  tags?: string[];
  /** Roles allowed to read the page; empty/absent = everyone in the vault's instance. */
  visibility?: string[];
  source?: string;
  caller?: string;
  recorded?: string;
  updated?: string;
  superseded_by?: string;
  superseded_at?: string;
  superseded_reason?: string;
  proposed_by?: string;
  /** Anything else on the page (migrated fields such as `confidence`, `migrated_from`). */
  [key: string]: unknown;
}

/** A parsed page. */
export interface WikiPage {
  frontmatter: Partial<WikiPageFrontmatter>;
  body: string;
  /** True when the file had a `---` block at all. */
  hadFrontmatter: boolean;
}

/** Why a page write was refused by the retention gate. */
export interface RetentionRefusal {
  reason: 'retention_gate';
  missing: string[];
  message: string;
}

/**
 * Split a page into frontmatter + body. Tolerant: a page without a block
 * parses as `{ frontmatter: {}, body: raw }`; a malformed block is left in
 * the body untouched.
 *
 * @param raw - File content
 * @returns The parsed page
 */
export function parsePage(raw: string): WikiPage {
  const normalized = raw.replace(/\r\n/g, '\n');
  const m = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: normalized, hadFrontmatter: false };
  try {
    const parsed = parseYAML(m[1]);
    const fm = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    return { frontmatter: fm as Partial<WikiPageFrontmatter>, body: m[2], hadFrontmatter: true };
  } catch {
    return { frontmatter: {}, body: normalized, hadFrontmatter: false };
  }
}

/**
 * Serialise frontmatter + body back into a file. Keys are written in the
 * canonical order of {@link WIKI_KB_CONSTANTS.FRONTMATTER_KEYS} first, then
 * any extra keys, so diffs stay readable.
 *
 * @param frontmatter - Fields to write (undefined values are dropped)
 * @param body - Markdown body
 * @returns File content
 */
export function serializePage(frontmatter: Partial<WikiPageFrontmatter>, body: string): string {
  const ordered: Record<string, unknown> = {};
  for (const key of WIKI_KB_CONSTANTS.FRONTMATTER_KEYS) {
    if (frontmatter[key] !== undefined) ordered[key] = frontmatter[key];
  }
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!(key in ordered) && value !== undefined) ordered[key] = value;
  }
  const yaml = stringifyYAML(ordered).trimEnd();
  return `---\n${yaml}\n---\n${body.replace(/^\n+/, '')}`;
}

/**
 * Apply the retention gate to a page write: `title`, a non-empty `summary`
 * and a valid `keep_because` are required. Returns null when the page
 * passes.
 *
 * @param fm - Frontmatter the writer supplied
 * @returns A refusal describing what is missing, or null
 */
export function checkRetention(fm: Partial<WikiPageFrontmatter>): RetentionRefusal | null {
  const missing: string[] = [];
  if (!fm.title || !String(fm.title).trim()) missing.push('title');
  const summary = typeof fm.summary === 'string' ? fm.summary.trim() : '';
  if (!summary) missing.push('summary');
  else if (summary.length > WIKI_KB_CONSTANTS.SUMMARY_MAX_CHARS) missing.push(`summary (≤ ${WIKI_KB_CONSTANTS.SUMMARY_MAX_CHARS} chars)`);
  if (!fm.keep_because || !(WIKI_KB_CONSTANTS.KEEP_BECAUSE as readonly string[]).includes(String(fm.keep_because))) {
    missing.push(`keep_because (one of ${WIKI_KB_CONSTANTS.KEEP_BECAUSE.join(' | ')})`);
  }
  if (missing.length === 0) return null;
  return {
    reason: 'retention_gate',
    missing,
    message:
      `A page needs ${missing.join(', ')}. Default is to NOT keep: write a page only when it changes a decision, ` +
      `contradicts what we believed, is a citable hard fact, or a reusable method — otherwise append to llm-curated/log.md.`,
  };
}

/**
 * The single index line for a page: `- [title](path) — summary`, with a
 * `⟶ superseded by <path>` marker when applicable.
 *
 * @param relativePath - Vault-relative page path
 * @param fm - The page's frontmatter
 * @returns One markdown list line
 */
export function indexLineFor(relativePath: string, fm: Partial<WikiPageFrontmatter>): string {
  const title = oneLine(String(fm.title ?? relativePath.split('/').pop() ?? relativePath), WIKI_KB_CONSTANTS.TITLE_MAX_CHARS);
  const summary = oneLine(String(fm.summary ?? ''), WIKI_KB_CONSTANTS.SUMMARY_MAX_CHARS);
  const superseded = fm.superseded_by ? ` ⟶ superseded by ${fm.superseded_by}` : '';
  return `- [${title}](${relativePath})${summary ? ` — ${summary}` : ''}${superseded}`;
}

/**
 * Whether a viewer role may read a page. No `visibility` list = public
 * within the instance; a canonical role (owner/orchestrator) always may.
 *
 * @param fm - Page frontmatter
 * @param viewerRole - Role of the reader, or undefined for the owner/UI
 * @returns True when readable
 */
export function isVisibleTo(fm: Partial<WikiPageFrontmatter>, viewerRole?: string): boolean {
  const list = Array.isArray(fm.visibility) ? fm.visibility.map((v) => String(v).toLowerCase()) : [];
  if (list.length === 0) return true;
  if (!viewerRole) return true;
  const role = viewerRole.toLowerCase();
  return role === 'orchestrator' || role === 'owner' || list.includes(role);
}

/**
 * Collapse whitespace and cut to a maximum length (with an ellipsis).
 *
 * @param value - Text
 * @param max - Maximum characters
 * @returns One line
 */
export function oneLine(value: string, max: number): string {
  const flat = value.replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
