/**
 * Daily autopilot retro, pure parts (specs/2026-10-03-autopilot-experiments.md §4):
 * the brief the driver gets, the retro input contract, the wiki page, and
 * the harness-gap dedupe. Also the weekly cross-team retro the orchestrator
 * files over the week's daily retros (#985).
 *
 * @module services/project-tickets/ticket-autopilot-retro
 */

import { TICKET_AUTOPILOT_CONSTANTS } from '../../constants.js';
import type { AutopilotDayStats, AutopilotPeriodStats } from './ticket-autopilot-stats.js';
import type { StallCause, TraceMetricsSummary } from '../trace/trace-metrics.js';
import type { ProjectTicketService } from './project-ticket.service.js';
import type { RetroMilestone } from './ticket-autopilot-goal.js';
import type { ExperimentProcessSummary } from '../../types/experiment.types.js';

/** A problem class. */
export type RetroClass = 'agent_judgment' | 'missing_skill' | 'harness_gap' | 'owner_dependency';

/** One problem the retro found. */
export interface RetroProblem {
  class: RetroClass;
  title: string;
  detail?: string;
  /** Trace ids / ticket ids / event lines that show it */
  evidence?: string;
}

/** A validated retro. */
export interface RetroInput {
  day: string;
  summary: string;
  problems: RetroProblem[];
}

/** Words for the problem classes. */
export const RETRO_CLASS_LABELS: Record<RetroClass, string> = {
  agent_judgment: 'Agent judgment',
  missing_skill: 'Missing skill',
  harness_gap: 'Harness gap',
  owner_dependency: 'Owner dependency',
};

/** Words for the stall causes (same as the run timeline). */
const STALL_WORDS: Record<StallCause, string> = {
  runtime_quota: 'runtime out of usage / signed out',
  delivery_failure: 'a message was not delivered',
  waiting_on_owner: 'waiting on the owner',
  waiting_on_agent: 'waiting on an agent',
  nobody_pushing: 'nobody pushing',
};

/** A retro input error (HTTP 400). */
export class RetroInputError extends Error {
  /**
   * @param message - What is wrong
   */
  constructor(message: string) {
    super(message);
    this.name = 'RetroInputError';
  }
}

/**
 * Validate a retro submission.
 *
 * @param raw - Request body
 * @returns The retro
 * @throws RetroInputError with what to fix
 */
export function validateRetroInput(raw: unknown): RetroInput {
  if (!raw || typeof raw !== 'object') throw new RetroInputError('Body must be {day, summary, problems: [{class, title, detail?, evidence?}]}');
  const b = raw as Record<string, unknown>;
  const day = typeof b.day === 'string' ? b.day.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RetroInputError('day must be the reviewed day, YYYY-MM-DD');
  return { day, ...validateRetroCore(b) };
}

/** A validated weekly cross-team retro (#985). */
export interface WeeklyRetroInput {
  /** ISO week reviewed, `YYYY-Www` */
  week: string;
  summary: string;
  problems: RetroProblem[];
}

/**
 * Validate a weekly retro submission.
 *
 * @param raw - Request body
 * @returns The retro
 * @throws RetroInputError with what to fix
 */
export function validateWeeklyRetroInput(raw: unknown): WeeklyRetroInput {
  if (!raw || typeof raw !== 'object') throw new RetroInputError('Body must be {week, summary, problems: [{class, title, detail?, evidence?}]}');
  const b = raw as Record<string, unknown>;
  const week = typeof b.week === 'string' ? b.week.trim() : '';
  if (!/^\d{4}-W\d{2}$/.test(week)) throw new RetroInputError('week must be the reviewed ISO week, YYYY-Www (e.g. 2026-W44)');
  return { week, ...validateRetroCore(b) };
}

/**
 * The summary and problems shared by the daily and the weekly retro.
 *
 * @param b - Request body
 * @returns Summary and problems
 * @throws RetroInputError with what to fix
 */
