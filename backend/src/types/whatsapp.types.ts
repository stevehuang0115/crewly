/**
 * WhatsApp Integration Types
 *
 * Types for WhatsApp integration via Baileys (WhatsApp Web multi-device protocol),
 * enabling mobile communication with the Crewly orchestrator.
 *
 * @module types/whatsapp
 */

import { WHATSAPP_CONSTANTS } from '../constants.js';
import type { WhatsAppMode } from '../constants.js';

export type { WhatsAppMode } from '../constants.js';

/**
 * WhatsApp service configuration
 */
export interface WhatsAppConfig {
  /** Phone number associated with WhatsApp account (for display purposes) */
  phoneNumber?: string;
  /** Path to auth state directory (defaults to ~/.crewly/whatsapp-auth/) */
  authStatePath?: string;
  /** Allowed contact phone numbers or JIDs (empty = all contacts allowed) */
  allowedContacts?: string[];
  /**
   * `assistant` (default for the legacy env path) routes messages to the
   * orchestrator and auto-replies; `inbox` stores everything read-only and
   * never sends without the owner's confirmation. Absent = assistant, so
   * existing callers of `initialize()` keep their behaviour.
   */
  mode?: WhatsAppMode;
}

/**
 * Incoming WhatsApp message
 */
export interface WhatsAppIncomingMessage {
  /** WhatsApp message ID */
  messageId: string;
  /** Chat/conversation JID (e.g., 1234567890@s.whatsapp.net) */
  chatId: string;
  /** Sender JID */
  from: string;
  /** Message text content */
  text: string;
  /** Whether the message is from a group chat */
  isGroup: boolean;
  /** Contact display name (if available) */
  contactName?: string;
  /** Timestamp of the message */
  timestamp: number;
}

/**
 * Outgoing WhatsApp message
 */
export interface WhatsAppOutgoingMessage {
  /** Destination chat JID */
  to: string;
  /** Message text content */
  text: string;
}

/**
 * WhatsApp service status
 */
export interface WhatsAppServiceStatus {
  /** Whether the socket is connected */
  connected: boolean;
  /** Current QR code string if pending pairing (null if connected or disconnected) */
  qrCode: string | null;
  /** Phone number of the connected account */
  phoneNumber: string | null;
  /** Total messages sent */
  messagesSent: number;
  /** Total messages received */
  messagesReceived: number;
  /** Mode of the current (or last) connection; null before the first initialize */
  mode: WhatsAppMode | null;
}

/**
 * WhatsApp conversation context for message routing
 */
export interface WhatsAppConversationContext {
  /** Chat JID */
  chatId: string;
  /** Contact display name */
  contactName: string;
  /** Crewly conversation ID (maps to chat system) */
  conversationId: string;
  /** Total messages in this conversation */
  messageCount: number;
}

/**
 * Check if a contact is allowed to interact with the bot
 *
 * @param from - Sender JID or phone number
 * @param config - WhatsApp configuration with allowed contacts
 * @returns True if contact is allowed to interact
 */
export function isContactAllowed(from: string, config: WhatsAppConfig): boolean {
  if (!config.allowedContacts || config.allowedContacts.length === 0) {
    return true; // No restrictions
  }
  // Strip the @s.whatsapp.net suffix and + prefix for exact comparison.
  // WhatsApp JIDs use full international numbers without + (e.g., 11234567890@s.whatsapp.net).
  const normalizedFrom = from
    .replace(WHATSAPP_CONSTANTS.JID_SUFFIX_PATTERN, '')
    .replace(WHATSAPP_CONSTANTS.PHONE_PREFIX_PATTERN, '');
  return config.allowedContacts.some((contact) => {
    const normalizedContact = contact
      .replace(WHATSAPP_CONSTANTS.PHONE_PREFIX_PATTERN, '')
      .replace(WHATSAPP_CONSTANTS.JID_SUFFIX_PATTERN, '');
    return normalizedFrom === normalizedContact;
  });
}

/**
 * Whether a value is a valid WhatsApp connection mode.
 *
 * @param value - Anything (typically a request body field or env var)
 * @returns True for `assistant` or `inbox`
 */
export function isWhatsAppMode(value: unknown): value is WhatsAppMode {
  return value === WHATSAPP_CONSTANTS.MODES.ASSISTANT || value === WHATSAPP_CONSTANTS.MODES.INBOX;
}

/** Kind of a stored inbox message; media are recorded by kind + caption only */
export type WhatsAppMessageKind =
  (typeof WHATSAPP_CONSTANTS.MESSAGE_KINDS)[keyof typeof WHATSAPP_CONSTANTS.MESSAGE_KINDS];

/** Lifecycle status of a reply draft */
export type WhatsAppDraftStatus =
  (typeof WHATSAPP_CONSTANTS.DRAFT_STATUSES)[keyof typeof WHATSAPP_CONSTANTS.DRAFT_STATUSES];

/**
 * A chat (1:1 or group) in the local inbox store.
 */
export interface WhatsAppInboxChat {
  /** Chat JID */
  id: string;
  /** Best-known display name (address book > chat/group subject > pushName), null if unknown */
  name: string | null;
  /** Whether the chat is a group */
  isGroup: boolean;
  /** Epoch ms of the newest stored message, null if none yet */
  lastMessageAt: number | null;
}

/**
 * A message in the local inbox store.
 */
export interface WhatsAppInboxMessage {
  /** WhatsApp message id (unique key; upserts are idempotent on it) */
  id: string;
  /** Chat JID the message belongs to */
  chatId: string;
  /** True when the owner sent it (from the phone or via Crewly) */
  fromMe: boolean;
  /** Sender JID (participant in groups), null when unknown */
  senderJid: string | null;
  /** Sender's display name when known */
  senderName: string | null;
  /** Text, or the caption / file name of a media message ('' when none) */
  text: string;
  /** Epoch ms */
  ts: number;
  /** Message kind */
  kind: WhatsAppMessageKind;
}

/**
 * One row of the "needs a reply" inbox.
 */
export interface WhatsAppInboxEntry {
  /** The chat */
  chat: WhatsAppInboxChat;
  /** Inbound messages since the owner last wrote in this chat */
  unansweredCount: number;
  /** Text of the newest message */
  lastText: string;
  /** Kind of the newest message */
  lastKind: WhatsAppMessageKind;
  /** Sender name of the newest message (useful in groups) */
  lastSenderName: string | null;
  /** Epoch ms of the newest message */
  lastMessageAt: number;
}

/**
 * A search hit: a message plus the chat it lives in.
 */
export interface WhatsAppSearchHit extends WhatsAppInboxMessage {
  /** Name of the chat the message belongs to */
  chatName: string | null;
}

/**
 * A reply draft an agent proposed. Sent only with the owner's confirmation.
 */
export interface WhatsAppDraft {
  /** Opaque id */
  id: string;
  /** Short human code, e.g. `W12` — the owner confirms with 「发 W12」 */
  code: string;
  /** Monotonic sequence number behind the code */
  seq: number;
  /** Recipient chat JID */
  chatId: string;
  /** Proposed reply text */
  text: string;
  /** Lifecycle status */
  status: WhatsAppDraftStatus;
  /** Epoch ms when proposed */
  createdAt: number;
  /** Agent session that proposed it, null when the owner wrote it */
  createdBy: string | null;
  /** Epoch ms when sent, null otherwise */
  sentAt: number | null;
  /** Epoch ms when discarded, null otherwise */
  discardedAt: number | null;
  /** Last send failure, if the socket rejected it */
  lastError: string | null;
}
