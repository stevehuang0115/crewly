/**
 * Google reconnect cards — wiring with the real Slack, Cloud and agents.
 *
 * Kept apart from the notifier so its rules (throttle, wording, when a
 * reconnect counts) are testable without Slack. Everything here runs on the
 * machine where the Google call failed: its Slack transport posts the card,
 * its agents are told to retry. That is
 * the same on every machine, so an agent on a second machine (the Personal
 * Assistant on iriss-air, 2026-10-08) gets the same card as one on the main
 * Mac.
 *
 * @module services/google/google-reauth.wiring
 */

import type { SlackBlock } from '../../types/slack.types.js';
import { LoggerService } from '../core/logger.service.js';
import { getSlackService } from '../slack/slack.service.js';
import { getSlackAgentDmService } from '../slack/slack-agent-dm.service.js';
import { getSlackAgentIdentityService } from '../slack/slack-agent-identity.service.js';
import { GoogleWorkspaceTokenService } from './google-workspace-token.service.js';
import { GoogleReauthNotifier, type ReauthNotifierDeps, type ReauthPlace } from './google-reauth-notifier.service.js';

const logger = LoggerService.getInstance().createComponentLogger('GoogleReauthWiring');

/** The Slack calls the wiring makes (a slice of SlackService). */
export interface ReauthSlackApi {
  getOwnerUserId?: (() => string | null) | null;
  openDirectMessage: (userId: string, botToken?: string) => Promise<string>;
  sendMessage: (message: {
    channelId: string;
    text: string;
    blocks?: SlackBlock[];
    threadTs?: string;
    botToken?: string;
    skipChatV2Mirror?: boolean;
  }) => Promise<string>;
  sendEphemeral: (
    channelId: string,
    userId: string,
    text: string,
    blocks?: unknown[],
    botToken?: string,
    threadTs?: string,
  ) => Promise<boolean>;
}

/** What the wiring needs from the rest of the process. */
export interface ReauthWiringInput {
  /** Deliver text to an agent; wakes it when needed */
  sendToAgent: (session: string, text: string) => Promise<boolean>;
  /** Seams for tests; default to the real singletons */
  slack?: () => ReauthSlackApi;
  /**
   * The Slack place of the conversation the agent is answering the owner in.
   * Default: the reply-destination resolver, the same authority `reply-chat`
   * uses, so the card lands where the agent's answer would.
   */
  workDestination?: (session: string) => Promise<{ slackChannelId: string; threadTs?: string } | null>;
  /** The owner↔agent Slack DM, when there is one */
  agentDm?: (session: string) => { slackChannelId: string } | null;
  /** The agent's own installed bot token */
  agentBotToken?: (session: string) => string | undefined;
}

/**
 * A Slack DM channel id. DMs are private to the owner and the bot, so a
 * card there can be an ordinary message — which, unlike an ephemeral one,
 * reaches the owner's phone as a notification and survives a reload.
 *
 * @param channelId - Slack channel id
 * @returns True for `D…`
 */
export function isDirectMessage(channelId: string): boolean {
  return channelId.startsWith('D');
}

/**
 * Build the notifier's collaborators.
 *
 * @param input - Process hooks and test seams
 * @returns Notifier deps
 */
