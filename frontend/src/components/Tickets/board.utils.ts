/**
 * Pure helpers for the unified Tickets board (specs/2026-10-02-ui-redesign.md
 * §Tickets).
 *
 * The board shows two kinds of work side by side:
 * - **asks** — the owner's tickets (`TKT-n`, `/api/tickets`); they belong to
 *   no project;
 * - **project tickets** — a project's backlog (`CE-n`,
 *   `/api/project-tickets`, files in `<project>/.crewly/tickets/`).
 *
 * Both become a {@link BoardCard} placed in one board column.
 *
 * @module components/Tickets/board.utils
 */

import type { StatusTone } from '@crewly/ui';
import { ORCHESTRATOR_SESSION } from '../../constants/schedules.constants';
import { TICKET_TEXT } from '../../constants/tickets.constants';
import type { TicketBoardColumn, TicketListItem, TicketPriorityLabel } from '../../types/ticket.types';
import type { ProjectTicket, ProjectTicketCriterion, ProjectTicketStatus } from '../../types/project-ticket.types';
import type { Team } from '../../types';
import { autoAcceptLabel } from '../../utils/ticket.utils';

/** Columns shown as full columns, in display order (To review first). */
export const BOARD_MAIN_COLUMNS: readonly TicketBoardColumn[] = ['to_review', 'in_progress', 'todo', 'blocked'];

/** Columns folded into one quiet line under the board. */
export const BOARD_QUIET_COLUMNS: readonly TicketBoardColumn[] = ['idea', 'done'];

/** Cards shown per column before "Show all N". */
export const BOARD_COLUMN_LIMIT = 5;

/** Filter value meaning "tickets that belong to no project" (the owner's asks). */
export const NO_PROJECT = '__none__';

/** A status word on a card, shown only when it matters. */
export interface BoardFlag {
  text: string;
  tone: StatusTone;
  /** Tooltip */
  title?: string;
}

/** One card on the board. */
export interface BoardCard {
  /** Unique key: `t:<id>` for asks, `p:<project>:<id>` for project tickets */
  key: string;
  source: 'ticket' | 'project';
  /** `TKT-12` / `CE-3` (aria label and search; not printed on the card) */
  ref: string | null;
  /** Title for display (leading `[Tag]` and pasted image paths removed) */
  title: string;
  /** The stored title */
  fullTitle: string;
  column: TicketBoardColumn;
  /** Raw assignee (agent session or a person's name) */
  assignee: string | null;
  priority: TicketPriorityLabel;
  flag: BoardFlag | null;
  projectId: string | null;
  projectName: string | null;
  updatedAt: string;
  /** Text searched by the board's search box */
  searchText: string;
  ticket?: TicketListItem;
  projectTicket?: ProjectTicket;
}

/** A project as the board needs it. */
export interface BoardProject {
  id: string;
  name: string;
}

/**
 * Strip harness noise from a title for display: a leading `[Request]`-style
 * tag and a trailing pasted `[Slack Image: …]` path.
 *
 * @param raw - Stored title
 * @returns Display title (the raw title when stripping would empty it)
 */
export function displayTitle(raw: string): string {
  const stripped = raw
    .replace(/^\s*\[[^\]]{1,40}\]\s*/, '')
    .replace(/\s*\[Slack (Image|File):[^\]]*\]?\s*$/i, '')
    .trim();
  return stripped || raw;
}

/**
 * Board column of a project ticket status.
 *
 * Backlog and Ready both wait to be picked up, so both sit in To do
 * (Backlog cards carry the word "Backlog"); Owner review is To review.
 *
 * @param status - Project ticket status
 * @returns Board column
 */
export function projectStatusColumn(status: ProjectTicketStatus): TicketBoardColumn {
  switch (status) {
    case 'backlog':
    case 'ready':
      return 'todo';
    case 'in_progress':
      return 'in_progress';
    case 'review':
      return 'to_review';
    case 'done':
      return 'done';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'todo';
  }
}

/**
 * The one status word an ask's card shows.
 *
 * @param t - Board row
 * @param now - Current time in ms
 * @returns The flag, or null
 */
export function ticketFlag(t: TicketListItem, now?: number): BoardFlag | null {
  if (t.column === 'to_review') {
    const rejects = t.rejectCount ?? 0;
    const countdown = autoAcceptLabel(t.autoAcceptAt, now);
    if (countdown) return { text: countdown, tone: 'attention', ...(rejects > 0 ? { title: `${TICKET_TEXT.REJECT_BADGE} ×${rejects}` } : {}) };
    if (rejects > 0) return { text: `${TICKET_TEXT.REJECT_BADGE} ×${rejects}`, tone: 'danger' };
    return null;
  }
  if (t.column === 'done' && t.acceptedBy) {
    return t.acceptedBy === 'owner'
      ? { text: TICKET_TEXT.ACCEPTED_BY_OWNER, tone: 'success' }
      : { text: TICKET_TEXT.ACCEPTED_BY_SILENCE, tone: 'attention', title: TICKET_TEXT.ACCEPTED_BY_SILENCE_HINT };
  }
  return null;
}

/**
 * Shape an ask (owner ticket) as a card.
 *
 * @param t - Board row from `/api/tickets`
 * @param now - Current time in ms
 * @returns The card
 */
