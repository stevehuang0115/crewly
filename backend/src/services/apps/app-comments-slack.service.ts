/**
 * Crewly App comments <-> Slack, both ways (owner request 2026-10-05: "a
 * reply on either side is visible on both").
 *
 * - An owner comment (new, or a reply) delivered to an agent is also posted in
 *   Slack as that agent's bot — in its DM with the owner, else its team
 *   channel — as the root of ONE Slack thread per comment thread. The
 *   `{appId, commentId} <-> {channel, thread_ts}` mapping is persisted in
 *   `<CREWLY_HOME>/apps/comment-slack-links.json`.
 * - An agent's reply / resolve / reopen on the comment is posted into that
 *   thread.
 * - The owner replying in the mapped Slack thread is relayed to Cloud as an
 *   owner reply (`via: 'slack'`) and CONSUMED here (inbound interceptor), so it
 *   is not also routed to the agent as a chat message. The agent gets it once,
 *   from the normal change feed. Slack-originated replies are never mirrored
 *   back to Slack.
 *
 * Rooms (crewly-services apps/SPEC.md §15): for an app owned by a team or a
 * channel, {@link AppCommentRoomService} posts the comment into that room and
 * its Slack channel and stores the link here too (`room` set). The owner's
 * reply in such a Slack thread is relayed to Cloud the same way but NOT
 * consumed: the room's members see it through the normal Slack room routing
 * (room rules decide who answers), and the room service skips Cloud's
 * `via: 'slack'` echo, so nobody gets it twice.
 *
 * Off switch: `CREWLY_APP_COMMENTS_SLACK=off`. A failed Slack post never
 * affects comment delivery. Harness text is English; the comment text is the
 * owner's words.
 *
 * @module services/apps/app-comments-slack.service
 */

import fs from 'fs/promises';
import path from 'path';
import { CREWLY_APPS_CONSTANTS } from '../../constants.js';
import { anchorSummary, type AppChange } from './app-wake-message.js';
import { formatVoiceClock, mirrorVoiceToSlack, voiceAttachmentsOf, type SlackAudioUpload, type VoiceFiles } from './app-comment-audio.service.js';

/** The team or channel a room-owned comment thread lives in. */
export interface CommentRoomRef {
  kind: 'team' | 'channel';
  id: string;
  name: string;
}

/** One comment thread's Slack thread (and, for a room owner, its room thread). */
export interface CommentSlackLink {
  appId: string;
  commentId: string;
  /** The agent whose bot posted the root (and posts the rest) */
  agentSession: string;
  /** Slack channel and root ts ('' when the room has no Slack channel) */
  channel: string;
  threadTs: string;
  /** Set for a comment delivered to the room (team / channel) that owns the app */
  room?: CommentRoomRef;
  /** The room's chat-v2 channel (huddle) and the thread root row there */
  chatChannelId?: string;
  chatRootId?: string;
  /** Reply ids already shown in Slack (so two recipients / a resend never double-post) */
  replyIds: string[];
  createdAt: string;
}

/** The inbound Slack message slice the interceptor reads. */
export interface InboundSlackMessage {
  channelId: string;
  ts: string;
  threadTs?: string;
  userId?: string;
  text?: string;
  authorAgentSession?: string;
}

/** Collaborators (all injectable). */
export interface CommentSlackDeps {
  /** Crewly home directory */
  homeDir: string;
  /** Post as the agent's bot */
  post: (req: { agentSession: string; target: string; text: string; threadTs?: string }) => Promise<{ channelId: string; messageTs: string }>;
  /** Upload a voice comment recording into the thread as the agent's bot (SPEC §16); absent = a link line instead */
  uploadAudio?: SlackAudioUpload;
  /** The Slack DM channel id of an agent with the owner, when it has one */
  dmChannelOf: (agentSession: string) => string | null;
  /** The Slack channel id of the agent's team channel, when it has one */
  teamChannelOf: (agentSession: string) => Promise<string | null>;
  /** Display name of an agent */
  nameOf?: (agentSession: string) => string;
  /** Where the app opens for the owner */
  appUrl?: (appId: string) => string;
  /** Add the owner's reply to the Cloud thread */
  relayOwnerReply: (appId: string, commentId: string, text: string, slackUserId: string) => Promise<void>;
  /** Whether a Slack user is the owner */
  isOwner: (userId: string) => boolean;
  /** The owner's Slack message in this thread was handled (stops "unanswered" tracking) */
  noteHandled?: (channel: string, threadTs: string) => void;
  /** Env override (tests) */
  env?: () => string | undefined;
  log?: (level: 'info' | 'warn', msg: string, meta?: Record<string, unknown>) => void;
}

