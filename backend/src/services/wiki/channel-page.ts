/**
 * Channel pages — one wiki page per shared room, in the global vault, saying
 * what the room is for, who leads it and who covers what.
 *
 * Why: on 2026-11-23 the owner asked a room "what are our main contents?".
 * The agent that held the answer stayed quiet; an agent that did not hold it
 * answered "I do not have the outline, send it to me". It could not hand the
 * question over because nothing told it who covers what in that room: the
 * member list it received carried names, teams and machines only.
 *
 * How: the page lives at `llm-curated/channels/<room>.md` of the global
 * vault, which every agent on the machine reads. Its facts (purpose, lead,
 * who covers what) are front-matter; the body is rendered from them, plus a
 * free "Notes" section (decisions, open items) the nightly pass keeps
 * current. The page is attached to every message a person writes in the
 * room, with the room's recent threads and who answered them.
 *
 * @module services/wiki/channel-page
 */

import * as path from 'path';
import { promises as fs } from 'fs';
import { CHANNEL_PAGE_CONSTANTS } from '../../constants.js';
import { oneLine, parsePage, serializePage, type WikiPageFrontmatter } from './wiki-page.js';

/** One "who covers what" line. */
export interface ChannelCover {
  who: string;
  what: string;
}

/** What a channel page says. */
export interface ChannelPage {
  /** Room name as shown in chat, e.g. `#necina` */
  channelName: string;
  /** chat-v2 channel id of the room on this machine */
  channelId?: string;
  purpose?: string;
  /** Who answers a question nobody was @'d on */
  lead?: string;
  covers: ChannelCover[];
  /** Decisions, open items — free text */
  notes?: string;
  /** ISO time of the last change */
  updated?: string;
}

/** A change to a channel page. Absent fields are left as they are. */
export interface ChannelPagePatch {
  /** '' clears it */
  purpose?: string;
  /** '' clears it */
  lead?: string;
  /** Add or replace the line of `who` */
  cover?: ChannelCover;
  /** Remove the line of this name */
  uncover?: string;
  /** Replaces the notes section; '' clears it */
  notes?: string;
}

/** A recent thread of the room: how it opened and which agents answered. */
export interface RecentThread {
  /** Epoch ms of the opening message */
  at: number;
  /** Opening line, one line */
  opening: string;
  /** Display names of the agents that replied, first-seen order */
  answeredBy: string[];
}

/**
 * File name of a room's page.
 *
 * @param channelName - Room name (`#necina`, `Content Team`)
 * @returns A lowercase slug; `channel` when the name has no usable character
 *
 * @example
 * ```ts
 * channelSlug('#Mini CE'); // 'mini-ce'
 * ```
 */
export function channelSlug(channelName: string): string {
  const slug = channelName
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'channel';
}

/**
 * Vault-relative path of a room's page.
 *
 * @param channelName - Room name
 * @returns e.g. `llm-curated/channels/necina.md`
 */
export function channelPageRelativePath(channelName: string): string {
  return `llm-curated/${CHANNEL_PAGE_CONSTANTS.FOLDER}/${channelSlug(channelName)}.md`;
}

/**
 * Read the "who covers what" lines from front-matter.
 *
 * @param raw - The `covers` front-matter value
 * @returns Valid lines
 */
function coversOf(raw: unknown): ChannelCover[] {
  if (!Array.isArray(raw)) return [];
  const covers: ChannelCover[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const who = typeof (entry as ChannelCover).who === 'string' ? (entry as ChannelCover).who.trim() : '';
    const what = typeof (entry as ChannelCover).what === 'string' ? (entry as ChannelCover).what.trim() : '';
    if (who && what) covers.push({ who, what });
  }
  return covers;
}

/** Heading of the free section of a page body. */
const NOTES_HEADING = '## Notes';

/**
 * Render a page body from its facts.
 *
 * @param page - The page
 * @returns Markdown body
 */
export function renderChannelPageBody(page: ChannelPage): string {
  const lines: string[] = [];
  lines.push('## Purpose', page.purpose || '_Not recorded yet._', '');
  lines.push('## Lead', page.lead || '_Nobody named yet. Whoever holds the context answers._', '');
  lines.push('## Who covers what');
  if (page.covers.length === 0) lines.push('_Not recorded yet._');
  for (const cover of page.covers) lines.push(`- ${cover.who}: ${cover.what}`);
  lines.push('', NOTES_HEADING, page.notes?.trim() || '_None._', '');
  return lines.join('\n');
}

