/**
 * Audit log of connector use (issue #969): who used which connection,
 * acting for whom, when, and whether the call was allowed or refused.
 *
 * The owner reads it on Settings › Activity (`connector.use.allowed`,
 * `connector.use.refused`) next to the configuration changes #881 already
 * logs (`connector.access.updated`, `connector.sharing.updated`, …).
 *
 * Refusals are written every time: a role off the allowlist, or Crewly
 * Cloud refusing a grant that is not shared with the person the agent acts
 * for. Allowed uses would flood the log (one Drive search = one call), so an
 * allowed use is written once per actor, connection and person per hour;
 * the entry says so.
 *
 * @module services/connector/connector-use-audit.service
 */

import { ACTIVITY_LOG_CONSTANTS } from '../../constants.js';
import { recordActivity, type ActivityActor, type ActivityEntryInput } from '../activity/activity-log.service.js';
import { currentActor, type Actor } from '../people/acting-for.service.js';

/** Why a call was refused. */
export type ConnectorUseRefusal = 'role_not_allowed' | 'grant_not_shared';

/** One use of a connection. */
export interface ConnectorUseInput {
  /** `google-workspace`, `canva`, `microsoft-todo`, `mcp:<id>`, … */
  connectorId: string;
  /** Who called (the agent, the owner, or Crewly itself) */
  actor: ActivityActor;
  /** The person the call acts for; default the current request's, else none */
  actingFor?: Actor | null;
  /** The route or product used, for the note (`/drive/search`, `gmail`) */
  what?: string;
}

/** A refused use. */
export interface ConnectorUseRefusedInput extends ConnectorUseInput {
  reason: ConnectorUseRefusal;
  /** Roles the owner allowed (`role_not_allowed`) */
  allowedRoles?: string[];
  /** Who authorized the grant (`grant_not_shared`), when Cloud said */
  authorizedBy?: string | null;
}

/** Injectable pieces. */
export interface ConnectorUseAuditDeps {
  record?: (input: ActivityEntryInput) => void;
  now?: () => number;
  /** How long one allowed use stands for later ones (same actor, connection, person) */
  windowMs?: number;
  /** Most actor/connection/person keys remembered before the oldest are dropped */
  maxKeys?: number;
}

/** Action names written. */
export const CONNECTOR_USE_ACTIONS = {
  ALLOWED: 'connector.use.allowed',
  REFUSED: 'connector.use.refused',
} as const;

/**
 * Writes connector uses to the activity log, collapsing allowed uses to one
 * entry per actor, connection and person per window.
 */
export class ConnectorUseAuditService {
  private readonly record: (input: ActivityEntryInput) => void;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  /** Last time an allowed use was written, by `actor|connector|person` */
  private readonly lastAllowed = new Map<string, number>();

  /**
   * @param deps - Writer, clock and limits (defaults: the activity log, `Date.now`, the constants)
   */
  constructor(deps: ConnectorUseAuditDeps = {}) {
    this.record = deps.record ?? recordActivity;
    this.now = deps.now ?? Date.now;
    this.windowMs = deps.windowMs ?? ACTIVITY_LOG_CONSTANTS.USE_ALLOWED_WINDOW_MS;
    this.maxKeys = deps.maxKeys ?? ACTIVITY_LOG_CONSTANTS.USE_KEYS_MAX;
  }

  /**
   * Note an allowed use. Written once per actor, connection and person per
   * window; later uses inside the window are dropped.
   *
   * @param input - The use
   * @returns True when an entry was written
   */
  allowed(input: ConnectorUseInput): boolean {
    const person = input.actingFor === undefined ? currentActor() : input.actingFor;
    const key = `${input.actor.type}:${input.actor.id ?? ''}|${input.connectorId}|${person?.id ?? ''}`;
    const now = this.now();
    const last = this.lastAllowed.get(key);
    if (last !== undefined && now - last < this.windowMs) return false;
    this.remember(key, now);
    const hours = Math.round((this.windowMs / 3_600_000) * 10) / 10;
    const span = hours === 1 ? 'the next hour' : `the next ${hours} hours`;
    this.record({
      actor: input.actor,
      action: CONNECTOR_USE_ACTIONS.ALLOWED,
      target: { type: 'connector', id: input.connectorId },
      after: { ...personFields(person), ...(input.what ? { what: input.what } : {}) },
      note: `${describe(input.actor)} used ${input.connectorId}${person ? ` acting for ${person.name || person.id}` : ''}${input.what ? ` (${input.what})` : ''}; further uses in ${span} are not logged`,
    });
    return true;
  }

  /**
   * Note a refused use. Always written.
   *
   * @param input - The use and why it was refused
   */
  refused(input: ConnectorUseRefusedInput): void {
    const person = input.actingFor === undefined ? currentActor() : input.actingFor;
    const why = input.reason === 'role_not_allowed'
      ? `role ${input.actor.id ? `of ${input.actor.id} ` : ''}is not on the allowlist${input.allowedRoles?.length ? ` (allowed: ${input.allowedRoles.join(', ')})` : ''}`
      : `the grant is not shared with ${person ? person.name || person.id : 'the person this call acts for'}${input.authorizedBy ? ` (authorized by ${input.authorizedBy})` : ''}`;
    this.record({
      actor: input.actor,
      action: CONNECTOR_USE_ACTIONS.REFUSED,
      target: { type: 'connector', id: input.connectorId },
      after: {
        reason: input.reason,
        ...personFields(person),
        ...(input.allowedRoles ? { allowedRoles: input.allowedRoles } : {}),
        ...(input.authorizedBy ? { authorizedBy: input.authorizedBy } : {}),
        ...(input.what ? { what: input.what } : {}),
      },
      note: `${describe(input.actor)} was refused ${input.connectorId}${input.what ? ` (${input.what})` : ''}: ${why}`,
    });
  }

  /** Forget every allowed-use window (tests, owner changed sharing). */
  reset(): void {
    this.lastAllowed.clear();
  }

  /** Remember an allowed use, dropping the oldest keys past the cap. */
  private remember(key: string, at: number): void {
    this.lastAllowed.delete(key);
    this.lastAllowed.set(key, at);
    while (this.lastAllowed.size > this.maxKeys) {
      const oldest = this.lastAllowed.keys().next().value;
      if (oldest === undefined) break;
      this.lastAllowed.delete(oldest);
    }
  }
}

/** The person fields an entry carries. */
function personFields(person: Actor | null): Record<string, unknown> {
  return person ? { actingFor: person.id, actingForRole: person.role } : {};
}

/** "agent a-dev", "the owner", "Crewly (deadline)". */
function describe(actor: ActivityActor): string {
  if (actor.type === 'owner') return 'the owner';
  if (actor.type === 'agent') return `agent ${actor.id ?? '(unknown)'}`;
  return `Crewly${actor.id ? ` (${actor.id})` : ''}`;
}

let instance: ConnectorUseAuditService | null = null;

/**
 * The process-wide audit writer.
 *
 * @returns The service
 */
export function getConnectorUseAudit(): ConnectorUseAuditService {
  if (!instance) instance = new ConnectorUseAuditService();
  return instance;
}

/**
 * Replace the writer in tests (null restores the default).
 *
 * @param service - Replacement
 */
export function setConnectorUseAuditForTesting(service: ConnectorUseAuditService | null): void {
  instance = service;
}
