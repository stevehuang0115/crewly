/**
 * Slack Agent Post Service — an agent starting a Slack conversation itself.
 *
 * Everything else in the Slack layer is reactive: a message arrives, an agent
 * answers. This is the other direction. An agent calls the `slack-post` skill
 * and the message goes to a channel or into a DM, under the agent's own
 * identity when it has one.
 *
 * Target syntax (one string, so the skill stays a one-liner):
 *
 * | Target | Meaning |
 * |---|---|
 * | `#general`, `general` | public/private channel by name (lower-case) |
 * | `C0123ABCD` | channel by id (upper-case) |
 * | `D0123ABCD` | an already-open DM channel |
 * | `@sam`, `U0123ABCD` | DM that person |
 *
 * Identity: an agent with a Cloud-provisioned Slack app posts with its own
 * bot token, so a DM is a real conversation between the person and that agent.
 * Without one it falls back to the shared Crewly bot with the agent's name and
 * icon — visually similar, but the DM is Crewly's, not the agent's.
 *
 * @module services/slack/slack-agent-post.service
 */

import type { SlackTypingPlaceholderService } from './slack-typing-placeholder.service.js';
import type { Team } from '../../types/index.js';
import type { SlackChannelInfo, SlackOutgoingMessage } from '../../types/slack.types.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { SLACK_AGENT_POST_CONSTANTS } from '../../constants.js';
import { slackIdentityFor } from './slack-team-channel.service.js';
import type { SlackAgentIdentityService } from './slack-agent-identity.service.js';

/** The slice of SlackService this service uses. */
export interface AgentPostSlackApi {
  isConnected(): boolean;
  sendMessage(message: SlackOutgoingMessage): Promise<string>;
  findChannelByName(name: string): Promise<SlackChannelInfo | null>;
  openDirectMessage(userId: string, botToken?: string): Promise<string>;
  findUserByHandle(handle: string): Promise<string | null>;
}

/** The slice of the identity service this service uses. */
export type AgentPostIdentityApi = Pick<SlackAgentIdentityService, 'load' | 'getInstalled'>;

/** Storage slice — used to give a token-less agent its name and icon. */
export interface AgentPostStorageApi {
  getTeams(): Promise<Team[]>;
}

/** Constructor dependencies. */
export interface SlackAgentPostServiceDeps {
  slack: AgentPostSlackApi;
  storage: AgentPostStorageApi;
  identities?: AgentPostIdentityApi | null;
  /** Placeholders of replies agents owe — a post into such a conversation answers it */
  typing?: Pick<SlackTypingPlaceholderService, 'findOwed' | 'resolve'> | null;
  /** Links `@Name` to real Slack mentions (agents' bots and known people). */
  linkMentions?: SlackMentionLinker;
}

/** One post request. */
export interface SlackAgentPostRequest {
  /** The agent asking (its session name). */
  agentSession: string;
  /** Channel or person — see the table in the module docs. */
  target: string;
  text: string;
  /** Reply inside an existing Slack thread. */
  threadTs?: string;
}

/** What happened. */
export interface SlackAgentPostResult {
  channelId: string;
  messageTs: string;
  kind: 'channel' | 'dm';
  /** `agent` when the agent's own bot posted, `crewly` for the shared bot. */
  postedAs: 'agent' | 'crewly';
  /** Display name the message carries. */
  identity: string;
}

/**
 * Turns `@Name` into `<@Uxxx>` for known agents and people. Optional; when
 * absent (or when it fails) the text is posted as written.
 */
export type SlackMentionLinker = (text: string, channelId: string) => Promise<string>;

/** Reasons a post can be refused, for HTTP mapping. */
export type SlackAgentPostErrorCode = 'validation' | 'not_connected' | 'target_not_found' | 'slack_error';

/** Structured failure. */
export class SlackAgentPostError extends Error {
  constructor(
    public readonly code: SlackAgentPostErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SlackAgentPostError';
  }
}

// Case is the discriminator, and it is reliable: Slack ids are uppercase,
// while Slack forces channel names to lowercase. Matching case-insensitively
// would swallow ordinary names — `general` is `G` followed by six
// alphanumerics, so it would have been read as a private-channel id.
const CHANNEL_ID_RE = /^[CG][A-Z0-9]{6,}$/;
const DM_ID_RE = /^D[A-Z0-9]{6,}$/;
const USER_ID_RE = /^[UW][A-Z0-9]{6,}$/;

/**
 * Service — see module docs.
 */
export class SlackAgentPostService {
  private readonly logger: ComponentLogger;
  private readonly deps: SlackAgentPostServiceDeps;

  constructor(deps: SlackAgentPostServiceDeps) {
    this.deps = deps;
    this.logger = LoggerService.getInstance().createComponentLogger('SlackAgentPost');
  }

