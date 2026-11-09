/**
 * Where an agent's answer goes, decided by the WORK it is answering
 * (specs/2026-10-01-decision-cards.md §6).
 *
 * Incident: Atlas posted the output of a scheduled task ("steveswiki 第一次季度
 * 回看…") into an unrelated #pro-think-tank thread. The 1.20.170 `reply` sent
 * every answer to "the thread the agent was last asked in", and a cron run
 * has no asker — so the last owner thread, however old, won.
 *
 * Now each work item carries its own origin and the answer follows it:
 *
 * | Work | Destination |
 * |---|---|
 * | owner asked (newest, < 2 h) | that conversation / thread (turn origin) |
 * | ticket work | the ticket's Slack thread (created on first post) |
 * | trigger / cron / auto work | the trigger's `destination`, else a NEW top-level post in the team channel |
 * | work an agent delegated on its own initiative | that agent, as an internal message (crewly#1357) |
 * | no current work | a NEW top-level post in the team channel |
 *
 * Pure functions only; the effects live in `work-item-destination.wiring.ts`.
 *
 * @module services/orc/work-item-destination
 */

import { TEAM_LEAD_REPORT_CONSTANTS, TL_DELEGATION_CONSTANTS, WORK_ITEM_DESTINATION_CONSTANTS } from '../../constants.js';
import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';
import type { TurnOrigin } from './orc-reply-route.service.js';
import { formatSlackThreadKey, parseSlackThreadKey, slackThreadTag } from '../slack/slack-thread-key.js';

/** The origin a work item carries in `metadata.origin`. */
export type WorkItemOrigin =
  /**
   * Asked by the owner in a conversation / Slack thread / app comment.
   * `receivedBy`: the agent the owner's message reached (it reports the
   * finished work back); `appComment`: the Crewly App comment it came from.
   */
  | {
      kind: 'owner';
      conversationId?: string;
      slackChannelId?: string;
      threadTs?: string;
      chatThreadId?: string;
      receivedBy?: string;
      appComment?: { appId: string; commentId: string };
    }
  /** Work on a project ticket */
  | { kind: 'ticket'; projectPath: string; ticketId: string; title?: string; teamId?: string }
  /** Fired by a trigger or a cron task */
  | { kind: 'trigger'; triggerId?: string; cronTaskId?: string; destination?: string; teamId?: string; topic: string }
  /**
   * Delegated by an agent on its own initiative (no owner conversation named,
   * crewly#1357): the result goes back to that agent, never to the owner.
   */
  | { kind: 'agent'; sessionName: string };

/**
 * Who reports finished team work to the owner, and where
 * (`metadata.leadReport`, crewly#1371; see `team-lead-report.ts`).
 */
export interface LeadReport {
  /** Session of the agent that reports (the team lead; the worker when the team has no lead) */
  lead: string;
  /** Its display name, when known */
  leadName?: string;
  /** Session of the agent that did the work */
  worker: string;
  /** Its display name, when known */
  workerName?: string;
  /** The team */
  teamId: string;
  teamName: string;
  /** The team's Slack channel */
  slackChannelId: string;
  /** Its name, without the `#` */
  channelName: string;
}

/**
 * Shape check for a stamped lead report.
 *
 * @param value - Anything
 * @returns True for a {@link LeadReport}
 */
export function isLeadReport(value: unknown): value is LeadReport {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return ['lead', 'worker', 'teamId', 'slackChannelId'].every((k) => typeof v[k] === 'string' && (v[k] as string).length > 0);
}

/**
 * The lead report a work item is stamped with (crewly#1371).
 *
 * @param wi - Work item
 * @returns The stamp, or null when its finished work is not reported by a team lead
 */
export function leadReportOf(wi: Pick<WorkItem, 'metadata'> | null | undefined): LeadReport | null {
  const stamp = ((wi?.metadata ?? {}) as Record<string, unknown>)[TEAM_LEAD_REPORT_CONSTANTS.METADATA_KEY];
  return isLeadReport(stamp) ? stamp : null;
}

