/**
 * Team-lead delegation: the execution nudge, its counts, and "no member
 * fits" records (crewly#1083, specs/2026-10-04-tl-delegation.md §2, §4).
 *
 * The nudge rides on the Claude Code agent-status hook: each `PostToolUse`
 * reports the tool name, and a lead that edited files
 * {@link TL_DELEGATION_CONSTANTS.EDIT_THRESHOLD} times within
 * {@link TL_DELEGATION_CONSTANTS.WINDOW_MS} gets one note back as hook
 * `additionalContext` — at most once per
 * {@link TL_DELEGATION_CONSTANTS.NUDGE_COOLDOWN_MS}. It never blocks: the
 * tool already ran, and any failure means no note.
 *
 * @module services/tl-delegation/tl-delegation.service
 */

import * as fs from 'fs';
import * as path from 'path';
import { TL_DELEGATION_CONSTANTS } from '../../constants.js';
import type { Team, TeamMember } from '../../types/index.js';
import { getTeamLeads } from '../../utils/team.utils.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { memberLedgerKeys } from './lead-share.js';

/** A member as the nudge names it. */
export interface NudgeMember {
  name: string;
  role: string;
  /** idle: free now; stopped: starts when assigned; working: busy */
  availability: 'idle' | 'stopped' | 'working';
}

/** The lead's team, for the nudge. */
export interface LeadContext {
  teamId: string;
  teamName: string;
  /** Members other than the lead(s) */
  members: NudgeMember[];
}

/** Work a lead kept because no member fits. */
export interface KeptWorkRecord {
  at: string;
  /** Lead session */
  session: string;
  teamId?: string;
  reason: string;
  work: string;
  workItemId?: string;
  ticket?: string;
}

/** Per-lead nudge counts. */
export interface NudgeCounts {
  /** Nudges sent */
  count: number;
  /** Nudges followed by a delegation within the follow window */
  followed: number;
  /** Last nudge (epoch ms) */
  lastAt?: number;
  /** A nudge not yet followed (epoch ms), cleared on delegation or when the window passes */
  pendingSince?: number;
  /** Per local day: day key → { count, followed } */
  days?: Record<string, { count: number; followed: number }>;
}

/** Persisted state. */
interface DelegationState {
  version: 1;
  nudges: Record<string, NudgeCounts>;
  records: KeptWorkRecord[];
}

/** Collaborators. */
export interface TlDelegationDeps {
  /** The lead's team, or null when the session is not a team lead (or has nobody to delegate to) */
  leadContext: (session: string) => Promise<LeadContext | null>;
  /** State file (default: CREWLY_HOME/tl-delegation.json) */
  statePath?: string;
  /** Clock (epoch ms) */
  now?: () => number;
  logger?: ComponentLogger;
}

const AVAILABILITY_ORDER: Record<NudgeMember['availability'], number> = { idle: 0, stopped: 1, working: 2 };
const AVAILABILITY_WORDS: Record<NudgeMember['availability'], string> = {
  idle: 'idle',
  stopped: 'stopped — starts when assigned',
  working: 'working',
};

/**
 * Members best placed to take hands-on work: idle first, then stopped, then
 * working; at most {@link TL_DELEGATION_CONSTANTS.NUDGE_MAX_MEMBERS}.
 *
 * @param members - The lead's members
 * @returns Ranked, capped list
 */
export function rankMembersForNudge(members: readonly NudgeMember[]): NudgeMember[] {
  return [...members]
    .sort((a, b) => AVAILABILITY_ORDER[a.availability] - AVAILABILITY_ORDER[b.availability])
    .slice(0, TL_DELEGATION_CONSTANTS.NUDGE_MAX_MEMBERS);
}

/**
 * The nudge text (English harness text).
 *
 * @param edits - Edits counted in the window
 * @param members - The lead's members
 * @returns Note
 */