function validateRetroCore(b: Record<string, unknown>): { summary: string; problems: RetroProblem[] } {
  const C = TICKET_AUTOPILOT_CONSTANTS;
  const summary = typeof b.summary === 'string' ? b.summary.trim() : '';
  if (summary.length < 20) throw new RetroInputError('summary is required: what shipped, where it stalled and why (a few lines)');
  if (summary.length > C.RETRO_SUMMARY_MAX_CHARS) throw new RetroInputError(`summary is too long (max ${C.RETRO_SUMMARY_MAX_CHARS} characters)`);
  const list = b.problems === undefined ? [] : b.problems;
  if (!Array.isArray(list)) throw new RetroInputError('problems must be a list');
  if (list.length > C.RETRO_MAX_PROBLEMS) throw new RetroInputError(`at most ${C.RETRO_MAX_PROBLEMS} problems`);
  const problems: RetroProblem[] = list.map((p, i) => {
    if (!p || typeof p !== 'object') throw new RetroInputError(`problem ${i + 1} must be {class, title, detail?, evidence?}`);
    const r = p as Record<string, unknown>;
    const cls = typeof r.class === 'string' ? r.class.trim() : '';
    if (!C.RETRO_CLASSES.includes(cls)) throw new RetroInputError(`problem ${i + 1}: class must be one of ${C.RETRO_CLASSES.join(', ')}`);
    const title = typeof r.title === 'string' ? r.title.replace(/\s+/g, ' ').trim() : '';
    if (title.length < C.RETRO_TITLE_MIN_CHARS || title.length > C.RETRO_TITLE_MAX_CHARS) {
      throw new RetroInputError(`problem ${i + 1}: title must be ${C.RETRO_TITLE_MIN_CHARS}-${C.RETRO_TITLE_MAX_CHARS} characters`);
    }
    const detail = typeof r.detail === 'string' && r.detail.trim() ? r.detail.trim().slice(0, C.RETRO_DETAIL_MAX_CHARS) : undefined;
    const evidence = typeof r.evidence === 'string' && r.evidence.trim() ? r.evidence.trim().slice(0, C.RETRO_DETAIL_MAX_CHARS) : undefined;
    return { class: cls as RetroClass, title, ...(detail ? { detail } : {}), ...(evidence ? { evidence } : {}) };
  });
  return { summary, problems };
}

/**
 * Milliseconds in words ("2h 10m", "45m", "30s").
 *
 * @param ms - Duration
 * @returns Text
 */
export function durationWords(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.round(ms / 1000)}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 48) return rest ? `${h}h ${rest}m` : `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * USD in words.
 *
 * @param usd - Dollars
 * @returns "$1.23"
 */
export function usdWords(usd: number): string {
  return `$${(Math.round(usd * 100) / 100).toFixed(2)}`;
}

/**
 * Tokens in words.
 *
 * @param n - Tokens
 * @returns "1.2M" / "34k" / "900"
 */
export function tokenWords(n: number): string {
  if (n >= 1_000_000) return `${(Math.round(n / 100_000) / 10).toString()}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

/**
 * The top stall causes of a period, longest first.
 *
 * @param s - Period stats
 * @param max - How many
 * @returns e.g. ["waiting on the owner: 2 (3h 5m)"]
 */
export function topStallCauses(s: AutopilotPeriodStats, max = 3): string[] {
  return (Object.entries(s.stalls.byCause) as Array<[StallCause, { count: number; ms: number }]>)
    .filter(([, v]) => v.count > 0)
    .sort((a, b) => b[1].ms - a[1].ms || b[1].count - a[1].count)
    .slice(0, max)
    .map(([cause, v]) => `${STALL_WORDS[cause]}: ${v.count} (${durationWords(v.ms)})`);
}

/**
 * A period's numbers as a few short lines.
 *
 * @param s - Period stats
 * @returns Lines
 */
