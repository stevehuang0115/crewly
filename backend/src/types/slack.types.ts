/**
 * Slack Integration Types
 *
 * Types for Slack bot integration enabling mobile communication
 * with the Crewly orchestrator.
 *
 * @module types/slack
 */

/**
 * How inbound Slack events reach this instance.
 *
 * - `socket` — the self-hosted app: Bolt opens a Socket Mode connection with
 *   the app token (the original transport).
 * - `cloud` — Crewly Cloud owns the Slack app, receives events over HTTP and
 *   pushes them to this instance as `slack_event` relay messages. No socket
 *   is opened; outbound calls still go straight to the Slack Web API.
 */
export type SlackTransport = 'socket' | 'cloud';

/**
 * Slack bot configuration
 */
export interface SlackConfig {
  /** Bot OAuth token (xoxb-...) */
  botToken: string;
  /** App-level token for Socket Mode (xapp-...). Empty for the cloud transport. */
  appToken: string;
  /** Signing secret for request verification. Empty for the cloud transport. */
  signingSecret: string;
  /** Channel ID for orchestrator notifications */
  defaultChannelId?: string;
  /** Allowed user IDs (empty = all users) */
  allowedUserIds?: string[];
  /** Enable Socket Mode for real-time events */
  socketMode: boolean;
  /** Inbound transport; defaults to `socket` */
  transport?: SlackTransport;
  /** Bot user id (`U…`) when already known (cloud config) — skips `auth.test` */
  botUserId?: string;
}

/**
 * Raw Slack event object as delivered by the Events API / Socket Mode for
 * `message` and `app_mention`. Only the fields the inbound handler reads.
 */
export interface SlackRawInboundEvent {
  /** `message` | `app_mention` (anything else is ignored) */
  type: string;
  ts?: string;
  text?: string;
  user?: string;
  channel?: string;
  thread_ts?: string;
  team?: string;
  event_ts?: string;
  /** Message subtype (`file_share`, `bot_message`, `message_changed`, …) */
  subtype?: string;
  /** `im` | `channel` | `group` | `mpim` on Events API `message` events */
  channel_type?: string;
  /** Set when a bot posted the message */
  bot_id?: string;
  files?: SlackFile[];
}

/** Provenance attached to an inbound event by the transport that received it. */
export interface SlackInboundMeta {
  source: SlackTransport;
  /** Slack `event_id` (cloud transport) */
  eventId?: string;
  /** App the event was delivered to (cloud transport) */
  apiAppId?: string;
  /** Set when the event came through a per-agent app */
  agentSession?: string;
  /** Set when one of the account's agents (possibly on another machine) wrote the message */
  authorAgentSession?: string;
  authorDisplayName?: string;
}

/**
 * `data` of a `slack_event` relay message pushed by Crewly Cloud (contract:
 * Slack v3 events). `event` is the raw Slack event object.
 */
export interface SlackCloudEventEnvelope {
  eventId: string;
  slackTeamId: string;
  apiAppId: string;
  /** `master` = the account's workspace app; `agent` = a per-agent app */
  source: 'master' | 'agent';
  agentSession?: string;
  /** The account's agent that wrote the message (agent-to-agent @-mention), when any */
  authorAgentSession?: string;
  authorDisplayName?: string;
  /** Session names of the account's agents @-mentioned in the text */
  mentionedAgentSessions?: string[];
  event: SlackRawInboundEvent;
  receivedAt: string;
}

/** The master workspace half of `GET /api/cloud/slack/config`. */
export interface SlackCloudWorkspaceConfig {
  slackTeamId: string;
  slackTeamName: string;
  botUserId: string;
  botToken: string;
  appId: string;
  /** Slack user id of the installer (the owner); invited into every channel Crewly creates. */
  installedBy?: string;
}

/** One provisioned + installed per-agent app from `GET /api/cloud/slack/config`. */
export interface SlackCloudAgentConfig {
  agentSession: string;
  teamId?: string;
  botUserId: string;
  botToken: string;
  appId: string;
  displayName: string;
}

