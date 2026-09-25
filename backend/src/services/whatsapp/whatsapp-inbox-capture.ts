/**
 * WhatsApp Inbox Capture
 *
 * Turns Baileys events into inbox-store rows. Used only in `inbox` mode.
 * Unlike the assistant path (`WhatsAppService.handleIncomingMessage`) nothing
 * is dropped for being the owner's own message, a group message, media, or
 * from a contact outside `allowedContacts` — the inbox has to know whether
 * the owner already replied, and it is the owner's own account.
 *
 * Media are never downloaded: a message is recorded as its kind plus caption
 * (or file name for documents).
 *
 * Baileys shapes relied on (v7, `@whiskeysockets/baileys` typings):
 * - `messages.upsert`: `{ messages: WAMessage[], type: 'notify' | 'append' }`
 * - `messaging-history.set`: `{ chats: Chat[], contacts: Contact[], messages: WAMessage[], syncType? }`
 * - `contacts.upsert` / `contacts.update`: `Contact[]` (`id`, `name` = address book, `notify` = their pushName)
 * - `chats.upsert` / `chats.update`: `Chat[]` (`id`, `name`, `conversationTimestamp`)
 * - `groups.upsert` / `groups.update`: `GroupMetadata[]` (`id`, `subject`)
 * - `WAMessage.key.remoteJidAlt` / `participantAlt` (v7 LID↔PN alternates)
 * - `messageTimestamp`: seconds, as number, numeric string or protobuf Long
 *
 * @module services/whatsapp/whatsapp-inbox-capture
 */

import { WHATSAPP_CONSTANTS } from '../../constants.js';
import type { WhatsAppInboxMessage, WhatsAppMessageKind } from '../../types/whatsapp.types.js';
import type { UpsertChatInput, WhatsAppInboxStore } from './whatsapp-inbox.store.js';

/** Milliseconds per second (Baileys timestamps are seconds). */
const MS_PER_SECOND = 1000;

/** Max wrapper depth unwrapped (ephemeral → viewOnce → ...), as Baileys does. */
const MAX_UNWRAP_DEPTH = 5;

/** Wrapper message keys whose `.message` holds the real content. */
const WRAPPER_KEYS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
] as const;

/**
 * Content keys that are not user-visible messages (receipts of protocol
 * work, reactions, key distribution). A message carrying only these is not
 * stored.
 */
const NON_MESSAGE_KEYS = new Set([
  'protocolMessage',
  'reactionMessage',
  'senderKeyDistributionMessage',
  'messageContextInfo',
  'pollUpdateMessage',
  'keepInChatMessage',
  'encReactionMessage',
]);

/** Loose record type for untyped Baileys payloads. */
type Rec = Record<string, unknown>;

/**
 * Narrow an unknown to a plain object.
 *
 * @param v - Anything
 * @returns The object, or undefined
 */
function asRec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' ? (v as Rec) : undefined;
}

/**
 * Read a non-empty string field.
 *
 * @param v - Anything
 * @returns The string, or undefined when absent/blank
 */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Convert a Baileys timestamp (seconds as number, numeric string, or
 * protobuf Long with `toNumber()` / `low`+`high`) to epoch ms.
 *
 * @param ts - Raw timestamp
 * @returns Epoch ms, or null when unparseable / non-positive
 */
export function toEpochMs(ts: unknown): number | null {
  let seconds: number | null = null;
  if (typeof ts === 'number') seconds = ts;
  else if (typeof ts === 'bigint') seconds = Number(ts);
  else if (typeof ts === 'string' && /^\d+$/.test(ts)) seconds = Number(ts);
  else {
    const r = asRec(ts);
    if (r && typeof r.toNumber === 'function') seconds = (r.toNumber as () => number)();
    else if (r && typeof r.low === 'number') {
      const high = typeof r.high === 'number' ? r.high : 0;
      seconds = high * 2 ** 32 + (r.low >>> 0);
    }
  }
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * MS_PER_SECOND);
}

/**
 * Whether a JID is a group chat.
 *
 * @param jid - JID
 * @returns True for `...@g.us`
 */
export function isGroupJid(jid: string): boolean {
  return jid.endsWith(WHATSAPP_CONSTANTS.GROUP_JID_SUFFIX);
}

