/**
 * Decision cards — wiring with the real Slack, tickets, teams and agents
 * (specs/2026-10-01-decision-cards.md). Everything process-specific (how to
 * reach an agent, the composition root's singletons) is passed in by
 * `index.ts`; the rest is resolved here.
 *
 * @module services/decisions/decision.wiring
 */

import { ORCHESTRATOR_SESSION_NAME, TICKET_AUTOPILOT_CONSTANTS } from '../../constants.js';
import type { Team } from '../../types/index.js';
import type { SlackIncomingMessage, SlackInteractionEvent, SlackReactionEvent } from '../../types/slack.types.js';
import { isUserAllowed } from '../../types/slack.types.js';
import { LoggerService } from '../core/logger.service.js';
import { getSlackService } from '../slack/slack.service.js';
import { getSlackAgentIdentityService } from '../slack/slack-agent-identity.service.js';
import { getSlackInstanceRegistryService } from '../slack/slack-instance-registry.service.js';
import { getSlackTeamChannelService, slackIdentityFor } from '../slack/slack-team-channel.service.js';
import { getOwnerMessageWatchdog } from '../messaging/owner-message-watchdog.service.js';
import { ProjectTicketService } from '../project-tickets/project-ticket.service.js';
import type { ProjectTicketWorkflowService } from '../project-tickets/project-ticket-workflow.service.js';
import { DecisionError, DecisionService, type BlockActionsPayload, type DecisionServiceDeps, type DecisionPostIdentity, type DecisionSlackPlace, type DecisionTicketContext } from './decision.service.js';
import { DecisionStore } from './decision-store.js';
import { TicketThreadStore, setTicketThreadStore, getTicketThreadStore } from './ticket-thread-store.js';
import { pickTicketAsker, teamOfSession, trackedClosedReason, type TrackedState } from './decision-routing.js';
import { createSkipAllCommandInterceptor } from './decision-skip-command.js';

/** What the composition root provides. */
export interface DecisionWiringInput {
  crewlyHome: string;
  getTeams: () => Promise<Team[]>;
  /** Deliver text to a (non-orchestrator) agent; wakes it when needed */
  sendToAgent: (session: string, text: string) => Promise<boolean>;
  /** Deliver text to the orchestrator (its queue) */
  sendToOrchestrator: (text: string) => Promise<boolean>;
  /** The agent's running work item id */
  currentWorkItemId?: (session: string) => Promise<string | undefined>;
  /** Slack destination of the agent's current work (work-item destinations) */
  workDestination?: (session: string) => Promise<DecisionSlackPlace | null>;
}

const logger = LoggerService.getInstance().createComponentLogger('DecisionCards');

/**
 * Whether a Slack user may answer decisions: the configured allow-list
 * when there is one, else the workspace installer when known, else anyone
 * who is not a bot (single-person workspaces before Cloud config).
 *
 * @param userId - Slack user id
 * @returns True for the owner
 */
export function isDecisionOwner(userId: string): boolean {
  const slack = getSlackService();
  const config = slack.getConfig();
  if (config?.allowedUserIds && config.allowedUserIds.length > 0) return isUserAllowed(userId, config);
  const owner = slack.getOwnerUserId?.() ?? null;
  return owner ? owner === userId : true;
}

/** The ticket side of decisions (resolve / mark / log). */
export type TicketDecisionHooks = Pick<DecisionServiceDeps, 'resolveTicket' | 'markTicketAsked' | 'logTicket'>;

/**
 * Ticket hooks over the project-ticket workflow and store.
 *
 * - resolve: the caller must be the owner, the orchestrator, a lead of a
 *   project team, or the ticket's assignee; the asker is the assignee, else
 *   the lead ({@link pickTicketAsker});
 * - mark: `needs-owner` label + `owner question: … (D-n)` log line (the
 *   autopilot keeps such tickets out of triage);
 * - log: one line, optionally removing the label.
 *
 * @param input - Ticket store, teams, and (tests) a workflow
 * @returns Hooks
 */
