/**
 * Ticket autopilot — the texts (specs/2026-09-30-ticket-autopilot.md §3, §5):
 * the driver's triage brief, the owner's batched questions and the evening
 * digest. Pure functions; the owner-facing texts are phone-sized and carry no
 * harness mechanics (no WorkItem ids, claims or pool states).
 *
 * @module services/project-tickets/ticket-autopilot-messages
 */

import { TICKET_AUTOPILOT_CONSTANTS } from '../../constants.js';
import type { ProjectTicket } from '../../types/project-ticket.types.js';
import type { TriageCandidate } from './ticket-autopilot-decision.js';

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

/** A team member as the triage brief shows it. */
export interface TriageBriefMember {
  session: string;
  /** Display name, when different from the session */
  name?: string;
  role?: string;
  idle: boolean;
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
    `3. **Needs the owner** — \`bash ${tk} ask-owner --project ${p} --id <ID> --question "<one line the owner can answer with a tap or a word>"\`. Crewly batches these to the owner's phone; do not message the owner about them yourself.`,
    `4. **Cancel** — \`… update --project ${p} --id <ID> --status cancelled --note "<reason>"\`.`,
    '',
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
    '## Team',
    '',
    ...(input.members.length > 0
      ? input.members.map(
          (m) =>
            `- ${m.session}${m.name && m.name !== m.session ? ` (${m.name}${m.role ? `, ${m.role}` : ''})` : m.role ? ` (${m.role})` : ''} — ${m.idle ? 'idle' : 'busy'}, ${m.inFlight} in progress`,
        )
      : ['- (no members found)']),
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

/** A question for the owner. */
export interface OwnerQuestionItem {
  projectName: string;
  ticketId: string;
  title: string;
  question: string;
}

/**
 * The one batched message with every open owner question — numbered, short,
 * answerable with a tap or a word.
 *
 * @param items - Questions (already ordered)
 * @returns Message text
 */
export function buildOwnerQuestionsMessage(items: OwnerQuestionItem[]): string {
  const multiProject = new Set(items.map((i) => i.projectName)).size > 1;
  const lines = [
    items.length === 1 ? 'One ticket is waiting on you:' : `${items.length} tickets are waiting on you:`,
    '',
    ...items.map((q, i) => `${i + 1}. ${q.ticketId}${multiProject ? ` (${q.projectName})` : ''} ${excerpt(q.title, 60)} — ${q.question}`),
    '',
    'Reply with the number and your answer (e.g. "1 yes").',
  ];
  return lines.join('\n');
}

/** One project's section of the digest. */
export interface DigestProject {
  name: string;
  doneToday: ProjectTicket[];
  inProgress: ProjectTicket[];
  waitingOnOwner: ProjectTicket[];
}

/**
 * One digest section line: count plus the first few tickets.
 *
 * @param label - Section label
 * @param tickets - Tickets
 * @param withAssignee - Append the assignee
 * @returns Line, or null when empty
 */
function digestSection(label: string, tickets: ProjectTicket[], withAssignee: boolean): string | null {
  if (tickets.length === 0) return null;
  const max = TICKET_AUTOPILOT_CONSTANTS.DIGEST_MAX_ITEMS_PER_SECTION;
  const named = tickets
    .slice(0, max)
    .map((t) => `${t.id} ${excerpt(t.title, 50)}${withAssignee && t.assignee ? ` (${t.assignee})` : ''}`);
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
      digestSection('Waiting on you', p.waitingOnOwner, false),
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
 * @param spentUsd - Spent today
 * @param budgetUsd - Daily budget
 * @returns Message text
 */
export function buildBudgetPausedMessage(projectName: string, spentUsd: number, budgetUsd: number): string {
  return `Ticket autopilot paused for today on ${projectName}: the team has used $${spentUsd.toFixed(2)} of its $${budgetUsd.toFixed(2)} daily budget. It picks up again tomorrow. Reply "raise the budget to $N" to change it.`;
}
