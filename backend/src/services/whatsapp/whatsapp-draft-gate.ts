/**
 * WhatsApp Draft Send Gate
 *
 * Decides whether a reply draft may be sent. Owner decision (2026-09-24):
 * nothing is ever sent to WhatsApp without the owner's explicit
 * confirmation, one message at a time.
 *
 * - A request with no `X-Agent-Session` header is the owner (dashboard,
 *   mobile, portal) — the click is the confirmation.
 * - An agent may send only when a genuine owner chat message (from
 *   `ChatV2Service.getRecentOwnerMessageContents`, which agents cannot
 *   write) created after the draft says 「发 W12」 for this draft's code, and
 *   the draft is at most `DRAFT_CONFIRM_WINDOW_MS` old. Because the owner
 *   message must post-date the draft, bounding the draft's age also bounds
 *   the confirmation to that window.
 *
 * @module services/whatsapp/whatsapp-draft-gate
 */

import { WHATSAPP_CONSTANTS } from '../../constants.js';
import type { WhatsAppDraft } from '../../types/whatsapp.types.js';
import { parseDraftCode } from './whatsapp-inbox.store.js';

/** Milliseconds per minute (for human-readable window text). */
const MS_PER_MINUTE = 60 * 1000;

/** Why an agent's send was refused. */
export type DraftSendRefusal = 'no_confirmation' | 'window_expired';

/** Outcome of {@link decideDraftSend}. */
export type DraftSendDecision =
  | { allowed: true; via: 'owner' | 'owner_confirmation'; confirmation?: string }
  | { allowed: false; reason: DraftSendRefusal };

/** Inputs for {@link decideDraftSend}. */
export interface DraftSendContext {
  /** The draft (must be pending — checked by the caller) */
  draft: WhatsAppDraft;
  /** `X-Agent-Session` of the caller; undefined = owner */
  agentSession: string | undefined;
  /** Owner message texts created at/after `sinceMs`, newest first */
  ownerMessagesSince: (sinceMs: number) => string[];
  /** Current epoch ms */
  now: number;
}

/**
 * Whether one owner message confirms sending a given draft.
 *
 * @param text - Owner message text
 * @param draft - The draft
 * @returns True for 「发 W12」 / 「发送 12」 / "send #W12" / 「确认发送 W12」 naming this draft
 */
export function isConfirmationFor(text: string, draft: Pick<WhatsAppDraft, 'seq'>): boolean {
  const m = WHATSAPP_CONSTANTS.DRAFT_CONFIRM_PATTERN.exec(text.trim());
  if (!m) return false;
  return parseDraftCode(m[2]) === draft.seq;
}

/**
 * Decide whether the caller may send this draft now.
 *
 * @param ctx - Draft, caller, owner-message source, clock
 * @returns Allowed (and why), or refused (and why)
 */
export function decideDraftSend(ctx: DraftSendContext): DraftSendDecision {
  if (!ctx.agentSession) return { allowed: true, via: 'owner' };
  if (ctx.now - ctx.draft.createdAt > WHATSAPP_CONSTANTS.DRAFT_CONFIRM_WINDOW_MS) {
    return { allowed: false, reason: 'window_expired' };
  }
  const confirmation = ctx.ownerMessagesSince(ctx.draft.createdAt).find((t) => isConfirmationFor(t, ctx.draft));
  return confirmation !== undefined
    ? { allowed: true, via: 'owner_confirmation', confirmation }
    : { allowed: false, reason: 'no_confirmation' };
}

/**
 * The instruction an agent must follow after drafting: show the owner the
 * draft and ask for 「发 <code>」.
 *
 * @param draft - The draft
 * @param recipient - Human label for the recipient (chat name or JID)
 * @returns Instruction text
 */
export function buildOwnerConfirmPrompt(draft: Pick<WhatsAppDraft, 'code' | 'text'>, recipient: string): string {
  return (
    `Draft ${draft.code} is saved but NOT sent. Show the owner the recipient (${recipient}), ` +
    `the exact draft text, and the code ${draft.code}, and ask them to reply 「发 ${draft.code}」 to send it ` +
    `(or send/discard it from the dashboard). Do not send it until they do.`
  );
}

/**
 * Human message for a refused agent send.
 *
 * @param draft - The draft
 * @param reason - Refusal reason
 * @returns Message for the 403 body
 */
export function buildRefusalMessage(draft: Pick<WhatsAppDraft, 'code'>, reason: DraftSendRefusal): string {
  const windowMinutes = Math.round(WHATSAPP_CONSTANTS.DRAFT_CONFIRM_WINDOW_MS / MS_PER_MINUTE);
  if (reason === 'window_expired') {
    return (
      `Draft ${draft.code} is older than ${windowMinutes} minutes, so it can no longer be sent on the owner's ` +
      `chat confirmation. Ask the owner to send it from the dashboard, or write a fresh draft and ask them to reply 「发 <new code>」.`
    );
  }
  return (
    `The owner has not confirmed draft ${draft.code}. Show the owner the draft (recipient and exact text) ` +
    `and ask them to reply 「发 ${draft.code}」. Only then call send again. Never send without it.`
  );
}
