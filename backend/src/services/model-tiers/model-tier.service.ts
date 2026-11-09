/**
 * ModelTierService — model tiers and "Optimize usage" (crewly#1173 phases 1
 * and 2, specs/2026-10-08-model-tiers.md).
 *
 * Two change modes per team (`Team.tierChangeMode`, owner-only):
 * `approve` (default) — the lead proposes, the owner approves each change;
 * `auto` — the lead's changes apply at once and the owner gets a notice with
 * one-tap Undo.
 *
 * 1. Review: weekly while a team has "Optimize usage" on (and on demand), the
 *    team lead gets a compact usage report per member and is asked to
 *    propose tier changes and task routing rules.
 * 2. Proposal: the lead adds changes with `propose-tier-change` and submits.
 *    Approve mode: ONE owner card per review carries them all (Apply / Keep
 *    as is). Auto mode: they apply right away, and ONE notice (Undo / Keep)
 *    goes to the same place.
 * 3. Apply: the tiers are set (a member's fixed model is cleared so the tier
 *    takes effect). An idle member whose model changed is restarted so the
 *    new model takes effect now; a busy one picks it up at its next start.
 * 4. Quality guard: a member moved down is watched over its next settled work
 *    items; when it is sent back clearly more often than before, approve mode
 *    sends a revert card, auto mode moves it back at once and tells the owner
 *    (with "Keep the lower tier" to undo the revert).
 *
 * @module services/model-tiers/model-tier.service
 */

import { randomUUID } from 'crypto';
import { MODEL_TIER_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';
import type { ModelTier, Team, TeamMember, TeamTierModels, TierChangeMode } from '../../types/index.js';
import type { DecisionOption, OwnerDecision, TierChangeEntry, TierChangeSubject } from '../../types/decision.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { effectiveMemberModelId } from '../../utils/member-default-model.utils.js';
import { isModelTier, isTierChangeMode, leadChangesTiersItself, parseTierModels, resolveTierModel, tierChangeModeOf, tierMapFor, tierRank } from '../../utils/model-tier.utils.js';
import { getTeamLeads, isTeamLead } from '../../utils/team.utils.js';
import type { DecisionKindHandler, PrebuiltAsk } from '../decisions/decision.service.js';
import { resolveRate } from '../monitoring/model-pricing.js';
import type { TokenUsageEvent } from '../monitoring/token-usage.service.js';
import { memberLedgerKeys } from '../tl-delegation/lead-share.js';
import type { AppliedTierChange, ModelTierStore, TeamTierState, TierDraft } from './model-tier.store.js';
import { baselineBefore, describeStats, judgeGuard, statsAfter } from './tier-quality.js';
import { buildTierReport, renderTierReport, type TeamTierReport } from './tier-usage-report.js';

const C = MODEL_TIER_CONSTANTS;
const APPLY_KEY = 'a';
const KEEP_KEY = 'b';
const DAY_MS = 24 * 60 * 60 * 1000;
/** What the lead is told about restarts after an apply. */
const RESTART_NOTE = 'Idle members restart now on their new model; a busy member picks it up at its next start.';

/** A refusal with an HTTP status. */
export class ModelTierError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ModelTierError';
  }
}

/** The slice of the decision service used here. */
export interface TierDecisions {
  askPrebuilt(ask: PrebuiltAsk): Promise<OwnerDecision>;
  get(id: string): Promise<OwnerDecision | null>;
}

/** Logger slice. */
export interface TierLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

/** What restarting an idle member after an apply did. */
export type TierRestartOutcome = 'restarted' | 'busy' | 'not_running' | 'failed';

/** Collaborators. */
export interface ModelTierDeps {
  store: ModelTierStore;
  getTeams: () => Promise<Team[]>;
  saveTeam: (team: Team) => Promise<void>;
  /** Ledger visitor (TokenUsageService.forEachEvent) */
  forEachEvent: (visit: (sessionName: string, event: TokenUsageEvent) => void, since?: Date) => void;
  workItems: () => Promise<WorkItem[]>;
  /** The decision service, once it runs */
  decisions: () => TierDecisions | null;
  /** Deliver a message to an agent (wakes a stopped one) */
  deliverToAgent: (session: string, text: string) => Promise<boolean>;
  /** The team's Slack channel (the card goes there top-level), or null */
  teamChannelOf?: (teamId: string) => Promise<string | null>;
  /** Absolute path of the team-leader skills */
  tlSkillsPath: string;
  /**
   * Restart a member whose model changed when it is idle (no running turn,
   * no claimed work in progress), so the new model takes effect now. Never
   * stops a busy member. Absent = members pick up the model at their next start.
   */
  restartIfIdle?: (session: string) => Promise<TierRestartOutcome>;
  now?: () => Date;
  logger?: TierLogger;
}

/** What the dashboard shows and edits. */
export interface TierSettingsView {
  teamId: string;
  optimizeUsage: boolean;
  /** `approve`: the owner approves each change; `auto`: the lead decides and tells the owner */
  tierChangeMode: TierChangeMode;
  tierModels: TeamTierModels;
  routingRules: string[];
  /** Effective tier → model per runtime of the team's members */
  tierMaps: Record<string, Partial<Record<ModelTier, string>>>;
  members: Array<{ id: string; name: string; isLead: boolean; runtime: string; tier: ModelTier | null; modelId: string | null; model: string }>;
  review: {
    lastReviewAt: string | null;
    nextReviewAt: string | null;
    drafting: boolean;
    openDecisionId: string | null;
    recent: Array<Pick<AppliedTierChange, 'memberName' | 'from' | 'to' | 'appliedAt' | 'guard' | 'decisionId'>>;
  };
}

/** Settings patch (owner). */
export interface TierSettingsPatch {
  optimizeUsage?: unknown;
  /** `approve` | `auto` */
  tierChangeMode?: unknown;
  tierModels?: unknown;
  /** memberId → tier, '' / null clears */
  memberTiers?: unknown;
}

/** One proposal from the lead's skill. */
export interface ProposalInput {
  /** Member name or id */
  member?: unknown;
  tier?: unknown;
  reason?: unknown;
  /** A routing rule ("polling / formatting -> Ella") */
  routing?: unknown;
  /** Send the draft to the owner */
  submit?: unknown;
  /** Drop the draft */
  clear?: unknown;
}

/** The lead and its team. */
interface LeadContext {
  team: Team;
  lead: TeamMember;
}

