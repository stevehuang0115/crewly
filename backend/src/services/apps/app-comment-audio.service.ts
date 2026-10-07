/**
 * Voice comments on Crewly Apps (crewly-services apps/SPEC.md §16).
 *
 * The owner records audio in the app's comment box; Cloud stores it and puts
 * `attachments: [{ kind: 'audio', blobId, mime, durationMs, size }]` on the
 * comment or reply. When such a comment is delivered — to an agent, to the
 * room (team / channel) that owns the app, or mirrored to Slack — this module
 * downloads the recording to `<CREWLY_HOME>/tmp/app-comment-audio/` (next to
 * Slack's downloaded files) and builds the line that tells the agent where it
 * is and to transcribe it with the transcribe-audio skill, the same way a
 * Slack voice clip reaches an agent.
 *
 * A failed download never blocks delivery: the line then names the command
 * that fetches it (`app-comments --audio <comment id>`).
 *
 * @module services/apps/app-comment-audio.service
 */

import fs from 'fs/promises';
import path from 'path';
import { CREWLY_APPS_CONSTANTS } from '../../constants.js';
import type { AppChange, AppCommentAttachment } from './app-wake-message.js';

const C = CREWLY_APPS_CONSTANTS;
const V = C.VOICE;
const APP_ID_RE = /^[a-z0-9]{10}$/;

export type { AppCommentAttachment };

/** A recording on this machine (or why it is not). */
export interface VoiceFile {
  blobId: string;
  commentId: string;
  durationMs: number;
  mime: string;
  /** Absolute local path, when downloaded */
  path?: string;
  /** Why it could not be downloaded */
  error?: string;
}

/** Recordings of a batch, by blob id. */
export type VoiceFiles = Record<string, VoiceFile>;

/** The Cloud client slice used here. */
export interface VoiceDownloadClient {
  download(path: string, opts: { maxBytes: number; timeoutMs?: number }): Promise<{ data: Buffer; contentType: string }>;
}

