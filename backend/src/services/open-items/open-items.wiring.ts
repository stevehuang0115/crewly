/**
 * Open items — wiring with the real requests, task pool, decision cards,
 * Slack and chat (specs/2026-10-01-reply-open-items.md). Process-specific
 * hooks (how to reach an agent) come from `index.ts`.
 *
 * @module services/open-items/open-items.wiring
 */

import { OPEN_ITEMS_CONSTANTS, WORK_ITEM_DESTINATION_CONSTANTS } from '../../constants.js';
import type { Team } from '../../types/index.js';
import type { Request } from '../../types/v2/request.types.js';
import { createWorkItem, WORK_ITEM_BLOCK_SOURCES, type WorkItem } from '../../types/v2/work-item.types.js';
import { formatTicketNumber } from '../../types/v2/ticket.types.js';
import { RequestService } from '../v3/request.service.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { getSlackService } from '../slack/slack.service.js';
import { DecisionService } from '../decisions/decision.service.js';
import { defaultDeadline } from '../decisions/decision-contract.js';
import { formatWhen } from '../decisions/decision-card.js';
import { LoggerService } from '../core/logger.service.js';
import { OpenItemsService, slackPlaceOf, type FollowUpInput, type QuestionCardInput } from './open-items.service.js';

/** What the composition root provides. */
export interface OpenItemsWiringInput {
  getTeams: () => Promise<Team[]>;
  /** Deliver text to an agent, waking it when stopped */
  sendToAgent: (session: string, text: string) => Promise<boolean>;
  /** Record a system note in a chat-v2 conversation (chat-only tickets) */
  recordChatNote: (chatChannelId: string, threadId: string | undefined, text: string) => boolean;
}

const logger = LoggerService.getInstance().createComponentLogger('OpenItems');

/**
 * The follow-up WorkItem for a commitment: targeted at the agent, held
 * (explicitly blocked, so nothing re-queues or dispatches it) until the
 * promise is delivered, carrying the conversation as its origin so a
 * `reply` while on it goes back to the owner's thread.
 *
 * @param input - Request, item, Slack place
 * @param now - Clock
 * @returns The WorkItem (not yet added)
 */
export function buildFollowUpWorkItem(input: FollowUpInput, now: Date = new Date()): WorkItem {
  const { request, item, place } = input;
  const tkt = typeof request.ticketNumber === 'number' ? formatTicketNumber(request.ticketNumber) : request.id.slice(0, 8);
  const due = item.due ? new Date(item.due) : null;
  const flat = item.text.replace(/\s+/g, ' ').trim();
  const where = place ? ` (--thread ${place.slackChannelId}:${place.threadTs})` : '';
  const children = item.childWorkItemIds?.length ? `\nIt waits on: ${item.childWorkItemIds.join(', ')}. You are woken when that work is finished.` : '';
  const wi = createWorkItem({
    type: 'delegate',
    owner: 'system',
    target: item.agent,
    title: `Follow-up for the owner (${tkt}): ${flat.length > 80 ? `${flat.slice(0, 79)}…` : flat}`,
    description:
      `You promised the owner in ${tkt}'s thread: "${flat}"` +
      (due ? `\nDue: ${formatWhen(due, now)} (${due.toISOString()}).` : '') +
      `\nCrewly tracks it: post the deliverable in that thread${where}; that closes this item.` +
      children,
    metadata: {
      [OPEN_ITEMS_CONSTANTS.FOLLOW_UP_METADATA_KEY]: { requestId: request.id, itemId: item.id },
      ...(item.due ? { dueAt: item.due } : {}),
      [WORK_ITEM_DESTINATION_CONSTANTS.METADATA_KEY]: {
        kind: 'owner',
        ...(place ? { slackChannelId: place.slackChannelId, threadTs: place.threadTs } : {}),
        ...(request.chatRef ? { conversationId: request.chatRef.channelId, chatThreadId: request.chatRef.threadRootId } : {}),
      },
    },
  });
  wi.status = 'blocked';
  wi.blockSource = WORK_ITEM_BLOCK_SOURCES.EXPLICIT;
  wi.blockedReason = due ? `Waiting for the promised work (due ${due.toISOString()})` : 'Waiting for the promised work';
  return wi;
}

/**
 * Members by session across teams.
 *
 * @param teams - Teams
 * @returns session → { name, teamId }
 */
function membersBySession(teams: Team[]): Map<string, { name: string; teamId: string }> {
  const out = new Map<string, { name: string; teamId: string }>();
  for (const t of teams) {
    for (const m of t.members ?? []) {
      if (m.sessionName) out.set(m.sessionName, { name: m.name || m.sessionName, teamId: t.id });
    }
  }
  return out;
}

/**
 * Build the service on the real collaborators.
 *
 * @param input - Composition-root hooks
 * @returns The service (not started)
 */