export function statsLines(s: AutopilotPeriodStats): string[] {
  const lines = [
    `Tickets: ${s.triaged} triaged, ${s.started} started, ${s.done} done, ${s.verified} verified, ${s.sentBack} sent back, ${s.stalled} stalled${s.replans ? `; ${s.replans} goal replan${s.replans === 1 ? '' : 's'}` : ''}`,
    `Cycle time: start → done median ${s.cycleTime.toDone.medianMs === null ? 'n/a' : durationWords(s.cycleTime.toDone.medianMs)}, start → verified median ${s.cycleTime.toVerified.medianMs === null ? 'n/a' : durationWords(s.cycleTime.toVerified.medianMs)}`,
    `Owner touches: ${s.ownerTouches.total} (answered ${s.ownerTouches.answered}, approved ${s.ownerTouches.approved}, sent back ${s.ownerTouches.sentBack}, corrected ${s.ownerTouches.corrected}, other ${s.ownerTouches.other})`,
    `Stalls: ${s.stalls.count} (${durationWords(s.stalls.totalMs)})${s.stalls.count > 0 ? ` — ${topStallCauses(s).join('; ')}` : ''}`,
    `Harness interventions: ${s.interventions.total} (nudges ${s.interventions.nudges}, redeliveries ${s.interventions.redeliveries}, wakes ${s.interventions.wakes}, corrections ${s.interventions.corrections}, refusals ${s.interventions.guardBlocks}, misroutes ${s.interventions.misroutes})`,
    `Cost: ${tokenWords(s.tokens)} tokens traced, ${usdWords(s.costUsd)}; team ledger ${tokenWords(s.budget.ledgerTokens)} of ${tokenWords(s.budget.dailyBudgetTokens)} budget (${Math.round(s.budget.pct * 100)}%)${s.pausedMs > 0 ? `; paused on the budget ${durationWords(s.pausedMs)}` : ''}`,
  ];
  return lines;
}

/**
 * One run of the day as the brief reviews it (#985: a retro per completed
 * run, inside the daily retro rather than as its own wake). The numbers are
 * the run's metrics summary; `review` is absent when the trace could not be read.
 */
export interface RetroTrace {
  traceId: string;
  title: string;
  review?: Pick<TraceMetricsSummary, 'state' | 'wallMs' | 'stallMs' | 'stallMsByCause' | 'rework' | 'interventions' | 'costUsd'>;
}

/** Input of {@link buildRetroBrief}. */
export interface RetroBriefInput {
  project: { id: string; name: string };
  day: string;
  stats: AutopilotDayStats;
  /**
   * Traces of the day: run trace first, then ticket traces with a title.
   * When `runTrace` is given, these are the ticket traces only.
   */
  traces: RetroTrace[];
  /** The day's run trace; null when the autopilot did nothing that day (a milestone day) */
  runTrace?: RetroTrace | null;
  /** Experiment cards closed / OKRs completed on the day (#985) */
  milestones?: RetroMilestone[];
}

/**
 * A process number, baseline → result ("4 → 6"); the result alone when the
 * baseline had no autopilot work.
 *
 * @param baseline - Baseline window (may be noData)
 * @param result - Result window
 * @param pick - The number, as words
 * @returns Words
 */
function processDelta(baseline: ExperimentProcessSummary | undefined, result: ExperimentProcessSummary, pick: (s: ExperimentProcessSummary) => string): string {
  return baseline && !baseline.noData ? `${pick(baseline)} → ${pick(result)}` : pick(result);
}

/**
 * One milestone as brief / wiki lines: a closed card with its verdict,
 * hypothesis, outcome and process numbers; a reached goal with its criteria.
 *
 * @param m - Milestone
 * @returns Markdown list lines
 */