/** `GET /api/cloud/slack/config` payload (the Cloud-owned Slack setup). */
export interface SlackCloudConfig {
  workspace: SlackCloudWorkspaceConfig;
  agents: SlackCloudAgentConfig[];
  transport: 'cloud';
}

/** On-disk cache of {@link SlackCloudConfig} (`~/.crewly/slack-cloud-config.json`, 0600). */
export interface SlackCloudConfigFile {
  version: 1;
  fetchedAt: string;
  config: SlackCloudConfig;
}

/** Per-instance Slack settings (`~/.crewly/slack-instance.json`). */
export interface SlackInstanceSettingsFile {
  version: 1;
  /** This instance receives DMs / unmapped channels for the account */
  primary: boolean;
  /** Slack team id this instance serves when the account has several workspaces */
  slackTeamId?: string;
}

/** One workspace on the account, as listed by Cloud (never a token). */
export interface SlackCloudWorkspaceSummary {
  slackTeamId: string;
  slackTeamName: string;
  botUserId?: string;
  installedAt?: string;
  agentIdentities?: number;
}

/** One team as reported to the Cloud instance registry. */
export interface SlackRegistryTeam {
  teamId: string;
  name: string;
  /** Slack channel id when the team has one */
  channelId?: string;
  /** Member session names (orchestrator excluded) */
  agents: string[];
}

/** Body of `PUT /api/cloud/slack/instances/:instanceId`. */
export interface SlackInstanceRegistryPayload {
  deviceName: string;
  relayQueueId: string;
  primary?: boolean;
  /** Workspace this instance serves (omitted = keep Cloud's binding) */
  slackTeamId?: string;
  teams: SlackRegistryTeam[];
  crewlyVersion: string;
}

/** Body of `POST /api/cloud/slack/agents/sync`. */
export interface SlackAgentsSyncPayload {
  teams: Array<{
    teamId: string;
    name: string;
    agents: Array<{ agentSession: string; displayName: string; avatar?: string }>;
  }>;
  /** Delete the apps of agents that left one of these teams. */
  prune?: boolean;
}

/** One agent still waiting for its one-time install click. */
export interface SlackPendingInstall {
  agentSession: string;
  url: string;
}

/** Response of `POST /api/cloud/slack/agents/sync`. */
export interface SlackAgentsSyncResult {
  installUrls: SlackPendingInstall[];
}

/**
 * Slack user information
 */
export interface SlackUser {
  id: string;
  name: string;
  realName?: string;
  email?: string;
  isAdmin?: boolean;
  isOwner?: boolean;
  teamId: string;
}

/**
 * Slack channel information
 */
export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isIm: boolean; // Direct message
  isMpim: boolean; // Multi-party IM
}

/**
 * Slack file object from event payload.
 * Represents a file attached to a Slack message, including download URLs
 * and optional thumbnail/dimension metadata for images.
 */
export interface SlackFile {
  /** Slack file ID (e.g., F0123ABC456) */
  id: string;
  /** Original file name */
  name: string;
  /** MIME type (e.g., image/png) */
  mimetype: string;
  /** Slack file type identifier (e.g., png, jpg) */
  filetype: string;
  /** File size in bytes */
  size: number;
  /** Private URL requiring Bearer token to download */
  url_private: string;
  /** Private download URL requiring Bearer token */
  url_private_download: string;
  /** Optional 360px thumbnail URL */
  thumb_360?: string;
  /** Original image width in pixels */
  original_w?: number;
  /** Original image height in pixels */
  original_h?: number;
  /** Permalink to view the file in Slack */
  permalink: string;
}

/**
 * Downloaded image info with local file path.
 * Created after successfully downloading a SlackFile to the local filesystem.
 */
export interface SlackImageInfo {
  /** Slack file ID */
  id: string;
  /** Original file name */
  name: string;
  /** MIME type of the image */
  mimetype: string;
  /** Absolute path to the downloaded file on disk */
  localPath: string;
  /** Image width in pixels (from Slack metadata) */
  width?: number;
  /** Image height in pixels (from Slack metadata) */
  height?: number;
  /** Permalink to the original file in Slack */
  permalink: string;
}

