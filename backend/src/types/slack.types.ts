/**
 * Slack Integration Types
 *
 * Types for Slack bot integration enabling mobile communication
 * with the Crewly orchestrator.
 *
 * @module types/slack
 */

/**
 * Slack bot configuration
 */
export interface SlackConfig {
  /** Bot OAuth token (xoxb-...) */
  botToken: string;
  /** App-level token for Socket Mode (xapp-...) */
  appToken: string;
  /** Signing secret for request verification */
  signingSecret: string;
  /** Channel ID for orchestrator notifications */
  defaultChannelId?: string;
  /** Allowed user IDs (empty = all users) */
  allowedUserIds?: string[];
  /** Enable Socket Mode for real-time events */
  socketMode: boolean;
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
