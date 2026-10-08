/**
 * Slack file fetch — get a Slack file by link or id, even one your own bot
 * cannot see.
 *
 * Slack serves a file only to members of a channel it was shared in. An
 * agent asked to work on a colleague's file from another channel, often
 * posted from another machine so the event never reached this one, had no
 * way to open it. Rex asked Ella to "paste the text into the thread"
 * instead (2026-10-08, `longform-en.md` in #pro-crewly-marketing).
 *
 * Order:
 *   1. Locally, with the bot tokens this instance holds: the requesting
 *      agent's own bot, the uploader's bot, bots of agents in the channel,
 *      the workspace bot, then any other installed identity. The first one
 *      `files.info` answers for downloads the file.
 *   2. Otherwise Crewly Cloud (`POST /api/cloud/slack/files/fetch`), which
 *      holds every bot of the account and tries them the same way.
 *
 * Files land in the same directory as inbound Slack attachments
 * (`~/.crewly/tmp/slack-files/<id>-<name>`).
 *
 * @module services/slack/slack-file-fetch
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { SLACK_FILE_DOWNLOAD_CONSTANTS, SLACK_FILE_FETCH_CONSTANTS } from '../../constants.js';
import { isSlackDownloadHost, isTextFile, parseSlackFileRef, type SlackFileRef } from './slack-file-ref.js';

/** Stable failure codes (the route maps them to HTTP statuses). */
export type SlackFileGetErrorCode =
  | 'validation'
  | 'not_visible'
  | 'no_file_in_message'
  | 'file_deleted'
  | 'too_large'
  | 'foreign_workspace'
  | 'cloud_unavailable'
  | 'slack_error';

/** HTTP status per code. */
export const SLACK_FILE_GET_STATUS: Record<SlackFileGetErrorCode, number> = {
  validation: 400,
  not_visible: 404,
  no_file_in_message: 404,
  file_deleted: 410,
  too_large: 413,
  foreign_workspace: 403,
  cloud_unavailable: 503,
  slack_error: 502,
};

/** A failure with a stable code. */
export class SlackFileGetError extends Error {
  constructor(
    public readonly code: SlackFileGetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SlackFileGetError';
  }
}

/** What the caller learns about a fetched file. */
export interface SlackFetchedFileMeta {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  user: string | null;
  channels: string[];
  permalink: string | null;
  isText: boolean;
  /** Who could see it: `local:<session>`, `local:workspace`, or `cloud:<bot>`. */
  via: string;
  /** Other files on the same message (message links). */
  otherFileIds?: string[];
}

/** A fetched file, saved on disk. */
export interface SlackFetchedFile {
  meta: SlackFetchedFileMeta;
  localPath: string;
}

/** One bot token this instance may try. */
export interface LocalTokenCandidate {
  token: string;
  /** For logs and the result: `<session>` or `workspace`. */
  label: string;
}

/** Collaborators (injectable for tests). */
export interface SlackFileFetchDeps {
  /** Local bot tokens in the order to try them. */
  localCandidates: (ref: SlackFileRef, requesterAgent?: string) => LocalTokenCandidate[] | Promise<LocalTokenCandidate[]>;
  /** Cloud base URL and access token; null when not signed in. */
  cloud: () => { baseUrl: string; token: string } | null;
  /** Where files are written. Default `~/.crewly/tmp/slack-files`. */
  saveDir?: string;
  fetchImpl?: typeof fetch;
  slackApiBase?: string;
}

/** A Slack file object as `files.info` / message `files[]` returns it. */
interface RawSlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  user?: string;
  channels?: string[];
  groups?: string[];
  ims?: string[];
  permalink?: string;
  url_private?: string;
  url_private_download?: string;
}

/**
 * The service — see module docs.
 */
export class SlackFileFetchService {
  private readonly logger: ComponentLogger;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly saveDir: string;

  constructor(private readonly deps: SlackFileFetchDeps) {
    this.logger = LoggerService.getInstance().createComponentLogger('SlackFileFetch');
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.apiBase = deps.slackApiBase ?? 'https://slack.com/api';
    this.saveDir = deps.saveDir ?? path.join(os.homedir(), '.crewly', SLACK_FILE_DOWNLOAD_CONSTANTS.TEMP_DIR);
  }

