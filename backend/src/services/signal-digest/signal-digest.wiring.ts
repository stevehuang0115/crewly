/**
 * Signal digest — wiring with the real Slack, project tickets and teams
 * (#987, specs/2026-10-03-signal-digest.md). Process-specific hooks (how to
 * reach an agent) come from `index.ts`.
 *
 * @module services/signal-digest/signal-digest.wiring
 */

import type { Team } from '../../types/index.js';
import type { SlackInteractionEvent } from '../../types/slack.types.js';
import { LoggerService } from '../core/logger.service.js';
import { getSlackService } from '../slack/slack.service.js';
import { getSlackInstanceRegistryService } from '../slack/slack-instance-registry.service.js';
import { getSlackTeamChannelService } from '../slack/slack-team-channel.service.js';
import type { BlockActionsPayload } from '../decisions/decision.service.js';
import { createAgentSlackIdentityResolver, isDecisionOwner } from '../decisions/decision.wiring.js';
import { teamOfSession } from '../decisions/decision-routing.js';
import { SignalDigestService, type SignalTicketInput } from './signal-digest.service.js';
import { SignalDigestStore } from './signal-digest-store.js';

/** What the composition root provides. */
export interface SignalDigestWiringInput {
  crewlyHome: string;
  getTeams: () => Promise<Team[]>;
  /** Deliver text to an agent; wakes it when needed */
  sendToAgent: (session: string, text: string) => Promise<boolean>;
}

/** The ticket workflow slice a Do uses. */
export interface SignalTicketWorkflow {
  create(ref: string, input: Record<string, unknown>, caller: { session?: string }): Promise<{ id: string }>;
}

const logger = LoggerService.getInstance().createComponentLogger('SignalDigest');

/**
 * Open a Do ticket as the owner (who clicked Do). When the lead's team is not
 * on the site's project, the ticket is opened without a team rather than not
 * at all.
 *
 * @param workflow - Ticket workflow
 * @param input - Ticket
 * @returns The new ticket's id
 */
export async function createSignalTicket(workflow: SignalTicketWorkflow, input: SignalTicketInput): Promise<{ id: string }> {
  const body: Record<string, unknown> = {
    title: input.title,
    description: input.description,
    acceptance: input.acceptance,
    labels: input.labels,
    status: 'ready',
    source: input.source,
  };
  if (!input.team) return workflow.create(input.project, body, {});
  try {
    return await workflow.create(input.project, { ...body, team: input.team }, {});
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 400) throw err;
    logger.info('Signal digest ticket: team not on the project — opening it without a team', { project: input.project, team: input.team });
    return workflow.create(input.project, body, {});
  }
}

/**
 * Build the service with the real collaborators.
 *
 * @param input - Composition-root hooks
 * @returns The service
 */
export function createSignalDigestService(input: SignalDigestWiringInput): SignalDigestService {
  return new SignalDigestService({
    store: SignalDigestStore.inHome(input.crewlyHome),
    slack: () => getSlackService(),
    instanceId: () => getSlackInstanceRegistryService()?.getInstanceId() ?? '',
    isOwner: isDecisionOwner,
    identityOf: createAgentSlackIdentityResolver(input.getTeams),
    teamOf: async (session) => teamOfSession(session, await input.getTeams()),
    teamChannelOf: async (teamId) => {
      const mappings = (await getSlackTeamChannelService()?.listMappings().catch(() => [])) ?? [];
      return mappings.find((m) => m.teamId === teamId)?.slackChannelId ?? null;
    },
    ownerDmOf: async (identity) => {
      const slack = getSlackService();
      const owner = slack.getOwnerUserId?.() ?? null;
      return owner ? slack.openDirectMessage(owner, identity.botToken) : null;
    },
    displayName: async (session) => {
      const teams = await input.getTeams().catch(() => [] as Team[]);
      return teams.flatMap((t) => t.members ?? []).find((m) => m.sessionName === session)?.name || undefined;
    },
    createTicket: async (ticket) => {
      const { projectTicketWorkflow } = await import('../../controllers/project-tickets/project-tickets.controller.js');
      return createSignalTicket(projectTicketWorkflow() as unknown as SignalTicketWorkflow, ticket);
    },
    createExperiment: async (experiment, caller) => {
      const { ExperimentService } = await import('../experiments/experiment.service.js');
      const service = ExperimentService.getInstance();
      if (!service) throw new Error('experiment cards are not running on this instance');
      return service.create(experiment, caller);
    },
    deliverToAgent: input.sendToAgent,
    notifyOwner: async ({ title, message, urgent }) => {
      const slack = getSlackService();
      if (!slack.isConnected()) return false;
      return slack.sendNotification({ type: 'project_update', title, message, urgency: urgent ? 'high' : 'normal', timestamp: new Date().toISOString() });
    },
    logger,
  });
}

/**
 * Subscribe the service to Slack button clicks (Cloud relay, Socket Mode, HTTP).
 *
 * @param service - Signal digest service
 * @returns Unsubscribe
 */
export function attachSignalDigestSlackListeners(service: SignalDigestService): () => void {
  const slack = getSlackService();
  const onInteraction = (event: SlackInteractionEvent): void => {
    void service
      .handleInteraction(event.payload as BlockActionsPayload)
      .then((out) => {
        if (out.handled || out.reason !== 'not a signal digest action') logger.debug('Signal digest interaction', { source: event.source, handled: out.handled, reason: out.reason });
      })
      .catch((err) => logger.warn('Signal digest interaction failed', { error: err instanceof Error ? err.message : String(err) }));
  };
  slack.on('interaction', onInteraction);
  return () => slack.off('interaction', onInteraction);
}
