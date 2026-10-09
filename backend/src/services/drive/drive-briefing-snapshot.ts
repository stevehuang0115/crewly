/**
 * Build the Drive mode status snapshot (specs/2026-10-09-drive-mode-v3.md §1)
 * from structured data this machine already has. Pure, no LLM calls: the
 * text in it is what agents already wrote — ticket titles and log lines,
 * work item `output.summary`, decision card summaries, their own messages to
 * the owner.
 *
 *  - teams: lead, members, counts (open / in progress / review / blocked /
 *    done today);
 *  - agents: state (working / idle / starting / stopped), what each is on
 *    and since when (its running work item, else its ticket in progress),
 *    its last few messages to the owner;
 *  - items: project tickets and work items not linked to a ticket, in order
 *    of attention, done / cancelled ones only from the last 24 h;
 *  - waiting: the briefing queue's live owner items (cards, questions,
 *    reviews — stale and duplicate ones are already dropped there).
 *
 * Every text field is made speakable, passed through the secret redactor
 * and clipped; the whole snapshot is kept under
 * {@link DRIVE_BRIEFING_CONSTANTS.MAX_BYTES}.
 *
 * @module services/drive/drive-briefing-snapshot
 */

import { DRIVE_BRIEFING_CONSTANTS } from '../../constants.js';
import { redactSecrets } from '../../utils/secret-redactor.js';
import { clip, speakable } from '../briefing/briefing.utils.js';
import type { OwnerTurnMark } from '../briefing/briefing-cards.js';
import { messagesToOwner, type RecallFeedMessage } from './drive-recall.js';
import type { BriefingAgent, BriefingAgentState, BriefingItem, BriefingItemStatus, BriefingSnapshot, BriefingTeam, BriefingWaiting } from './drive-briefing.contract.js';

const C = DRIVE_BRIEFING_CONSTANTS;

/** An agent on this machine. */
export interface SnapshotAgentSource {
  agentSession: string;
  name: string;
  /** Team name */
  team?: string;
  role?: string;
  state: BriefingAgentState;
}

/** A team on this machine. */
export interface SnapshotTeamSource {
  id: string;
  name: string;
  /** Lead's session */
  lead?: string;
  /** Members' sessions */
  members: string[];
}

/** A project ticket (the fields used). */
export interface SnapshotTicketSource {
  /** Project name */
  project: string;
  id: string;
  title: string;
  status: string;
  labels: string[];
  /** Agent session or a person's name */
  assignee: string | null;
  /** Team id */
  team: string | null;
  updatedAt: string;
  workItemId: string | null;
  log: string[];
}