/**
 * Downloaded non-image file info with local file path.
 * Created after successfully downloading a non-image SlackFile to the local filesystem.
 */
export interface SlackFileInfo {
  /** Slack file ID */
  id: string;
  /** Original file name */
  name: string;
  /** MIME type of the file */
  mimetype: string;
  /** Absolute path to the downloaded file on disk */
  localPath: string;
  /** File size in bytes */
  size: number;
  /** Permalink to the original file in Slack */
  permalink: string;
  /** Extracted text content (for PDFs and text-based files) */
  extractedText?: string;
}

/**
 * Incoming Slack message
 */
export interface SlackIncomingMessage {
  id: string;
  type: 'message' | 'app_mention' | 'command';
  text: string;
  userId: string;
  channelId: string;
  threadTs?: string; // Thread timestamp for replies
  ts: string; // Message timestamp
  teamId: string;
  eventTs: string;
  user?: SlackUser;
  channel?: SlackChannel;
  /** Raw Slack file objects from the event payload */
  files?: SlackFile[];
  /** Downloaded image info with local paths (populated after download) */
  images?: SlackImageInfo[];
  /** Whether the message contains image attachments */
  hasImages?: boolean;
  /** Downloaded non-image file info with local paths (populated after download) */
  attachments?: SlackFileInfo[];
  /** Whether the message has any file attachments (images or other) */
  hasFiles?: boolean;
  /** Transport that delivered the event (`socket` when omitted) */
  source?: SlackTransport;
  /** Slack `event_id` when known (cloud transport) */
  eventId?: string;
  /** Agent whose per-agent app received the event (cloud transport) */
  agentSession?: string;
  /** Agent (on any machine of the account) that wrote the message, when a bot did */
  authorAgentSession?: string;
  authorDisplayName?: string;
}

/**
 * Outgoing Slack message
 */
export interface SlackOutgoingMessage {
  channelId: string;
  text: string;
  threadTs?: string; // Reply in thread
  blocks?: SlackBlock[];
  attachments?: SlackAttachment[];
  unfurlLinks?: boolean;
  unfurlMedia?: boolean;
  /**
   * Per-message display name (requires the `chat:write.customize` scope).
   * Used by Slack team channels so each agent posts under its own name.
   */
  username?: string;
  /** Per-message icon as a Slack emoji name, e.g. `:robot_face:`. */
  iconEmoji?: string;
  /** Per-message icon as an image URL. Ignored when `iconEmoji` is set. */
  iconUrl?: string;
  /**
   * Post as a different bot user: the agent's own Slack app token (Slack
   * agent identities). When set, `username`/icon are ignored — the message
   * already carries a real identity.
   */
  botToken?: string;
  /**
   * Skip the best-effort mirror of this reply into the `slack-<channel>-<ts>`
   * chat-v2 channel. Set by callers that already persisted the message in
   * chat-v2 under a different channel (team-channel outbound mirror), so the
   * same reply is not stored twice.
   */
  skipChatV2Mirror?: boolean;
}

/**
 * One Crewly team bound to one Slack channel (and the chat-v2 huddle that
 * backs it). Persisted in `~/.crewly/slack-team-channels.json`.
 */
export interface SlackTeamChannelMapping {
  /** Crewly team id */
  teamId: string;
  /** Slack channel id (C…) */
  slackChannelId: string;
  /** Slack channel name without the leading `#`, as last known */
  slackChannelName: string;
  /** chat-v2 huddle id that receives the channel's messages */
  chatChannelId: string;
  /** ISO timestamp the mapping was created */
  createdAt: string;
  /** True when Crewly created the Slack channel (vs. linked an existing one) */
  autoCreated: boolean;
}

/**
 * On-disk shape of the team-channel mapping store.
 */
export interface SlackTeamChannelsFile {
  version: 1;
  /** Create a Slack channel + huddle automatically for every new team */
  autoCreate: boolean;
  /** Optional prefix for auto-created channel names (e.g. `crew-`) */
  channelPrefix: string;
  mappings: SlackTeamChannelMapping[];
}

/**
 * Minimal Slack channel descriptor returned by the conversations API helpers.
 */
