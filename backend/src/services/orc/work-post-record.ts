/**
 * Chat-history record of an agent's work-destination Slack post (CREW-877).
 *
 * `reply --work-item` / `--new-thread` / `--ticket` post straight to Slack
 * (SlackAgentPostService, which turns the chat mirror off) and used to leave no
 * chat row, so `search-chat` could not find them: a team lead read the empty
 * result as "the worker's reply failed" and posted the answer again. This files
 * a quiet row for such a post, attributed to the posting agent, in the chat
 * channel its Slack channel maps to. See ChatV2Service.recordSlackOnlyAgentPost
 * for why the write emits nothing.
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { parseSlackThreadKey } from '../slack/slack-thread-key.js';

/** One Slack post an agent just made. */
export interface WorkPostRecordInput {
  /** The posting agent's session */
  agentSession: string;
  /** Slack channel the post is in */
  slackChannelId: string;
  /** The post's own Slack ts */
  messageTs: string;
  /** Thread the post is in (a Slack ts or a `<channel>:<ts>` key), when threaded */
  threadTs?: string;
  /** What was posted */
  text: string;
}

/** Collaborators of {@link recordWorkPost}. */
export interface WorkPostRecordDeps {
  /** The chat channel a Slack channel maps to (team room or agent DM), or null when it has none */
  chatChannelOf(slackChannelId: string): string | null;
  /** File the row quietly; the stored id, or null when a row for that Slack message already existed */
  record(input: { channelId: string; agentSession: string; content: string; slackChannelId: string; slackTs: string; slackThreadTs?: string }): string | null;
}

/** What happened to the record. */
export type WorkPostRecordResult = { recorded: true; messageId: string } | { recorded: false; reason: string };

/**
 * File an agent's work-destination post in the chat history. Never throws: a
 * failed record must not fail a post that already reached Slack.
 *
 * @param input - The post
 * @param deps - Collaborators (default: the real ones)
 * @returns Whether a row was stored, or why not
 */
export async function recordWorkPost(input: WorkPostRecordInput, deps?: WorkPostRecordDeps): Promise<WorkPostRecordResult> {
  const log: ComponentLogger = LoggerService.getInstance().createComponentLogger('WorkPostRecord');
  try {
    const d = deps ?? (await defaultWorkPostRecordDeps());
    if (!input.slackChannelId || !input.messageTs || !input.text.trim()) return { recorded: false, reason: 'nothing to record (no channel, ts or text)' };
    const channelId = d.chatChannelOf(input.slackChannelId);
    if (!channelId) return { recorded: false, reason: `Slack channel ${input.slackChannelId} has no chat channel (not a team room or agent DM)` };
    const threadTs = input.threadTs ? (parseSlackThreadKey(input.threadTs)?.threadTs ?? input.threadTs) : undefined;
    const messageId = d.record({
      channelId,
      agentSession: input.agentSession,
      content: input.text,
      slackChannelId: input.slackChannelId,
      slackTs: input.messageTs,
      ...(threadTs ? { slackThreadTs: threadTs } : {}),
    });
    return messageId ? { recorded: true, messageId } : { recorded: false, reason: 'a chat row for that Slack message already exists' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn('Could not record a work-destination post in the chat history (the post itself went out)', { agentSession: input.agentSession, slackChannelId: input.slackChannelId, reason });
    return { recorded: false, reason };
  }
}

/**
 * The real collaborators (lazy imports keep this module light for tests).
 *
 * @returns Deps
 */
export async function defaultWorkPostRecordDeps(): Promise<WorkPostRecordDeps> {
  const [{ getChatV2Service }, { getSlackTeamChannelService }, { getSlackAgentDmService }] = await Promise.all([
    import('../chat-v2/chat-v2.singleton.js'),
    import('../slack/slack-team-channel.service.js'),
    import('../slack/slack-agent-dm.service.js'),
  ]);
  const chat = getChatV2Service();
  return {
    chatChannelOf: (slackChannelId) =>
      getSlackTeamChannelService()?.findBySlackChannelId(slackChannelId)?.chatChannelId ??
      getSlackAgentDmService()?.findBySlackChannelId(slackChannelId)?.chatChannelId ??
      null,
    record: (input) => chat.recordSlackOnlyAgentPost(input),
  };
}
