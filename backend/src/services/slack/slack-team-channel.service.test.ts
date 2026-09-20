/**
 * Tests for SlackTeamChannelService.
 *
 * Uses in-memory fakes for Slack, chat-v2 and storage so each behaviour
 * (create/link/unlink, lifecycle sync, inbound routing with threads and
 * mentions, outbound identity) is asserted without a socket or a database.
 *
 * @module services/slack/slack-team-channel.service.test
 */

import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import {
  SlackTeamChannelService,
  slackChannelNameFor,
  slackIdentityFor,
  teamChannelMembers,
  getSlackTeamChannelService,
  setSlackTeamChannelService,
  type TeamChannelChatApi,
  type TeamChannelIdentityApi,
  type TeamChannelSlackApi,
  type TeamChannelStorageApi,
} from './slack-team-channel.service.js';
import type { Team, TeamMember } from '../../types/index.js';
import type { SlackAgentIdentityRecord, SlackIncomingMessage, SlackOutgoingMessage } from '../../types/slack.types.js';
import type { ChatChannelDTO, ChatMessageDTO } from '../chat-v2/types.js';
import type { StorageEvent } from '../core/storage.service.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function member(name: string, role: TeamMember['role'], extra: Partial<TeamMember> = {}): TeamMember {
  return {
    id: `m-${name.toLowerCase()}`,
    name,
    sessionName: `crewly-alpha-${name.toLowerCase().replace(/\s+/g, '-')}`,
    role,
    systemPrompt: '',
    agentStatus: 'active',
    workingStatus: 'idle',
    runtimeType: 'claude-code',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  } as TeamMember;
}

function team(overrides: Partial<Team> = {}): Team {
  return {
    id: 'team-alpha',
    name: 'Alpha Team',
    description: 'Ships the alpha',
    members: [member('Sam', 'developer', { avatar: ':computer:' }), member('Leo', 'qa')],
    projectIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Team;
}

class FakeSlack implements TeamChannelSlackApi {
  connected = true;
  created: string[] = [];
  archived: string[] = [];
  joined: string[] = [];
  purposes: Array<{ id: string; purpose: string }> = [];
  sent: SlackOutgoingMessage[] = [];
  reactions: Array<{ channelId: string; ts: string; emoji: string; botToken?: string }> = [];
  channels = new Map<string, { id: string; name: string; isArchived: boolean; isPrivate: boolean }>();
  private seq = 0;
  private channelSeq = 0;

  isConnected(): boolean {
    return this.connected;
  }
  async createChannel(name: string) {
    this.created.push(name);
    const ch = { id: `C${++this.channelSeq}`, name, isArchived: false, isPrivate: false };
    this.channels.set(ch.id, ch);
    return ch;
  }
  async getChannelInfo(id: string) {
    return this.channels.get(id) ?? null;
  }
  async joinChannel(id: string) {
    this.joined.push(id);
  }
  async archiveChannel(id: string) {
    this.archived.push(id);
  }
  async setChannelPurpose(id: string, purpose: string) {
    this.purposes.push({ id, purpose });
  }
  async sendMessage(m: SlackOutgoingMessage) {
    this.sent.push(m);
    return `${++this.seq}.000`;
  }
  async addReaction(channelId: string, ts: string, emoji: string, botToken?: string) {
    this.reactions.push({ channelId, ts, emoji, ...(botToken ? { botToken } : {}) });
  }
  invites: Array<{ channelId: string; userIds: string[] }> = [];
  async inviteToChannel(channelId: string, userIds: string[]) {
    this.invites.push({ channelId, userIds });
  }
  renamed: Array<{ channelId: string; name: string }> = [];
  /** Set to make the next rename fail the way Slack does (name_taken, no scope). */
  renameFails = false;
  async renameChannel(channelId: string, name: string): Promise<string | null> {
    this.renamed.push({ channelId, name });
    if (this.renameFails) return null;
    const ch = this.channels.get(channelId);
    if (ch) ch.name = name;
    return name;
  }
}

/** Scripted stand-in for SlackAgentIdentityService. */
class FakeIdentities implements TeamChannelIdentityApi {
  available = true;
  records = new Map<string, SlackAgentIdentityRecord>();
  provisionCalls: string[] = [];
  provisionError: Error | null = null;
  private installedListeners: Array<(r: SlackAgentIdentityRecord) => void> = [];
  isAvailable() {
    return this.available;
  }
  async load() {
    return { version: 1 as const, identities: [...this.records.values()] };
  }
  async provision(agentSession: string, displayName: string) {
    this.provisionCalls.push(agentSession);
    if (this.provisionError) throw this.provisionError;
    const existing = this.records.get(agentSession);
    if (existing) return { ...existing };
    const rec: SlackAgentIdentityRecord = {
      agentSession,
      displayName,
      appId: `A-${agentSession}`,
      status: 'pending_install',
      installUrl: `https://slack.com/oauth/v2/authorize?state=${agentSession}`,
      announcedIn: [],
      invitedTo: [],
      updatedAt: 'now',
    };
    this.records.set(agentSession, rec);
    return { ...rec };
  }
  get(agentSession: string) {
    return this.records.get(agentSession) ?? null;
  }
  getInstalled(agentSession: string) {
    const r = this.records.get(agentSession);
    return r?.status === 'installed' && r.botUserId && r.botToken ? { botUserId: r.botUserId, botToken: r.botToken } : null;
  }
  async markChannel(agentSession: string, patch: { announcedIn?: string; invitedTo?: string }) {
    const r = this.records.get(agentSession);
    if (!r) return;
    if (patch.announcedIn) r.announcedIn.push(patch.announcedIn);
    if (patch.invitedTo) r.invitedTo.push(patch.invitedTo);
  }
  onInstalled(l: (r: SlackAgentIdentityRecord) => void) {
    this.installedListeners.push(l);
    return () => undefined;
  }
  /** Test helper: simulate the owner completing an install. */
  install(agentSession: string, botUserId: string, botToken: string) {
    const r = this.records.get(agentSession)!;
    r.status = 'installed';
    r.botUserId = botUserId;
    r.botToken = botToken;
    delete r.installUrl;
    for (const l of this.installedListeners) l({ ...r });
  }
}

/** Minimal in-memory chat-v2 double with the exact methods the service uses. */
class FakeChat extends EventEmitter {
  channels = new Map<string, ChatChannelDTO>();
  members = new Map<string, Set<string>>();
  messages: ChatMessageDTO[] = [];
  private seq = 0;

  createHuddle(args: { name: string; purpose?: string; memberSessions: string[] }): ChatChannelDTO {
    const id = `huddle-${++this.seq}`;
    const dto: ChatChannelDTO = {
      id,
      agentSession: '',
      name: args.name,
      purpose: args.purpose,
      createdAt: this.seq,
      archivedAt: null,
      lastMessageAt: null,
      agentPresence: { status: 'online', lastSeenAt: null },
      type: 'huddle',
    };
    this.channels.set(id, dto);
    this.members.set(id, new Set(args.memberSessions));
    return dto;
  }
  setHuddleMembers(id: string, sessions: string[]) {
    const cur = this.members.get(id) ?? new Set<string>();
    const wanted = new Set(sessions);
    const added = [...wanted].filter((s) => !cur.has(s));
    const removed = [...cur].filter((s) => !wanted.has(s));
    this.members.set(id, wanted);
    return { added, removed };
  }
  getChannelForBridge(id: string) {
    const ch = this.channels.get(id);
    return ch ? { ...ch, members: [...(this.members.get(id) ?? [])].map((s) => ({ sessionName: s, joinedAt: 1 })) } : null;
  }
  archiveChannelForBridge(id: string) {
    const ch = this.channels.get(id);
    if (!ch || ch.archivedAt) return false;
    ch.archivedAt = Date.now();
    return true;
  }
  recordTurn(input: {
    channelId: string;
    senderType: ChatMessageDTO['senderType'];
    senderId: string;
    content: string;
    threadId?: string;
    mentions?: string[];
    metadata: Record<string, unknown>;
  }) {
    const dto: ChatMessageDTO = {
      id: `msg-${++this.seq}`,
      channelId: input.channelId,
      seq: this.seq,
      senderType: input.senderType,
      senderId: input.senderId,
      content: input.content,
      contentType: 'markdown',
      createdAt: this.seq,
      attachments: [],
      metadata: input.metadata,
      mentions: input.mentions ?? [],
      threadId: input.threadId,
    };
    this.messages.push(dto);
    return { message: dto, deduped: false };
  }
  findSlackThreadRoot(channelId: string, ts: string) {
    return (
      [...this.messages]
        .reverse()
        .find((m) => m.channelId === channelId && !m.threadId && m.metadata?.slackThreadTs === ts) ?? null
    );
  }
  findLatestSlackRoot(channelId: string) {
    return (
      [...this.messages]
        .reverse()
        .find((m) => m.channelId === channelId && !m.threadId && typeof m.metadata?.slackThreadTs === 'string') ??
      null
    );
  }
  getMessageForBridge(id: string) {
    return this.messages.find((m) => m.id === id) ?? null;
  }
}

class FakeStorage implements TeamChannelStorageApi {
  teams: Team[] = [];
  listeners: Array<(e: StorageEvent) => Promise<void> | void> = [];
  async getTeams() {
    return this.teams;
  }
  onStorageEvent(l: (e: StorageEvent) => Promise<void> | void) {
    this.listeners.push(l);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l);
    };
  }
  async emit(e: StorageEvent) {
    for (const l of this.listeners) await l(e);
  }
}