/**
 * Parse a page file.
 *
 * @param raw - File content
 * @param channelName - Room name (used when the page has no title)
 * @returns The page
 */
export function parseChannelPage(raw: string, channelName: string): ChannelPage {
  const { frontmatter: fm, body } = parsePage(raw);
  const at = body.indexOf(`${NOTES_HEADING}\n`);
  const notes = at >= 0 ? body.slice(at + NOTES_HEADING.length + 1).trim() : '';
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  return {
    channelName: text(fm.title) ?? channelName,
    ...(text(fm['channel_id']) ? { channelId: text(fm['channel_id']) } : {}),
    ...(text(fm['purpose']) ? { purpose: text(fm['purpose']) } : {}),
    ...(text(fm['lead']) ? { lead: text(fm['lead']) } : {}),
    covers: coversOf(fm['covers']),
    ...(notes && notes !== '_None._' ? { notes } : {}),
    ...(text(fm.updated) ? { updated: text(fm.updated) } : {}),
  };
}

/**
 * Apply a change to a page.
 *
 * @param page - Current page
 * @param patch - The change
 * @returns The changed page (a new object)
 */
export function applyChannelPagePatch(page: ChannelPage, patch: ChannelPagePatch): ChannelPage {
  const C = CHANNEL_PAGE_CONSTANTS;
  const next: ChannelPage = { ...page, covers: [...page.covers] };
  if (patch.purpose !== undefined) {
    const purpose = oneLine(patch.purpose, C.PURPOSE_MAX_CHARS);
    if (purpose) next.purpose = purpose;
    else delete next.purpose;
  }
  if (patch.lead !== undefined) {
    const lead = oneLine(patch.lead, 80);
    if (lead) next.lead = lead;
    else delete next.lead;
  }
  const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
  if (patch.uncover) next.covers = next.covers.filter((c) => !same(c.who, patch.uncover as string));
  if (patch.cover) {
    const who = oneLine(patch.cover.who, 80);
    const what = oneLine(patch.cover.what, C.COVER_MAX_CHARS);
    if (who && what) {
      next.covers = [...next.covers.filter((c) => !same(c.who, who)), { who, what }].slice(-C.MAX_COVERS);
    }
  }
  if (patch.notes !== undefined) {
    const notes = patch.notes.trim().slice(0, C.NOTES_MAX_CHARS);
    if (notes) next.notes = notes;
    else delete next.notes;
  }
  return next;
}

/**
 * One-line summary of a page (the wiki index line).
 *
 * @param page - The page
 * @returns Summary
 */
function summaryOf(page: ChannelPage): string {
  const parts = [page.purpose ?? `Shared room ${page.channelName}`];
  if (page.lead) parts.push(`lead: ${page.lead}`);
  return oneLine(parts.join(' — '), 240);
}

/**
 * Read a room's page.
 *
 * @param vaultPath - Global vault root
 * @param channelName - Room name
 * @returns The page, or null when none was written yet
 */
export async function readChannelPage(vaultPath: string, channelName: string): Promise<ChannelPage | null> {
  try {
    return parseChannelPage(await fs.readFile(path.join(vaultPath, channelPageRelativePath(channelName)), 'utf8'), channelName);
  } catch {
    return null;
  }
}

/**
 * Change a room's page, creating it when needed.
 *
 * @param vaultPath - Global vault root
 * @param channel - The room
 * @param patch - The change
 * @param by - Who made it (an agent session, or `owner`)
 * @param now - Clock (tests)
 * @returns The page as written
 */
export async function writeChannelPage(
  vaultPath: string,
  channel: { name: string; id?: string },
  patch: ChannelPagePatch,
  by: string,
  now: Date = new Date(),
): Promise<ChannelPage> {
  const file = path.join(vaultPath, channelPageRelativePath(channel.name));
  let existing: Partial<WikiPageFrontmatter> = {};
  let current: ChannelPage = { channelName: channel.name, covers: [] };
  try {
    const raw = await fs.readFile(file, 'utf8');
    existing = parsePage(raw).frontmatter;
    current = parseChannelPage(raw, channel.name);
  } catch {
    /* first write */
  }
  const next = applyChannelPagePatch({ ...current, channelName: channel.name, ...(channel.id ? { channelId: channel.id } : {}) }, patch);
  next.updated = now.toISOString();
  const frontmatter: Partial<WikiPageFrontmatter> = {
    ...existing,
    title: next.channelName,
    summary: summaryOf(next),
    keep_because: 'hard_fact',
    source: CHANNEL_PAGE_CONSTANTS.SOURCE,
    caller: by,
    recorded: typeof existing.recorded === 'string' ? existing.recorded : next.updated,
    updated: next.updated,
    channel_id: next.channelId,
    purpose: next.purpose,
    lead: next.lead,
    covers: next.covers.length > 0 ? next.covers : undefined,
  };
  if (patch.lead !== undefined) frontmatter['lead_set_by'] = next.lead ? by : undefined;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, serializePage(frontmatter, renderChannelPageBody(next)), 'utf8');
  return next;
}