  /**
   * Link `@Name` mentions, falling back to the text as written.
   *
   * @param text - Agent text
   * @param channelId - Where it is going (decides between same-named agents)
   * @returns Text with Slack mentions where a name is known
   */
  private async linkMentions(text: string, channelId: string): Promise<string> {
    if (!this.deps.linkMentions || !text.includes('@')) return text;
    try {
      return await this.deps.linkMentions(text, channelId);
    } catch (err) {
      this.logger.warn('Mention linking failed — posting as written', { error: errText(err) });
      return text;
    }
  }

  /**
   * Send one agent-initiated message.
   *
   * @param req - Who is posting, where, and what
   * @returns Where it landed and which identity carried it
   * @throws {SlackAgentPostError} `validation` for bad input, `not_connected`
   *   when Slack is not up, `target_not_found` when the channel or person
   *   cannot be resolved, `slack_error` when Slack refuses the send
   */
  async post(req: SlackAgentPostRequest): Promise<SlackAgentPostResult> {
    const agentSession = (req.agentSession ?? '').trim();
    const target = (req.target ?? '').trim();
    const rawText = req.text ?? '';
    if (!agentSession) throw new SlackAgentPostError('validation', 'agentSession is required');
    if (!target) throw new SlackAgentPostError('validation', 'target is required');
    if (!rawText.trim()) throw new SlackAgentPostError('validation', 'text is required');
    if (rawText.length > SLACK_AGENT_POST_CONSTANTS.MAX_TEXT_LENGTH) {
      throw new SlackAgentPostError(
        'validation',
        `text exceeds ${SLACK_AGENT_POST_CONSTANTS.MAX_TEXT_LENGTH} characters`,
      );
    }
    if (!this.deps.slack.isConnected()) {
      throw new SlackAgentPostError('not_connected', 'Slack is not connected');
    }

    const { identity, botToken, postedAs } = await this.resolveIdentity(agentSession);
    const { channelId, kind } = await this.resolveTarget(target, botToken);
    // "@Ella" → a real mention. This path posted agent text verbatim, so an
    // agent naming a colleague here never notified them (2026-09-25).
    const text = await this.linkMentions(rawText, channelId);

    // An agent that owes an answer here (a "working on it…" placeholder is up,
    // or timed out) and posts without naming a thread is answering: put it in
    // that thread and take the placeholder down. Ella answered the owner's
    // in-thread question with this skill and it landed top-level, next to a
    // "⏱ still working" that never went away (2026-09-25).
    const owed = !req.threadTs ? this.deps.typing?.findOwed(agentSession, channelId) ?? null : null;
    if (owed) {
      try {
        await this.deps.typing!.resolve(owed, text, {
          displayName: identity.username ?? agentSession,
          ...(identity.botToken ? { botToken: identity.botToken } : {}),
          ...(identity.username ? { username: identity.username } : {}),
          ...(identity.iconEmoji ? { iconEmoji: identity.iconEmoji } : {}),
          ...(identity.iconUrl ? { iconUrl: identity.iconUrl } : {}),
        });
      } catch (err) {
        throw new SlackAgentPostError('slack_error', this.explainSendFailure(err, kind, postedAs));
      }
      this.logger.info('Agent posted to Slack', {
        agentSession,
        channelId,
        kind,
        postedAs,
        threaded: !!owed.threadTs,
        answeredOwedReply: true,
        chars: text.length,
      });
      return { channelId, messageTs: '', kind, postedAs, identity: identity.username ?? agentSession };
    }

    let messageTs: string;
    try {
      messageTs = await this.deps.slack.sendMessage({
        channelId,
        text,
        threadTs: req.threadTs,
        // The chat-v2 mirror attributes outbound Slack replies to the
        // orchestrator, which would misfile an agent's own post. Team-channel
        // traffic is mirrored by its own path; this one stays Slack-only.
        skipChatV2Mirror: true,
        ...identity,
      });
    } catch (err) {
      throw new SlackAgentPostError('slack_error', this.explainSendFailure(err, kind, postedAs));
    }

    this.logger.info('Agent posted to Slack', {
      agentSession,
      channelId,
      kind,
      postedAs,
      threaded: !!req.threadTs,
      chars: text.length,
    });
    return { channelId, messageTs, kind, postedAs, identity: identity.username ?? agentSession };
  }

  /**
   * Which identity this agent posts under: its own bot token when installed,
   * otherwise the shared bot with the member's name and icon.
   */
  private async resolveIdentity(agentSession: string): Promise<{
    identity: Pick<SlackOutgoingMessage, 'username' | 'iconEmoji' | 'iconUrl' | 'botToken'>;
    botToken?: string;
    postedAs: 'agent' | 'crewly';
  }> {
    if (this.deps.identities) {
      await this.deps.identities.load();
      const installed = this.deps.identities.getInstalled(agentSession);
      if (installed) {
        const member = await this.findMember(agentSession);
        return {
          identity: { botToken: installed.botToken, username: member?.name ?? agentSession },
          botToken: installed.botToken,
          postedAs: 'agent',
        };
      }
    }
    const member = await this.findMember(agentSession);
    return { identity: slackIdentityFor(member, agentSession), postedAs: 'crewly' };
  }

