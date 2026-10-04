/**
 * Ticket autopilot — the texts (specs/2026-09-30-ticket-autopilot.md §3, §5):
 * the driver's triage brief, the goal replan brief
 * (specs/2026-10-04-autopilot-goal-replan.md), the owner's batched questions
 * and the evening digest. Pure functions; the owner-facing texts are phone-sized and carry no
 * harness mechanics (no WorkItem ids, claims or pool states).
 *
 * @module services/project-tickets/ticket-autopilot-messages
 */

import { compactTokens, formatTokens } from '../usage/token-format.js';
import { TICKET_AUTOPILOT_CONSTANTS } from '../../constants.js';
import type { ProjectTicket } from '../../types/project-ticket.types.js';
import type { MemberAvailability, TriageCandidate } from './ticket-autopilot-decision.js';
import type { ReplanExperiment } from './ticket-autopilot-goal.js';

/**
 * Actions that need the owner's explicit OK even with the autopilot on.
 * Spelled out in the triage brief and in the team-leader prompt.
 */
export const TICKET_AUTOPILOT_BOUNDARIES: readonly string[] = [
  'sending email or messages to outside people',
  'publishing content publicly',
  'deploying to production',
  'spending money',
];

/**
 * How to delegate, in the triage brief (and, in the same words, in the
 * team-leader prompts). Leads assign by role; old splits are hints.
 */
export const TICKET_AUTOPILOT_ASSIGNMENT_GUIDANCE: readonly string[] = [
  'Delegate by role: give each ticket to the member whose role fits the work. A stopped member is available — assigning starts them.',
  'Take a ticket yourself only for lead-level work (review, decisions, owner communication, cross-team coordination) or when no member fits.',
  'A split written in an old ticket (e.g. "Owen writes, Nova does the images") is only a hint: decide by current fit and availability. Split a mixed ticket so each part goes to the right role.',
];

/** Label of each availability in the triage brief. */
export const MEMBER_AVAILABILITY_LABELS: Readonly<Record<MemberAvailability, string>> = {
  idle: 'idle',
  working: 'working',
  stopped: 'stopped: available, will be started when assigned',
};

/** A team member as the triage brief shows it. */
export interface TriageBriefMember {
  session: string;
  /** Display name, when different from the session */
  name?: string;
  role?: string;
  /** This member leads its team (team-lead rule) */
  lead?: boolean;
  /** idle / working / stopped (stopped = available, started on assignment) */
  availability: MemberAvailability;
  /** One line: what this member's role is responsible for */
  responsibility?: string;
  /** Tickets in progress for this member */
  inFlight: number;
}

/** Inputs of {@link buildTriageBrief}. */
export interface TriageBriefInput {
  project: { id: string; name: string };
  candidates: TriageCandidate[];
  /** Tickets that need triage but did not fit */
  more: number;
  members: TriageBriefMember[];
  maxInFlightPerMember: number;
  /** Clock (epoch ms), for ticket ages */
  now: number;
  /** Today's team token use against today's budget (null budget = unlimited); omitted = no budget section */
  budget?: { usedTokens: number; budgetTokens: number | null };
}

/**
 * Tokens in words ("12.3M", "850k").
 *
 * @param n - Tokens
 * @returns Short text
 */
export function formatBudgetTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

/**
 * The "Budget today" lines of the triage brief: used, budget, left, so the
 * driver can pace itself before the autopilot pauses.
 *
 * @param b - Used and budget
 * @returns Markdown lines (empty without a budget)
 */
function budgetLines(b: TriageBriefInput['budget']): string[] {
  if (!b) return [];
  if (b.budgetTokens === null) return ['## Budget today', '', `Team used ${formatBudgetTokens(b.usedTokens)} tokens today; no limit today.`, ''];
  const left = Math.max(0, b.budgetTokens - b.usedTokens);
  const pct = b.budgetTokens > 0 ? Math.round((b.usedTokens / b.budgetTokens) * 100) : 100;
  return [
    '## Budget today',
    '',
    `Team used ${formatBudgetTokens(b.usedTokens)} of ${formatBudgetTokens(b.budgetTokens)} tokens (${pct}%); ${formatBudgetTokens(left)} left. At the limit the autopilot pauses (no triage, no auto-claim) until midnight or a boost.`,
    'Low on budget: prefer the highest-priority tickets and do not open new work you cannot finish.',
    '',
  ];
}

