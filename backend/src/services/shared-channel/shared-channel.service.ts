/**
 * Receive side of shared channels (crewly#1543 slice 4): when Cloud says
 * another company's account wrote on a linked channel, fetch the new messages,
 * mirror them into Team Chat as an `external-<linkId>` channel and wake the
 * default responder (the orchestrator) only.
 *
 * Trust: a push carries no text. Everything mirrored is fetched from Cloud
 * with this machine's own token, so a forged push can at most trigger a fetch.
 * Mirrored text reaches an agent only behind the untrusted-sender framing in
 * {@link formatExternalMessage}.
 *
 * Dependencies are injected so the service is testable without Cloud or chat.
 *
 * @module services/shared-channel/shared-channel.service
 */

import { SHARED_CHANNEL_CONSTANTS } from '../../constants.js';
import {
  isSharedChannelMessagePush,
  isSharedChannelRevokedPush,
  type SharedChannelLink,
  type SharedChannelPage,
} from './shared-channel.types.js';
import { counterpartLabel, externalSenderName, formatExternalMessage } from './shared-channel-framing.js';

/** Most received messages one sync wakes the responder for (older ones are mirrored silently). */
export const MAX_WAKES_PER_SYNC = 5;

/** One message to file in Team Chat. */
export interface SharedChannelMirrorInput {
  linkId: string;
  /** Channel title: the counterpart's display name or email */
  counterpart: string;
  messageId: string;
  /** Name shown on the row */
  senderName: string;
  direction: 'sent' | 'received';
  text: string;
  createdAtMs: number;
  replyTo?: string;
}

/** Everything the service needs from the outside. */
export interface SharedChannelDeps {
  /** The account's links, or null when Cloud cannot be reached */
  listLinks(): Promise<SharedChannelLink[] | null>;
  /** History of a link after a cursor, or null when Cloud cannot be reached */
  fetchMessages(linkId: string, after: string | undefined, limit: number): Promise<SharedChannelPage | null>;
  /** Persistent read position per link */
  cursors: { get(linkId: string): string | undefined; set(linkId: string, messageId: string): void };
  /** File one message in chat; true when it is new (false for a redelivery). May throw. */
  mirror(input: SharedChannelMirrorInput): boolean;
  /** Make the link's channel read-only (keeps history). No-op when the channel does not exist. */
  markRevoked(linkId: string, counterpart: string): void;
  /** Deliver text to the orchestrator (queued when it is down). */
  notifyOrchestrator(text: string): Promise<void>;
  /** Logger */
  log?: { info(msg: string, meta?: object): void; warn(msg: string, meta?: object): void };
}

/** What a relay message led to. */
export interface SharedChannelOutcome {
  handled: boolean;
  mirrored?: number;
  woke?: number;
  reason?: string;
}

/** Mirrors shared channels into Team Chat — see module docs. */
export class SharedChannelService {
  private readonly links = new Map<string, SharedChannelLink>();
  private readonly running = new Map<string, Promise<number>>();
  private readonly rerun = new Set<string>();

  constructor(private readonly deps: SharedChannelDeps) {}

  /**
   * Handle one relay message. Other types are not handled. Never throws.
   *
   * @param type - Relay message type
   * @param payload - Its `data`
   * @returns What was done
   */
  async receive(type: string, payload: unknown): Promise<SharedChannelOutcome> {
    try {
      if (type === SHARED_CHANNEL_CONSTANTS.MESSAGE_TYPE) {
        if (!isSharedChannelMessagePush(payload)) return { handled: false, reason: 'malformed' };
        await this.ensureLink(payload.linkId);
        const r = await this.sync(payload.linkId, true);
        return { handled: true, mirrored: r.mirrored, woke: r.woke };
      }
      if (type === SHARED_CHANNEL_CONSTANTS.REVOKED_TYPE) {
        if (!isSharedChannelRevokedPush(payload)) return { handled: false, reason: 'malformed' };
        await this.refreshLinks();
        // Last look at the history, then the channel goes read-only.
        const r = await this.sync(payload.linkId, false);
        this.deps.markRevoked(payload.linkId, this.labelOf(payload.linkId));
        return { handled: true, mirrored: r.mirrored };
      }
      return { handled: false };
    } catch (err) {
      this.deps.log?.warn('Shared channel message failed', { error: err instanceof Error ? err.message : String(err) });
      return { handled: false, reason: 'failed' };
    }
  }

