/**
 * TempMemberService — temporary members and permanent seat requests
 * (specs/2026-11-26-temp-members-seat-requests.md).
 *
 * When a team has more work than hands, its lead must not do everything
 * alone. Two ways out:
 *
 * 1. `add-temp-member`: the lead adds a TEMPORARY member itself, within the
 *    team's temporary headcount (`Team.tempHeadcount`, owner-only). The member
 *    is created through the normal add-member path, starts when it is assigned
 *    work, and is removed automatically once its work is accepted or it sits
 *    unused. The lead can also remove it early (`remove-temp-member`).
 * 2. `request-seat`: the lead asks the owner for a PERMANENT seat. One owner
 *    card (Approve / Not now) carries the reason and the evidence. On Approve
 *    a live temporary member of that role becomes permanent, else a new
 *    member is added.
 *
 * Every creation, removal and conversion is written to the history file
 * (`temp-members.json`), which is where the card's evidence and the daily
 * digest line come from.
 *
 * @module services/temp-members/temp-member.service
 */

import { TEMP_MEMBER_CONSTANTS } from '../../constants.js';
import type { Team, TeamMember, TemporaryMemberInfo } from '../../types/index.js';
import type { DecisionOption, OwnerDecision } from '../../types/decision.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { memberAgentId } from '../../utils/member-session-name.utils.js';
import { getTeamLeads, isTeamLead } from '../../utils/team.utils.js';
import type { DecisionKindHandler, PrebuiltAsk } from '../decisions/decision.service.js';
import type { SeatRequest, TempMemberEvent, TempMemberStore } from './temp-member.store.js';

const C = TEMP_MEMBER_CONSTANTS;
const E = C.ERRORS;
const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE: readonly string[] = C.LIVE_WORK_STATUSES;
const SETTLED: readonly string[] = C.SETTLED_WORK_STATUSES;
/** Work reported done that the lead has not accepted yet: the member is kept for a possible send-back. */
const AWAITING_REVIEW = 'done_by_worker';

/** A refusal with an HTTP status and a code the skill can show. */
export class TempMemberError extends Error {
  /**
   * @param status - HTTP status
   * @param code - One of `TEMP_MEMBER_CONSTANTS.ERRORS`
   * @param message - Plain-English message the lead can act on
   */
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'TempMemberError';
  }
}

/** The slice of the decision service used here. */
export interface SeatDecisions {
  askPrebuilt(ask: PrebuiltAsk): Promise<OwnerDecision>;
  get(id: string): Promise<OwnerDecision | null>;
}

/** Logger slice. */
export interface TempMemberLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

/** What the normal add-member path needs for a new member. */
export interface NewMemberInput {
  name: string;
  role: string;
  /** Present for a temporary member */
  temporary?: TemporaryMemberInfo;
  /** The lead it reports to, on a team with a hierarchy */
  parentMemberId?: string;
}

/** Collaborators. */
export interface TempMemberDeps {
  store: TempMemberStore;
  getTeams: () => Promise<Team[]>;
  /** Add a member through the normal add-member path (the team is saved) */
  addMember: (teamId: string, input: NewMemberInput) => Promise<TeamMember>;
  /** Stop the member's session and remove it through the normal remove path (the team is saved) */
  removeMember: (teamId: string, memberId: string) => Promise<boolean>;
  /** Save a team (used when a temporary member becomes permanent) */
  saveTeam: (team: Team) => Promise<void>;
  /** Names of the roles a member can have */
  knownRoles: () => Promise<string[]>;
  /** Whether the machine is in memory-pressure mode (no new agents then) */
  underMemoryPressure: () => boolean;
  workItems: () => Promise<WorkItem[]>;
  /** Whether a session is mid-turn (unknown reads as busy) */
  isBusy: (session: string) => Promise<boolean>;
  /** When a session last printed (epoch ms), or null when unknown / never */
  lastActivityAt?: (session: string) => number | null;
  /** "No member fits" records of a team's leads since a time */
  noMemberFitsCount: (teamId: string, leadSessions: string[], sinceMs: number) => number;
  /** The decision service, once it runs */
  decisions: () => SeatDecisions | null;
  /** Deliver a message to an agent (wakes a stopped one) */
  deliverToAgent: (session: string, text: string) => Promise<boolean>;
  /** The team's Slack channel (the card goes there top-level), or null */
  teamChannelOf?: (teamId: string) => Promise<string | null>;
  /** The owner's language (default English); the seat card is written in it */
  ownerLanguage?: () => Promise<'en' | 'zh' | null>;
  /** Absolute path of the team-leader skills */
  tlSkillsPath: string;
  now?: () => Date;
  logger?: TempMemberLogger;
}

/** `add-temp-member` input. */
export interface AddTempInput {
  role?: unknown;
  reason?: unknown;
  name?: unknown;
  workItemId?: unknown;
}

/** `remove-temp-member` input. */
export interface RemoveTempInput {
  /** Member id, name or session */
  member?: unknown;
  reason?: unknown;
  /** Remove although it is mid-turn or holds work */
  force?: unknown;
}

