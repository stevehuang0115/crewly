/**
 * Tests for the voice comment helpers and downloader (crewly-services
 * apps/SPEC.md §16): which recordings a change is about, the lines the agent
 * reads, the cached download into <home>/tmp/app-comment-audio, and the Slack
 * mirror (upload as the bot, else a link).
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  AppCommentAudioService,
  formatVoiceClock,
  mirrorVoiceToSlack,
  threadVoiceAttachments,
  voiceAttachmentsOf,
  voiceLines,
} from './app-comment-audio.service.js';
import type { AppChange } from './app-wake-message.js';

const APP = '28au74d9cj';
const A1 = { kind: 'audio', blobId: 'abcdefgh12345678', mime: 'audio/webm', durationMs: 42_000, size: 9 };
const A2 = { kind: 'audio', blobId: 'bbbbbbbb12345678', mime: 'audio/mp4', durationMs: 5_000, size: 9 };
const thread = { id: 'c1', body: '', attachments: [A1], replies: [{ id: 'r1', body: '', attachments: [A2] }, { id: 'r2', body: 'text' }] };
const change = (op: string, replyId?: string): AppChange => ({ seq: 1, kind: 'comment', comment: { id: 'c1', op, ...(replyId ? { replyId } : {}), thread: thread as never } });

describe('voice comment helpers', () => {
  it('formats a clock', () => {
    expect(formatVoiceClock(42_000)).toBe('0:42');
    expect(formatVoiceClock(125_900)).toBe('2:05');
    expect(formatVoiceClock(undefined)).toBe('0:00');
  });

  it('picks the comment\'s recordings for add / reopen, the reply\'s for a reply, none for resolve or bad shapes', () => {
    expect(voiceAttachmentsOf(change('add')).map((x) => x.attachment.blobId)).toEqual([A1.blobId]);
    expect(voiceAttachmentsOf(change('reopen')).map((x) => x.attachment.blobId)).toEqual([A1.blobId]);
    expect(voiceAttachmentsOf(change('reply', 'r1')).map((x) => x.attachment.blobId)).toEqual([A2.blobId]);
    expect(voiceAttachmentsOf(change('reply', 'r2'))).toEqual([]);
    expect(voiceAttachmentsOf(change('resolve'))).toEqual([]);
    const bad: AppChange = { seq: 1, kind: 'comment', comment: { id: 'c1', op: 'add', thread: { attachments: [{ kind: 'audio', blobId: '../../etc' }, { kind: 'image', blobId: A1.blobId }] } as never } };
    expect(voiceAttachmentsOf(bad)).toEqual([]);
    expect(threadVoiceAttachments(thread).map((a) => a.blobId)).toEqual([A1.blobId, A2.blobId]);
  });

  it('the agent\'s line: the path and "transcribe first", or the fetch command when it is missing', () => {
    const files = { [A1.blobId]: { blobId: A1.blobId, commentId: 'c1', durationMs: 42_000, mime: 'audio/webm', path: '/x/a.webm' } };
    const [ok] = voiceLines(change('add'), files, 'bash /s/app-comments/execute.sh --app 28au74d9cj');
    expect(ok).toBe(
      '    Voice comment (0:42): /x/a.webm — transcribe it with the transcribe-audio skill before acting: {"audioFile":"/x/a.webm"}. ' +
        'If it answers "needsSetup": true, run install-skill --id transcribe-audio first; do not guess what it says.',
    );
    const [missing] = voiceLines(change('add'), {}, 'bash /s/app-comments/execute.sh --app 28au74d9cj');
    expect(missing).toBe('    Voice comment (0:42): not downloaded yet. Fetch it with: bash /s/app-comments/execute.sh --app 28au74d9cj --audio c1 — then transcribe it with the transcribe-audio skill before acting.');
    expect(voiceLines(change('resolve'), files, 'x')).toEqual([]);
  });
});

describe('AppCommentAudioService', () => {
  let home: string;
  let calls: string[];
  let fail: Error | null;
  const svc = () =>
    new AppCommentAudioService({
      client: {
        download: async (p) => {
          calls.push(p);
          if (fail) throw fail;
          return { data: Buffer.from('OggS-bytes'), contentType: 'audio/webm' };
        },
      },
      homeDir: () => home,
    });

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-'));
    calls = [];
    fail = null;
  });
  afterEach(() => fs.rm(home, { recursive: true, force: true }));

  it('downloads into <home>/tmp/app-comment-audio with the type\'s extension, once (then cached)', async () => {
    const s = svc();
    const files = await s.forChanges(APP, [change('add'), change('reply', 'r1')]);
    const p1 = path.join(home, 'tmp', 'app-comment-audio', `${APP}-${A1.blobId}.webm`);
    const p2 = path.join(home, 'tmp', 'app-comment-audio', `${APP}-${A2.blobId}.m4a`);
    expect(files[A1.blobId]).toMatchObject({ path: p1, durationMs: 42_000, commentId: 'c1' });
    expect(files[A2.blobId]).toMatchObject({ path: p2 });
    expect(await fs.readFile(p1, 'utf8')).toBe('OggS-bytes');
    expect(calls).toEqual([`/apps/${APP}/comments/c1/audio/${A1.blobId}`, `/apps/${APP}/comments/c1/audio/${A2.blobId}`]);
    await s.forChanges(APP, [change('add')]);
    expect(calls).toHaveLength(2);
    expect((await fs.stat(p1)).mode & 0o777).toBe(0o600);
  });

  it('a failed download is reported, never thrown; bad ids are refused without a request', async () => {
    fail = new Error('Could not reach Crewly Apps');
    const files = await svc().forChanges(APP, [change('add')]);
    expect(files[A1.blobId]).toMatchObject({ error: 'Could not reach Crewly Apps' });
    expect(files[A1.blobId].path).toBeUndefined();
    expect(await svc().fetchOne('../x', 'c1', { blobId: A1.blobId })).toMatchObject({ error: 'bad id' });
    expect(calls).toHaveLength(1);
  });

  it('forThread fetches every recording of a thread (app-comments --audio)', async () => {
    const out = await svc().forThread(APP, 'c1', thread);
    expect(out.map((f) => f.blobId)).toEqual([A1.blobId, A2.blobId]);
    expect(out.every((f) => !!f.path)).toBe(true);
  });
});

describe('mirrorVoiceToSlack', () => {
  const files = { [A1.blobId]: { blobId: A1.blobId, commentId: 'c1', durationMs: 42_000, mime: 'audio/webm', path: '/x/a.webm' } };
  const base = { agentSession: 'ella', channel: 'D1', threadTs: '1.1', appUrl: 'https://apps.test/x' };

  it('uploads the file as the bot; on failure, or without the file, posts a link line', async () => {
    const posted: string[] = [];
    const uploads: unknown[] = [];
    expect(await mirrorVoiceToSlack({ ...base, change: change('add'), files, upload: async (r) => void uploads.push(r), post: async (t) => posted.push(t) })).toBe(1);
    expect(uploads).toEqual([{ agentSession: 'ella', channel: 'D1', threadTs: '1.1', filePath: '/x/a.webm', filename: 'a.webm', title: 'Voice comment (0:42)' }]);
    expect(posted).toEqual([]);

    expect(await mirrorVoiceToSlack({ ...base, change: change('add'), files, upload: async () => Promise.reject(new Error('not_in_channel')), post: async (t) => posted.push(t) })).toBe(0);
    expect(await mirrorVoiceToSlack({ ...base, change: change('add'), files: {}, post: async (t) => posted.push(t) })).toBe(0);
    expect(posted).toEqual(['🎤 Voice comment (0:42) — listen in the app: <https://apps.test/x|Open app>', '🎤 Voice comment (0:42) — listen in the app: <https://apps.test/x|Open app>']);
  });
});