  /**
   * Fetch a file: locally first, then through Cloud.
   *
   * @param fileRef - File id, permalink, download URL or message link
   * @param opts - `requesterAgent` (preferred bot, audit), `maxBytes` (default 25 MB)
   * @returns Metadata and the saved path
   * @throws {SlackFileGetError}
   */
  async get(fileRef: string, opts: { requesterAgent?: string; maxBytes?: number } = {}): Promise<SlackFetchedFile> {
    const ref = parseSlackFileRef(fileRef);
    if (!ref || (!ref.fileId && !ref.messageTs)) {
      throw new SlackFileGetError('validation', 'Not a Slack file reference: pass a file id (F…), a file link, or a message link');
    }
    const maxBytes = Math.min(opts.maxBytes ?? SLACK_FILE_FETCH_CONSTANTS.MAX_BYTES, SLACK_FILE_FETCH_CONSTANTS.MAX_BYTES);

    let localError: SlackFileGetError | null = null;
    try {
      const local = await this.getLocal(ref, opts.requesterAgent, maxBytes);
      if (local) return local;
    } catch (err) {
      if (!(err instanceof SlackFileGetError)) throw err;
      // Final answers: the file is gone, too big, or not a file at all.
      if (err.code === 'file_deleted' || err.code === 'too_large' || err.code === 'validation') throw err;
      localError = err;
    }

    const cloud = this.deps.cloud();
    if (!cloud) {
      throw localError ??
        new SlackFileGetError(
          'not_visible',
          'No bot on this machine can see that file, and this machine is not signed in to Crewly Cloud (which could try the account\'s other bots).',
        );
    }
    return this.getViaCloud(fileRef, cloud, opts.requesterAgent, maxBytes);
  }

  // ---------------------------------------------------------------------------
  // Local
  // ---------------------------------------------------------------------------

  private async getLocal(ref: SlackFileRef, requesterAgent: string | undefined, maxBytes: number): Promise<SlackFetchedFile | null> {
    const candidates = (await this.deps.localCandidates(ref, requesterAgent)).slice(0, SLACK_FILE_FETCH_CONSTANTS.MAX_LOCAL_CANDIDATES);
    if (candidates.length === 0) return null;

    let fileId = ref.fileId;
    let otherFileIds: string[] | undefined;
    if (!fileId) {
      const found = await this.fileFromMessage(candidates, ref);
      if (!found) return null;
      fileId = found.fileId;
      otherFileIds = found.others.length > 0 ? found.others : undefined;
    }

    for (const c of candidates) {
      const info = await this.slack<{ file?: RawSlackFile }>('files.info', c.token, { file: fileId });
      if (info.ok && info.data.file) {
        const file = info.data.file;
        const name = file.name || file.title || fileId;
        const size = typeof file.size === 'number' ? file.size : 0;
        if (size > maxBytes) {
          throw new SlackFileGetError('too_large', `File is ${size} bytes; the limit is ${maxBytes}`);
        }
        const bytes = await this.download(file, c.token, maxBytes);
        const meta: SlackFetchedFileMeta = {
          id: file.id || fileId,
          name,
          mimetype: file.mimetype || 'application/octet-stream',
          size: bytes.length,
          user: file.user ?? null,
          channels: [...(file.channels ?? []), ...(file.groups ?? []), ...(file.ims ?? [])],
          permalink: file.permalink ?? null,
          isText: isTextFile(file.mimetype, name),
          via: `local:${c.label}`,
          ...(otherFileIds ? { otherFileIds } : {}),
        };
        const localPath = await this.save(meta, bytes);
        this.logger.info('Slack file fetched', { fileId: meta.id, via: meta.via, bytes: bytes.length });
        return { meta, localPath };
      }
      if (!info.ok && info.error === 'file_deleted') {
        throw new SlackFileGetError('file_deleted', 'That Slack file was deleted');
      }
    }
    this.logger.debug('No local bot can see the Slack file', { fileId, tried: candidates.length });
    return null;
  }

  private async fileFromMessage(
    candidates: LocalTokenCandidate[],
    ref: SlackFileRef,
  ): Promise<{ fileId: string; others: string[] } | null> {
    const ts = ref.messageTs as string;
    for (const c of candidates) {
      const threaded = !!ref.threadTs && ref.threadTs !== ts;
      const res = await this.slack<{ messages?: Array<{ ts?: string; files?: RawSlackFile[] }> }>(
        threaded ? 'conversations.replies' : 'conversations.history',
        c.token,
        {
          channel: ref.channelId as string,
          ...(threaded ? { ts: ref.threadTs as string } : {}),
          latest: ts,
          oldest: ts,
          inclusive: 'true',
          limit: threaded ? '5' : '1',
        },
      );
      if (!res.ok) continue;
      const message = (res.data.messages ?? []).find((m) => m.ts === ts);
      if (!message) continue;
      const ids = (message.files ?? []).map((f) => f.id).filter((id): id is string => !!id);
      if (ids.length === 0) throw new SlackFileGetError('no_file_in_message', 'That message has no file attached');
      return { fileId: ids[0], others: ids.slice(1) };
    }
    return null;
  }

