/**
 * Crewly channels — named rooms whose members are agents from any team.
 *
 * A Crewly channel is a chat-v2 huddle (so dispatch, threads and replies work
 * exactly as in every other multi-agent room) plus a registry row that names
 * it and, when Slack is connected, links it to one Slack channel.
 *
 * The channel id IS the chat-v2 huddle id. It is stable for the channel's
 * whole life — renames, Slack link changes and member changes keep it — so
 * other records (Crewly Apps owned by a channel, step 2) store it as their
 * `ownerChannelId`.
 *
 * Membership is not duplicated here: the huddle roster
 * (`chat_channel_members`) is the source of truth, and for a channel linked
 * to Slack the ad-hoc mapping in `slack-team-channels.json` mirrors it.
 *
 * @module types/crewly-channel.types
 */

/** Where a channel came from. */
export type CrewlyChannelOrigin = 'crewly' | 'slack';

/** One registry row, as stored in `~/.crewly/crewly-channels.json`. */
export interface CrewlyChannelRecord {
  /** chat-v2 huddle id — the channel's stable id */
  id: string;
  /** Display name, without `#`. Equals the Slack channel name when linked. */
  name: string;
  /** Optional purpose line */
  purpose?: string;
  /** Linked Slack channel id (C…/G…), when any */
  slackChannelId?: string;
  /** `crewly` = the owner created it in Crewly; `slack` = found in Slack */
  origin: CrewlyChannelOrigin;
  /** ISO creation time */
  createdAt: string;
  /** ISO archive time; archived channels are hidden from lists by default */
  archivedAt?: string;
}

/** On-disk shape of the registry. */
export interface CrewlyChannelsFile {
  version: 1;
  channels: CrewlyChannelRecord[];
}

/** A channel member as returned over REST. */
export interface CrewlyChannelMember {
  /** Agent session name */
  sessionName: string;
  /** Agent display name, when the agent is known locally */
  name?: string;
  /** Team the agent belongs to, when known */
  teamId?: string;
  /** That team's name */
  teamName?: string;
}

/** A channel as returned over REST and to skills. */
export interface CrewlyChannelDTO {
  /** Stable id (the chat-v2 huddle id) — reference this, not the name */
  id: string;
  name: string;
  purpose?: string;
  origin: CrewlyChannelOrigin;
  createdAt: string;
  archivedAt?: string;
  /** Linked Slack channel, when any */
  slack: { channelId: string; channelName: string } | null;
  members: CrewlyChannelMember[];
}

/**
 * Type guard for a persisted registry row.
 *
 * @param value - Anything read from disk
 * @returns True when it has the required fields with the right types
 */
export function isCrewlyChannelRecord(value: unknown): value is CrewlyChannelRecord {
  const v = value as Partial<CrewlyChannelRecord> | null;
  return (
    !!v &&
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.name === 'string' &&
    (v.origin === 'crewly' || v.origin === 'slack') &&
    typeof v.createdAt === 'string' &&
    (v.slackChannelId === undefined || typeof v.slackChannelId === 'string')
  );
}
