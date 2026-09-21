/**
 * Slack DMs to an agent's own bot user.
 *
 * Every Cloud-provisioned agent has a real Slack bot, so a person can open
 * a DM with "Ella" directly. Cloud tags such an event with the agent's
 * session (`SlackIncomingMessage.agentSession`); this service turns it
 * into a turn on the owner's chat-v2 DM channel with that agent — the same
 * channel the dashboard's team-chat uses — and dispatches it (activate-on-
 * send wakes an idle agent). The agent answers with its usual `reply-chat`
 * skill; the reply is mirrored back into the Slack DM under the agent's
 * bot token. The orchestrator never sees these conversations.
 *
 * @module services/slack/slack-agent-dm.service
 */

import * as path from 'path';
import type { ChatMessageDTO } from '../chat-v2/types.js';
import type { SlackIncomingMessage, SlackOutgoingMessage } from '../../types/slack.types.js';
import type { Team } from '../../types/index.js';
import type { ChatV2Service } from '../chat-v2/chat-v2.service.js';
import type { ChatV2DispatcherService, DispatchMessageResult } from '../chat-v2/chat-v2.dispatcher.service.js';
import type { SlackAgentIdentityService } from './slack-agent-identity.service.js';
import type { SlackTypingPlaceholderService } from './slack-typing-placeholder.service.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { SLACK_AGENT_DM_CONSTANTS } from '../../constants.js';
import { toSlackMrkdwn } from './slack-mrkdwn.js';

// ---------------------------------------------------------------------------
// Dependency contracts (narrow so tests can pass plain fakes)
// ---------------------------------------------------------------------------

/** The slice of SlackService this service uses. */
export interface AgentDmSlackApi {
  isConnected(): boolean;
  sendMessage(message: SlackOutgoingMessage): Promise<string>;
  addReaction(channelId: string, messageTs: string, emoji: string, botToken?: string): Promise<void>;
}

/** The slice of ChatV2Service this service uses. */
export type AgentDmChatApi = Pick<ChatV2Service, 'ensureDmChannel' | 'getChannelForBridge' | 'recordTurn' | 'on' | 'off'>;

/** The slice of SlackAgentIdentityService this service uses. */
export type AgentDmIdentityApi = Pick<SlackAgentIdentityService, 'getInstalled'>;

/** Dispatcher slice — resolved lazily because it is built after the bridge. */
export type AgentDmDispatcherApi = Pick<ChatV2DispatcherService, 'dispatchMessage'>;

/** Constructor dependencies. */
export interface SlackAgentDmServiceDeps {
  slack: AgentDmSlackApi;
  chat: AgentDmChatApi;
  storage: { getTeams(): Promise<Team[]> };
  getDispatcher: () => AgentDmDispatcherApi | null;
  identities: AgentDmIdentityApi;
  /** Whether the agent runs on this instance (Cloud fans DMs out to the owner only, but be safe). */
  isLocalAgent?: (agentSession: string) => boolean;
  /** "Is typing…" placeholders; optional (replies are posted plainly without it). */
  typing?: Pick<SlackTypingPlaceholderService, 'begin' | 'resolve' | 'setPhase' | 'fail'> | null;
  /** Whether the agent's runtime session exists right now (false = it must be woken first). */
  isAgentAwake?: (agentSession: string) => boolean;
  /** Link store path; defaults to `<CREWLY_HOME>/slack-agent-dms.json`. */
  storePath?: string;
  now?: () => Date;
}

/** One chat-v2 DM channel ↔ one Slack DM conversation with the agent's bot. */
export interface SlackAgentDmLink {
  chatChannelId: string;
  agentSession: string;
  /** Slack DM channel id (`D…`). */
  slackChannelId: string;
  /** Thread the last inbound message sat in, when it was threaded; replies follow it. */
  replyThreadTs?: string;
  updatedAt: string;
}

/** Result of {@link SlackAgentDmService.routeInbound}. */
export interface AgentDmRouteResult {
  link: SlackAgentDmLink;
  message: ChatMessageDTO;
  dispatch: DispatchMessageResult | null;
}

interface AgentDmStore {
  links: Record<string, SlackAgentDmLink>;
}

/**
 * Routes Slack DMs addressed to an agent's bot into that agent's chat-v2 DM
 * channel and mirrors the agent's replies back.
 */
/** How long after a post a similar one counts as a repeat. */
const DM_REPEAT_WINDOW_MS = 30_000;

/**
 * Shortest text the containment rule applies to.
 *
 * Without it a genuine "ok" would be swallowed whenever it appeared inside
 * the previous reply.
 */
const DM_REPEAT_MIN_CHARS = 40;

/**
 * Text reduced to what a repeat comparison should care about.
 *
 * @param text - Message text
 * @returns Whitespace-collapsed, trimmed text
 */
