/**
 * Wiring for the owner-thread sentinel: Slack posting, agent nudges, the
 * agent's owner work, and the mapping from decision cards / work items to
 * sentinel events. Kept apart from the service so its timeline logic stays
 * transport-free.
 *
 * @module services/messaging/owner-thread-sentinel.wiring
 * @see specs/2026-10-08-owner-thread-sentinel.md
 */

import * as path from 'path';
import { ORCHESTRATOR_SESSION_NAME, OWNER_THREAD_SENTINEL_CONSTANTS as C } from '../../constants.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { originOfWorkItem } from '../orc/work-item-destination.js';
import { isOwnerStopped } from '../agent/owner-stopped.registry.js';
import { pausedTeamOfSession } from '../team/team-pause.registry.js';
import { DecisionStore, PENDING_DECISION_STATUSES } from '../decisions/decision-store.js';
import type { OwnerMessageEntry } from './owner-message-watchdog.service.js';
import {
  OwnerThreadSentinelService,
  owingAgentsOnDisk,
  setOwnerThreadSentinel,
  type SentinelEvent,
  type SlackThreadRef,
} from './owner-thread-sentinel.service.js';

/** Work statuses that still hold the agent to an owner thread. */
const OPEN_WORK_STATUSES: ReadonlySet<string> = new Set(['running', 'accepted', 'blocked', 'queued', 'proposed']);

/**
 * A Slack link to a message (opens in the owner's workspace).
 *
 * @param slackChannelId - Channel
 * @param messageTs - Message ts
 * @param threadTs - Thread root, when the message is a reply
 * @returns URL
 */
export function slackMessageLink(slackChannelId: string, messageTs: string, threadTs?: string): string {
  const base = `https://slack.com/archives/${slackChannelId}/p${messageTs.replace('.', '')}`;
  return threadTs && threadTs !== messageTs ? `${base}?thread_ts=${threadTs}&cid=${slackChannelId}` : base;
}

/**
 * The owner Slack thread a work item came from, if it came from one.
 *
 * @param wi - Work item
 * @returns The thread, or null
 */
export function ownerThreadOfWorkItem(wi: WorkItem): SlackThreadRef | null {
  const origin = originOfWorkItem(wi);
  if (origin?.kind !== 'owner' || !origin.slackChannelId) return null;
  return { slackChannelId: origin.slackChannelId, ...(origin.threadTs ? { threadTs: origin.threadTs } : {}) };
}

/**
 * The owner thread of the agent's newest open work item (running, accepted,
 * blocked, queued), when that work came from an owner thread.
 *
 * @param items - Pool items
 * @param agent - The agent
 * @returns The thread, or null
 */
export function ownerThreadOfAgentWork(items: readonly WorkItem[], agent: string): SlackThreadRef | null {
  const mine = items
    .filter((wi) => wi.target === agent && OPEN_WORK_STATUSES.has(wi.status))
    .sort((a, b) => (Date.parse(b.startedAt ?? b.createdAt) || 0) - (Date.parse(a.startedAt ?? a.createdAt) || 0));
  for (const wi of mine) {
    const ref = ownerThreadOfWorkItem(wi);
    if (ref) return ref;
  }
  return null;
}

/**
 * What a decision card change means for the owner thread its asker owes.
 *
 * @param d - The decision (after the change)
 * @param what - `posted` (the card went up) or `settled` (any end state)
 * @returns The event, or null for harness-owned / orchestrator decisions
 */
export function sentinelEventForDecision(d: OwnerDecision, what: 'posted' | 'settled'): SentinelEvent | null {
  if (d.system) return null;
  // Only held browser actions need a pointer: every other card (questions an
  // agent asks, deploy OKs) is posted in the thread it is about, so a status
  // line for it only repeated the card — once per thread the agent owed
  // (2026-10-08: three Atlas question cards copied into two other threads).
  if (d.kind !== 'browser_action') return null;
  const link = d.card ? slackMessageLink(d.card.slackChannelId, d.card.messageTs, d.card.threadTs) : undefined;
  const browser = d.kind === 'browser_action';
  if (what === 'posted') {
    if (!d.card) return null;
    return {
      kind: 'card_posted',
      decisionId: d.id,
      question: d.question,
      ...(link ? { link } : {}),
      // Where the card can be seen: in a thread, or as the root of its own.
      place: { slackChannelId: d.card.slackChannelId, ...(d.card.threadTs ? { threadTs: d.card.threadTs } : { threadTs: d.card.messageTs }) },
      ...(browser ? { browser: true } : {}),
    };
  }
  switch (d.status) {
    case 'expired':
      return { kind: 'card_expired', decisionId: d.id, question: d.question, ...(link ? { link } : {}), ...(browser ? { browser: true, why: 'Crewly restarted and the held action was lost' } : {}) };
    case 'parked':
      return { kind: 'card_parked', decisionId: d.id, question: d.question, ...(link ? { link } : {}) };
    case 'resolved':
    case 'defaulted':
    case 'cancelled':
    case 'skipped':
      return { kind: 'card_settled', decisionId: d.id };
    default:
      return null;
  }
}