/** `request-seat` input. */
export interface SeatRequestInput {
  role?: unknown;
  reason?: unknown;
  name?: unknown;
}

/** One temporary member in a status view. */
export interface TempMemberView {
  id: string;
  name: string;
  role: string;
  /** Agent id: what `delegate-task --to` takes */
  sessionName: string;
  temporary: TemporaryMemberInfo;
}

/** A team's temporary headcount and who uses it. */
export interface TempStatusView {
  teamId: string;
  headcount: { used: number; limit: number };
  members: TempMemberView[];
}

/** What one tick did. */
export interface TempTickResult {
  removed: Array<{ teamId: string; memberId: string; name: string; why: string }>;
  /** Members left alone because they are mid-turn or hold work */
  kept: number;
}

/** A lead and its team. */
interface LeadContext {
  team: Team;
  lead: TeamMember;
}

/**
 * How many temporary members a team may have at the same time.
 *
 * @param team - Team
 * @returns `Team.tempHeadcount` when it is a valid number, else the default
 *
 * @example
 * ```typescript
 * tempHeadcountOf({});                  // 2
 * tempHeadcountOf({ tempHeadcount: 0 }); // 0 — the lead cannot add any
 * ```
 */
export function tempHeadcountOf(team: Pick<Team, 'tempHeadcount'>): number {
  const n = team.tempHeadcount;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return C.DEFAULT_HEADCOUNT;
  return Math.min(n, C.MAX_HEADCOUNT);
}

/**
 * Validate a headcount the owner typed.
 *
 * @param value - Raw value (`null` restores the default)
 * @returns `{ ok, value }` (`undefined` = unset) or `{ ok: false, error }`
 */
export function parseTempHeadcount(value: unknown): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (value === null) return { ok: true, value: undefined };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > C.MAX_HEADCOUNT) {
    return { ok: false, error: `tempHeadcount is a whole number from 0 to ${C.MAX_HEADCOUNT} (0 = no temporary members)` };
  }
  return { ok: true, value };
}

/**
 * The temporary members of a team.
 *
 * @param team - Team
 * @returns Members carrying a `temporary` record
 */
export function temporaryMembersOf(team: Pick<Team, 'members'>): TeamMember[] {
  return (team.members ?? []).filter((m) => !!m.temporary);
}

/**
 * Temporary members opened and removed per team since a time (digest line).
 *
 * @param events - History lines
 * @param sinceMs - Lower bound (epoch ms)
 * @returns Team id → counts (teams with neither are absent)
 */
export function tempCountsByTeam(events: readonly TempMemberEvent[], sinceMs: number): Map<string, { opened: number; removed: number }> {
  const out = new Map<string, { opened: number; removed: number }>();
  for (const e of events) {
    if ((Date.parse(e.at) || 0) < sinceMs || e.type === 'converted') continue;
    const row = out.get(e.teamId) ?? { opened: 0, removed: 0 };
    if (e.type === 'created') row.opened += 1;
    else row.removed += 1;
    out.set(e.teamId, row);
  }
  return out;
}