export function createTicketDecisionHooks(input: {
  tickets: Pick<ProjectTicketService, 'mutate'>;
  getTeams: () => Promise<Team[]>;
  workflow?: Pick<ProjectTicketWorkflowService, 'resolveProject' | 'get' | 'accessOf'>;
}): TicketDecisionHooks {
  const label = TICKET_AUTOPILOT_CONSTANTS.NEEDS_OWNER_LABEL;
  return {
    resolveTicket: async (projectRef, ticketId, callerSession): Promise<DecisionTicketContext> => {
      const wf = input.workflow ?? (await import('../../controllers/project-tickets/project-tickets.controller.js')).projectTicketWorkflow();
      const project = await wf.resolveProject(projectRef);
      const ticket = await wf.get(project.id, ticketId);
      const { access } = await wf.accessOf(callerSession ? { session: callerSession } : {}, project);
      const isAssignee = !!callerSession && ticket.assignee === callerSession;
      if (!['owner', 'orchestrator', 'lead'].includes(access) && !isAssignee) {
        throw new DecisionError(403, `Only the ticket's assignee, a lead of the project's teams, the orchestrator or the owner can ask the owner about ${ticket.id}`);
      }
      if (ticket.status === 'done' || ticket.status === 'cancelled') throw new DecisionError(409, `${ticket.id} is ${ticket.status}; nothing to ask`);
      const teams = (await input.getTeams()).filter((t) => !t.archived && (t.projectIds ?? []).includes(project.id));
      const asker = pickTicketAsker(ticket, teams);
      if (!asker) throw new DecisionError(409, `${ticket.id}: the project has no team lead to ask the owner`);
      return { projectId: project.id, projectPath: project.path, projectName: project.name, id: ticket.id, title: ticket.title, asker: asker.session, teamId: asker.teamId };
    },
    markTicketAsked: async (ctx, question, decisionId) => {
      await input.tickets.mutate(ctx.projectPath, ctx.id, ctx.asker, (t) => ({
        fields: t.labels.includes(label) ? {} : { labels: [...t.labels, label] },
        log: [`${TICKET_AUTOPILOT_CONSTANTS.OWNER_QUESTION_LOG_PREFIX}${question} (${decisionId})`],
      }));
    },
    logTicket: async (ticket, line, clearNeedsOwner) => {
      await input.tickets.mutate(ticket.projectPath, ticket.id, 'owner', (t) => ({
        fields: clearNeedsOwner && t.labels.includes(label) ? { labels: t.labels.filter((l) => l !== label) } : {},
        log: [line],
      }));
    },
  };
}

/**
 * Build the service with the real collaborators.
 *
 * @param input - Composition-root hooks
 * @returns The service (not started)
 */
export function createDecisionService(input: DecisionWiringInput): DecisionService {
  const threads = getTicketThreadStore() ?? TicketThreadStore.inHome(input.crewlyHome);
  setTicketThreadStore(threads);
  const tickets = ProjectTicketService.getInstance();

  const identityOf = async (session: string): Promise<DecisionPostIdentity> => {
    const teams = await input.getTeams().catch(() => [] as Team[]);
    const member = teams.flatMap((t) => t.members ?? []).find((m) => m.sessionName === session);
    const ids = getSlackAgentIdentityService();
    if (ids) {
      await ids.load().catch(() => undefined);
      const installed = ids.getInstalled(session);
      if (installed?.botToken) return { botToken: installed.botToken, username: member?.name ?? session };
    }
    return slackIdentityFor(member, session);
  };

  return new DecisionService({
    store: DecisionStore.inHome(input.crewlyHome),
    threads,
    slack: () => getSlackService(),
    instanceId: () => getSlackInstanceRegistryService()?.getInstanceId() ?? '',
    isOwner: isDecisionOwner,
    ownerUserId: () => getSlackService().getOwnerUserId?.() ?? null,
    userName: async (userId) => (await getSlackService().getUserBasic(userId).catch(() => null))?.name,
    identityOf,
    teamChannelOf: async (teamId) => {
      const mappings = (await getSlackTeamChannelService()?.listMappings().catch(() => [])) ?? [];
      return mappings.find((m) => m.teamId === teamId)?.slackChannelId ?? null;
    },
    teamOf: async (session) => teamOfSession(session, await input.getTeams()),
    ...createTicketDecisionHooks({ tickets, getTeams: input.getTeams }),
    ...(input.workDestination ? { workDestination: input.workDestination } : {}),
    ...(input.currentWorkItemId ? { currentWorkItemId: input.currentWorkItemId } : {}),
    ownerDmOf: async (identity) => {
      const slack = getSlackService();
      const owner = slack.getOwnerUserId?.() ?? null;
      if (!owner) return null;
      return slack.openDirectMessage(owner, identity.botToken);
    },
    displayName: async (session) => {
      const teams = await input.getTeams().catch(() => [] as Team[]);
      return teams.flatMap((t) => t.members ?? []).find((m) => m.sessionName === session)?.name || undefined;
    },
    trackedClosed: async (d) => {
      const state: TrackedState = {};
      if (d.requestRef) {
        const { RequestService } = await import('../v3/request.service.js');
        state.request = await RequestService.getInstance().getById(d.requestRef.requestId).catch(() => undefined);
      }
      if (d.ticket) {
        state.ticketStatus = (await tickets.get(d.ticket.projectPath, d.ticket.id).catch(() => null))?.status ?? null;
      }
      return trackedClosedReason(d, state);
    },
    openItemAskedAt: async (ref) => {
      const { RequestService } = await import('../v3/request.service.js');
      const request = await RequestService.getInstance().getById(ref.requestId).catch(() => null);
      return request?.openItems?.find((i) => i.id === ref.itemId)?.createdAt;
    },
    deliverToAgent: (session, text) => (session === ORCHESTRATOR_SESSION_NAME ? input.sendToOrchestrator(text) : input.sendToAgent(session, text)),
    closeWatchdog: (session, slackChannelId, threadTs) => {
      const watchdog = getOwnerMessageWatchdog();
      if (!watchdog) return;
      watchdog.closeByAgent(session, { slackChannelId, threadTs });
      // The owner's own reply / click in the card's thread is the answer to
      // what the asker owed there — and a reply that is still being
      // dispatched must not be tracked as a new unanswered message.
      watchdog.noteSlackAnswer(slackChannelId, threadTs, 'decision answered');
    },
  });
}