export function buildNudgeText(edits: number, members: readonly NudgeMember[]): string {
  const minutes = Math.round(TL_DELEGATION_CONSTANTS.WINDOW_MS / 60000);
  const named = rankMembersForNudge(members)
    .map((m) => `${m.name} (${m.role}, ${AVAILABILITY_WORDS[m.availability]})`)
    .join(', ');
  return (
    `${TL_DELEGATION_CONSTANTS.NUDGE_TAG} You have edited files ${edits} times in the last ${minutes} minutes. ` +
    `As team lead, hand hands-on work to a member: ${named}. ` +
    'Any member can do any work that needs no special account, tool or permission — role is a preference, not a limit. ' +
    'Delegate with delegate-task (pass --thread <key> for an owner request, so the member answers the owner in that thread). ' +
    'Keep it only if the change is tiny, every member is busy, or it needs your own judgment — then record why: ' +
    'delegate-task --no-member-fits "<what is missing>" --task "<the work>".'
  );
}

/**
 * Local date key (YYYY-MM-DD).
 *
 * @param ms - Epoch ms
 * @returns Day key
 */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Trim a free-text field to one line within the cap.
 *
 * @param text - Any text
 * @returns One line, capped
 */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const max = TL_DELEGATION_CONSTANTS.MAX_TEXT_CHARS;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Nudge bookkeeping and kept-work records.
 */
export class TlDelegationService {
  private static instance: TlDelegationService | null = null;

  private readonly deps: TlDelegationDeps;
  private readonly statePath: string;
  private readonly now: () => number;
  private readonly logger: ComponentLogger;
  /** session → recent edit times (epoch ms), in-memory only */
  private readonly edits = new Map<string, number[]>();
  private state: DelegationState | null = null;
  private writing: Promise<void> = Promise.resolve();

  /**
   * @param deps - Collaborators
   */
  constructor(deps: TlDelegationDeps) {
    this.deps = deps;
    this.statePath = deps.statePath ?? path.join(getCrewlyHomePath(), TL_DELEGATION_CONSTANTS.STATE_FILENAME);
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('TlDelegation');
  }

  /**
   * The process instance (built from the team store on first use).
   *
   * @returns Service
   */
  static getInstance(): TlDelegationService {
    if (!TlDelegationService.instance) {
      TlDelegationService.instance = new TlDelegationService({ leadContext: cachedLeadContext() });
    }
    return TlDelegationService.instance;
  }

  /**
   * Replace (tests) or clear the process instance.
   *
   * @param service - New instance, or null
   */
  static setInstance(service: TlDelegationService | null): void {
    TlDelegationService.instance = service;
  }