/** Where the answer goes. */
export type WorkDestination =
  /** The owner's turn origin — the existing `reply` path */
  | { kind: 'owner-origin'; origin: TurnOrigin; reason: string }
  /** The ticket's Slack thread (created with a `*ID · title*` root when missing) */
  | { kind: 'ticket-thread'; projectPath: string; ticketId: string; title?: string; teamId?: string; reason: string }
  /** An explicit Slack place (a trigger's destination): channel name/id, optional thread */
  | { kind: 'slack'; target: string; threadTs?: string; topic?: string; reason: string }
  /** A new top-level post in the agent's (or the work's) team channel */
  | { kind: 'new-top-level'; teamId?: string; topic?: string; reason: string }
  /** An internal message to the agent that delegated the work (`workItemId`: the work it answers) */
  | { kind: 'agent'; sessionName: string; workItemId?: string; reason: string };

/** Statuses in which a work item is the agent's current work. */
const CURRENT_STATUSES: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>(['running', 'accepted']);

/**
 * Build the origin stamped on a trigger- or cron-created work item.
 *
 * @param input - Trigger/cron ids, its destination, team and a topic
 * @returns The origin (topic shortened to one line)
 */
export function buildTriggerOrigin(input: {
  triggerId?: string;
  cronTaskId?: string;
  destination?: string;
  teamId?: string;
  topic: string;
}): WorkItemOrigin {
  return {
    kind: 'trigger',
    ...(input.triggerId ? { triggerId: input.triggerId } : {}),
    ...(input.cronTaskId ? { cronTaskId: input.cronTaskId } : {}),
    ...(input.destination?.trim() ? { destination: input.destination.trim() } : {}),
    ...(input.teamId ? { teamId: input.teamId } : {}),
    topic: shortTopic(input.topic),
  };
}

/**
 * The origin of work an agent delegated on its own initiative: the delegating
 * agent itself (crewly#1357). Its result is reported to that agent, which
 * decides what, if anything, the owner hears.
 *
 * @param sessionName - The delegating agent's session
 * @returns An agent origin
 */
export function buildAgentOrigin(sessionName: string): WorkItemOrigin {
  return { kind: 'agent', sessionName };
}

/**
 * One-line topic, capped at {@link WORK_ITEM_DESTINATION_CONSTANTS.TOPIC_MAX_CHARS}.
 *
 * @param text - Any text
 * @returns Single line, possibly shortened with an ellipsis
 */
export function shortTopic(text: string | undefined): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const max = WORK_ITEM_DESTINATION_CONSTANTS.TOPIC_MAX_CHARS;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The agent's current work item: the newest (by start) item targeted at it
 * that is running or accepted.
 *
 * @param items - Pool items
 * @param session - Agent session
 * @returns The item, or null
 */
export function currentWorkItemOf(items: readonly WorkItem[], session: string): WorkItem | null {
  let best: WorkItem | null = null;
  let bestAt = -Infinity;
  for (const wi of items) {
    if (wi.target !== session || !CURRENT_STATUSES.has(wi.status)) continue;
    const at = startOf(wi);
    if (at > bestAt) {
      best = wi;
      bestAt = at;
    }
  }
  return best;
}

/**
 * When a work item started (else when it was created).
 *
 * @param wi - Work item
 * @returns Epoch ms (0 when unreadable)
 */
function startOf(wi: Pick<WorkItem, 'startedAt' | 'createdAt'>): number {
  return Date.parse(wi.startedAt ?? '') || Date.parse(wi.createdAt) || 0;
}

/**
 * The origin of a work item: its stamped `metadata.origin`, else what its
 * other fields say (a linked project ticket, a trigger, a cron task).
 *
 * @param wi - Work item
 * @returns The origin, or null when nothing tells where it came from
 */
