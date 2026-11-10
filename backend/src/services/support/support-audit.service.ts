/**
 * Activity log of support access (crewly#1558 slice 2).
 *
 * Every call a support grantee makes is written to the instance's Activity
 * log (#881): who (grantee email, account id, grant, role), what (method and
 * path) and the outcome. The owner reads it on Settings › Activity.
 *
 * - Refusals and actions (POST) are written every time.
 * - A successful read repeated by the same grant on the same method and path
 *   is written once per window (`AUDIT_COLLAPSE_WINDOW_MS`); the entry says
 *   so. Paging through one conversation (`?cursor=`) is the same path, so a
 *   scroll is one entry, while reading another conversation is a new one.
 *
 * @module services/support/support-audit.service
 */

import { SUPPORT_ACCESS_CONSTANTS } from '../../constants.js';
import { recordActivity, type ActivityActor, type ActivityEntryInput } from '../activity/activity-log.service.js';
import type { SupportCaller } from './support.types.js';

/** How a support call ended. */
export type SupportOutcome = 'ok' | 'refused' | 'error';

/** One call to audit. */
export interface SupportAuditInput {
  /** The grantee, or null when the envelope itself was unusable */
  caller: SupportCaller | null;
  method: string;
  /** Path relative to `/api` (query kept out of the entry) */
  path: string;
  outcome: SupportOutcome;
  /** HTTP status sent back */
  status: number;
  /** Refusal or error code, when any */
  code?: string;
}

/** Injectable pieces. */
export interface SupportAuditDeps {
  record?: (input: ActivityEntryInput) => void;
  now?: () => number;
  windowMs?: number;
  maxKeys?: number;
}

/**
 * The activity-log actor of a grantee.
 *
 * @param caller - Grantee (null = unknown)
 * @returns Actor `{type: 'support', id: <email or account id>, via: 'support-grant'}`
 */
export function supportActor(caller: SupportCaller | null): ActivityActor {
  const id = caller ? caller.granteeEmail || caller.granteeAccountId : 'unknown';
  return { type: 'support', id, via: SUPPORT_ACCESS_CONSTANTS.ACTOR_VIA };
}

/**
 * Writes support calls to the activity log, collapsing repeated reads.
 */
export class SupportAuditService {
  private readonly record: (input: ActivityEntryInput) => void;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  /** Last time a successful read was written, by `grant|method|pathname` */
  private readonly lastRead = new Map<string, number>();

  /**
   * @param deps - Writer, clock and limits (defaults: the activity log, `Date.now`, the constants)
   */
  constructor(deps: SupportAuditDeps = {}) {
    this.record = deps.record ?? recordActivity;
    this.now = deps.now ?? Date.now;
    this.windowMs = deps.windowMs ?? SUPPORT_ACCESS_CONSTANTS.AUDIT_COLLAPSE_WINDOW_MS;
    this.maxKeys = deps.maxKeys ?? SUPPORT_ACCESS_CONSTANTS.AUDIT_KEYS_MAX;
  }

  /**
   * Note one support call.
   *
   * @param input - The call and its outcome
   * @returns True when an entry was written (false = collapsed into an earlier one)
   */
  note(input: SupportAuditInput): boolean {
    const pathname = input.path.split('?')[0] || input.path;
    const isRead = input.method === 'GET';
    const collapsible = isRead && input.outcome === 'ok' && input.caller !== null;
    const minutes = Math.round(this.windowMs / 60_000);
    if (collapsible) {
      const key = `${input.caller!.grantId}|${input.method}|${pathname}`;
      const now = this.now();
      const last = this.lastRead.get(key);
      if (last !== undefined && now - last < this.windowMs) return false;
      this.remember(key, now);
    }
    const caller = input.caller;
    const action =
      input.outcome !== 'ok'
        ? SUPPORT_ACCESS_CONSTANTS.ACTIONS.REFUSED
        : isRead
          ? SUPPORT_ACCESS_CONSTANTS.ACTIONS.READ
          : SUPPORT_ACCESS_CONSTANTS.ACTIONS.ACTION;
    const who = caller ? caller.granteeEmail || caller.granteeAccountId : 'an unidentified support caller';
    const verb = input.outcome === 'ok' ? (isRead ? 'read' : 'ran') : input.outcome === 'refused' ? 'was refused' : 'failed on';
    this.record({
      actor: supportActor(caller),
      action,
      target: { type: SUPPORT_ACCESS_CONSTANTS.TARGET_TYPE, id: pathname },
      after: {
        method: input.method,
        path: pathname,
        outcome: input.outcome,
        status: input.status,
        ...(input.code ? { code: input.code } : {}),
        ...(caller
          ? {
              granteeEmail: caller.granteeEmail,
              granteeAccountId: caller.granteeAccountId,
              grantId: caller.grantId,
              role: caller.role,
              includePrivate: caller.includePrivate,
            }
          : {}),
      },
      note: `Support (${caller?.role ?? 'unknown role'}) ${who} ${verb} ${input.method} /api${pathname}${input.code ? ` (${input.code})` : ''}${collapsible ? `; the same read in the next ${minutes} minutes is not logged again` : ''}`,
    });
    return true;
  }

  /** Forget every collapse window (tests). */
  reset(): void {
    this.lastRead.clear();
  }

  /** Remember a read, dropping the oldest keys past the cap. */
  private remember(key: string, at: number): void {
    this.lastRead.delete(key);
    this.lastRead.set(key, at);
    while (this.lastRead.size > this.maxKeys) {
      const oldest = this.lastRead.keys().next().value;
      if (oldest === undefined) break;
      this.lastRead.delete(oldest);
    }
  }
}
