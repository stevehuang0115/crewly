/**
 * Tests for the in-process support API (crewly#1558): endpoints, role gate,
 * redaction, settings allowlist and the admin restart.
 */

import { SUPPORT_ACCESS_CONSTANTS } from '../../constants.js';
import { getDefaultSettings, type CrewlySettings } from '../../types/settings.types.js';
import type { ChatChannelDTO, ChatMessageDTO } from '../chat-v2/types.js';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SupportApiService,
  conversationSource,
  readFileTail,
  serviceLogPath,
  type SupportApiDeps,
  type SupportChatSource,
} from './support-api.service.js';
import { supportCallerFromEnvelope, type SupportCaller, type SupportRole } from './support.types.js';

/** A fake Slack-shaped token, split so secret scanners don't flag the fixture. */
const FAKE_SLACK = ['xox', 'b-1234567890-abcdefghijklmnop'].join('');

const W = SUPPORT_ACCESS_CONSTANTS.WITHHELD_PLACEHOLDER;

function caller(role: SupportRole = 'viewer', includePrivate = false): SupportCaller {
  return supportCallerFromEnvelope({ grantId: 'g1', role, includePrivate, granteeEmail: 'help@crewlyai.com', granteeAccountId: 'acct-b', replyQueueId: 'q-b' });
}

function channel(id: string, name: string, lastMessageAt: number, extra: Partial<ChatChannelDTO> = {}): ChatChannelDTO {
  return { id, name, agentSession: '', createdAt: 1, lastMessageAt, agentPresence: { status: 'offline', lastSeenAt: null }, type: 'dm', lastReadSeq: 0, unreadCount: 0, ...extra } as ChatChannelDTO;
}

function message(id: string, content: string, metadata?: Record<string, unknown>): ChatMessageDTO {
  return { id, channelId: 'c1', seq: 1, senderType: 'agent', senderId: 'a-dev', content, contentType: 'text', createdAt: 5, attachments: [], mentions: [], ...(metadata ? { metadata } : {}) } as ChatMessageDTO;
}

function make(overrides: Partial<SupportApiDeps> = {}) {
  const chat: SupportChatSource = {
    listChannels: jest.fn(() => [channel('c-old', 'old', 10), channel('slack-T1-C2', 'Slack thread', 30), channel('c-new', 'Agent DM', 20, { agentSession: 'a-dev' })]),
    listMessages: jest.fn((args) => {
      if (args.channelId === 'missing') throw Object.assign(new Error('channel_not_found'), { status: 404 });
      return {
        channelId: args.channelId,
        nextCursor: 'n1',
        prevCursor: null,
        messages: [
          message('m1', 'Deploy failed: token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123'),
          message('m2', 'Inbox summary for you', { privateSourcePeople: ['owner'] }),
          message('m3', 'Mia is 7 years old and in grade 2'),
          message('m4', 'Restarted the agent, all good'),
        ],
      };
    }),
  };
  const settings: CrewlySettings = getDefaultSettings();
  settings.apiKeys = { global: { anthropic: 'sk-ant-secret-value-1234567890' } };
  const restartAgent = jest.fn(async () => true);
  const deps: SupportApiDeps = {
    chat: () => chat,
    teams: async () => [{ id: 't1', name: 'Team', members: [{ id: 'm1', name: 'Dev', role: 'developer', sessionName: 'a-dev', agentStatus: 'active', workingStatus: 'idle', runtimeType: 'claude-code' }, { id: 'm2', name: 'Off', sessionName: 'a-off' }] }],
    orchestrator: async () => ({ sessionName: 'crewly-orc', agentStatus: 'active', workingStatus: 'in_progress', runtimeType: 'claude-code' }),
    settings: async () => settings,
    readLogTail: async () => ['INFO started', 'WARN [Cloud] poll failed token=abcdefgh12345678', 'ERROR boom for ops@acme.io', 'INFO ok'].join('\n'),
    restartAgent,
    isOwnerStopped: (s) => s === 'a-off',
    isSessionPaused: () => false,
    ...overrides,
  };
  return { api: new SupportApiService(deps), chat, restartAgent };
}

