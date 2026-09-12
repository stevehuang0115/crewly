/**
 * Tests for SlackAgentPostService — target resolution, identity choice and
 * the error messages an agent sees.
 *
 * @module services/slack/slack-agent-post.service.test
 */

import {
  SlackAgentPostService,
  SlackAgentPostError,
  getSlackAgentPostService,
  setSlackAgentPostService,
  type AgentPostIdentityApi,
  type AgentPostSlackApi,
} from './slack-agent-post.service.js';
import type { Team, TeamMember } from '../../types/index.js';
import type { SlackOutgoingMessage } from '../../types/slack.types.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
    }),
  },
}));

function member(name: string, role: TeamMember['role'], extra: Partial<TeamMember> = {}): TeamMember {
  return {
    id: `m-${name}`,
    name,
    sessionName: `crewly-a-${name.toLowerCase()}`,
    role,
    systemPrompt: '',
    agentStatus: 'active',
    workingStatus: 'idle',
    runtimeType: 'claude-code',
    createdAt: 'x',
    updatedAt: 'x',
    ...extra,
  } as TeamMember;
}

class FakeSlack implements AgentPostSlackApi {
  connected = true;
  sent: SlackOutgoingMessage[] = [];
  channels: Record<string, { id: string; name: string; isArchived: boolean; isPrivate: boolean }> = {
    general: { id: 'C-GEN', name: 'general', isArchived: false, isPrivate: false },
    old: { id: 'C-OLD', name: 'old', isArchived: true, isPrivate: false },
  };
  handles: Record<string, string> = { steve: 'USTEVE' };
  dmOpens: Array<{ userId: string; botToken?: string }> = [];
  sendError: unknown = null;
  openError: unknown = null;
  isConnected() {
    return this.connected;
  }
  async sendMessage(m: SlackOutgoingMessage) {
    if (this.sendError) throw this.sendError;
    this.sent.push(m);
    return '111.222';
  }
  async findChannelByName(name: string) {
    return this.channels[name] ?? null;
  }
  async openDirectMessage(userId: string, botToken?: string) {
    if (this.openError) throw this.openError;
    this.dmOpens.push({ userId, botToken });
    return `D-${userId}`;
  }
  async findUserByHandle(handle: string) {
    return this.handles[handle.toLowerCase()] ?? null;
  }
}

class FakeIdentities implements AgentPostIdentityApi {
  installed: Record<string, { botUserId: string; botToken: string }> = {};
  loaded = 0;
  async load() {
    this.loaded += 1;
    return { version: 1 as const, identities: [] };
  }
  getInstalled(agentSession: string) {
    return this.installed[agentSession] ?? null;
  }
}

const TEAMS: Team[] = [
  { id: 't1', name: 'Alpha', members: [member('Sam', 'developer', { avatar: ':computer:' }), member('Leo', 'qa')], projectIds: [], createdAt: 'x', updatedAt: 'x' } as Team,
];

let slack: FakeSlack;
let identities: FakeIdentities | null;
let service: SlackAgentPostService;

beforeEach(() => {
  slack = new FakeSlack();
  identities = new FakeIdentities();
  service = new SlackAgentPostService({
    slack,
    storage: { getTeams: async () => TEAMS },
    identities,
  });
});

afterEach(() => setSlackAgentPostService(null));