/**
 * Render the block attached to a message delivered in the room.
 *
 * @param args - The room, its page (if any), its recent threads and how to record a change
 * @returns The block; '' when there is neither a page nor a recent thread
 */
export function renderChannelBlock(args: {
  channelName: string;
  page: ChannelPage | null;
  recent: readonly RecentThread[];
  /** Command that records who leads or covers what */
  recordCommand?: string;
}): string {
  const C = CHANNEL_PAGE_CONSTANTS;
  const { page, recent } = args;
  const hasFacts = !!page && (!!page.purpose || !!page.lead || page.covers.length > 0 || !!page.notes);
  if (!hasFacts && recent.length === 0) return '';
  const lines: string[] = [
    `[What Crewly knows about ${args.channelName} — who leads it and who covers what. Use it to decide whether this message is yours, and to hand it to the right colleague when it is not.]`,
  ];
  if (page?.purpose) lines.push(`Purpose: ${page.purpose}`);
  lines.push(`Lead: ${page?.lead ?? 'nobody named yet'}`);
  if (page && page.covers.length > 0) {
    lines.push('Who covers what:');
    for (const cover of page.covers) lines.push(`- ${cover.who}: ${cover.what}`);
  }
  if (page?.notes) {
    const notes = page.notes.length > C.NOTES_SHOWN_MAX_CHARS ? `${page.notes.slice(0, C.NOTES_SHOWN_MAX_CHARS)} …[clipped; the full page is ${channelPageRelativePath(args.channelName).replace(/^llm-curated\//, '')}]` : page.notes;
    lines.push('Notes:', notes);
  }
  if (recent.length > 0) {
    lines.push('Recent threads here and who answered them:');
    for (const thread of recent.slice(0, C.RECENT_THREADS_SHOWN)) {
      const day = new Date(thread.at).toISOString().slice(5, 10);
      lines.push(`- ${day} "${thread.opening}" — ${thread.answeredBy.length > 0 ? thread.answeredBy.join(', ') : 'no agent answered'}`);
    }
  }
  if (args.recordCommand) {
    lines.push(`When a person says here who leads this room or who covers what, record it right away: ${args.recordCommand}`);
  }
  lines.push('[end of channel notes]');
  const block = lines.join('\n');
  return block.length > C.BLOCK_MAX_CHARS ? `${block.slice(0, C.BLOCK_MAX_CHARS)} …[clipped]\n[end of channel notes]` : block;
}

/** A room message as read for the recent-thread list. */
export interface RoomRow {
  id: string;
  threadId: string | null;
  senderType: string;
  senderId: string;
  content: string;
  createdAt: number;
}

/**
 * The recent threads of a room and which agents answered them, newest first.
 * A thread counts when a person opened it; agents talking among themselves
 * do not make a thread.
 *
 * @param rows - Room messages, oldest first
 * @param nameOf - Display name of an agent that wrote a row, or null when the row is a person's
 * @returns Threads, newest first
 */
export function recentThreadsOf(rows: readonly RoomRow[], nameOf: (row: RoomRow) => string | null): RecentThread[] {
  const threads = new Map<string, RecentThread>();
  for (const row of rows) {
    const root = row.threadId ?? row.id;
    const author = nameOf(row);
    const thread = threads.get(root);
    if (!thread) {
      // A thread whose opening message was not read (older than the window) is skipped.
      if (row.threadId || author) continue;
      const opening = oneLine(row.content, CHANNEL_PAGE_CONSTANTS.THREAD_LINE_MAX_CHARS);
      if (opening) threads.set(root, { at: row.createdAt, opening, answeredBy: [] });
      continue;
    }
    if (author && !thread.answeredBy.includes(author)) thread.answeredBy.push(author);
  }
  return [...threads.values()].sort((a, b) => b.at - a.at);
}
