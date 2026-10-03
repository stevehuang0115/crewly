/**
 * Daily autopilot retro, pure parts (specs/2026-10-03-autopilot-experiments.md §4):
 * the brief the driver gets, the retro input contract, the wiki page, and
 * the harness-gap dedupe.
 *
 * @module services/project-tickets/ticket-autopilot-retro
 */

import { TICKET_AUTOPILOT_CONSTANTS } from '../../constants.js';
import type { AutopilotDayStats, AutopilotPeriodStats } from './ticket-autopilot-stats.js';
import type { StallCause } from '../trace/trace-metrics.js';
import type { ProjectTicketService } from './project-ticket.service.js';

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
  const C = TICKET_AUTOPILOT_CONSTANTS;
  if (!raw || typeof raw !== 'object') throw new RetroInputError('Body must be {day, summary, problems: [{class, title, detail?, evidence?}]}');
  const b = raw as Record<string, unknown>;
  const day = typeof b.day === 'string' ? b.day.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RetroInputError('day must be the reviewed day, YYYY-MM-DD');
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
  return { day, summary, problems };
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
    `Tickets: ${s.triaged} triaged, ${s.started} started, ${s.done} done, ${s.verified} verified, ${s.sentBack} sent back, ${s.stalled} stalled`,
    `Cycle time: start → done median ${s.cycleTime.toDone.medianMs === null ? 'n/a' : durationWords(s.cycleTime.toDone.medianMs)}, start → verified median ${s.cycleTime.toVerified.medianMs === null ? 'n/a' : durationWords(s.cycleTime.toVerified.medianMs)}`,
    `Owner touches: ${s.ownerTouches.total} (answered ${s.ownerTouches.answered}, approved ${s.ownerTouches.approved}, sent back ${s.ownerTouches.sentBack}, corrected ${s.ownerTouches.corrected})`,
    `Stalls: ${s.stalls.count} (${durationWords(s.stalls.totalMs)})${s.stalls.count > 0 ? ` — ${topStallCauses(s).join('; ')}` : ''}`,
    `Harness interventions: ${s.interventions.total} (nudges ${s.interventions.nudges}, redeliveries ${s.interventions.redeliveries}, wakes ${s.interventions.wakes}, corrections ${s.interventions.corrections}, refusals ${s.interventions.guardBlocks}, misroutes ${s.interventions.misroutes})`,
    `Cost: ${tokenWords(s.tokens)} tokens traced, ${usdWords(s.costUsd)}; team ledger ${tokenWords(s.budget.ledgerTokens)} of ${tokenWords(s.budget.dailyBudgetTokens)} budget (${Math.round(s.budget.pct * 100)}%)${s.pausedMs > 0 ? `; paused on the budget ${durationWords(s.pausedMs)}` : ''}`,
  ];
  return lines;
}

/** Input of {@link buildRetroBrief}. */
export interface RetroBriefInput {
  project: { id: string; name: string };
  day: string;
  stats: AutopilotDayStats;
  /** Traces of the day: run trace first, then ticket traces with a title */
  traces: Array<{ traceId: string; title: string }>;
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
  const traceLines = input.traces.length
    ? input.traces.map((t) => `- ${t.title} — \`bash $AGENT_SKILLS_PATH/core/trace-read/execute.sh --trace ${t.traceId}\``)
    : ['- (no traces)'];
  return [
    `# Autopilot retro: ${project.name}, ${day}`,
    '',
    `Review yesterday's autopilot run of ${project.name} and file a short retro. The numbers below come from the run traces.`,
    '',
    '## Numbers',
    '',
    ...statsLines(stats).map((l) => `- ${l}`),
    '',
    '## Traces',
    '',
    ...traceLines,
    '',
    'Read the run trace first, then the tickets that stalled, were sent back or cost the most. Keep each read short (`--max-chars 3000`).',
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
}): string {
  const { retro } = input;
  const out = [`# Autopilot retro — ${input.project.name} — ${retro.day}`, '', `Filed by ${input.by}.`, '', '## Summary', '', retro.summary, ''];
  if (input.stats) out.push('## Numbers', '', ...statsLines(input.stats).map((l) => `- ${l}`), '');
  out.push('## Problems', '');
  if (retro.problems.length === 0) out.push('None found.', '');
  for (const cls of TICKET_AUTOPILOT_CONSTANTS.RETRO_CLASSES as readonly RetroClass[]) {
    const items = retro.problems.filter((p) => p.class === cls);
    if (items.length === 0) continue;
    out.push(`### ${RETRO_CLASS_LABELS[cls]}`, '');
    for (const p of items) {
      out.push(`- **${p.title}**${p.detail ? ` — ${p.detail}` : ''}${p.evidence ? ` (evidence: ${p.evidence})` : ''}`);
    }
    out.push('');
  }
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