/**
 * Subscribe the service to Slack: interactions (Cloud relay / Socket Mode /
 * HTTP), reactions and thread replies.
 *
 * @param service - Decision service
 * @returns Unsubscribe
 */
export function attachDecisionSlackListeners(service: DecisionService): () => void {
  const slack = getSlackService();
  const onInteraction = (event: SlackInteractionEvent): void => {
    void service
      .handleInteraction(event.payload as BlockActionsPayload)
      .then((out) => logger.debug('Slack interaction', { source: event.source, handled: out.handled, reason: out.reason }))
      .catch((err) => logger.warn('Slack interaction failed', { error: err instanceof Error ? err.message : String(err) }));
  };
  const onReaction = (event: SlackReactionEvent): void => {
    void service
      .handleReaction({ user: event.user, reaction: event.reaction, item: { type: 'message', channel: event.channelId, ts: event.messageTs } })
      .catch((err) => logger.warn('Slack reaction handling failed', { error: err instanceof Error ? err.message : String(err) }));
  };
  const onMessage = (message: SlackIncomingMessage): void => {
    if (!message.threadTs) return;
    void service.handleThreadReply(message).catch((err) => logger.warn('Decision thread reply failed', { error: err instanceof Error ? err.message : String(err) }));
  };
  slack.on('interaction', onInteraction);
  slack.on('reaction', onReaction);
  slack.on('message', onMessage);
  return () => {
    slack.off('interaction', onInteraction);
    slack.off('reaction', onReaction);
    slack.off('message', onMessage);
  };
}

/**
 * The owner's "skip all old cards" / 「清掉旧卡片」 in their orc DM: handled
 * here (the orc never sees it), answered in the same conversation.
 *
 * @param service - Decision service
 * @returns Remove function
 */
export async function attachSkipAllCommand(service: DecisionService): Promise<() => void> {
  const { SlackReloginDmService } = await import('../slack/slack-relogin-dm.service.js');
  const { getSlackOrchestratorBridge } = await import('../slack/slack-orchestrator-bridge.js');
  const dm = new SlackReloginDmService(
    () => getSlackService(),
    undefined,
    (agentSession) => getSlackAgentIdentityService()?.getInstalled(agentSession)?.botToken ?? null,
  );
  return getSlackOrchestratorBridge().addInboundInterceptor(
    'the skip-all-cards command',
    createSkipAllCommandInterceptor({
      ownerDmScope: (m) => dm.ownerDmScope(m),
      replyTargetOf: (m) => dm.replyTargetOf(m),
      reply: (text, target) => dm.sendToOwner(text, target as ReturnType<typeof dm.replyTargetOf>),
      service: () => DecisionService.getInstance() ?? service,
      onError: (err) => logger.warn('Skip-all command failed', { error: err instanceof Error ? err.message : String(err) }),
    }),
  );
}