export function milestoneLines(m: RetroMilestone): string[] {
  const day = m.closedAt.slice(0, 10);
  if (m.kind === 'goal_completed') {
    return [`- Goal reached (${day}): ${m.title}`, ...(m.criteria ?? []).map((c) => `  - ${c}`)];
  }
  const verdict = m.verdict
    ? `verdict **${m.verdict}**${m.verdictReason ? ` — ${m.verdictReason}` : ''}`
    : m.status === 'cancelled'
      ? 'cancelled, no verdict'
      : 'no verdict recorded';
  const out = [`- ${m.id} "${m.title}" ${m.status === 'cancelled' ? 'cancelled' : 'measured'} (${day}): ${verdict}`];
  if (m.hypothesis) out.push(`  Hypothesis: ${m.hypothesis}`);
  if (m.outcome) {
    const n = (v: number | null): string => (v === null ? 'n/a' : String(Math.round(v * 100) / 100));
    out.push(`  Outcome (${m.outcome.metric}): ${n(m.outcome.baseline)} → ${n(m.outcome.result)}`);
  }
  const result = m.process?.result;
  if (result && !result.noData) {
    const perTicket = (s: ExperimentProcessSummary): string => (s.ownerTouchesPerTicket === null ? 'n/a' : String(Math.round(s.ownerTouchesPerTicket * 10) / 10));
    const perShipped = (s: ExperimentProcessSummary): string => (s.costPerShippedTicket === null ? 'n/a' : usdWords(s.costPerShippedTicket));
    const b = m.process?.baseline;
    out.push(
      `  Process: ${processDelta(b, result, (s) => String(s.ticketsShipped))} tickets shipped, ${processDelta(b, result, perTicket)} owner touches per ticket, ` +
        `stalled ${processDelta(b, result, (s) => durationWords(s.stallMs))}, ${processDelta(b, result, perShipped)} per shipped ticket`,
    );
  }
  return out;
}

/**
 * The milestone section of the brief and the wiki page (empty with none).
 *
 * @param milestones - Milestones
 * @param ask - Add the lines telling the lead what to write about them
 * @returns Markdown lines, '' terminated
 */
function milestoneSection(milestones: readonly RetroMilestone[] | undefined, ask: boolean): string[] {
  if (!milestones || milestones.length === 0) return [];
  return [
    '## Milestones',
    '',
    ...milestones.flatMap(milestoneLines),
    '',
    ...(ask
      ? [
          'For each milestone say in the retro whether the change earned its keep (keep it, revert it, or run the next experiment) and what the process numbers say about how the team worked. A quiet day with a milestone still gets this retro.',
          '',
        ]
      : []),
  ];
}

/** Stall time of a run that was the harness's fault (ms). */
function harnessStallMs(r: NonNullable<RetroTrace['review']>): number {
  return (r.stallMsByCause?.runtime_quota ?? 0) + (r.stallMsByCause?.delivery_failure ?? 0);
}

/** Stall time of a run that was the team's (ms): waiting on an agent, nobody pushing. */
function teamStallMs(r: NonNullable<RetroTrace['review']>): number {
  return (r.stallMsByCause?.waiting_on_agent ?? 0) + (r.stallMsByCause?.nobody_pushing ?? 0);
}

/**
 * Why a run deserves a look in the retro. Empty for a run that went well:
 * done, no stall but the owner's, no rework, few interventions.
 *
 * @param r - The run's numbers
 * @returns Reasons, in the order they are shown
 */
export function retroReviewReasons(r: NonNullable<RetroTrace['review']>): string[] {
  const out: string[] = [];
  if (r.state === 'failed' || r.state === 'cancelled') out.push(`ended ${r.state}`);
  const harness = harnessStallMs(r);
  if (harness > 0) out.push(`stalled ${durationWords(harness)} on the harness (${STALL_WORDS.runtime_quota} / ${STALL_WORDS.delivery_failure})`);
  const team = teamStallMs(r);
  if (team > 0) out.push(`stalled ${durationWords(team)} on the team (${STALL_WORDS.waiting_on_agent} / ${STALL_WORDS.nobody_pushing})`);
  if (r.rework > 0) out.push(`${r.rework} rework (send-backs, retries, failed verifications)`);
  if (r.interventions >= TICKET_AUTOPILOT_CONSTANTS.RETRO_REVIEW_INTERVENTIONS) out.push(`${r.interventions} harness interventions`);
  return out;
}

/**
 * Order the day's ticket traces for the brief: the ones with reasons first
 * (most reasons, then the longest), then the rest by wall time, then the
 * ones that could not be read. Stable for equal keys.
 *
 * @param traces - Ticket traces (not the run trace)
 * @returns A new array
 */
