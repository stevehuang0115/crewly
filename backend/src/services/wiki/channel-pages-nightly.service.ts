/**
 * Nightly channel-page pass: once a night the orchestrator is handed the
 * day's messages of every room someone wrote in, and brings each room's page
 * up to date (who covers what, decisions, open items).
 *
 * Why: who leads a room is said once and recorded on the spot, but who
 * actually covers what, and what was decided, only shows in the day's
 * conversation. Nobody writes that down while working. One pass a night,
 * for the rooms that were active only, keeps the pages true at the cost of
 * one orchestrator turn.
 *
 * @module services/wiki/channel-pages-nightly.service
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { CHANNEL_PAGE_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { createWorkItem, MAX_BRIEF_MARKDOWN_BYTES, type WorkItem } from '../../types/v2/work-item.types.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { ChannelPage } from './channel-page.js';
import { agentNameOfRow, type AuthoredRoomRow } from './channel-page.wiring.js';
import { oneLine } from './wiki-page.js';

/** What the pass remembers between runs. */
export interface ChannelPagesNightlyState {
  /** Local day (YYYY-MM-DD) the pass last looked at */
  lastDay?: string;
  /** Epoch ms up to which messages were handed over */
  coveredUntil?: number;
  /** The last work item raised */
  workItemId?: string;
}

/** What the pass needs from the server. */
export interface ChannelPagesNightlyDeps {
  /** Where the state file lives */
  statePath: string;
  /** Rooms someone wrote in since a time, busiest first */
  listActiveRooms: (sinceMs: number, limit: number) => Array<{ channelId: string; messages: number }>;
  /** A room by id; null when gone */
  getRoom: (channelId: string) => { id: string; name: string } | null;
  /** Messages of a room since a time, oldest first */
  listRoomRows: (channelId: string, sinceMs: number, limit: number) => AuthoredRoomRow[];
  /** Display names of local agents, by session */
  sessionNames: () => Promise<Map<string, string>>;
  /** The page of a room, if written */
  readPage: (room: { id: string; name: string }) => Promise<ChannelPage | null>;
  /** Queue a work item */
  addWorkItem: (item: WorkItem) => Promise<void>;
  /** Whether a work item is still open (not finished, not gone) */
  isWorkItemOpen: (workItemId: string) => Promise<boolean>;
  /** Clock (tests) */
  now?: () => Date;
}

/** A room as quoted in the brief. */
export interface NightlyRoom {
  id: string;
  name: string;
  page: ChannelPage | null;
  /** `HH:MM name: text` lines, oldest first */
  lines: string[];
  /** Bytes the page's current state may take in the brief */
  stateMax?: number;
}

/**
 * Local calendar day of a time.
 *
 * @param date - The time
 * @returns `YYYY-MM-DD` in the machine's time zone
 */
export function localDay(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Quote a room's messages for the brief, newest kept within a size budget.
 *
 * @param rows - Messages, oldest first
 * @param names - Display names of local agents, by session
 * @param maxBytes - Bytes this room may take
 * @returns Lines, oldest first
 */
export function quoteRoomRows(rows: readonly AuthoredRoomRow[], names: ReadonlyMap<string, string>, maxBytes: number): string[] {
  const lines: string[] = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const time = new Date(row.createdAt).toISOString().slice(11, 16);
    const line = `${time}Z ${agentNameOfRow(row, names) ?? 'a person'}${row.threadId ? ' (in thread)' : ''}: ${oneLine(row.content, CHANNEL_PAGE_CONSTANTS.NIGHTLY_MESSAGE_MAX_CHARS)}`;
    const bytes = Buffer.byteLength(line, 'utf8') + 1;
    if (used + bytes > maxBytes) break;
    lines.unshift(line);
    used += bytes;
  }
  return lines;
}

/**
 * What the brief says about a room before its messages: its id and the
 * current page, clipped so one long page cannot crowd out the messages.
 *
 * @param room - The room and its page
 * @param maxBytes - Bytes the cover list and the notes may take together
 * @returns Lines
 */