/** Constructor dependencies. */
export interface AppCommentAudioDeps {
  client: VoiceDownloadClient;
  /** Crewly home directory */
  homeDir: () => string;
  log?: (level: 'info' | 'warn', msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * "0:42" / "2:05" for a length in milliseconds.
 *
 * @param ms - Milliseconds
 * @returns m:ss
 */
export function formatVoiceClock(ms: unknown): string {
  const total = Math.max(0, Math.floor((typeof ms === 'number' && Number.isFinite(ms) ? ms : 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/** Valid audio attachments of a list (untrusted input). */
function audioOf(list: unknown): Array<Required<Pick<AppCommentAttachment, 'blobId'>> & AppCommentAttachment> {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (a): a is Required<Pick<AppCommentAttachment, 'blobId'>> & AppCommentAttachment =>
      !!a && typeof a === 'object' && (a as AppCommentAttachment).kind === 'audio' && typeof (a as AppCommentAttachment).blobId === 'string' && V.BLOB_ID_PATTERN.test((a as AppCommentAttachment).blobId as string),
  );
}

/**
 * The recordings a comment change is about: the comment's own for a new
 * comment or a reopen, the reply's for a reply.
 *
 * @param change - A comment change (its `thread` as Cloud sent it)
 * @returns Attachments with the comment id
 */
export function voiceAttachmentsOf(change: AppChange): Array<{ commentId: string; attachment: AppCommentAttachment & { blobId: string } }> {
  const info = change.comment;
  const thread = info?.thread;
  if (!info?.id || !thread || !C.COMMENTS.ID_PATTERN.test(info.id)) return [];
  const list = info.op === 'reply' ? (thread.replies ?? []).find((r) => r.id === info.replyId)?.attachments : info.op === 'add' || info.op === 'reopen' ? thread.attachments : undefined;
  return audioOf(list).map((attachment) => ({ commentId: info.id as string, attachment }));
}

/**
 * Every recording in a thread (the comment and all replies).
 *
 * @param thread - The thread
 * @returns Attachments
 */
export function threadVoiceAttachments(thread: { attachments?: unknown; replies?: Array<{ attachments?: unknown }> } | null | undefined): Array<AppCommentAttachment & { blobId: string }> {
  if (!thread) return [];
  return [...audioOf(thread.attachments), ...(thread.replies ?? []).flatMap((r) => audioOf(r.attachments))];
}

/**
 * The lines an agent reads for a comment change's recordings (indented under
 * the comment). Downloaded: the path and the instruction to transcribe it
 * first. Not downloaded: the reason and the command that fetches it.
 *
 * @param change - The comment change
 * @param files - Recordings fetched for this delivery
 * @param fetchCmd - `bash …/app-comments/execute.sh --app <id>` (the fallback command)
 * @returns Lines (empty when the change has no recording)
 */
export function voiceLines(change: AppChange, files: VoiceFiles | undefined, fetchCmd: string): string[] {
  const out: string[] = [];
  for (const { commentId, attachment } of voiceAttachmentsOf(change)) {
    const f = files?.[attachment.blobId];
    const clock = formatVoiceClock(f?.durationMs ?? attachment.durationMs);
    if (f?.path) {
      const json = JSON.stringify(f.path);
      out.push(
        `    Voice comment (${clock}): ${f.path} — transcribe it with the transcribe-audio skill before acting: {"audioFile":${json}}. ` +
          'If it answers "needsSetup": true, run install-skill --id transcribe-audio first; do not guess what it says.',
      );
    } else {
      out.push(
        `    Voice comment (${clock}): not downloaded yet${f?.error ? ` (${f.error})` : ''}. Fetch it with: ${fetchCmd} --audio ${commentId} ` +
          '— then transcribe it with the transcribe-audio skill before acting.',
      );
    }
  }
  return out;
}

/** Downloads voice comment recordings to this machine. */
export class AppCommentAudioService {
  constructor(private readonly deps: AppCommentAudioDeps) {}

  private dir(): string {
    return path.join(this.deps.homeDir(), V.DIR);
  }

  /**
   * One recording, cached by app + blob id.
   *
   * @param appId - App
   * @param commentId - Thread it is attached to
   * @param a - The attachment
   * @returns The local file (or why not)
   */
  async fetchOne(appId: string, commentId: string, a: AppCommentAttachment & { blobId: string }): Promise<VoiceFile> {
    const base: VoiceFile = { blobId: a.blobId, commentId, durationMs: typeof a.durationMs === 'number' ? a.durationMs : 0, mime: typeof a.mime === 'string' ? a.mime : 'audio/webm' };
    if (!APP_ID_RE.test(appId) || !C.COMMENTS.ID_PATTERN.test(commentId) || !V.BLOB_ID_PATTERN.test(a.blobId)) return { ...base, error: 'bad id' };
    const ext = V.EXT[base.mime] ?? 'audio';
    const file = path.join(this.dir(), `${appId}-${a.blobId}.${ext}`);
    try {
      const st = await fs.stat(file).catch(() => null);
      if (st && st.size > 0) return { ...base, path: file };
      const { data } = await this.deps.client.download(`/apps/${appId}/comments/${commentId}/audio/${a.blobId}`, { maxBytes: V.MAX_BYTES, timeoutMs: V.DOWNLOAD_TIMEOUT_MS });
      if (data.length === 0) return { ...base, error: 'empty recording' };
      await fs.mkdir(this.dir(), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, data, { mode: 0o600 });
      await fs.rename(tmp, file);
      this.deps.log?.('info', 'Voice comment downloaded', { appId, commentId, blobId: a.blobId, bytes: data.length });
      return { ...base, path: file };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.deps.log?.('warn', 'Voice comment could not be downloaded', { appId, commentId, blobId: a.blobId, error: why });
      return { ...base, error: why.slice(0, 120) };
    }
  }

  /**
   * The recordings of a batch of comment changes (at most VOICE.MAX_PER_WAKE).
   * Never throws.
   *
   * @param appId - App
   * @param comments - Comment changes
   * @returns Files by blob id (empty when none)
   */
  async forChanges(appId: string, comments: AppChange[]): Promise<VoiceFiles> {
    const out: VoiceFiles = {};
    const wanted = comments.flatMap((c) => voiceAttachmentsOf(c)).slice(-V.MAX_PER_WAKE);
    for (const { commentId, attachment } of wanted) {
      if (out[attachment.blobId]) continue;
      out[attachment.blobId] = await this.fetchOne(appId, commentId, attachment).catch((err) => ({
        blobId: attachment.blobId,
        commentId,
        durationMs: attachment.durationMs ?? 0,
        mime: attachment.mime ?? 'audio/webm',
        error: err instanceof Error ? err.message : String(err),
      }));
    }
    return out;
  }

  /**
   * Every recording of one thread (`app-comments --audio <id>`).
   *
   * @param appId - App
   * @param commentId - Thread
   * @param thread - The thread as Cloud returned it
   * @returns Files, oldest first
   */
  async forThread(appId: string, commentId: string, thread: { attachments?: unknown; replies?: Array<{ attachments?: unknown }> }): Promise<VoiceFile[]> {
    const out: VoiceFile[] = [];
    for (const a of threadVoiceAttachments(thread)) out.push(await this.fetchOne(appId, commentId, a));
    return out;
  }
}

/** Upload a recording into a Slack thread as an agent's bot. */
export type SlackAudioUpload = (req: { agentSession: string; channel: string; threadTs: string; filePath: string; filename: string; title: string }) => Promise<void>;

/**
 * Show a comment change's recordings in its Slack thread: each file uploaded
 * as the thread's bot when it is on this machine and an uploader is wired;
 * otherwise (or when the upload fails) one line with a link to the app,
 * where the owner can play it.
 *
 * @param input - The change, its downloaded files, the thread and the senders
 * @returns How many recordings were uploaded
 */
export async function mirrorVoiceToSlack(input: {
  change: AppChange;
  files: VoiceFiles | undefined;
  agentSession: string;
  channel: string;
  threadTs: string;
  appUrl: string;
  upload?: SlackAudioUpload;
  post: (text: string) => Promise<unknown>;
  log?: (level: 'info' | 'warn', msg: string, meta?: Record<string, unknown>) => void;
}): Promise<number> {
  let uploaded = 0;
  for (const { attachment } of voiceAttachmentsOf(input.change)) {
    const f = input.files?.[attachment.blobId];
    const clock = formatVoiceClock(f?.durationMs ?? attachment.durationMs);
    if (f?.path && input.upload && input.agentSession) {
      try {
        await input.upload({
          agentSession: input.agentSession,
          channel: input.channel,
          threadTs: input.threadTs,
          filePath: f.path,
          filename: path.basename(f.path),
          title: `Voice comment (${clock})`,
        });
        uploaded++;
        continue;
      } catch (err) {
        input.log?.('warn', 'Voice comment could not be uploaded to Slack; posting a link instead', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    try {
      await input.post(`🎤 Voice comment (${clock}) — listen in the app: <${input.appUrl}|Open app>`);
    } catch {
      /* a mirror problem never fails delivery */
    }
  }
  return uploaded;
}
