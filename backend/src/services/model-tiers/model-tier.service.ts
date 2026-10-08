/**
 * ModelTierService — model tiers and "Optimize usage" (crewly#1173 phase 1,
 * specs/2026-10-08-model-tiers.md).
 *
 * Recommendation mode: nothing here changes a member's tier on its own.
 *
 * 1. Review: weekly while a team has "Optimize usage" on (and on demand), the
 *    team lead gets a compact usage report per member and is asked to
 *    propose tier changes and task routing rules.
 * 2. Proposal: the lead adds changes with `propose-tier-change` and submits;
 *    ONE owner card per review carries them all (Apply / Keep as is).
 * 3. Apply: only the owner's yes applies the tiers (and clears a member's
 *    fixed model so the tier takes effect). Each member picks its new model up
 *    at its next start.
 * 4. Quality guard: a member moved down is watched over its next settled work
 *    items; when it is sent back clearly more often than before, a revert card
 *    goes to the owner (again only applied on yes).
 *
 * @module services/model-tiers/model-tier.service
 */

import { randomUUID } from 'crypto';
import { MODEL_TIER_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';
import type { ModelTier, Team, TeamMember, TeamTierModels } from '../../types/index.js';
import type { DecisionOption, OwnerDecision, TierChangeEntry, TierChangeSubject } from '../../types/decision.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { effectiveMemberModelId } from '../../utils/member-default-model.utils.js';
import { isModelTier, parseTierModels, resolveTierModel, tierMapFor, tierRank } from '../../utils/model-tier.utils.js';
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
  now?: () => Date;
  logger?: TierLogger;
}

