/**
 * Support view: what an agent of this account may do with the support
 * access another account gave it (crewly#1558).
 *
 * The local API (`/api/support-view/*`, the `support-view-instance` skill)
 * calls this service. For every call it:
 *
 * 1. refuses when the owner of THIS machine turned agent use of grants off
 *    (`support.allowAgentViews`);
 * 2. refuses a session that is working for someone other than the owner
 *    right now (a grant is given to the account, and what comes back is for
 *    the owner);
 * 3. picks the grant and the machine (the only one, or the one named);
 * 4. sends the read through the {@link SupportClientService};
 * 5. on success, notes the read in the private-source tracker under the
 *    GRANTOR's id (`support:<their email>`): for the next minutes, what the
 *    session writes to a shared place is held for the owner, and memory and
 *    wiki pages it writes are the owner's only;
 * 6. writes the read, allowed or refused, to this machine's Activity log:
 *    which agent, whose account, which machine, what was read, the outcome.
 *    Never the content.
 *
 * `specs/2026-11-12-support-access-agent-read.md`
 *
 * @module services/support/support-view.service
 */

import { PEOPLE_CONSTANTS, SUPPORT_VIEW_CONSTANTS } from '../../constants.js';
import type { ActivityEntryInput } from '../activity/activity-log.service.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { SupportClientService } from './support-client.service.js';
import {
  SupportViewError,
  supportAgentName,
  supportSourcePersonId,
  type SupportRead,
  type SupportViewGrant,
  type SupportViewMachine,
} from './support-client.types.js';

const V = SUPPORT_VIEW_CONSTANTS;
const F = V.FAILURES;

/** Which grant and machine an agent named (both optional). */
export interface SupportViewSelector {
  /** Grant id, or the grantor's email or name */
  grant?: string;
  /** Machine name or instance id */
  machine?: string;
}

/** A grant as the agent sees it (no relay queue ids). */
export interface SupportViewGrantSummary {
  id: string;
  grantorEmail: string;
  grantorName?: string;
  role: string;
  includePrivate: boolean;
  /** `true` / `false` as the grantor set it; `null` when Cloud did not say */
  agentAccess: boolean | null;
  expiresAt?: string;
  machines: Array<{ instanceId: string; deviceName: string; live: boolean; lastSeenAt?: string }>;
  /** Set when the machines could not be listed */
  machinesError?: string;
}

/** The answer of one read. */
export interface SupportViewReadResult {
  grant: { id: string; grantorEmail: string; grantorName?: string; includePrivate: boolean };
  machine: { instanceId: string; deviceName: string };
  data: unknown;
}

/** Collaborators. */
export interface SupportViewDeps {
  client: Pick<SupportClientService, 'listGrants' | 'listMachines' | 'read'>;
  /** `support.allowAgentViews`; a failure to read counts as off */
  allowed: () => Promise<boolean>;
  /** The display name of a session's agent (may hold any characters) */
  displayName: (session: string) => Promise<string | undefined>;
  /** The person a session works for right now */
  actingFor: (session: string) => { id: string; role: string };
  /** Private-source tracker note */
  notePrivate: (session: string, personId: string, connectorId: string) => void;
  /** Activity-log writer */
  record: (input: ActivityEntryInput) => void;
  logger?: Pick<ComponentLogger, 'warn'>;
}

/**
 * Whether a selector is a clean, short value.
 *
 * @param value - What the agent passed
 * @returns The trimmed value, or undefined when none was passed
 * @throws SupportViewError `invalid` when it is too long or holds control characters
 */
function cleanSelector(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (!v) return undefined;
  // eslint-disable-next-line no-control-regex
  if (v.length > V.SELECTOR_MAX_CHARS || /[\u0000-\u001f\u007f]/.test(v)) throw new SupportViewError(F.INVALID, 'That grant or machine name is not accepted.');
  return v;
}

/**
 * How a read is named in the Activity log.
 *
 * @param read - The read
 * @returns e.g. `the agents list`, `messages of conversation slack-C1`
 */
export function describeSupportRead(read: SupportRead): string {
  switch (read.area) {
    case V.AREAS.AGENTS:
      return 'the agents list';
    case V.AREAS.CONVERSATIONS:
      return 'the conversations list';
    case V.AREAS.ERRORS:
      return 'recent errors';
    case V.AREAS.MESSAGES:
      return `messages of conversation ${String(read.conversationId).slice(0, V.SELECTOR_MAX_CHARS)}`;
    default:
      return 'something';
  }
}