/**
 * Pick the canonical JID for a person: prefer the phone-number form when
 * Baileys supplies it as the alternate of a LID, so the same person's
 * messages (some keyed by LID, some by phone number) land in one chat.
 *
 * @param jid - Primary JID (`remoteJid` / `participant`)
 * @param alt - Alternate JID (`remoteJidAlt` / `participantAlt`)
 * @returns The canonical JID
 */
export function canonicalJid(jid: string, alt?: string): string {
  if (jid.endsWith(WHATSAPP_CONSTANTS.LID_JID_SUFFIX) && alt && alt.endsWith(WHATSAPP_CONSTANTS.USER_JID_SUFFIX)) {
    return alt;
  }
  return jid;
}

/**
 * Strip wrapper messages (disappearing, view-once, edited, doc-with-caption).
 *
 * @param content - `WAMessage.message`
 * @returns The innermost content object, or undefined
 */
export function unwrapMessageContent(content: unknown): Rec | undefined {
  let cur = asRec(content);
  for (let i = 0; i < MAX_UNWRAP_DEPTH && cur; i++) {
    let inner: Rec | undefined;
    for (const k of WRAPPER_KEYS) {
      inner = asRec(asRec(cur[k])?.message);
      if (inner) break;
    }
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

/**
 * Classify message content into a stored kind and its text/caption.
 *
 * @param content - `WAMessage.message` (wrappers allowed)
 * @returns `{ kind, text }`, or null when this is not a user-visible message
 *   (protocol message, reaction, empty envelope)
 */
export function classifyMessageContent(content: unknown): { kind: WhatsAppMessageKind; text: string } | null {
  const c = unwrapMessageContent(content);
  if (!c) return null;
  const K = WHATSAPP_CONSTANTS.MESSAGE_KINDS;

  const conversation = str(c.conversation);
  if (conversation) return { kind: K.TEXT, text: conversation };
  const ext = asRec(c.extendedTextMessage);
  if (ext) return { kind: K.TEXT, text: str(ext.text) ?? '' };

  const image = asRec(c.imageMessage);
  if (image) return { kind: K.IMAGE, text: str(image.caption) ?? '' };
  const video = asRec(c.videoMessage) ?? asRec(c.ptvMessage);
  if (video) return { kind: K.VIDEO, text: str(video.caption) ?? '' };
  const doc = asRec(c.documentMessage);
  if (doc) return { kind: K.DOCUMENT, text: str(doc.caption) ?? str(doc.fileName) ?? str(doc.title) ?? '' };
  if (asRec(c.audioMessage)) return { kind: K.AUDIO, text: '' };
  if (asRec(c.stickerMessage)) return { kind: K.STICKER, text: '' };

  const visibleKeys = Object.keys(c).filter((k) => c[k] !== null && c[k] !== undefined && !NON_MESSAGE_KEYS.has(k));
  if (visibleKeys.length === 0) return null;
  return { kind: K.OTHER, text: '' };
}

/** Result of parsing one Baileys message. */
export interface ParsedWhatsAppMessage {
  /** Row for the store */
  message: WhatsAppInboxMessage;
  /** Whether the chat is a group */
  isGroup: boolean;
  /** Sender's self-chosen name, when the message carried one (not for own messages) */
  pushName: string | null;
}

/**
 * Parse a Baileys `WAMessage` into an inbox row.
 *
 * @param raw - The WAMessage
 * @param ownJid - The connected account's JID (sender of `fromMe` messages), if known
 * @returns The parsed message, or null when it is not storable (no id/chat,
 *   status broadcast, protocol-only content, no timestamp)
 */
export function parseBaileysMessage(raw: unknown, ownJid?: string | null): ParsedWhatsAppMessage | null {
  const r = asRec(raw);
  const key = asRec(r?.key);
  const remoteJid = str(key?.remoteJid);
  const id = str(key?.id);
  if (!r || !key || !remoteJid || !id) return null;
  if (remoteJid === WHATSAPP_CONSTANTS.STATUS_BROADCAST_JID) return null;

  const classified = classifyMessageContent(r.message);
  if (!classified) return null;
  const ts = toEpochMs(r.messageTimestamp);
  if (ts === null) return null;

  const fromMe = key.fromMe === true;
  const chatId = canonicalJid(remoteJid, str(key.remoteJidAlt));
  const isGroup = isGroupJid(chatId);
  const participant = str(key.participant);
  const pushName = fromMe ? null : (str(r.pushName) ?? null);

  let senderJid: string | null;
  if (fromMe) senderJid = ownJid ?? null;
  else if (isGroup) senderJid = participant ? canonicalJid(participant, str(key.participantAlt)) : null;
  else senderJid = chatId;

  return {
    message: {
      id,
      chatId,
      fromMe,
      senderJid,
      senderName: pushName,
      text: classified.text,
      ts,
      kind: classified.kind,
    },
    isGroup,
    pushName,
  };
}

/**
 * Chat row from a Baileys `Contact`: the address-book name outranks the
 * contact's own pushName (`notify`) and business `verifiedName`.
 *
 * @param contact - Contact (full or partial update)
 * @returns Upsert input, or null when the contact names nothing useful
 */
export function chatFromContact(contact: unknown): UpsertChatInput | null {
  const c = asRec(contact);
  const rawId = str(c?.id);
  if (!c || !rawId) return null;
  const id = canonicalJid(rawId, str(c.phoneNumber));
  const R = WHATSAPP_CONSTANTS.NAME_RANKS;
  const saved = str(c.name);
  if (saved) return { id, name: saved, nameRank: R.CONTACT };
  const other = str(c.notify) ?? str(c.verifiedName);
  if (other) return { id, name: other, nameRank: R.PUSH_NAME };
  return null;
}

/**
 * Chat row from a Baileys `Chat` (history sync, `chats.upsert/update`).
 *
 * @param chat - Chat
 * @returns Upsert input, or null without an id / for the status pseudo-chat
 */
export function chatFromChat(chat: unknown): UpsertChatInput | null {
  const c = asRec(chat);
  const id = str(c?.id);
  if (!c || !id || id === WHATSAPP_CONSTANTS.STATUS_BROADCAST_JID) return null;
  return {
    id,
    name: str(c.name) ?? null,
    nameRank: WHATSAPP_CONSTANTS.NAME_RANKS.CHAT,
    isGroup: isGroupJid(id),
    lastMessageAt: toEpochMs(c.conversationTimestamp),
  };
}

/**
 * Chat row from Baileys `GroupMetadata` (subject = group name).
 *
 * @param group - Group metadata (full or partial)
 * @returns Upsert input, or null without an id
 */
export function chatFromGroup(group: unknown): UpsertChatInput | null {
  const g = asRec(group);
  const id = str(g?.id);
  if (!g || !id) return null;
  return { id, name: str(g.subject) ?? null, nameRank: WHATSAPP_CONSTANTS.NAME_RANKS.CHAT, isGroup: true };
}

/** Optional hooks for {@link WhatsAppInboxCapture}. */
export interface WhatsAppInboxCaptureOptions {
  /** The connected account's JID (sender of own messages) */
  getOwnJid?: () => string | null;
  /** Fetch a group's subject for a group we have no name for (best effort) */
  fetchGroupSubject?: (jid: string) => Promise<string | null>;
  /** Clock (tests) */
  now?: () => number;
}

/**
 * Writes Baileys events into a {@link WhatsAppInboxStore}.
 *
 * Every handler is defensive: a malformed payload is skipped, never thrown,
 * because it runs inside the socket's event loop.
 */
export class WhatsAppInboxCapture {
  private readonly store: WhatsAppInboxStore;
  private readonly opts: WhatsAppInboxCaptureOptions;
  private readonly groupLookups = new Set<string>();

  /**
   * @param store - Destination store
   * @param opts - Own-JID accessor, group-subject fetcher, clock
   */
  constructor(store: WhatsAppInboxStore, opts: WhatsAppInboxCaptureOptions = {}) {
    this.store = store;
    this.opts = opts;
  }

  /**
   * Store one message and name its chat.
   *
   * @param raw - A WAMessage
   * @returns True when stored
   */
  captureMessage(raw: unknown): boolean {
    const parsed = parseBaileysMessage(raw, this.opts.getOwnJid?.() ?? null);
    if (!parsed) return false;
    const { message, isGroup, pushName } = parsed;
    // In a 1:1 chat the sender's pushName is a (weak) name for the chat.
    this.store.upsertChat({
      id: message.chatId,
      isGroup,
      name: !isGroup ? pushName : null,
      nameRank: WHATSAPP_CONSTANTS.NAME_RANKS.PUSH_NAME,
      lastMessageAt: message.ts,
    });
    this.store.upsertMessage(message);
    if (isGroup) this.maybeFetchGroupName(message.chatId);
    return true;
  }

  /**
   * Handle `messages.upsert` (both `notify` and `append`: own messages sent
   * from the phone and backfills arrive as `append`).
   *
   * @param upsert - `{ messages, type }`
   * @returns Number of messages stored
   */
  onMessagesUpsert(upsert: unknown): number {
    const messages = asRec(upsert)?.messages;
    if (!Array.isArray(messages)) return 0;
    let n = 0;
    for (const m of messages) if (this.captureMessage(m)) n++;
    return n;
  }

  /**
   * Handle `messaging-history.set`: seed chats, contact names and recent
   * messages. Messages older than `HISTORY_SYNC_MAX_AGE_MS` are skipped.
   *
   * @param payload - `{ chats, contacts, messages }`
   * @returns Number of messages stored
   */
  onHistorySet(payload: unknown): number {
    const p = asRec(payload);
    if (!p) return 0;
    const chats = (Array.isArray(p.chats) ? p.chats : []).map(chatFromChat).filter((c): c is UpsertChatInput => c !== null);
    const contacts = (Array.isArray(p.contacts) ? p.contacts : [])
      .map(chatFromContact)
      .filter((c): c is UpsertChatInput => c !== null);
    this.store.upsertChats([...chats, ...contacts]);

    const cutoff = (this.opts.now?.() ?? Date.now()) - WHATSAPP_CONSTANTS.HISTORY_SYNC_MAX_AGE_MS;
    const ownJid = this.opts.getOwnJid?.() ?? null;
    const parsed = (Array.isArray(p.messages) ? p.messages : [])
      .map((m) => parseBaileysMessage(m, ownJid))
      .filter((m): m is ParsedWhatsAppMessage => m !== null && m.message.ts >= cutoff);
    this.store.upsertChats(
      parsed
        .filter((m) => !m.isGroup && m.pushName)
        .map((m) => ({ id: m.message.chatId, name: m.pushName, nameRank: WHATSAPP_CONSTANTS.NAME_RANKS.PUSH_NAME })),
    );
    return this.store.upsertMessages(parsed.map((m) => m.message));
  }

  /**
   * Handle `contacts.upsert` / `contacts.update`.
   *
   * @param contacts - Contact list
   */
  onContacts(contacts: unknown): void {
    if (!Array.isArray(contacts)) return;
    this.store.upsertChats(contacts.map(chatFromContact).filter((c): c is UpsertChatInput => c !== null));
  }

  /**
   * Handle `chats.upsert` / `chats.update`.
   *
   * @param chats - Chat list
   */
  onChats(chats: unknown): void {
    if (!Array.isArray(chats)) return;
    this.store.upsertChats(chats.map(chatFromChat).filter((c): c is UpsertChatInput => c !== null));
  }

  /**
   * Handle `groups.upsert` / `groups.update`.
   *
   * @param groups - Group metadata list
   */
  onGroups(groups: unknown): void {
    if (!Array.isArray(groups)) return;
    this.store.upsertChats(groups.map(chatFromGroup).filter((c): c is UpsertChatInput => c !== null));
  }

  /**
   * Look a group's subject up once per process when we have no name for it.
   *
   * @param jid - Group JID
   */
  private maybeFetchGroupName(jid: string): void {
    const fetcher = this.opts.fetchGroupSubject;
    if (!fetcher || this.groupLookups.has(jid)) return;
    if (this.store.getChat(jid)?.name) return;
    this.groupLookups.add(jid);
    fetcher(jid)
      .then((subject) => {
        if (subject) this.store.upsertChat({ id: jid, name: subject, nameRank: WHATSAPP_CONSTANTS.NAME_RANKS.CHAT, isGroup: true });
      })
      .catch(() => {
        // Best effort — the chat keeps its JID as the label.
      });
  }
}