export function rankRetroTraces(traces: readonly RetroTrace[]): RetroTrace[] {
  const key = (t: RetroTrace): [number, number, number] => {
    if (!t.review) return [2, 0, 0];
    const reasons = retroReviewReasons(t.review).length;
    return [reasons > 0 ? 0 : 1, -reasons, -t.review.wallMs];
  };
  return traces
    .map((t, i) => ({ t, i, k: key(t) }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2] || a.i - b.i)
    .map((x) => x.t);
}

/**
 * One brief line for a ticket trace: title, the trace-read command, and
 * (when read) the numbers with the reasons to look.
 *
 * @param t - Trace
 * @returns Markdown list item
 */
export function retroTraceLine(t: RetroTrace): string {
  const cmd = `\`bash $AGENT_SKILLS_PATH/core/trace-read/execute.sh --trace ${t.traceId}\``;
  if (!t.review) return `- ${t.title} — ${cmd}`;
  const r = t.review;
  const reasons = retroReviewReasons(r);
  const owner = r.stallMsByCause?.waiting_on_owner ?? 0;
  const numbers = [
    r.state.replace(/_/g, ' '),
    `wall ${durationWords(r.wallMs)}`,
    r.stallMs > 0 ? `stalled ${durationWords(r.stallMs)}${owner > 0 && owner === r.stallMs ? ' (all on the owner)' : ''}` : 'no stall',
    usdWords(r.costUsd),
  ].join(', ');
  const flag = reasons.length ? ` — **read first**: ${reasons.join('; ')}` : '';
  return `- ${t.title} — ${numbers}${flag} — ${cmd}`;
}

/**
 * The brief of the daily retro WorkItem.
 *
 * @param input - Project, day, stats, traces
 * @returns Markdown
 */
export function buildRetroBrief(input: RetroBriefInput): string {
  const { project, day, stats } = input;
  const ref = project.id;
  // The run trace stays first; the ticket traces are ranked so the runs
  // that need a retro line are read before the ones that went well. On a
  // milestone day without autopilot work there is no run trace.
  const run = input.runTrace !== undefined ? (input.runTrace ?? undefined) : input.traces[0];
  const tickets = input.runTrace !== undefined ? input.traces : input.traces.slice(1);
  const ranked = [...(run ? [run] : []), ...rankRetroTraces(tickets)];
  const flagged = ranked.filter((t) => t.review && retroReviewReasons(t.review).length > 0).length;
  const traceLines = ranked.length ? ranked.map(retroTraceLine) : ['- (no traces)'];
  if (flagged > 0) traceLines.push('', `${flagged} of ${tickets.length} runs are flagged **read first**: say in the retro what happened in each (a line is enough when it was the owner's wait).`);
  return [
    `# Autopilot retro: ${project.name}, ${day}`,
    '',
    `Review yesterday's autopilot run of ${project.name} and file a short retro. The numbers below come from the run traces.`,
    '',
    ...milestoneSection(input.milestones, true),
    '## Numbers',
    '',
    ...statsLines(stats).map((l) => `- ${l}`),
    '',
    '## Traces',
    '',
    ...traceLines,
    '',
    'Read the run trace first, then the flagged runs, then the tickets that cost the most. Keep each read short (`--max-chars 3000`).',
    '',
    '## What to write',
    '',
    '1. A few lines: what shipped, where it stalled and why.',
    '2. Each problem with ONE class:',
    '   - `agent_judgment` — an agent chose badly (wrong owner, skipped a check, wrong scope);',
    '   - `missing_skill` — an agent lacked a skill or tool it needed;',
    '   - `harness_gap` — Crewly itself got in the way or failed to help (lost message, missed wake, wrong routing, missing guard);',
    '   - `owner_dependency` — the work waited on the owner.',
    '   Give evidence (trace ids, ticket ids, the event line).',
    '',
    '## Submit',
    '',
    '```bash',
    `bash $AGENT_SKILLS_PATH/core/project-tickets/execute.sh retro --project ${ref} --day ${day} \\`,
    '  --summary "Shipped CE-12 and CE-14. CE-15 stalled 3h waiting on the owner for the copy." \\',
    '  --problem "owner_dependency|CE-15 waited 3h for copy approval|Decision D-40 open 3h|tr-…" \\',
    '  --problem "harness_gap|Triage brief listed a stopped member as busy||tr-…"',
    '```',
    '',
    'Crewly writes the retro to the project wiki. Harness gaps become backlog tickets on the Crewly project; the owner approves them with one card (deduplicated, at most 3 a day). Do not file them yourself.',
    '',
    'Then complete this WorkItem (no verification).',
  ].join('\n');
}