/**
 * The policy around support reads by agents.
 */
export class SupportViewService {
  private readonly logger: Pick<ComponentLogger, 'warn'>;

  /**
   * @param deps - Collaborators
   */
  constructor(private readonly deps: SupportViewDeps) {
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('SupportView');
  }

  /**
   * The grants this account received, with the machines of each.
   *
   * @param session - Calling agent session
   * @returns Grants (machines without their relay queue ids)
   * @throws SupportViewError `turned_off_here`, `owner_only`, `not_connected`
   */
  async grants(session: string): Promise<SupportViewGrantSummary[]> {
    await this.gate(session);
    const grants = await this.deps.client.listGrants();
    const out: SupportViewGrantSummary[] = [];
    for (const grant of grants) {
      let machines: SupportViewMachine[] = [];
      let machinesError: string | undefined;
      try {
        machines = await this.deps.client.listMachines(grant.id);
      } catch (error) {
        machinesError = error instanceof SupportViewError ? error.message : 'The machines could not be listed.';
      }
      out.push({
        id: grant.id,
        grantorEmail: grant.grantorEmail,
        ...(grant.grantorName ? { grantorName: grant.grantorName } : {}),
        role: grant.role,
        includePrivate: grant.includePrivate,
        agentAccess: grant.agentAccess ?? null,
        ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
        machines: machines.map((m) => ({ instanceId: m.instanceId, deviceName: m.deviceName, live: m.live, ...(m.lastSeenAt ? { lastSeenAt: m.lastSeenAt } : {}) })),
        ...(machinesError ? { machinesError } : {}),
      });
    }
    return out;
  }

  /**
   * Read one thing from a granted machine for an agent.
   *
   * @param session - Calling agent session
   * @param selector - The grant and machine named, when any
   * @param read - What to read
   * @returns The grant and machine used and the granted machine's data
   * @throws SupportViewError with the failure (already written to the Activity log)
   */
  async read(session: string, selector: SupportViewSelector, read: SupportRead): Promise<SupportViewReadResult> {
    const agentName = supportAgentName(await this.deps.displayName(session).catch(() => undefined), session);
    let grant: SupportViewGrant | null = null;
    let machine: SupportViewMachine | null = null;
    try {
      await this.gate(session);
      grant = this.pickGrant(await this.deps.client.listGrants(), cleanSelector(selector.grant));
      if (grant.agentAccess === false) throw new SupportViewError(F.AGENT_ACCESS_OFF);
      machine = this.pickMachine(await this.deps.client.listMachines(grant.id), cleanSelector(selector.machine));
      const data = await this.deps.client.read(machine, read, agentName);
      // What this session read is the other account's data: keep what it writes next private.
      try {
        this.deps.notePrivate(session, supportSourcePersonId(grant), V.PRIVATE_SOURCE_CONNECTOR);
      } catch (error) {
        this.logger.warn('Support read could not be noted as a private source', { error: error instanceof Error ? error.message : String(error) });
      }
      this.audit(session, agentName, grant, machine, read, null);
      return {
        grant: { id: grant.id, grantorEmail: grant.grantorEmail, ...(grant.grantorName ? { grantorName: grant.grantorName } : {}), includePrivate: grant.includePrivate },
        machine: { instanceId: machine.instanceId, deviceName: machine.deviceName },
        data,
      };
    } catch (error) {
      const failure = error instanceof SupportViewError ? error : new SupportViewError(F.FAILED);
      if (!(error instanceof SupportViewError)) {
        this.logger.warn('Support read failed unexpectedly', { error: error instanceof Error ? error.message : String(error) });
      }
      this.audit(session, agentName, grant, machine, read, failure);
      throw failure;
    }
  }

  /**
   * The checks every call passes first.
   *
   * @param session - Calling agent session
   * @throws SupportViewError `turned_off_here` or `owner_only`
   */
  private async gate(session: string): Promise<void> {
    let allowed = false;
    try {
      allowed = await this.deps.allowed();
    } catch {
      allowed = false;
    }
    if (!allowed) throw new SupportViewError(F.TURNED_OFF_HERE);
    let actor: { id: string; role: string } | null = null;
    try {
      actor = this.deps.actingFor(session);
    } catch {
      actor = null;
    }
    if (!actor || actor.id !== PEOPLE_CONSTANTS.OWNER_ID) throw new SupportViewError(F.OWNER_ONLY);
  }

