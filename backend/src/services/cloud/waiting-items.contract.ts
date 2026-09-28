/**
 * "Waiting on you" wire contract, machine side — mirrors
 * `AUTH:conversations/waiting.contract.ts` (crewly-services). Change them
 * together.
 *
 *   POST /api/cloud/conversations/waiting/ingest            machine snapshot of its 待验收 tickets
 *   GET  /api/cloud/conversations/waiting/actions/:actionId?instanceId=   fetch a pushed action
 *   POST /api/cloud/conversations/waiting/actions/:actionId/result        report what happened
 *   relay `waiting_action` {v, actionId, itemId, instanceId, ticketId}    Cloud → machine (ids only)
 *
 * Pure (no I/O).
 *
 * @module services/cloud/waiting-items.contract
 */

import { WAITING_SYNC_CONSTANTS } from '../../constants.js';
import type { TicketListItem } from '../v3/ticket-intake.service.js';

/** One ticket in 待验收 as the machine uploads it (text only). */
export interface WaitingIngestItem {
  /** Request id (stable). */
  ticketId: string;
  /** `TKT-12` */
  tkt?: string;
  title: string;
  /** Start of the agent's answer. */
  excerpt?: string;
  /** Agent that answered (local session name). */
  agentSession?: string;
  agentName?: string;
  /** When it went to 待验收 (ISO). */
  since: string;
  /** When silence accepts it (ISO), or null. */
  autoAcceptAt: string | null;
  rejectCount: number;
  /** Ticket's last change (ISO). */
  updatedAt: string;
}

/** `POST /waiting/ingest` body. */
export interface WaitingIngestRequest {
  instanceId: string;
  deviceName?: string;
  crewlyVersion?: string;
  /** True = `items` is the whole set; Cloud removes this machine's other items. */
  full: boolean;
  items: WaitingIngestItem[];
  /** Tickets that left 待验收 (delta uploads). */
  removed?: string[];
  capabilities?: string[];
}

/** `data` of a `waiting_action` relay push. */
export interface WaitingActionRelayData {
  v: 1;
  actionId: string;
  itemId: string;
  instanceId: string;
  ticketId: string;
}

/** What the owner asked for. */
export type WaitingActionKind = 'accept' | 'send_back';

/** `GET /waiting/actions/:actionId?instanceId=` → `data`. */
export interface WaitingActionFetchResponse {
  actionId: string;
  itemId: string;
  instanceId: string;
  ticketId: string;
  kind: WaitingActionKind;
  /** With `send_back`: what still needs fixing. */
  reason?: string;
  state: 'queued' | 'sent' | 'failed';
}

/** `POST /waiting/actions/:actionId/result` body. */
export interface WaitingActionResultRequest {
  instanceId: string;
  ok: boolean;
  /** Refusal code from the ticket service (`not_in_review`, `open_work`, …). */
  code?: string;
  /** Owner-readable reason when not ok. */
  error?: string;
}

/**
 * Whether a value is a plain object.
 *
 * @param value - Anything
 * @returns True for a non-array object
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether a value is a non-empty string of at most `max` characters.
 *
 * @param value - Anything
 * @param max - Longest accepted length
 * @returns True when usable as an id
 */
function nonEmpty(value: unknown, max = 128): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/**
 * Validate the `data` of a `waiting_action` push. Never throws.
 *
 * @param raw - `IncomingMessage.payload`
 * @returns The push, or null when it is not one
 */
export function parseWaitingActionRelayData(raw: unknown): WaitingActionRelayData | null {
  if (!isRecord(raw)) return null;
  const { actionId, itemId, instanceId, ticketId } = raw;
  if (!nonEmpty(actionId) || !nonEmpty(itemId, 64) || !nonEmpty(instanceId) || !nonEmpty(ticketId)) return null;
  return { v: 1, actionId, itemId, instanceId, ticketId };
}

/**
 * Validate Cloud's answer to the action fetch. Never throws.
 *
 * @param raw - Parsed JSON body (`{success, data}`)
 * @returns The action, or null when the body is not usable
 */
export function parseWaitingActionFetchResponse(raw: unknown): WaitingActionFetchResponse | null {
  const data = isRecord(raw) && isRecord(raw['data']) ? raw['data'] : null;
  if (!data) return null;
  const { actionId, itemId, instanceId, ticketId, kind, reason, state } = data;
  if (!nonEmpty(actionId) || !nonEmpty(itemId, 64) || !nonEmpty(instanceId) || !nonEmpty(ticketId)) return null;
  if (kind !== 'accept' && kind !== 'send_back') return null;
  if (kind === 'send_back' && (typeof reason !== 'string' || reason.trim().length === 0)) return null;
  return {
    actionId,
    itemId,
    instanceId,
    ticketId,
    kind,
    ...(kind === 'send_back' ? { reason: (reason as string).trim() } : {}),
    state: state === 'queued' || state === 'failed' ? state : 'sent',
  };
}

/**
 * Cut text to `max` characters on a character boundary.
 *
 * @param text - Text
 * @param max - Longest length
 * @returns The text, shortened with an ellipsis when needed
 */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${Array.from(text).slice(0, max - 1).join('')}…`;
}

/**
 * Shape one board row in 待验收 for Cloud. Ticket mechanics stay internal
 * (the portal shows the title, the agent's words and who said them).
 *
 * @param row - Board row (`column === 'to_review'`)
 * @param nameOf - Display name of an agent session, when known
 * @returns The upload item
 */
export function toWaitingIngestItem(row: TicketListItem, nameOf?: (session: string) => string | undefined): WaitingIngestItem {
  const agentSession = row.reply?.by ?? row.assignee ?? undefined;
  const agentName = agentSession ? nameOf?.(agentSession) : undefined;
  const excerpt = (row.reply?.excerpt ?? row.description ?? '').trim();
  return {
    ticketId: row.id,
    ...(row.tkt ? { tkt: row.tkt } : {}),
    title: cut(row.title.trim() || row.tkt || row.id, WAITING_SYNC_CONSTANTS.MAX_TITLE_CHARS),
    ...(excerpt ? { excerpt: cut(excerpt, WAITING_SYNC_CONSTANTS.MAX_EXCERPT_CHARS) } : {}),
    ...(agentSession ? { agentSession } : {}),
    ...(agentName ? { agentName } : {}),
    since: row.submittedAt ?? row.updatedAt,
    autoAcceptAt: row.autoAcceptAt,
    rejectCount: row.rejectCount,
    updatedAt: row.updatedAt,
  };
}