export function roomStateLines(room: Pick<NightlyRoom, 'id' | 'name' | 'page'>, maxBytes: number = Number.MAX_SAFE_INTEGER): string[] {
  const C = CHANNEL_PAGE_CONSTANTS;
  const readFull = `read the full page with channel-notes --channel ${room.id}`;
  // Clipped by characters, then by bytes: a page in CJK takes three bytes a character.
  const clip = (text: string, maxChars: number): string => {
    const half = Math.max(0, Math.floor(maxBytes / 2));
    let kept = text.slice(0, maxChars);
    while (kept.length > 0 && Buffer.byteLength(kept, 'utf8') > half) kept = kept.slice(0, Math.floor(kept.length * 0.8));
    return kept.length < text.length ? `${kept} …[clipped; ${readFull}]` : text;
  };
  const page = room.page;
  const lines = [`## ${room.name} — room id \`${room.id}\``, `Current page: lead ${page?.lead ?? '(none)'}; purpose ${page?.purpose ?? '(none)'}.`];
  if (page && page.covers.length > 0) {
    lines.push(`Who covers what now: ${clip(page.covers.map((c) => `${c.who}: ${c.what}`).join(' | '), C.NIGHTLY_COVERS_SHOWN_MAX_CHARS)}`);
  }
  if (page?.notes) lines.push('Notes now:', clip(page.notes, C.NIGHTLY_NOTES_SHOWN_MAX_CHARS));
  return lines;
}

/**
 * The brief handed to the orchestrator.
 *
 * @param day - Local day the pass runs on
 * @param rooms - Rooms with their page and quoted messages
 * @returns Markdown
 */
export function buildNightlyBrief(day: string, rooms: readonly NightlyRoom[]): string {
  const out: string[] = [
    `# Channel pages: nightly update (${day})`,
    '',
    'Each shared room has a wiki page saying who leads it, who covers what, and what was decided. Crewly attaches it to every message a person writes in the room, so agents know whose question it is. Bring the pages below up to date from what was said since the last pass.',
    '',
    'For each room, with the `channel-notes` skill (`bash config/skills/agent/core/channel-notes/execute.sh --channel <room id> …`):',
    '- `--cover "<name>: <what>"` for each agent whose standing part in the room shows in the messages (what they answered, what they took on). One line per agent; skip an agent whose line is already right.',
    '- `--notes-file <path>` with what stays true: decisions made, what is open and who has it. Rewrite the whole Notes section (keep what is still true from the current one, drop what is done). Under 2000 characters, not a log of the day.',
    '- `--lead` or `--purpose` only when a person said it in the messages. Never infer a lead.',
    '- Nothing changed for a room: leave its page alone.',
    '',
    'The pages are readable by every agent on this machine: no customer details, credentials or personal information in them. Do not reply in the rooms and do not message anyone about this; when all rooms are done, complete this item with one line per room saying what you changed.',
  ];
  for (const room of rooms) out.push('', ...roomStateLines(room, room.stateMax), 'Messages since the last pass:', ...room.lines);
  const brief = out.join('\n');
  // A work item refuses a longer brief: cut on a character boundary.
  if (Buffer.byteLength(brief, 'utf8') <= MAX_BRIEF_MARKDOWN_BYTES) return brief;
  return `${Buffer.from(brief, 'utf8').subarray(0, MAX_BRIEF_MARKDOWN_BYTES - 64).toString('utf8').replace(/\uFFFD+$/, '')}\n…[clipped]`;
}

/**
 * Service — see module docs.
 */