export function originOfWorkItem(wi: WorkItem): WorkItemOrigin | null {
  const meta = (wi.metadata ?? {}) as Record<string, unknown>;
  const stamped = meta[WORK_ITEM_DESTINATION_CONSTANTS.METADATA_KEY];
  if (isWorkItemOrigin(stamped)) return stamped;
  const link = meta.projectTicket as { projectPath?: unknown; id?: unknown } | undefined;
  if (link && typeof link.projectPath === 'string' && typeof link.id === 'string') {
    return {
      kind: 'ticket',
      projectPath: link.projectPath,
      ticketId: link.id,
      ...(typeof meta.teamId === 'string' ? { teamId: meta.teamId } : {}),
    };
  }
  if (wi.triggerId) return buildTriggerOrigin({ triggerId: wi.triggerId, topic: wi.title });
  if (meta.source === 'cron') {
    return buildTriggerOrigin({
      ...(typeof meta.cronTaskId === 'string' ? { cronTaskId: meta.cronTaskId } : {}),
      ...(typeof meta.targetTeamId === 'string' ? { teamId: meta.targetTeamId } : {}),
      topic: wi.description ?? wi.title,
    });
  }
  return null;
}

/**
 * The origin an owner turn gives the work started from it.
 *
 * @param turn - The owner's turn origin (OrcReplyRouteService)
 * @param receivedBy - The agent the owner's message reached, when known
 * @returns An owner origin
 */
export function ownerOriginFromTurn(turn: TurnOrigin, receivedBy?: string): WorkItemOrigin {
  const key = parseSlackThreadKey(turn.slackThreadKey);
  const slackChannelId = key?.slackChannelId ?? turn.slackChannelId;
  const threadTs = key?.threadTs ?? turn.slackThreadTs;
  return {
    kind: 'owner',
    conversationId: turn.conversationId,
    ...(slackChannelId ? { slackChannelId } : {}),
    ...(threadTs ? { threadTs } : {}),
    ...(turn.chatThreadId ? { chatThreadId: turn.chatThreadId } : {}),
    ...(receivedBy ? { receivedBy } : {}),
  };
}

/** Inputs of {@link inheritedOrigin}. */
export interface InheritOriginInput {
  /** The item being created */
  workItem: WorkItem;
  /** The item it continues (verify / retry / subtask parent), when it has one */
  parent: WorkItem | null;
  /** Where the creating agent's current work came from (its plan), when an agent creates it */
  creatorDestination: WorkDestination | null;
  /** The creating agent's current work item */
  creatorWorkItem: WorkItem | null;
  /** The creating agent (stamped as `receivedBy` on an owner origin taken from its turn) */
  creatorSession?: string;
  /**
   * An owner request the creator is handling that is not a chat turn: an
   * app comment delivered to it, or an owner request a colleague handed it
   * (see `owner-request-context.ts`). `at` = when it reached the creator.
   */
  creatorOwnerContext?: { origin: WorkItemOrigin; at: number } | null;
  /**
   * True when an agent hands the item to someone else (target is not the
   * creator). Such a delegation never inherits the creator's owner turn,
   * owner context or current work: without an owner conversation named
   * explicitly its origin is the creator itself (crewly#1357).
   */
  delegation?: boolean;
  /** Clock (epoch ms); defaults to Date.now() */
  now?: number;
}

/**
 * The origin a new work item inherits (owner request → delegate → verify /
 * retry / subtask). Incident 2026-10-01: Atlas delegated the owner's
 * #morning-brief question to Sage; Sage's [DONE] made a verify item for
 * Atlas with no origin, and the answer's file landed in an unrelated thread.
 *
 * Order: an origin already stamped wins (null = keep it); then the parent's;
 * then the creator's current owner request (the newer of its owner turn and
 * its owner context — an app comment or a colleague's hand-over — when that
 * is newer than its current work item); then the creator's current work
 * item's.
 *
 * Incident 2026-10-07: the owner's app comment reached Lyra (no chat turn),
 * Lyra handed it to Ella by message, and Ella's tickets carried no owner
 * origin, so nothing linked their completion back to the owner.
 *
 * Incident 2026-10-17 (crewly#1357): Ella delegated work of her own to Lyra
 * and the item took an owner DM from nine days earlier (her running item's
 * origin); later two delegations made while she answered the owner in a
 * video thread took that thread. Lyra's internal report and the harness's
 * "finished" summary both went to the owner. So an agent's DELEGATION
 * (`delegation: true`) inherits nothing from the creator's turn, context or
 * current work: its origin is the creator (an agent origin), unless the
 * caller named the owner conversation (handled before this, by the task
 * pool) or the item continues a parent. An owner origin read off the
 * creator's current work item is also dropped once that work is older than
 * {@link WORK_ITEM_DESTINATION_CONSTANTS.ORIGIN_INHERIT_MAX_AGE_MS}.
 *
 * @param input - New item, its parent, the creator's current work
 * @returns The origin to stamp, or null (nothing to inherit / already stamped)
 */