/** A task-pool work item (the fields used). */
export interface SnapshotWorkItemSource {
  id: string;
  title: string;
  status: string;
  target?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  statusChangedAt?: string;
  output?: Record<string, unknown>;
  blockedReason?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

/** A live owner item from the briefing queue (the fields used). */
export interface SnapshotWaitingSource {
  id: string;
  kind: 'decision' | 'question' | 'review';
  agentSession: string;
  agentName: string;
  teamName?: string;
  summary: string;
  since: string;
  urgency: 'high' | 'normal' | 'low';
  answerTarget: { kind: string; decisionId?: string; tkt?: string };
}

/** Everything the snapshot is built from. */
export interface SnapshotSources {
  now: Date;
  agents: SnapshotAgentSource[];
  teams: SnapshotTeamSource[];
  tickets: SnapshotTicketSource[];
  workItems: SnapshotWorkItemSource[];
  waiting: SnapshotWaitingSource[];
  ownerFeed: { messages: RecallFeedMessage[]; ownerTurns: OwnerTurnMark[] };
}

/** Order of attention. */
const STATUS_RANK: Record<BriefingItemStatus, number> = { review: 0, blocked: 1, in_progress: 2, open: 3, done: 4, cancelled: 5 };

/**
 * Speakable, redacted, clipped text (empty → '').
 *
 * @param raw - Agent-written text
 * @param max - Longest length
 * @returns Safe text
 */
export function safeText(raw: unknown, max: number): string {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  return clip(speakable(redactSecrets(raw)), max - 1);
}

/**
 * An agent's state from its team member record.
 *
 * @param agentStatus - Connection status
 * @param workingStatus - Activity
 * @returns State
 */
export function agentStateOf(agentStatus: string | undefined, workingStatus: string | undefined): BriefingAgentState {
  if (agentStatus === 'active') return workingStatus === 'in_progress' ? 'working' : 'idle';
  if (agentStatus === 'starting' || agentStatus === 'started' || agentStatus === 'activating') return 'starting';
  return 'stopped';
}

/**
 * A project ticket's status for the voice (`blocked` label wins).
 *
 * @param status - Ticket status
 * @param labels - Ticket labels
 * @returns Normalised status
 */
export function ticketStatus(status: string, labels: readonly string[]): BriefingItemStatus {
  if (status === 'done') return 'done';
  if (status === 'cancelled') return 'cancelled';
  if (labels.some((l) => l.toLowerCase() === 'blocked')) return 'blocked';
  if (status === 'in_progress') return 'in_progress';
  if (status === 'review') return 'review';
  return 'open';
}

/**
 * A work item's status for the voice.
 *
 * @param status - WorkItem status
 * @returns Normalised status
 */
export function workItemStatus(status: string): BriefingItemStatus {
  switch (status) {
    case 'running':
    case 'accepted':
      return 'in_progress';
    case 'done_by_worker':
      return 'review';
    case 'blocked':
    case 'escalated':
    case 'failed':
      return 'blocked';
    case 'verified':
    case 'done':
      return 'done';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'open';
  }
}

/**
 * The words of a ticket log line (`<iso> · <actor> · <message>` → message).
 *
 * @param line - Log line
 * @returns The message
 */
export function logMessage(line: string): string {
  const parts = line.split(' · ');
  return parts.length >= 3 ? parts.slice(2).join(' · ') : line;
}

/** A work item's own last word: its summary, its blocked reason, its error. */
function workItemLast(w: SnapshotWorkItemSource): string {
  const summary = w.output && typeof w.output['summary'] === 'string' ? (w.output['summary'] as string) : '';
  return summary || w.blockedReason || w.error || '';
}

const workItemUpdatedAt = (w: SnapshotWorkItemSource): string => w.statusChangedAt ?? w.completedAt ?? w.startedAt ?? w.createdAt;

/**
 * Build the snapshot.
 *
 * @param src - Sources
 * @returns Snapshot, under the size cap
 *
 * @example
 * ```typescript
 * const snapshot = buildBriefingSnapshot({ now: new Date(), agents, teams, tickets, workItems, waiting, ownerFeed });
 * ```
 */
export function buildBriefingSnapshot(src: SnapshotSources): BriefingSnapshot {
  const nowMs = src.now.getTime();
  const nameOf = new Map(src.agents.map((a) => [a.agentSession, a.name]));
  const teamOfAgent = new Map(src.agents.filter((a) => a.team).map((a) => [a.agentSession, a.team as string]));
  const teamName = new Map(src.teams.map((t) => [t.id, t.name]));
  const recentEnough = (status: BriefingItemStatus, at: string): boolean => (status !== 'done' && status !== 'cancelled') || nowMs - Date.parse(at) < C.DONE_WINDOW_MS;
  const who = (assignee: string | null | undefined): string | undefined => (assignee ? safeText(nameOf.get(assignee) ?? assignee, C.NAME_MAX) || undefined : undefined);

  // --- items: tickets, then work items not behind a ticket --------------------
  const byWorkItem = new Map(src.workItems.map((w) => [w.id, w]));
  const linked = new Set<string>();
  const items: Array<BriefingItem & { session?: string }> = [];
  for (const t of src.tickets) {
    const status = ticketStatus(t.status, t.labels);
    if (!recentEnough(status, t.updatedAt)) continue;
    if (t.workItemId) linked.add(t.workItemId);
    const wi = t.workItemId ? byWorkItem.get(t.workItemId) : undefined;
    const logLast = t.log.length ? logMessage(t.log[t.log.length - 1]) : '';
    const wiLast = wi ? workItemLast(wi) : '';
    // The newer of the ticket's last log line and its work item's summary.
    const last = wiLast && wi && Date.parse(workItemUpdatedAt(wi)) > Date.parse(t.updatedAt) ? wiLast : logLast || wiLast;
    const team = (t.team && teamName.get(t.team)) || (t.assignee ? teamOfAgent.get(t.assignee) : undefined);
    items.push({
      ref: t.id,
      kind: 'ticket',
      title: safeText(t.title, C.TITLE_MAX) || t.id,
      status,
      ...(who(t.assignee) ? { assignee: who(t.assignee) } : {}),
      ...(team ? { team: safeText(team, C.NAME_MAX) } : {}),
      project: safeText(t.project, C.NAME_MAX),
      updatedAt: t.updatedAt,
      ...(safeText(last, C.TEXT_MAX) ? { last: safeText(last, C.TEXT_MAX) } : {}),
      ...(t.assignee ? { session: t.assignee } : {}),
    });
  }
  for (const w of src.workItems) {
    const meta = w.metadata?.['projectTicket'];
    if (linked.has(w.id) || (meta && typeof meta === 'object')) continue;
    const status = workItemStatus(w.status);
    const at = workItemUpdatedAt(w);
    if (!recentEnough(status, at)) continue;
    const team = w.target ? teamOfAgent.get(w.target) : undefined;
    const last = safeText(workItemLast(w), C.TEXT_MAX);
    items.push({
      ref: `wi:${w.id.slice(0, 8)}`,
      kind: 'work',
      title: safeText(w.title, C.TITLE_MAX) || 'Untitled work',
      status,
      ...(who(w.target) ? { assignee: who(w.target) } : {}),
      ...(team ? { team: safeText(team, C.NAME_MAX) } : {}),
      updatedAt: at,
      ...(last ? { last } : {}),
      ...(w.target ? { session: w.target } : {}),
    });
  }
  items.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  // --- agents ---------------------------------------------------------------
  const feed = messagesToOwner(src.ownerFeed.messages, src.ownerFeed.ownerTurns, src.agents.map((a) => a.agentSession));
  const agents: BriefingAgent[] = src.agents.slice(0, C.MAX_AGENTS).map((a) => {
    const running = src.workItems
      .filter((w) => w.target === a.agentSession && (w.status === 'running' || w.status === 'accepted'))
      .sort((x, y) => Date.parse(y.startedAt ?? y.createdAt) - Date.parse(x.startedAt ?? x.createdAt))[0];
    const ticket = running ? undefined : items.find((i) => i.kind === 'ticket' && i.session === a.agentSession && i.status === 'in_progress');
    const linkedTicket = running ? src.tickets.find((t) => t.workItemId === running.id) : undefined;
    const activity = running
      ? { title: safeText(linkedTicket?.title ?? running.title, C.TITLE_MAX), since: running.startedAt ?? running.createdAt, ref: linkedTicket?.id ?? `wi:${running.id.slice(0, 8)}` }
      : ticket
        ? { title: ticket.title, since: ticket.updatedAt, ref: ticket.ref }
        : undefined;
    const last = feed
      .filter((m) => (m.agentSession ?? m.senderId) === a.agentSession)
      .slice(0, C.MAX_LAST_TO_OWNER)
      .map((m) => ({ at: new Date(m.createdAt).toISOString(), text: safeText(m.content, C.TEXT_MAX) }))
      .filter((m) => m.text);
    return {
      session: a.agentSession,
      name: safeText(a.name, C.NAME_MAX) || a.agentSession,
      ...(a.team ? { team: safeText(a.team, C.NAME_MAX) } : {}),
      ...(a.role ? { role: safeText(a.role, C.NAME_MAX) } : {}),
      state: a.state,
      ...(activity && activity.title ? { activity } : {}),
      ...(last.length ? { lastToOwner: last } : {}),
    };
  });

  // --- waiting --------------------------------------------------------------
  const waiting: BriefingWaiting[] = src.waiting.slice(0, C.MAX_WAITING).map((w) => ({
    ref: waitingRef(w),
    kind: w.kind,
    from: safeText(w.agentName, C.NAME_MAX) || w.agentSession,
    ...(w.teamName || teamOfAgent.get(w.agentSession) ? { team: safeText(w.teamName ?? teamOfAgent.get(w.agentSession) ?? '', C.NAME_MAX) } : {}),
    summary: safeText(w.summary, C.TEXT_MAX) || 'Waiting on you',
    since: w.since,
    urgency: w.urgency,
  }));

  // --- teams ----------------------------------------------------------------
  const teams: BriefingTeam[] = src.teams.slice(0, C.MAX_TEAMS).map((t) => {
    const mine = items.filter((i) => i.team === safeText(t.name, C.NAME_MAX));
    const n = (s: BriefingItemStatus): number => mine.filter((i) => i.status === s).length;
    return {
      name: safeText(t.name, C.NAME_MAX),
      ...(t.lead && nameOf.get(t.lead) ? { lead: safeText(nameOf.get(t.lead) as string, C.NAME_MAX) } : {}),
      agents: t.members.map((m) => safeText(nameOf.get(m) ?? m, C.NAME_MAX)).filter(Boolean),
      open: n('open'),
      inProgress: n('in_progress'),
      review: n('review'),
      blocked: n('blocked'),
      doneToday: n('done'),
    };
  });

  const snapshot: BriefingSnapshot = {
    v: 1,
    generatedAt: src.now.toISOString(),
    teams,
    agents,
    items: items.slice(0, C.MAX_ITEMS).map(({ session: _session, ...i }) => i),
    waiting,
  };
  return capSnapshot(snapshot, C.MAX_BYTES);
}

/**
 * A spoken reference for a waiting item: the card id (`D-7`), the ticket
 * (`TKT-5`), or a short question id.
 *
 * @param w - Waiting item
 * @returns Reference
 */
export function waitingRef(w: Pick<SnapshotWaitingSource, 'id' | 'kind' | 'answerTarget'>): string {
  if (w.answerTarget.decisionId) return w.answerTarget.decisionId;
  if (w.answerTarget.tkt) return w.answerTarget.tkt;
  const tail = w.id.split(':').pop() ?? w.id;
  return `${w.kind === 'question' ? 'Q' : 'R'}-${tail.slice(0, 6)}`;
}

/**
 * Keep the snapshot under `maxBytes`: drop finished work first, then older
 * messages to the owner, then the least urgent items and waiting entries.
 *
 * @param s - Snapshot
 * @param maxBytes - Size cap (JSON)
 * @returns A snapshot within the cap
 */
export function capSnapshot(s: BriefingSnapshot, maxBytes: number): BriefingSnapshot {
  const out: BriefingSnapshot = { ...s, items: [...s.items], waiting: [...s.waiting], agents: s.agents.map((a) => ({ ...a })) };
  const size = (): number => Buffer.byteLength(JSON.stringify(out), 'utf8');
  while (size() > maxBytes) {
    const done = out.items.map((i) => i.status).lastIndexOf('done');
    if (done >= 0) {
      out.items.splice(done, 1);
      continue;
    }
    const chatty = out.agents.find((a) => (a.lastToOwner?.length ?? 0) > 1);
    if (chatty) {
      chatty.lastToOwner = chatty.lastToOwner?.slice(0, 1);
      continue;
    }
    if (out.items.length > 0) {
      out.items.pop();
      continue;
    }
    if (out.waiting.length > 0) {
      out.waiting.pop();
      continue;
    }
    break;
  }
  return out;
}