export function ticketToCard(t: TicketListItem, now?: number): BoardCard {
  return {
    key: `t:${t.id}`,
    source: 'ticket',
    ref: t.tkt,
    title: displayTitle(t.title),
    fullTitle: t.title,
    column: t.column,
    assignee: t.assignee,
    priority: t.priorityLabel,
    flag: ticketFlag(t, now),
    projectId: null,
    projectName: null,
    updatedAt: t.updatedAt,
    searchText: '',
    ticket: t,
  };
}

/**
 * Shape a project ticket as a card.
 *
 * @param pt - Project ticket
 * @param project - Its project
 * @returns The card
 */
export function projectTicketToCard(pt: ProjectTicket, project: BoardProject): BoardCard {
  return {
    key: `p:${project.id}:${pt.id}`,
    source: 'project',
    ref: pt.id,
    title: displayTitle(pt.title),
    fullTitle: pt.title,
    column: projectStatusColumn(pt.status),
    assignee: pt.assignee,
    priority: pt.priority,
    flag: pt.status === 'backlog' ? { text: 'Backlog', tone: 'neutral' } : null,
    projectId: project.id,
    projectName: project.name,
    updatedAt: pt.updatedAt,
    searchText: [pt.id, pt.title, pt.description, pt.labels.join(' '), pt.assignee ?? ''].join('\n').toLowerCase(),
    projectTicket: pt,
  };
}

/** Priority rank, P0 first. */
const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/**
 * Order cards inside a column: most urgent first, then most recently updated.
 *
 * @param a - Card
 * @param b - Card
 * @returns Sort order
 */
export function compareCards(a: BoardCard, b: BoardCard): number {
  const p = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
  if (p !== 0) return p;
  return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
}

/**
 * Group cards by column, each column sorted with {@link compareCards}.
 *
 * @param cards - Cards
 * @returns One (possibly empty) list per column, cancelled included
 */
export function groupCards(cards: BoardCard[]): Record<TicketBoardColumn, BoardCard[]> {
  const groups: Record<TicketBoardColumn, BoardCard[]> = {
    idea: [], todo: [], in_progress: [], blocked: [], to_review: [], done: [], cancelled: [],
  };
  for (const c of cards) (groups[c.column] ?? (groups[c.column] = [])).push(c);
  for (const k of Object.keys(groups) as TicketBoardColumn[]) groups[k].sort(compareCards);
  return groups;
}

/**
 * Whether a project ticket card matches a search (asks are searched
 * server-side).
 *
 * @param card - Card
 * @param q - Query
 * @returns True when it matches (always for an empty query)
 */
export function cardMatchesSearch(card: BoardCard, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle || card.source === 'ticket') return true;
  return card.searchText.includes(needle);
}

/** An agent's name and team, looked up by session name. */
export interface AgentName {
  name: string;
  team: string;
}

/**
 * Index team members by session name.
 *
 * @param teams - Teams
 * @returns session name → name and team
 */
export function buildAgentNames(teams: Team[]): Map<string, AgentName> {
  const map = new Map<string, AgentName>();
  for (const team of teams) {
    for (const m of team.members ?? []) {
      if (m.sessionName) map.set(m.sessionName, { name: m.name, team: team.name });
    }
  }
  return map;
}

/**
 * Human name for an assignee or agent session: "Atlas" rather than
 * `think-tank-atlas-b4e166f6`. Unknown values (a person's name, a team)
 * show as-is.
 *
 * @param session - Session name, or null
 * @param names - Index from {@link buildAgentNames}
 * @param withTeam - Append " · Team"
 * @returns Display name, or null when there is none
 */
export function agentDisplayName(
  session: string | null | undefined,
  names: Map<string, AgentName>,
  withTeam = false,
): string | null {
  if (!session) return null;
  if (session === ORCHESTRATOR_SESSION) return 'Orc';
  const hit = names.get(session);
  if (!hit) return session;
  return withTeam ? `${hit.name} · ${hit.team}` : hit.name;
}

/**
 * Split a comma list.
 *
 * @param text - `a, b`
 * @returns Trimmed, non-empty items
 */
export function parseLabels(text: string): string[] {
  return text.split(',').map((l) => l.trim()).filter(Boolean);
}

/**
 * Turn the acceptance textarea into criteria. `[x] ` marks a done item; the
 * done flag of an unchanged line is kept.
 *
 * @param text - One criterion per line
 * @param previous - Current criteria (to keep done flags)
 * @returns Criteria
 */
export function parseAcceptance(text: string, previous: ProjectTicketCriterion[] = []): ProjectTicketCriterion[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^\[( |x|X)\]\s*(.*)$/.exec(line);
      if (m) return { text: m[2].trim(), done: m[1].toLowerCase() === 'x' };
      return { text: line, done: previous.find((c) => c.text === line)?.done ?? false };
    })
    .filter((c) => c.text.length > 0);
}

/**
 * Render criteria for the textarea.
 *
 * @param criteria - Criteria
 * @returns One per line, `[x] ` for done ones
 */
export function formatAcceptance(criteria: ProjectTicketCriterion[]): string {
  return criteria.map((c) => (c.done ? `[x] ${c.text}` : c.text)).join('\n');
}

/**
 * The ticket a run belongs to, read from its title (`TKT-191`, `CE-69`).
 *
 * @param title - Run title
 * @returns The reference, or null
 */
export function runTicketRef(title: string): string | null {
  const m = /\b(TKT-\d+|[A-Z][A-Z0-9]{1,9}-\d+)\b/.exec(title);
  return m ? m[1] : null;
}
