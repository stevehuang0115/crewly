/**
 * WhatsApp Settings Constants
 *
 * Endpoints, the default connect mode and the owner-facing copy for the
 * WhatsApp tab. Mirrors `WHATSAPP_CONSTANTS` in `backend/src/constants.ts`
 * (the frontend bundle does not import backend constants).
 *
 * @module constants/whatsapp.constants
 */

/** Base path of the WhatsApp REST API. */
export const WHATSAPP_API_BASE = '/api/whatsapp';

/** WhatsApp REST endpoints used by the Settings tab. */
export const WHATSAPP_ENDPOINTS = Object.freeze({
  STATUS: `${WHATSAPP_API_BASE}/status`,
  CONNECT: `${WHATSAPP_API_BASE}/connect`,
  DISCONNECT: `${WHATSAPP_API_BASE}/disconnect`,
  PENDING_DRAFTS: `${WHATSAPP_API_BASE}/drafts?status=pending`,
  /** POST — send one draft (owner call: no agent header) */
  draftSend: (id: string): string => `${WHATSAPP_API_BASE}/drafts/${encodeURIComponent(id)}/send`,
  /** POST — discard one draft */
  draftDiscard: (id: string): string => `${WHATSAPP_API_BASE}/drafts/${encodeURIComponent(id)}/discard`,
});

/** Connection modes (see backend `WHATSAPP_CONSTANTS.MODES`). */
export const WHATSAPP_MODES = Object.freeze({
  INBOX: 'inbox',
  ASSISTANT: 'assistant',
} as const);

/** WhatsApp connection mode. */
export type WhatsAppMode = (typeof WHATSAPP_MODES)[keyof typeof WHATSAPP_MODES];

/** Mode the Connect button uses (owner decision: read + draft, never auto-send). */
export const WHATSAPP_DEFAULT_CONNECT_MODE: WhatsAppMode = WHATSAPP_MODES.INBOX;

/** Owner-facing copy for the inbox-mode explainer. */
export const WHATSAPP_INBOX_COPY = Object.freeze({
  TITLE: '收件箱模式 · Inbox mode',
  ZH: '只读+起草，发送前需要你确认；不会自动回复任何人。',
  EN: 'Read-only + drafts: nothing is sent until you confirm, and Crewly never auto-replies to anyone.',
  TOS:
    'Connects as a linked device through an unofficial client (like WhatsApp Web). WhatsApp does not allow automated messaging and may ban numbers that do it, which is why every send waits for you.',
  ASSISTANT_WARNING:
    'Assistant mode: incoming messages are routed to the orchestrator and answered automatically. Disconnect and reconnect to switch to inbox mode.',
});
