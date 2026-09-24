/**
 * Slack Source Preference — which Slack app this instance last connected with.
 *
 * An instance can hold both a self-hosted Slack app (env vars or
 * `slack-credentials.json`) and a Crewly Cloud-owned workspace. They are
 * different bot users, so channel membership does not carry over: switching
 * from one to the other breaks every outbound post with `channel_not_found`.
 * Boot therefore must not flip between them on its own (#753).
 *
 * This module records the source of the last successful connection at
 * `<CREWLY_HOME>/slack-source.json`. Boot precedence in `auto` mode reads it:
 * the recorded source wins when both exist, and with no record the
 * explicitly configured self-hosted app wins. An owner switches sources by
 * connecting the other one (`/api/slack/connect`, Cloud "Connect Slack",
 * `PUT /api/slack/source`) or by setting `CREWLY_SLACK_SOURCE`.
 *
 * @module services/slack/slack-source-preference.service
 */

import * as path from 'path';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { SLACK_CLOUD_CONSTANTS } from '../../constants.js';

/** A Slack token source. */
export type SlackSourceName = 'env' | 'cloud';

/** The persisted record. */
export interface SlackSourcePreference {
  /** Source of the last successful connection. */
  source: SlackSourceName;
  /** When it was recorded (ISO). */
  recordedAt: string;
  /** Why it was recorded (e.g. `boot`, `connect-route`, `owner-choice`, `fallback`). */
  reason: string;
}

/**
 * Where the preference lives.
 *
 * @returns Absolute path under CREWLY_HOME
 */
export function getSlackSourcePreferencePath(): string {
  return path.join(getCrewlyHomePath(), SLACK_CLOUD_CONSTANTS.SOURCE_PREFERENCE_FILENAME);
}

/**
 * Whether a value is a Slack source name.
 *
 * @param value - Anything
 * @returns True for `env` / `cloud`
 */
export function isSlackSourceName(value: unknown): value is SlackSourceName {
  return value === 'env' || value === 'cloud';
}

/**
 * Read the recorded source. A missing or malformed file reads as null.
 *
 * @param filePath - Override for tests
 * @returns The preference, or null when none was recorded
 */
export async function loadSlackSourcePreference(
  filePath: string = getSlackSourcePreferencePath(),
): Promise<SlackSourcePreference | null> {
  const raw = await safeReadJson<Partial<SlackSourcePreference> | null>(filePath, null);
  if (!raw || !isSlackSourceName(raw.source)) return null;
  return {
    source: raw.source,
    recordedAt: typeof raw.recordedAt === 'string' ? raw.recordedAt : '',
    reason: typeof raw.reason === 'string' ? raw.reason : '',
  };
}

/**
 * Record the source of a successful connection.
 *
 * @param source - `env` or `cloud`
 * @param reason - Short tag describing what triggered it
 * @param filePath - Override for tests
 * @returns The record written
 */
export async function saveSlackSourcePreference(
  source: SlackSourceName,
  reason: string,
  filePath: string = getSlackSourcePreferencePath(),
): Promise<SlackSourcePreference> {
  const record: SlackSourcePreference = { source, recordedAt: new Date().toISOString(), reason };
  await atomicWriteJson(filePath, record);
  return record;
}
