/**
 * Drive mode wire shapes, machine half (mirrors crewly-services
 * `auth/src/drive/drive.contract.ts`). Pure.
 *
 * Cloud → machine: relay `talk_message` with `{v:1, kind:'drive', op,
 * sessionId, id?, instanceId}` — ids only. The machine then fetches, with its
 * own Cloud token:
 *   GET  /api/cloud/talk/session/:sid/machine/deliveries/:id?instanceId=  → the owner's words
 *   GET  /api/cloud/talk/session/:sid/machine/state?instanceId=          → its conversations (after `end`)
 *   GET  /api/cloud/talk/session/:sid/machine/recalls/:id?instanceId=     → what to recall
 *   POST /api/cloud/talk/session/:sid/machine/recalls/:id {instanceId, messages}
 *   (`op:'warm'` → `machine/state` also lists the agents to keep warm, with `warmUntil`)
 * Machine → Cloud (an agent's `reply --drive`):
 *   POST /api/cloud/talk/session/:sid/replies {instanceId, conversationId, agentSession, text, interim?, ack?, recap?, nextStep?}
 * Machine → Cloud (its status snapshot, specs/2026-10-09-drive-mode-v3.md):
 *   PUT  /api/cloud/instances/:instanceId/briefing {snapshot}
 *
 * @module services/drive/drive-cloud.contract
 */

import { DRIVE_CONSTANTS } from '../../constants.js';

/** What the owner can talk to. */
export type DriveTargetKind = 'agent' | 'team' | 'channel';

/** A Drive mode push. */
export interface DriveRelayData {
  v: 1;
  kind: 'drive';
  op: 'deliver' | 'end' | 'recall' | 'warm' | 'refresh';
  sessionId: string;
  id?: string;
  instanceId: string;
}

/** The owner's words, as Cloud hands them to the machine. */
export interface DriveDeliveryFetch {
  id: string;
  sessionId: string;
  conversationId: string;
  target: { kind: DriveTargetKind; name: string; agentSession: string; team?: string; slackChannelId?: string; members?: string[] };
  text: string;
}

/** A recall request. */
export interface DriveRecallFetch {
  agentSessions: string[];
  hint?: string;
  slackChannelId?: string;
}

/** The machine's part of a session. */
export interface DriveStateFetch {
  ended: boolean;
  conversations: Array<{ conversationId: string; agentSession: string }>;
  /** Agents to keep warm while the session runs (v3) */
  warm: string[];
  /** Until when (ms); 0 when nothing is warm */
  warmUntil: number;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/**
 * A Drive mode relay payload, or null (any other `talk_message`).
 *
 * @param payload - Relay payload
 * @returns Data or null
 */
export function parseDriveRelayData(payload: unknown): DriveRelayData | null {
  const p = obj(payload);
  if (!p || p['kind'] !== DRIVE_CONSTANTS.RELAY_KIND || p['v'] !== 1) return null;
  const op = p['op'];
  const sessionId = str(p['sessionId']);
  const instanceId = str(p['instanceId']);
  if ((op !== 'deliver' && op !== 'end' && op !== 'recall' && op !== 'warm' && op !== 'refresh') || !sessionId || !DRIVE_CONSTANTS.SESSION_ID_PATTERN.test(sessionId) || !instanceId) return null;
  const id = str(p['id']);
  if ((op === 'deliver' || op === 'recall' || op === 'refresh') && !id) return null;
  return { v: 1, kind: 'drive', op, sessionId, instanceId, ...(id ? { id } : {}) };
}

/**
 * Whether a relay payload is Drive mode's (so the Talk handler leaves it alone).
 *
 * @param payload - Relay payload
 * @returns True for `kind: 'drive'`
 */
export function isDrivePayload(payload: unknown): boolean {
  return obj(payload)?.['kind'] === DRIVE_CONSTANTS.RELAY_KIND;
}

/**
 * Cloud's delivery answer, or null.
 *
 * @param data - `data` of the response
 * @returns Delivery or null
 */
export function parseDeliveryFetch(data: unknown): DriveDeliveryFetch | null {
  const d = obj(data);
  const t = obj(d?.['target']);
  if (!d || !t) return null;
  const kind = t['kind'];
  const id = str(d['id']);
  const sessionId = str(d['sessionId']);
  const conversationId = str(d['conversationId']);
  const text = str(d['text']);
  const agentSession = str(t['agentSession']);
  if ((kind !== 'agent' && kind !== 'team' && kind !== 'channel') || !id || !sessionId || !conversationId || !text || !agentSession) return null;
  const members = Array.isArray(t['members']) ? (t['members'] as unknown[]).filter((m): m is string => typeof m === 'string') : undefined;
  return {
    id,
    sessionId,
    conversationId,
    text,
    target: {
      kind,
      name: str(t['name']) ?? agentSession,
      agentSession,
      ...(str(t['team']) ? { team: t['team'] as string } : {}),
      ...(str(t['slackChannelId']) ? { slackChannelId: t['slackChannelId'] as string } : {}),
      ...(members ? { members } : {}),
    },
  };
}

/**
 * Cloud's recall request, or null.
 *
 * @param data - `data` of the response
 * @returns Request or null
 */
export function parseRecallFetch(data: unknown): DriveRecallFetch | null {
  const d = obj(data);
  const sessions = Array.isArray(d?.['agentSessions']) ? (d?.['agentSessions'] as unknown[]).filter((s): s is string => typeof s === 'string' && !!s) : [];
  if (!d || sessions.length === 0) return null;
  return { agentSessions: sessions, ...(str(d['hint']) ? { hint: d['hint'] as string } : {}), ...(str(d['slackChannelId']) ? { slackChannelId: d['slackChannelId'] as string } : {}) };
}

/**
 * Cloud's session state for this machine, or null.
 *
 * @param data - `data` of the response
 * @returns State or null
 */
export function parseStateFetch(data: unknown): DriveStateFetch | null {
  const d = obj(data);
  if (!d || !Array.isArray(d['conversations'])) return null;
  const conversations = (d['conversations'] as unknown[])
    .map(obj)
    .filter((c): c is Record<string, unknown> => !!c && !!str(c['conversationId']) && !!str(c['agentSession']))
    .map((c) => ({ conversationId: c['conversationId'] as string, agentSession: c['agentSession'] as string }));
  const warm = Array.isArray(d['warm']) ? (d['warm'] as unknown[]).filter((s): s is string => typeof s === 'string' && !!s.trim()).slice(0, DRIVE_CONSTANTS.MAX_WARM) : [];
  const until = typeof d['warmUntil'] === 'string' ? Date.parse(d['warmUntil']) : NaN;
  return { ended: d['ended'] === true, conversations, warm, warmUntil: warm.length && Number.isFinite(until) ? until : 0 };
}