describe('SupportApiService routing and role gate', () => {
  it('answers whoami with the grant', async () => {
    const { api } = make();
    const res = await api.handle(caller(), { method: 'GET', path: '/support/whoami' });
    expect(res).toEqual({ status: 200, body: { success: true, data: { grantId: 'g1', role: 'viewer', includePrivate: false, granteeEmail: 'help@crewlyai.com' } } });
  });

  it('refuses a forged non-support caller object', async () => {
    const { api } = make();
    const forged = { ...caller(), kind: 'owner' } as unknown as SupportCaller;
    expect((await api.handle(forged, { method: 'GET', path: '/support/whoami' })).status).toBe(403);
  });

  it('refuses POST from a viewer, and the restart route even if the method table changed', async () => {
    const { api, restartAgent } = make();
    expect((await api.handle(caller('viewer'), { method: 'POST', path: '/support/agents/a-dev/restart' })).status).toBe(403);
    expect(restartAgent).not.toHaveBeenCalled();
  });

  it('404s an unknown endpoint and a GET to the restart route', async () => {
    const { api } = make();
    expect((await api.handle(caller(), { method: 'GET', path: '/support/secrets' })).status).toBe(404);
    expect((await api.handle(caller('admin'), { method: 'GET', path: '/support/agents/a-dev/restart' })).status).toBe(404);
  });

  it('turns an unexpected failure into a scrubbed 500', async () => {
    const { api } = make({ teams: async () => { throw new Error(`bad ${FAKE_SLACK}`); } });
    const res = await api.handle(caller(), { method: 'GET', path: '/support/agents' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('abcdefghijklmnop');
  });
});

describe('GET /support/conversations', () => {
  it('lists newest first with source, limited', async () => {
    const { api } = make();
    const res = await api.handle(caller(), { method: 'GET', path: '/support/conversations?limit=2' });
    const list = (res.body as { data: { conversations: Array<{ id: string; source: string; agentSession?: string }> } }).data.conversations;
    expect(list.map((c) => c.id)).toEqual(['slack-T1-C2', 'c-new']);
    expect(list[0].source).toBe('slack');
    expect(list[1].agentSession).toBe('a-dev');
  });

  it('503s when chat is not ready', async () => {
    const { api } = make({ chat: () => null });
    expect((await api.handle(caller(), { method: 'GET', path: '/support/conversations' })).status).toBe(503);
  });
});

describe('GET /support/conversations/:id/messages', () => {
  it('scrubs secrets and withholds private content by default', async () => {
    const { api } = make();
    const res = await api.handle(caller(), { method: 'GET', path: '/support/conversations/c1/messages' });
    const msgs = (res.body as { data: { messages: Array<{ id: string; content: string; withheld: boolean }>; nextCursor: string } }).data;
    expect(msgs.nextCursor).toBe('n1');
    const byId = Object.fromEntries(msgs.messages.map((m) => [m.id, m]));
    expect(byId.m1.content).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
    expect(byId.m2).toMatchObject({ content: W, withheld: true });
    expect(byId.m3).toMatchObject({ content: W, withheld: true });
    expect(byId.m4).toMatchObject({ content: 'Restarted the agent, all good', withheld: false });
    expect(JSON.stringify(res.body)).not.toContain('metadata');
  });

  it('shows private content with includePrivate, but still scrubs secrets', async () => {
    const { api } = make();
    const res = await api.handle(caller('viewer', true), { method: 'GET', path: '/support/conversations/c1/messages' });
    const body = JSON.stringify(res.body);
    expect(body).toContain('Inbox summary for you');
    expect(body).toContain('Mia is 7 years old');
    expect(body).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
  });

  it('passes paging through and 404s an unknown conversation', async () => {
    const { api, chat } = make();
    await api.handle(caller(), { method: 'GET', path: '/support/conversations/c1/messages?limit=999&cursor=abc&direction=forward' });
    expect(chat.listMessages).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'c1', cursor: 'abc', direction: 'forward', limit: SUPPORT_ACCESS_CONSTANTS.MAX_MESSAGES }));
    expect((await api.handle(caller(), { method: 'GET', path: '/support/conversations/missing/messages' })).status).toBe(404);
  });
});

describe('GET /support/agents', () => {
  it('returns the orchestrator and members with status', async () => {
    const { api } = make();
    const res = await api.handle(caller(), { method: 'GET', path: '/support/agents' });
    const data = (res.body as { data: { orchestrator: { sessionName: string }; teams: Array<{ members: Array<{ sessionName: string; ownerStopped: boolean }> }> } }).data;
    expect(data.orchestrator.sessionName).toBe('crewly-orc');
    expect(data.teams[0].members).toEqual([
      expect.objectContaining({ sessionName: 'a-dev', agentStatus: 'active', ownerStopped: false }),
      expect.objectContaining({ sessionName: 'a-off', ownerStopped: true }),
    ]);
  });
});