  /** The team member behind a session, for name and avatar. */
  private async findMember(agentSession: string): Promise<Team['members'][number] | undefined> {
    try {
      const teams = await this.deps.storage.getTeams();
      for (const team of teams) {
        const member = team.members?.find((m) => m.sessionName === agentSession);
        if (member) return member;
      }
    } catch (err) {
      this.logger.debug('Could not read teams for agent identity', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return undefined;
  }

  /**
   * Turn a target string into a Slack conversation id.
   *
   * @param target - See the table in the module docs
   * @param botToken - Token to open the DM with, so the DM belongs to the agent
   * @returns The conversation id and whether it is a channel or a DM
   */
  private async resolveTarget(target: string, botToken?: string): Promise<{ channelId: string; kind: 'channel' | 'dm' }> {
    if (DM_ID_RE.test(target)) return { channelId: target, kind: 'dm' };
    if (CHANNEL_ID_RE.test(target)) return { channelId: target, kind: 'channel' };
    if (USER_ID_RE.test(target)) return { channelId: await this.openDm(target, botToken), kind: 'dm' };

    if (target.startsWith('@')) {
      const handle = target.slice(1);
      const userId = await this.lookupHandle(handle);
      if (!userId) throw new SlackAgentPostError('target_not_found', `No Slack user matches "@${handle}"`);
      return { channelId: await this.openDm(userId, botToken), kind: 'dm' };
    }

    const name = target.replace(/^#/, '');
    let channel: SlackChannelInfo | null;
    try {
      channel = await this.deps.slack.findChannelByName(name);
    } catch (err) {
      const text = errText(err);
      // Resolving a name needs channels:read / groups:read. Say so, rather
      // than handing the agent a bare Slack error code it cannot act on.
      const hint = /missing_scope/.test(text)
        ? ' — the app is missing channels:read; reinstall it to pick up the new scopes, or pass the channel id instead'
        : '';
      throw new SlackAgentPostError('slack_error', `Could not look up channel "#${name}": ${text}${hint}`);
    }
    if (!channel) throw new SlackAgentPostError('target_not_found', `No Slack channel named "#${name}"`);
    if (channel.isArchived) throw new SlackAgentPostError('target_not_found', `Channel "#${name}" is archived`);
    return { channelId: channel.id, kind: 'channel' };
  }

  private async openDm(userId: string, botToken?: string): Promise<string> {
    try {
      return await this.deps.slack.openDirectMessage(userId, botToken);
    } catch (err) {
      const text = errText(err);
      if (/missing_scope/.test(text)) {
        throw new SlackAgentPostError(
          'slack_error',
          'Slack refused to open the DM: the app is missing the im:write scope — reinstall it to pick up the new scopes',
        );
      }
      // Slack refuses a DM between two apps. An agent reaching for "@<its
      // own name>" lands here, and the raw code told it nothing — one agent
      // read it as "DMs are unavailable" and posted the owner's personal
      // calendar into a public team channel instead (2026-09-21).
      if (/cannot_dm_bot/.test(text)) {
        throw new SlackAgentPostError(
          'target_not_found',
          `${userId} is a bot, and Slack does not allow one app to DM another. Target the person instead (@their-handle). Do not fall back to a channel: whatever you were about to say privately stays private.`,
        );
      }
      throw new SlackAgentPostError('slack_error', `Could not open a DM with ${userId}: ${text}`);
    }
  }

  private async lookupHandle(handle: string): Promise<string | null> {
    try {
      return await this.deps.slack.findUserByHandle(handle);
    } catch (err) {
      throw new SlackAgentPostError('slack_error', `Could not look up "@${handle}": ${errText(err)}`);
    }
  }

  /** Turn Slack's send errors into something an agent can act on. */
  private explainSendFailure(err: unknown, kind: 'channel' | 'dm', postedAs: 'agent' | 'crewly'): string {
    const text = errText(err);
    if (/not_in_channel|channel_not_found/.test(text) && kind === 'channel') {
      const who = postedAs === 'agent' ? "this agent's Slack bot" : 'the Crewly bot';
      return `Slack refused the post (${text}): invite ${who} into the channel, or use a public channel (chat:write.public covers those)`;
    }
    if (/missing_scope/.test(text)) {
      return `Slack refused the post (${text}): reinstall the app to pick up the new scopes`;
    }
    return `Slack refused the post: ${text}`;
  }
}

function errText(err: unknown): string {
  if (err && typeof err === 'object') {
    const data = (err as { data?: { error?: string } }).data;
    if (typeof data?.error === 'string') return data.error;
  }
  return err instanceof Error ? err.message : String(err);
}

let instance: SlackAgentPostService | null = null;

/**
 * Install the process-wide instance (composition root).
 *
 * @param service - The service or null
 */
export function setSlackAgentPostService(service: SlackAgentPostService | null): void {
  instance = service;
}

/**
 * The process-wide instance, or null before wiring.
 *
 * @returns The service or null
 */
export function getSlackAgentPostService(): SlackAgentPostService | null {
  return instance;
}
