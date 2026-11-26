/**
 * A team must have a lead (specs/2026-10-04-tl-delegation.md §6).
 *
 * Everything that makes a lead hand work to members keys on the lead rule
 * (`utils/team.utils.ts`): the lead prompt, the team-leader skills, the
 * execution nudge, the lead-share report. A team with no lead by the rule
 * gets none of it, and the member the owner writes to does everything
 * itself. This service finds such teams and asks the owner — one card per
 * team — who should lead. The owner's pick is applied the way
 * `POST /api/teams/:id/lead` applies it and the new lead is told; "Not now"
 * (or no answer) is remembered for
 * {@link TEAM_LEAD_REQUIRED_CONSTANTS.SNOOZE_MS}.
 *
 * @module services/team-lead-required/team-lead-required.service
 */

import { DECISION_CONSTANTS, ORCHESTRATOR_ROLE, TEAM_LEAD_REQUIRED_CONSTANTS } from '../../constants.js';
import { CREWLY_CONSTANTS } from '../../../../config/constants.js';
import type { DecisionLanguage, OwnerDecision } from '../../types/decision.types.js';
import type { Team, TeamMember } from '../../types/index.js';
import { resolveMemberSessionName } from '../../utils/member-session-name.utils.js';
import { getTeamLeadIds, pickTeamLead } from '../../utils/team.utils.js';
import { PENDING_DECISION_STATUSES } from '../decisions/decision-store.js';
import type { DecisionKindHandler, SystemAskInput } from '../decisions/decision.service.js';
import type { TeamLeadAskRecord, TeamLeadCandidate, TeamLeadRequiredStore } from './team-lead-required.store.js';

const C = TEAM_LEAD_REQUIRED_CONSTANTS;

/** The decision-card calls the service makes. */
export interface TeamLeadDecisions {
  askSystem(input: SystemAskInput): Promise<OwnerDecision>;
  get(id: string): Promise<OwnerDecision | null>;
  cancelWhere(filter: (d: OwnerDecision) => boolean, note?: string): Promise<number>;
}

/** Logger slice. */
export interface TeamLeadLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

/** Collaborators. */
export interface TeamLeadRequiredDeps {
  store: TeamLeadRequiredStore;
  /** Every team */
  getTeams: () => Promise<Team[]>;
  /** The decision cards, or null while they are not running */
  decisions: () => TeamLeadDecisions | null;
  /** Make the member THE lead and persist it (the `POST /api/teams/:id/lead` path) */
  setLead: (team: Team, memberId: string) => Promise<void>;
  /** Deliver text to an agent (wakes a stopped one) */
  deliverToAgent: (session: string, text: string) => Promise<boolean>;
  /** The owner's language (default English); the card is written in it */
  ownerLanguage?: () => Promise<DecisionLanguage | null>;
  /** Folder of the team-leader skills, named in the note to the new lead */
  tlSkillsPath?: string;
  /** Clock */
  now?: () => Date;
  logger?: TeamLeadLogger;
}

/** The card's text. */
export interface TeamLeadCardText {
  title: string;
  question: string;
  body: string[];
}

/**
 * The members of a team that count for the lead question: everyone but the
 * orchestrator.
 *
 * @param team - Team
 * @returns Members
 */
export function leadEligibleMembers(team: Team): TeamMember[] {
  return (team.members ?? []).filter((m) => m.role !== ORCHESTRATOR_ROLE);
}

/**
 * Whether a team must be asked about: not archived, not the orchestrator
 * team, at least {@link TEAM_LEAD_REQUIRED_CONSTANTS.MIN_MEMBERS} members,
 * and no lead by the rule.
 *
 * @param team - Team
 * @returns True when the team needs a lead and has none
 */
export function teamNeedsLead(team: Team): boolean {
  if (team.archived || team.id === CREWLY_CONSTANTS.AGENT_IDS.ORCHESTRATOR_ID) return false;
  if (leadEligibleMembers(team).length < C.MIN_MEMBERS) return false;
  return getTeamLeadIds(team).length === 0;
}

/**
 * The members offered on the card, best guess first: members whose role
 * already coordinates work ({@link TEAM_LEAD_REQUIRED_CONSTANTS.PREFERRED_ROLES}),
 * then the member "the team lead" traffic falls back to today
 * (`pickTeamLead`), then the others. Members whose name repeats an earlier
 * candidate's are left out (a card cannot carry two identical buttons). At
 * most {@link TEAM_LEAD_REQUIRED_CONSTANTS.MAX_CANDIDATES}.
 *
 * @param team - A team without a lead
 * @returns Candidates, in option order
 */