  /**
   * Backfill every link (boot and reconnect). Revoked links are read once more
   * and marked read-only. Never throws.
   *
   * @returns Messages mirrored in total
   */
  async syncAll(): Promise<number> {
    let total = 0;
    try {
      const links = await this.refreshLinks();
      if (!links) return 0;
      for (const link of links) {
        const r = await this.sync(link.linkId, false);
        total += r.mirrored;
        if (link.status === 'revoked') this.deps.markRevoked(link.linkId, this.labelOf(link.linkId));
      }
    } catch (err) {
      this.deps.log?.warn('Shared channel backfill failed', { error: err instanceof Error ? err.message : String(err) });
    }
    return total;
  }

  private labelOf(linkId: string): string {
    const l = this.links.get(linkId);
    return counterpartLabel(l?.counterpartDisplayName, l?.counterpartEmail);
  }

  private async refreshLinks(): Promise<SharedChannelLink[] | null> {
    const links = await this.deps.listLinks();
    if (links) for (const l of links) this.links.set(l.linkId, l);
    return links;
  }

  private async ensureLink(linkId: string): Promise<void> {
    if (!this.links.has(linkId)) await this.refreshLinks();
  }

  /**
   * One pass over a link, one at a time per link (a push during a pass asks for one more pass).
   *
   * @param linkId - Link
   * @param live - True for a push: received messages wake the responder
   */
  private async sync(linkId: string, live: boolean): Promise<{ mirrored: number; woke: number }> {
    const active = this.running.get(linkId);
    if (active) {
      this.rerun.add(linkId);
      await active;
      return { mirrored: 0, woke: 0 };
    }
    const result = { mirrored: 0, woke: 0 };
    const pass = (async (): Promise<number> => {
      do {
        this.rerun.delete(linkId);
        await this.pass(linkId, live, result);
      } while (this.rerun.has(linkId));
      return result.mirrored;
    })();
    this.running.set(linkId, pass);
    try {
      await pass;
    } finally {
      this.running.delete(linkId);
    }
    return result;
  }

  private async pass(linkId: string, live: boolean, result: { mirrored: number; woke: number }): Promise<void> {
    const counterpart = this.labelOf(linkId);
    // Without a cursor this is the first read of the link: old history is mirrored silently,
    // unless a push says something new just arrived.
    const hadCursor = this.deps.cursors.get(linkId) !== undefined;
    const wake: Array<{ agent: string; text: string; messageId: string }> = [];
    for (let page = 0; page < SHARED_CHANNEL_CONSTANTS.MAX_PAGES; page++) {
      const after = this.deps.cursors.get(linkId);
      const got = await this.deps.fetchMessages(linkId, after, SHARED_CHANNEL_CONSTANTS.PAGE_SIZE);
      if (!got) {
        this.deps.log?.warn('Could not read a shared channel; will retry on the next push or reconnect', { linkId });
        break;
      }
      for (const m of got.messages) {
        const fresh = this.deps.mirror({
          linkId,
          counterpart,
          messageId: m.id,
          senderName: m.direction === 'received' ? externalSenderName(m.fromAgentName, counterpart) : m.fromAgentName,
          direction: m.direction,
          text: m.text,
          createdAtMs: Date.parse(m.createdAt) || Date.now(),
          ...(m.replyTo ? { replyTo: m.replyTo } : {}),
        });
        this.deps.cursors.set(linkId, m.id);
        if (fresh) {
          result.mirrored += 1;
          if (m.direction === 'received' && (live || hadCursor)) wake.push({ agent: m.fromAgentName, text: m.text, messageId: m.id });
        }
      }
      if (!got.hasMore || got.messages.length === 0) break;
    }
    // Only the newest few wake the responder; the rest are in the channel for the owner.
    for (const w of wake.slice(-MAX_WAKES_PER_SYNC)) {
      try {
        await this.deps.notifyOrchestrator(formatExternalMessage(w.agent, counterpart, w.text, { linkId, messageId: w.messageId }));
        result.woke += 1;
      } catch (err) {
        this.deps.log?.warn('Could not hand a shared-channel message to the orchestrator', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}
