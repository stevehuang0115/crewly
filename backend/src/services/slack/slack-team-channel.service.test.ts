/**
 * Tests for SlackTeamChannelService.
 *
 * Uses in-memory fakes for Slack, chat-v2 and storage so each behaviour
 * (create/link/unlink, lifecycle sync, inbound routing with threads and
 * mentions, outbound identity) is asserted without a socket or a database.
 *
 * @module services/slack/slack-team-channel.service.test
 */

import { setTicketIntakeService, type IntakeMessage, type TicketIntakeService } from '../v3/ticket-intake.service.js';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import {
  SlackTeamChannelService,
  slackChannelNameFor,
  slackIdentityFor,
  teamChannelMembers,
  orchestratorSyncEntry,
  orchestratorSyncSession,
  orchestratorSyncTeamId,
  localAgentSession,
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
  /** Tokens for which addReaction should answer channel_not_found. */
  reactionNotInChannel = new Set<string | undefined>();
  uploads: Array<{
    channelId: string;
    filePath: string;
    filename?: string;
    title?: string;
    initialComment?: string;
    threadTs?: string;
    botToken?: string;
  }> = [];
  uploadError: string | null = null;
  channels = new Map<string, { id: string; name: string; isArchived: boolean; isPrivate: boolean }>();
  private seq = 0;
  private channelSeq = 0;

  isConnected(): boolean {
    return this.connected;
  }
  async uploadFile(options: {
    channelId: string;
    filePath: string;
    filename?: string;
    title?: string;
    initialComment?: string;
    threadTs?: string;
    botToken?: string;
  }): Promise<{ fileId?: string }> {
    if (this.uploadError) throw new Error(this.uploadError);
    this.uploads.push(options);
    return { fileId: `F${this.uploads.length}` };
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
    if (this.reactionNotInChannel.has(botToken)) {
      throw Object.assign(new Error('channel_not_found'), { data: { error: 'channel_not_found' } });
    }
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
let dispatcher: { dispatchMessage: jest.Mock; planHuddleTargets?: jest.Mock } | null;
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

describe('orchestratorSyncEntry', () => {
  // Two Crewly accounts in one Slack workspace install the same master app,
  // so they share one bot user and one DM with the owner — and only one of
  // them can answer it. The other machine's orchestrator went silent with
  // nothing in any log (owner, 2026-09-20). Its own app fixes that.
  //
  // The Orchestrator Team is assembled by the teams API for display and is
  // never stored, so `storage.getTeams()` has no orchestrator member to
  // find: the entry has to be synthesised.
  it('files the orchestrator under a team named after the machine', () => {
    expect(orchestratorSyncEntry('macbookpro.lan', 'inst-1')).toEqual({
      teamId: 'orchestrator@inst-1',
      name: 'macbookpro.lan',
      agentSession: 'crewly-orc@inst-1',
      displayName: 'Crewly Orc',
    });
  });

  // Cloud keys an agent's app on (account, agentSession), and every machine
  // calls its orchestrator `crewly-orc` — so two machines on one Cloud
  // account would collapse into one app, one bot and one DM, which is the
  // thing the per-machine app exists to prevent (owner, 2026-09-21).
  it('qualifies the session per instance so two machines do not share an app', () => {
    const a = orchestratorSyncEntry('macbookpro.lan', 'inst-a')!;
    const b = orchestratorSyncEntry('iriss-air.lan', 'inst-b')!;
    expect(a.agentSession).not.toBe(b.agentSession);
  });

  // Cloud deletes an app whose team is in a sync but whose session is not.
  // Filing both machines' orchestrators under a bare `orchestrator` meant
  // each sync would delete the other's app — every time, both directions.
  // Real teams have distinct ids and were never at risk; this one was
  // hardcoded (spotted by the agent on the Air, 2026-09-21).
  it('qualifies the pseudo-team too, so one machine\'s sync cannot prune the other\'s orc', () => {
    const a = orchestratorSyncEntry('macbookpro.lan', 'inst-a')!;
    const b = orchestratorSyncEntry('iriss-air.lan', 'inst-b')!;
    expect(a.teamId).not.toBe(b.teamId);
    expect(orchestratorSyncTeamId('inst-a')).toBe('orchestrator@inst-a');
  });

  it('asks for no app when the instance is not known yet', () => {
    expect(orchestratorSyncEntry('macbookpro.lan', '')).toBeNull();
    expect(orchestratorSyncEntry('macbookpro.lan', undefined)).toBeNull();
  });

  // Cloud strips a trailing "(...)" from a display name before comparing and
  // re-appends the *team* when two agents collide. Carrying the machine in
  // the display name would therefore be stripped and replaced; carrying it
  // in the team name makes Cloud's own suffix the one we want —
  // "Crewly Orc" alone, "Crewly Orc (macbookpro.lan)" once a second machine
  // shows up (owner, 2026-09-21).
  it('keeps the machine out of the display name, where Cloud would strip it', () => {
    const entry = orchestratorSyncEntry('macbookpro.lan', 'inst-1')!;
    expect(entry.displayName).not.toContain('macbookpro');
    expect(entry.name).toBe('macbookpro.lan');
  });

  it('asks for no app when the machine has no name to tell it apart by', () => {
    expect(orchestratorSyncEntry('', 'inst-1')).toBeNull();
    expect(orchestratorSyncEntry(undefined, 'inst-1')).toBeNull();
    expect(orchestratorSyncEntry('   ', 'inst-1')).toBeNull();
  });
});

describe('localAgentSession', () => {
  // The qualified spelling exists only between here and Cloud; dispatch,
  // the local roster and chat channels all know the orchestrator as
  // `crewly-orc`, so it is stripped the moment an event comes back.
  it('strips the instance from the orchestrator session', () => {
    expect(localAgentSession(orchestratorSyncSession('inst-1'))).toBe('crewly-orc');
    expect(localAgentSession('crewly-orc@2577fec0-d975')).toBe('crewly-orc');
  });

  it('leaves the unqualified orchestrator alone', () => {
    expect(localAgentSession('crewly-orc')).toBe('crewly-orc');
  });

  it('leaves an ordinary agent alone, including one with an @ in it', () => {
    expect(localAgentSession('marketing-ella-1234')).toBe('marketing-ella-1234');
    expect(localAgentSession('some-agent@thing')).toBe('some-agent@thing');
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

describe('the owner is put into every channel Crewly created', () => {
  // At boot the owner's Slack id arrives with the Cloud config a moment after
  // the first channel of a batch can be created. #crewly-marketing was made
  // with nobody to invite and sat for four days with only bots in it.
  afterEach(() => {
    ownerUserId = 'UOWNER';
  });

  it('retries an invite that could not happen at creation, then stops', async () => {
    ownerUserId = null;
    service = makeService();
    const mapping = await service.ensureTeamChannel(team());
    expect(slack.invites).toEqual([]);
    expect(mapping.ownerInvited).toBeUndefined();

    ownerUserId = 'UOWNER';
    await service.inviteOwnerWhereMissing();
    expect(slack.invites).toEqual([{ channelId: 'C1', userIds: ['UOWNER'] }]);
    expect(service.findBySlackChannelId('C1')?.ownerInvited).toBe(true);

    // Once in, never again — a channel the owner chose to leave stays left.
    await service.inviteOwnerWhereMissing();
    expect(slack.invites).toHaveLength(1);
  });

  it('counts "already in the channel" as done', async () => {
    ownerUserId = null;
    service = makeService();
    await service.ensureTeamChannel(team());
    ownerUserId = 'UOWNER';
    slack.inviteToChannel = async () => {
      throw Object.assign(new Error('An API error occurred: already_in_channel'), { data: { error: 'already_in_channel' } });
    };
    await service.inviteOwnerWhereMissing();
    expect(service.findBySlackChannelId('C1')?.ownerInvited).toBe(true);
  });

  it('marks a channel created with the owner invited straight away', async () => {
    const mapping = await service.ensureTeamChannel(team());
    expect(mapping.ownerInvited).toBe(true);
  });
});

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

  // Saving a prefix used to change the setting and nothing else. The
  // channels did follow it eventually — any team save runs syncChannelName —
  // so an active team renamed within minutes and an idle one kept the old
  // name indefinitely, with nothing to tell the two apart (owner,
  // 2026-09-21).
  it('renames the channels it already made when the prefix changes', async () => {
    storage.teams = [team({ id: 't1', name: 'Alpha Team' }), team({ id: 't2', name: 'Beta Team' })];
    await service.ensureTeamChannel(storage.teams[0]);
    await service.ensureTeamChannel(storage.teams[1]);
    slack.renamed = [];

    await service.updateSettings({ channelPrefix: 'mbp-' });

    expect(slack.renamed.map((r) => r.name)).toEqual(['mbp-alpha-team', 'mbp-beta-team']);
  });

  // Re-saving the same prefix reconciles rather than doing nothing: a prefix
  // saved before this feature existed would otherwise have no way to be
  // applied. It costs nothing when the names already match.
  it('calls no Slack rename when the channels already match the prefix', async () => {
    storage.teams = [team({ id: 't1', name: 'Alpha Team' })];
    await service.updateSettings({ channelPrefix: 'mbp-' });
    await service.ensureTeamChannel(storage.teams[0]);
    slack.renamed = [];

    await service.updateSettings({ channelPrefix: 'mbp-' });

    expect(slack.renamed).toEqual([]);
  });

  it('does not sweep when only autoCreate was changed', async () => {
    storage.teams = [team({ id: 't1', name: 'Alpha Team' })];
    await service.ensureTeamChannel(storage.teams[0]);
    slack.renamed = [];

    await service.updateSettings({ autoCreate: false });

    expect(slack.renamed).toEqual([]);
  });

  // syncChannelName leaves a hand-renamed channel alone; the sweep must not
  // become a way around that.
  it('leaves a channel the owner renamed by hand', async () => {
    storage.teams = [team({ id: 't1', name: 'Alpha Team' })];
    const created = await service.ensureTeamChannel(storage.teams[0]);
    slack.channels.get(created!.slackChannelId)!.name = 'owner-picked-this';
    slack.renamed = [];

    await service.updateSettings({ channelPrefix: 'mbp-' });

    expect(slack.renamed).toEqual([]);
  });

  it('carries on past a channel Slack refuses to rename', async () => {
    storage.teams = [team({ id: 't1', name: 'Alpha Team' }), team({ id: 't2', name: 'Beta Team' })];
    await service.ensureTeamChannel(storage.teams[0]);
    await service.ensureTeamChannel(storage.teams[1]);
    slack.renamed = [];
    slack.renameFails = true;

    await service.updateSettings({ channelPrefix: 'mbp-' });

    // Both were attempted even though neither took: one channel Slack
    // refuses must not strand the rest on the old prefix.
    expect(slack.renamed.map((r) => r.name)).toEqual(['mbp-alpha-team', 'mbp-beta-team']);
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

  // Reinstalling the workspace app drops the bot out of every channel it
  // had joined, and joining only ever happened when a channel was first
  // linked. A channel the bot has left delivers no events at all, so the
  // message reached neither Cloud nor any instance and left no trace
  // anywhere — from Slack's side nothing had happened (#rednote-team,
  // 2026-09-21).
  it('start() rejoins every mapped channel, and says which one it could not', async () => {
    await service.ensureTeamChannel(team());
    slack.joined.length = 0;
    const warnings: Array<Record<string, unknown>> = [];

    await service.start();
    await new Promise((r) => setImmediate(r));
    expect(slack.joined).toContain('C1');

    // A private channel cannot be joined — the bot must be invited.
    const again = makeService();
    (again as unknown as { logger: { warn: unknown } }).logger.warn = (_m: string, ctx: Record<string, unknown>) => {
      warnings.push(ctx);
    };
    slack.joinChannel = async () => {
      throw Object.assign(new Error('An API error occurred'), { data: { error: 'channel_not_found' } });
    };
    await again.start();
    await new Promise((r) => setImmediate(r));
    expect(warnings).toContainEqual(expect.objectContaining({ error: 'channel_not_found' }));
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
      expect.objectContaining({ threadId: msg.id, replyVia: 'reply-channel' }),
    );
    expect(slack.reactions).toEqual([{ channelId: 'C1', ts: '100.1', emoji: 'eyes' }]);
    expect(slack.sent).toEqual([]); // no hint: mention resolved
  });

  // The reaction is cosmetic, so its failure was swallowed outright. The
  // owner then saw no eyes and no placeholder and reasonably concluded the
  // message had not arrived — while it was routed, dispatched and answered
  // (2026-09-21). Still non-fatal, but it must leave a trace.
  it('logs the Slack error code when the seen-reaction cannot be added, and still routes', async () => {
    const warnings: Array<Record<string, unknown>> = [];
    (service as unknown as { logger: { warn: unknown } }).logger.warn = (_m: string, ctx: Record<string, unknown>) => {
      warnings.push(ctx);
    };
    slack.addReaction = async () => {
      throw Object.assign(new Error('An API error occurred'), { data: { error: 'not_in_channel' } });
    };

    const result = await service.routeInbound(inbound({ text: '@sam 看一下', userId: 'U1' }));

    expect(result).not.toBeNull();
    expect(dispatcher!.dispatchMessage).toHaveBeenCalled();
    expect(warnings).toContainEqual(expect.objectContaining({ error: 'not_in_channel', identitiesTried: 1 }));
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
      expect.objectContaining({ threadId: root!.message.id, replyVia: 'reply-channel' }),
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

describe('one pair of eyes per agent that receives it', () => {
  /** A dispatcher whose plan says who will receive the message. */
  function planning(plan: Array<[string, 'required' | 'optional']>) {
    dispatcher = {
      dispatchMessage: jest.fn().mockResolvedValue({ strategy: 'huddle-broadcast', dispatched: true, huddleOutcomes: [] }),
      planHuddleTargets: jest.fn().mockResolvedValue(new Map(plan)),
    };
  }

  beforeEach(async () => {
    identities = new FakeIdentities();
    typing = null;
  });

  it('reacts once with each receiving agent\'s own bot, so the count is how many agents got it', async () => {
    // The owner reads 👀 as "how many agents saw this". Three agents who
    // will each weigh a message should show three eyes.
    planning([['crewly-alpha-sam', 'required'], ['crewly-alpha-leo', 'optional']]);
    service = makeService();
    await service.ensureTeamChannel(team());
    identities!.install('crewly-alpha-sam', 'USAM', 'xoxb-sam');
    identities!.install('crewly-alpha-leo', 'ULEO', 'xoxb-leo');
    slack.reactions = [];

    await service.routeInbound(inbound({ text: 'hello team', ts: '500.1' }));

    const eyes = slack.reactions.filter((r) => r.ts === '500.1');
    expect(eyes.map((r) => r.botToken).sort()).toEqual(['xoxb-leo', 'xoxb-sam']);
  });

  it('shows "waking up" at once for an agent woken to own the message, but not for one merely told', async () => {
    // Nobody in #pro-crewly-marketing was awake, so Ella — the team leader —
    // was woken for it. The owner saw eyes and then nothing for two minutes
    // (2026-09-23). An agent woken for a message owns it; say so straight away.
    planning([['crewly-alpha-sam', 'optional'], ['crewly-alpha-leo', 'optional']]);
    typing = { begin: jest.fn().mockResolvedValue(null), resolve: jest.fn(), setPhase: jest.fn(), fail: jest.fn() };
    awake = (s) => s === 'crewly-alpha-leo';
    service = makeService();
    await service.ensureTeamChannel(team());

    await service.routeInbound(inbound({ text: 'who leads this?', ts: '510.1' }));

    const begun = typing.begin.mock.calls.map(([key, , phase]) => [key.agentSession, phase]);
    expect(begun).toEqual([['crewly-alpha-sam', 'waking']]);
    awake = () => true;
  });

  it('shows no eye from an agent the message is not going to', async () => {
    // Honest count: not everyone in the room, only those handed the message.
    planning([['crewly-alpha-sam', 'required']]);
    service = makeService();
    await service.ensureTeamChannel(team());
    identities!.install('crewly-alpha-sam', 'USAM', 'xoxb-sam');
    identities!.install('crewly-alpha-leo', 'ULEO', 'xoxb-leo');
    slack.reactions = [];

    await service.routeInbound(inbound({ text: 'hello', ts: '501.1' }));

    expect(slack.reactions.filter((r) => r.ts === '501.1').map((r) => r.botToken)).toEqual(['xoxb-sam']);
  });

  it('skips an agent whose bot is no longer in the channel, and still shows the others', async () => {
    planning([['crewly-alpha-sam', 'required'], ['crewly-alpha-leo', 'optional']]);
    service = makeService();
    await service.ensureTeamChannel(team());
    identities!.install('crewly-alpha-sam', 'USAM', 'xoxb-sam');
    identities!.install('crewly-alpha-leo', 'ULEO', 'xoxb-leo');
    slack.reactionNotInChannel.add('xoxb-leo');
    slack.reactions = [];

    await service.routeInbound(inbound({ text: 'hello', ts: '502.1' }));

    expect(slack.reactions.filter((r) => r.ts === '502.1').map((r) => r.botToken)).toEqual(['xoxb-sam']);
  });

  it('still puts one eye on a message nobody in particular receives', async () => {
    // The 2026-09-21 lesson: no eyes at all reads as "nothing arrived".
    planning([]);
    service = makeService();
    await service.ensureTeamChannel(team());
    slack.reactions = [];

    await service.routeInbound(inbound({ text: 'just chatting', ts: '503.1' }));

    const eyes = slack.reactions.filter((r) => r.ts === '503.1');
    expect(eyes).toHaveLength(1);
    expect(eyes[0].botToken).toBeUndefined();
  });

  it('shows a placeholder only for agents that owe a reply', async () => {
    // A placeholder is a promise of an answer; an agent only passed the
    // message to judge announces itself if it takes it on.
    typing = { begin: jest.fn().mockResolvedValue(null), resolve: jest.fn(), setPhase: jest.fn().mockResolvedValue(undefined), fail: jest.fn().mockResolvedValue(undefined) };
    planning([['crewly-alpha-sam', 'required'], ['crewly-alpha-leo', 'optional']]);
    service = makeService();
    await service.ensureTeamChannel(team());
    identities!.install('crewly-alpha-sam', 'USAM', 'xoxb-sam');

    await service.routeInbound(inbound({ text: 'hello', ts: '504.1' }));

    const begun = typing.begin.mock.calls.map((c) => c[0].agentSession);
    expect(begun).toEqual(['crewly-alpha-sam']);
    typing = null;
  });

  it('shows a placeholder for the last speaker on a bare thread follow-up', async () => {
    // The old heuristic only placed one for @'d agents or a top-level
    // leader, so a follow-up in a thread with no @ showed nothing at all.
    typing = { begin: jest.fn().mockResolvedValue(null), resolve: jest.fn(), setPhase: jest.fn().mockResolvedValue(undefined), fail: jest.fn().mockResolvedValue(undefined) };
    planning([['crewly-alpha-sam', 'required']]);
    service = makeService();
    await service.ensureTeamChannel(team());
    identities!.install('crewly-alpha-sam', 'USAM', 'xoxb-sam');
    await service.routeInbound(inbound({ text: 'start', ts: '505.1' }));
    typing.begin.mockClear();

    await service.routeInbound(inbound({ text: 'and one more thing', ts: '505.2', threadTs: '505.1' }));

    expect(typing.begin).toHaveBeenCalledWith(
      { agentSession: 'crewly-alpha-sam', slackChannelId: 'C1', threadTs: '505.1' },
      expect.anything(),
      'typing',
    );
    typing = null;
  });

  it('plans with exactly the options it then dispatches with', async () => {
    planning([['crewly-alpha-sam', 'required']]);
    service = makeService();
    await service.ensureTeamChannel(team());

    await service.routeInbound(inbound({ text: 'hello', ts: '506.1' }));

    const planOpts = dispatcher!.planHuddleTargets!.mock.calls[0][2];
    const sendOpts = dispatcher!.dispatchMessage.mock.calls[0][2];
    expect(sendOpts).toMatchObject(planOpts);
  });
});

describe('ticket loop intake (specs/ticket-loop.md §2)', () => {
  const TICKET = { id: '11111111-2222-3333-4444-555555555555', ticketNumber: 12 };
  let intake: { intakeWithOutcome: jest.Mock };

  beforeEach(async () => {
    intake = { intakeWithOutcome: jest.fn(async () => ({ action: 'created', ticket: TICKET })) };
    setTicketIntakeService(intake as unknown as TicketIntakeService);
    await service.ensureTeamChannel(team());
  });

  afterEach(() => setTicketIntakeService(null));

  it('the owner\'s message in a team channel is intake with team-channel refs and the @\'d agent as assignee; the dispatch carries the marker', async () => {
    await service.routeInbound(inbound({ text: '@sam please fix the export', userId: 'UOWNER', ts: '700.1' }));
    const [msg] = intake.intakeWithOutcome.mock.calls[0] as [IntakeMessage];
    expect(msg).toMatchObject({
      isOwner: true,
      targetAgent: 'crewly-alpha-sam',
      origin: { channel: 'slack-channel', ref: 'slackch-C1-700.1', threadRef: 'slack:C1:700.1', author: 'UOWNER' },
      receipt: { kind: 'slack', slackChannelId: 'C1', threadTs: '700.1' },
    });
    // Team channel: the workspace bot posts the receipt.
    expect((msg.receipt as { postAs?: string }).postAs).toBeUndefined();
    const dispatched = dispatcher!.dispatchMessage.mock.calls[0][1];
    expect(String(dispatched.metadata.ticketMarker)).toContain('[TICKET:TKT-012');
  });

  it('someone other than the owner is not the owner', async () => {
    await service.routeInbound(inbound({ text: '@sam please fix the export', userId: 'U-colleague', ts: '700.2' }));
    expect((intake.intakeWithOutcome.mock.calls[0][0] as IntakeMessage).isOwner).toBe(false);
  });

  it('a colleague agent\'s post never reaches intake', async () => {
    await service.routeInbound(
      inbound({ text: '<@USAM> please fix the export', userId: 'UMIA', ts: '700.3', authorAgentSession: 'remote-team-mia', authorDisplayName: 'Mia' }),
    );
    expect(intake.intakeWithOutcome).not.toHaveBeenCalled();
    expect(dispatcher!.dispatchMessage.mock.calls[0][1].metadata?.ticketMarker).toBeUndefined();
  });

  it('in an ad-hoc room, only the machine whose agent must answer files the ticket', async () => {
    identities = new FakeIdentities();
    isLocal = (s) => s === 'crewly-alpha-leo';
    service = makeService();
    await service.ensureTeamChannel(team());
    identities.install('crewly-alpha-leo', 'ULEO', 'xoxb-leo');
    // Seen here only because Leo's app is in the room; nobody here must answer.
    dispatcher = { ...dispatcher!, planHuddleTargets: jest.fn().mockResolvedValue(new Map([['crewly-alpha-leo', 'optional']])) };
    await service.routeInbound(inbound({ channelId: 'C-room', text: 'please fix the export', userId: 'UOWNER', ts: '800.1', receivedVia: 'crewly-alpha-leo' }));
    expect(intake.intakeWithOutcome).not.toHaveBeenCalled();
    // Addressed to Leo: this machine owns it, and the receipt goes out as Leo's bot.
    dispatcher.planHuddleTargets = jest.fn().mockResolvedValue(new Map([['crewly-alpha-leo', 'required']]));
    await service.routeInbound(inbound({ channelId: 'C-room', text: 'please fix the export', userId: 'UOWNER', ts: '800.2', receivedVia: 'crewly-alpha-leo' }));
    expect(intake.intakeWithOutcome).toHaveBeenCalledTimes(1);
    expect(intake.intakeWithOutcome.mock.calls[0][0]).toMatchObject({ targetAgent: 'crewly-alpha-leo', receipt: { postAs: 'crewly-alpha-leo' } });
    isLocal = () => false;
  });

  it('a failing intake never stops delivery', async () => {
    intake.intakeWithOutcome.mockRejectedValue(new Error('disk gone'));
    await service.routeInbound(inbound({ text: '@sam please fix the export', userId: 'UOWNER', ts: '900.1' }));
    expect(dispatcher!.dispatchMessage).toHaveBeenCalled();
  });
});

describe('the room is whoever\'s bot is in it', () => {
  beforeEach(async () => {
    identities = new FakeIdentities();
    typing = null;
  });

  it('links a channel when a message arrives through a local agent\'s own app, with nobody @\'d', async () => {
    // Slack only delivers to apps that are members, so the copy proves the
    // agent is in the room. The old rule needed someone to @ it first.
    isLocal = (s) => s === 'crewly-alpha-leo';
    service = makeService();
    await service.ensureTeamChannel(team());
    identities!.install('crewly-alpha-leo', 'ULEO', 'xoxb-leo');

    const result = await service.routeInbound(
      inbound({ channelId: 'C-new', text: 'just a thought', ts: '600.1', receivedVia: 'crewly-alpha-leo' }),
    );

    expect(result).not.toBeNull();
    expect(result!.mapping.teamId).toBe('adhoc:C-new');
    expect(result!.mapping.members).toEqual(['crewly-alpha-leo']);
    isLocal = () => false;
  });

  it('adds the receiving agent to a room it was never @\'d in', async () => {
    isLocal = (s) => s === 'crewly-alpha-leo' || s === 'crewly-alpha-sam';
    service = makeService();
    await service.ensureTeamChannel(team());
    identities!.install('crewly-alpha-sam', 'USAM', 'xoxb-sam');
    identities!.install('crewly-alpha-leo', 'ULEO', 'xoxb-leo');
    await service.routeInbound(inbound({ channelId: 'C-priv', text: '<@USAM> hi', ts: '601.1' }));

    await service.routeInbound(inbound({ channelId: 'C-priv', text: 'morning', ts: '601.2', receivedVia: 'crewly-alpha-leo' }));

    expect(service.findBySlackChannelId('C-priv')?.members).toEqual(['crewly-alpha-sam', 'crewly-alpha-leo']);
    isLocal = () => false;
  });

  it('records but does not dispatch a message that @\'s only an agent on another machine', async () => {
    // Owner @'d Atlas (on the Mac) in #daily-info; the Air resolved no local
    // mention and broadcast to Ella, who was awake (2026-09-23).
    isLocal = (s) => s === 'crewly-alpha-leo';
    service = makeService();
    await service.ensureTeamChannel(team());
    identities!.install('crewly-alpha-leo', 'ULEO', 'xoxb-leo');

    const result = await service.routeInbound(
      inbound({
        channelId: 'C-daily', text: '<@UATLAS> anything worth a look today?', ts: '603.1',
        receivedVia: 'crewly-alpha-leo', mentionedAgentSessions: ['think-tank-atlas-b4e166f6'],
      }),
    );

    expect(result).not.toBeNull();
    expect(result!.dispatch).toBeNull();
    expect(result!.mentions).toEqual([]);
    expect(dispatcher!.dispatchMessage).not.toHaveBeenCalled();
    isLocal = () => false;
  });

  it('still dispatches when a local agent is @\'d alongside a remote one', async () => {
    isLocal = (s) => s === 'crewly-alpha-leo';
    service = makeService();
    await service.ensureTeamChannel(team());
    identities!.install('crewly-alpha-leo', 'ULEO', 'xoxb-leo');

    await service.routeInbound(
      inbound({
        channelId: 'C-daily', text: '<@UATLAS> <@ULEO> both of you', ts: '603.2',
        receivedVia: 'crewly-alpha-leo', mentionedAgentSessions: ['think-tank-atlas-b4e166f6', 'crewly-alpha-leo'],
      }),
    );

    expect(dispatcher!.dispatchMessage).toHaveBeenCalled();
    isLocal = () => false;
  });

  it('never turns a DM into a room', async () => {
    isLocal = () => true;
    service = makeService();
    await service.ensureTeamChannel(team());

    expect(
      await service.routeInbound(inbound({ channelId: 'D0DM', text: 'hi', ts: '602.1', receivedVia: 'crewly-alpha-leo' })),
    ).toBeNull();
    isLocal = () => false;
  });

  it('ignores a copy delivered through an agent that does not run here', async () => {
    isLocal = () => false;
    service = makeService();
    await service.ensureTeamChannel(team());

    expect(
      await service.routeInbound(inbound({ channelId: 'C-elsewhere', text: 'hi', ts: '603.1', receivedVia: 'someone-elses-agent' })),
    ).toBeNull();
  });
});

describe('who in the room is awake', () => {
  // The owner's rule (2026-09-22): a message nobody @'d reaches every agent
  // awake, on any machine; each decides. Nobody asleep is woken unless
  // nobody at all is awake, and then only the one machine Cloud named.
  const room = (members: Array<[string, string, boolean]>, fallback?: { instanceId: string; agentSession: string; kind: 'team-leader' | 'orchestrator' }) => ({
    members: members.map(([agentSession, instanceId, isAwake]) => ({
      agentSession,
      displayName: agentSession.split('-').pop()!,
      instanceId,
      deviceName: instanceId === 'mac' ? 'macbookpro' : 'iriss-air',
      awake: isAwake,
    })),
    ...(fallback ? { fallback } : {}),
  });
  const optionsOf = () => dispatcher!.dispatchMessage.mock.calls[0][2];

  function presenceService() {
    return new SlackTeamChannelService({
      slack,
      chat: chat as unknown as TeamChannelChatApi,
      storage,
      getDispatcher: () => dispatcher,
      isAgentAwake: (s) => awake(s),
      isLocalAgent: (s) => isLocal(s),
      resolveInstanceId: async () => 'mac',
      storePath: path.join(tmpDir, 'slack-team-channels.json'),
    });
  }

  afterEach(() => {
    awake = () => true;
    isLocal = () => false;
  });

  it('passes the local agents that are awake, and what it knows of the other machines', async () => {
    awake = (s) => s === 'crewly-alpha-sam';
    service = presenceService();
    await service.ensureTeamChannel(team());

    await service.routeInbound(
      inbound({ ts: '800.1', room: room([['crewly-alpha-sam', 'mac', true], ['crewly-alpha-leo', 'mac', false], ['pa-ella', 'air', true]]) }),
    );

    expect(optionsOf().room).toEqual({ awakeHere: ['crewly-alpha-sam'], awakeElsewhere: true, wakeWhenAllAsleep: null });
    expect(optionsOf().roomPresence).toBe('sam（醒着，本机） · leo（在睡，本机） · ella（醒着，iriss-air）');
  });

  it('judges local agents by what is running here, not by what Cloud last heard', async () => {
    awake = () => false;
    service = presenceService();
    await service.ensureTeamChannel(team());

    // Cloud thinks Sam is awake; Sam has just stopped. Every other machine
    // believes we have it, so this machine is the only one that can wake the
    // leader — otherwise nobody answers at all.
    await service.routeInbound(inbound({ ts: '800.2', room: room([['crewly-alpha-sam', 'mac', true], ['pa-ella', 'air', false]]) }));

    expect(optionsOf().room.awakeHere).toEqual([]);
    expect(optionsOf().room.wakeWhenAllAsleep).toMatchObject({ kind: 'team-leader' });
    expect(optionsOf().roomPresence).toContain('sam（在睡，本机）');
  });

  it('wakes the router only when Cloud named this machine', async () => {
    awake = () => false;
    service = presenceService();
    await service.ensureTeamChannel(team());

    await service.routeInbound(
      inbound({ ts: '800.3', room: room([['crewly-alpha-sam', 'mac', false]], { instanceId: 'mac', agentSession: 'crewly-orc@mac', kind: 'orchestrator' }) }),
    );
    expect(optionsOf().room.wakeWhenAllAsleep).toEqual({ agentSession: 'crewly-orc', kind: 'orchestrator' });

    dispatcher!.dispatchMessage.mockClear();
    await service.routeInbound(
      inbound({ ts: '800.4', room: room([['crewly-alpha-sam', 'mac', false]], { instanceId: 'air', agentSession: 'crewly-orc@air', kind: 'orchestrator' }) }),
    );
    expect(optionsOf().room.wakeWhenAllAsleep).toBeNull();
  });

  it('leaves the old rule in charge when Cloud sent no presence', async () => {
    awake = () => false;
    service = presenceService();
    await service.ensureTeamChannel(team());
    await service.routeInbound(inbound({ ts: '800.5' }));
    expect(optionsOf().room).toEqual({ awakeHere: [], awakeElsewhere: false });
  });

  it('reports the ad-hoc rooms for the heartbeat', async () => {
    isLocal = (s) => s === 'crewly-alpha-leo';
    const changed = jest.fn();
    service = new SlackTeamChannelService({
      slack,
      chat: chat as unknown as TeamChannelChatApi,
      storage,
      getDispatcher: () => dispatcher,
      isLocalAgent: (s) => isLocal(s),
      onRoomsChanged: changed,
      storePath: path.join(tmpDir, 'slack-team-channels.json'),
    });
    await service.ensureTeamChannel(team());
    await service.routeInbound(inbound({ channelId: 'C-priv', ts: '801.1', receivedVia: 'crewly-alpha-leo' }));

    expect(await service.listRooms()).toEqual([{ channelId: 'C-priv', agents: ['crewly-alpha-leo'] }]);
    // Cloud hears about it now, not at the next 5-minute heartbeat.
    expect(changed).toHaveBeenCalled();
  });
});

describe('handoffForAgent', () => {
  // The orchestrator of a private room routes a message nobody was awake
  // for. Its bot is usually not in that room, so it cannot @ anyone there.
  async function seedRoom(handoffViaCloud?: jest.Mock) {
    isLocal = (s) => s === 'crewly-alpha-leo' || s === 'crewly-alpha-sam';
    awake = () => false;
    service = new SlackTeamChannelService({
      slack,
      chat: chat as unknown as TeamChannelChatApi,
      storage,
      getDispatcher: () => dispatcher,
      isAgentAwake: (s) => awake(s),
      isLocalAgent: (s) => isLocal(s),
      ...(handoffViaCloud ? { handoffViaCloud } : {}),
      storePath: path.join(tmpDir, 'slack-team-channels.json'),
    });
    await service.ensureTeamChannel(team());
    const routed = await service.routeInbound(
      inbound({
        channelId: 'C-priv',
        text: '帮我起草一封邮件',
        ts: '900.1',
        receivedVia: 'crewly-alpha-leo',
        room: {
          members: [
            { agentSession: 'crewly-alpha-leo', displayName: 'Leo', instanceId: 'mac', deviceName: 'mac', awake: false },
            { agentSession: 'pa-ella', displayName: 'Ella', instanceId: 'air', deviceName: 'iriss-air', awake: false },
          ],
        },
      }),
    );
    dispatcher!.dispatchMessage.mockClear();
    return routed!;
  }

  afterEach(() => {
    awake = () => true;
    isLocal = () => false;
  });

  it('delivers the same message again to a local agent, as if it had been @\'d', async () => {
    const routed = await seedRoom();
    const before = chat.messages.length;

    const result = await service.handoffForAgent({ chatChannelId: routed.mapping.chatChannelId, messageId: routed.message.id, name: '@Leo' });

    expect(result).toMatchObject({ ok: true, agentSession: 'crewly-alpha-leo', via: 'here' });
    const [, delivered] = dispatcher!.dispatchMessage.mock.calls[0];
    expect(delivered.id).toBe(routed.message.id);
    expect(delivered.mentions).toContain('crewly-alpha-leo');
    // Not recorded a second time.
    expect(chat.messages.length).toBe(before);
  });

  it('sends it through Cloud to an agent on another machine', async () => {
    const cloud = jest.fn().mockResolvedValue(undefined);
    const routed = await seedRoom(cloud);

    const result = await service.handoffForAgent({ chatChannelId: routed.mapping.chatChannelId, threadId: routed.message.id, name: 'ella' });

    expect(result).toMatchObject({ ok: true, agentSession: 'pa-ella', via: 'cloud' });
    expect(cloud).toHaveBeenCalledWith({
      agentSession: 'pa-ella',
      event: { channel: 'C-priv', ts: '900.1', text: '帮我起草一封邮件', user: 'U1' },
    });
  });

  it('names who it could have meant when the name is unknown', async () => {
    const routed = await seedRoom();
    const result = await service.handoffForAgent({ chatChannelId: routed.mapping.chatChannelId, messageId: routed.message.id, name: 'Zoe' });
    expect(result).toMatchObject({ ok: false, reason: 'unknown_agent' });
    expect((result as { candidates: string[] }).candidates).toEqual(expect.arrayContaining(['Leo', 'Ella']));
  });

  it('refuses a channel that is not in Slack and a message that did not come from Slack', async () => {
    const routed = await seedRoom();
    expect(await service.handoffForAgent({ chatChannelId: 'local-only', name: 'Leo' })).toEqual({ ok: false, reason: 'not_a_slack_channel' });
    expect(await service.handoffForAgent({ chatChannelId: routed.mapping.chatChannelId, messageId: 'nope', name: 'Leo' })).toEqual({
      ok: false,
      reason: 'not_a_slack_message',
    });
  });
});

describe('beginWorkingForAgent', () => {
  it('shows a placeholder that the agent\'s reply then replaces', async () => {
    typing = { begin: jest.fn().mockResolvedValue(null), resolve: jest.fn().mockResolvedValue('edited'), setPhase: jest.fn(), fail: jest.fn() };
    identities = new FakeIdentities();
    service = makeService();
    await service.ensureTeamChannel(team());
    identities!.install('crewly-alpha-leo', 'ULEO', 'xoxb-leo');
    await service.routeInbound(inbound({ text: 'anyone?', ts: '700.1' }));
    const root = chat.messages.find((m) => m.metadata?.slackTs === '700.1')!;

    const result = await service.beginWorkingForAgent({
      chatChannelId: 'huddle-1',
      agentSession: 'crewly-alpha-leo',
      threadId: root.id,
    });

    const key = { agentSession: 'crewly-alpha-leo', slackChannelId: 'C1', threadTs: '700.1' };
    expect(result).toMatchObject({ ok: true, threadTs: '700.1' });
    expect(typing.begin).toHaveBeenCalledWith(key, { botToken: 'xoxb-leo', displayName: 'Leo' }, 'typing');

    // Same key the reply is mirrored under, so it edits the placeholder in
    // place instead of landing beside it.
    await service.mirrorOutbound({
      id: 'reply-9', channelId: 'huddle-1', seq: 99, senderType: 'agent', senderId: 'crewly-alpha-leo', content: 'I can take this',
      contentType: 'markdown', createdAt: 1, attachments: [], mentions: [], metadata: { source: 'reply-tool' }, threadId: root.id,
    } as ChatMessageDTO);
    expect(typing.resolve).toHaveBeenCalledWith(key, 'I can take this', expect.anything());
    typing = null;
  });

  it('does nothing for a chat channel that is not mirrored to Slack', async () => {
    typing = { begin: jest.fn(), resolve: jest.fn(), setPhase: jest.fn(), fail: jest.fn() };
    service = makeService();

    const result = await service.beginWorkingForAgent({ chatChannelId: 'local-only', agentSession: 'crewly-alpha-leo' });

    expect(result).toEqual({ ok: false, reason: 'not_a_slack_channel' });
    expect(typing.begin).not.toHaveBeenCalled();
    typing = null;
  });
});

describe('attachFileForAgent', () => {
  beforeEach(async () => {
    await service.ensureTeamChannel(team());
    await service.start();
    slack.uploads = [];
    slack.uploadError = null;
  });

  it('uploads to the Slack channel the chat channel maps to', async () => {
    // The agent knows its chat channel id and has no reason to know a Slack
    // one; resolving that is the point of this method.
    const result = await service.attachFileForAgent({
      chatChannelId: 'huddle-1',
      agentSession: 'crewly-alpha-sam',
      filePath: '/tmp/proposal.pdf',
    });

    expect(result.ok).toBe(true);
    expect(slack.uploads).toHaveLength(1);
    expect(slack.uploads[0].filePath).toBe('/tmp/proposal.pdf');
    // The Slack channel the mapping points at, not the chat channel id.
    expect(slack.uploads[0].channelId).toBe('C1');
    expect(slack.uploads[0].channelId).not.toBe('huddle-1');
  });

  it('lands in the same thread the agent is replying in', async () => {
    // Otherwise the file appears at the bottom of the channel while the
    // conversation about it is somewhere above.
    const root = await service.routeInbound(inbound({ ts: '200.1', text: '@sam send the pdf' }));
    expect(root).toBeTruthy();

    await service.attachFileForAgent({
      chatChannelId: 'huddle-1',
      agentSession: 'crewly-alpha-sam',
      filePath: '/tmp/proposal.pdf',
    });

    expect(slack.uploads[0].threadTs).toBe('200.1');
  });

  it('uploads as the agent\'s own bot when it has one', async () => {
    // So the file comes from the same name as the words next to it.
    identities = new FakeIdentities();
    service = makeService();
    await service.ensureTeamChannel(team());
    await service.start();
    slack.uploads = [];
    identities.records.set('crewly-alpha-sam', {
      agentSession: 'crewly-alpha-sam', displayName: 'Sam', appId: 'A-sam',
      status: 'installed', botUserId: 'USAM', botToken: 'xoxb-sam',
    } as unknown as SlackAgentIdentityRecord);

    const result = await service.attachFileForAgent({
      chatChannelId: 'huddle-1',
      agentSession: 'crewly-alpha-sam',
      filePath: '/tmp/proposal.pdf',
    });

    expect(slack.uploads[0].botToken).toBe('xoxb-sam');
    expect(result.ok && result.asAgentBot).toBe(true);
  });

  it('still uploads, from the workspace bot, when the agent has no bot yet', async () => {
    const result = await service.attachFileForAgent({
      chatChannelId: 'huddle-1',
      agentSession: 'crewly-alpha-sam',
      filePath: '/tmp/proposal.pdf',
    });

    expect(slack.uploads[0].botToken).toBeUndefined();
    expect(result.ok && result.asAgentBot).toBe(false);
  });

  it('passes the caption and title through', async () => {
    await service.attachFileForAgent({
      chatChannelId: 'huddle-1',
      agentSession: 'crewly-alpha-sam',
      filePath: '/tmp/proposal.pdf',
      filename: 'proposal.pdf',
      title: '课程设计方案',
      comment: '第 3 节改了',
    });

    expect(slack.uploads[0]).toMatchObject({
      filename: 'proposal.pdf',
      title: '课程设计方案',
      initialComment: '第 3 节改了',
    });
  });

  it('refuses a chat channel that is not mirrored to Slack', async () => {
    const result = await service.attachFileForAgent({
      chatChannelId: 'not-a-slack-channel',
      agentSession: 'crewly-alpha-sam',
      filePath: '/tmp/proposal.pdf',
    });

    expect(result).toEqual({ ok: false, reason: 'not_a_slack_channel' });
    expect(slack.uploads).toHaveLength(0);
  });

  it('reports Slack being down rather than pretending it sent', async () => {
    slack.connected = false;

    const result = await service.attachFileForAgent({
      chatChannelId: 'huddle-1',
      agentSession: 'crewly-alpha-sam',
      filePath: '/tmp/proposal.pdf',
    });

    expect(result).toEqual({ ok: false, reason: 'slack_not_connected' });
  });

  it('surfaces an upload failure instead of throwing', async () => {
    slack.uploadError = 'file too large';

    const result = await service.attachFileForAgent({
      chatChannelId: 'huddle-1',
      agentSession: 'crewly-alpha-sam',
      filePath: '/tmp/huge.pdf',
    });

    expect(result).toEqual({ ok: false, reason: 'file too large' });
  });
});

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

  it('tries another agent bot when the first one is not in the private channel', async () => {
    // The huddle roster grows as agents are @'d there and never shrinks, and
    // a bot can be removed from a private channel afterwards — so "a huddle
    // member's bot is in the channel" is not something we can assume. Picking
    // one that is not gave channel_not_found and no eyes at all, while the
    // message was routed, dispatched and answered (#daily-info, 2026-09-22).
    await service.ensureTeamChannel(team());
    identities!.install('crewly-alpha-sam', 'USAM', 'xoxb-sam');
    identities!.install('crewly-alpha-leo', 'ULEO', 'xoxb-leo');

    // Build the ad-hoc mapping with both in the roster.
    await service.routeInbound(inbound({ channelId: 'C-priv', text: '<@USAM> hi', ts: '400.1' }));
    await service.routeInbound(inbound({ channelId: 'C-priv', text: '<@ULEO> hi', ts: '400.2' }));

    // Sam's bot has since been removed from the channel.
    slack.reactionNotInChannel.add('xoxb-sam');
    slack.reactions = [];

    await service.routeInbound(inbound({ channelId: 'C-priv', text: 'a follow-up with no @', ts: '400.3' }));

    // It fell through to Leo rather than giving up.
    expect(slack.reactions.at(-1)).toMatchObject({ channelId: 'C-priv', botToken: 'xoxb-leo' });
  });

  it('falls back to the master bot when no agent bot is in the channel', async () => {
    await service.ensureTeamChannel(team());
    identities!.install('crewly-alpha-sam', 'USAM', 'xoxb-sam');
    await service.routeInbound(inbound({ channelId: 'C-priv', text: '<@USAM> hi', ts: '401.1' }));

    slack.reactionNotInChannel.add('xoxb-sam');
    slack.reactions = [];

    await service.routeInbound(inbound({ channelId: 'C-priv', text: 'follow-up', ts: '401.2' }));

    // Master bot = no token. It may well also fail, but it is worth the try.
    expect(slack.reactions.at(-1)).toMatchObject({ channelId: 'C-priv' });
    expect(slack.reactions.at(-1)!.botToken).toBeUndefined();
  });

  it('does not cycle identities for a failure every bot would share', async () => {
    // An already-reacted or rate-limited error fails the same for everyone;
    // retrying it once per agent just multiplies the calls.
    await service.ensureTeamChannel(team());
    identities!.install('crewly-alpha-sam', 'USAM', 'xoxb-sam');
    identities!.install('crewly-alpha-leo', 'ULEO', 'xoxb-leo');
    await service.routeInbound(inbound({ channelId: 'C-priv', text: '<@USAM> hi', ts: '402.1' }));
    await service.routeInbound(inbound({ channelId: 'C-priv', text: '<@ULEO> hi', ts: '402.2' }));

    let calls = 0;
    const realAdd = slack.addReaction.bind(slack);
    slack.addReaction = async (...args: Parameters<typeof realAdd>) => {
      calls += 1;
      throw Object.assign(new Error('already_reacted'), { data: { error: 'already_reacted' } });
    };

    await service.routeInbound(inbound({ channelId: 'C-priv', text: 'follow-up', ts: '402.3' }));

    expect(calls).toBe(1);
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