export function leadCandidates(team: Team): TeamMember[] {
  const members = leadEligibleMembers(team);
  const preferred = members.filter((m) => C.PREFERRED_ROLES.includes(String(m.role)));
  const fallback = pickTeamLead(team);
  const ordered = [...preferred, ...(fallback ? [fallback] : []), ...members];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>([C.NOT_NOW_LABEL.toLowerCase(), C.NOT_NOW_LABEL_ZH.toLowerCase()]);
  const out: TeamMember[] = [];
  for (const m of ordered) {
    const name = candidateLabel(m).toLowerCase();
    if (m.role === ORCHESTRATOR_ROLE || seenIds.has(m.id) || !name || seenNames.has(name)) continue;
    seenIds.add(m.id);
    seenNames.add(name);
    out.push(m);
    if (out.length >= C.MAX_CANDIDATES) break;
  }
  return out;
}

/**
 * The button label of a candidate: its name, on one line, within the
 * button limit.
 *
 * @param m - Member
 * @returns Label
 */
export function candidateLabel(m: Pick<TeamMember, 'name'>): string {
  return String(m.name ?? '').replace(/\s+/g, ' ').trim().slice(0, DECISION_CONSTANTS.OPTION_LABEL_MAX_CHARS);
}

/**
 * The card for a team without a lead (Slack mrkdwn), in the owner's
 * language: Chinese for a Chinese-writing owner, English otherwise.
 *
 * @param team - The team
 * @param lang - Owner language
 * @returns Title, question and body sections
 */
export function teamLeadCard(team: Team, lang?: DecisionLanguage | null): TeamLeadCardText {
  const roster = leadEligibleMembers(team)
    .map((m) => `${m.name} (${m.role})`)
    .join(', ');
  if (lang === 'zh') {
    return {
      title: `${team.name} 团队没有负责人`,
      question: `谁来负责 ${team.name} 团队？没有负责人，团队里没人能分派工作、启动组员或验收结果。`,
      body: [`*成员：* ${roster}`, '现在你把活交给谁，谁就一个人全做完。你选的负责人会把活分给其他组员并检查结果。之后可以在团队页面更换负责人。'],
    };
  }
  return {
    title: `Team ${team.name} has no lead`,
    question: `Who should lead team ${team.name}? Without a lead, nobody on the team can assign work, start members or review results.`,
    body: [
      `*Members:* ${roster}`,
      'Today whoever you write to does all the work alone. The lead you pick hands work to the other members and checks it. You can change the lead later on the team page.',
    ],
  };
}

/**
 * The declining option of the card, in the owner's language.
 *
 * @param lang - Owner language
 * @returns Label and detail
 */
export function notNowOption(lang?: DecisionLanguage | null): { label: string; detail: string } {
  return lang === 'zh' ? { label: C.NOT_NOW_LABEL_ZH, detail: C.NOT_NOW_DETAIL_ZH } : { label: C.NOT_NOW_LABEL, detail: C.NOT_NOW_DETAIL };
}

/**
 * The note the new lead gets (English harness text).
 *
 * @param team - The team (after the change)
 * @param lead - The new lead
 * @param tlSkillsPath - Folder of the team-leader skills (optional)
 * @returns Note
 */
export function newLeadNote(team: Team, lead: TeamMember, tlSkillsPath?: string): string {
  const others = leadEligibleMembers(team)
    .filter((m) => m.id !== lead.id)
    .map((m) => `${m.name} (${m.role})`)
    .join(', ');
  const where = tlSkillsPath ? ` They are in ${tlSkillsPath} (for example ${tlSkillsPath}/delegate-task/execute.sh); your prompt lists them from your next start.` : '';
  return (
    `${C.NOTE_TAG} The owner made you the lead of team ${team.name}. ` +
    `You now have the team-leader skills: delegate-task assigns work to a member, start-agent starts a stopped one.${where} ` +
    `Hand hands-on work to your members${others ? `: ${others}` : ''}. ` +
    'Keep lead-level work yourself: review, decisions and talking to the owner. No reply is needed.'
  );
}

/**
 * Finds teams without a lead, asks the owner, and applies the answer.
 */