export function createReauthNotifierDeps(input: ReauthWiringInput): ReauthNotifierDeps {
  const slack = input.slack ?? ((): ReauthSlackApi => getSlackService());
  const botTokenOf =
    input.agentBotToken ?? ((session: string) => getSlackAgentIdentityService()?.getInstalled(session)?.botToken);
  const agentDm =
    input.agentDm ??
    ((session: string) => {
      const link = getSlackAgentDmService()?.findByAgentSession(session);
      return link ? { slackChannelId: link.slackChannelId } : null;
    });
  const workDestination =
    input.workDestination ??
    (async (session: string) => {
      // Not resolveAgentSlackDestination: it knows only the work item and the
      // last owner turn origin, so a team lead answering the owner in a
      // channel thread resolved to nothing and the card went to the DM
      // (Ruth, 2026-10-10). The resolver also reads the conversation the
      // agent was prompted about and the owner threads it owes an answer.
      const { resolveSlackPlace } = await import('../orc/reply-destination.wiring.js');
      const place = await resolveSlackPlace({ session, noOwnerDm: true });
      return place ? { slackChannelId: place.slackChannelId, ...(place.threadTs ? { threadTs: place.threadTs } : {}) } : null;
    });
  const tokens = (): GoogleWorkspaceTokenService => GoogleWorkspaceTokenService.getInstance();

  /** The owner's DM with this bot. */
  const ownerDm = async (owner: string, botToken?: string): Promise<ReauthPlace | null> => {
    const id = await slack().openDirectMessage(owner, botToken).catch(() => null);
    return id ? { slackChannelId: id, ...(botToken ? { botToken } : {}) } : null;
  };

  /** One post attempt; a DM gets an ordinary message, a channel an ephemeral one. */
  const postOnce = async (place: ReauthPlace, owner: string, text: string, blocks: unknown[], botToken?: string): Promise<boolean> => {
    if (isDirectMessage(place.slackChannelId)) {
      const ts = await slack()
        .sendMessage({
          channelId: place.slackChannelId,
          text,
          blocks: blocks as SlackBlock[],
          ...(place.threadTs ? { threadTs: place.threadTs } : {}),
          ...(botToken ? { botToken } : {}),
          // A card is not conversation: keep it out of the chat mirror.
          skipChatV2Mirror: true,
        })
        .catch(() => '');
      return !!ts;
    }
    return slack()
      .sendEphemeral(place.slackChannelId, owner, text, blocks, botToken, place.threadTs)
      .catch(() => false);
  };

  return {
    ownerUserId: () => slack().getOwnerUserId?.() ?? null,
    placeFor: async (session, owner) => {
      const botToken = session ? botTokenOf(session) : undefined;
      if (session) {
        // Where the agent is working — but only a conversation, not a bare
        // team channel: a card at the top of #team would reach nobody.
        const work = await workDestination(session).catch(() => null);
        if (work?.slackChannelId && (work.threadTs || isDirectMessage(work.slackChannelId))) {
          return {
            slackChannelId: work.slackChannelId,
            ...(work.threadTs ? { threadTs: work.threadTs } : {}),
            ...(botToken ? { botToken } : {}),
          };
        }
        const dm = agentDm(session);
        if (dm) return { slackChannelId: dm.slackChannelId, ...(botToken ? { botToken } : {}) };
      }
      return ownerDm(owner, botToken);
    },
    postCard: async (place, owner, text, blocks) => {
      if (await postOnce(place, owner, text, blocks, place.botToken)) return true;
      // The agent's own bot may not be in that conversation; the shared bot
      // usually is.
      if (place.botToken && (await postOnce(place, owner, text, blocks))) return true;
      if (isDirectMessage(place.slackChannelId)) return false;
      // A channel thread refused it: the owner's DM still reaches the phone.
      const dm = await ownerDm(owner, place.botToken);
      if (dm && (await postOnce(dm, owner, text, blocks, dm.botToken))) return true;
      logger.warn('Could not post the Google reconnect card anywhere', { slackChannelId: place.slackChannelId });
      return false;
    },
    status: () => tokens().status(),
    clearTokenCache: (account) => tokens().clearCache(account),
    tellAgent: input.sendToAgent,
  };
}

/**
 * Install the process-wide notifier. Called once Slack is up.
 *
 * @param input - Process hooks
 * @returns The notifier
 */
export function startGoogleReauthNotifier(input: ReauthWiringInput): GoogleReauthNotifier {
  const notifier = new GoogleReauthNotifier(createReauthNotifierDeps(input));
  GoogleReauthNotifier.setInstance(notifier);
  logger.info('Google reconnect cards started');
  return notifier;
}