export interface SlackChannelInfo {
  id: string;
  name: string;
  isArchived: boolean;
  isPrivate: boolean;
}

/**
 * Slack Block Kit block types
 */
export type SlackBlockType =
  | 'section'
  | 'divider'
  | 'header'
  | 'context'
  | 'actions'
  | 'image';

/**
 * Slack Block Kit block
 */
export interface SlackBlock {
  type: SlackBlockType;
  text?: SlackTextObject;
  fields?: SlackTextObject[];
  accessory?: SlackAccessory;
  elements?: SlackElement[];
  block_id?: string;
}

/**
 * Slack text object (mrkdwn or plain_text)
 */
export interface SlackTextObject {
  type: 'mrkdwn' | 'plain_text';
  text: string;
  emoji?: boolean;
  verbatim?: boolean;
}

/**
 * Slack accessory element
 */
export interface SlackAccessory {
  type: 'button' | 'image' | 'overflow' | 'datepicker' | 'static_select';
  action_id?: string;
  text?: SlackTextObject;
  value?: string;
  url?: string;
  image_url?: string;
  alt_text?: string;
}

/**
 * Slack interactive element
 */
export interface SlackElement {
  type: string;
  action_id?: string;
  text?: SlackTextObject;
  value?: string;
  [key: string]: unknown;
}

/**
 * Slack attachment (legacy but still useful)
 */
export interface SlackAttachment {
  color?: string;
  fallback?: string;
  title?: string;
  title_link?: string;
  text?: string;
  fields?: SlackAttachmentField[];
  footer?: string;
  footer_icon?: string;
  ts?: number;
}

/**
 * Slack attachment field
 */
export interface SlackAttachmentField {
  title: string;
  value: string;
  short?: boolean;
}

/**
 * Slack slash command payload
 */
export interface SlackSlashCommand {
  command: string;
  text: string;
  responseUrl: string;
  triggerId: string;
  userId: string;
  userName: string;
  channelId: string;
  channelName: string;
  teamId: string;
  teamDomain: string;
}

/**
 * Slack event types we handle
 */
export type SlackEventType =
  | 'message'
  | 'app_mention'
  | 'app_home_opened'
  | 'member_joined_channel'
  | 'reaction_added';

/**
 * Slack event wrapper
 */
export interface SlackEvent<T = unknown> {
  type: SlackEventType;
  eventTs: string;
  user?: string;
  channel?: string;
  ts?: string;
  payload: T;
}

/**
 * Message routing destination
 */
export type MessageDestination =
  | { type: 'orchestrator' }
  | { type: 'agent'; agentId: string }
  | { type: 'team'; teamId: string }
  | { type: 'project'; projectId: string };

/**
 * Parsed command from Slack message
 */
export interface ParsedSlackCommand {
  intent: SlackCommandIntent;
  target?: MessageDestination;
  parameters: Record<string, string>;
  rawText: string;
}

/**
 * Recognized command intents
 */
export type SlackCommandIntent =
  | 'status' // Get status of projects/teams/agents
  | 'assign' // Assign task to agent/team
  | 'create_task' // Create a new task
  | 'create_project' // Create a new project
  | 'list_projects' // List all projects
  | 'list_teams' // List all teams
  | 'list_agents' // List all agents
  | 'pause' // Pause agent/team
  | 'resume' // Resume agent/team
  | 'help' // Show help
  | 'conversation' // General conversation with orchestrator
  | 'unknown'; // Unrecognized command

/**
 * Slack notification types
 */
export type SlackNotificationType =
  | 'task_completed'
  | 'task_failed'
  | 'task_blocked'
  | 'agent_error'
  | 'agent_question' // Agent needs clarification
  | 'project_update'
  | 'daily_summary'
  | 'okr_reminder' // OKR follow-up reminder
  | 'alert';

/**
 * Slack notification payload
 */
export interface SlackNotification {
  type: SlackNotificationType;
  title: string;
  message: string;
  urgency: 'low' | 'normal' | 'high' | 'critical';
  metadata?: {
    projectId?: string;
    teamId?: string;
    agentId?: string;
    taskId?: string;
    missionId?: string;
    offTrack?: number;
    atRisk?: number;
    errorDetails?: string;
  };
  timestamp: string;
  /** Reply in this Slack thread instead of top-level */
  threadTs?: string;
  /** Post to this channel (fallback: defaultChannelId) */
  channelId?: string;
}

