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
import { trackSlackDelivery, SLACK_DELIVERY_METADATA_KEY, type SlackOutboundDelivery } from './slack-outbound-delivery.js';
import type { ChatMessageDTO } from '../chat-v2/types.js';
import type { SlackIncomingMessage, SlackOutgoingMessage } from '../../types/slack.types.js';
import type { Team } from '../../types/index.js';
import type { ChatV2Service } from '../chat-v2/chat-v2.service.js';
import type { ChatV2DispatcherService, DispatchMessageResult } from '../chat-v2/chat-v2.dispatcher.service.js';
import { renderSlackThreadContext } from './slack-thread-context.service.js';
import type { SlackAgentIdentityService } from './slack-agent-identity.service.js';
import type { SlackTypingPlaceholderService } from './slack-typing-placeholder.service.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { REPLY_ROUTING_CONSTANTS, SLACK_AGENT_DM_CONSTANTS, SLACK_THREAD_KEY_CONSTANTS, SLACK_TYPING_CONSTANTS } from '../../constants.js';
import { isInterim } from './slack-typing-placeholder.service.js';
import { isOwnerAuthored, deliveredSessions, type SlackAutoWorkingService } from './slack-auto-working.service.js';
import { toSlackMrkdwn } from './slack-mrkdwn.js';
import { parseSlackThreadKey, slackThreadOfMetadata } from './slack-thread-key.js';
import { getTicketIntakeService } from '../v3/ticket-intake.service.js';
import { intakeWithin, slackIntakeMessage, ticketOfOutcome, markAndLinkTicket } from '../v3/ticket-channel-hooks.js';
import type { Request } from '../../types/v2/request.types.js';

// ---------------------------------------------------------------------------
// Dependency contracts (narrow so tests can pass plain fakes)
// ---------------------------------------------------------------------------

/** The slice of SlackService this service uses. */
export interface AgentDmSlackApi {
  isConnected(): boolean;
  sendMessage(message: SlackOutgoingMessage): Promise<string>;
  uploadFile(options: {
    channelId: string;
    filePath: string;
    filename?: string;
    title?: string;
    initialComment?: string;
    threadTs?: string;
    botToken?: string;
  }): Promise<{ fileId?: string }>;
  addReaction(channelId: string, messageTs: string, emoji: string, botToken?: string): Promise<void>;
}

/** The slice of ChatV2Service this service uses. */
export type AgentDmChatApi = Pick<
  ChatV2Service,
  'ensureDmChannel' | 'getChannelForBridge' | 'recordTurn' | 'getLatestOwnerTurnSource' | 'on' | 'off'
> &
  Partial<Pick<ChatV2Service, 'getMessageForBridge' | 'getLatestOwnerTurnAt' | 'updateMessageMetadata'>>;

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
  typing?: (Pick<SlackTypingPlaceholderService, 'begin' | 'resolve' | 'setPhase' | 'fail'> &
    Partial<Pick<SlackTypingPlaceholderService, 'dropThread'>>) | null;
  /**
   * Harness-posted "working on it": if the DM's placeholder is not showing
   * when the agent starts on the owner's message, it is posted then; optional.
   */
  autoWorking?: Pick<SlackAutoWorkingService, 'watch'> | null;
  /** Whether the agent's runtime session exists right now (false = it must be woken first). */
  isAgentAwake?: (agentSession: string) => boolean;
  /** Slack user id of the owner, when known — only the owner's DMs file tickets. */
  getOwnerUserId?: () => string | null;
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
  /**
   * Thread the reply belongs in.
   *
   * A threaded question keeps its own thread. A top-level DM gets one
   * rooted at the question itself, so a long conversation with an agent
   * reads as exchanges rather than one flat column (owner, 2026-09-21).
   */
  replyThreadTs?: string;
  /**
   * Threads that still owe an answer, oldest first (thread root ts).
   *
   * `replyThreadTs` alone is the thread the owner wrote in *last*; used as
   * the reply target it sent an answer owed in an older thread into the
   * newest one (2026-09-28). An answer that names no thread goes to the
   * oldest entry here instead, and leaves it.
   */
  openThreads?: SlackAgentDmOpenThread[];
  /** Thread of the last answer posted, and when — a file sent right after its answer follows it. */
  lastReply?: { threadTs: string; at: string };
  updatedAt: string;
}