export class TeamLeadRequiredService implements DecisionKindHandler {
  private readonly deps: TeamLeadRequiredDeps;
  private readonly now: () => Date;
  private ticking: Promise<void> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;

  /**
   * @param deps - Collaborators
   */
  constructor(deps: TeamLeadRequiredDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Start checking: once {@link TEAM_LEAD_REQUIRED_CONSTANTS.FIRST_TICK_DELAY_MS}
   * after the call, then every {@link TEAM_LEAD_REQUIRED_CONSTANTS.TICK_INTERVAL_MS}.
   * The timers do not keep the process alive.
   */
  start(): void {
    this.stop();
    this.firstTimer = setTimeout(() => void this.tick(), C.FIRST_TICK_DELAY_MS);
    this.firstTimer.unref?.();
    this.interval = setInterval(() => void this.tick(), C.TICK_INTERVAL_MS);
    this.interval.unref?.();
  }

  /** Stop checking. */
  stop(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.interval) clearInterval(this.interval);
    this.firstTimer = null;
    this.interval = null;
  }

  /**
   * One check over every team. Never throws; a check already running is
   * joined rather than started again (so a team never gets two cards).
   *
   * @returns When the check is done
   */
  tick(): Promise<void> {
    if (!this.ticking) {
      this.ticking = this.runTick()
        .catch((err) => this.deps.logger?.warn('Team lead check failed', { error: errText(err) }))
        .finally(() => {
          this.ticking = null;
        });
    }
    return this.ticking;
  }

  /**
   * A `team_lead` card settled. The owner's pick becomes the lead and is
   * told; anything else (Not now, the deadline, a skip) is remembered so
   * the team is not asked about again for a while. A card that is not the
   * team's current one, or whose team has a lead by now, changes nothing.
   *
   * @param d - Settled decision
   * @returns null (the harness asked; no agent is waiting for the answer)
   */
  async onSettled(d: OwnerDecision): Promise<null> {
    try {
      await this.handleSettled(d);
    } catch (err) {
      this.deps.logger?.warn('Could not act on the team lead answer', { decisionId: d.id, error: errText(err) });
    }
    return null;
  }

  // ------------------------------------------------------------------ internals

  /**
   * Walk the teams: withdraw questions that no longer apply, pick up
   * answers the handler missed, and ask about teams that need a lead.
   */
  private async runTick(): Promise<void> {
    const teams = await this.deps.getTeams();
    const byId = new Map(teams.map((t) => [t.id, t]));
    for (const rec of Object.values(this.deps.store.all())) {
      const team = byId.get(rec.teamId);
      if (!team || getTeamLeadIds(team).length > 0) {
        // Deleted, or it has a lead now: nothing left to ask or remember.
        await this.withdraw(rec);
        this.deps.store.delete(rec.teamId);
      } else if (rec.status === 'asked' && !teamNeedsLead(team)) {
        // Archived or shrunk below two members while the card was open.
        await this.withdraw(rec);
        this.deps.store.delete(rec.teamId);
      }
    }
    for (const team of teams) {
      if (!teamNeedsLead(team)) continue;
      try {
        await this.askOnce(team);
      } catch (err) {
        this.deps.logger?.warn('Could not ask who leads the team', { teamId: team.id, error: errText(err) });
      }
    }
  }

  /**
   * Ask about one team unless it has an open card or is snoozed.
   *
   * @param team - A team that needs a lead
   */
  private async askOnce(team: Team): Promise<void> {
    const decisions = this.deps.decisions();
    if (!decisions) return;
    let rec = this.deps.store.get(team.id);
    if (rec?.status === 'asked' && rec.decisionId) {
      const d = await decisions.get(rec.decisionId);
      if (d && PENDING_DECISION_STATUSES.has(d.status)) return;
      // Settled while the handler was not listening (a restart): act on it now.
      if (d) await this.handleSettled(d);
      else this.deps.store.delete(team.id);
      rec = this.deps.store.get(team.id);
      if (!rec && d) return;
    }
    if (rec?.status === 'snoozed' && rec.snoozedUntil && Date.parse(rec.snoozedUntil) > this.now().getTime()) return;

    const candidates = leadCandidates(team);
    if (candidates.length === 0) return;
    const lang = this.deps.ownerLanguage ? await this.deps.ownerLanguage().catch(() => null) : null;
    const text = teamLeadCard(team, lang);
    const notNow = notNowOption(lang);
    const offered: TeamLeadCandidate[] = candidates.map((m) => ({ memberId: m.id, label: candidateLabel(m) }));
    const d = await decisions.askSystem({
      kind: C.DECISION_KIND,
      system: { key: team.id, defaultIsDecline: true },
      title: text.title,
      question: text.question,
      body: text.body,
      options: [
        ...candidates.map((m, i) => ({ label: offered[i].label, detail: String(m.role) })),
        { label: notNow.label, detail: notNow.detail },
      ],
      default: notNow.label,
      deadline: new Date(this.now().getTime() + C.DEADLINE_MS),
    });
    this.save({ teamId: team.id, status: 'asked', decisionId: d.id, candidates: offered });
    this.deps.logger?.info('Asked the owner who leads the team', { teamId: team.id, teamName: team.name, decisionId: d.id, candidates: offered.map((c) => c.label) });
  }