  /**
   * The grant to use.
   *
   * @param grants - Active received grants
   * @param named - What the agent named (grant id, grantor email or name)
   * @returns The grant
   * @throws SupportViewError `access_ended` (none / no match) or `choose` (several)
   */
  private pickGrant(grants: SupportViewGrant[], named: string | undefined): SupportViewGrant {
    if (grants.length === 0) throw new SupportViewError(F.ACCESS_ENDED, 'No account has given this account support access right now.');
    const label = (g: SupportViewGrant): string => `${g.grantorEmail || g.id} (grant ${g.id})`;
    if (!named) {
      if (grants.length === 1) return grants[0];
      throw new SupportViewError(F.CHOOSE, 'More than one account gave support access. Name one with --grant.', grants.map(label));
    }
    const wanted = named.toLowerCase();
    const matches = grants.filter((g) => g.id === named || g.grantorEmail === wanted || (g.grantorName ?? '').toLowerCase() === wanted);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new SupportViewError(F.CHOOSE, 'More than one grant matches. Name it by its grant id.', matches.map(label));
    throw new SupportViewError(F.ACCESS_ENDED, `No active support access matches "${named}".`, grants.map(label));
  }

  /**
   * The machine to read.
   *
   * @param machines - Machines the grant reaches
   * @param named - What the agent named (machine name or instance id)
   * @returns The machine
   * @throws SupportViewError `offline` (none), `not_found` (no match) or `choose` (several)
   */
  private pickMachine(machines: SupportViewMachine[], named: string | undefined): SupportViewMachine {
    if (machines.length === 0) throw new SupportViewError(F.OFFLINE, 'That account has no machine this access reaches right now.');
    const label = (m: SupportViewMachine): string => `${m.deviceName} (${m.live ? 'online' : 'offline'}, id ${m.instanceId})`;
    if (!named) {
      if (machines.length === 1) return machines[0];
      throw new SupportViewError(F.CHOOSE, 'That account has more than one machine. Name one with --machine.', machines.map(label));
    }
    const wanted = named.toLowerCase();
    const matches = machines.filter((m) => m.instanceId === named || m.deviceName.toLowerCase() === wanted);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new SupportViewError(F.CHOOSE, 'More than one machine has that name. Name it by its id.', matches.map(label));
    throw new SupportViewError(F.NOT_FOUND, `No machine matches "${named}".`, machines.map(label));
  }

  /**
   * Write one read to this machine's Activity log (never its content).
   *
   * @param session - Calling agent session
   * @param agentName - Name sent to the other machine
   * @param grant - Grant used, when one was picked
   * @param machine - Machine read, when one was picked
   * @param read - What was asked for
   * @param failure - Why it failed, or null when it worked
   */
  private audit(
    session: string,
    agentName: string,
    grant: SupportViewGrant | null,
    machine: SupportViewMachine | null,
    read: SupportRead,
    failure: SupportViewError | null,
  ): void {
    const what = describeSupportRead(read);
    const whose = grant ? grant.grantorEmail || `grant ${grant.id}` : 'another account';
    const where = machine ? ` on ${machine.deviceName}` : '';
    try {
      this.deps.record({
        actor: { type: 'agent', id: session, via: V.ACTOR_VIA },
        action: failure ? V.ACTIONS.REFUSED : V.ACTIONS.READ,
        target: { type: V.TARGET_TYPE, id: grant?.id ?? 'none' },
        after: {
          agent: agentName,
          area: read.area,
          ...(read.area === V.AREAS.MESSAGES ? { conversationId: String(read.conversationId).slice(0, V.SELECTOR_MAX_CHARS) } : {}),
          outcome: failure ? failure.code : 'ok',
          ...(grant ? { grantId: grant.id, grantorEmail: grant.grantorEmail, role: grant.role, includePrivate: grant.includePrivate } : {}),
          ...(machine ? { machine: machine.deviceName, instanceId: machine.instanceId } : {}),
        },
        note: failure
          ? `Agent ${agentName} (${session}) could not read ${what}${where} of ${whose} through support access: ${failure.code}`
          : `Agent ${agentName} (${session}) read ${what}${where} of ${whose} through support access`,
      });
    } catch (error) {
      this.logger.warn('Support read could not be written to the Activity log', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