/** A thread that still owes an answer. */
export interface SlackAgentDmOpenThread {
  /** Thread root ts */
  threadTs: string;
  /** When the owner's (first unanswered) message in it arrived, ISO-8601 */
  at: string;
}

/** Where an outbound post goes, and how that was decided (logged). */
export interface AgentDmReplyTarget {
  /** Thread root ts; undefined = top level (a DM with no thread yet) */
  threadTs?: string;
  /**
   * - `key`: the agent named the thread (`--thread <slack thread key>`)
   * - `thread-root`: the agent replied under a chat-v2 message (`--thread <message id>`) that came from that Slack thread
   * - `recent-reply`: a file following the answer just posted
   * - `oldest-open`: unattributed — the oldest thread still owed an answer
   * - `latest`: unattributed and nothing owed — the thread the owner wrote in last
   */
  via: 'key' | 'thread-root' | 'recent-reply' | 'oldest-open' | 'latest';
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
 * How long after a reply a turn recorded by the *other* runtime counts as
 * the same answer told twice.
 *
 * One orchestrator turn reaches chat by two recording paths: the terminal
 * scraper picks up its `[CHAT_RESPONSE]` block (`pty-runtime`) and the
 * notify handler picks up its `[NOTIFY]` summary (`in-process-runtime`).
 * Both are agent turns on the DM, so the owner got the answer and then a
 * condensed restatement of it about a second later. The two texts do not
 * contain one another — a summary is not a substring — so only the source
 * tells them apart. Kept short: two renderings of one turn land together,
 * while a genuine follow-up ("done") comes much later.
 */
const DM_CROSS_RUNTIME_WINDOW_MS = 10_000;

/** The runtime whose turns are a restatement of one already recorded. */
const DM_SUMMARY_SOURCE = 'in-process-runtime';

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
  private readonly lastSent = new Map<string, { text: string; at: number; source: string | null }>();
  private loaded = false;
  private started = false;