export function inheritedOrigin(input: InheritOriginInput): WorkItemOrigin | null {
  const meta = (input.workItem.metadata ?? {}) as Record<string, unknown>;
  if (isWorkItemOrigin(meta[WORK_ITEM_DESTINATION_CONSTANTS.METADATA_KEY])) return null;
  if (input.parent) {
    const fromParent = originOfWorkItem(input.parent);
    if (fromParent) return fromParent;
  }
  const { creatorWorkItem, creatorSession } = input;
  if (input.delegation) return creatorSession ? buildAgentOrigin(creatorSession) : null;
  const now = input.now ?? Date.now();
  const wiStart = creatorWorkItem ? startOf(creatorWorkItem) : -Infinity;
  const rawWiOrigin = creatorWorkItem ? originOfWorkItem(creatorWorkItem) : null;
  // An owner request behind work older than the cap is not current any more.
  const wiOwnerStale = rawWiOrigin?.kind === 'owner' && now - wiStart > WORK_ITEM_DESTINATION_CONSTANTS.ORIGIN_INHERIT_MAX_AGE_MS;
  const wiOrigin = wiOwnerStale ? null : rawWiOrigin;
  let fromTurn: { origin: WorkItemOrigin; at: number } | null = null;
  const dest = input.creatorDestination;
  if (dest?.kind === 'owner-origin') {
    // planWorkDestination also answers owner-origin for a work item that was
    // itself asked by the owner (receivedAt = its start): keep that item's
    // own origin then, which knows who received the request (or nothing,
    // when that request is stale).
    const isTheWorkItem = !!creatorWorkItem && rawWiOrigin?.kind === 'owner' && dest.origin.receivedAt <= wiStart;
    if (!isTheWorkItem) fromTurn = { origin: ownerOriginFromTurn(dest.origin, creatorSession), at: dest.origin.receivedAt };
  }
  const ctx = input.creatorOwnerContext && input.creatorOwnerContext.at >= wiStart ? input.creatorOwnerContext : null;
  const pick = fromTurn && ctx ? (ctx.at > fromTurn.at ? ctx : fromTurn) : fromTurn ?? ctx;
  if (pick) return pick.origin;
  return wiOrigin;
}

/**
 * Shape check for a stamped origin.
 *
 * @param value - Anything
 * @returns True for a {@link WorkItemOrigin}
 */
export function isWorkItemOrigin(value: unknown): value is WorkItemOrigin {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.kind === 'owner') return true;
  if (v.kind === 'ticket') return typeof v.projectPath === 'string' && typeof v.ticketId === 'string';
  if (v.kind === 'trigger') return typeof v.topic === 'string';
  if (v.kind === 'agent') return typeof v.sessionName === 'string' && v.sessionName.length > 0;
  return false;
}

/**
 * Whether an owner request is too old for new work to inherit its origin
 * (crewly#1357). An unknown age (`null`) is not too old: nothing says so.
 *
 * @param askedAt - When the owner last asked there (epoch ms), or null when unknown
 * @param now - Clock (epoch ms)
 * @returns True when older than {@link WORK_ITEM_DESTINATION_CONSTANTS.ORIGIN_INHERIT_MAX_AGE_MS}
 */