function oneLine(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function sessionOf(team: Team, m: TeamMember): string {
  return memberAgentId(team.name, m);
}

/** `frontend-developer` → `Frontend-Developer`. */
function roleLabel(role: string): string {
  return role
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('-');
}

function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** When a work item last moved (epoch ms). */
function endOf(wi: WorkItem): number {
  return Date.parse(wi.completedAt ?? wi.statusChangedAt ?? wi.startedAt ?? wi.createdAt) || 0;
}

/** Service. */
export class TempMemberService implements DecisionKindHandler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  /** Adds, removals and seat requests run one after another, so the headcount cannot be overrun. */
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * @param deps - Collaborators
   */
  constructor(private readonly deps: TempMemberDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** Start the removal tick. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((err) => this.deps.logger?.warn('Temp member tick failed', { error: String(err) })), C.TICK_MS);
    this.timer.unref?.();
  }

  /** Stop the tick. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Run `work` after the operations already queued.
   *
   * @param work - Operation
   * @returns Its result
   */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async team(teamId: string): Promise<Team> {
    const team = (await this.deps.getTeams()).find((t) => t.id === teamId);
    if (!team) throw new TempMemberError(404, E.TEAM_NOT_FOUND, 'Team not found');
    return team;
  }

  /**
   * The calling lead and its team; refuses anyone who does not lead THIS team.
   *
   * @param callerSession - The calling agent's session
   * @param teamId - Team id
   * @param doing - What only a lead may do (for the message)
   * @returns Lead context
   * @throws TempMemberError 404 unknown team, 403 not a lead of it
   */
  private async leadContext(callerSession: string | undefined, teamId: string, doing: string): Promise<LeadContext> {
    const team = await this.team(teamId);
    const me = callerSession ? (team.members ?? []).find((m) => m.sessionName === callerSession || m.agentId === callerSession || sessionOf(team, m) === callerSession) : undefined;
    if (!me || !isTeamLead(team, me)) {
      throw new TempMemberError(403, E.NOT_LEAD, `Only a lead of ${team.name} can ${doing}. ${callerSession ? `${callerSession} does not lead this team.` : 'This call carries no agent identity.'}`);
    }
    return { team, lead: me };
  }

  /**
   * A role name the team can use, or a refusal.
   *
   * @param raw - What the lead typed
   * @returns The role name
   * @throws TempMemberError 400 unknown / not allowed
   */
  private async role(raw: unknown): Promise<string> {
    const role = oneLine(raw, 60).toLowerCase();
    const known = (await this.deps.knownRoles()).filter((r) => !(C.REFUSED_ROLES as readonly string[]).includes(r));
    if (!role) throw new TempMemberError(400, E.UNKNOWN_ROLE, `role is required. Known roles: ${known.join(', ')}`);
    if ((C.REFUSED_ROLES as readonly string[]).includes(role)) {
      throw new TempMemberError(400, E.ROLE_NOT_ALLOWED, `A ${role} cannot be added this way: leads and the orchestrator are set by the owner. Pick a working role: ${known.join(', ')}`);
    }
    if (!known.includes(role)) throw new TempMemberError(400, E.UNKNOWN_ROLE, `"${role}" is not a known role. Known roles: ${known.join(', ')}`);
    return role;
  }

  private reason(raw: unknown, what: string): string {
    const reason = oneLine(raw, C.MAX_REASON_CHARS);
    if (!reason) throw new TempMemberError(400, E.REASON_REQUIRED, `reason is required: ${what}`);
    return reason;
  }

  private skill(name: string): string {
    return `bash ${this.deps.tlSkillsPath}/${name}/execute.sh`;
  }

  /**
   * A name nobody on the team has: `<prefix-><Role>-<n>`.
   *
   * @param team - Team
   * @param role - Role name
   * @param start - First number to try
   * @param prefix - Name prefix (`Temp` for temporary members)
   * @returns Unique name
   */
  private freeName(team: Team, role: string, start: number, prefix?: string): string {
    const taken = new Set((team.members ?? []).map((m) => m.name.toLowerCase()));
    const base = `${prefix ? `${prefix}-` : ''}${roleLabel(role)}`;
    for (let n = Math.max(1, start); ; n += 1) {
      const name = `${base}-${n}`;
      if (!taken.has(name.toLowerCase())) return name;
    }
  }

  private requestedName(team: Team, raw: unknown): string | null {
    const name = oneLine(raw, C.MAX_NAME_CHARS);
    if (!name) return null;
    if ((team.members ?? []).some((m) => m.name.toLowerCase() === name.toLowerCase())) {
      throw new TempMemberError(409, E.NAME_TAKEN, `${team.name} already has a member named ${name}. Pick another name, or leave --name out.`);
    }
    return name;
  }

  private view(team: Team, m: TeamMember): TempMemberView {
    return { id: m.id, name: m.name, role: m.role, sessionName: sessionOf(team, m), temporary: m.temporary! };
  }

  // ------------------------------------------------------------------ status

  /**
   * A team's temporary headcount and its temporary members.
   *
   * @param teamId - Team id
   * @returns View
   * @throws TempMemberError 404 unknown team
   */
  async status(teamId: string): Promise<TempStatusView> {
    const team = await this.team(teamId);
    const members = temporaryMembersOf(team);
    return { teamId, headcount: { used: members.length, limit: tempHeadcountOf(team) }, members: members.map((m) => this.view(team, m)) };
  }

  // --------------------------------------------------------------------- add

  /**
   * `add-temp-member`: a lead adds a temporary member to its own team.
   *
   * @param callerSession - The calling agent (must lead the team)
   * @param teamId - Team id
   * @param input - role, reason, optional name and work item
   * @returns The new member, the headcount and what to do next
   * @throws TempMemberError 400 bad input, 403 not a lead, 409 headcount full / off / memory pressure / name taken
   */
  addTemp(callerSession: string | undefined, teamId: string, input: AddTempInput): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      const { team, lead } = await this.leadContext(callerSession, teamId, 'add a temporary member');
      const role = await this.role(input.role);
      const reason = this.reason(input.reason, 'why the team needs one more pair of hands now');
      const seat = `${this.skill('request-seat')} --role ${role} --reason "<why>"`;
      const limit = tempHeadcountOf(team);
      const current = temporaryMembersOf(team);
      if (limit === 0) {
        throw new TempMemberError(409, E.HEADCOUNT_DISABLED, `${team.name} has no temporary headcount (the owner set it to 0), so you cannot add a temporary member. Ask the owner for a permanent seat instead: ${seat}`);
      }
      if (current.length >= limit) {
        const names = current.map((m) => `${m.name} (${m.role})`).join(', ');
        throw new TempMemberError(
          409,
          E.HEADCOUNT_FULL,
          `${team.name}'s temporary headcount is used up (${current.length} of ${limit}: ${names}). Give the work to one of them, remove one that is done (${this.skill('remove-temp-member')} --member "<name>"), or ask the owner for a permanent seat: ${seat}`,
        );
      }
      if (this.deps.underMemoryPressure()) {
        throw new TempMemberError(409, E.MEMORY_PRESSURE, `This machine is short of memory right now, so no new agent can be added. Wait until a member finishes and try again; if the team is short of hands every time, ask the owner for a permanent seat: ${seat}`);
      }
      const workItemId = oneLine(input.workItemId, 200);
      const history = await this.deps.store.events();
      const sameRole = history.filter((e) => e.type === 'created' && e.teamId === team.id && e.role === role);
      const name = this.requestedName(team, input.name) ?? this.freeName(team, role, sameRole.length + 1, C.NAME_PREFIX);
      const at = this.now();
      const temporary: TemporaryMemberInfo = {
        createdBy: sessionOf(team, lead),
        createdAt: at.toISOString(),
        reason,
        ...(workItemId ? { workItemId } : {}),
        expiresAt: new Date(at.getTime() + C.MAX_AGE_MS).toISOString(),
      };
      const member = await this.deps.addMember(team.id, { name, role, temporary, ...(reportsTo(team, lead) ? { parentMemberId: lead.id } : {}) });
      const session = memberAgentId(team.name, member);
      await this.deps.store.record({
        type: 'created',
        at: at.toISOString(),
        teamId: team.id,
        teamName: team.name,
        memberId: member.id,
        memberName: member.name,
        session,
        role,
        reason,
        by: temporary.createdBy,
        ...(workItemId ? { workItemId } : {}),
      });
      this.deps.logger?.info('Temporary member added', { teamId: team.id, member: member.name, role, by: temporary.createdBy });
      const since = at.getTime() - C.EVIDENCE_WINDOW_DAYS * DAY_MS;
      const recent = sameRole.filter((e) => Date.parse(e.at) >= since).length + 1;
      const repeat =
        recent >= C.REPEAT_THRESHOLD
          ? `This is the ${ordinal(recent)} temporary ${role} on ${team.name} in ${C.EVIDENCE_WINDOW_DAYS} days: this need keeps coming back. Ask the owner for a permanent seat: ${seat}`
          : null;
      return {
        member: { id: member.id, name: member.name, role, sessionName: session, agentId: session },
        temporary,
        headcount: { used: current.length + 1, limit },
        delegate: `${this.skill('delegate-task')} --to ${session} --task "<the work>"`,
        note: `${member.name} is on the team as a temporary ${role}. It starts when you assign it work (delegate-task --to ${session}). It is removed automatically when its work is accepted or after it sits unused.`,
        ...(repeat ? { hint: repeat } : {}),
      };
    });
  }

  // ------------------------------------------------------------------ remove

  /**
   * `remove-temp-member`: a lead removes one of its temporary members early.
   *
   * @param callerSession - The calling agent (must lead the team)
   * @param teamId - Team id
   * @param input - member (id, name or session), optional reason, force
   * @returns What was removed
   * @throws TempMemberError 403 not a lead, 404 no such member, 409 not temporary / busy
   */
  removeTemp(callerSession: string | undefined, teamId: string, input: RemoveTempInput): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      const { team, lead } = await this.leadContext(callerSession, teamId, 'remove a temporary member');
      const ref = oneLine(input.member, 200);
      const lower = ref.toLowerCase();
      const member = ref ? (team.members ?? []).find((m) => m.id === ref || m.name.toLowerCase() === lower || sessionOf(team, m) === ref || m.sessionName === ref) : undefined;
      if (!member) {
        const temps = temporaryMembersOf(team).map((m) => m.name);
        throw new TempMemberError(404, E.MEMBER_NOT_FOUND, `No member "${ref}" on ${team.name}. Temporary members: ${temps.join(', ') || 'none'}.`);
      }
      if (!member.temporary) {
        throw new TempMemberError(409, E.NOT_TEMPORARY, `${member.name} is a permanent member. This skill removes temporary members only; only the owner removes a permanent member.`);
      }
      const session = sessionOf(team, member);
      if (input.force !== true) {
        const items = await this.deps.workItems();
        const held = items.filter((wi) => wi.target === session && LIVE.includes(wi.status));
        if (held.length > 0) {
          throw new TempMemberError(409, E.MEMBER_BUSY, `${member.name} still holds work (${held.map((wi) => wi.id).slice(0, 5).join(', ')}). Reassign or cancel it first, or pass --force to remove it anyway.`);
        }
        if (await this.deps.isBusy(session).catch(() => true)) {
          throw new TempMemberError(409, E.MEMBER_BUSY, `${member.name} is in the middle of a turn. Try again when it is idle, or pass --force to remove it anyway.`);
        }
      }
      const why = oneLine(input.reason, C.MAX_REASON_CHARS) || 'removed by the lead';
      const left = temporaryMembersOf(team).filter((m) => m.id !== member.id).length;
      await this.remove(team, member, why, sessionOf(team, lead));
      return { removed: true, member: { id: member.id, name: member.name, role: member.role }, headcount: { used: left, limit: tempHeadcountOf(team) } };
    });
  }

  /**
   * Stop and remove a temporary member through the normal remove path and
   * write the history line.
   *
   * @param team - Its team
   * @param member - The temporary member
   * @param why - Why it goes
   * @param by - A lead's session, or `system`
   * @throws TempMemberError when it is no longer temporary, or the remove path refused
   */
  private async remove(team: Team, member: TeamMember, why: string, by: string): Promise<void> {
    // The owner may have made it permanent since the caller looked: never remove a permanent member here.
    const fresh = (await this.team(team.id)).members?.find((m) => m.id === member.id);
    if (!fresh?.temporary) throw new TempMemberError(409, E.NOT_TEMPORARY, `${member.name} is no longer a temporary member of ${team.name}`);
    const ok = await this.deps.removeMember(team.id, member.id);
    if (!ok) throw new TempMemberError(500, E.MEMBER_NOT_FOUND, `${member.name} could not be removed from ${team.name}`);
    await this.deps.store.record({
      type: 'removed',
      at: this.now().toISOString(),
      teamId: team.id,
      teamName: team.name,
      memberId: member.id,
      memberName: member.name,
      session: sessionOf(team, member),
      role: member.role,
      reason: why,
      by,
      ...(member.temporary?.workItemId ? { workItemId: member.temporary.workItemId } : {}),
    });
    this.deps.logger?.info('Temporary member removed', { teamId: team.id, member: member.name, why, by });
  }

  // -------------------------------------------------------------------- tick

  /**
   * Why a temporary member should go now, or null to keep it. Never names a
   * member that is mid-turn or holds live work.
   *
   * @param team - Its team
   * @param member - The temporary member
   * @param items - Every work item
   * @param busy - Whether it is mid-turn
   * @returns Reason in plain words, or null
   */
  removalReason(team: Team, member: TeamMember, items: readonly WorkItem[], busy: boolean): string | null {
    const t = member.temporary;
    if (!t || busy) return null;
    const session = sessionOf(team, member);
    const mine = items.filter((wi) => wi.target === session);
    if (mine.some((wi) => LIVE.includes(wi.status))) return null;
    const nowMs = this.now().getTime();
    if (nowMs >= Date.parse(t.expiresAt)) return `it reached the ${Math.round(C.MAX_AGE_MS / DAY_MS)}-day limit for temporary members`;
    // Work it reported done and the lead has not accepted yet may be sent back to it.
    if (mine.some((wi) => wi.status === AWAITING_REVIEW)) return null;
    const lastWork = Math.max(Date.parse(t.createdAt) || 0, ...mine.map(endOf));
    const idleSince = Math.max(lastWork, this.deps.lastActivityAt?.(session) ?? 0);
    const bound = t.workItemId ? items.find((wi) => wi.id === t.workItemId) : undefined;
    if (bound && SETTLED.includes(bound.status) && nowMs - idleSince >= C.DONE_IDLE_MS) {
      return bound.status === 'cancelled' ? `its work (${bound.id}) was cancelled` : `its work (${bound.id}) was accepted`;
    }
    if (nowMs - lastWork >= C.UNUSED_MS) return `it had no work for ${Math.round(C.UNUSED_MS / (60 * 60 * 1000))} hours`;
    return null;
  }

  /**
   * Remove every temporary member that is done or unused. A busy one is left
   * alone and checked again next tick. The lead gets one short note per
   * removal.
   *
   * @returns What was removed and how many were kept
   */
  async tick(): Promise<TempTickResult> {
    const out: TempTickResult = { removed: [], kept: 0 };
    if (this.ticking) return out;
    this.ticking = true;
    try {
      const teams = (await this.deps.getTeams()).filter((t) => !t.archived && temporaryMembersOf(t).length > 0);
      if (teams.length === 0) return out;
      const items = await this.deps.workItems();
      for (const team of teams) {
        for (const member of temporaryMembersOf(team)) {
          try {
            const busy = await this.deps.isBusy(sessionOf(team, member)).catch(() => true);
            const why = this.removalReason(team, member, items, busy);
            if (!why) {
              out.kept += 1;
              continue;
            }
            await this.serial(() => this.remove(team, member, why, 'system'));
            out.removed.push({ teamId: team.id, memberId: member.id, name: member.name, why });
            await this.tellLead(team, member.temporary?.createdBy, `${C.NOTE_TAG} ${member.name} (temporary ${member.role}) was removed from ${team.name}: ${why}. Nothing for you to do; add another with add-temp-member when you need one.`);
          } catch (err) {
            this.deps.logger?.warn('Could not remove a temporary member', { teamId: team.id, member: member.name, error: err instanceof Error ? err.message : String(err) });
          }
        }
      }
    } finally {
      this.ticking = false;
    }
    return out;
  }

  /**
   * Send a note to the lead that asked (when it still leads the team), else
   * to the team's first lead.
   *
   * @param team - Team
   * @param preferred - Session of the lead that asked
   * @param text - Note
   */
  private async tellLead(team: Team, preferred: string | undefined, text: string): Promise<void> {
    const leads = getTeamLeads(team);
    const lead = leads.find((l) => sessionOf(team, l) === preferred) ?? leads[0];
    if (!lead) return;
    await this.deps.deliverToAgent(sessionOf(team, lead), text).catch(() => false);
  }

  // ----------------------------------------------------------- seat requests

  /**
   * `request-seat`: a lead asks the owner for a permanent seat. One owner
   * card (Approve / Not now, default Not now) with the reason and evidence.
   *
   * @param callerSession - The calling agent (must lead the team)
   * @param teamId - Team id
   * @param input - role, reason, optional name
   * @returns The card id and what happens next
   * @throws TempMemberError 400 bad input, 403 not a lead, 409 already open / declined recently, 503 no cards
   */
  requestSeat(callerSession: string | undefined, teamId: string, input: SeatRequestInput): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      const { team, lead } = await this.leadContext(callerSession, teamId, 'ask for a permanent seat');
      const role = await this.role(input.role);
      const reason = this.reason(input.reason, 'what work keeps needing this seat');
      const name = this.requestedName(team, input.name);
      const decisions = this.deps.decisions();
      if (!decisions) throw new TempMemberError(503, E.CARDS_UNAVAILABLE, 'Owner decision cards are not running on this machine, so the request cannot be sent. Try again in a minute.');
      const now = this.now();
      for (const r of (await this.deps.store.seatRequests()).filter((x) => x.teamId === team.id && x.role === role)) {
        if (r.status === 'open') {
          const d = await decisions.get(r.decisionId).catch(() => null);
          if (d && (d.status === 'open' || d.status === 'parked')) {
            throw new TempMemberError(409, E.SEAT_REQUEST_OPEN, `A request for a permanent ${role} on ${team.name} already waits for the owner (${r.decisionId}). You will be told the answer; do not ask again.`);
          }
          // The card is gone without its handler having run: count it as "not now" from now on.
          await this.deps.store.updateSeatRequest(r.decisionId, { status: 'declined', settledAt: now.toISOString() });
          r.status = 'declined';
          r.settledAt = now.toISOString();
        }
        const until = r.status === 'declined' && r.settledAt ? Date.parse(r.settledAt) + C.DECLINE_COOLDOWN_MS : 0;
        if (until > now.getTime()) {
          throw new TempMemberError(
            409,
            E.SEAT_RECENTLY_DECLINED,
            `The owner said "not now" to a permanent ${role} on ${team.name} on ${r.settledAt!.slice(0, 10)}. The same seat can be requested again from ${new Date(until).toISOString().slice(0, 10)}. Until then use temporary members (add-temp-member) within the team's headcount.`,
          );
        }
      }
      const asker = sessionOf(team, lead);
      const decision = await this.postCard(decisions, team, lead, role, reason, name);
      const request: SeatRequest = {
        decisionId: decision.id,
        teamId: team.id,
        teamName: team.name,
        role,
        ...(name ? { name } : {}),
        reason,
        askerSession: asker,
        askerName: lead.name,
        at: now.toISOString(),
        status: 'open',
      };
      await this.deps.store.addSeatRequest(request);
      this.deps.logger?.info('Permanent seat requested', { teamId: team.id, role, decisionId: decision.id, asker });
      return {
        requested: true,
        decisionId: decision.id,
        note: `One card went to the owner (${decision.id}). Nothing changes until the owner approves; you will be told the answer. Without an answer in ${Math.round(C.DECISION_DEADLINE_MS / DAY_MS)} days it counts as "not now".`,
      };
    });
  }

  /**
   * The evidence lines of a seat-request card, in plain words.
   *
   * @param team - Team
   * @param lead - The asking lead
   * @param role - Requested role
   * @param lang - Owner language (Chinese lines for `zh`)
   * @returns Lines
   */
  async evidence(team: Team, lead: TeamMember, role: string, lang?: 'en' | 'zh' | null): Promise<string[]> {
    const since = this.now().getTime() - C.EVIDENCE_WINDOW_DAYS * DAY_MS;
    const opened = (await this.deps.store.events(since)).filter((e) => e.type === 'created' && e.teamId === team.id && e.role === role).length;
    const leadSessions = getTeamLeads(team).map((l) => sessionOf(team, l));
    let kept = 0;
    try {
      kept = this.deps.noMemberFitsCount(team.id, leadSessions, since);
    } catch (err) {
      this.deps.logger?.warn('Could not read the "no member fits" records', { teamId: team.id, error: String(err) });
    }
    const roster = (team.members ?? []).filter((m) => m.role !== 'orchestrator');
    const temps = roster.filter((m) => !!m.temporary).length;
    if (lang === 'zh') {
      return [
        `• 最近 ${C.EVIDENCE_WINDOW_DAYS} 天，团队开过 ${opened} 个临时 ${role} 组员。`,
        `• 最近 ${C.EVIDENCE_WINDOW_DAYS} 天，${lead.name} 有 ${kept} 次因为没有组员能接而自己做。`,
        `• 团队现在有 ${roster.length} 名成员${temps ? `，其中 ${temps} 名是临时的` : ''}。`,
      ];
    }
    return [
      `• In the last ${C.EVIDENCE_WINDOW_DAYS} days the team opened ${plural(opened, `temporary ${role} member`)}.`,
      `• In the last ${C.EVIDENCE_WINDOW_DAYS} days ${lead.name} kept work ${plural(kept, 'time')} because no member could take it.`,
      `• The team has ${plural(roster.length, 'member')} now${temps ? `, ${temps} of them temporary` : ''}.`,
    ];
  }

  /**
   * Post the owner card of a seat request (same place and form as a model
   * tier card: the team's channel, from the lead's bot).
   *
   * @param decisions - Decision service
   * @param team - Team
   * @param lead - Asking lead
   * @param role - Requested role
   * @param reason - The lead's reason
   * @param name - Requested member name, or null
   * @returns The decision
   */
  private async postCard(decisions: SeatDecisions, team: Team, lead: TeamMember, role: string, reason: string, name: string | null): Promise<OwnerDecision> {
    const convert = this.convertible(team, role);
    const lang = this.deps.ownerLanguage ? await this.deps.ownerLanguage().catch(() => null) : null;
    const zh = lang === 'zh';
    const days = Math.round(C.DECLINE_COOLDOWN_MS / DAY_MS);
    const evidence = await this.evidence(team, lead, role, lang);
    const body = zh
      ? [
          `原因：${reason}`,
          ...evidence,
          convert ? `同意后，${convert.name}（现在是临时组员）转为长期成员，保留手上的工作和记忆。` : `同意后，团队新增一名 ${role}${name ? `，名字是 ${name}` : ''}。有活派给它时才启动。`,
        ]
      : [
          `Why: ${reason}`,
          ...evidence,
          convert
            ? `On Approve, ${convert.name} (temporary now) becomes a permanent member and keeps its work and memory.`
            : `On Approve, a new ${role}${name ? ` named ${name}` : ''} joins the team. It starts when it is given work.`,
        ];
    const options: DecisionOption[] = zh
      ? [
          { key: C.APPROVE_KEY, label: '同意', detail: convert ? `${convert.name} 长期留下` : `新增一名 ${role}` },
          { key: C.DECLINE_KEY, label: '先不', detail: `不做任何改动；${days} 天后可以再申请` },
        ]
      : [
          { key: C.APPROVE_KEY, label: 'Approve', detail: convert ? `${convert.name} stays for good` : `adds one ${role}` },
          { key: C.DECLINE_KEY, label: 'Not now', detail: `nothing changes; can be asked again in ${days} days` },
        ];
    const question = zh ? `给 ${team.name} 团队增加一个长期的 ${role} 席位吗？` : `Add a permanent ${role} to ${team.name}?`;
    const title = zh ? `${lead.name} 申请给 ${team.name} 增加一个长期 ${role}` : `${lead.name} asks for a permanent ${role} on ${team.name}`;
    const channel = await this.deps.teamChannelOf?.(team.id).catch(() => null);
    try {
      return await decisions.askPrebuilt({
        kind: C.DECISION_KIND,
        asker: sessionOf(team, lead),
        question,
        title,
        body,
        options,
        defaultKey: C.DECLINE_KEY,
        yesKey: C.APPROVE_KEY,
        deadline: new Date(this.now().getTime() + C.DECISION_DEADLINE_MS),
        ...(channel ? { place: { slackChannelId: channel } } : {}),
      });
    } catch (err) {
      const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 500;
      throw new TempMemberError(status, E.CARDS_UNAVAILABLE, `The request could not be sent to the owner: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The temporary member an approved seat of `role` would make permanent:
   * the oldest live one of that role.
   *
   * @param team - Team
   * @param role - Role
   * @returns Member, or undefined
   */
  private convertible(team: Team, role: string): TeamMember | undefined {
    return temporaryMembersOf(team)
      .filter((m) => m.role === role)
      .sort((a, b) => Date.parse(a.temporary!.createdAt) - Date.parse(b.temporary!.createdAt))[0];
  }

  /**
   * A seat card settled. Approve: a live temporary member of that role
   * becomes permanent, else a member is added through the normal path.
   * Anything else (Not now, the deadline, skip, cancel): nothing changes and
   * the same seat cannot be requested again for the cool-down.
   *
   * @param decision - The settled decision
   * @returns Note for the asking lead, or null
   */
  async onSettled(decision: OwnerDecision): Promise<string | null> {
    // A parked card can still be answered: it stays open.
    if (decision.status === 'parked') return null;
    return this.serial(async () => {
      const request = (await this.deps.store.seatRequests()).find((r) => r.decisionId === decision.id);
      if (!request || request.status !== 'open') return null;
      const settledAt = this.now().toISOString();
      if (decision.status !== 'resolved' || decision.chosenKey !== C.APPROVE_KEY) {
        await this.deps.store.updateSeatRequest(decision.id, { status: 'declined', settledAt });
        const again = new Date(Date.parse(settledAt) + C.DECLINE_COOLDOWN_MS).toISOString().slice(0, 10);
        return `${C.SEAT_NOTE_TAG} The owner said "not now" to a permanent ${request.role} on ${request.teamName} (${decision.id}). Nothing changed. Keep using temporary members within the team's headcount; the same seat can be requested again from ${again}.`;
      }
      try {
        const filled = await this.fillSeat(request);
        await this.deps.store.updateSeatRequest(decision.id, { status: 'approved', settledAt, memberId: filled.member.id });
        const how = filled.converted ? `${filled.member.name} is now a permanent member (it keeps its session, work and memory)` : `${filled.member.name} joined as a permanent ${request.role}; it starts when you assign it work`;
        return `${C.SEAT_NOTE_TAG} The owner approved a permanent ${request.role} on ${request.teamName} (${decision.id}): ${how}. Delegate to it with delegate-task --to ${filled.session}.`;
      } catch (err) {
        // Closed as approved (no cool-down): the lead tells the owner and may ask again.
        await this.deps.store.updateSeatRequest(decision.id, { status: 'approved', settledAt });
        this.deps.logger?.warn('Seat approved but it could not be filled', { decisionId: decision.id, error: err instanceof Error ? err.message : String(err) });
        return `${C.SEAT_NOTE_TAG} The owner approved a permanent ${request.role} on ${request.teamName} (${decision.id}), but adding the member failed (${err instanceof Error ? err.message : String(err)}). Tell the owner.`;
      }
    });
  }

  /**
   * Fill an approved seat.
   *
   * @param request - The approved request
   * @returns The member that fills it, its session, and whether it was a temporary member before
   * @throws TempMemberError when the team is gone
   */
  private async fillSeat(request: SeatRequest): Promise<{ member: TeamMember; session: string; converted: boolean }> {
    const team = await this.team(request.teamId);
    const taken = (name: string, except?: string): boolean => (team.members ?? []).some((m) => m.id !== except && m.name.toLowerCase() === name.toLowerCase());
    const temp = this.convertible(team, request.role);
    if (temp) {
      const info = temp.temporary!;
      // The agent id was fixed at creation, so a new display name keeps its session and memory.
      const session = sessionOf(team, temp);
      if (!temp.agentId) temp.agentId = session;
      const plain = temp.name.startsWith(`${C.NAME_PREFIX}-`) ? temp.name.slice(C.NAME_PREFIX.length + 1) : temp.name;
      const wanted = request.name && !taken(request.name, temp.id) ? request.name : plain;
      const before = temp.name;
      if (wanted !== temp.name && !taken(wanted, temp.id)) temp.name = wanted;
      delete temp.temporary;
      temp.updatedAt = this.now().toISOString();
      team.updatedAt = temp.updatedAt;
      await this.deps.saveTeam(team);
      await this.deps.store.record({
        type: 'converted',
        at: temp.updatedAt,
        teamId: team.id,
        teamName: team.name,
        memberId: temp.id,
        memberName: temp.name,
        session,
        role: temp.role,
        reason: `made permanent by the owner (${request.decisionId})${before !== temp.name ? `; was ${before}` : ''}`,
        by: 'owner',
        ...(info.workItemId ? { workItemId: info.workItemId } : {}),
      });
      return { member: temp, session, converted: true };
    }
    const name = request.name && !taken(request.name) ? request.name : this.freeName(team, request.role, 1);
    const lead = getTeamLeads(team).find((l) => sessionOf(team, l) === request.askerSession) ?? getTeamLeads(team)[0];
    const member = await this.deps.addMember(team.id, { name, role: request.role, ...(lead && reportsTo(team, lead) ? { parentMemberId: lead.id } : {}) });
    return { member, session: memberAgentId(team.name, member), converted: false };
  }
}

/**
 * Whether a new member should name this lead as its parent: on a team with a
 * hierarchy the lead's delegation checks accept only members that report to
 * it. A flat team keeps its members without a parent.
 *
 * @param team - Team
 * @param lead - The lead
 * @returns True when the team uses the hierarchy fields
 */
function reportsTo(team: Team, lead: TeamMember): boolean {
  return team.hierarchical === true || (lead.subordinateIds?.length ?? 0) > 0 || (team.members ?? []).some((m) => m.parentMemberId === lead.id);
}

/** 3 → "3rd". */
function ordinal(n: number): string {
  const tail = n % 100;
  if (tail >= 11 && tail <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** Process-wide instance (set by the wiring). */
let instance: TempMemberService | null = null;

/**
 * The running service, or null before it is wired.
 *
 * @returns Service
 */
export function getTempMemberService(): TempMemberService | null {
  return instance;
}

/**
 * Install (or clear) the running service.
 *
 * @param s - Service
 */
export function setTempMemberService(s: TempMemberService | null): void {
  instance = s;
}
