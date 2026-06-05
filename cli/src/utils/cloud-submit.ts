/**
 * Cloud Submit Utility
 *
 * Submits a skill to Crewly Cloud, which opens a PR to the marketplace repo on
 * the user's behalf using a server-side bot token. Unlike `submitToGitHub`
 * (which requires the user's own `gh` CLI + GitHub account), this path only
 * needs the user to be logged in to Crewly Cloud (`crewly cloud login`).
 *
 * The skill's files are read from disk, base64-encoded, and POSTed to the cloud
 * `POST /api/registry/submit` endpoint with the user's cloud JWT. The server
 * authenticates, rate-limits, validates, and opens/updates the PR.
 *
 * @module cli/utils/cloud-submit
 */

import path from 'path';
import { homedir } from 'os';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import axios from 'axios';
import type { SkillManifest } from './package-validator.js';

/** Path to the cloud credentials written by `crewly cloud login`. */
const CLOUD_CONFIG_FILE = path.join(homedir(), '.crewly', 'cloud', 'config.json');

/** Cloud submission endpoint (relative to the cloud base URL). */
const SUBMIT_ENDPOINT = '/api/registry/submit';

/** Default cloud base URL when the saved config lacks one. */
const DEFAULT_CLOUD_URL = process.env['CREWLY_CLOUD_URL'] || 'https://api.crewlyai.com';

/** Client-side guard mirroring the server's 2 MiB total-size cap. */
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

/** Directories never included in a submission. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store']);

/** Result returned by the cloud submit endpoint. */
export interface CloudSubmitResult {
  /** URL of the opened/updated pull request. */
  prUrl: string;
  /** Branch used (`skill/<id>`). */
  branch: string;
  /** True when an existing PR was updated rather than newly opened. */
  updated: boolean;
}

/** A single file payload entry sent to the cloud. */
export interface CloudSubmitFile {
  /** Path relative to the skill directory, forward-slashed. */
  path: string;
  /** File contents, base64-encoded. */
  contentBase64: string;
  /** Whether the file carries the executable bit. */
  executable: boolean;
}

/** Loaded cloud credentials. */
interface CloudToken {
  token: string;
  cloudUrl: string;
}

/**
 * Load the cloud token saved by `crewly cloud login`.
 *
 * @returns The token and cloud base URL, or null if not logged in.
 */
export function loadCloudToken(): CloudToken | null {
  if (!existsSync(CLOUD_CONFIG_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(CLOUD_CONFIG_FILE, 'utf-8')) as {
      token?: string;
      cloudUrl?: string;
    };
    if (!raw.token) return null;
    return { token: raw.token, cloudUrl: raw.cloudUrl || DEFAULT_CLOUD_URL };
  } catch {
    return null;
  }
}

/**
 * Recursively collect a skill directory's files as base64 payload entries.
 *
 * Skips VCS/dependency dirs. The executable bit is set for files with a Unix
 * exec mode or a `.sh` extension. Enforces the total-size cap client-side so a
 * too-large submission fails fast before hitting the network.
 *
 * @param skillDir - Absolute path to the skill directory.
 * @returns The collected files (paths relative to `skillDir`, forward-slashed).
 * @throws Error if the collected files exceed the size cap.
 */
export function collectSkillFiles(skillDir: string): CloudSubmitFile[] {
  const out: CloudSubmitFile[] = [];
  let total = 0;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;

      const data = readFileSync(abs);
      total += data.length;
      if (total > MAX_TOTAL_BYTES) {
        throw new Error(`Skill exceeds the ${MAX_TOTAL_BYTES}-byte size limit`);
      }
      const rel = path.relative(skillDir, abs).split(path.sep).join('/');
      const mode = statSync(abs).mode;
      out.push({
        path: rel,
        contentBase64: data.toString('base64'),
        executable: (mode & 0o111) !== 0 || rel.endsWith('.sh'),
      });
    }
  };

  walk(skillDir);
  return out;
}

/**
 * Submit a skill to Crewly Cloud, which opens/updates the marketplace PR.
 *
 * @param skillDir - Absolute path to the validated skill directory.
 * @param manifest - Parsed skill.json.
 * @returns The PR result from the cloud.
 * @throws Error with a user-actionable message on auth failure (not logged in /
 *   expired), rate limiting (429), server misconfiguration (503), or network errors.
 */
export async function submitToCloud(
  skillDir: string,
  manifest: SkillManifest,
): Promise<CloudSubmitResult> {
  const creds = loadCloudToken();
  if (!creds) {
    throw new Error('Not logged in to Crewly Cloud. Run `crewly cloud login` first.');
  }

  const files = collectSkillFiles(skillDir);

  try {
    const res = await axios.post(
      `${creds.cloudUrl}${SUBMIT_ENDPOINT}`,
      {
        manifest: {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          category: manifest.category,
          description: manifest.description,
          author: manifest.author,
        },
        files,
      },
      {
        headers: { Authorization: `Bearer ${creds.token}` },
        timeout: 30_000,
      },
    );
    return res.data as CloudSubmitResult;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      const { status, data } = err.response;
      const serverMsg = (data as { error?: string })?.error || err.message;
      if (status === 401) {
        throw new Error('Cloud session expired or invalid. Run `crewly cloud login` again.');
      }
      if (status === 429) {
        const retry = err.response.headers?.['retry-after'];
        throw new Error(
          `Rate limited: ${serverMsg}${retry ? ` (retry after ${retry}s)` : ''}`,
        );
      }
      if (status === 503) {
        throw new Error(`Cloud submission unavailable: ${serverMsg}`);
      }
      throw new Error(`Cloud submission failed (${status}): ${serverMsg}`);
    }
    throw new Error(
      `Could not reach Crewly Cloud: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