function normaliseForRepeat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export class SlackAgentDmService {
  private readonly logger: ComponentLogger;
  private readonly storePath: string;
  private store: AgentDmStore = { links: {} };
  /** What was last posted on each DM, so a repeat is not posted twice. */
  private readonly lastSent = new Map<string, { text: string; at: number }>();
  private loaded = false;
  private started = false;

  private readonly onChatMessage = (dto: ChatMessageDTO): void => {
    void this.mirrorOutbound(dto);
  };

  /**
   * @param deps - Narrow service dependencies (see {@link SlackAgentDmServiceDeps})
   */
  constructor(private readonly deps: SlackAgentDmServiceDeps) {
    this.logger = LoggerService.getInstance().createComponentLogger('SlackAgentDm');
    this.storePath = deps.storePath ?? path.join(getCrewlyHomePath(), SLACK_AGENT_DM_CONSTANTS.STORE_FILENAME);
  }

  /** Load the link store and subscribe to chat-v2 messages. Idempotent. */
  async start(): Promise<void> {
    await this.load();
    if (this.started) return;
    this.started = true;
    this.deps.chat.on('chat_message', this.onChatMessage);
  }

  /** Unsubscribe from chat-v2 messages. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.deps.chat.off('chat_message', this.onChatMessage);
  }

  /**
   * The link for a Slack DM channel, when this service owns it.
   *
   * @param slackChannelId - Slack conversation id
   * @returns The link or null
   */
  findBySlackChannelId(slackChannelId: string): SlackAgentDmLink | null {
    return Object.values(this.store.links).find((l) => l.slackChannelId === slackChannelId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Inbound (Slack DM → agent)
  // -------------------------------------------------------------------------

  /**
   * Route a DM to an agent's bot. Returns null (caller falls through to the
   * normal routing) when the message is not addressed to a local agent.
   *
   * @param message - The inbound Slack message; `agentSession` names the bot's agent
   * @returns Where it went, or null when not handled
   */
  async routeInbound(message: SlackIncomingMessage): Promise<AgentDmRouteResult | null> {
    const agentSession = message.agentSession;
    if (!agentSession) return null;
    if (this.deps.isLocalAgent && !this.deps.isLocalAgent(agentSession)) {
      this.logger.debug('DM addressed to an agent that is not on this instance — ignoring', { agentSession });
      return null;
    }
    await this.load();

    const member = await this.findMember(agentSession);
    const { channel } = this.deps.chat.ensureDmChannel({
      agentSession,
      name: member?.name ?? agentSession,
      principal: { userId: SLACK_AGENT_DM_CONSTANTS.OWNER_USER_ID, source: 'oss' },
    });

    const link: SlackAgentDmLink = {
      chatChannelId: channel.id,
      agentSession,
      slackChannelId: message.channelId,
      ...(message.threadTs ? { replyThreadTs: message.threadTs } : {}),
      updatedAt: this.now().toISOString(),
    };
    this.store.links[channel.id] = link;
    // A new question reopens the DM: the next reply is an answer to it, not a
    // repeat of the previous one, however similar the two happen to read.
    this.lastSent.delete(message.channelId);
    await this.persist();

    const senderId = message.user?.realName || message.user?.name || message.userId || 'slack-user';
    const { message: persisted } = this.deps.chat.recordTurn({
      channelId: channel.id,
      senderType: 'user',
      senderId,
      content: message.text ?? '',
      metadata: {
        source: 'slack',
        slackChannelId: message.channelId,
        slackThreadTs: message.threadTs || message.ts,
        slackTs: message.ts,
        slackUserId: message.userId,
      },
    });

    // Reactions come from the agent's own bot: the DM conversation belongs to
    // that app, the master Crewly bot cannot see it (channel_not_found).
    const installed = this.deps.identities.getInstalled(agentSession);
    if (installed) {
      await this.deps.slack
        .addReaction(message.channelId, message.ts, SLACK_AGENT_DM_CONSTANTS.INBOUND_REACTION, installed.botToken)
        .catch((err: unknown) => {
          // Cosmetic; a token from before `reactions:write` was required
          // lands here until the owner re-authorises the bot.
          this.logger.warn('Could not add the seen-reaction from the agent bot', {
            agentSession,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    // A reply is now owed: show the honest state where it will land —
    // "waking up…" while an idle agent is started and registered (a cold
    // start is 1–2 minutes), "is working on it…" once it holds the message.
    const typingKey = { agentSession, slackChannelId: message.channelId, ...(message.threadTs ? { threadTs: message.threadTs } : {}) };
    const typing = installed && this.deps.typing ? this.deps.typing : null;
    if (typing) {
      const awake = this.deps.isAgentAwake ? this.deps.isAgentAwake(agentSession) : true;
      await typing.begin(typingKey, { botToken: installed!.botToken, displayName: member?.name ?? agentSession }, awake ? 'typing' : 'waking');
    }

    const dispatcher = this.deps.getDispatcher();
    let dispatch: DispatchMessageResult | null = null;
    if (dispatcher) {
      dispatch = await dispatcher.dispatchMessage(channel, persisted);
    } else {
      this.logger.warn('No chat dispatcher wired — DM persisted but not delivered', { agentSession });
    }
    if (typing) {
      if (dispatch?.dispatched) await typing.setPhase(typingKey, 'typing');
      else await typing.fail(typingKey);
    }

    this.logger.info('Slack DM routed to agent', {
      agentSession,
      slackChannel: message.channelId,
      chatChannel: channel.id,
      dispatched: dispatch?.dispatched ?? false,
      strategy: dispatch?.strategy ?? 'none',
    });
    return { link, message: persisted, dispatch };
  }

  // -------------------------------------------------------------------------
  // Outbound (agent reply → Slack DM)
  // -------------------------------------------------------------------------

  /**
   * Whether this text repeats what was just sent on the same DM.
   *
   * Containment, not equality: the duplicate that prompted this was the
   * same answer with a line of self-report in front of it, so an exact
   * match would have let it through. The minimum length keeps a genuine
   * short reply ("ok", "done") from being swallowed because it happens to
   * appear inside a longer one.
   *
   * @param slackChannelId - The DM
   * @param text - What is about to be sent
   * @returns True when it should not be sent
   */
  private isRepeatOfLastSent(slackChannelId: string, text: string): boolean {
    const previous = this.lastSent.get(slackChannelId);
    if (!previous) return false;
    if (this.now().getTime() - previous.at > DM_REPEAT_WINDOW_MS) return false;
    const a = normaliseForRepeat(previous.text);
    const b = normaliseForRepeat(text);
    if (!a || !b) return false;
    if (a === b) return true;
    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
    if (shorter.length < DM_REPEAT_MIN_CHARS) return false;
    return longer.includes(shorter);
  }

  /**
   * Record what was sent, for {@link isRepeatOfLastSent}.
   *
   * @param slackChannelId - The DM
   * @param text - What was sent
   */
  private rememberSent(slackChannelId: string, text: string): void {
    this.lastSent.set(slackChannelId, { text, at: this.now().getTime() });
  }

  /**
   * Post an agent's reply on a linked DM channel back into the Slack DM,
   * under the agent's own bot. Ignores anything that is not an agent
   * message on a linked channel.
   *
   * @param dto - The chat-v2 message
   * @returns True when a Slack post was attempted
   */
  async mirrorOutbound(dto: ChatMessageDTO): Promise<boolean> {
    try {
      if (dto.senderType !== 'agent') return false;
      if (dto.metadata?.source === 'slack') return false;
      await this.load();
      const link = this.store.links[dto.channelId];
      if (!link) return false;
      if (!this.deps.slack.isConnected()) return false;

      const installed = this.deps.identities.getInstalled(link.agentSession);
      if (!installed) {
        this.logger.warn('Agent has no installed Slack bot — DM reply not mirrored', { agentSession: link.agentSession });
        return false;
      }
      const key = { agentSession: link.agentSession, slackChannelId: link.slackChannelId, ...(link.replyThreadTs ? { threadTs: link.replyThreadTs } : {}) };
      const text = toSlackMrkdwn(dto.content);
      // An agent that both posts its answer with a tool and returns the same
      // answer as its turn text produces two chat turns, and both are agent
      // messages on the same DM — so the owner saw the reply twice, the
      // second prefixed with the agent reporting that it had replied
      // (2026-09-20). Suppressed here rather than in a prompt: this holds
      // whatever the model does.
      if (this.isRepeatOfLastSent(link.slackChannelId, text)) {
        this.logger.info('DM reply suppressed as a repeat of the one just sent', {
          agentSession: link.agentSession,
          slackChannelId: link.slackChannelId,
        });
        return false;
      }
      this.rememberSent(link.slackChannelId, text);
      if (this.deps.typing) {
        await this.deps.typing.resolve(key, text, { botToken: installed.botToken, displayName: link.agentSession });
        return true;
      }
      await this.deps.slack.sendMessage({
        channelId: link.slackChannelId,
        text,
        ...(link.replyThreadTs ? { threadTs: link.replyThreadTs } : {}),
        botToken: installed.botToken,
        skipChatV2Mirror: true,
      });
      return true;
    } catch (err) {
      this.logger.warn('DM reply mirror to Slack failed', {
        channelId: dto.channelId,
        sender: dto.senderId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async findMember(agentSession: string): Promise<Team['members'][number] | undefined> {
    try {
      for (const team of await this.deps.storage.getTeams()) {
        const member = team.members?.find((m) => m.sessionName === agentSession);
        if (member) return member;
      }
    } catch {
      /* storage unavailable — fall back to the session name */
    }
    return undefined;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const raw = await safeReadJson<Partial<AgentDmStore>>(this.storePath, {});
    this.store = { links: raw.links && typeof raw.links === 'object' ? raw.links : {} };
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    try {
      await atomicWriteJson(this.storePath, this.store);
    } catch (err) {
      this.logger.warn('Could not persist the agent DM links', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: SlackAgentDmService | null = null;

/** @returns The wired service, or null before Slack started. */
export function getSlackAgentDmService(): SlackAgentDmService | null {
  return instance;
}

/** @param service - The service to expose (null to clear, for tests) */
export function setSlackAgentDmService(service: SlackAgentDmService | null): void {
  instance = service;
}
