/**
 * Colleague message — wire format and shared types.
 *
 * One agent writes to another agent of the same Crewly account, on any
 * machine (`message-colleague` skill). Between machines the message travels
 * as a `colleague_message` over the Cloud relay queue (the same
 * store-and-forward queue as every other cross-machine message).
 *
 * @module services/colleague/colleague-message.types
 */

import { COLLEAGUE_MESSAGE_CONSTANTS } from '../../constants.js';

/** Who sent a colleague message, as the receiving machine learns it. */
export interface ColleagueSender {
  /** Cloud instance id (device id) of the sending machine */
  instanceId: string;
  /** Device name of the sending machine, e.g. `iriss-air.lan` */
  deviceName: string;
  /** Agent session of the sender (the reply address on that machine) */
  session: string;
  /** Display name of the sender, e.g. `Fern` */
  name: string;
  /** Team of the sender, when it has one */
  team?: string;
}

/** What goes over the relay between machines. */
export interface ColleagueWireMessage {
  /** Wire version */
  v: typeof COLLEAGUE_MESSAGE_CONSTANTS.WIRE_VERSION;
  /** Message id (idempotency key, and what a reply points at) */
  id: string;
  from: ColleagueSender;
  /** Agent session on the receiving machine */
  toSession: string;
  /** Display name the sender used for the recipient (for the record) */
  toName?: string;
  /** The text */
  text: string;
  /** Id of the colleague message this answers */
  replyTo?: string;
  /** ISO time the sender wrote it */
  sentAt: string;
}

/**
 * Whether an unknown value is a well-formed {@link ColleagueWireMessage}.
 *
 * @param value - Parsed relay payload
 * @returns True when every required field has the right shape
 */
export function isColleagueWireMessage(value: unknown): value is ColleagueWireMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  const from = m.from as Record<string, unknown> | undefined;
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  return (
    m.v === COLLEAGUE_MESSAGE_CONSTANTS.WIRE_VERSION &&
    str(m.id) &&
    str(m.toSession) &&
    str(m.text) &&
    str(m.sentAt) &&
    typeof from === 'object' &&
    from !== null &&
    str(from.instanceId) &&
    str(from.deviceName) &&
    str(from.session) &&
    str(from.name) &&
    (from.team === undefined || typeof from.team === 'string') &&
    (m.replyTo === undefined || typeof m.replyTo === 'string')
  );
}

/** Why a send did not go through. */
export type ColleagueSendErrorCode =
  | 'invalid'
  | 'not_found'
  | 'ambiguous'
  | 'self'
  | 'loop_cap'
  | 'cloud_unavailable'
  | 'machine_unknown'
  | 'send_failed'
  | 'delivery_failed';

/** Outcome of a send (also the HTTP body of `POST /api/colleagues/message`). */
export interface ColleagueSendResult {
  success: boolean;
  /** Message id (what the colleague's reply points at) */
  messageId?: string;
  /** `local` = delivered on this machine, `remote` = handed to the relay for another machine */
  route?: 'local' | 'remote';
  /** The colleague as resolved */
  to?: { name: string; team: string | null; machine: string | null; session: string };
  /** Local delivery: the agent was down, the message is queued and the agent is being started */
  queued?: boolean;
  /** Plain-language outcome for the agent that called */
  note?: string;
  code?: ColleagueSendErrorCode;
  error?: string;
  /** Candidates for `not_found` / `ambiguous` */
  candidates?: Array<{ name: string; team: string | null; machine: string | null; session: string | null }>;
}