describe('GET /support/errors', () => {
  it('returns WARN / ERROR lines only, scrubbed and masked', async () => {
    const { api } = make();
    const res = await api.handle(caller(), { method: 'GET', path: '/support/errors' });
    const lines = (res.body as { data: { lines: string[] } }).data.lines;
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('abcdefgh12345678');
    expect(lines.join('\n')).not.toContain('ops@acme.io');
  });

  it('honours the limit', async () => {
    const { api } = make();
    const res = await api.handle(caller(), { method: 'GET', path: '/support/errors?limit=1' });
    expect((res.body as { data: { lines: string[] } }).data.lines).toEqual([expect.stringContaining('ERROR boom')]);
  });
});

describe('GET /support/settings', () => {
  it('returns only allowlisted settings and key presence, never values or commands', async () => {
    const { api } = make();
    const res = await api.handle(caller(), { method: 'GET', path: '/support/settings' });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('sk-ant-secret-value');
    expect(body).not.toContain('runtimeCommands');
    expect(body).not.toContain('dangerously');
    const data = (res.body as { data: { general: Record<string, unknown>; apiKeysConfigured: Record<string, boolean> } }).data;
    expect(data.general.maxConcurrentAgents).toBe(10);
    expect(data.apiKeysConfigured).toEqual({ gemini: false, anthropic: true, openai: false, deepseek: false });
  });
});

describe('POST /support/agents/:session/restart', () => {
  it('restarts a known agent for an admin', async () => {
    const { api, restartAgent } = make();
    const res = await api.handle(caller('admin'), { method: 'POST', path: '/support/agents/a-dev/restart' });
    expect(res).toEqual({ status: 200, body: { success: true, data: { session: 'a-dev', restarted: true } } });
    expect(restartAgent).toHaveBeenCalledWith('a-dev');
  });

  it('restarts the orchestrator', async () => {
    const { api, restartAgent } = make();
    expect((await api.handle(caller('admin'), { method: 'POST', path: '/support/agents/crewly-orc/restart' })).status).toBe(200);
    expect(restartAgent).toHaveBeenCalledWith('crewly-orc');
  });

  it('refuses an unknown agent and one the owner stopped or paused', async () => {
    const { api, restartAgent } = make({ isSessionPaused: (s) => s === 'a-dev' });
    expect((await api.handle(caller('admin'), { method: 'POST', path: '/support/agents/nobody/restart' })).status).toBe(404);
    expect((await api.handle(caller('admin'), { method: 'POST', path: '/support/agents/a-off/restart' })).status).toBe(409);
    expect((await api.handle(caller('admin'), { method: 'POST', path: '/support/agents/a-dev/restart' })).status).toBe(409);
    expect(restartAgent).not.toHaveBeenCalled();
  });

  it('500s when the agent does not come back', async () => {
    const { api } = make({ restartAgent: async () => false });
    expect((await api.handle(caller('admin'), { method: 'POST', path: '/support/agents/a-dev/restart' })).status).toBe(500);
  });
});

describe('helpers', () => {
  it('conversationSource names the surface', () => {
    expect(conversationSource('slack-x')).toBe('slack');
    expect(conversationSource('whatsapp-x')).toBe('whatsapp');
    expect(conversationSource('telegram-x')).toBe('telegram');
    expect(conversationSource('gchat-x')).toBe('google-chat');
    expect(conversationSource('external-l1')).toBe('shared');
    expect(conversationSource('dm-1')).toBe('crewly');
  });

  it('readFileTail reads the end of a file and drops a partial first line', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'support-tail-'));
    try {
      const file = path.join(dir, 'service.log');
      await fsp.writeFile(file, 'first line\nsecond line\nthird\n');
      expect(await readFileTail(file, 1000)).toBe('first line\nsecond line\nthird\n');
      expect(await readFileTail(file, 10)).toBe('third\n');
      expect(await readFileTail(path.join(dir, 'none.log'), 10)).toBe('');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('serviceLogPath points at <home>/logs/service.log', () => {
    expect(serviceLogPath('/h')).toBe(path.join('/h', 'logs', 'service.log'));
  });
});