export function createOpenItemsService(input: OpenItemsWiringInput): OpenItemsService {
  const pool = (): TaskPoolService => TaskPoolService.getInstance();
  const nameOf = async (session: string): Promise<string> => membersBySession(await input.getTeams().catch(() => [])).get(session)?.name ?? session;

  return new OpenItemsService({
    requests: RequestService.getInstance(),
    listWorkItems: () => pool().getAllItems(),
    createFollowUp: async (fu: FollowUpInput) => {
      const wi = buildFollowUpWorkItem(fu);
      await pool().addToPool(wi);
      return wi.id;
    },
    closeFollowUp: async (id, outcome, reason) => {
      const wi = await pool().findWorkItem(id);
      if (!wi || ['done', 'verified', 'cancelled'].includes(wi.status)) return;
      if (outcome === 'cancelled') {
        if (['queued', 'blocked', 'scheduled'].includes(wi.status)) await pool().cancelQueued(id, reason);
        return;
      }
      if (wi.status !== 'running') await pool().updateItemStatus(id, 'running', { role: 'system', via: 'open-items:delivered' });
      await pool().updateItemStatus(id, 'done', { role: 'system', via: 'open-items:delivered' });
    },
    recentDecisionsBy: async (agent, sinceMs) => {
      const all = (await DecisionService.getInstance()?.list('all')) ?? [];
      return all.filter((d) => d.asker === agent && Date.parse(d.createdAt) >= sinceMs);
    },
    askQuestion: async (q: QuestionCardInput) => {
      const decisions = DecisionService.getInstance();
      if (!decisions) return null;
      const tkt = typeof q.request.ticketNumber === 'number' ? formatTicketNumber(q.request.ticketNumber) : undefined;
      const name = await nameOf(q.item.agent);
      return decisions.askPrebuilt({
        kind: 'reply_question',
        asker: q.item.agent,
        question: q.card.question,
        options: q.card.options,
        defaultKey: q.card.defaultKey,
        ...(q.card.yesKey ? { yesKey: q.card.yesKey } : {}),
        deadline: defaultDeadline(new Date()),
        ...(q.card.sensitive ? { sensitive: q.card.sensitive } : {}),
        title: tkt ? `${tkt} · ${name} asks` : `${name} asks`,
        ...(q.place ? { place: { slackChannelId: q.place.slackChannelId, threadTs: q.place.threadTs } } : {}),
        requestRef: { requestId: q.request.id, itemId: q.item.id },
        source: q.source ?? 'live',
        askedAt: q.item.createdAt,
      });
    },
    skippedQuestion: async (requestId, agent, question) =>
      (await DecisionService.getInstance()?.findSkipped({ requestId, asker: agent }, question)) ?? null,
    skipQuestion: async (decisionId) => {
      const decisions = DecisionService.getInstance();
      if (!decisions) return false;
      const d = await decisions.get(decisionId);
      if (!d || (d.status !== 'open' && d.status !== 'parked')) return false;
      await decisions.skipFromDashboard(decisionId);
      return true;
    },
    cancelQuestion: async (decisionId, note) => {
      await DecisionService.getInstance()?.cancelWhere((d) => d.id === decisionId, note);
    },
    getDecision: async (id) => (await DecisionService.getInstance()?.get(id)) ?? null,
    deliverToAgent: input.sendToAgent,
    postOwnerNote: async (request: Request, text: string) => {
      const place = slackPlaceOf(request);
      const slack = getSlackService();
      if (place && slack.isConnected()) {
        await slack.sendMessage({ channelId: place.slackChannelId, threadTs: place.threadTs, text, notAnAnswer: true, skipChatV2Mirror: true });
        return true;
      }
      if (request.chatRef) return input.recordChatNote(request.chatRef.channelId, request.chatRef.threadRootId, text);
      logger.warn('No place to tell the owner about a late promise', { id: request.id });
      return false;
    },
    displayName: nameOf,
    colleagueNames: async (session) => {
      const teams = await input.getTeams().catch(() => [] as Team[]);
      return teams.flatMap((t) => t.members ?? []).filter((m) => m.sessionName !== session && !!m.name).map((m) => m.name);
    },
    ownerSlackUserId: () => getSlackService().getOwnerUserId?.() ?? null,
  });
}

/**
 * Create, install and start the service; register the decision kind.
 *
 * @param input - Composition-root hooks
 * @returns The started service
 */
export function startOpenItems(input: OpenItemsWiringInput): OpenItemsService {
  const service = createOpenItemsService(input);
  OpenItemsService.getInstance()?.stop();
  OpenItemsService.setInstance(service);
  DecisionService.registerKindHandler('reply_question', {
    onSettled: (d, fallback) => service.onDecisionSettled(d, fallback),
  });
  service.start();
  return service;
}