/** Slack mrkdwn escapes for text that is not meant as markup. */
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Whether the mirror is switched off. */
export function commentsSlackOff(env: string | undefined = process.env.CREWLY_APP_COMMENTS_SLACK): boolean {
  return (env ?? '').trim().toLowerCase() === 'off';
}

/** Mirrors App comments to Slack and Slack thread replies back. */
export class AppCommentsSlackService {
  private readonly file: string;
  private links = new Map<string, CommentSlackLink>();
  private byThread = new Map<string, CommentSlackLink>();
  private byRoot = new Map<string, CommentSlackLink>();
  private loaded: Promise<void> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly seenInbound = new Set<string>();

  constructor(private readonly deps: CommentSlackDeps) {
    this.file = path.join(deps.homeDir, 'apps', 'comment-slack-links.json');
  }

  private off(): boolean {
    return commentsSlackOff(this.deps.env ? this.deps.env() : process.env.CREWLY_APP_COMMENTS_SLACK);
  }

  private log(level: 'info' | 'warn', msg: string, meta?: Record<string, unknown>): void {
    this.deps.log?.(level, msg, meta);
  }

  /** Load the mapping once (call at boot so the inbound check can be synchronous). */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const raw = JSON.parse(await fs.readFile(this.file, 'utf-8')) as { links?: CommentSlackLink[] };
        for (const l of raw.links ?? []) this.index(l);
      } catch {
        /* none yet */
      }
    })();
    return this.loaded;
  }

  private index(l: CommentSlackLink): void {
    this.links.set(`${l.appId}:${l.commentId}`, l);
    if (l.channel && l.threadTs) this.byThread.set(`${l.channel}:${l.threadTs}`, l);
    if (l.chatRootId) this.byRoot.set(l.chatRootId, l);
  }

  /**
   * Store a link made elsewhere (the room service), replacing any earlier one
   * for the same comment.
   *
   * @param link - The link
   */
  async saveLink(link: CommentSlackLink): Promise<void> {
    await this.load();
    this.index(link);
    await this.persist();
  }

  /**
   * Remember that a reply is shown in the thread (so a resend never doubles it).
   *
   * @param link - The link
   * @param replyId - Cloud reply id
   */
  async noteReply(link: CommentSlackLink, replyId: string): Promise<void> {
    await this.remember(link, replyId);
  }

  /** The room-owned comment thread whose root is this chat-v2 row, if any. */
  linkOfChatRoot(chatRootId: string): CommentSlackLink | null {
    return this.byRoot.get(chatRootId) ?? null;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ links: [...this.links.values()] }, null, 2), 'utf-8');
    await fs.rename(tmp, this.file);
  }

  /** The Slack thread of a comment, if one exists. */
  linkOf(appId: string, commentId: string): CommentSlackLink | null {
    return this.links.get(`${appId}:${commentId}`) ?? null;
  }

  /** Serialize work so a root is never created twice. */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.chain.then(work).catch((err) => this.log('warn', 'App comment Slack mirror failed', { error: err instanceof Error ? err.message : String(err) }));
    this.chain = next;
    return next;
  }

  /**
   * Owner comment changes just delivered to `session`: post new ones to Slack.
   *
   * @param session - The agent they were delivered to
   * @param appId - App
   * @param appName - App name
   * @param changes - The batch's comment changes
   */
  mirrorOwnerComments(session: string, appId: string, appName: string, changes: AppChange[], voiceFiles?: VoiceFiles): Promise<void> {
    if (this.off() || changes.length === 0) return Promise.resolve();
    return this.enqueue(async () => {
      await this.load();
      for (const c of changes) {
        const info = c.comment;
        const thread = info?.thread;
        if (!info?.id || !thread) continue;
        const op = info.op;
        if (op !== 'add' && op !== 'reply' && op !== 'reopen') continue;
        const reply = op === 'reply' ? (thread.replies ?? []).find((r) => r.id === info.replyId) : undefined;
        // Written in Slack: it is already there.
        if ((reply?.author as { via?: string } | undefined)?.via === 'slack' || (c.actor as { via?: string } | undefined)?.via === 'slack') continue;
        // A room-owned comment: the room service shows it (room + its Slack channel).
        if ((c as { roomOwned?: boolean }).roomOwned) continue;
        let link = this.linkOf(appId, info.id);
        if (link?.room) continue;
        if (op === 'add' && link) continue; // a second recipient of the same comment
        if (!link) {
          const rootVoice = op === 'add' ? voiceAttachmentsOf(c).map(({ attachment }) => ` 🎤 voice comment (${formatVoiceClock(attachment.durationMs)})`).join('') : '';
          link = await this.openThread(session, appId, appName, info.id, anchorSummary(thread.anchor), thread.body ?? '', rootVoice);
          if (!link) continue;
          if (op === 'add') {
            // the root IS the comment; its recording goes into the thread
            if (rootVoice) await this.voiceIn(link, c, voiceFiles);
            continue;
          }
        }
        if (op === 'reply' && reply?.id && reply.body !== undefined) {
          if (link.replyIds.includes(reply.id)) continue;
          const hasVoice = voiceAttachmentsOf(c).length > 0;
          if (await this.postIn(link, `💬 ${esc(reply.body || (hasVoice ? '(voice comment)' : ''))}`)) {
            await this.remember(link, reply.id);
            if (hasVoice) await this.voiceIn(link, c, voiceFiles);
          }
        } else if (op === 'reopen') {
          await this.postIn(link, '↩️ The owner reopened this comment in the app.');
        }
      }
    });
  }

  private async remember(link: CommentSlackLink, replyId: string): Promise<void> {
    link.replyIds = [...link.replyIds, replyId].slice(-50);
    await this.persist();
  }

  /** A change's voice recordings into the thread (upload as the bot, else a link line). Never throws. */
  private async voiceIn(link: CommentSlackLink, change: AppChange, files: VoiceFiles | undefined): Promise<void> {
    const url = (this.deps.appUrl ?? ((id) => `${CREWLY_APPS_CONSTANTS.APPS_ORIGIN}/${id}`))(link.appId);
    await mirrorVoiceToSlack({
      change,
      files,
      agentSession: link.agentSession,
      channel: link.channel,
      threadTs: link.threadTs,
      appUrl: url,
      ...(this.deps.uploadAudio ? { upload: this.deps.uploadAudio } : {}),
      post: (text) => this.postIn(link, text),
      log: this.deps.log,
    }).catch(() => 0);
  }

  private async openThread(session: string, appId: string, appName: string, commentId: string, element: string, body: string, voiceNote = ''): Promise<CommentSlackLink | null> {
    const target = this.deps.dmChannelOf(session) ?? (await this.deps.teamChannelOf(session));
    if (!target) {
      this.log('info', 'App comment not mirrored to Slack: the agent has no DM or team channel', { session, appId });
      return null;
    }
    const url = (this.deps.appUrl ?? ((id) => `${CREWLY_APPS_CONSTANTS.APPS_ORIGIN}/${id}`))(appId);
    const text = `💬 Comment on ${esc(appName)} — ${esc(element)}: ${esc(body)}${voiceNote}  ·  <${url}|Open app>`;
    const posted = await this.deps.post({ agentSession: session, target, text });
    const link: CommentSlackLink = { appId, commentId, agentSession: session, channel: posted.channelId, threadTs: posted.messageTs, replyIds: [], createdAt: new Date().toISOString() };
    this.index(link);
    await this.persist();
    return link;
  }

  private async postIn(link: CommentSlackLink, text: string): Promise<boolean> {
    try {
      await this.deps.post({ agentSession: link.agentSession, target: link.channel, text, threadTs: link.threadTs });
      return true;
    } catch (err) {
      this.log('warn', 'App comment Slack post failed', { appId: link.appId, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /**
   * An agent replied on a comment in the app: show it in the thread.
   *
   * @param replier - The replying agent session
   */
  agentReplied(appId: string, commentId: string, replier: string, text: string): Promise<void> {
    if (this.off()) return Promise.resolve();
    return this.enqueue(async () => {
      await this.load();
      const link = this.linkOf(appId, commentId);
      if (!link || link.room || !link.channel) return;
      // The thread's bot is the one in this channel; name a different replier.
      const who = replier !== link.agentSession ? `*${esc(this.deps.nameOf?.(replier) ?? replier)}:* ` : '';
      await this.postIn(link, `${who}${esc(text)}`);
    });
  }

  /** An agent resolved / reopened the comment in the app: one short line in the thread. */
  statusChanged(appId: string, commentId: string, by: string, action: 'resolve' | 'reopen'): Promise<void> {
    if (this.off()) return Promise.resolve();
    return this.enqueue(async () => {
      await this.load();
      const link = this.linkOf(appId, commentId);
      if (!link || link.room || !link.channel) return;
      const name = esc(this.deps.nameOf?.(by) ?? by);
      await this.postIn(link, action === 'resolve' ? `✅ Resolved by ${name}.` : `↩️ Reopened by ${name}.`);
    });
  }

  /**
   * Inbound Slack message hook (synchronous, for the bridge interceptor):
   * the owner's reply in a mapped thread goes to the app comment instead of
   * the normal routing.
   *
   * @returns True when the message was consumed
   */
  interceptInbound(message: InboundSlackMessage): boolean {
    if (this.off() || !message.threadTs || message.threadTs === message.ts) return false;
    if (message.authorAgentSession || !message.userId) return false;
    const link = this.byThread.get(`${message.channelId}:${message.threadTs}`);
    if (!link) return false;
    if (!this.deps.isOwner(message.userId)) return false;
    const text = (message.text ?? '').trim();
    if (!text) return false;
    if (this.seenInbound.has(message.ts)) return true; // Slack redelivery
    this.seenInbound.add(message.ts);
    if (this.seenInbound.size > 200) this.seenInbound.delete(this.seenInbound.values().next().value as string);
    const userId = message.userId;
    // A room-owned thread: the reply is the room's too. Relay it to the app,
    // and let the normal room routing deliver it (not consumed here).
    if (link.room) {
      void this.enqueue(async () => {
        try {
          await this.deps.relayOwnerReply(link.appId, link.commentId, text.slice(0, CREWLY_APPS_CONSTANTS.COMMENTS.MAX_BODY_CHARS), userId);
          this.log('info', 'Slack room thread reply added to the app comment', { appId: link.appId, commentId: link.commentId, room: link.room?.name });
        } catch (err) {
          this.log('warn', 'Slack room thread reply could not be added to the app comment', { appId: link.appId, error: err instanceof Error ? err.message : String(err) });
        }
      });
      return false;
    }
    void this.enqueue(async () => {
      try {
        await this.deps.relayOwnerReply(link.appId, link.commentId, text.slice(0, CREWLY_APPS_CONSTANTS.COMMENTS.MAX_BODY_CHARS), userId);
        this.log('info', 'Slack thread reply added to the app comment', { appId: link.appId, commentId: link.commentId });
      } catch (err) {
        this.log('warn', 'Slack thread reply could not be added to the app comment', { appId: link.appId, error: err instanceof Error ? err.message : String(err) });
        await this.postIn(link, "⚠️ I couldn't add that reply to the comment in the app. Please reply there instead.");
      }
    });
    // The owner was answered by the comment path: nothing is owed in this thread.
    this.deps.noteHandled?.(message.channelId, message.threadTs);
    setTimeout(() => this.deps.noteHandled?.(message.channelId, message.threadTs as string), 1500).unref?.();
    return true;
  }
}