  private readonly onChatMessage = (dto: ChatMessageDTO): void => {
    if (dto.senderType === 'agent') trackSlackDelivery(dto.id, this.mirrorOutboundDetailed(dto).then((r) => r.delivery));
    else void this.mirrorOutbound(dto);
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

  /**
   * The link for a chat-v2 DM channel — the direction a skill needs.
   *
   * An agent only knows the chat channel it was addressed in; posting an
   * authorization card back into Slack needs the conversation that chat
   * channel came from.
   *
   * @param chatChannelId - chat-v2 channel id
   * @returns The link or null
   */
  findByChatChannelId(chatChannelId: string): SlackAgentDmLink | null {
    return this.store.links[chatChannelId] ?? null;
  }

  /**
   * The newest link of an agent — its DM with the owner, for messages that
   * have no other place (specs/2026-10-02-harness-owned-routing.md §1, step 7).
   *
   * @param agentSession - Agent session
   * @returns The link or null
   */
  findByAgentSession(agentSession: string): SlackAgentDmLink | null {
    const links = Object.values(this.store.links).filter((l) => l.agentSession === agentSession);
    links.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return links[0] ?? null;
  }

  /**
   * Put a file into the Slack DM an agent is answering in.
   *
   * The team-channel path has the same method for the same reason; an agent
   * talking to its owner one-to-one needs it at least as much, and this is
   * the path most conversations with a single agent actually take. Without
   * it, asked for a PDF, the agent uploads to Drive and sends a link — which
   * it will then correctly explain is all its reply interface can carry.
   *
   * The file goes out under the agent's own bot, into the thread it belongs
   * to: the one the agent names (`threadId` — a Slack thread key or the
   * chat-v2 message it answers), else the answer it just posted, else the
   * oldest thread still owed an answer. It used to go wherever the owner
   * wrote last, which put the EFT form into the HSA thread (2026-09-28).
   *
   * @param input - Chat channel the agent was given, plus the file and optional thread
   * @returns What was uploaded, or why it could not be
   */
  async attachFileForAgent(input: {
    chatChannelId: string;
    agentSession: string;
    filePath: string;
    filename?: string;
    title?: string;
    comment?: string;
    /** Slack thread key (`<channel>:<ts>`) or chat-v2 message id of the thread */
    threadId?: string;
  }): Promise<
    | { ok: true; slackChannelId: string; threadTs?: string; fileId?: string; asAgentBot: boolean }
    | { ok: false; reason: string }
  > {
    const link = this.findByChatChannelId(input.chatChannelId);
    if (!link) return { ok: false, reason: 'not_a_slack_channel' };

    const installed = this.deps.identities.getInstalled(link.agentSession);
    if (!installed) return { ok: false, reason: 'agent_has_no_slack_bot' };

    const target = this.resolveReplyTarget(link, { threadRef: input.threadId, forAttachment: true });
    const threadTs = target.threadTs;
    try {
      const result = await this.deps.slack.uploadFile({
        channelId: link.slackChannelId,
        filePath: input.filePath,
        ...(input.filename ? { filename: input.filename } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.comment ? { initialComment: input.comment } : {}),
        ...(threadTs ? { threadTs } : {}),
        botToken: installed.botToken,
      });
      // The file is the agent answering in that thread: no "working on it"
      // may be left there (2026-09-28).
      await this.deps.typing?.dropThread?.({
        agentSession: link.agentSession,
        slackChannelId: link.slackChannelId,
        ...(threadTs ? { threadTs } : {}),
      }).catch(() => 0);
      this.logger.info('Agent attached a file to its Slack DM', {
        agentSession: link.agentSession,
        slackChannelId: link.slackChannelId,
        threaded: Boolean(threadTs),
        threadTs,
        via: target.via,
      });
      return {
        ok: true,
        slackChannelId: link.slackChannelId,
        ...(threadTs ? { threadTs } : {}),
        ...(result.fileId ? { fileId: result.fileId } : {}),
        asAgentBot: true,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn('Agent DM file attach failed', { agentSession: link.agentSession, reason });
      return { ok: false, reason };
    }
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

    const previous = this.store.links[channel.id];
    const inboundThreadTs = message.threadTs || message.ts;
    // Another Slack DM (the owner re-opened the conversation): the old
    // conversation's threads cannot be posted into from here.
    const sameConversation = previous?.slackChannelId === message.channelId;
    const link: SlackAgentDmLink = {
      chatChannelId: channel.id,
      agentSession,
      slackChannelId: message.channelId,
      // `ts` when the question was top-level: the answer opens a thread under
      // it instead of landing beside it.
      ...(inboundThreadTs ? { replyThreadTs: inboundThreadTs } : {}),
      ...(inboundThreadTs
        ? { openThreads: withOpenThread(sameConversation ? previous?.openThreads : undefined, inboundThreadTs, this.now()) }
        : sameConversation && previous?.openThreads
          ? { openThreads: previous.openThreads }
          : {}),
      ...(sameConversation && previous?.lastReply ? { lastReply: previous.lastReply } : {}),
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
        ...(message.teamId ? { slackTeamId: message.teamId } : {}),
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
    // The placeholder goes where the reply will go — the message's thread,
    // started by the message itself when it has none (see replyThreadTs).
    // Keyed on message.threadTs alone, a top-level DM got its placeholder at
    // the top level while the reply went into the thread under a different
    // key: the placeholder was never replaced, and ten minutes later turned
    // into "still working on this" next to an answered thread (2026-09-23).
    const typingKey = { agentSession, slackChannelId: message.channelId, threadTs: message.threadTs || message.ts };
    const typing = installed && this.deps.typing ? this.deps.typing : null;
    if (typing) {
      const awake = this.deps.isAgentAwake ? this.deps.isAgentAwake(agentSession) : true;
      await typing.begin(typingKey, { botToken: installed!.botToken, displayName: member?.name ?? agentSession }, awake ? 'typing' : 'waking', message.ts);
    }

    // The placeholder above may not be showing (its post failed, Slack
    // blipped): the agent starting on the owner's message posts it then.
    const autoWatch =
      typing && this.deps.autoWorking && isOwnerAuthored(message, this.deps.getOwnerUserId?.())
        ? this.deps.autoWorking.watch({
            slackChannelId: typingKey.slackChannelId,
            threadTs: typingKey.threadTs,
            sourceTs: message.ts,
            candidates: [agentSession],
            identityFor: () => ({ botToken: installed!.botToken, displayName: member?.name ?? agentSession }),
          })
        : null;

    // Ticket loop (specs/ticket-loop.md §2): an owner's ask in an agent's DM
    // is a ticket assigned to that agent. The receipt goes into the DM thread
    // under the agent's own bot (the workspace bot cannot see this DM).
    const ticket = await this.intakeTicket(message, agentSession);

    const dispatcher = this.deps.getDispatcher();
    let dispatch: DispatchMessageResult | null = null;
    if (dispatcher) {
      // A threaded DM: the thread as Slack has it (top-level DMs get none).
      const slackContext = await message.threadContext;
      dispatch = await dispatcher.dispatchMessage(
        channel,
        markAndLinkTicket(persisted, ticket),
        slackContext
          ? {
              slackContextFor: () =>
                renderSlackThreadContext(slackContext, { botUserId: installed?.botUserId, name: member?.name ?? agentSession }),
            }
          : undefined,
      );
    } else {
      this.logger.warn('No chat dispatcher wired — DM persisted but not delivered', { agentSession });
    }
    autoWatch?.delivered(deliveredSessions(dispatch, agentSession));
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
  private rememberSent(slackChannelId: string, text: string, source: string | null): void {
    this.lastSent.set(slackChannelId, { text, at: this.now().getTime(), source });
  }

  /**
   * Whether this turn is the other runtime's restatement of the answer just
   * sent — see {@link DM_CROSS_RUNTIME_WINDOW_MS}.
   *
   * @param slackChannelId - The DM
   * @param source - `metadata.source` of the turn about to be sent
   * @returns True when it should not be sent
   */
  private isCrossRuntimeRestatement(slackChannelId: string, source: string | null): boolean {
    if (source !== DM_SUMMARY_SOURCE) return false;
    const previous = this.lastSent.get(slackChannelId);
    if (!previous || previous.source === DM_SUMMARY_SOURCE) return false;
    return this.now().getTime() - previous.at <= DM_CROSS_RUNTIME_WINDOW_MS;
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
    return (await this.mirrorOutboundDetailed(dto)).attempted;
  }

  /**
   * {@link mirrorOutbound} with the outcome: where the reply landed (also
   * stored on the chat message) or Slack's error.
   *
   * @param dto - The chat-v2 message
   * @returns Whether a post was attempted, and its delivery (null when not meant for Slack)
   */
  async mirrorOutboundDetailed(dto: ChatMessageDTO): Promise<{ attempted: boolean; delivery: SlackOutboundDelivery | null }> {
    const no: { attempted: boolean; delivery: SlackOutboundDelivery | null } = { attempted: false, delivery: null };
    let linkedChannel: string | null = null;
    try {
      if (dto.senderType !== 'agent') return no;
      if (dto.metadata?.source === 'slack') return no;
      await this.load();
      const link = this.store.links[dto.channelId];
      if (!link) return no;
      linkedChannel = link.slackChannelId;
      // Reply affinity (specs/unified-conversations-cloud-store.md §A.3 G6):
      // the DM channel is shared with Crewly Chat and Cloud Talk, so an answer
      // goes to Slack only when the owner last spoke there. A question asked
      // on the dashboard or from Cloud Talk is answered where it was asked.
      //
      // It used to drop every reply whenever the owner's last word was on
      // another surface — an unprompted follow-up days later never reached
      // the owner's Slack (specs/2026-10-02-harness-owned-routing.md §6).
      // Now the other surface keeps the answer only while that conversation
      // is live (DM_AFFINITY_FRESH_MS) and the reply names no Slack thread.
      const ownerSurface = this.deps.chat.getLatestOwnerTurnSource(dto.channelId);
      if (ownerSurface !== null && ownerSurface !== 'slack') {
        const namesSlackThread = !!parseSlackThreadKey(dto.metadata?.[SLACK_THREAD_KEY_CONSTANTS.METADATA_KEY]);
        const getAt = this.deps.chat.getLatestOwnerTurnAt?.bind(this.deps.chat);
        const lastAt = getAt ? getAt(dto.channelId) : null;
        // Without a timestamp source the other surface keeps it (old behaviour).
        const live = getAt ? lastAt !== null && this.now().getTime() - lastAt < REPLY_ROUTING_CONSTANTS.DM_AFFINITY_FRESH_MS : true;
        if (!namesSlackThread && live) {
          this.logger.info('DM reply answered where the owner is talking now (not mirrored to Slack)', {
            agentSession: link.agentSession,
            ownerSurface,
          });
          return no;
        }
      }
      if (!this.deps.slack.isConnected()) return no;

      const installed = this.deps.identities.getInstalled(link.agentSession);
      if (!installed) {
        this.logger.warn('Agent has no installed Slack bot — DM reply not mirrored', { agentSession: link.agentSession });
        return no;
      }
      // The thread this answer is FOR — not simply where the owner wrote last.
      const target = this.resolveReplyTarget(link, { dto });
      const key = { agentSession: link.agentSession, slackChannelId: link.slackChannelId, ...(target.threadTs ? { threadTs: target.threadTs } : {}) };
      const text = toSlackMrkdwn(dto.content);
      // An agent that both posts its answer with a tool and returns the same
      // answer as its turn text produces two chat turns, and both are agent
      // messages on the same DM — so the owner saw the reply twice, the
      // second prefixed with the agent reporting that it had replied
      // (2026-09-20). Suppressed here rather than in a prompt: this holds
      // whatever the model does.
      const source = typeof dto.metadata?.source === 'string' ? dto.metadata.source : null;
      if (this.isRepeatOfLastSent(link.slackChannelId, text)) {
        this.logger.info('DM reply suppressed as a repeat of the one just sent', {
          agentSession: link.agentSession,
          slackChannelId: link.slackChannelId,
        });
        return no;
      }
      if (this.isCrossRuntimeRestatement(link.slackChannelId, source)) {
        this.logger.info('DM reply suppressed: the other runtime already sent this answer', {
          agentSession: link.agentSession,
          slackChannelId: link.slackChannelId,
          source,
        });
        return no;
      }
      this.rememberSent(link.slackChannelId, text, source);
      this.noteAnswered(link, target.threadTs, isInterim(dto));
      if (target.via !== 'latest' || (link.openThreads?.length ?? 0) > 0) {
        this.logger.info('DM reply routed to its thread', {
          agentSession: link.agentSession,
          slackChannelId: link.slackChannelId,
          threadTs: target.threadTs,
          via: target.via,
        });
      }
      if (this.deps.typing) {
        const identity = { botToken: installed.botToken, displayName: link.agentSession };
        // Interim note → still working: the placeholder goes back under it,
        // in the same step (see SlackTypingPlaceholderService.resolve).
        let postedTs = '';
        const onMessageTs = (ts: string): void => { postedTs = ts; };
        if (isInterim(dto)) await this.deps.typing.resolve(key, text, identity, { reopen: 'typing', onMessageTs });
        else await this.deps.typing.resolve(key, text, identity, { onMessageTs });
        return { attempted: true, delivery: this.recordDelivery(dto, link.slackChannelId, postedTs, target.threadTs) };
      }
      const sentTs = await this.deps.slack.sendMessage({
        channelId: link.slackChannelId,
        text,
        ...(target.threadTs ? { threadTs: target.threadTs } : {}),
        botToken: installed.botToken,
        senderSession: link.agentSession,
        skipChatV2Mirror: true,
      });
      return { attempted: true, delivery: this.recordDelivery(dto, link.slackChannelId, sentTs, target.threadTs) };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.warn('DM reply mirror to Slack failed', {
        channelId: dto.channelId,
        sender: dto.senderId,
        error,
      });
      return {
        attempted: true,
        delivery: linkedChannel ? { delivered: false, slackChannelId: linkedChannel, error } : null,
      };
    }
  }

  /**
   * Store where a mirrored DM reply landed on its chat message.
   *
   * @param dto - The mirrored message
   * @param slackChannelId - Slack DM channel
   * @param ts - Slack ts of the message that carries the reply ('' when unknown)
   * @param threadTs - Thread the reply is in
   * @returns The delivery
   */
  private recordDelivery(dto: ChatMessageDTO, slackChannelId: string, ts: string, threadTs?: string | null): SlackOutboundDelivery {
    try {
      this.deps.chat.updateMessageMetadata?.(dto.id, {
        [SLACK_DELIVERY_METADATA_KEY]: { slackChannelId, ts: ts || null, threadTs: threadTs ?? null },
      });
    } catch (err) {
      this.logger.warn('Could not store the Slack ts on the mirrored DM message', {
        messageId: dto.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { delivered: true, slackChannelId, ...(ts ? { ts } : {}), ...(threadTs ? { threadTs } : {}) };
  }


  // -------------------------------------------------------------------------
  // Thread routing
  // -------------------------------------------------------------------------

  /**
   * Which thread of the DM an outbound post belongs in.
   *
   * In order: the Slack thread key the agent named (`--thread <key>`, or the
   * key recorded on its reply); the Slack thread of the chat-v2 message it
   * replied under (`--thread <message id>` — ticket nudges use this); for a
   * file, the answer posted moments ago; the OLDEST thread still owed an
   * answer; and only when nothing is owed, the thread the owner wrote in
   * last. A key naming another conversation is ignored rather than trusted.
   *
   * @param link - The DM link
   * @param opts - The reply being mirrored, or an explicit thread reference
   * @returns Target thread and how it was chosen
   */
  resolveReplyTarget(
    link: SlackAgentDmLink,
    opts: { dto?: Pick<ChatMessageDTO, 'metadata' | 'threadId'>; threadRef?: string; forAttachment?: boolean },
  ): AgentDmReplyTarget {
    const inThisDm = (parts: { slackChannelId: string; threadTs: string } | null): string | undefined =>
      parts && parts.slackChannelId === link.slackChannelId ? parts.threadTs : undefined;

    const fromKey =
      inThisDm(parseSlackThreadKey(opts.threadRef)) ??
      inThisDm(parseSlackThreadKey(opts.dto?.threadId)) ??
      inThisDm(parseSlackThreadKey(opts.dto?.metadata?.[SLACK_THREAD_KEY_CONSTANTS.METADATA_KEY]));
    if (fromKey) return { threadTs: fromKey, via: 'key' };

    const rootId = opts.threadRef && !parseSlackThreadKey(opts.threadRef) ? opts.threadRef : opts.dto?.threadId;
    if (rootId && this.deps.chat.getMessageForBridge) {
      try {
        const root = this.deps.chat.getMessageForBridge(rootId);
        const ts = inThisDm(slackThreadOfMetadata(root?.metadata));
        if (ts) return { threadTs: ts, via: 'thread-root' };
      } catch {
        /* unknown message — fall through to the heuristics */
      }
    }

    if (opts.forAttachment && link.lastReply) {
      const age = this.now().getTime() - Date.parse(link.lastReply.at);
      if (Number.isFinite(age) && age >= 0 && age <= SLACK_AGENT_DM_CONSTANTS.ATTACH_FOLLOWS_REPLY_MS) {
        return { threadTs: link.lastReply.threadTs, via: 'recent-reply' };
      }
    }

    const oldest = link.openThreads?.[0];
    if (oldest) return { threadTs: oldest.threadTs, via: 'oldest-open' };
    return { ...(link.replyThreadTs ? { threadTs: link.replyThreadTs } : {}), via: 'latest' };
  }

  /**
   * An answer went into a thread: it no longer owes one (an interim note
   * does not count), and a file sent right after follows it there.
   *
   * @param link - The DM link (updated in place and persisted)
   * @param threadTs - Where the answer went
   * @param interim - Whether it was only an interim note
   */
  private noteAnswered(link: SlackAgentDmLink, threadTs: string | undefined, interim: boolean): void {
    if (!threadTs) return;
    // In memory first and synchronously: a second answer mirrored right
    // behind this one must already see this thread as answered.
    link.lastReply = { threadTs, at: this.now().toISOString() };
    if (!interim && link.openThreads?.some((t) => t.threadTs === threadTs)) {
      link.openThreads = link.openThreads.filter((t) => t.threadTs !== threadTs);
    }
    void this.persist();
  }

  /**
   * The agent finished a turn: threads it left unanswered for longer than
   * SETTLE_MIN_AGE_MS are ones it chose not to answer ("ok", "谢谢") — the
   * same rule that takes their "working on it" placeholder down. They stop
   * counting as owed, so a later unattributed answer is not pulled back
   * into them.
   *
   * @param agentSession - Agent whose turn ended
   * @returns How many threads were settled
   */
  async settleOpenThreads(agentSession: string): Promise<number> {
    await this.load();
    const cutoff = this.now().getTime() - SLACK_TYPING_CONSTANTS.SETTLE_MIN_AGE_MS;
    let settled = 0;
    for (const link of Object.values(this.store.links)) {
      if (link.agentSession !== agentSession || !link.openThreads?.length) continue;
      const keep = link.openThreads.filter((t) => {
        const at = Date.parse(t.at);
        return Number.isFinite(at) && at > cutoff;
      });
      settled += link.openThreads.length - keep.length;
      link.openThreads = keep;
    }
    if (settled > 0) await this.persist();
    return settled;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Ticket intake for a DM to an agent's bot. Never throws.
   *
   * @param message - The inbound DM
   * @param agentSession - The agent it was addressed to
   * @returns The ticket the message belongs to, or null
   */
  private async intakeTicket(message: SlackIncomingMessage, agentSession: string): Promise<Request | null> {
    try {
      const outcome = await intakeWithin(
        getTicketIntakeService(),
        slackIntakeMessage(
          {
            text: message.text ?? '',
            slackChannelId: message.channelId,
            ts: message.ts,
            threadTs: message.threadTs,
            userId: message.userId,
            userName: message.user?.realName || message.user?.name,
            authorAgentSession: message.authorAgentSession,
            hasFiles: message.hasFiles,
            ownerUserId: this.deps.getOwnerUserId?.() ?? null,
          },
          'agent-dm',
          { targetAgent: agentSession, receiptPostAs: agentSession },
        ),
      );
      return ticketOfOutcome(outcome);
    } catch (err) {
      this.logger.warn('Ticket intake failed for an agent DM (still delivered)', {
        agentSession,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

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

/**
 * Add a thread to the owed list, keeping its original place when it is
 * already there (a follow-up in an owed thread does not make it newer).
 *
 * @param open - Current list, oldest first
 * @param threadTs - Thread that now owes an answer
 * @param now - Current time
 * @returns The new list, capped at MAX_OPEN_THREADS (oldest dropped)
 */
export function withOpenThread(
  open: readonly SlackAgentDmOpenThread[] | undefined,
  threadTs: string,
  now: Date,
): SlackAgentDmOpenThread[] {
  const list = [...(open ?? [])];
  if (!list.some((t) => t.threadTs === threadTs)) list.push({ threadTs, at: now.toISOString() });
  return list.slice(-SLACK_AGENT_DM_CONSTANTS.MAX_OPEN_THREADS);
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
