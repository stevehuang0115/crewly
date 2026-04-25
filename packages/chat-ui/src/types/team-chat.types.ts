/**
 * Type contracts for the Slack-like multi-team chat surfaces.
 *
 * These types describe the WorkspaceRail / ConversationListPanel /
 * MentionComposer components added in Phase B (Leo, 2026-04-25). They
 * are intentionally separate from `chat.types` so:
 *
 *  1. The wire-protocol shapes used by the existing Channel/Message API
 *     stay focused on a single agent ↔ user channel binding.
 *  2. The Slack-like UI surfaces evolve independently of the chat
 *     transport contract — Phase A backend work (Sam) will populate
 *     these shapes from `Team`, `ChatConversation` and the agent
 *     directory; the UI does not assume a specific BE schema yet.
 *
 * Phase B uses mock data shaped to these interfaces so the FE shell
 * can render and accept review before the BE migration ships
 * (target 2026-04-27 EOD, per TL Sam).
 *
 * @module types/team-chat
 */

import type { ChatPresenceStatus } from '../components/AgentStatusBadge';

// =============================================================================
// Workspace rail (left panel) — design §6.1, §11.2
// =============================================================================

/**
 * One workspace = one Crewly Team, plus a UX-only `kind` distinguishing
 * the cross-team Activity / All-DMs entry from a real team.
 *
 * `parentId` enables the nested-grouping rule from design §6.1:
 *   "Crewly" folder contains Product, Marketing, etc.
 * Renderers indent or group by `parentId` chains. A workspace with no
 * `parentId` is a root.
 */
export interface Workspace {
  id: string;
  /** Display name in expanded mode; first letters used in collapsed mode. */
  name: string;
  /**
   * Optional short label override for the icon-only collapsed mode. If
   * absent, we derive 2-letter initials from `name`.
   */
  initials?: string;
  /**
   * Workspace category. `team` is the default; `activity` is the
   * cross-team unified-inbox entry described in design §4.3.
   */
  kind?: 'team' | 'activity';
  /** Parent workspace id for nested grouping. */
  parentId?: string;
  /** Total unread items in this workspace (channels + dms combined). */
  unreadCount?: number;
  /** True when at least one mention is unread — drives the rail dot color. */
  hasMentions?: boolean;
  /**
   * Aggregate presence summary for the workspace. `online` if any agent
   * is online; `idle` if any is idle and none online; otherwise
   * `inactive`. Computed by the rail renderer's caller.
   */
  presence?: ChatPresenceStatus;
}

// =============================================================================
// Conversation list (center panel) — design §6.1, §11.2
// =============================================================================

/**
 * Discriminator for a conversation row. Renderers pick the icon and
 * heading style off this:
 *  - `channel` — `#name` prefix (project / general)
 *  - `dm`      — avatar + presence dot
 *  - `activity` — system row in the cross-team inbox
 */
export type ConversationKind = 'channel' | 'dm' | 'activity';

/**
 * One row in the ConversationListPanel center surface. The shape is the
 * minimum a Slack-style row needs to render legibly: title, kind, unread
 * + mention counts, last-message preview, and a presence hint for DMs.
 */
export interface ConversationRow {
  id: string;
  kind: ConversationKind;
  /** Display title — `general`, `proj-onboarding`, agent name, etc. */
  title: string;
  /** Optional secondary label such as the team / project tag. */
  subtitle?: string;
  /** Last message text, used as a one-line preview under the title. */
  lastMessagePreview?: string;
  /** ISO timestamp of the last message — drives sort order in the renderer. */
  lastMessageAt?: string;
  /** Total unread messages in this conversation. */
  unreadCount?: number;
  /** Number of unread mentions of the current user — drives count pill. */
  mentionCount?: number;
  /** Presence for DM rows. Undefined for channel/activity rows. */
  presence?: ChatPresenceStatus;
  /**
   * Optional agent session id for DM rows. Lets the renderer pass it
   * through to AgentStatusBadge for live presence subscription.
   */
  agentSession?: string;
}

/**
 * A labelled grouping inside the conversation list — the Slack
 * `Channels` / `Direct Messages` / `Activity` sections.
 */
export interface ConversationGroup {
  /** Stable identifier; renderers may use it as the React key. */
  id: 'channels' | 'dms' | 'activity' | string;
  /** Section heading copy, e.g. "Direct Messages". */
  label: string;
  rows: ConversationRow[];
}

// =============================================================================
// Mention composer (chip / suggestion) — design §7
// =============================================================================

/**
 * Discriminator for a mention chip / suggestion. Drives chip iconography
 * and the helper-text routing hint.
 */
export type MentionKind = 'team' | 'agent';

/**
 * One selectable target in the @-mention suggestion popover.
 *
 * Phase B does NOT route mentions — this is a UX shell. Phase C wires
 * `team` → TL resolver and `agent` → direct ping (per design §2.1).
 */
export interface MentionTarget {
  id: string;
  kind: MentionKind;
  /** Display label rendered inside the chip and the suggestion row. */
  label: string;
  /** One-line routing hint shown next to the row in the popover. */
  routingHint?: string;
  /** Presence for agent rows. Undefined for team rows. */
  presence?: ChatPresenceStatus;
  /** Optional agent session id for agent rows (passes to chip metadata). */
  agentSession?: string;
}