function inbound(overrides: Partial<SlackIncomingMessage> = {}): SlackIncomingMessage {
  return {
    id: '100.1',
    type: 'message',
    text: 'hello team',
    userId: 'U1',
    channelId: 'C1',
    ts: '100.1',
    teamId: 'T1',
    eventTs: '100.1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tmpDir: string;
let slack: FakeSlack;
let chat: FakeChat;
let storage: FakeStorage;
let dispatcher: { dispatchMessage: jest.Mock } | null;
let identities: FakeIdentities | null;
let service: SlackTeamChannelService;
let ownerUserId: string | null = 'UOWNER';
let typing: { begin: jest.Mock; resolve: jest.Mock; setPhase: jest.Mock; fail: jest.Mock } | null = null;
let awake: (s: string) => boolean = () => true;
let isLocal: (s: string) => boolean = () => false;

function makeService() {
  return new SlackTeamChannelService({
    slack,
    chat: chat as unknown as TeamChannelChatApi,
    storage,
    getDispatcher: () => dispatcher,
    identities,
    typing,
    isAgentAwake: (s) => awake(s),
    isLocalAgent: (s) => isLocal(s),
    getOwnerUserId: () => ownerUserId,
    storePath: path.join(tmpDir, 'slack-team-channels.json'),
    now: () => new Date('2026-09-12T00:00:00.000Z'),
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-slack-team-'));
  slack = new FakeSlack();
  chat = new FakeChat();
  storage = new FakeStorage();
  storage.teams = [team()];
  dispatcher = { dispatchMessage: jest.fn().mockResolvedValue({ strategy: 'huddle-broadcast', dispatched: true }) };
  identities = null;
  service = makeService();
});

afterEach(async () => {
  service.stop();
  setSlackTeamChannelService(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('slackChannelNameFor', () => {
  it('lower-cases, collapses punctuation and applies the prefix', () => {
    expect(slackChannelNameFor('Growth Team!')).toBe('growth-team');
    expect(slackChannelNameFor('Growth Team', 'crew-')).toBe('crew-growth-team');
    expect(slackChannelNameFor('  A  ..  B ')).toBe('a-b');
  });
  it('keeps CJK letters and never returns empty', () => {
    expect(slackChannelNameFor('增长 团队')).toBe('增长-团队');
    expect(slackChannelNameFor('!!!')).toBe('team');
  });
  it('caps at 80 characters', () => {
    expect(slackChannelNameFor('x'.repeat(100))).toHaveLength(80);
  });
});

describe('teamChannelMembers', () => {
  it('excludes the orchestrator and derives a session name for an idle member (stop clears it)', () => {
    const t = team({
      name: 'Think Tank',
      members: [member('Sam', 'developer'), member('Orc', 'orchestrator'), member('Sage', 'qa', { sessionName: '', id: 'c1d2e3f4-0000-4000-8000-000000000000' })],
    });
    const got = teamChannelMembers(t);
    expect(got.map((m) => m.name)).toEqual(['Sam', 'Sage']);
    expect(got[1].sessionName).toBe('think-tank-sage-c1d2e3f4');
  });
});

describe('slackIdentityFor', () => {
  it('uses an emoji avatar', () => {
    expect(slackIdentityFor(member('Sam', 'developer', { avatar: ':rocket:' }), 's')).toEqual({
      username: 'Sam',
      iconEmoji: ':rocket:',
    });
  });
  it('uses a URL avatar', () => {
    expect(slackIdentityFor(member('Sam', 'developer', { avatar: 'https://x/a.png' }), 's')).toEqual({
      username: 'Sam',
      iconUrl: 'https://x/a.png',
    });
  });
  it('falls back to the role emoji, then the default', () => {
    expect(slackIdentityFor(member('Leo', 'qa'), 's').iconEmoji).toBe(':mag:');
    expect(slackIdentityFor(member('Zed', 'unknown-role' as TeamMember['role']), 's').iconEmoji).toBe(':robot_face:');
    expect(slackIdentityFor(undefined, 'crewly-x-y')).toEqual({ username: 'crewly-x-y', iconEmoji: ':robot_face:' });
  });
});

// ---------------------------------------------------------------------------
// Store + create/link/unlink
// ---------------------------------------------------------------------------

describe('ensureTeamChannel', () => {
  it('creates a Slack channel, a huddle with the members, persists the mapping and posts a welcome', async () => {
    const mapping = await service.ensureTeamChannel(team());

    expect(slack.created).toEqual(['alpha-team']);
    // A bot-created channel is invisible until someone joins: the owner is invited first.
    expect(slack.invites).toEqual([{ channelId: 'C1', userIds: ['UOWNER'] }]);
    expect(slack.purposes[0]).toEqual({ id: 'C1', purpose: 'Ships the alpha' });
    expect(mapping).toMatchObject({
      teamId: 'team-alpha',
      slackChannelId: 'C1',
      slackChannelName: 'alpha-team',
      chatChannelId: 'huddle-1',
      autoCreated: true,
      createdAt: '2026-09-12T00:00:00.000Z',
    });
    expect([...chat.members.get('huddle-1')!]).toEqual(['crewly-alpha-sam', 'crewly-alpha-leo']);
    expect(chat.channels.get('huddle-1')?.name).toBe('#alpha-team');

    const welcome = slack.sent[0];
    expect(welcome.channelId).toBe('C1');
    expect(welcome.text).toContain('Alpha Team');
    expect(welcome.text).toContain('@Sam');
    expect(welcome.skipChatV2Mirror).toBe(true);

    const onDisk = JSON.parse(await fs.readFile(path.join(tmpDir, 'slack-team-channels.json'), 'utf-8'));
    expect(onDisk.mappings).toHaveLength(1);
    expect(onDisk.version).toBe(1);
  });

  it('still creates the channel when no owner id is known (self-hosted app)', async () => {
    ownerUserId = null;
    try {
      const mapping = await service.ensureTeamChannel(team());
      expect(mapping.slackChannelId).toBe('C1');
      expect(slack.invites).toEqual([]);
    } finally {
      ownerUserId = 'UOWNER';
    }
  });

  it('is idempotent and re-syncs the roster on a second call', async () => {
    await service.ensureTeamChannel(team());
    const again = await service.ensureTeamChannel(team({ members: [member('Sam', 'developer')] }));
    expect(again.slackChannelId).toBe('C1');
    expect(slack.created).toHaveLength(1);
    expect([...chat.members.get('huddle-1')!]).toEqual(['crewly-alpha-sam']);
  });

  it('links an existing channel instead of creating when slackChannelId is given', async () => {
    slack.channels.set('C77', { id: 'C77', name: 'ops', isArchived: false, isPrivate: false });
    const mapping = await service.ensureTeamChannel(team(), { slackChannelId: 'C77' });
    expect(slack.created).toEqual([]);
    expect(slack.joined).toEqual(['C77']);
    expect(mapping).toMatchObject({ slackChannelId: 'C77', slackChannelName: 'ops', autoCreated: false });
  });

  it('refuses to link an unknown or archived channel', async () => {
    await expect(service.ensureTeamChannel(team(), { slackChannelId: 'C404' })).rejects.toThrow(/not found/);
    slack.channels.set('C9', { id: 'C9', name: 'old', isArchived: true, isPrivate: false });
    await expect(service.ensureTeamChannel(team(), { slackChannelId: 'C9' })).rejects.toThrow(/archived/);
  });

  it('throws when Slack is not connected', async () => {
    slack.connected = false;
    await expect(service.ensureTeamChannel(team())).rejects.toThrow('Slack is not connected');
  });

  it('applies the configured channel prefix', async () => {
    await service.updateSettings({ channelPrefix: 'crew-' });
    await service.ensureTeamChannel(team());
    expect(slack.created).toEqual(['crew-alpha-team']);
  });

  it('serialises concurrent ensures for the same team into one channel', async () => {
    const [a, b] = await Promise.all([service.ensureTeamChannel(team()), service.ensureTeamChannel(team())]);
    expect(a.slackChannelId).toBe(b.slackChannelId);
    expect(slack.created).toHaveLength(1);
  });

  it('survives a corrupt store file', async () => {
    await fs.writeFile(path.join(tmpDir, 'slack-team-channels.json'), '{not json');
    const fresh = makeService();
    expect(await fresh.listMappings()).toEqual([]);
    expect(await fresh.getSettings()).toEqual({ autoCreate: true, channelPrefix: '' });
  });

  it('reloads persisted mappings in a new instance', async () => {
    await service.ensureTeamChannel(team());
    const fresh = makeService();
    const list = await fresh.listMappings();
    expect(list[0].slackChannelId).toBe('C1');
    expect(fresh.findBySlackChannelId('C1')?.teamId).toBe('team-alpha');
    expect(fresh.findByChatChannelId('huddle-1')?.teamId).toBe('team-alpha');
    expect(fresh.findByTeamId('nope')).toBeNull();
  });
});

describe('listTeamsWithMappings / getTeam', () => {
  it('lists non-archived teams with their mapping', async () => {
    storage.teams = [team(), team({ id: 'team-b', name: 'B' }), team({ id: 'team-z', name: 'Z', archived: true })];
    await service.ensureTeamChannel(team());
    const rows = await service.listTeamsWithMappings();
    expect(rows.map((r) => r.teamId)).toEqual(['team-alpha', 'team-b']);
    expect(rows[0]).toMatchObject({ teamName: 'Alpha Team', memberCount: 2 });
    expect(rows[0].mapping?.slackChannelId).toBe('C1');
    expect(rows[1].mapping).toBeNull();
    expect((await service.getTeam('team-b'))?.name).toBe('B');
    expect(await service.getTeam('nope')).toBeNull();
  });
});

describe('unlinkTeam', () => {
  it('drops the mapping, archives the huddle, and archives Slack only when asked', async () => {
    await service.ensureTeamChannel(team());
    expect(await service.unlinkTeam('team-alpha')).toBe(true);
    expect(chat.channels.get('huddle-1')?.archivedAt).not.toBeNull();
    expect(slack.archived).toEqual([]);
    expect(await service.listMappings()).toEqual([]);
    expect(await service.unlinkTeam('team-alpha')).toBe(false);

    await service.ensureTeamChannel(team());
    await service.unlinkTeam('team-alpha', { archiveSlackChannel: true });
    expect(slack.archived).toEqual(['C2']);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('team lifecycle sync', () => {
  it('auto-creates when a NEW team is saved and Slack is connected', async () => {
    await service.start();
    await storage.emit({ kind: 'team-saved', team: team(), created: true });
    expect(slack.created).toEqual(['alpha-team']);
  });

  // Every status write is also a team-saved event. Pre-existing teams must
  // not sprout Slack channels just because an agent went idle.
  it('does NOT auto-create for an update of an unmapped, pre-existing team', async () => {
    await service.start();
    await storage.emit({ kind: 'team-saved', team: team(), created: false });
    expect(slack.created).toEqual([]);
    expect(await service.listMappings()).toEqual([]);
  });

  it('does nothing on a new team when autoCreate is off', async () => {
    await service.updateSettings({ autoCreate: false });
    await service.start();
    await storage.emit({ kind: 'team-saved', team: team(), created: true });
    expect(slack.created).toEqual([]);
  });

  it('start() gives every existing team with members a channel (auto-create on), skipping empty teams and existing mappings', async () => {
    storage.teams = [team(), team({ id: 'team-empty', name: 'Empty', members: [] })];
    await service.start();
    await new Promise((r) => setImmediate(r));
    expect(slack.created).toEqual(['alpha-team']);
    expect((await service.reconcileAllTeams())).toEqual({ created: [], skipped: 1 });
  });

  it('does nothing when Slack is offline (no crash, no mapping)', async () => {
    slack.connected = false;
    await service.start();
    await storage.emit({ kind: 'team-saved', team: team(), created: true });
    expect(await service.listMappings()).toEqual([]);
  });

  it('syncs the roster on a later team-saved update', async () => {
    await service.start();
    await storage.emit({ kind: 'team-saved', team: team(), created: true });
    await storage.emit({
      kind: 'team-saved',
      team: team({ members: [member('Sam', 'developer'), member('Leo', 'qa'), member('Mia', 'designer')] }),
      created: false,
    });
    expect([...chat.members.get('huddle-1')!]).toContain('crewly-alpha-mia');
  });

  it('renames the Slack channel when the team is renamed', async () => {
    // Renaming a team used to leave #alpha-team on its old name forever, and
    // the owner had to rename it by hand (2026-09-20, #strategy).
    await service.start();
    await storage.emit({ kind: 'team-saved', team: team(), created: true });
    expect(slack.created).toEqual(['alpha-team']);

    await storage.emit({ kind: 'team-saved', team: team({ name: 'Crewly Strategy Team' }), created: false });

    expect(slack.renamed).toEqual([{ channelId: 'C1', name: 'crewly-strategy-team' }]);
    expect((await service.listMappings())[0]).toMatchObject({
      slackChannelName: 'crewly-strategy-team',
      derivedName: 'crewly-strategy-team',
    });
  });

  it('does not rename on an update that left the name alone', async () => {
    // team-saved also fires on every status write; those must cost nothing.
    await service.start();
    await storage.emit({ kind: 'team-saved', team: team(), created: true });
    await storage.emit({ kind: 'team-saved', team: team(), created: false });
    expect(slack.renamed).toEqual([]);
  });

  it('leaves a channel the owner renamed themselves, and records their name', async () => {
    await service.start();
    await storage.emit({ kind: 'team-saved', team: team(), created: true });
    // The owner renames it in Slack; Crewly's derived name no longer matches.
    slack.channels.get('C1')!.name = 'war-room';

    await storage.emit({ kind: 'team-saved', team: team({ name: 'Crewly Strategy Team' }), created: false });

    expect(slack.renamed).toEqual([]);
    expect((await service.listMappings())[0]).toMatchObject({
      slackChannelName: 'war-room',
      derivedName: 'war-room',
    });
  });

  it('never renames a channel the owner linked rather than Crewly creating it', async () => {
    await service.start();
    slack.channels.set('C99', { id: 'C99', name: 'existing-room', isArchived: false, isPrivate: false });
    await service.ensureTeamChannel(team(), { slackChannelId: 'C99' });

    await storage.emit({ kind: 'team-saved', team: team({ name: 'Renamed Team' }), created: false });

    expect(slack.renamed).toEqual([]);
    expect((await service.listMappings())[0]!.slackChannelName).toBe('existing-room');
  });

  it('keeps the team update working when Slack refuses the rename', async () => {
    await service.start();
    await storage.emit({ kind: 'team-saved', team: team(), created: true });
    slack.renameFails = true;

    await storage.emit({ kind: 'team-saved', team: team({ name: 'Taken Name' }), created: false });

    expect(slack.renamed).toHaveLength(1);
    // The old name stands rather than the store claiming a rename that never happened.
    expect((await service.listMappings())[0]!.slackChannelName).toBe('alpha-team');
  });

  it('renames again after a team is renamed twice', async () => {
    await service.start();
    await storage.emit({ kind: 'team-saved', team: team(), created: true });
    await storage.emit({ kind: 'team-saved', team: team({ name: 'Second Name' }), created: false });
    await storage.emit({ kind: 'team-saved', team: team({ name: 'Third Name' }), created: false });
    expect(slack.renamed.map((r) => r.name)).toEqual(['second-name', 'third-name']);
  });

  it('archives both sides when the team is archived or deleted', async () => {
    await service.start();
    await storage.emit({ kind: 'team-saved', team: team(), created: true });
    await storage.emit({ kind: 'team-saved', team: team({ archived: true }), created: false });
    expect(slack.archived).toEqual(['C1']);
    expect(await service.listMappings()).toEqual([]);

    await storage.emit({ kind: 'team-saved', team: team({ id: 'team-b', name: 'B' }), created: true });
    await storage.emit({ kind: 'team-deleted', teamId: 'team-b' });
    expect(slack.archived).toEqual(['C1', 'C2']);
  });

  it('stop() unsubscribes', async () => {
    await service.start();
    service.stop();
    await storage.emit({ kind: 'team-saved', team: team(), created: true });
    expect(slack.created).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

describe('routeInbound', () => {
  beforeEach(async () => {
    await service.ensureTeamChannel(team());
    slack.sent = [];
  });

  it('returns null for an unmapped channel', async () => {
    expect(await service.routeInbound(inbound({ channelId: 'C-other' }))).toBeNull();
  });

  it('persists a root message into the huddle with Slack correlation and dispatches with reply-channel + thread', async () => {
    const result = await service.routeInbound(inbound({ text: '@sam 看一下', userId: 'U1' }));
    expect(result).not.toBeNull();
    const msg = result!.message;
    expect(msg.channelId).toBe('huddle-1');
    expect(msg.senderType).toBe('user');
    expect(msg.mentions).toEqual(['crewly-alpha-sam']);
    expect(msg.threadId).toBeUndefined();
    expect(msg.metadata).toMatchObject({ source: 'slack', slackChannelId: 'C1', slackThreadTs: '100.1', slackTs: '100.1' });

    expect(dispatcher!.dispatchMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'huddle-1', type: 'huddle' }),
      expect.objectContaining({ id: msg.id }),
      { threadId: msg.id, replyVia: 'reply-channel' },
    );
    expect(slack.reactions).toEqual([{ channelId: 'C1', ts: '100.1', emoji: 'eyes' }]);
    expect(slack.sent).toEqual([]); // no hint: mention resolved
  });

  it('a message written by an agent on another machine is recorded under its name as an outside voice and dispatched', async () => {
    const result = await service.routeInbound(
      inbound({ text: '<@USAM> can you check?', userId: 'UMIA', authorAgentSession: 'remote-team-mia', authorDisplayName: 'Mia' }),
    );
    expect(result).not.toBeNull();
    const msg = result!.message;
    expect(msg.senderType).toBe('user');
    expect(msg.senderId).toBe('Mia (agent)');
    expect(msg.metadata).toMatchObject({ source: 'slack', remoteAgentSession: 'remote-team-mia' });
    expect(dispatcher!.dispatchMessage).toHaveBeenCalled();
  });

  it('a local agent\'s own Slack copy is dispatched to the colleagues it @\'d, not recorded again, and not sent back to itself', async () => {
    isLocal = (s) => s === 'crewly-alpha-leo';
    service = makeService();
    await service.ensureTeamChannel(team());
    const before = chat.messages.length;
    const result = await service.routeInbound(
      inbound({ text: '<@USAM> 你怎么看', ts: '400.1', userId: 'ULEO', authorAgentSession: 'crewly-alpha-leo', authorDisplayName: 'Leo' }),
    );
    expect(result).not.toBeNull();
    expect(chat.messages.length).toBe(before); // reply-channel already stored Leo's turn
    expect(result!.message.senderId).toBe('Leo (agent)');
    expect(dispatcher!.dispatchMessage).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ senderId: 'Leo (agent)', content: '<@USAM> 你怎么看' }),
      expect.objectContaining({ excludeSessions: ['crewly-alpha-leo'] }),
    );
    isLocal = () => false;
  });

  it('files a Slack thread reply under the matching chat-v2 root', async () => {
    const root = await service.routeInbound(inbound({ ts: '100.1' }));
    const reply = await service.routeInbound(inbound({ ts: '100.2', threadTs: '100.1', text: 'more' }));
    expect(reply!.message.threadId).toBe(root!.message.id);
    expect(dispatcher!.dispatchMessage).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      { threadId: root!.message.id, replyVia: 'reply-channel' },
    );
  });

  it('treats a reply to an unknown Slack thread as a new root keyed by that thread', async () => {
    const reply = await service.routeInbound(inbound({ ts: '300.5', threadTs: '300.1', text: 'late' }));
    expect(reply!.message.threadId).toBeUndefined();
    expect(reply!.message.metadata?.slackThreadTs).toBe('300.1');
  });

  it('answers an unknown @name in-thread with suggestions but still dispatches to the team', async () => {
    const result = await service.routeInbound(inbound({ text: '@lee 帮忙' }));
    expect(result!.mentions).toEqual([]);
    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
    const hint = slack.sent.find((m) => m.threadTs === '100.1');
    expect(hint?.text).toContain('@lee');
    expect(hint?.text).toContain('@Leo');
    expect(hint?.text).toContain('@Sam');
    expect(hint?.skipChatV2Mirror).toBe(true);
  });

  it('persists but reports no dispatch when no dispatcher is wired', async () => {
    dispatcher = null;
    const result = await service.routeInbound(inbound());
    expect(result!.dispatch).toBeNull();
    expect(chat.messages).toHaveLength(1);
  });

  it('drops a mapping whose huddle vanished', async () => {
    chat.channels.delete('huddle-1');
    expect(await service.routeInbound(inbound())).toBeNull();
    expect(await service.listMappings()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

describe('mirrorOutbound', () => {
  beforeEach(async () => {
    await service.ensureTeamChannel(team());
    await service.start();
    slack.sent = [];
  });

  function agentMessage(overrides: Partial<ChatMessageDTO> = {}): ChatMessageDTO {
    return {
      id: 'reply-1',
      channelId: 'huddle-1',
      seq: 99,
      senderType: 'agent',
      senderId: 'crewly-alpha-sam',
      content: 'done ✅',
      contentType: 'markdown',
      createdAt: 1,
      attachments: [],
      mentions: [],
      metadata: { source: 'reply-tool' },
      ...overrides,
    };
  }

  it('turns @Name into a real mention of that agent\'s bot user (any agent of the account), leaving unknown names alone', async () => {
    identities = new FakeIdentities();
    service = makeService();
    identities.records.set('crewly-alpha-leo', {
      agentSession: 'crewly-alpha-leo', displayName: 'Leo', appId: 'A-leo', status: 'installed', botUserId: 'ULEO', botToken: 'xoxb-leo', announcedIn: [], invitedTo: [],
    } as unknown as SlackAgentIdentityRecord);
    identities.records.set('remote-team-mia', {
      agentSession: 'remote-team-mia', displayName: 'Mia', appId: 'A-mia', status: 'installed', botUserId: 'UMIA', botToken: 'xoxb-mia', announcedIn: [], invitedTo: [],
    } as unknown as SlackAgentIdentityRecord);
    expect(await service.linkAgentMentions('@Leo and @mia please; @Nobody too, email a@b.c')).toBe('<@ULEO> and <@UMIA> please; @Nobody too, email a@b.c');
    expect(await service.linkAgentMentions('no mentions')).toBe('no mentions');
  });

  it('posts an agent reply into the Slack thread of its chat-v2 thread root, as the agent', async () => {
    const root = await service.routeInbound(inbound({ ts: '100.1', text: '@sam go' }));
    slack.sent = [];
    expect(await service.mirrorOutbound(agentMessage({ threadId: root!.message.id }))).toBe(true);
    expect(slack.sent).toEqual([
      expect.objectContaining({
        channelId: 'C1',
        threadTs: '100.1',
        text: 'done ✅',
        username: 'Sam',
        iconEmoji: ':computer:',
        skipChatV2Mirror: true,
      }),
    ]);
  });

  it('falls back to the latest Slack root when the reply has no thread', async () => {
    await service.routeInbound(inbound({ ts: '100.1' }));
    await service.routeInbound(inbound({ ts: '200.1' }));
    slack.sent = [];
    await service.mirrorOutbound(agentMessage({ senderId: 'crewly-alpha-leo' }));
    expect(slack.sent[0]).toEqual(expect.objectContaining({ threadTs: '200.1', username: 'Leo', iconEmoji: ':mag:' }));
  });

  it('posts top-level when the huddle has never seen a Slack message', async () => {
    await service.mirrorOutbound(agentMessage());
    expect(slack.sent[0].threadTs).toBeUndefined();
  });

  it('ignores user messages, Slack-origin messages, unmapped channels, and offline Slack', async () => {
    expect(await service.mirrorOutbound(agentMessage({ senderType: 'user' }))).toBe(false);
    expect(await service.mirrorOutbound(agentMessage({ metadata: { source: 'slack' } }))).toBe(false);
    expect(await service.mirrorOutbound(agentMessage({ channelId: 'huddle-zzz' }))).toBe(false);
    slack.connected = false;
    expect(await service.mirrorOutbound(agentMessage())).toBe(false);
    expect(slack.sent).toEqual([]);
  });

  it('names the reason in the log whenever a reply is not mirrored', async () => {
    // Until 2026-09-19 every skip was a silent `return false`: an agent could
    // answer, be told the reply was delivered, and leave the owner staring at
    // an unanswered Slack thread with nothing in the log to explain it.
    const logged: Array<Record<string, unknown>> = [];
    (service as unknown as { logger: { info: unknown } }).logger.info = (_m: string, ctx: Record<string, unknown>) => {
      logged.push(ctx);
    };

    await service.mirrorOutbound(agentMessage({ senderType: 'user' }));
    await service.mirrorOutbound(agentMessage({ metadata: { source: 'slack' } }));
    await service.mirrorOutbound(agentMessage({ channelId: 'huddle-zzz' }));
    slack.connected = false;
    await service.mirrorOutbound(agentMessage());

    expect(logged.map((c) => c['reason'])).toEqual([
      'senderType=user',
      'inbound-from-slack',
      'channel-not-mapped-to-slack',
      'slack-not-connected',
    ]);
  });

  it('logs the mirror that did happen, so a missing reply is distinguishable from a silent skip', async () => {
    const logged: Array<Record<string, unknown>> = [];
    (service as unknown as { logger: { info: unknown } }).logger.info = (_m: string, ctx: Record<string, unknown>) => {
      logged.push(ctx);
    };
    await service.mirrorOutbound(agentMessage());
    expect(logged).toHaveLength(1);
    expect(logged[0]).toEqual(expect.objectContaining({ sender: expect.any(String) }));
  });

  it('is driven by the chat-v2 chat_message event once started', async () => {
    chat.emit('chat_message', agentMessage());
    await new Promise((r) => setImmediate(r));
    expect(slack.sent).toHaveLength(1);
  });

  it('uses the session name when the sender is not a known member', async () => {
    await service.mirrorOutbound(agentMessage({ senderId: 'crewly-alpha-ghost' }));
    expect(slack.sent[0]).toEqual(expect.objectContaining({ username: 'crewly-alpha-ghost', iconEmoji: ':robot_face:' }));
  });
});

// ---------------------------------------------------------------------------
// Real agent identities (Cloud-provisioned bot users)
// ---------------------------------------------------------------------------

describe('agent identities', () => {
  beforeEach(() => {
    identities = new FakeIdentities();
    service = makeService();
  });

  it('provisions an identity per member and announces the install links once in the channel', async () => {
    await service.ensureTeamChannel(team());
    expect(identities!.provisionCalls).toEqual(['crewly-alpha-sam', 'crewly-alpha-leo']);
    const announce = slack.sent.find((m) => m.text.includes('创建了 Slack 身份'));
    expect(announce?.channelId).toBe('C1');
    expect(announce?.text).toContain('安装 Sam');
    expect(announce?.text).toContain('state=crewly-alpha-leo');
    expect(identities!.get('crewly-alpha-sam')?.announcedIn).toEqual(['C1']);

    // A second roster sync must not re-announce.
    slack.sent = [];
    await service.syncTeamMembers(team());
    expect(slack.sent.find((m) => m.text.includes('创建了 Slack 身份'))).toBeUndefined();
  });

  it('invites an installed bot into the channel once and posts as that bot afterwards', async () => {
    await service.ensureTeamChannel(team());
    await service.start();
    identities!.install('crewly-alpha-sam', 'USAM', 'xoxb-sam');
    await new Promise((r) => setImmediate(r));
    expect(slack.invites.filter((i) => !i.userIds.includes('UOWNER'))).toEqual([{ channelId: 'C1', userIds: ['USAM'] }]);
    expect(identities!.get('crewly-alpha-sam')?.invitedTo).toEqual(['C1']);

    // Later syncs do not re-invite.
    await service.syncTeamMembers(team());
    expect(slack.invites.filter((i) => !i.userIds.includes('UOWNER'))).toHaveLength(1);

    // Outbound uses the agent's own token, no cosmetic identity.
    slack.sent = [];
    await service.mirrorOutbound({
      id: 'r1',
      channelId: 'huddle-1',
      seq: 1,
      senderType: 'agent',
      senderId: 'crewly-alpha-sam',
      content: 'as myself',
      contentType: 'markdown',
      createdAt: 1,
      attachments: [],
      mentions: [],
      metadata: { source: 'reply-tool' },
    });
    expect(slack.sent[0]).toEqual(expect.objectContaining({ botToken: 'xoxb-sam', text: 'as myself' }));
    expect(slack.sent[0].username).toBeUndefined();

    // Leo (not installed) still gets the cosmetic identity.
    await service.mirrorOutbound({
      id: 'r2',
      channelId: 'huddle-1',
      seq: 2,
      senderType: 'agent',
      senderId: 'crewly-alpha-leo',
      content: 'cosmetic',
      contentType: 'markdown',
      createdAt: 2,
      attachments: [],
      mentions: [],
      metadata: { source: 'reply-tool' },
    });
    expect(slack.sent[1]).toEqual(expect.objectContaining({ username: 'Leo', iconEmoji: ':mag:' }));
    expect(slack.sent[1].botToken).toBeUndefined();
  });

  it('shows "waking up…" in the thread for an idle @\'d agent before dispatch, "is working on it…" after, then edits it into the reply', async () => {
    typing = { begin: jest.fn().mockResolvedValue(null), resolve: jest.fn().mockResolvedValue('edited'), setPhase: jest.fn().mockResolvedValue(undefined), fail: jest.fn().mockResolvedValue(undefined) };
    awake = () => false;
    dispatcher = { dispatchMessage: jest.fn().mockResolvedValue({ strategy: 'huddle-broadcast', dispatched: true, huddleOutcomes: [{ sessionName: 'crewly-alpha-sam', responseMode: 'required', dispatched: true }] }) };
    service = makeService();
    await service.ensureTeamChannel(team());
    identities!.install('crewly-alpha-sam', 'USAM', 'xoxb-sam');
    const result = await service.routeInbound(inbound({ text: '<@USAM> 看一下', ts: '100.1' }));
    expect(result!.mentions).toEqual(['crewly-alpha-sam']);
    expect(typing.begin).toHaveBeenCalledWith(
      { agentSession: 'crewly-alpha-sam', slackChannelId: 'C1', threadTs: '100.1' },
      { botToken: 'xoxb-sam', displayName: 'Sam' },
      'waking',
    );
    expect(typing.begin.mock.invocationCallOrder[0]).toBeLessThan(dispatcher.dispatchMessage.mock.invocationCallOrder[0]);
    expect(typing.setPhase).toHaveBeenCalledWith({ agentSession: 'crewly-alpha-sam', slackChannelId: 'C1', threadTs: '100.1' }, 'typing');
    expect(typing.fail).not.toHaveBeenCalled();
    awake = () => true;

    const root = chat.messages.find((m) => m.metadata?.slackTs === '100.1');
    await service.mirrorOutbound({
      id: 'reply-1', channelId: 'huddle-1', seq: 99, senderType: 'agent', senderId: 'crewly-alpha-sam', content: 'done ✅',
      contentType: 'markdown', createdAt: 1, attachments: [], mentions: [], metadata: { source: 'reply-tool' }, threadId: root!.id,
    } as ChatMessageDTO);
    expect(typing.resolve).toHaveBeenCalledWith(
      { agentSession: 'crewly-alpha-sam', slackChannelId: 'C1', threadTs: '100.1' },
      'done ✅',
      { botToken: 'xoxb-sam', displayName: 'Sam' },
    );
    typing = null;
  });

  it('routes a repeated copy of one Slack message (app_mention + message) only once', async () => {
    await service.ensureTeamChannel(team());
    const first = await service.routeInbound(inbound({ text: '@sam 看一下', ts: '200.1' }));
    const again = await service.routeInbound(inbound({ text: '@sam 看一下', ts: '200.1' }));
    expect(first!.duplicate).toBeUndefined();
    expect(again!.duplicate).toBe(true);
    expect(again!.message.id).toBe(first!.message.id);
    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
    expect(chat.messages.filter((m) => m.metadata?.slackTs === '200.1')).toHaveLength(1);
  });

  it('links any channel on the fly when a local agent bot is @\'d there, growing its roster as more agents are @\'d', async () => {
    await service.ensureTeamChannel(team()); // provisions the identities
    identities!.install('crewly-alpha-sam', 'USAM', 'xoxb-sam');
    identities!.install('crewly-alpha-leo', 'ULEO', 'xoxb-leo');
    dispatcher!.dispatchMessage.mockClear();
    // A private channel the master bot cannot see, nobody local @'d → not ours.
    expect(await service.routeInbound(inbound({ channelId: 'C-priv', text: 'hello everyone' }))).toBeNull();
    expect(await service.routeInbound(inbound({ channelId: 'C-priv', text: '<@USOMEONE> hi' }))).toBeNull();

    const first = await service.routeInbound(inbound({ channelId: 'C-priv', text: '<@USAM> 自我介绍一下', ts: '300.1' }));
    expect(first).not.toBeNull();
    expect(first!.mapping.teamId).toBe('adhoc:C-priv');
    expect(first!.mapping.members).toEqual(['crewly-alpha-sam']);
    expect(first!.mentions).toEqual(['crewly-alpha-sam']);
    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
    // The seen-reaction comes from Sam's bot (master bot is not a member).
    expect(slack.reactions.at(-1)).toMatchObject({ channelId: 'C-priv', botToken: 'xoxb-sam' });

    const second = await service.routeInbound(inbound({ channelId: 'C-priv', text: '<@ULEO> 你呢', ts: '300.2' }));
    expect(second!.mapping.chatChannelId).toBe(first!.mapping.chatChannelId);
    expect(second!.mapping.members).toEqual(['crewly-alpha-sam', 'crewly-alpha-leo']);
    expect(service.findBySlackChannelId('C-priv')?.members).toEqual(['crewly-alpha-sam', 'crewly-alpha-leo']);

    // A later message that @'s nobody local (e.g. the master bot: "@Crewly
    // who leads content?") still gets 👀 — from a huddle member's bot, since
    // the master bot is not in the private channel (2026-09-19, #steamfun-portal).
    slack.reactions.length = 0;
    const third = await service.routeInbound(inbound({ channelId: 'C-priv', text: '<@UMASTER> 负责内容的Team lead是谁？', ts: '300.3' }));
    expect(third).not.toBeNull();
    expect(third!.mentions).toEqual([]);
    expect(slack.reactions.at(-1)).toMatchObject({ channelId: 'C-priv', ts: '300.3', botToken: 'xoxb-sam' });
    // …and the recipient gets a roster it can answer "who leads?" from, even
    // though the directory cannot list a private channel's members.
    const prompt = String(dispatcher!.dispatchMessage.mock.calls.at(-1)![2].channelRoster ?? '');
    expect(prompt).toContain('Sam (');
    expect(prompt).toContain('Leo (');
  });

  it('a no-@ message in a team without a leader shows the sole/first member (the dispatcher\'s rule)', async () => {
    typing = { begin: jest.fn().mockResolvedValue(null), resolve: jest.fn().mockResolvedValue('edited'), setPhase: jest.fn().mockResolvedValue(undefined), fail: jest.fn().mockResolvedValue(undefined) };
    storage.teams = [team({ members: [member('Claude', 'developer', { sessionName: '' , id: 'd11d57bb-0000-4000-8000-000000000000' })] })];
    service = makeService();
    await service.ensureTeamChannel(storage.teams[0]);
    await service.routeInbound(inbound({ text: '这个团队是干什么的', ts: '600.1' }));
    expect(typing.begin).toHaveBeenCalledWith(
      expect.objectContaining({ agentSession: 'alpha-team-claude-d11d57bb' }),
      expect.objectContaining({ displayName: 'Claude' }),
      expect.any(String),
    );
    typing = null;
  });

  it('an agent without its own bot still gets a placeholder (master bot wearing its name), and a no-@ message shows the team leader', async () => {
    typing = { begin: jest.fn().mockResolvedValue(null), resolve: jest.fn().mockResolvedValue('edited'), setPhase: jest.fn().mockResolvedValue(undefined), fail: jest.fn().mockResolvedValue(undefined) };
    storage.teams = [team({ members: [member('Sam', 'developer'), member('Lena', 'team-leader')] })];
    service = makeService();
    await service.ensureTeamChannel(storage.teams[0]);
    await service.routeInbound(inbound({ text: '大家好，进度如何？', ts: '500.1' }));
    expect(typing.begin).toHaveBeenCalledWith(
      { agentSession: 'crewly-alpha-lena', slackChannelId: 'C1', threadTs: '500.1' },
      expect.objectContaining({ displayName: 'Lena', username: 'Lena' }),
      'typing',
    );
    expect((typing.begin.mock.calls[0][1] as { botToken?: string }).botToken).toBeUndefined();
    typing = null;
  });

  it('resolves a native <@bot> mention to the agent', async () => {
    await service.ensureTeamChannel(team());
    identities!.install('crewly-alpha-sam', 'USAM', 'xoxb-sam');
    const result = await service.routeInbound(inbound({ text: '<@USAM> 看一下' }));
    expect(result!.mentions).toEqual(['crewly-alpha-sam']);
  });

  it('stops the pass quietly when the owner has no config token', async () => {
    identities!.provisionError = Object.assign(new Error('No Slack app configuration token stored'), { code: 'config_token_missing' });
    const mapping = await service.ensureTeamChannel(team());
    const result = await service.ensureIdentities(team(), mapping);
    expect(result.skipped).toMatch(/configuration token/);
    // Each pass stops at the first failing member: one call from
    // ensureTeamChannel's pass, one from the explicit call above.
    expect(identities!.provisionCalls).toEqual(['crewly-alpha-sam', 'crewly-alpha-sam']);
    expect(slack.sent.find((m) => m.text.includes('创建了 Slack 身份'))).toBeUndefined();
  });

  it('does nothing when identities are unavailable', async () => {
    identities!.available = false;
    const mapping = await service.ensureTeamChannel(team());
    expect(await service.ensureIdentities(team(), mapping)).toEqual({ provisioned: 0, announced: 0, invited: 0, skipped: 'identities unavailable' });
    expect(identities!.provisionCalls).toEqual([]);
  });
});

describe('singleton accessors', () => {
  it('returns null until set', () => {
    expect(getSlackTeamChannelService()).toBeNull();
    setSlackTeamChannelService(service);
    expect(getSlackTeamChannelService()).toBe(service);
  });
});