/**
 * Conversation thread context
 */
export interface SlackConversationContext {
  threadTs: string;
  channelId: string;
  userId: string;
  conversationId: string; // Maps to chat conversation
  startedAt: string;
  lastActivityAt: string;
  messageCount: number;
}

/**
 * Slack service status
 */
export interface SlackServiceStatus {
  connected: boolean;
  socketMode: boolean;
  lastEventAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  messagesSent: number;
  messagesReceived: number;
}

/**
 * Valid notification urgency levels
 */
export const NOTIFICATION_URGENCIES = ['low', 'normal', 'high', 'critical'] as const;

/**
 * Command intent patterns for parsing
 */
export const COMMAND_PATTERNS: Record<SlackCommandIntent, RegExp[]> = {
  status: [
    /^(what('s| is) the )?status/i,
    /^how('s| is| are)/i,
    /^(show|get|check) (me )?(the )?(status|progress)/i,
  ],
  assign: [/^assign/i, /^give .+ to/i, /^have .+ (work on|do)/i],
  create_task: [/^create (a )?task/i, /^add (a )?task/i, /^new task/i],
  create_project: [/^create (a )?project/i, /^new project/i, /^start (a )?project/i],
  list_projects: [/^(list|show|get) (all )?(the )?projects/i, /^what projects/i],
  list_teams: [/^(list|show|get) (all )?(the )?teams/i, /^what teams/i],
  list_agents: [/^(list|show|get) (all )?(the )?agents/i, /^who('s| is) (working|available)/i],
  pause: [/^pause/i, /^stop/i, /^hold/i],
  resume: [/^resume/i, /^continue/i, /^start/i, /^unpause/i],
  help: [/^help/i, /^what can you do/i, /^commands/i],
  conversation: [/.*/], // Catch-all for general conversation
  unknown: [],
};

/**
 * Check if user is allowed to interact with the bot
 *
 * @param userId - Slack user ID to check
 * @param config - Slack configuration with allowed users
 * @returns True if user is allowed to interact
 */
export function isUserAllowed(userId: string, config: SlackConfig): boolean {
  if (!config.allowedUserIds || config.allowedUserIds.length === 0) {
    return true; // No restrictions
  }
  return config.allowedUserIds.includes(userId);
}

/**
 * Parse command intent from message text
 *
 * @param text - Message text to parse
 * @returns Detected command intent
 */
export function parseCommandIntent(text: string): SlackCommandIntent {
  const normalizedText = text.trim().toLowerCase();

  for (const [intent, patterns] of Object.entries(COMMAND_PATTERNS)) {
    if (intent === 'conversation' || intent === 'unknown') continue;

    for (const pattern of patterns) {
      if (pattern.test(normalizedText)) {
        return intent as SlackCommandIntent;
      }
    }
  }

  return 'conversation'; // Default to conversation
}

/**
 * One agent's Slack identity as cached by the OSS install
 * (`~/.crewly/slack-agent-identities.json`, mode 0600). Mirrors the Cloud's
 * `SlackAgentView` plus local bookkeeping.
 */
export interface SlackAgentIdentityRecord {
  agentSession: string;
  displayName: string;
  appId: string;
  status: 'pending_install' | 'installed' | 'error';
  botUserId?: string;
  teamId?: string;
  /** The agent's own bot token — never leaves this machine except to Slack. */
  botToken?: string;
  installUrl?: string;
  /** Installed, but the token predates a scope the app now needs; `installUrl` re-authorises it. */
  reinstall?: boolean;
  error?: string;
  /** Slack channel ids where the install link has been announced. */
  announcedIn: string[];
  /** Slack channel ids the bot user has been invited into. */
  invitedTo: string[];
  updatedAt: string;
}

/** On-disk shape of the identity cache. */
export interface SlackAgentIdentitiesFile {
  version: 1;
  identities: SlackAgentIdentityRecord[];
}
