/**
 * Cloud config helper for tools that need to talk to api.crewlyai.com.
 *
 * Reads `~/.crewly/cloud/config.json` (the same file the OSS server writes
 * during `crewly login`). Each call re-reads from disk so token refreshes are
 * picked up without process restart.
 *
 * @module services/agent/crewly-agent/cloud-config
 */

import { promises as fs } from 'fs';
import { homedir } from 'os';
import * as path from 'path';

export interface CloudConfig {
  cloudUrl: string;
  token: string;
  tier?: string;
  refreshToken?: string;
}

export const CLOUD_CONFIG_PATH = path.join(homedir(), '.crewly', 'cloud', 'config.json');

export class CloudNotLoggedInError extends Error {
  constructor() {
    super(
      `Crewly Cloud is not connected. Run \`crewly login\` (or open the Crewly desktop app and sign in) to enable cloud-backed tools.`,
    );
    this.name = 'CloudNotLoggedInError';
  }
}

export async function loadCloudConfig(filePath: string = CLOUD_CONFIG_PATH): Promise<CloudConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CloudNotLoggedInError();
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Cloud config at ${filePath} is not valid JSON.`);
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as Record<string, unknown>)['cloudUrl'] !== 'string' ||
    typeof (parsed as Record<string, unknown>)['token'] !== 'string'
  ) {
    throw new CloudNotLoggedInError();
  }

  const cfg = parsed as Record<string, unknown>;
  return {
    cloudUrl: (cfg['cloudUrl'] as string).replace(/\/$/, ''),
    token: cfg['token'] as string,
    tier: typeof cfg['tier'] === 'string' ? (cfg['tier'] as string) : undefined,
    refreshToken: typeof cfg['refreshToken'] === 'string' ? (cfg['refreshToken'] as string) : undefined,
  };
}