/**
 * Feed a watchdog-tracked owner message (Slack surface) to the sentinel.
 *
 * @param sentinel - The sentinel
 * @param entry - The tracked owner message
 */
export function onOwnerMessageTracked(sentinel: Pick<OwnerThreadSentinelService, 'noteOwnerMessage'>, entry: OwnerMessageEntry): void {
  if (entry.surface !== 'slack' || !entry.slackChannelId) return;
  const threadTs = entry.threadTs ?? entry.sourceTs;
  sentinel.noteOwnerMessage({ slackChannelId: entry.slackChannelId, ...(threadTs ? { threadTs } : {}), agent: entry.responsible, at: entry.receivedAt });
}

/** What the wiring needs from the rest of the backend. */
export interface OwnerThreadSentinelWiringDeps {
  crewlyHome: string;
  /** Slack posting (null while Slack is not wired) */
  slack: () => {
    isConnected(): boolean;
    sendMessage(m: { channelId: string; text: string; threadTs?: string; botToken?: string; notAnAnswer?: boolean; skipChatV2Mirror?: boolean; unfurlLinks?: boolean; unfurlMedia?: boolean }): Promise<string>;
  } | null;
  /** Bot token of the agent whose own app owns this Slack DM (the master bot cannot post there) */
  agentDmBotToken: (slackChannelId: string) => string | undefined;
  /** An agent's own bot token, when installed */
  botTokenOf: (session: string) => string | undefined;
  /** PTY / in-process delivery */
  sendToAgent: (session: string, text: string) => Promise<{ success: boolean }>;
  sessionExists: (session: string) => boolean;
  activate: (session: string) => Promise<{ success: boolean; error?: string }>;
  displayNameOf?: (session: string) => string;
  /** Pool items (owner work, current activity) */
  listItems: () => Promise<WorkItem[]>;
  /** Working status ("in_progress" / "idle"), when known */
  workingStatusOf?: (session: string) => string | null;
}

/**
 * Post a status line: Crewly's master bot (never counted as an answer); in an
 * agent-owned DM the agent's bot, the only one that can post there.
 *
 * @param deps - Wiring deps
 * @param thread - Where
 * @param agent - The agent it is about
 * @param text - The line
 * @returns True when posted
 */
export async function postSentinelStatus(deps: OwnerThreadSentinelWiringDeps, thread: SlackThreadRef, agent: string, text: string): Promise<boolean> {
  const slack = deps.slack();
  if (!slack?.isConnected()) return false;
  const base = { channelId: thread.slackChannelId, text, ...(thread.threadTs ? { threadTs: thread.threadTs } : {}), notAnAnswer: true, skipChatV2Mirror: true, unfurlLinks: false, unfurlMedia: false };
  const dmToken = deps.agentDmBotToken(thread.slackChannelId);
  try {
    await slack.sendMessage(dmToken ? { ...base, botToken: dmToken } : base);
    return true;
  } catch (err) {
    const fallback = !dmToken ? deps.botTokenOf(agent) : undefined;
    if (!fallback) throw err;
    await slack.sendMessage({ ...base, botToken: fallback });
    return true;
  }
}

/**
 * Deliver a sentinel reminder, waking the agent when it is down — never one
 * the owner stopped or whose team the owner paused.
 *
 * @param deps - Wiring deps
 * @param agent - The agent
 * @param text - The reminder
 * @returns True when delivered (or queued)
 */