export function isOwnerRequestTooOld(askedAt: number | null | undefined, now: number): boolean {
  return typeof askedAt === 'number' && Number.isFinite(askedAt) && now - askedAt > WORK_ITEM_DESTINATION_CONSTANTS.ORIGIN_INHERIT_MAX_AGE_MS;
}

/**
 * Split a trigger destination into a post target and an optional thread.
 *
 * @param destination - `#name`, `C…` or `C…:<ts>`
 * @returns Target + thread, or null when unreadable
 */
export function parseDestination(destination: string): { target: string; threadTs?: string } | null {
  const d = destination.trim();
  const thread = /^([CG][A-Z0-9]{6,}):(\d{6,}\.\d+)$/.exec(d);
  if (thread) return { target: thread[1], threadTs: thread[2] };
  if (/^[CG][A-Z0-9]{6,}$/.test(d)) return { target: d };
  if (/^#[a-z0-9][a-z0-9._-]*$/.test(d)) return { target: d };
  return null;
}

/** Inputs of {@link planWorkDestination}. */
export interface WorkDestinationInput {
  /** The agent's current work item (see {@link currentWorkItemOf}) */
  workItem: WorkItem | null;
  /** The agent's last owner turn origin (OrcReplyRouteService) */
  ownerOrigin?: TurnOrigin;
  /** Clock (epoch ms) */
  now: number;
}

/**
 * Decide where the answer to the agent's current work goes.
 *
 * The current work is the newer of the running work item and the last owner
 * message — the owner message only counts while it is fresh
 * ({@link WORK_ITEM_DESTINATION_CONSTANTS.OWNER_ORIGIN_FRESH_MS}).
 *
 * @param input - Current work item, owner origin, clock
 * @returns The destination
 */
export function planWorkDestination(input: WorkDestinationInput): WorkDestination {
  const { workItem, ownerOrigin, now } = input;
  const ownerFresh = !!ownerOrigin && now - ownerOrigin.receivedAt < WORK_ITEM_DESTINATION_CONSTANTS.OWNER_ORIGIN_FRESH_MS;
  if (ownerOrigin && ownerFresh && (!workItem || ownerOrigin.receivedAt >= startOf(workItem))) {
    return { kind: 'owner-origin', origin: ownerOrigin, reason: workItem ? 'the owner asked after the work item started' : 'the owner asked (no work item running)' };
  }
  if (!workItem) {
    return { kind: 'new-top-level', reason: ownerOrigin ? 'no current work; the last owner message is stale' : 'no current work' };
  }
  const origin = originOfWorkItem(workItem);
  if (!origin) {
    return { kind: 'new-top-level', topic: shortTopic(workItem.title), reason: `work item ${workItem.id} has no recorded origin` };
  }
  switch (origin.kind) {
    case 'owner': {
      // Team work the orchestrator delegated for the owner: answers about it go
      // to the team channel, where the lead reports it (crewly#1371) — never
      // into the orchestrator's thread with the owner.
      const leadReport = leadReportOf(workItem);
      if (leadReport) {
        return {
          kind: 'new-top-level',
          // No topic line: the report is one or two plain lines for the owner.
          teamId: leadReport.teamId,
          reason: `work item ${workItem.id} is team work ${leadReport.leadName ?? leadReport.lead} reports to the owner in #${leadReport.channelName}`,
        };
      }
      if (origin.conversationId) {
        const threadKey = origin.slackChannelId && origin.threadTs ? `${origin.slackChannelId}:${origin.threadTs}` : undefined;
        return {
          kind: 'owner-origin',
          origin: {
            conversationId: origin.conversationId,
            ...(origin.slackChannelId ? { slackChannelId: origin.slackChannelId } : {}),
            ...(origin.threadTs ? { slackThreadTs: origin.threadTs } : {}),
            ...(threadKey ? { slackThreadKey: threadKey } : {}),
            ...(origin.chatThreadId ? { chatThreadId: origin.chatThreadId } : {}),
            receivedAt: startOf(workItem),
          },
          reason: `work item ${workItem.id} was asked by the owner`,
        };
      }
      if (origin.slackChannelId) {
        return { kind: 'slack', target: origin.slackChannelId, ...(origin.threadTs ? { threadTs: origin.threadTs } : {}), reason: `work item ${workItem.id} was asked by the owner in Slack` };
      }
      return { kind: 'new-top-level', topic: shortTopic(workItem.title), reason: `work item ${workItem.id} owner origin has no place` };
    }
    case 'ticket':
      return {
        kind: 'ticket-thread',
        projectPath: origin.projectPath,
        ticketId: origin.ticketId,
        ...(origin.title ? { title: origin.title } : {}),
        ...(origin.teamId ? { teamId: origin.teamId } : {}),
        reason: `work item ${workItem.id} is ticket ${origin.ticketId}`,
      };
    case 'trigger': {
      const parsed = origin.destination ? parseDestination(origin.destination) : null;
      if (parsed) {
        return {
          kind: 'slack',
          target: parsed.target,
          ...(parsed.threadTs ? { threadTs: parsed.threadTs } : { topic: origin.topic }),
          reason: `scheduled work item ${workItem.id}: its trigger's destination`,
        };
      }
      return {
        kind: 'new-top-level',
        ...(origin.teamId ? { teamId: origin.teamId } : {}),
        topic: origin.topic,
        reason: `scheduled work item ${workItem.id}: new top-level post`,
      };
    }
    case 'agent':
      return { kind: 'agent', sessionName: origin.sessionName, workItemId: workItem.id, reason: `work item ${workItem.id} was delegated by ${origin.sessionName} on its own initiative` };
  }
}

/**
 * The text of a new top-level post: the topic line in bold, then the body.
 *
 * @param topic - Topic (may be empty)
 * @param text - Body
 * @returns Post text
 */
export function withTopicLine(topic: string | undefined, text: string): string {
  const t = shortTopic(topic);
  if (!t) return text;
  // An agent that already opened with the topic needs no second copy.
  if (text.trimStart().startsWith(`*${t}*`)) return text;
  return `*${t}*\n${text}`;
}

/**
 * The owner origin a delegation names explicitly (`delegate-task --thread
 * <key>`, specs/2026-10-04-tl-delegation.md §1).
 *
 * @param rawKey - Slack thread key (or the whole `[SLACK-THREAD:…]` tag)
 * @param conversationId - The conversation the thread belongs to, when known
 * @returns The origin, or null when the key is unreadable
 */
export function ownerOriginFromThreadKey(rawKey: unknown, conversationId?: string | null): WorkItemOrigin | null {
  const key = parseSlackThreadKey(rawKey);
  if (!key) return null;
  return {
    kind: 'owner',
    ...(conversationId ? { conversationId } : {}),
    slackChannelId: key.slackChannelId,
    threadTs: key.threadTs,
  };
}

/**
 * The owner origin a delegation names by chat conversation (`delegate-task
 * --conversation <id>`, crewly#1357).
 *
 * @param rawId - Conversation id
 * @param chatThreadId - Thread root message id in that conversation, when the owner asked in a thread
 * @returns The origin, or null when the id is unusable
 */
export function ownerOriginFromConversation(rawId: unknown, chatThreadId?: string | null): WorkItemOrigin | null {
  if (typeof rawId !== 'string') return null;
  const conversationId = rawId.trim();
  if (!conversationId || /\s/.test(conversationId)) return null;
  return { kind: 'owner', conversationId, ...(chatThreadId ? { chatThreadId } : {}) };
}

/**
 * The line a delegated member gets when its work came from the delegating
 * agent itself, not from the owner (crewly#1357): the result goes to that
 * agent, nothing to the owner.
 *
 * @param wi - The stored work item
 * @param delegatorName - Who delegated it (name or session)
 * @returns Who gets the result + the note, or null when the item has no agent origin
 */
export function delegatorResultNote(wi: WorkItem, delegatorName?: string): { to: string; note: string } | null {
  const origin = originOfWorkItem(wi);
  if (origin?.kind !== 'agent') return null;
  const who = delegatorName ?? origin.sessionName;
  const note =
    `${who} delegated this on their own initiative; the owner did not ask for it in any thread. ` +
    `Report your result to ${who}: reply --work-item ${wi.id} "<message>". Do not post it to the owner.`;
  return { to: origin.sessionName, note };
}

/** Statuses in which a work item still owns its owner thread. */
const THREAD_HOLDING_STATUSES: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>(['queued', 'proposed', 'accepted', 'running', 'blocked', 'escalated']);
/** Statuses that ended the work; the thread stays open to it for a grace period. */
const THREAD_DONE_STATUSES: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>(['done_by_worker', 'verified', 'done']);

/**
 * Whether `session` was handed work that came from this owner Slack thread:
 * a live work item targeted at it whose owner origin is the thread (or one
 * finished within {@link TL_DELEGATION_CONSTANTS.DONE_THREAD_GRACE_MS}). Its
 * posts there are answers it owes, never "a second responder".
 *
 * @param items - Pool items
 * @param session - Agent about to post
 * @param slackChannelId - Thread's Slack channel
 * @param threadTs - Thread root ts
 * @param now - Clock (epoch ms)
 * @returns True when the agent holds work from that thread
 */
export function isDelegatedInThread(
  items: readonly WorkItem[],
  session: string,
  slackChannelId: string,
  threadTs: string,
  now: number,
): boolean {
  for (const wi of items) {
    if (wi.target !== session) continue;
    const origin = originOfWorkItem(wi);
    if (origin?.kind !== 'owner' || origin.slackChannelId !== slackChannelId || origin.threadTs !== threadTs) continue;
    if (THREAD_HOLDING_STATUSES.has(wi.status)) return true;
    if (THREAD_DONE_STATUSES.has(wi.status)) {
      const ended = Date.parse(wi.completedAt ?? '') || 0;
      if (ended && now - ended <= TL_DELEGATION_CONSTANTS.DONE_THREAD_GRACE_MS) return true;
    }
  }
  return false;
}

/**
 * The line a delegated member gets when its work came from an owner Slack
 * thread: answer there yourself, under your own name.
 *
 * @param wi - The stored work item
 * @param delegatorName - Who delegated it (name or session), for the "does not relay" line
 * @returns Thread key + note, or null when the item has no owner Slack thread
 */
export function ownerThreadHandover(wi: WorkItem, delegatorName?: string): { key: string; note: string } | null {
  const origin = originOfWorkItem(wi);
  if (origin?.kind !== 'owner' || !origin.slackChannelId || !origin.threadTs) return null;
  if (!wi.target || wi.target === delegatorName) return null;
  // Its lead reports it in the team channel (crewly#1371): no answer in the owner's thread.
  if (leadReportOf(wi)) return null;
  const key = formatSlackThreadKey(origin.slackChannelId, origin.threadTs);
  const relay = delegatorName ? ` ${delegatorName} does not relay it for you.` : '';
  const note =
    `The owner asked for this in Slack thread ${slackThreadTag(origin.slackChannelId, origin.threadTs)}. ` +
    `Post your progress and your result there yourself, under your own name: reply --work-item ${wi.id} "<message>".${relay}` +
    // CREW-957: the Slack ts is not a Crewly id. A member that copied it into
    // reply-channel --thread got 404/400 and fell back to a plain reply that
    // landed in another owner thread. Name the Crewly ids, and the one skill
    // that takes --work-item.
    (origin.chatThreadId
      ? ` The Crewly thread id is ${origin.chatThreadId}${origin.conversationId ? ` in conversation ${origin.conversationId}` : ''}; if you must use reply-channel, pass that id as --thread (never the Slack ts) — reply-channel has no --work-item flag.`
      : ` --work-item belongs to reply only; reply-channel does not take it.`);
  return { key, note };
}