/**
 * The retro's wiki page.
 *
 * @param input - Project, retro, the day's stats, filed tickets
 * @returns Markdown
 */
export function renderRetroMarkdown(input: {
  project: { name: string };
  retro: RetroInput;
  stats: AutopilotPeriodStats | null;
  by: string;
  filed: Array<{ id: string; title: string }>;
  runTraceId: string | null;
  /** Experiment cards closed / OKRs completed on the day (#985) */
  milestones?: RetroMilestone[];
}): string {
  const { retro } = input;
  const out = [`# Autopilot retro — ${input.project.name} — ${retro.day}`, '', `Filed by ${input.by}.`, '', '## Summary', '', retro.summary, ''];
  out.push(...milestoneSection(input.milestones, false));
  if (input.stats) out.push('## Numbers', '', ...statsLines(input.stats).map((l) => `- ${l}`), '');
  out.push(...problemLines(retro.problems));
  if (input.filed.length > 0) {
    out.push('## Harness-gap tickets', '', ...input.filed.map((t) => `- ${t.id}: ${t.title} (waiting for the owner's OK)`), '');
  }
  if (input.runTraceId) out.push(`Run trace: \`${input.runTraceId}\``, '');
  return out.join('\n');
}

/**
 * Words of a title for the dedupe (lower case, no punctuation, no short words).
 *
 * @param title - Title
 * @returns Word set
 */
export function titleWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/**
 * Word overlap of two titles (Jaccard).
 *
 * @param a - Title
 * @param b - Title
 * @returns 0..1
 */