  private async download(file: RawSlackFile, token: string, maxBytes: number): Promise<Buffer> {
    let url = file.url_private_download || file.url_private;
    if (!url) throw new SlackFileGetError('slack_error', 'Slack returned no download URL for that file');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SLACK_FILE_FETCH_CONSTANTS.DOWNLOAD_TIMEOUT_MS);
    try {
      for (let hop = 0; hop <= SLACK_FILE_FETCH_CONSTANTS.MAX_REDIRECTS; hop++) {
        const target = new URL(url);
        if (target.protocol !== 'https:' || !isSlackDownloadHost(target.hostname)) {
          throw new SlackFileGetError('slack_error', 'Slack redirected the download somewhere unexpected');
        }
        const sendAuth = target.hostname === 'slack.com' || target.hostname.endsWith('.slack.com');
        const response: Response = await this.fetchImpl(url, {
          headers: sendAuth ? { Authorization: `Bearer ${token}` } : {},
          redirect: 'manual',
          signal: controller.signal,
        });
        if (response.status >= 300 && response.status < 400) {
          const location: string | null = response.headers.get('location');
          await response.body?.cancel().catch(() => undefined);
          if (!location) throw new SlackFileGetError('slack_error', 'Slack redirect without a location');
          url = new URL(location, url).toString();
          continue;
        }
        if (!response.ok) throw new SlackFileGetError('slack_error', `Slack download failed with HTTP ${response.status}`);
        const type = (response.headers.get('content-type') ?? '').toLowerCase();
        if (type.startsWith('text/html') && !(file.mimetype ?? '').toLowerCase().startsWith('text/html')) {
          await response.body?.cancel().catch(() => undefined);
          throw new SlackFileGetError('slack_error', 'Slack served a sign-in page instead of the file');
        }
        return await readCapped(response, maxBytes);
      }
      throw new SlackFileGetError('slack_error', 'Too many redirects downloading the file');
    } catch (err) {
      if (err instanceof SlackFileGetError) throw err;
      throw new SlackFileGetError('slack_error', `Download failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // Cloud
  // ---------------------------------------------------------------------------

  private async getViaCloud(
    fileRef: string,
    cloud: { baseUrl: string; token: string },
    requesterAgent: string | undefined,
    maxBytes: number,
  ): Promise<SlackFetchedFile> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SLACK_FILE_FETCH_CONSTANTS.DOWNLOAD_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(`${cloud.baseUrl.replace(/\/$/, '')}${SLACK_FILE_FETCH_CONSTANTS.CLOUD_FETCH_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cloud.token}` },
        body: JSON.stringify({ fileRef, ...(requesterAgent ? { requesterAgent } : {}) }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new SlackFileGetError('cloud_unavailable', `Crewly Cloud did not answer: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { code?: string; error?: string } | null;
        const code = body?.code;
        const known: SlackFileGetErrorCode[] = ['validation', 'not_visible', 'no_file_in_message', 'file_deleted', 'too_large', 'foreign_workspace'];
        if (code && (known as string[]).includes(code)) {
          throw new SlackFileGetError(code as SlackFileGetErrorCode, body?.error ?? code);
        }
        // 404 without a code = a Cloud that does not have this endpoint yet.
        throw new SlackFileGetError('cloud_unavailable', `Crewly Cloud could not fetch the file (HTTP ${response.status}${body?.error ? `: ${body.error}` : ''})`);
      }
      const metaHeader = response.headers.get(SLACK_FILE_FETCH_CONSTANTS.CLOUD_META_HEADER);
      let cloudMeta: Partial<SlackFetchedFileMeta> & { via?: string } = {};
      if (metaHeader) {
        try {
          cloudMeta = JSON.parse(Buffer.from(metaHeader, 'base64url').toString('utf8')) as typeof cloudMeta;
        } catch {
          cloudMeta = {};
        }
      }
      const bytes = await readCapped(response, maxBytes);
      const id = typeof cloudMeta.id === 'string' && /^F[A-Z0-9]+$/.test(cloudMeta.id) ? cloudMeta.id : parseSlackFileRef(fileRef)?.fileId ?? 'file';
      const name = typeof cloudMeta.name === 'string' && cloudMeta.name ? cloudMeta.name : id;
      const mimetype = typeof cloudMeta.mimetype === 'string' && cloudMeta.mimetype ? cloudMeta.mimetype : 'application/octet-stream';
      const meta: SlackFetchedFileMeta = {
        id,
        name,
        mimetype,
        size: bytes.length,
        user: typeof cloudMeta.user === 'string' ? cloudMeta.user : null,
        channels: Array.isArray(cloudMeta.channels) ? cloudMeta.channels.filter((c): c is string => typeof c === 'string') : [],
        permalink: typeof cloudMeta.permalink === 'string' ? cloudMeta.permalink : null,
        isText: isTextFile(mimetype, name),
        via: `cloud:${typeof cloudMeta.via === 'string' ? cloudMeta.via : 'unknown'}`,
        ...(Array.isArray(cloudMeta.otherFileIds) ? { otherFileIds: cloudMeta.otherFileIds.filter((c): c is string => typeof c === 'string') } : {}),
      };
      const localPath = await this.save(meta, bytes);
      this.logger.info('Slack file fetched through Cloud', { fileId: meta.id, via: meta.via, bytes: bytes.length });
      return { meta, localPath };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async save(meta: SlackFetchedFileMeta, bytes: Buffer): Promise<string> {
    await fs.mkdir(this.saveDir, { recursive: true });
    const safeName = path.basename(meta.name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
    const safeId = meta.id.replace(/[^A-Za-z0-9]/g, '');
    const localPath = path.join(this.saveDir, `${safeId}-${safeName}`);
    await fs.writeFile(localPath, bytes);
    return localPath;
  }

  private async slack<T>(
    method: string,
    token: string,
    params: Record<string, string>,
  ): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SLACK_FILE_FETCH_CONSTANTS.API_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${this.apiBase}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${token}` },
        body: new URLSearchParams(params),
        signal: controller.signal,
      });
      const body = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string } & T) | null;
      if (!body || body.ok !== true) return { ok: false, error: body?.error ?? `http_${res.status}` };
      return { ok: true, data: body };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Read a response body, refusing more than `maxBytes`.
 *
 * @param response - Fetch response
 * @param maxBytes - Cap
 * @returns The bytes
 * @throws {SlackFileGetError} `too_large`
 */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new SlackFileGetError('too_large', `File is ${declared} bytes; the limit is ${maxBytes}`);
  }
  if (!response.body) return Buffer.from(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SlackFileGetError('too_large', `File is over the ${maxBytes}-byte limit`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * The first lines of a text file, for a one-glance preview.
 *
 * @param localPath - Saved file
 * @returns Up to PREVIEW_LINES lines / PREVIEW_CHARS characters
 */
export async function previewTextFile(localPath: string): Promise<string> {
  const text = await fs.readFile(localPath, 'utf8');
  const lines = text.split('\n').slice(0, SLACK_FILE_FETCH_CONSTANTS.PREVIEW_LINES).join('\n');
  return lines.length > SLACK_FILE_FETCH_CONSTANTS.PREVIEW_CHARS ? `${lines.slice(0, SLACK_FILE_FETCH_CONSTANTS.PREVIEW_CHARS)}…` : lines;
}

let instance: SlackFileFetchService | null = null;

/**
 * The process-wide service, wired to this instance's Slack identities and
 * Cloud sign-in. Built on first use.
 *
 * @returns The service
 */
export async function getSlackFileFetchService(): Promise<SlackFileFetchService> {
  if (instance) return instance;
  const { getSlackService } = await import('./slack.service.js');
  const { getSlackAgentIdentityService } = await import('./slack-agent-identity.service.js');
  const { getSlackTeamChannelService } = await import('./slack-team-channel.service.js');
  const { CloudClientService } = await import('../cloud/cloud-client.service.js');
  instance = new SlackFileFetchService({
    localCandidates: async (ref, requesterAgent) => {
      const identities = getSlackAgentIdentityService();
      const out: LocalTokenCandidate[] = [];
      const push = (token: string | null | undefined, label: string): void => {
        if (token && !out.some((c) => c.token === token)) out.push({ token, label });
      };
      const tokenOf = (session: string | null | undefined): string | undefined =>
        session ? identities?.getInstalled(session)?.botToken ?? undefined : undefined;
      if (requesterAgent) push(tokenOf(requesterAgent), requesterAgent);
      if (ref.uploaderUserId) {
        const uploader = identities?.findByBotUserId(ref.uploaderUserId) ?? null;
        if (uploader) push(tokenOf(uploader), uploader);
      }
      if (ref.channelId) {
        for (const session of getSlackTeamChannelService()?.rosterSessions(ref.channelId) ?? []) push(tokenOf(session), session);
      }
      push(getSlackService().getBotToken(), 'workspace');
      for (const r of (await identities?.list().catch(() => [])) ?? []) {
        if (r.status === 'installed' && r.botToken) push(r.botToken, r.agentSession);
      }
      return out;
    },
    cloud: () => {
      const cloud = CloudClientService.getInstance();
      const token = cloud.getToken();
      const baseUrl = cloud.getCloudUrl();
      return token && baseUrl ? { baseUrl, token } : null;
    },
  });
  return instance;
}

/** Replace the process-wide service (tests). */
export function setSlackFileFetchService(service: SlackFileFetchService | null): void {
  instance = service;
}
