/**
 * Room context backlog.
 *
 * Room messages an agent should know about but not answer
 * (specs/2026-10-03-one-responder-per-message.md "Everyone else: context
 * only"). Instead of a turn of their own — which would wake a sleeping agent
 * or spend a full prompt on "do nothing" — they wait here and are put at the
 * top of the agent's next prompt from the same room.
 *
 * In memory and bounded: a restart loses it, which is acceptable because the
 * Slack thread context still shows the thread when the agent is next
 * addressed there.
 *
 * @module services/chat-v2/room-context-backlog
 */

import { ROOM_CONTEXT_CONSTANTS } from '../../constants.js';

/** One queued room message. */
export interface RoomContextEntry {
  /** The chat message id (deduplicates a hand-off re-route) */
  messageId: string;
  /** Who wrote it, as the prompt names them */
  sender: string;
  /** The message text */
  content: string;
  /** Thread root id it belongs to, when it is a thread reply */
  threadId?: string;
  /** Who is answering it, when anyone is (display name) */
  responderName?: string;
  /** Epoch ms when it was queued */
  at: number;
}

/** Constructor options. */
export interface RoomContextBacklogOptions {
  /** Clock override for tests */
  now?: () => number;
}

/**
 * Collapse whitespace and clip.
 *
 * @param text - Text
 * @param max - Most characters
 * @returns The clipped text
 */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * The line the prompt shows for one entry.
 *
 * @param entry - The queued message
 * @returns One English line
 */
export function contextOnlyLine(entry: Pick<RoomContextEntry, 'sender' | 'content' | 'threadId' | 'responderName'>): string {
  const where = entry.threadId ? ` (thread ${entry.threadId})` : '';
  const who = entry.responderName
    ? ` — ${entry.responderName} is answering this; do not reply unless you are asked.`
    : ' — not addressed to you; do not reply unless you are asked.';
  return `  - ${entry.sender}${where}: ${clip(entry.content, ROOM_CONTEXT_CONSTANTS.PER_ENTRY_CHARS)}${who}`;
}

/**
 * Render queued entries as the block that goes at the top of a prompt.
 *
 * @param entries - Entries, oldest first
 * @returns The block, or '' when there are none
 */
export function renderContextOnlyBlock(entries: readonly RoomContextEntry[]): string {
  if (entries.length === 0) return '';
  return [
    '[Context only — not for you to answer] Messages in this room since your last turn:',
    ...entries.map((e) => contextOnlyLine(e)),
    '[end of context-only messages]',
  ].join('\n');
}

/**
 * Per (agent, room) queue of context-only messages.
 */
export class RoomContextBacklog {
  private readonly queues = new Map<string, RoomContextEntry[]>();
  private readonly now: () => number;

  constructor(options: RoomContextBacklogOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  private static key(agentSession: string, channelId: string): string {
    return `${agentSession}\u0000${channelId}`;
  }

  /**
   * Queue a message for an agent, to be shown on its next prompt from this room.
   *
   * @param agentSession - The agent
   * @param channelId - The room (chat-v2 channel id)
   * @param entry - The message (its `at` is set here)
   */
  add(agentSession: string, channelId: string, entry: Omit<RoomContextEntry, 'at'>): void {
    const key = RoomContextBacklog.key(agentSession, channelId);
    const list = this.fresh(this.queues.get(key) ?? []);
    if (list.some((e) => e.messageId === entry.messageId)) return;
    list.push({ ...entry, at: this.now() });
    while (list.length > ROOM_CONTEXT_CONSTANTS.MAX_ENTRIES) list.shift();
    this.queues.delete(key);
    this.queues.set(key, list);
    while (this.queues.size > ROOM_CONTEXT_CONSTANTS.MAX_QUEUES) {
      const oldest = this.queues.keys().next().value;
      if (oldest === undefined) break;
      this.queues.delete(oldest);
    }
  }

  /**
   * Take (and clear) what an agent has queued for a room.
   *
   * @param agentSession - The agent
   * @param channelId - The room
   * @param excludeMessageId - The message being delivered now (never shown as its own context)
   * @returns Entries, oldest first
   */
  take(agentSession: string, channelId: string, excludeMessageId?: string): RoomContextEntry[] {
    const key = RoomContextBacklog.key(agentSession, channelId);
    const list = this.queues.get(key);
    if (!list) return [];
    this.queues.delete(key);
    return this.fresh(list).filter((e) => e.messageId !== excludeMessageId);
  }

  /**
   * Put entries back after a delivery failed, ahead of anything queued since.
   *
   * @param agentSession - The agent
   * @param channelId - The room
   * @param entries - What {@link take} returned
   */
  restore(agentSession: string, channelId: string, entries: readonly RoomContextEntry[]): void {
    if (entries.length === 0) return;
    const key = RoomContextBacklog.key(agentSession, channelId);
    const later = this.queues.get(key) ?? [];
    const merged = [...entries, ...later.filter((e) => !entries.some((x) => x.messageId === e.messageId))];
    this.queues.set(key, merged.slice(-ROOM_CONTEXT_CONSTANTS.MAX_ENTRIES));
  }

  /**
   * What an agent has queued for a room, without taking it (tests, diagnostics).
   *
   * @param agentSession - The agent
   * @param channelId - The room
   * @returns Entries, oldest first
   */
  peek(agentSession: string, channelId: string): RoomContextEntry[] {
    return this.fresh(this.queues.get(RoomContextBacklog.key(agentSession, channelId)) ?? []);
  }

  private fresh(list: RoomContextEntry[]): RoomContextEntry[] {
    const cutoff = this.now() - ROOM_CONTEXT_CONSTANTS.TTL_MS;
    return list.filter((e) => e.at >= cutoff);
  }
}