export async function nudgeSentinelAgent(deps: OwnerThreadSentinelWiringDeps, agent: string, text: string): Promise<boolean> {
  if (pausedTeamOfSession(agent) || isOwnerStopped(agent)) return false;
  if (!deps.sessionExists(agent)) {
    const res = await deps.activate(agent).catch(() => ({ success: false }));
    if (!res.success) return false;
  }
  const res = await deps.sendToAgent(agent, text).catch(() => ({ success: false }));
  return res.success;
}

/**
 * What the agent is doing now, for an overdue-promise line.
 *
 * @param deps - Wiring deps
 * @param agent - The agent
 * @returns A few words, or null
 */
export async function describeAgentActivity(deps: OwnerThreadSentinelWiringDeps, agent: string): Promise<string | null> {
  const running = deps.sessionExists(agent);
  const items = await deps.listItems().catch(() => [] as WorkItem[]);
  const current = items
    .filter((wi) => wi.target === agent && OPEN_WORK_STATUSES.has(wi.status))
    .sort((a, b) => (Date.parse(b.startedAt ?? b.createdAt) || 0) - (Date.parse(a.startedAt ?? a.createdAt) || 0))[0];
  const what = current ? `“${current.title}” (${current.status === 'blocked' ? `blocked${current.blockedReason ? `: ${current.blockedReason}` : ''}` : current.status})` : null;
  if (!running) return what ? `not running; its open work is ${what}` : 'not running';
  const busy = deps.workingStatusOf?.(agent) === 'in_progress';
  if (what) return `${busy ? 'busy on' : 'idle, with open work'} ${what}`;
  return busy ? 'busy, with no work item' : 'idle, with no work item';
}

/**
 * Build the sentinel on the real transports and expose it as the singleton.
 *
 * @param deps - Wiring deps
 * @returns The started sentinel
 */
export function createOwnerThreadSentinel(deps: OwnerThreadSentinelWiringDeps): OwnerThreadSentinelService {
  const service = new OwnerThreadSentinelService({
    postStatus: (thread, agent, text) => postSentinelStatus(deps, thread, agent, text),
    nudgeAgent: (agent, text) => nudgeSentinelAgent(deps, agent, text),
    ...(deps.displayNameOf ? { displayNameOf: deps.displayNameOf } : {}),
    ownerWorkThread: async (agent) => ownerThreadOfAgentWork(await deps.listItems(), agent),
    currentActivity: (agent) => describeAgentActivity(deps, agent),
    storePath: path.join(deps.crewlyHome, C.STORE_FILENAME),
  });
  // Off switch: CREWLY_OWNER_THREAD_SENTINEL=off (no lines, no tracking).
  if ((process.env['CREWLY_OWNER_THREAD_SENTINEL'] ?? '').trim().toLowerCase() === 'off') return service;
  setOwnerThreadSentinel(service);
  service.start();
  return service;
}

/**
 * Agents an owner thread waits on at boot — restored as work in hand: the
 * sentinel's persisted threads (a promise, an unanswered owner message, an
 * open card) plus the askers of open, posted owner cards from the last
 * BOOT_CARD_MAX_AGE_MS. Read from disk: the restore can run before the
 * sentinel and the decision service start.
 *
 * @param crewlyHome - CREWLY_HOME
 * @param now - Clock
 * @param onError - Told about an unreadable store (non-fatal)
 * @returns Session names (never the orchestrator)
 */
export async function ownerThreadSessionsAtBoot(
  crewlyHome: string,
  now: number = Date.now(),
  onError?: (message: string, error: unknown) => void,
): Promise<string[]> {
  const out = new Set<string>();
  try {
    for (const s of owingAgentsOnDisk(path.join(crewlyHome, C.STORE_FILENAME), now)) out.add(s);
  } catch (error) {
    onError?.('Could not read the owner thread sentinel state at boot (non-fatal)', error);
  }
  try {
    const since = now - C.BOOT_CARD_MAX_AGE_MS;
    const open = await DecisionStore.inHome(crewlyHome).list(
      (d) => d.status === 'open' && PENDING_DECISION_STATUSES.has(d.status) && !d.system && !!d.card && Date.parse(d.createdAt) >= since,
    );
    for (const d of open) out.add(d.asker);
  } catch (error) {
    onError?.('Could not read open owner cards at boot (non-fatal)', error);
  }
  out.delete(ORCHESTRATOR_SESSION_NAME);
  return [...out];
}