  /**
   * A tool call finished in `session`. Returns the nudge to show the agent,
   * or null. Never throws.
   *
   * @param session - Agent session
   * @param toolName - Claude Code tool name
   * @returns Nudge text, or null
   */
  async observeToolUse(session: string, toolName: string): Promise<string | null> {
    try {
      if (!(TL_DELEGATION_CONSTANTS.EDIT_TOOLS as readonly string[]).includes(toolName)) return null;
      const now = this.now();
      const recent = (this.edits.get(session) ?? []).filter((t) => now - t < TL_DELEGATION_CONSTANTS.WINDOW_MS);
      recent.push(now);
      this.edits.set(session, recent);
      if (recent.length < TL_DELEGATION_CONSTANTS.EDIT_THRESHOLD) return null;
      const state = this.load();
      const counts = state.nudges[session];
      if (counts?.lastAt !== undefined && now - counts.lastAt < TL_DELEGATION_CONSTANTS.NUDGE_COOLDOWN_MS) return null;
      const lead = await this.deps.leadContext(session);
      if (!lead || lead.members.length === 0) {
        // Not a lead: stop counting for it until the window passes.
        this.edits.set(session, []);
        return null;
      }
      const text = buildNudgeText(recent.length, lead.members);
      this.edits.set(session, []);
      const next: NudgeCounts = { ...(counts ?? { count: 0, followed: 0 }) };
      next.count += 1;
      next.lastAt = now;
      next.pendingSince = now;
      const day = localDayKey(now);
      const days = { ...(next.days ?? {}) };
      days[day] = { count: (days[day]?.count ?? 0) + 1, followed: days[day]?.followed ?? 0 };
      next.days = pruneDays(days, now);
      state.nudges[session] = next;
      this.save();
      this.logger.info('Team lead nudged to delegate', { session, teamId: lead.teamId, edits: recent.length });
      return text;
    } catch (err) {
      this.logger.debug('Nudge check failed — no nudge', { session, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /**
   * A work item was delegated. Counts as following a nudge when the
   * delegator was nudged within {@link TL_DELEGATION_CONSTANTS.FOLLOW_WINDOW_MS}.
   *
   * @param delegator - Delegating session
   * @param target - Target session
   * @returns True when it followed a nudge
   */
  recordDelegation(delegator: string | undefined, target: string | undefined): boolean {
    try {
      if (!delegator || !target || delegator === target) return false;
      const state = this.load();
      const counts = state.nudges[delegator];
      if (!counts?.pendingSince) return false;
      const now = this.now();
      if (now - counts.pendingSince > TL_DELEGATION_CONSTANTS.FOLLOW_WINDOW_MS) {
        delete counts.pendingSince;
        this.save();
        return false;
      }
      counts.followed += 1;
      const day = localDayKey(counts.pendingSince);
      if (counts.days?.[day]) counts.days[day].followed += 1;
      delete counts.pendingSince;
      this.save();
      this.logger.info('Team lead delegated after a nudge', { delegator, target });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Record work a lead keeps because no member fits.
   *
   * @param input - Lead session, team, reason, work, optional work item / ticket
   * @returns The stored record
   */
  recordKeptWork(input: { session: string; teamId?: string; reason: string; work: string; workItemId?: string; ticket?: string }): KeptWorkRecord {
    const record: KeptWorkRecord = {
      at: new Date(this.now()).toISOString(),
      session: input.session,
      ...(input.teamId ? { teamId: input.teamId } : {}),
      reason: oneLine(input.reason),
      work: oneLine(input.work),
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
      ...(input.ticket ? { ticket: input.ticket } : {}),
    };
    const state = this.load();
    state.records.push(record);
    if (state.records.length > TL_DELEGATION_CONSTANTS.MAX_RECORDS) {
      state.records.splice(0, state.records.length - TL_DELEGATION_CONSTANTS.MAX_RECORDS);
    }
    this.save();
    this.logger.info('Team lead kept work: no member fits', { session: input.session, teamId: input.teamId });
    return record;
  }

  /**
   * Kept-work records since a time, optionally for one team or set of sessions.
   *
   * @param sinceMs - Lower bound (epoch ms)
   * @param filter - Team id and/or lead sessions (either matches)
   * @returns Records, oldest first
   */
  keptWorkSince(sinceMs: number, filter?: { teamId?: string; sessions?: readonly string[] }): KeptWorkRecord[] {
    const sessions = new Set(filter?.sessions ?? []);
    return this.load().records.filter((r) => {
      if ((Date.parse(r.at) || 0) < sinceMs) return false;
      if (!filter) return true;
      return (filter.teamId !== undefined && r.teamId === filter.teamId) || sessions.has(r.session);
    });
  }

  /**
   * Nudge counts of some sessions: all-time, and for one local day.
   *
   * @param sessions - Lead sessions
   * @param dayMs - A time on the day to report (default: now)
   * @returns Totals and that day's numbers
   */
  nudgeCounts(sessions: readonly string[], dayMs?: number): { total: { count: number; followed: number }; day: { count: number; followed: number } } {
    const state = this.load();
    const day = localDayKey(dayMs ?? this.now());
    const out = { total: { count: 0, followed: 0 }, day: { count: 0, followed: 0 } };
    for (const s of new Set(sessions)) {
      const c = state.nudges[s];
      if (!c) continue;
      out.total.count += c.count;
      out.total.followed += c.followed;
      out.day.count += c.days?.[day]?.count ?? 0;
      out.day.followed += c.days?.[day]?.followed ?? 0;
    }
    return out;
  }

  /** Wait for pending writes (tests, shutdown). */
  async flush(): Promise<void> {
    await this.writing;
  }

  /**
   * Load the state once (a missing or broken file starts empty).
   *
   * @returns State
   */
  private load(): DelegationState {
    if (this.state) return this.state;
    let parsed: Partial<DelegationState> | null = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as Partial<DelegationState>;
    } catch {
      parsed = null;
    }
    this.state = {
      version: 1,
      nudges: parsed && typeof parsed.nudges === 'object' && parsed.nudges ? parsed.nudges : {},
      records: Array.isArray(parsed?.records) ? parsed.records : [],
    };
    return this.state;
  }

  /** Write the state (serialized, best-effort). */
  private save(): void {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.writing = this.writing
      .then(async () => {
        await fs.promises.mkdir(path.dirname(this.statePath), { recursive: true });
        const tmp = `${this.statePath}.tmp`;
        await fs.promises.writeFile(tmp, snapshot, 'utf8');
        await fs.promises.rename(tmp, this.statePath);
      })
      .catch((err) => {
        this.logger.warn('Could not save team-lead delegation state', { error: err instanceof Error ? err.message : String(err) });
      });
  }
}

/**
 * Keep only the last 14 days of per-day counts.
 *
 * @param days - Day key → counts
 * @param now - Clock
 * @returns Pruned map
 */
function pruneDays(days: Record<string, { count: number; followed: number }>, now: number): Record<string, { count: number; followed: number }> {
  const oldest = localDayKey(now - 14 * 24 * 60 * 60 * 1000);
  return Object.fromEntries(Object.entries(days).filter(([k]) => k >= oldest));
}

/**
 * The availability of a member, as the nudge words it.
 *
 * @param m - Member
 * @returns Availability
 */
export function memberAvailability(m: Pick<TeamMember, 'agentStatus' | 'workingStatus'>): NudgeMember['availability'] {
  if (m.agentStatus === 'inactive' || m.agentStatus === 'suspended') return 'stopped';
  return m.workingStatus === 'in_progress' ? 'working' : 'idle';
}

/**
 * The lead context of a session among teams: the team it leads, with its
 * other members. Null when it leads no team with other members.
 *
 * @param teams - Teams
 * @param session - Agent session
 * @returns Context, or null
 */
export function leadContextFromTeams(teams: readonly Team[], session: string): LeadContext | null {
  for (const team of teams) {
    if ((team as Team & { archived?: boolean }).archived) continue;
    const leads = getTeamLeads(team);
    if (!leads.some((l) => memberLedgerKeys(l).includes(session))) continue;
    const leadIds = new Set(leads.map((l) => l.id));
    const members = (team.members ?? [])
      .filter((m) => !leadIds.has(m.id) && m.role !== 'orchestrator')
      .map((m) => ({ name: m.name, role: String(m.role), availability: memberAvailability(m) }));
    if (members.length === 0) continue;
    return { teamId: team.id, teamName: team.name, members };
  }
  return null;
}

/**
 * Lead context from the team store, cached per session for a minute (the
 * hook calls this on every file edit).
 *
 * @returns Lookup
 */
function cachedLeadContext(): (session: string) => Promise<LeadContext | null> {
  const cache = new Map<string, { at: number; value: LeadContext | null }>();
  const TTL = 60 * 1000;
  return async (session) => {
    const hit = cache.get(session);
    if (hit && Date.now() - hit.at < TTL) return hit.value;
    const { StorageService } = await import('../core/storage.service.js');
    const teams = await StorageService.getInstance().getTeams().catch(() => [] as Team[]);
    const value = leadContextFromTeams(teams, session);
    cache.set(session, { at: Date.now(), value });
    return value;
  };
}