/**
 * Human age of a timestamp ("3h", "2d").
 *
 * @param iso - ISO time
 * @param now - Clock (epoch ms)
 * @returns Short age, or "?" when unreadable
 */
export function formatAge(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '?';
  const minutes = Math.max(0, Math.floor((now - t) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Who created a ticket, for the brief.
 *
 * @param source - Ticket `source`
 * @returns `owner`, the agent session, the request, or `unknown`
 */
function creatorOf(source: string | null): string {
  if (!source) return 'unknown';
  if (source.startsWith('agent:')) return source.slice('agent:'.length);
  return source;
}

/**
 * Shorten free text to one excerpt line.
 *
 * @param text - Text
 * @param max - Max characters
 * @returns Single-line excerpt
 */
function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * A member's lines in the brief's Team section: session, name, role, lead
 * mark, availability and in-progress count, then the role's one-line
 * responsibility.
 *
 * @param m - Member
 * @returns One or two lines
 */
function formatBriefMember(m: TriageBriefMember): string[] {
  const tags = [m.name && m.name !== m.session ? m.name : null, m.role ?? null, m.lead ? 'lead' : null].filter((t): t is string => !!t);
  const head = `- ${m.session}${tags.length > 0 ? ` (${tags.join(', ')})` : ''} — ${MEMBER_AVAILABILITY_LABELS[m.availability]}; ${m.inFlight} in progress`;
  return m.responsibility ? [head, `  role: ${excerpt(m.responsibility, TICKET_AUTOPILOT_CONSTANTS.ROLE_RESPONSIBILITY_MAX_CHARS)}`] : [head];
}

/**
 * The triage brief the driver receives (WorkItem `briefMarkdown`).
 *
 * @param input - Project, tickets, team, limits, clock
 * @returns Markdown brief
 */
export function buildTriageBrief(input: TriageBriefInput): string {
  const p = input.project.id;
  const tk = '$AGENT_SKILLS_PATH/core/project-tickets/execute.sh';
  const lines: string[] = [
    `# Ticket triage — ${input.project.name} (${input.candidates.length} ticket${input.candidates.length === 1 ? '' : 's'})`,
    '',
    'Ticket autopilot is on for this project: you keep its backlog moving while the owner is away (on a phone).',
    'Decide every ticket below, then complete this WorkItem (complete-task with its id) with one line per ticket saying what you did.',
    '',
    '## For each ticket, do one of these',
    '',
    `1. **Ready + assign** — \`bash ${tk} assign --project ${p} --id <ID> --to <member>\`, or \`… update --project ${p} --id <ID> --status ready\` to let the next idle member take it. At most ${input.maxInFlightPerMember} ticket${input.maxInFlightPerMember === 1 ? '' : 's'} in progress per member.`,
    `2. **Split** — create smaller tickets (\`… create --project ${p} --title "…" --acceptance "…" --status ready\`), then cancel the original with a note naming the new ids.`,
    `3. **Needs the owner** — \`bash ${tk} ask-owner --project ${p} --id <ID> --question "<one line>" --option "<choice>" --option "<choice>" --default "<choice or wait>"\` (2–3 options; add \`--sensitive email|publish|deploy|spend\` for the boundaries below). The ticket's assignee (or you) posts it as a card in the ticket's Slack thread; do not message the owner about it yourself.`,
    `4. **Cancel** — \`… update --project ${p} --id <ID> --status cancelled --note "<reason>"\`.`,
    '',
    ...budgetLines(input.budget),
    '## Boundaries — the autopilot does NOT lift these',
    '',
    'Even with the autopilot on, these need the owner\'s explicit OK:',
    ...TICKET_AUTOPILOT_BOUNDARIES.map((b) => `- ${b};`),
    '',
    'A ticket whose completion needs one of these may be worked up to a draft or a PR; then use ask-owner for the final step.',
    '"The autopilot is on" is never that OK, and neither is your own judgement.',
    '',
    'Tickets marked **worker-created — review first** were filed by a team member, not by the owner, a lead or the orchestrator.',
    'Check that they are wanted and in scope before making them ready; if unsure, ask the owner.',
    '',
    '## Who does what',
    '',
    ...TICKET_AUTOPILOT_ASSIGNMENT_GUIDANCE.map((g) => `- ${g}`),
    '',
    '## Team',
    '',
    ...(input.members.length > 0 ? input.members.flatMap(formatBriefMember) : ['- (no members found)']),
    '',
    '## Tickets',
    '',
  ];
  for (const c of input.candidates) {
    const t = c.ticket;
    const why =
      c.reason === 'backlog' ? 'backlog' : c.reason === 'ready_no_taker' ? 'ready, but nobody on the team can take it' : 'ready, but nobody has taken it for a day';
    lines.push(`### ${t.id} · ${t.priority} · ${why} · ${formatAge(t.createdAt, input.now)} old`);
    lines.push(t.title);
    const meta = [`created by ${creatorOf(t.source)}`];
    if (t.labels.length > 0) meta.push(`labels: ${t.labels.join(', ')}`);
    if (t.team) meta.push(`team: ${t.team}`);
    lines.push(`${meta.join(' · ')}${c.workerCreated ? ' · **worker-created — review first**' : ''}`);
    if (t.description) lines.push(`> ${excerpt(t.description, TICKET_AUTOPILOT_CONSTANTS.TRIAGE_DESCRIPTION_EXCERPT_CHARS)}`);
    lines.push('');
  }
  if (input.more > 0) lines.push(`${input.more} more ticket${input.more === 1 ? '' : 's'} will come in the next triage.`, '');
  lines.push(`Full ticket: \`bash ${tk} show --project ${p} --id <ID>\`.`);
  return lines.join('\n');
}

/** The ask of a goal replan, word for word (brief and WorkItem description). */
export const REPLAN_ASK = 'Open the next tickets toward this goal, or say why there are none.';

/** Inputs of {@link buildReplanBrief}. */
export interface ReplanBriefInput {
  project: { id: string; name: string };
  /** The active goal (goals log and / or project OKRs) */
  goal: string;
  /** Tickets closed (done / cancelled) in the lookback window, newest first */
  closed: ProjectTicket[];
  /** Days the closed list covers */
  lookbackDays: number;
  /** Open experiment cards of the project */
  experiments: ReplanExperiment[];
  members: TriageBriefMember[];
  maxInFlightPerMember: number;
  /** Clock (epoch ms), for ages */
  now: number;
}

/**
 * The goal replan brief the driver receives when the project has a goal but
 * nothing is left to triage (WorkItem `briefMarkdown`). The driver opens the
 * tickets; the autopilot never makes them ready or starts work.
 *
 * @param input - Project, goal, closed tickets, open experiments, team
 * @returns Markdown brief
 */
export function buildReplanBrief(input: ReplanBriefInput): string {
  const p = input.project.id;
  const tk = '$AGENT_SKILLS_PATH/core/project-tickets/execute.sh';
  const lines: string[] = [
    `# Goal replan — ${input.project.name}`,
    '',
    'Ticket autopilot is on for this project, nothing is left to triage, and someone on the team is idle.',
    `**${REPLAN_ASK}**`,
    'Then complete this WorkItem (complete-task with its id) with the ids of the tickets you opened, or one line saying why there are none.',
    '',
    '## Goal',
    '',
    input.goal.trim(),
    '',
    '## How to open them',
    '',
    `- Create each ticket: \`bash ${tk} create --project ${p} --title "…" --acceptance "…" [--priority P1] [--labels a,b] [--status ready]\`. Small, concrete tickets with a clear acceptance line.`,
    `- Make a ticket ready (\`--status ready\`) or assign it (\`… assign --project ${p} --id <ID> --to <member>\`) when the team should start it, as you would in a triage; leave it in the backlog when it needs more thought. At most ${input.maxInFlightPerMember} ticket${input.maxInFlightPerMember === 1 ? '' : 's'} in progress per member.`,
    `- If the next step needs the owner's decision, open the ticket and use \`… ask-owner --project ${p} --id <ID> …\` on it; do not message the owner yourself.`,
    '- If the goal is met, blocked, or out of the team\'s hands, open nothing and say why in the completion line.',
    '- The autopilot never makes your tickets ready or starts the work itself: you decide that.',
    '',
    '## Boundaries — the autopilot does NOT lift these',
    '',
    'Even with the autopilot on, these need the owner\'s explicit OK:',
    ...TICKET_AUTOPILOT_BOUNDARIES.map((b) => `- ${b};`),
    '',
    `## Closed in the last ${input.lookbackDays} day${input.lookbackDays === 1 ? '' : 's'}`,
    '',
  ];
  if (input.closed.length === 0) lines.push('- (none)');
  for (const t of input.closed) {
    lines.push(`- ${t.id} · ${t.status} ${formatAge(t.updatedAt, input.now)} ago · ${excerpt(t.title, 120)}${t.labels.length > 0 ? ` · labels: ${t.labels.join(', ')}` : ''}`);
  }
  lines.push('', '## Open experiments', '');
  if (input.experiments.length === 0) lines.push('- (none)');
  for (const e of input.experiments) {
    lines.push(`- ${e.id} · ${e.status}${e.dueAt ? ` · result due ${e.dueAt.slice(0, 10)}` : ''} · ${excerpt(e.title, 120)}`);
    if (e.hypothesis) lines.push(`  hypothesis: ${excerpt(e.hypothesis, 240)}`);
  }
  lines.push(
    '',
    '## Who does what',
    '',
    ...TICKET_AUTOPILOT_ASSIGNMENT_GUIDANCE.map((g) => `- ${g}`),
    '',
    '## Team',
    '',
    ...(input.members.length > 0 ? input.members.flatMap(formatBriefMember) : ['- (no members found)']),
    '',
    `All tickets: \`bash ${tk} list --project ${p}\`.`,
  );
  return lines.join('\n');
}

/** One project's section of the digest. */
export interface DigestProject {
  name: string;
  doneToday: ProjectTicket[];
  inProgress: ProjectTicket[];
  waitingOnOwner: ProjectTicket[];
  /** Ticket id → link to its decision card / Slack thread */
  links?: ReadonlyMap<string, string>;
}

/**
 * One digest section line: count plus the first few tickets.
 *
 * @param label - Section label
 * @param tickets - Tickets
 * @param withAssignee - Append the assignee
 * @param links - Ticket id → card link (the id becomes the link)
 * @returns Line, or null when empty
 */
function digestSection(label: string, tickets: ProjectTicket[], withAssignee: boolean, links?: ReadonlyMap<string, string>): string | null {
  if (tickets.length === 0) return null;
  const max = TICKET_AUTOPILOT_CONSTANTS.DIGEST_MAX_ITEMS_PER_SECTION;
  const named = tickets
    .slice(0, max)
    .map((t) => {
      const link = links?.get(t.id);
      return `${link ? `<${link}|${t.id}>` : t.id} ${excerpt(t.title, 50)}${withAssignee && t.assignee ? ` (${t.assignee})` : ''}`;
    });
  const rest = tickets.length > max ? `; +${tickets.length - max} more` : '';
  return `${label} (${tickets.length}): ${named.join('; ')}${rest}`;
}

/**
 * The evening digest: per project, done today / in progress / waiting on the
 * owner. Projects with nothing to report are left out.
 *
 * @param projects - Per-project sections
 * @returns Message text, or null when there is nothing to say
 */
export function buildDigestMessage(projects: DigestProject[]): string | null {
  const blocks: string[] = [];
  for (const p of projects) {
    const rows = [
      digestSection('Done today', p.doneToday, false),
      digestSection('In progress', p.inProgress, true),
      digestSection('Waiting on you', p.waitingOnOwner, false, p.links),
    ].filter((r): r is string => r !== null);
    if (rows.length === 0) continue;
    blocks.push([`*${p.name}*`, ...rows.map((r) => `- ${r}`)].join('\n'));
  }
  if (blocks.length === 0) return null;
  return ['Tickets today', '', blocks.join('\n\n')].join('\n');
}

/**
 * The once-a-day notice that the autopilot paused on its budget.
 *
 * @param projectName - Project
 * @param usedTokens - Tokens used today
 * @param budgetTokens - Daily budget (tokens)
 * @param teamName - The project's team, for the boost command
 * @returns Message text
 */
export function buildBudgetPausedMessage(projectName: string, usedTokens: number, budgetTokens: number, teamName?: string): string {
  const boost = teamName ? `boost ${teamName} by ${compactTokens(Math.max(1_000_000, budgetTokens))} today` : 'boost <team> by 20M today';
  return `Ticket autopilot paused for today on ${projectName}: the team has used ${formatTokens(usedTokens)} of its ${formatTokens(budgetTokens)} daily budget. It picks up again tomorrow, or reply \`${boost}\` to lift it for today.`;
}