/** What the dashboard shows and edits. */
export interface TierSettingsView {
  teamId: string;
  optimizeUsage: boolean;
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
    return [
      `[MODEL TIER REVIEW] ${trigger === 'weekly' ? 'Weekly' : 'Requested'} usage review for team ${team.name} (${reviewId}). "Optimize usage" is on; the owner approves every change.`,
      '',
      renderTierReport(report),
      rules,
      '',
      'Do this now (a few minutes, no long analysis):',
      '1. For each member, decide whether its work needs its tier. strong = hard reasoning, design, reviewing others. mid = normal implementation and writing. weak = routine work: polling, checks, formatting, sorting, first-pass triage, summaries.',
      `2. Propose a change for each member that should move: ${skill} --member "<name>" --tier weak --reason "<the work it does and why the tier fits>"`,
      `3. Propose routing rules for incoming work: ${skill} --routing "polling / formatting / sorting -> <member>"`,
      `4. Send it: ${skill} --submit. One card goes to the owner; nothing changes until the owner says yes. If nothing should change, still run --submit (no card is posted).`,
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
    const state = await this.deps.store.get(ctx.team.id);
    const draft = state.draft;
    if (!draft || (draft.changes.length === 0 && draft.routing.length === 0)) {
      await this.deps.store.update(ctx.team.id, (s) => ({ ...s, draft: undefined }));
      return { submitted: false, note: 'No changes proposed; nothing goes to the owner. The review is closed.' };
    }
    await this.refreshOpenDecision(ctx.team.id, state);
    if (state.openDecisionId) throw new ModelTierError(409, `The last tier proposal (${state.openDecisionId}) still waits for the owner; add to it next review`);
    const decision = await this.askOwner(ctx.team, ctx.lead, draft, 'review');
    await this.deps.store.update(ctx.team.id, (s) => ({ ...s, draft: undefined, openDecisionId: decision.id }));
    return { submitted: true, decisionId: decision.id, changes: draft.changes.length, routing: draft.routing.length, note: 'One card went to the owner. Nothing changes until the owner says yes; you will be told the answer.' };
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
    body.push('Applies at each member\'s next start.');
    const options: DecisionOption[] = [
      { key: APPLY_KEY, label: kind === 'revert' ? 'Move back' : 'Apply', detail: 'takes effect at each member\'s next start' },
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
    if (decision.status !== 'resolved' || decision.chosenKey !== APPLY_KEY) {
      if (s.kind === 'revert') return `[MODEL TIERS] The owner kept the lower tier (${decision.id}). Nothing changed.`;
      return `[MODEL TIERS] The owner kept the tiers as they are (${decision.id}). Nothing changed; do not propose the same change again this week.`;
    }
    try {
      const applied = await this.apply(s, decision.id);
      const lines = applied.map((c) => `${c.memberName} → ${tierLabel(c.clearTier ? null : c.to, c.toModel)}`);
      const routing = s.routing.length ? ` Routing rules now in force: ${s.routing.map((r) => `"${r}"`).join('; ')}. Route new work by them.` : '';
      return `[MODEL TIERS] The owner approved ${decision.id}: ${lines.join(', ') || 'routing rules only'}. Each member picks up its new model at its next start; to apply now, stop-agent + start-agent a member while it is idle.${routing}`;
    } catch (err) {
      this.deps.logger?.warn('Applying tier changes failed', { decisionId: decision.id, error: String(err) });
      return `[MODEL TIERS] The owner approved ${decision.id}, but applying it failed (${err instanceof Error ? err.message : String(err)}). Tell the owner.`;
    }
  }

  /**
   * Apply an approved subject to the team and record it for the guard.
   *
   * @param s - Subject
   * @param decisionId - The approving decision
   * @returns The applied entries
   */
  async apply(s: TierChangeSubject, decisionId: string): Promise<TierChangeEntry[]> {
    const team = await this.team(s.teamId);
    const items = await this.deps.workItems().catch(() => [] as WorkItem[]);
    const now = this.now();
    const applied: AppliedTierChange[] = [];
    for (const c of s.changes) {
      const m = team.members.find((x) => x.id === c.memberId);
      if (!m) continue;
      if (c.clearTier) delete m.tier;
      else m.tier = c.to;
      if (c.clearsModelId && m.modelId === c.clearsModelId) delete m.modelId;
      if (c.restoreModelId) m.modelId = c.restoreModelId;
      const lowered = !c.clearTier && tierRank(c.to) < tierRank(effectiveFromTier(c, m.runtimeType ?? RUNTIME_TYPES.CLAUDE_CODE, team.tierModels));
      applied.push({
        ...c,
        appliedAt: now.toISOString(),
        decisionId,
        baseline: baselineBefore(items, memberLedgerKeys(m), now.getTime()),
        guard: lowered && s.kind === 'review' ? 'watching' : 'not_watched',
      });
    }
    if (s.routing.length) {
      const rules = [...(team.tierRoutingRules ?? [])];
      for (const r of s.routing) if (!rules.includes(r)) rules.push(r);
      team.tierRoutingRules = rules.slice(-20);
    }
    team.updatedAt = now.toISOString();
    await this.deps.saveTeam(team);
    await this.deps.store.update(s.teamId, (st) => ({ ...st, applied: [...st.applied, ...applied] }));
    this.deps.logger?.info('Model tier changes applied', { teamId: s.teamId, decisionId, changes: applied.map((a) => `${a.memberName}:${a.to}`) });
    return applied;
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
      const back: TierChangeEntry = {
        memberId: m.id,
        memberName: m.name,
        session: sessionOf(m),
        from: a.to,
        to: a.from ?? effectiveFromTier(a, m.runtimeType ?? RUNTIME_TYPES.CLAUDE_CODE, team.tierModels),
        ...(a.from === null ? { clearTier: true } : {}),
        fromModel: a.toModel,
        toModel: a.fromModel,
        ...(a.clearsModelId ? { restoreModelId: a.clearsModelId } : {}),
        reason: `since moving to ${a.to}: ${describeStats(after)}; before: ${describeStats(a.baseline)}`,
      };
      try {
        const d = await this.askOwner(team, lead, { reviewId: `guard-${a.decisionId}`, changes: [back], routing: [] }, 'revert', [
          `${m.name} was moved to ${a.to} in ${a.decisionId}. Since then ${describeStats(after)}; before the change ${describeStats(a.baseline)}.`,
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
