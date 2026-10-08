/**
 * Tests for the Slack file fetch: local bot tokens first, Cloud fallback,
 * size cap, message links.
 *
 * @module services/slack/slack-file-fetch.service.test
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { SlackFileFetchService, SlackFileGetError, previewTextFile, type LocalTokenCandidate } from './slack-file-fetch.service.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
    }),
  },
}));

const FILE = 'F0ABC12345';
const LINK = `https://acme.slack.com/files/U0ELLA1234/${FILE}/longform-en.md`;
const CONTENT = '# Longform\nline 2\n';

interface Fake {
  visible: Record<string, string[]>;
  history?: Record<string, string[]>;
  size?: number;
  cloud?: { status: number; body?: string; json?: unknown; meta?: unknown };
  calls: Array<{ method: string; token: string }>;
  cloudCalls: Array<{ url: string; body: unknown; auth: string | null }>;
}

function fakeFetch(f: Fake): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const token = (headers['Authorization'] ?? '').replace(/^Bearer /, '');
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://slack.com/api/')) {
      const method = url.slice('https://slack.com/api/'.length);
      const form = new URLSearchParams(String(init?.body ?? ''));
      f.calls.push({ method, token });
      if (method === 'files.info') {
        const id = form.get('file') as string;
        if (!(f.visible[token] ?? []).includes(id)) return json({ ok: false, error: 'file_not_found' });
        return json({
          ok: true,
          file: {
            id,
            name: 'longform-en.md',
            mimetype: 'text/markdown',
            size: f.size ?? Buffer.byteLength(CONTENT),
            user: 'U0ELLA1234',
            channels: ['C0MKTG1234'],
            permalink: LINK,
            url_private_download: `https://files.slack.com/files-pri/T0ACME1234-${id}/download/longform-en.md`,
          },
        });
      }
      if (method === 'conversations.history') {
        if (!(f.history?.[token] ?? []).includes(form.get('channel') as string)) return json({ ok: false, error: 'not_in_channel' });
        return json({ ok: true, messages: [{ ts: form.get('latest'), files: [{ id: FILE }] }] });
      }
      return json({ ok: false, error: 'unknown_method' });
    }
    if (url.startsWith('https://files.slack.com/')) {
      return new Response(CONTENT, { status: 200, headers: { 'content-type': 'text/markdown' } });
    }
    if (url.startsWith('https://cloud.test/')) {
      f.cloudCalls.push({ url, body: JSON.parse(String(init?.body ?? '{}')), auth: headers['Authorization'] ?? null });
      const c = f.cloud ?? { status: 404, json: { success: false, error: 'Not found' } };
      if (c.status !== 200) return json(c.json ?? {}, c.status);
      const h = new Headers({ 'content-type': 'text/markdown' });
      if (c.meta) h.set('x-crewly-slack-file', Buffer.from(JSON.stringify(c.meta)).toString('base64url'));
      return new Response(c.body ?? CONTENT, { status: 200, headers: h });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

describe('SlackFileFetchService', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-file-fetch-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function make(f: Fake, candidates: LocalTokenCandidate[], signedIn = true) {
    return new SlackFileFetchService({
      localCandidates: () => candidates,
      cloud: () => (signedIn ? { baseUrl: 'https://cloud.test', token: 'cloud-jwt' } : null),
      saveDir: dir,
      fetchImpl: fakeFetch(f),
    });
  }
  const fake = (p: Partial<Fake>): Fake => ({ visible: {}, calls: [], cloudCalls: [], ...p });

  it('fetches locally with the first token that can see the file, and saves it', async () => {
    const f = fake({ visible: { 'xoxb-ella': [FILE] } });
    const svc = make(f, [
      { token: 'xoxb-rex', label: 'team-rex' },
      { token: 'xoxb-ella', label: 'team-ella' },
    ]);
    const out = await svc.get(LINK, { requesterAgent: 'team-rex' });
    expect(out.meta.via).toBe('local:team-ella');
    expect(out.localPath).toBe(path.join(dir, `${FILE}-longform-en.md`));
    expect(await fs.readFile(out.localPath, 'utf8')).toBe(CONTENT);
    expect(f.calls.filter((c) => c.method === 'files.info').map((c) => c.token)).toEqual(['xoxb-rex', 'xoxb-ella']);
    expect(f.cloudCalls).toHaveLength(0);
  });

  it('falls back to Cloud when no local bot can see the file', async () => {
    const f = fake({
      visible: {},
      cloud: { status: 200, meta: { id: FILE, name: 'longform-en.md', mimetype: 'text/markdown', via: 'agent:team-ella', channels: ['C0MKTG1234'] } },
    });
    const out = await make(f, [{ token: 'xoxb-rex', label: 'team-rex' }]).get(LINK, { requesterAgent: 'team-rex' });
    expect(out.meta.via).toBe('cloud:agent:team-ella');
    expect(out.meta.isText).toBe(true);
    expect(await fs.readFile(out.localPath, 'utf8')).toBe(CONTENT);
    expect(f.cloudCalls).toEqual([
      { url: 'https://cloud.test/api/cloud/slack/files/fetch', body: { fileRef: LINK, requesterAgent: 'team-rex' }, auth: 'Bearer cloud-jwt' },
    ]);
  });

  it('goes straight to Cloud when this machine holds no Slack tokens', async () => {
    const f = fake({ cloud: { status: 200, meta: { id: FILE, name: 'longform-en.md', mimetype: 'text/markdown', via: 'master' } } });
    const out = await make(f, []).get(FILE);
    expect(out.meta.via).toBe('cloud:master');
    expect(f.calls).toHaveLength(0);
  });

  it('passes Cloud\'s refusal through with its code', async () => {
    const f = fake({ cloud: { status: 403, json: { success: false, code: 'foreign_workspace', error: 'other workspace' } } });
    await expect(make(f, []).get(FILE)).rejects.toMatchObject({ code: 'foreign_workspace' });
  });

  it('reports cloud_unavailable when Cloud does not have the endpoint yet', async () => {
    const f = fake({ cloud: { status: 404, json: { success: false, error: 'Not found' } } });
    await expect(make(f, []).get(FILE)).rejects.toMatchObject({ code: 'cloud_unavailable' });
  });

  it('says not_visible when nothing local can see it and the machine is not signed in', async () => {
    const f = fake({});
    await expect(make(f, [{ token: 'xoxb-rex', label: 'team-rex' }], false).get(FILE)).rejects.toMatchObject({ code: 'not_visible' });
  });

  it('refuses a file over the cap without downloading or asking Cloud', async () => {
    const f = fake({ visible: { 'xoxb-ella': [FILE] }, size: 30 * 1024 * 1024 });
    const err = await make(f, [{ token: 'xoxb-ella', label: 'team-ella' }]).get(FILE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackFileGetError);
    expect((err as SlackFileGetError).code).toBe('too_large');
    expect(f.cloudCalls).toHaveLength(0);
  });

  it('honours a smaller cap from the caller (auto-fetch of linked files)', async () => {
    const f = fake({ visible: { 'xoxb-ella': [FILE] } });
    await expect(make(f, [{ token: 'xoxb-ella', label: 'team-ella' }]).get(FILE, { maxBytes: 5 })).rejects.toMatchObject({ code: 'too_large' });
  });

  it('caps what Cloud sends back too', async () => {
    const f = fake({ cloud: { status: 200, body: 'x'.repeat(100), meta: { id: FILE, name: 'a.md', mimetype: 'text/markdown' } } });
    await expect(make(f, []).get(FILE, { maxBytes: 10 })).rejects.toMatchObject({ code: 'too_large' });
  });

  it('resolves a message link through a bot that can read the channel', async () => {
    const f = fake({ visible: { 'xoxb-mia': [FILE] }, history: { 'xoxb-mia': ['C0MKTG1234'] } });
    const out = await make(f, [
      { token: 'xoxb-rex', label: 'team-rex' },
      { token: 'xoxb-mia', label: 'team-mia' },
    ]).get('https://acme.slack.com/archives/C0MKTG1234/p1696771234567890');
    expect(out.meta.id).toBe(FILE);
    expect(out.meta.via).toBe('local:team-mia');
  });

  it('rejects something that is not a Slack file reference', async () => {
    await expect(make(fake({}), []).get('https://example.com/x')).rejects.toMatchObject({ code: 'validation' });
  });

  it('previews the first lines of a text file', async () => {
    const p = path.join(dir, 'long.md');
    await fs.writeFile(p, Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'));
    const preview = await previewTextFile(p);
    expect(preview.split('\n')).toHaveLength(20);
    expect(preview.startsWith('line 0')).toBe(true);
  });
});