describe('validation and availability', () => {
  it('rejects missing fields and oversized text', async () => {
    await expect(service.post({ agentSession: '', target: '#general', text: 'x' })).rejects.toMatchObject({ code: 'validation' });
    await expect(service.post({ agentSession: 'a', target: ' ', text: 'x' })).rejects.toMatchObject({ code: 'validation' });
    await expect(service.post({ agentSession: 'a', target: '#general', text: '  ' })).rejects.toMatchObject({ code: 'validation' });
    await expect(service.post({ agentSession: 'a', target: '#general', text: 'x'.repeat(12_001) })).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('refuses when Slack is down', async () => {
    slack.connected = false;
    await expect(service.post({ agentSession: 'a', target: '#general', text: 'hi' })).rejects.toMatchObject({
      code: 'not_connected',
    });
  });
});

describe('target resolution', () => {
  it('posts to a channel by name, with or without the hash', async () => {
    const res = await service.post({ agentSession: 'crewly-a-sam', target: '#general', text: 'hello' });
    expect(res).toMatchObject({ channelId: 'C-GEN', kind: 'channel', messageTs: '111.222' });
    await service.post({ agentSession: 'crewly-a-sam', target: 'general', text: 'again' });
    expect(slack.sent.map((m) => m.channelId)).toEqual(['C-GEN', 'C-GEN']);
  });

  it('accepts channel and DM ids verbatim', async () => {
    expect(await service.post({ agentSession: 'a', target: 'C0123ABC', text: 'x' })).toMatchObject({ channelId: 'C0123ABC', kind: 'channel' });
    expect(await service.post({ agentSession: 'a', target: 'D0123ABC', text: 'x' })).toMatchObject({ channelId: 'D0123ABC', kind: 'dm' });
    expect(slack.dmOpens).toEqual([]);
  });

  // `general` is `G` plus six alphanumerics. Matching ids case-insensitively
  // would have read it as a private-channel id and posted nowhere.
  it('treats a lower-case target as a channel name, never as an id', async () => {
    slack.channels.gaming = { id: 'C-GAM', name: 'gaming', isArchived: false, isPrivate: false };
    expect(await service.post({ agentSession: 'a', target: 'gaming', text: 'x' })).toMatchObject({ channelId: 'C-GAM' });
    await expect(service.post({ agentSession: 'a', target: 'c0123abc', text: 'x' })).rejects.toMatchObject({
      code: 'target_not_found',
    });
  });

  it('opens a DM for a user id and for an @handle', async () => {
    expect(await service.post({ agentSession: 'a', target: 'U0123ABC', text: 'x' })).toMatchObject({ channelId: 'D-U0123ABC', kind: 'dm' });
    expect(await service.post({ agentSession: 'a', target: '@Steve', text: 'x' })).toMatchObject({ channelId: 'D-USTEVE', kind: 'dm' });
  });

  it('reports an unknown channel, an archived channel and an unknown handle', async () => {
    await expect(service.post({ agentSession: 'a', target: '#nope', text: 'x' })).rejects.toMatchObject({
      code: 'target_not_found',
      message: expect.stringContaining('#nope'),
    });
    await expect(service.post({ agentSession: 'a', target: '#old', text: 'x' })).rejects.toMatchObject({
      message: expect.stringContaining('archived'),
    });
    await expect(service.post({ agentSession: 'a', target: '@ghost', text: 'x' })).rejects.toMatchObject({
      code: 'target_not_found',
      message: expect.stringContaining('@ghost'),
    });
  });
});

describe('identity', () => {
  it("uses the agent's own bot token when installed, and opens the DM as that bot", async () => {
    identities!.installed['crewly-a-sam'] = { botUserId: 'USAM', botToken: 'xoxb-sam' };
    const res = await service.post({ agentSession: 'crewly-a-sam', target: '@steve', text: 'ping' });
    expect(res.postedAs).toBe('agent');
    expect(res.identity).toBe('Sam');
    expect(slack.dmOpens).toEqual([{ userId: 'USTEVE', botToken: 'xoxb-sam' }]);
    expect(slack.sent[0]).toEqual(expect.objectContaining({ botToken: 'xoxb-sam', skipChatV2Mirror: true }));
    expect(slack.sent[0].iconEmoji).toBeUndefined();
  });

  it('falls back to the shared bot with the member name and icon', async () => {
    const res = await service.post({ agentSession: 'crewly-a-sam', target: '#general', text: 'hi' });
    expect(res.postedAs).toBe('crewly');
    expect(slack.sent[0]).toEqual(expect.objectContaining({ username: 'Sam', iconEmoji: ':computer:' }));
    expect(slack.sent[0].botToken).toBeUndefined();
    expect(slack.dmOpens).toEqual([]);
  });

  it('works with no identity service and with an unknown agent', async () => {
    const bare = new SlackAgentPostService({ slack, storage: { getTeams: async () => TEAMS } });
    await bare.post({ agentSession: 'crewly-a-ghost', target: '#general', text: 'hi' });
    expect(slack.sent[0]).toEqual(expect.objectContaining({ username: 'crewly-a-ghost', iconEmoji: ':robot_face:' }));
  });

  it('survives a storage failure', async () => {
    const broken = new SlackAgentPostService({
      slack,
      storage: { getTeams: async () => { throw new Error('disk'); } },
      identities,
    });
    const res = await broken.post({ agentSession: 'crewly-a-sam', target: '#general', text: 'hi' });
    expect(res.postedAs).toBe('crewly');
    expect(slack.sent[0].username).toBe('crewly-a-sam');
  });

  it('forwards threadTs', async () => {
    await service.post({ agentSession: 'a', target: '#general', text: 'x', threadTs: '100.1' });
    expect(slack.sent[0].threadTs).toBe('100.1');
  });
});

describe('Slack failures get actionable messages', () => {
  it('explains not_in_channel with the right bot', async () => {
    slack.sendError = Object.assign(new Error('not_in_channel'), { data: { error: 'not_in_channel' } });
    await expect(service.post({ agentSession: 'crewly-a-sam', target: '#general', text: 'x' })).rejects.toMatchObject({
      code: 'slack_error',
      message: expect.stringContaining('invite the Crewly bot'),
    });
    identities!.installed['crewly-a-sam'] = { botUserId: 'USAM', botToken: 'xoxb-sam' };
    await expect(service.post({ agentSession: 'crewly-a-sam', target: '#general', text: 'x' })).rejects.toMatchObject({
      message: expect.stringContaining("invite this agent's Slack bot"),
    });
  });

  it('explains a missing scope on send and on DM open', async () => {
    slack.sendError = Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } });
    await expect(service.post({ agentSession: 'a', target: '#general', text: 'x' })).rejects.toMatchObject({
      message: expect.stringContaining('reinstall'),
    });
    slack.sendError = null;
    slack.openError = Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } });
    await expect(service.post({ agentSession: 'a', target: '@steve', text: 'x' })).rejects.toMatchObject({
      message: expect.stringContaining('im:write'),
    });
  });

  it('passes other Slack errors through', async () => {
    slack.sendError = Object.assign(new Error('rate_limited'), { data: { error: 'rate_limited' } });
    await expect(service.post({ agentSession: 'a', target: '#general', text: 'x' })).rejects.toMatchObject({
      message: 'Slack refused the post: rate_limited',
    });
  });
});

describe('singleton', () => {
  it('is null until set', () => {
    expect(getSlackAgentPostService()).toBeNull();
    setSlackAgentPostService(service);
    expect(getSlackAgentPostService()).toBe(service);
  });
  it('SlackAgentPostError carries its code', () => {
    expect(new SlackAgentPostError('validation', 'x').code).toBe('validation');
  });
});