export class ChannelPagesNightlyService {
  private readonly logger: ComponentLogger = LoggerService.getInstance().createComponentLogger('ChannelPagesNightly');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: ChannelPagesNightlyDeps) {}

  /** Start checking whether the pass is due. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), CHANNEL_PAGE_CONSTANTS.NIGHTLY_CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Stop checking. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Read the state file.
   *
   * @returns The state ({} when absent or unreadable)
   */
  readState(): ChannelPagesNightlyState {
    try {
      if (!existsSync(this.deps.statePath)) return {};
      const parsed = JSON.parse(readFileSync(this.deps.statePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? (parsed as ChannelPagesNightlyState) : {};
    } catch {
      return {};
    }
  }

  /**
   * Write the state file.
   *
   * @param state - State to keep
   */
  private writeState(state: ChannelPagesNightlyState): void {
    mkdirSync(path.dirname(this.deps.statePath), { recursive: true });
    writeFileSync(this.deps.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  /**
   * Run the pass when it is due: once per local day, from the nightly hour,
   * for rooms someone wrote in since the last pass. Skipped while the
   * previous night's item is still open (the next pass covers both days).
   *
   * @returns The work item raised, or null. Never throws.
   */
  async tick(): Promise<WorkItem | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.runIfDue();
    } catch (err) {
      this.logger.warn('Nightly channel-page pass failed', { error: err instanceof Error ? err.message : String(err) });
      return null;
    } finally {
      this.running = false;
    }
  }

  /**
   * {@link tick}, without the guard.
   *
   * @returns The work item raised, or null
   */
  private async runIfDue(): Promise<WorkItem | null> {
    const C = CHANNEL_PAGE_CONSTANTS;
    const now = (this.deps.now ?? (() => new Date()))();
    const day = localDay(now);
    const state = this.readState();
    if (state.lastDay === day || now.getHours() < C.NIGHTLY_HOUR) return null;

    if (state.workItemId && (await this.deps.isWorkItemOpen(state.workItemId))) {
      this.writeState({ ...state, lastDay: day });
      this.logger.info('Nightly channel-page pass skipped: the previous one is still open', { day, workItemId: state.workItemId });
      return null;
    }

    const dayMs = 24 * 60 * 60 * 1000;
    const since = Math.max(state.coveredUntil ?? now.getTime() - dayMs, now.getTime() - 3 * dayMs);
    const active = this.deps.listActiveRooms(since, C.NIGHTLY_MAX_ROOMS);
    if (active.length === 0) {
      this.writeState({ ...state, lastDay: day, coveredUntil: now.getTime() });
      return null;
    }

    const names = await this.deps.sessionNames();
    // The brief must fit a work item: the rooms' messages share what the
    // instructions and the pages' current state leave.
    const found: Array<Pick<NightlyRoom, 'id' | 'name' | 'page'>> = [];
    for (const { channelId } of active) {
      const room = this.deps.getRoom(channelId);
      if (room) found.push({ id: room.id, name: room.name, page: await this.deps.readPage(room) });
    }
    const perRoom = Math.floor((MAX_BRIEF_MARKDOWN_BYTES - C.NIGHTLY_BRIEF_OVERHEAD_BYTES) / Math.max(1, found.length));
    const stateMax = Math.floor(perRoom * C.NIGHTLY_STATE_SHARE);
    const rooms: NightlyRoom[] = [];
    for (const room of found) {
      const stateBytes = Buffer.byteLength(roomStateLines(room, stateMax).join('\n'), 'utf8') + C.NIGHTLY_ROOM_FRAME_BYTES;
      const lines = quoteRoomRows(this.deps.listRoomRows(room.id, since, C.NIGHTLY_MESSAGES_PER_ROOM), names, Math.max(0, perRoom - stateBytes));
      if (lines.length > 0) rooms.push({ ...room, lines, stateMax });
    }
    if (rooms.length === 0) {
      this.writeState({ ...state, lastDay: day, coveredUntil: now.getTime() });
      return null;
    }

    const workItem = createWorkItem({
      type: 'delegate',
      owner: 'orchestrator',
      target: ORCHESTRATOR_SESSION_NAME,
      title: `Update channel pages: ${rooms.length} room${rooms.length === 1 ? '' : 's'} (${day})`,
      description: `Bring the wiki pages of the rooms that were active up to date (who covers what, decisions, open items) with the channel-notes skill. Rooms: ${rooms.map((r) => r.name).join(', ')}.`,
      briefMarkdown: buildNightlyBrief(day, rooms),
      metadata: { kind: C.NIGHTLY_METADATA_KIND, day, rooms: rooms.map((r) => r.id), requiresVerification: false },
    });
    workItem.targetSource = 'assigned';
    await this.deps.addWorkItem(workItem);
    this.writeState({ lastDay: day, coveredUntil: now.getTime(), workItemId: workItem.id });
    this.logger.info('Nightly channel-page pass raised', { day, rooms: rooms.length, workItemId: workItem.id });
    return workItem;
  }
}