  /**
   * Act on a settled card (see {@link onSettled}).
   *
   * @param d - Settled decision
   */
  private async handleSettled(d: OwnerDecision): Promise<void> {
    if (d.kind !== C.DECISION_KIND || !d.system) return;
    const teamId = d.system.key;
    const rec = this.deps.store.get(teamId);
    if (!rec || rec.status !== 'asked' || rec.decisionId !== d.id) return;
    const team = (await this.deps.getTeams()).find((t) => t.id === teamId);
    if (!team || getTeamLeadIds(team).length > 0) {
      // The team is gone or got a lead elsewhere meanwhile: the answer is moot.
      this.deps.store.delete(teamId);
      return;
    }
    const label = d.status === 'resolved' ? d.options.find((o) => o.key === d.chosenKey)?.label : undefined;
    const picked = label ? rec.candidates?.find((c) => c.label === label) : undefined;
    const member = picked ? leadEligibleMembers(team).find((m) => m.id === picked.memberId) : undefined;
    if (!picked) {
      this.save({ teamId, status: 'snoozed', decisionId: d.id, snoozedUntil: new Date(this.now().getTime() + C.SNOOZE_MS).toISOString() });
      this.deps.logger?.info('Team stays without a lead for now', { teamId, decisionId: d.id, status: d.status });
      return;
    }
    // Answered: whatever happens next, this card is done. A pick that cannot
    // be applied (the member left) is asked again on the next check.
    this.deps.store.delete(teamId);
    if (!member) {
      this.deps.logger?.warn('The member the owner picked as lead is no longer on the team', { teamId, decisionId: d.id, memberId: picked.memberId });
      return;
    }
    await this.deps.setLead(team, member.id);
    this.deps.logger?.info('Team lead set from the owner card', { teamId, teamName: team.name, lead: member.name, decisionId: d.id });
    const session = resolveMemberSessionName(team.name, member);
    const delivered = await this.deps.deliverToAgent(session, newLeadNote(team, member, this.deps.tlSkillsPath)).catch(() => false);
    if (!delivered) this.deps.logger?.warn('Could not tell the new lead', { teamId, session });
  }

  /**
   * Withdraw a record's open card, if it has one.
   *
   * @param rec - Record
   */
  private async withdraw(rec: TeamLeadAskRecord): Promise<void> {
    if (rec.status !== 'asked' || !rec.decisionId) return;
    const id = rec.decisionId;
    await this.deps
      .decisions()
      ?.cancelWhere((d) => d.id === id, C.WITHDRAWN_NOTE)
      .catch((err) => this.deps.logger?.warn('Could not withdraw the team lead card', { decisionId: id, error: errText(err) }));
  }

  /**
   * Store a record, stamped now.
   *
   * @param rec - Record without its time
   * @returns The stored record
   */
  private save(rec: Omit<TeamLeadAskRecord, 'updatedAt'>): TeamLeadAskRecord {
    return this.deps.store.set({ ...rec, updatedAt: this.now().toISOString() });
  }
}

/**
 * An error as text.
 *
 * @param err - Anything thrown
 * @returns Message
 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let instance: TeamLeadRequiredService | null = null;

/**
 * The running service, or null before the decision cards start.
 *
 * @returns Service
 */
export function getTeamLeadRequiredService(): TeamLeadRequiredService | null {
  return instance;
}

/**
 * Install (or clear) the running service.
 *
 * @param service - Service, or null
 */
export function setTeamLeadRequiredService(service: TeamLeadRequiredService | null): void {
  instance?.stop();
  instance = service;
}
