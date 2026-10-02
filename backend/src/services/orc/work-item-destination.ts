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
 * | no current work | a NEW top-level post in the team channel |
 *
 * Pure functions only; the effects live in `work-item-destination.wiring.ts`.
 *
 * @module services/orc/work-item-destination
 */

import { WORK_ITEM_DESTINATION_CONSTANTS } from '../../constants.js';
import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';
import type { TurnOrigin } from './orc-reply-route.service.js';
import { parseSlackThreadKey } from '../slack/slack-thread-key.js';

/** The origin a work item carries in `metadata.origin`. */
export type WorkItemOrigin =
  /** Asked by the owner in a conversation / Slack thread */
  | { kind: 'owner'; conversationId?: string; slackChannelId?: string; threadTs?: string; chatThreadId?: string }
  /** Work on a project ticket */
  | { kind: 'ticket'; projectPath: string; ticketId: string; title?: string; teamId?: string }
  /** Fired by a trigger or a cron task */
  | { kind: 'trigger'; triggerId?: string; cronTaskId?: string; destination?: string; teamId?: string; topic: string };

/** Where the answer goes. */
export type WorkDestination =
  /** The owner's turn origin — the existing `reply` path */
  | { kind: 'owner-origin'; origin: TurnOrigin; reason: string }
  /** The ticket's Slack thread (created with a `*ID · title*` root when missing) */
  | { kind: 'ticket-thread'; projectPath: string; ticketId: string; title?: string; teamId?: string; reason: string }
  /** An explicit Slack place (a trigger's destination): channel name/id, optional thread */
  | { kind: 'slack'; target: string; threadTs?: string; topic?: string; reason: string }
  /** A new top-level post in the agent's (or the work's) team channel */
  | { kind: 'new-top-level'; teamId?: string; topic?: string; reason: string };

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
 * @returns An owner origin
 */
export function ownerOriginFromTurn(turn: TurnOrigin): WorkItemOrigin {
  const key = parseSlackThreadKey(turn.slackThreadKey);
  const slackChannelId = key?.slackChannelId ?? turn.slackChannelId;
  const threadTs = key?.threadTs ?? turn.slackThreadTs;
  return {
    kind: 'owner',
    conversationId: turn.conversationId,
    ...(slackChannelId ? { slackChannelId } : {}),
    ...(threadTs ? { threadTs } : {}),
    ...(turn.chatThreadId ? { chatThreadId: turn.chatThreadId } : {}),
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
}

/**
 * The origin a new work item inherits (owner request → delegate → verify /
 * retry / subtask). Incident 2026-10-01: Atlas delegated the owner's
 * #morning-brief question to Sage; Sage's [DONE] made a verify item for
 * Atlas with no origin, and the answer's file landed in an unrelated thread.
 *
 * Order: an origin already stamped wins (null = keep it); then the parent's;
 * then the creator's current owner request; then the creator's current
 * work item's.
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
  const dest = input.creatorDestination;
  if (dest?.kind === 'owner-origin') return ownerOriginFromTurn(dest.origin);
  if (input.creatorWorkItem) return originOfWorkItem(input.creatorWorkItem);
  return null;
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
  return false;
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