export function titleSimilarity(a: string, b: string): number {
  const x = titleWords(a);
  const y = titleWords(b);
  if (x.size === 0 || y.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common += 1;
  return common / (x.size + y.size - common);
}

/**
 * Whether a gap duplicates one of the given titles.
 *
 * @param title - New gap
 * @param existing - Open ticket titles and earlier gaps
 * @returns The duplicated title, or null
 */
export function duplicateOf(title: string, existing: readonly string[]): string | null {
  for (const t of existing) if (titleSimilarity(title, t) >= TICKET_AUTOPILOT_CONSTANTS.RETRO_DEDUPE_SIMILARITY) return t;
  return null;
}

/**
 * Apply the owner's answer to a retro harness-gap ticket. Approve: drop the
 * `retro-pending` hold and make a backlog ticket ready. Skip / no answer:
 * cancel it only while it has not started (backlog / ready); a ticket
 * someone already started is left alone with a Log line.
 *
 * @param tickets - Ticket store
 * @param projectPath - Harness project root
 * @param id - Ticket id
 * @param approve - The owner approved
 * @param note - Log note
 * @returns What happened
 */
export async function applyRetroGapDecision(
  tickets: Pick<ProjectTicketService, 'mutate'>,
  projectPath: string,
  id: string,
  approve: boolean,
  note: string,
): Promise<'ready' | 'cancelled' | 'left'> {
  let outcome: 'ready' | 'cancelled' | 'left' = 'left';
  const hold = TICKET_AUTOPILOT_CONSTANTS.RETRO_PENDING_LABEL;
  await tickets.mutate(projectPath, id, 'owner', (t) => {
    const labels = t.labels.filter((l) => l !== hold);
    if (approve) {
      if (t.status === 'backlog') {
        outcome = 'ready';
        return { fields: { labels, status: 'ready' }, log: [`backlog → ready — ${note}`] };
      }
      return { fields: { labels }, log: [note] };
    }
    if (t.status === 'backlog' || t.status === 'ready') {
      outcome = 'cancelled';
      return { fields: { labels, status: 'cancelled', assignee: null, workItemId: null }, log: [`${t.status} → cancelled — ${note}`] };
    }
    return { log: [`${note}; left as ${t.status} because work already started`] };
  });
  return outcome;
}

/**
 * The "## Problems" section of a retro page, grouped by class.
 *
 * @param problems - Problems
 * @returns Markdown lines
 */
function problemLines(problems: readonly RetroProblem[]): string[] {
  const out = ['## Problems', ''];
  if (problems.length === 0) out.push('None found.', '');
  for (const cls of TICKET_AUTOPILOT_CONSTANTS.RETRO_CLASSES as readonly RetroClass[]) {
    const items = problems.filter((p) => p.class === cls);
    if (items.length === 0) continue;
    out.push(`### ${RETRO_CLASS_LABELS[cls]}`, '');
    for (const p of items) {
      out.push(`- **${p.title}**${p.detail ? ` — ${p.detail}` : ''}${p.evidence ? ` (evidence: ${p.evidence})` : ''}`);
    }
    out.push('');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Weekly cross-team retro (#985)
// ---------------------------------------------------------------------------

/**
 * ISO-8601 week (`YYYY-Www`) of a local day key.
 *
 * @param day - `YYYY-MM-DD`
 * @returns Week label such as `2026-W40`
 */
export function isoWeekOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  // Thursday of the week decides the ISO year.
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Monday and Sunday (day keys) of an ISO week.
 *
 * @param week - `YYYY-Ww`
 * @returns `{ start, end }` as `YYYY-MM-DD`
 * @throws Error for a malformed label
 */
export function isoWeekRange(week: string): { start: string; end: string } {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) throw new Error(`Not an ISO week: ${week}`);
  const year = Number(m[1]);
  const n = Number(m[2]);
  // ISO week 1 contains January 4th; its Monday is the start of the year's weeks.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Weekday = jan4.getUTCDay() || 7;
  const monday = new Date(jan4.getTime() - (jan4Weekday - 1) * 86_400_000 + (n - 1) * 7 * 86_400_000);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  const key = (d: Date): string => d.toISOString().slice(0, 10);
  return { start: key(monday), end: key(sunday) };
}

/**
 * The ISO week before the one `day` falls in, with its Monday and Sunday.
 *
 * @param day - A local day key (today)
 * @returns `{ week, start, end }`
 */
export function previousIsoWeek(day: string): { week: string; start: string; end: string } {
  const { start } = isoWeekRange(isoWeekOf(day));
  const [y, m, d] = start.split('-').map(Number);
  const lastSunday = new Date(Date.UTC(y, m - 1, d) - 86_400_000).toISOString().slice(0, 10);
  const week = isoWeekOf(lastSunday);
  return { week, ...isoWeekRange(week) };
}

/** One project in the weekly brief. */
export interface WeeklyRetroProject {
  id: string;
  name: string;
  /** The week's numbers, or null when the traces could not be read */
  stats: AutopilotPeriodStats | null;
  /** Daily retros filed for the week, with where their pages are */
  retros: Array<{ day: string; page: string; problems: number; gaps: number }>;
}

/** What the weekly brief is built from. */
export interface WeeklyRetroBriefInput {
  week: string;
  start: string;
  end: string;
  projects: WeeklyRetroProject[];
  /** Harness-gap tickets the week's daily retros filed */
  gaps: Array<{ id: string; title: string; project: string; day: string }>;
}

/**
 * The brief of the weekly cross-team retro WorkItem (the orchestrator's).
 *
 * @param input - Week, projects with their numbers and daily retros, gaps filed
 * @returns Markdown
 */
export function buildWeeklyRetroBrief(input: WeeklyRetroBriefInput): string {
  const C = TICKET_AUTOPILOT_CONSTANTS;
  const { week, start, end } = input;
  const listed = input.projects.slice(0, C.WEEKLY_RETRO_MAX_PROJECTS_IN_BRIEF);
  const rest = input.projects.length - listed.length;
  const projectLines: string[] = [];
  for (const p of listed) {
    projectLines.push(`### ${p.name}`, '');
    projectLines.push(...(p.stats ? statsLines(p.stats).map((l) => `- ${l}`) : ['- Numbers unavailable (traces could not be read)']));
    projectLines.push('', 'Daily retros:', '');
    for (const r of p.retros) {
      projectLines.push(`- ${r.day}: ${r.problems} problem${r.problems === 1 ? '' : 's'}, ${r.gaps} harness gap${r.gaps === 1 ? '' : 's'} filed — \`${r.page}\``);
    }
    projectLines.push('');
  }
  if (rest > 0) projectLines.push(`…and ${rest} more project${rest === 1 ? '' : 's'} with daily retros this week.`, '');
  const gapLines = input.gaps.length
    ? input.gaps.map((g) => `- ${g.id} — ${g.title} (${g.project}, ${g.day})`)
    : ['- (none filed this week)'];
  return [
    `# Weekly autopilot retro: ${week} (${start} → ${end})`,
    '',
    `The team leads filed daily retros for ${input.projects.length} project${input.projects.length === 1 ? '' : 's'} this week. Read them across teams and file ONE weekly retro: what repeated, what one team learned that the others still trip over, and which problems belong to Crewly rather than to a team.`,
    '',
    '## Projects',
    '',
    ...projectLines,
    '## Harness gaps filed this week',
    '',
    ...gapLines,
    '',
    'Read each daily retro page (they are files; `cat` them). Look for the same problem under different titles across projects, and for gaps the owner skipped more than once.',
    '',
    '## What to write',
    '',
    '1. A few lines: the week across teams — what shipped, where it stalled, what repeated.',
    '2. Each cross-team problem with ONE class (`agent_judgment`, `missing_skill`, `harness_gap`, `owner_dependency`) and evidence: the retro pages or ticket ids it came from. Do not repeat problems a single team already filed unless they recur across teams.',
    '',
    '## Submit',
    '',
    '```bash',
    `bash $AGENT_SKILLS_PATH/core/project-tickets/execute.sh retro --week ${week} \\`,
    '  --summary "Three projects shipped; two stalled on the same owner approval; the triage brief misread paused teams twice." \\',
    '  --problem "harness_gap|Triage brief counts a paused team as available|Seen in CE and Flopost retros||CE 2026-10-01, Flopost 2026-10-03" \\',
    '  --problem "owner_dependency|Copy approvals waited a day in two projects"',
    '```',
    '',
    `Crewly writes the retro to the global wiki (\`${C.WEEKLY_RETRO_WIKI_DIR}/${week}.md\`). Harness gaps become backlog tickets on the ${C.RETRO_HARNESS_PROJECT} project, deduplicated against open tickets and earlier retros, at most ${C.RETRO_MAX_GAPS_PER_DAY} a day; the owner approves them with one card. Do not file them yourself.`,
    '',
    'Then complete this WorkItem (no verification).',
  ].join('\n');
}

/**
 * The weekly retro's wiki page (global vault).
 *
 * @param input - Week, retro, projects, filed tickets
 * @returns Markdown
 */
export function renderWeeklyRetroMarkdown(input: {
  week: string;
  start: string;
  end: string;
  retro: WeeklyRetroInput;
  by: string;
  projects: WeeklyRetroProject[];
  filed: Array<{ id: string; title: string }>;
}): string {
  const out = [`# Weekly autopilot retro — ${input.week} (${input.start} → ${input.end})`, '', `Filed by ${input.by}.`, '', '## Summary', '', input.retro.summary, ''];
  if (input.projects.length > 0) {
    out.push('## Projects', '');
    for (const p of input.projects) {
      const days = p.retros.map((r) => r.day).join(', ');
      const numbers = p.stats ? ` — ${p.stats.done} done, ${p.stats.verified} verified, ${p.stats.sentBack} sent back, ${p.stats.stalled} stalled` : '';
      out.push(`- **${p.name}**: daily retros ${days || '(none)'}${numbers}`);
    }
    out.push('');
  }
  out.push(...problemLines(input.retro.problems));
  if (input.filed.length > 0) {
    out.push('## Harness-gap tickets', '', ...input.filed.map((t) => `- ${t.id}: ${t.title} (waiting for the owner's OK)`), '');
  }
  return out.join('\n');
}