function sessionOf(m: Pick<TeamMember, 'sessionName' | 'agentId'>): string {
  return m.sessionName || m.agentId || '';
}

function oneLine(v: unknown, max: number = C.MAX_REASON_CHARS): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function tierLabel(tier: ModelTier | null, model?: string): string {
  return `${tier ?? 'no tier'}${model ? ` (${model})` : ''}`;
}

/** Service. */
export class ModelTierService implements DecisionKindHandler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private restarts: Promise<void> = Promise.resolve();

  private readonly submitting = new Set<string>();

  constructor(private readonly deps: ModelTierDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** Start the hourly tick (due reviews, stale drafts, quality guard). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((err) => this.deps.logger?.warn('Model tier tick failed', { error: String(err) })), C.TICK_MS);
    this.timer.unref?.();
  }

  /** Stop the tick. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async team(teamId: string): Promise<Team> {
    const team = (await this.deps.getTeams()).find((t) => t.id === teamId);
    if (!team) throw new ModelTierError(404, 'Team not found');
    return team;
  }

  // ---------------------------------------------------------------- settings

  /**
   * The team's tier settings and review state.
   *
   * @param teamId - Team id
   * @returns View
   */
  async settings(teamId: string): Promise<TierSettingsView> {
    const team = await this.team(teamId);
    const state = await this.deps.store.get(teamId);
    await this.refreshOpenDecision(teamId, state);
    const members = (team.members ?? []).filter((m) => m.role !== 'orchestrator');
    const tierMaps: TierSettingsView['tierMaps'] = {};
    for (const m of members) {
      const rt = m.runtimeType ?? RUNTIME_TYPES.CLAUDE_CODE;
      tierMaps[rt] ??= tierMapFor(rt, team.tierModels);
    }
    const last = state.lastReviewAt ? Date.parse(state.lastReviewAt) : null;
    return {
      teamId,
      optimizeUsage: team.optimizeUsage === true,
      tierChangeMode: tierChangeModeOf(team),
      tierModels: team.tierModels ?? {},
      routingRules: team.tierRoutingRules ?? [],
      tierMaps,
      members: members.map((m) => {
        const rt = m.runtimeType ?? RUNTIME_TYPES.CLAUDE_CODE;
        return {
          id: m.id,
          name: m.name,
          isLead: isTeamLead(team, m),
          runtime: rt,
          tier: m.tier ?? null,
          modelId: m.modelId ?? null,
          model: effectiveMemberModelId(team, { ...m, runtimeType: rt }) ?? 'runtime default',
        };
      }),
      review: {
        lastReviewAt: state.lastReviewAt ?? null,
        nextReviewAt: team.optimizeUsage ? new Date(last === null ? this.now().getTime() : last + C.REVIEW_INTERVAL_DAYS * DAY_MS).toISOString() : null,
        drafting: !!state.draft,
        openDecisionId: state.openDecisionId ?? null,
        recent: state.applied.slice(-10).reverse().map((a) => ({ memberName: a.memberName, from: a.from, to: a.to, appliedAt: a.appliedAt, guard: a.guard, decisionId: a.decisionId })),
      },
    };
  }

  /**
   * Change the toggle, the team's tier map, or members' tiers (owner).
   *
   * @param teamId - Team id
   * @param patch - Fields to change
   * @returns The new view
   * @throws ModelTierError(400) on invalid input
   */
  async updateSettings(teamId: string, patch: TierSettingsPatch): Promise<TierSettingsView> {
    const team = await this.team(teamId);
    if (patch.optimizeUsage !== undefined) {
      if (typeof patch.optimizeUsage !== 'boolean') throw new ModelTierError(400, 'optimizeUsage is true or false');
      team.optimizeUsage = patch.optimizeUsage;
    }
    if (patch.tierChangeMode !== undefined) {
      if (!isTierChangeMode(patch.tierChangeMode)) throw new ModelTierError(400, 'tierChangeMode is "approve" or "auto"');
      team.tierChangeMode = patch.tierChangeMode;
    }
    if (patch.tierModels !== undefined) {
      const parsed = parseTierModels(patch.tierModels);
      if (!parsed.ok) throw new ModelTierError(400, parsed.error);
      team.tierModels = parsed.value;
    }
    if (patch.memberTiers !== undefined) {
      if (!patch.memberTiers || typeof patch.memberTiers !== 'object' || Array.isArray(patch.memberTiers)) {
        throw new ModelTierError(400, 'memberTiers is { "<memberId>": "strong"|"mid"|"weak"|"" }');
      }
      for (const [memberId, tier] of Object.entries(patch.memberTiers as Record<string, unknown>)) {
        const m = team.members.find((x) => x.id === memberId);
        if (!m) throw new ModelTierError(400, `No member ${memberId} in this team`);
        if (tier === '' || tier === null) delete m.tier;
        else if (isModelTier(tier)) m.tier = tier;
        else throw new ModelTierError(400, `Invalid tier for ${m.name}: use strong, mid or weak`);
      }
    }
    team.updatedAt = this.now().toISOString();
    await this.deps.saveTeam(team);
    return this.settings(teamId);
  }

  // ------------------------------------------------------------------ review

  /**
   * Build the usage report of a team.
   *
   * @param teamId - Team id
   * @returns Report
   */
  async report(teamId: string): Promise<TeamTierReport> {
    const team = await this.team(teamId);
    return buildTierReport({ team, forEachEvent: this.deps.forEachEvent, workItems: await this.deps.workItems(), now: this.now() });
  }

  /**
   * Send the team lead its review: the report and what to do with it.
   *
   * @param teamId - Team id
   * @param trigger - `weekly` (tick) or `on_demand` (owner / API)
   * @returns The review id and the lead it went to
   * @throws ModelTierError 404 unknown team, 409 no lead / a proposal still waits for the owner
   */
  async startReview(teamId: string, trigger: 'weekly' | 'on_demand'): Promise<{ reviewId: string; lead: string; delivered: boolean }> {
    const team = await this.team(teamId);
    const lead = getTeamLeads(team)[0];
    if (!lead || !sessionOf(lead)) throw new ModelTierError(409, `${team.name} has no team lead to review its usage`);
    const state = await this.deps.store.get(teamId);
    await this.refreshOpenDecision(teamId, state);
    if (state.openDecisionId) throw new ModelTierError(409, `The last tier proposal (${state.openDecisionId}) still waits for the owner`);
    const report = buildTierReport({ team, forEachEvent: this.deps.forEachEvent, workItems: await this.deps.workItems(), now: this.now() });
    const reviewId = `TR-${randomUUID().slice(0, 8)}`;
    const at = this.now().toISOString();
    await this.deps.store.update(teamId, (s) => ({
      ...s,
      lastReviewAt: at,
      lastReviewTrigger: trigger,
      draft: { reviewId, askerSession: sessionOf(lead), startedAt: at, updatedAt: at, changes: [], routing: [] },
    }));
    const delivered = await this.deps.deliverToAgent(sessionOf(lead), this.reviewMessage(team, report, reviewId, trigger)).catch(() => false);
    this.deps.logger?.info('Model tier review sent to the team lead', { teamId, lead: sessionOf(lead), reviewId, trigger, delivered });
    return { reviewId, lead: lead.name, delivered };
  }

  /**
   * The review message for the lead.
   *
   * @param team - Team
   * @param report - Usage report
   * @param reviewId - Review id
   * @param trigger - Why now
   * @returns Text
   */
  reviewMessage(team: Team, report: TeamTierReport, reviewId: string, trigger: 'weekly' | 'on_demand'): string {
    const skill = `bash ${this.deps.tlSkillsPath}/propose-tier-change/execute.sh`;
    const rules = team.tierRoutingRules?.length ? `\nRouting rules in force: ${team.tierRoutingRules.map((r) => `"${r}"`).join('; ')}.` : '';
    const auto = leadChangesTiersItself(team);
    const who = auto ? 'you decide: your changes apply as soon as you submit, and the owner is told and can undo them' : 'the owner approves every change';
    const send = auto
      ? `4. Send it: ${skill} --submit. The changes apply at once: idle members restart on their new model, busy ones switch at their next start, and the owner gets one notice with Undo. If nothing should change, still run --submit (nothing is posted).`
      : `4. Send it: ${skill} --submit. One card goes to the owner; nothing changes until the owner says yes. If nothing should change, still run --submit (no card is posted).`;
    return [
      `[MODEL TIER REVIEW] ${trigger === 'weekly' ? 'Weekly' : 'Requested'} usage review for team ${team.name} (${reviewId}). "Optimize usage" is on; ${who}.`,
      '',
      renderTierReport(report),
      rules,
      '',
      'Do this now (a few minutes, no long analysis):',
      '1. For each member, decide whether its work needs its tier. strong = hard reasoning, design, reviewing others. mid = normal implementation and writing. weak = routine work: polling, checks, formatting, sorting, first-pass triage, summaries.',
      `2. Propose a change for each member that should move: ${skill} --member "<name>" --tier weak --reason "<the work it does and why the tier fits>"`,
      `3. Propose routing rules for incoming work: ${skill} --routing "polling / formatting / sorting -> <member>"`,
      send,
      'Do not lower a member whose work was often sent back, and do not lower yourself below mid.',
    ].join('\n');
  }

  // ---------------------------------------------------------------- proposals

  /**
   * The lead's skill call: add a change or a routing rule to the draft,
   * submit it, or drop it.
   *
   * @param callerSession - The calling agent (must lead a team)
   * @param input - One of member+tier+reason, routing, submit, clear
   * @returns What happened
   * @throws ModelTierError 400 bad input, 403 not a lead, 409 toggle off / nothing to submit
   */
  async propose(callerSession: string | undefined, input: ProposalInput): Promise<Record<string, unknown>> {
    const ctx = await this.leadContext(callerSession);
    if (input.clear === true) {
      await this.deps.store.update(ctx.team.id, (s) => ({ ...s, draft: undefined }));
      return { cleared: true };
    }
    if (input.submit === true) return this.submit(ctx);
    if (ctx.team.optimizeUsage !== true) {
      throw new ModelTierError(409, `"Optimize usage" is off for ${ctx.team.name}. Tier proposals are only made while it is on; the owner turns it on in the team settings.`);
    }
    if (input.routing !== undefined) {
      const rule = oneLine(input.routing);
      if (!rule) throw new ModelTierError(400, 'routing is one rule, e.g. "polling / formatting / sorting -> Ella"');
      const draft = await this.updateDraft(ctx, (d) => {
        if (!d.routing.includes(rule)) d.routing.push(rule);
        if (d.routing.length > C.MAX_ROUTING_RULES) throw new ModelTierError(400, `At most ${C.MAX_ROUTING_RULES} routing rules per proposal`);
      });
      return { added: 'routing', rule, draft: summarizeDraft(draft) };
    }
    const memberRef = oneLine(input.member, 100);
    if (!memberRef) throw new ModelTierError(400, 'member is the member name (or id) to move');
    if (!isModelTier(input.tier)) throw new ModelTierError(400, 'tier is strong, mid or weak');
    const reason = oneLine(input.reason);
    if (!reason) throw new ModelTierError(400, 'reason is required: the work this member does and why the tier fits');
    const lower = memberRef.toLowerCase();
    const member = ctx.team.members.find((m) => m.role !== 'orchestrator' && (m.id === memberRef || m.name.toLowerCase() === lower || sessionOf(m) === memberRef));
    if (!member) throw new ModelTierError(400, `No member "${memberRef}" in ${ctx.team.name}`);
    const to = input.tier;
    if (member.id === ctx.lead.id && tierRank(to) < tierRank('mid')) throw new ModelTierError(400, 'A team lead stays at mid or above');
    const entry = this.entryFor(ctx.team, member, to, reason);
    if (entry.from === to && !entry.clearsModelId) throw new ModelTierError(409, `${member.name} is already on ${to}`);
    const draft = await this.updateDraft(ctx, (d) => {
      d.changes = d.changes.filter((c) => c.memberId !== member.id);
      d.changes.push(entry);
    });
    return { added: 'change', change: `${member.name}: ${tierLabel(entry.from, entry.fromModel)} -> ${tierLabel(to, entry.toModel)}`, draft: summarizeDraft(draft) };
  }

  /** A change entry for a member moving to `to`. */
  private entryFor(team: Team, member: TeamMember, to: ModelTier, reason: string): TierChangeEntry {
    const runtime = member.runtimeType ?? RUNTIME_TYPES.CLAUDE_CODE;
    const fromModel = effectiveMemberModelId(team, { ...member, runtimeType: runtime }) ?? 'runtime default';
    const toModel = resolveTierModel(runtime, to, team.tierModels) ?? 'runtime default';
    return {
      memberId: member.id,
      memberName: member.name,
      session: sessionOf(member),
      from: member.tier ?? null,
      to,
      fromModel,
      toModel,
      ...(member.modelId ? { clearsModelId: member.modelId } : {}),
      reason,
    };
  }

  private async updateDraft(ctx: LeadContext, change: (d: TierDraft) => void): Promise<TierDraft> {
    const at = this.now().toISOString();
    let error: unknown;
    const state = await this.deps.store.update(ctx.team.id, (s) => {
      const draft: TierDraft = s.draft
        ? { ...s.draft, changes: [...s.draft.changes], routing: [...s.draft.routing] }
        : { reviewId: `TR-${randomUUID().slice(0, 8)}`, askerSession: sessionOf(ctx.lead), startedAt: at, updatedAt: at, changes: [], routing: [] };
      try {
        change(draft);
      } catch (err) {
        error = err;
        return s;
      }
      draft.updatedAt = at;
      return { ...s, draft };
    });
    if (error) throw error;
    return state.draft!;
  }

  private async submit(ctx: LeadContext): Promise<Record<string, unknown>> {
    // The hourly auto-submit and the lead's own --submit can overlap; one wins.
    if (this.submitting.has(ctx.team.id)) throw new ModelTierError(409, 'This review is being submitted already');
    this.submitting.add(ctx.team.id);
    try {
      return await this.submitOnce(ctx);
    } finally {
      this.submitting.delete(ctx.team.id);
    }
  }

  private async submitOnce(ctx: LeadContext): Promise<Record<string, unknown>> {
    const state = await this.deps.store.get(ctx.team.id);
    const draft = state.draft;
    if (!draft || (draft.changes.length === 0 && draft.routing.length === 0)) {
      await this.deps.store.update(ctx.team.id, (s) => ({ ...s, draft: undefined }));
      return { submitted: false, note: 'No changes proposed; nothing goes to the owner. The review is closed.' };
    }
    await this.refreshOpenDecision(ctx.team.id, state);
    if (state.openDecisionId) throw new ModelTierError(409, `The last tier proposal (${state.openDecisionId}) still waits for the owner; add to it next review`);
    if (leadChangesTiersItself(ctx.team)) return this.applyNow(ctx, draft);
    const decision = await this.askOwner(ctx.team, ctx.lead, draft, 'review');
    await this.deps.store.update(ctx.team.id, (s) => ({ ...s, draft: undefined, openDecisionId: decision.id }));
    return { submitted: true, decisionId: decision.id, changes: draft.changes.length, routing: draft.routing.length, note: 'One card went to the owner. Nothing changes until the owner says yes; you will be told the answer.' };
  }

  /**
   * Auto mode: apply the lead's draft at once (the same apply path as the
   * owner's Apply), then post ONE notice where the card would go, whose Undo
   * puts back exactly these changes.
   *
   * @param ctx - The lead and its team
   * @param draft - The submitted draft
   * @returns What happened (for the skill output)
   */
  private async applyNow(ctx: LeadContext, draft: TierDraft): Promise<Record<string, unknown>> {
    if (!this.deps.decisions()) throw new ModelTierError(503, 'Owner notices are not running on this machine, so the change cannot be applied (the owner must be able to undo it).');
    const before = ctx.team.tierRoutingRules ?? [];
    const subject: TierChangeSubject = {
      teamId: ctx.team.id,
      teamName: ctx.team.name,
      reviewId: draft.reviewId,
      kind: 'review',
      changes: draft.changes,
      routing: draft.routing,
      askerSession: sessionOf(ctx.lead),
      askerName: ctx.lead.name,
    };
    // Priced before the apply: the estimate compares each member's current model with its new one.
    const saving = this.estimateSaving(ctx.team, draft.changes);
    const applied = await this.apply(subject, draft.reviewId);
    await this.deps.store.update(ctx.team.id, (s) => ({ ...s, draft: undefined }));
    const team = await this.team(ctx.team.id);
    const undo: TierChangeSubject = {
      ...subject,
      kind: 'undo',
      notice: 'applied',
      undoOf: draft.reviewId,
      changes: applied.map((c) => reverseEntry(c, team, 'the owner undid it')),
      routing: before.filter((r) => !(team.tierRoutingRules ?? []).includes(r)),
      removeRouting: draft.routing.filter((r) => !before.includes(r)),
    };
    let noticeId: string | null = null;
    try {
      noticeId = (await this.postNotice(team, ctx.lead, undo, applied, draft.routing, saving)).id;
    } catch (err) {
      this.deps.logger?.warn('Tier changes applied but the owner notice could not be posted', { teamId: team.id, error: err instanceof Error ? err.message : String(err) });
    }
    return {
      submitted: true,
      applied: true,
      changes: applied.length,
      routing: draft.routing.length,
      ...(noticeId ? { noticeId } : {}),
      note: `Applied now. ${RESTART_NOTE} ${noticeId ? 'The owner got one notice and can undo it.' : 'The owner notice could not be posted; tell the owner what you changed.'}`,
    };
  }

  /**
   * Post an auto-mode notice: the change already happened; its one action
   * (`APPLY_KEY`) applies `subject` — the undo. Default and plain "yes" = keep.
   *
   * @param team - Team
   * @param asker - The lead (its bot posts it, it gets the outcome)
   * @param subject - The undo the action applies
   * @param done - What happened (the lead's changes, or the guard's move back)
   * @param routing - Routing rules that went in (applied notices)
   * @param saving - Weekly saving estimate of the lead's changes, or null
   * @returns The notice decision
   */
  private async postNotice(team: Team, asker: TeamMember, subject: TierChangeSubject, done: TierChangeEntry[], routing: string[], saving: number | null): Promise<OwnerDecision> {
    const decisions = this.deps.decisions();
    if (!decisions) throw new ModelTierError(503, 'Owner notices are not running on this machine.');
    const reverted = subject.notice === 'reverted';
    const body: string[] = [];
    let question: string;
    let options: DecisionOption[];
    if (reverted) {
      const c = done[0];
      const m = subject.changes[0];
      question = `${c.memberName}'s work was sent back more often on the ${c.from} tier, so it was moved back to ${tierLabel(c.clearTier ? null : c.to, c.toModel)}.`;
      body.push(`${c.reason[0].toUpperCase()}${c.reason.slice(1)}.`);
      options = [
        { key: APPLY_KEY, label: 'Keep the lower tier', detail: `moves ${m.memberName} to ${m.to} again` },
        { key: KEEP_KEY, label: 'OK', detail: 'leave it moved back' },
      ];
    } else {
      const summary = done.map((c) => `${c.memberName} → ${targetLabel(c)}`).join(', ');
      question = summary ? `${asker.name} changed model tiers for ${team.name}: ${summary}.` : `${asker.name} set new work routing for ${team.name}.`;
      for (const c of done) {
        const fixed = c.clearsModelId ? ` (its fixed model \`${c.clearsModelId}\` was cleared)` : '';
        body.push(`• *${c.memberName}*: ${tierLabel(c.from, c.fromModel)} → ${tierLabel(c.clearTier ? null : c.to, c.toModel)}${fixed} — ${c.reason}`);
      }
      if (routing.length) body.push(`New work routing: ${routing.map((r) => `"${r}"`).join('; ')}`);
      if (saving !== null) body.push(`Estimated change: ${saving >= 0 ? 'saves' : 'adds'} about $${Math.abs(saving).toFixed(2)} a week at API list price (from the last ${C.REPORT_WINDOW_DAYS} days).`);
      options = [
        { key: APPLY_KEY, label: 'Undo', detail: 'puts these back as they were' },
        { key: KEEP_KEY, label: 'Keep', detail: 'nothing more to do' },
      ];
    }
    if (done.length) body.push('Idle members switch to the new model now; busy ones at their next start.');
    const channel = await this.deps.teamChannelOf?.(team.id).catch(() => null);
    return decisions.askPrebuilt({
      kind: C.DECISION_KIND,
      asker: sessionOf(asker),
      question,
      title: reverted ? `Model tiers — quality check, ${team.name}` : `Model tiers — ${team.name}`,
      body,
      options,
      defaultKey: KEEP_KEY,
      yesKey: KEEP_KEY,
      deadline: new Date(this.now().getTime() + C.NOTICE_DEADLINE_MS),
      tierChange: subject,
      ...(channel ? { place: { slackChannelId: channel } } : {}),
    });
  }

  /** Post the owner card for a draft (review) or a revert. */
  private async askOwner(team: Team, asker: TeamMember, draft: Pick<TierDraft, 'reviewId' | 'changes' | 'routing'>, kind: 'review' | 'revert', extraBody: string[] = []): Promise<OwnerDecision> {
    const decisions = this.deps.decisions();
    if (!decisions) throw new ModelTierError(503, 'Owner decision cards are not running on this machine, so the proposal cannot be sent.');
    const subject: TierChangeSubject = {
      teamId: team.id,
      teamName: team.name,
      reviewId: draft.reviewId,
      kind,
      changes: draft.changes,
      routing: draft.routing,
      askerSession: sessionOf(asker),
      askerName: asker.name,
    };
    const summary = draft.changes.map((c) => `${c.memberName} ${c.from ?? 'no tier'}→${targetLabel(c)}`).join(', ');
    const question =
      kind === 'revert'
        ? `Move ${summary.replace(/→/g, ' back to ')}? Quality dropped after the change.`
        : `Change model tiers for ${team.name}? ${asker.name} proposes${summary ? `: ${summary}` : ' routing rules only'}.`;
    const body: string[] = [...extraBody];
    for (const c of draft.changes) {
      const fixed = c.clearsModelId ? ` (clears the fixed model \`${c.clearsModelId}\`)` : c.restoreModelId ? ` (restores the fixed model \`${c.restoreModelId}\`)` : '';
      body.push(`• *${c.memberName}*: ${tierLabel(c.from, c.fromModel)} → ${tierLabel(c.clearTier ? null : c.to, c.toModel)}${fixed} — ${c.reason}`);
    }
    if (draft.routing.length) body.push(`Routing: ${draft.routing.map((r) => `"${r}"`).join('; ')}`);
    const saving = kind === 'review' ? this.estimateSaving(team, draft.changes) : null;
    if (saving !== null) body.push(`Estimated change: ${saving >= 0 ? 'saves' : 'adds'} about $${Math.abs(saving).toFixed(2)} a week at API list price (from the last ${C.REPORT_WINDOW_DAYS} days).`);
    body.push('On Apply, idle members switch to the new model right away; busy ones at their next start.');
    const options: DecisionOption[] = [
      { key: APPLY_KEY, label: kind === 'revert' ? 'Move back' : 'Apply', detail: 'idle members switch now, busy ones at their next start' },
      { key: KEEP_KEY, label: 'Keep as is', detail: 'nothing changes' },
    ];
    const channel = await this.deps.teamChannelOf?.(team.id).catch(() => null);
    return decisions.askPrebuilt({
      kind: C.DECISION_KIND,
      asker: sessionOf(asker),
      question,
      title: kind === 'revert' ? `Model tiers — quality check, ${team.name}` : `Model tiers — ${team.name}`,
      body,
      options,
      defaultKey: KEEP_KEY,
      yesKey: APPLY_KEY,
      deadline: new Date(this.now().getTime() + C.DECISION_DEADLINE_MS),
      tierChange: subject,
      ...(channel ? { place: { slackChannelId: channel } } : {}),
    });
  }

  /**
   * Weekly USD difference of a set of changes at list price, from each
   * member's cost over the report window scaled by the output-price ratio of
   * its new model to its current one. Null when nothing can be priced.
   */
  private estimateSaving(team: Team, changes: TierChangeEntry[]): number | null {
    const report = buildTierReport({ team, forEachEvent: this.deps.forEachEvent, workItems: [], now: this.now() });
    let total = 0;
    let priced = false;
    for (const c of changes) {
      const row = report.rows.find((r) => r.memberId === c.memberId);
      if (!row || row.costUsd <= 0) continue;
      const fromModel = this.priceableModel(row.runtime, c.fromModel, team);
      const toModel = this.priceableModel(row.runtime, c.toModel, team);
      if (!fromModel || !toModel) continue;
      const ratio = resolveRate(toModel).output / resolveRate(fromModel).output;
      if (!Number.isFinite(ratio)) continue;
      total += row.costUsd * (1 - ratio);
      priced = true;
    }
    return priced ? Math.round(total * 100) / 100 : null;
  }

  /** A model name the pricing table can read ("runtime default" → the runtime's strong model). */
  private priceableModel(runtime: string, model: string | undefined, team: Team): string | null {
    if (!model) return null;
    if (model !== 'runtime default') return model;
    return tierMapFor(runtime, team.tierModels).strong ?? null;
  }

  private async leadContext(callerSession: string | undefined): Promise<LeadContext> {
    if (!callerSession) throw new ModelTierError(403, 'Only a team lead proposes tier changes (no agent identity on this call)');
    for (const team of await this.deps.getTeams()) {
      if (team.archived) continue;
      const me = (team.members ?? []).find((m) => sessionOf(m) === callerSession || m.sessionName === callerSession);
      if (me && isTeamLead(team, me)) return { team, lead: me };
    }
    throw new ModelTierError(403, 'Only a team lead proposes tier changes for its team');
  }

  /** Clear `openDecisionId` when that decision is no longer open. */
  private async refreshOpenDecision(teamId: string, state: TeamTierState): Promise<void> {
    if (!state.openDecisionId) return;
    const d = await this.deps.decisions()?.get(state.openDecisionId).catch(() => null);
    if (d && d.status === 'open') return;
    if (!d && !this.deps.decisions()) return;
    state.openDecisionId = undefined;
    await this.deps.store.update(teamId, (s) => ({ ...s, openDecisionId: undefined }));
  }

  // ------------------------------------------------------------------- apply

  /**
   * A tier decision settled: on the owner's yes apply the tiers (and routing
   * rules); otherwise nothing changes. Returns the note for the lead.
   *
   * @param decision - The settled decision
   * @returns Note for the asking lead, or null
   */
  async onSettled(decision: OwnerDecision): Promise<string | null> {
    const s = decision.tierChange;
    if (!s) return null;
    await this.deps.store.update(s.teamId, (st) => (st.openDecisionId === decision.id ? { ...st, openDecisionId: undefined } : st));
    if (s.notice) return this.onNoticeSettled(decision, s);
    if (decision.status !== 'resolved' || decision.chosenKey !== APPLY_KEY) {
      if (s.kind === 'revert') return `[MODEL TIERS] The owner kept the lower tier (${decision.id}). Nothing changed.`;
      return `[MODEL TIERS] The owner kept the tiers as they are (${decision.id}). Nothing changed; do not propose the same change again this week.`;
    }
    try {
      const applied = await this.apply(s, decision.id);
      const lines = applied.map((c) => `${c.memberName} → ${tierLabel(c.clearTier ? null : c.to, c.toModel)}`);
      const routing = s.routing.length ? ` Routing rules now in force: ${s.routing.map((r) => `"${r}"`).join('; ')}. Route new work by them.` : '';
      return `[MODEL TIERS] The owner approved ${decision.id}: ${lines.join(', ') || 'routing rules only'}. ${RESTART_NOTE}${routing}`;
    } catch (err) {
      this.deps.logger?.warn('Applying tier changes failed', { decisionId: decision.id, error: String(err) });
      return `[MODEL TIERS] The owner approved ${decision.id}, but applying it failed (${err instanceof Error ? err.message : String(err)}). Tell the owner.`;
    }
  }

  /**
   * An auto-mode notice settled: its one action undoes what the notice is
   * about; anything else (Keep, the deadline, skip) leaves it as it is.
   *
   * @param decision - The settled notice
   * @param s - Its subject (the undo)
   * @returns Note for the lead, or null
   */
  private async onNoticeSettled(decision: OwnerDecision, s: TierChangeSubject): Promise<string | null> {
    if (decision.status !== 'resolved' || decision.chosenKey !== APPLY_KEY) return null;
    try {
      const applied = await this.apply(s, decision.id);
      const lines = applied.map((c) => `${c.memberName} → ${tierLabel(c.clearTier ? null : c.to, c.toModel)}`);
      const skipped = s.changes.length - applied.length;
      const skippedNote = skipped > 0 ? ` ${skipped} member(s) were left as they are: their tier changed again since.` : '';
      if (s.notice === 'reverted') {
        return `[MODEL TIERS] The owner chose to keep the lower tier after the quality check: ${lines.join(', ') || 'nothing to change'}. It is not watched again.${skippedNote} ${RESTART_NOTE}`;
      }
      const routing = s.removeRouting?.length ? ` Routing rules removed: ${s.removeRouting.map((r) => `"${r}"`).join('; ')}.` : '';
      return `[MODEL TIERS] The owner undid your tier changes: ${lines.join(', ') || 'routing rules only'}.${routing}${skippedNote} Do not make the same change again this week. ${RESTART_NOTE}`;
    } catch (err) {
      this.deps.logger?.warn('Undoing tier changes failed', { decisionId: decision.id, error: String(err) });
      return `[MODEL TIERS] The owner tapped Undo, but undoing failed (${err instanceof Error ? err.message : String(err)}). Tell the owner.`;
    }
  }

  /**
   * Apply a subject to the team (owner's Apply, the lead's change in auto
   * mode, an undo or a revert), record it for the guard, and restart idle
   * members whose model changed.
   *
   * An `undo` changes only members still on the tier it expects (`from`): a
   * member whose tier changed again since is left alone.
   *
   * @param s - Subject
   * @param decisionId - The approving decision, or the batch id of an auto apply
   * @returns The applied entries
   */
  async apply(s: TierChangeSubject, decisionId: string): Promise<TierChangeEntry[]> {
    const team = await this.team(s.teamId);
    const items = await this.deps.workItems().catch(() => [] as WorkItem[]);
    const now = this.now();
    const applied: AppliedTierChange[] = [];
    const modelChanged: string[] = [];
    // An undo puts back only members whose latest change is the one undone:
    // a later change (by the owner's card or another batch) wins.
    const latest = new Map<string, string>();
    if (s.kind === 'undo') for (const a of (await this.deps.store.get(s.teamId)).applied) latest.set(a.memberId, a.decisionId);
    for (const c of s.changes) {
      const m = team.members.find((x) => x.id === c.memberId);
      if (!m || m.role === 'orchestrator') continue;
      if (s.kind === 'undo' && ((m.tier ?? null) !== c.from || (s.undoOf && latest.get(m.id) !== s.undoOf))) continue;
      const runtime = m.runtimeType ?? RUNTIME_TYPES.CLAUDE_CODE;
      const modelBefore = effectiveMemberModelId(team, { ...m, runtimeType: runtime });
      // What the member had right now, not when the change was proposed: the
      // record (and the undo built from it) must put back this state.
      const tierBefore = m.tier ?? null;
      const fixedBefore = m.modelId;
      if (c.clearTier) delete m.tier;
      else m.tier = c.to;
      if (c.clearsModelId && m.modelId === c.clearsModelId) delete m.modelId;
      // Never overwrite a fixed model someone set after the change being reverted.
      if (c.restoreModelId && !m.modelId) m.modelId = c.restoreModelId;
      if (effectiveMemberModelId(team, { ...m, runtimeType: runtime }) !== modelBefore && sessionOf(m)) modelChanged.push(sessionOf(m));
      const actual: TierChangeEntry = { ...c, from: tierBefore, fromModel: modelBefore };
      delete actual.clearsModelId;
      if (fixedBefore && !m.modelId) actual.clearsModelId = fixedBefore;
      const lowered = !c.clearTier && tierRank(c.to) < tierRank(effectiveFromTier(actual, runtime, team.tierModels));
      applied.push({
        ...actual,
        appliedAt: now.toISOString(),
        decisionId,
        baseline: baselineBefore(items, memberLedgerKeys(m), now.getTime()),
        guard: lowered && s.kind === 'review' ? 'watching' : 'not_watched',
      });
    }
    // Removal first, so an undo can take its rules out and put back the ones they pushed out.
    if (s.removeRouting?.length) {
      const rules = (team.tierRoutingRules ?? []).filter((r) => !s.removeRouting!.includes(r));
      if (rules.length) team.tierRoutingRules = rules;
      else delete team.tierRoutingRules;
    }
    if (s.routing.length) {
      const rules = [...(team.tierRoutingRules ?? [])];
      for (const r of s.routing) if (!rules.includes(r)) rules.push(r);
      team.tierRoutingRules = rules.slice(-20);
    }
    team.updatedAt = now.toISOString();
    await this.deps.saveTeam(team);
    const undone = new Set(s.kind === 'undo' && s.undoOf ? applied.map((a) => a.memberId) : []);
    await this.deps.store.update(s.teamId, (st) => ({
      ...st,
      applied: [
        ...st.applied.map((a) => (a.decisionId === s.undoOf && undone.has(a.memberId) && a.guard !== 'auto_reverted' ? { ...a, guard: 'undone' as const, guardCheckedAt: now.toISOString() } : a)),
        ...applied,
      ],
    }));
    this.deps.logger?.info('Model tier changes applied', { teamId: s.teamId, decisionId, kind: s.kind, changes: applied.map((a) => `${a.memberName}:${a.to}`) });
    this.restartIdle(modelChanged);
    return applied;
  }

  /**
   * Restart, one after another in the background, each member whose model
   * changed and that is idle; busy or stopped members pick the model up at
   * their next start.
   *
   * @param sessions - Members whose effective model changed
   */
  private restartIdle(sessions: string[]): void {
    const restart = this.deps.restartIfIdle;
    if (!restart || !sessions.length) return;
    this.restarts = this.restarts.then(async () => {
      for (const session of new Set(sessions)) {
        const outcome = await restart(session).catch(() => 'failed' as const);
        this.deps.logger?.info('Model tier change: restart of an idle member', { session, outcome });
      }
    });
  }

  /**
   * Resolves once the restarts scheduled so far are done (tests, shutdown).
   *
   * @returns Promise
   */
  restartsSettled(): Promise<void> {
    return this.restarts;
  }

  // -------------------------------------------------------------------- tick

  /**
   * Hourly: start due weekly reviews, send drafts the lead never submitted,
   * and run the quality guard.
   *
   * @returns What it did (for tests / logs)
   */
  async tick(): Promise<{ reviews: string[]; autoSubmitted: string[]; reverts: string[] }> {
    const out = { reviews: [] as string[], autoSubmitted: [] as string[], reverts: [] as string[] };
    if (this.ticking) return out;
    this.ticking = true;
    try {
      const teams = await this.deps.getTeams();
      const states = await this.deps.store.all();
      const nowMs = this.now().getTime();
      for (const team of teams) {
        if (team.archived) continue;
        const state = states[team.id] ?? { applied: [] };
        try {
          if (state.applied.some((a) => a.guard === 'watching')) {
            out.reverts.push(...(await this.guard(team)));
          }
          if (team.optimizeUsage !== true || team.paused) continue;
          if (state.draft && nowMs - Date.parse(state.draft.updatedAt) >= C.DRAFT_AUTO_SUBMIT_MS) {
            const lead = team.members.find((m) => sessionOf(m) === state.draft!.askerSession) ?? getTeamLeads(team)[0];
            if (lead && (state.draft.changes.length || state.draft.routing.length)) {
              const r = await this.submit({ team, lead });
              if (r.submitted) out.autoSubmitted.push(team.id);
            } else {
              await this.deps.store.update(team.id, (s) => ({ ...s, draft: undefined }));
            }
            continue;
          }
          const due = !state.lastReviewAt || nowMs - Date.parse(state.lastReviewAt) >= C.REVIEW_INTERVAL_DAYS * DAY_MS;
          if (due && !state.draft) {
            await this.refreshOpenDecision(team.id, state);
            if (state.openDecisionId) continue;
            const r = await this.startReview(team.id, 'weekly');
            out.reviews.push(r.reviewId);
          }
        } catch (err) {
          this.deps.logger?.warn('Model tier tick failed for a team', { teamId: team.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
    } finally {
      this.ticking = false;
    }
    return out;
  }

  /**
   * Auto mode: move a member whose work got worse back at once (the revert
   * the approve-mode card would apply), tell the lead, and post the owner a
   * notice whose one action — "Keep the lower tier" — undoes the move back.
   *
   * @param team - Team
   * @param lead - Its lead (posts the notice)
   * @param a - The watched change
   * @param back - The reverse entry
   * @returns The notice id, or null when it could not be posted / nothing moved
   */
  private async autoRevert(team: Team, lead: TeamMember, a: AppliedTierChange, back: TierChangeEntry): Promise<string | null> {
    const batch = `TG-${randomUUID().slice(0, 8)}`;
    const subject: TierChangeSubject = {
      teamId: team.id,
      teamName: team.name,
      reviewId: batch,
      kind: 'revert',
      changes: [back],
      routing: [],
      askerSession: sessionOf(lead),
      askerName: lead.name,
    };
    const done = await this.apply(subject, batch);
    if (!done.length) return null;
    const forward: TierChangeEntry = {
      memberId: a.memberId,
      memberName: a.memberName,
      session: a.session,
      from: back.clearTier ? null : back.to,
      to: a.to,
      fromModel: back.toModel,
      toModel: a.toModel,
      ...(a.clearsModelId ? { clearsModelId: a.clearsModelId } : {}),
      reason: a.reason,
    };
    const undo: TierChangeSubject = { ...subject, kind: 'undo', notice: 'reverted', undoOf: batch, changes: [forward] };
    let id: string | null = null;
    try {
      id = (await this.postNotice(await this.team(team.id), lead, undo, done, [], null)).id;
    } catch (err) {
      this.deps.logger?.warn('Member moved back, but the owner notice could not be posted', { teamId: team.id, member: a.memberName, error: String(err) });
    }
    const to = tierLabel(back.clearTier ? null : back.to, back.toModel);
    await this.deps
      .deliverToAgent(
        sessionOf(lead),
        `[MODEL TIERS] Quality check: ${a.memberName}'s work was sent back more often on ${a.to} (${back.reason}), so it was moved back to ${to}. The owner was told and can keep the lower tier. Do not lower ${a.memberName} again this month unless its work changes. ${RESTART_NOTE}`,
      )
      .catch(() => false);
    return id;
  }

  /**
   * Quality guard for one team: judge every watched (lowered) member and ask
   * the owner to move back the ones whose work got worse.
   *
   * @param team - Team
   * @returns Revert decision ids
   */
  async guard(team: Team): Promise<string[]> {
    const state = await this.deps.store.get(team.id);
    const watching = state.applied.filter((a) => a.guard === 'watching');
    if (!watching.length) return [];
    const items = await this.deps.workItems();
    const now = this.now();
    const reverts: string[] = [];
    const updates = new Map<string, Partial<AppliedTierChange>>();
    for (const a of watching) {
      const m = team.members.find((x) => x.id === a.memberId);
      const key = `${a.memberId}@${a.appliedAt}`;
      if (!m || m.tier !== a.to) {
        updates.set(key, { guard: 'ok', guardCheckedAt: now.toISOString() });
        continue;
      }
      const after = statsAfter(items, memberLedgerKeys(m), Date.parse(a.appliedAt));
      const verdict = judgeGuard(a.baseline, after);
      if (verdict === 'wait') {
        if (now.getTime() - Date.parse(a.appliedAt) > C.GUARD_MAX_DAYS * DAY_MS) updates.set(key, { guard: 'expired', guardCheckedAt: now.toISOString(), guardAfter: after });
        continue;
      }
      if (verdict === 'ok') {
        updates.set(key, { guard: 'ok', guardCheckedAt: now.toISOString(), guardAfter: after });
        continue;
      }
      const lead = getTeamLeads(team)[0];
      if (!lead) continue;
      const back = reverseEntry(a, team, `since moving to ${a.to}: ${describeStats(after)}; before: ${describeStats(a.baseline)}`);
      if (leadChangesTiersItself(team)) {
        try {
          const id = await this.autoRevert(team, lead, a, back);
          updates.set(key, { guard: 'auto_reverted', guardDecisionId: id ?? undefined, guardCheckedAt: now.toISOString(), guardAfter: after });
          reverts.push(id ?? `reverted:${m.name}`);
        } catch (err) {
          this.deps.logger?.warn('Quality guard could not move a member back', { teamId: team.id, member: m.name, error: String(err) });
        }
        continue;
      }
      try {
        const d = await this.askOwner(team, lead, { reviewId: `guard-${a.decisionId}`, changes: [back], routing: [] }, 'revert', [
          `${m.name} was moved to ${a.to}. Since then ${describeStats(after)}; before the change ${describeStats(a.baseline)}.`,
        ]);
        updates.set(key, { guard: 'revert_proposed', guardDecisionId: d.id, guardCheckedAt: now.toISOString(), guardAfter: after });
        reverts.push(d.id);
      } catch (err) {
        this.deps.logger?.warn('Quality guard could not ask the owner', { teamId: team.id, member: m.name, error: String(err) });
      }
    }
    if (updates.size) {
      await this.deps.store.update(team.id, (s) => ({
        ...s,
        applied: s.applied.map((a) => {
          const u = updates.get(`${a.memberId}@${a.appliedAt}`);
          return u && a.guard === 'watching' ? { ...a, ...u } : a;
        }),
      }));
    }
    return reverts;
  }
}

/**
 * The entry that puts a change back: from its target to the tier (and fixed
 * model) the member had before it.
 *
 * @param c - The change to reverse
 * @param team - Team (tier map)
 * @param reason - Why it is put back
 * @returns The reverse entry
 */
export function reverseEntry(c: TierChangeEntry, team: Pick<Team, 'members' | 'tierModels'>, reason: string): TierChangeEntry {
  const m = team.members.find((x) => x.id === c.memberId);
  const runtime = m?.runtimeType ?? RUNTIME_TYPES.CLAUDE_CODE;
  return {
    memberId: c.memberId,
    memberName: c.memberName,
    session: c.session,
    from: c.to,
    to: c.from ?? effectiveFromTier(c, runtime, team.tierModels),
    ...(c.from === null ? { clearTier: true } : {}),
    fromModel: c.toModel,
    toModel: c.fromModel,
    ...(c.clearsModelId ? { restoreModelId: c.clearsModelId } : {}),
    reason,
  };
}

/** "weak" / "no tier" for the target of a change. */
function targetLabel(c: TierChangeEntry): string {
  return c.clearTier ? 'no tier' : c.to;
}

/**
 * The tier a member effectively ran on before a change: its tier, else the
 * tier whose model it ran (a reviewed member on the Sonnet default = mid),
 * else strong (the runtime default is the strongest model).
 *
 * @param c - Change entry
 * @param runtime - The member's runtime
 * @param overrides - The team's tier map
 * @returns Tier
 */
export function effectiveFromTier(c: Pick<TierChangeEntry, 'from' | 'fromModel'>, runtime: string, overrides?: TeamTierModels): ModelTier {
  if (c.from) return c.from;
  const map = tierMapFor(runtime, overrides);
  const hit = (Object.keys(map) as ModelTier[]).find((t) => map[t] === c.fromModel);
  return hit ?? 'strong';
}

/** Short view of a draft for the skill output. */
function summarizeDraft(d: TierDraft): { reviewId: string; changes: string[]; routing: string[] } {
  return {
    reviewId: d.reviewId,
    changes: d.changes.map((c) => `${c.memberName}: ${c.from ?? 'no tier'} -> ${c.to}`),
    routing: d.routing,
  };
}

/** Process-wide instance (set by the wiring). */
let instance: ModelTierService | null = null;

/**
 * The running service, or null before it is wired.
 *
 * @returns Service
 */
export function getModelTierService(): ModelTierService | null {
  return instance;
}

/**
 * Install (or clear) the running service.
 *
 * @param s - Service
 */
export function setModelTierService(s: ModelTierService | null): void {
  instance = s;
}
