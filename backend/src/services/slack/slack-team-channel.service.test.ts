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
  teamChannelLeader,
  teamChannelMembers,
  isRuntimeSmokeTeam,
  orchestratorSyncEntry,
  orchestratorSyncSession,
  orchestratorSyncTeamId,
  localAgentSession,
  getSlackTeamChannelService,
  isAssistantRoom,
  isDirectRequest,
  roomWatcherInstance,
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
import { setSlackDirectoryService, type SlackDirectoryService } from './slack-directory.service.js';
import { ChatV2DispatcherService } from '../chat-v2/chat-v2.dispatcher.service.js';
import type { SlackThreadContext } from '../../types/slack.types.js';

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
  getBotUserId?: () => Promise<string | null>;
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
        .find(
          (m) =>
            m.channelId === channelId && !m.threadId && m.senderType !== 'agent' && typeof m.metadata?.slackThreadTs === 'string',
        ) ?? null
    );
  }
  updateMessageMetadata(id: string, patch: Record<string, unknown>) {
    const m = this.messages.find((x) => x.id === id);
    if (!m) return null;
    m.metadata = { ...(m.metadata ?? {}), ...patch };
    return m;
  }
  getMessageForBridge(id: string) {
    return this.messages.find((m) => m.id === id) ?? null;
  }
  listThreadForBridge(channelId: string, rootId: string) {
    return this.messages.filter((m) => m.channelId === channelId && (m.id === rootId || m.threadId === rootId));
  }
  queryRecentTurnsForDispatch(channelId: string, threadId: string | undefined, limit: number) {
    const rows = this.messages.filter((m) => m.channelId === channelId && (!threadId || m.threadId === threadId)).slice(-(limit + 1));
    return rows.slice(0, Math.max(0, rows.length - 1)).map((r) => ({
      senderId: r.senderId,
      content: r.content,
      createdAt: new Date(r.createdAt).toISOString(),
      inThread: Boolean(r.threadId),
    }));
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
let autoWorking: { watch: jest.Mock } | null = null;
let isLocal: (s: string) => boolean = () => false;

function makeService() {
  return new SlackTeamChannelService({
    slack,
    chat: chat as unknown as TeamChannelChatApi,
    storage,
    getDispatcher: () => dispatcher,
    identities,
    typing,
    autoWorking,
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

  it('gives a runtime smoke test team no channel members (no channel, invite or agent app)', () => {
    const t = team({ name: 'zz-runtime-smoke-crewly-agent', members: [member('smoke', 'developer')] });
    expect(teamChannelMembers(t)).toEqual([]);
    expect(isRuntimeSmokeTeam(t)).toBe(true);
    expect(isRuntimeSmokeTeam(team({ name: 'Think Tank' }))).toBe(false);
  });
});

describe('teamChannelLeader', () => {
  it('uses the shared team-lead rule: tech-lead, then an explicit lead, else the first member', () => {
    const ce = team({ members: [member('Nova', 'developer'), member('Owen', 'tech-lead' as TeamMember['role'])] });
    expect(teamChannelLeader(ce)?.name).toBe('Owen');
    const explicit = { ...ce, leaderIds: [ce.members[0].id] } as Team;
    expect(teamChannelLeader(explicit)?.name).toBe('Nova');
    expect(teamChannelLeader(team({ members: [member('Sam', 'developer'), member('Mia', 'qa')] }))?.name).toBe('Sam');
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
    expect(welcome.text).toContain('is ready');
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

  it("a dedicated agent @'d by someone else declines politely and gets nothing; its person is served (issue #968)", async () => {
    storage.teams = [team({ members: [member('Sam', 'developer', { dedicatedTo: 'UINFO1' }), member('Leo', 'team-leader')], leaderIds: ['m-leo'] })];
    const declined = await service.routeInbound(inbound({ text: '@sam 看一下', userId: 'USTEVE1' }));
    expect(declined!.mentions).toEqual([]);
    expect(declined!.dispatch).toBeNull();
    expect(dispatcher!.dispatchMessage).not.toHaveBeenCalled();
    expect(slack.sent).toHaveLength(1);
    expect(slack.sent[0]).toMatchObject({ channelId: 'C1', threadTs: '100.1' });
    expect(slack.sent[0].text).toMatch(/^Hi <@USTEVE1>, I'm .+'s personal assistant, so I can't take this on\. For this, please ask Leo \(team lead\)\.$/);

    slack.sent = [];
    const served = await service.routeInbound(inbound({ text: '@sam 看一下', userId: 'UINFO1', ts: '100.2' }));
    expect(served!.mentions).toEqual(['crewly-alpha-sam']);
    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
    expect(slack.sent).toEqual([]);
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

  // 2026-09-28 #daily-info: a thread post by an agent on another machine
  // never reaches this one (Cloud drops own-bot events). The thread as Slack
  // has it is handed to each recipient, its own lines marked.
  it('hands the Slack thread context to the dispatcher, rendered per recipient, without recording it', async () => {
    const before = chat.messages.length;
    const threadContext = Promise.resolve({
      kind: 'thread' as const,
      channelId: 'C1',
      threadTs: '100.1',
      totalBefore: 2,
      messages: [
        { ts: '100.1', isBot: true, authorName: 'Ella (Personal Assistant Team)', userId: 'UELLA', text: 'Email digest: AWS invoice' },
        { ts: '100.2', isBot: true, authorName: 'Sam', usernameOverride: true, text: 'my earlier note' },
      ],
    });
    await service.routeInbound(inbound({ ts: '100.3', threadTs: '100.1', text: '@sam 看看上面的这些', threadContext }));
    expect(chat.messages.length).toBe(before + 1); // only the owner's message itself
    const opts = dispatcher!.dispatchMessage.mock.calls[0][2] as { slackContextFor?: (s: string) => string };
    const forSam = opts.slackContextFor!('crewly-alpha-sam');
    expect(forSam).toContain('Ella (Personal Assistant Team) [bot]: Email digest: AWS invoice');
    expect(forSam).toContain('Sam [bot] (you): my earlier note');
    expect(opts.slackContextFor!('crewly-alpha-leo')).not.toContain('(you)');
  });

  it('delivers without a context block when the Slack read gave nothing', async () => {
    await service.routeInbound(inbound({ ts: '100.3', threadTs: '100.1', text: '@sam hi', threadContext: Promise.resolve(null) }));
    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
    expect(dispatcher!.dispatchMessage.mock.calls[0][2]).not.toHaveProperty('slackContextFor');
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
    expect(hint?.text).toContain('Did you mean');
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

  it('links a bare @Name to a team-suffixed bot ("Ella (Crewly Marketing)") only when the bare name is unique', async () => {
    const ids = new FakeIdentities();
    identities = ids;
    service = makeService();
    const rec = (session: string, displayName: string, botUserId: string) =>
      ids.records.set(session, {
        agentSession: session, displayName, appId: `A-${botUserId}`, status: 'installed', botUserId, botToken: 'xoxb', announcedIn: [], invitedTo: [],
      } as unknown as SlackAgentIdentityRecord);
    rec('mkt-ella', 'Ella (Crewly Marketing)', 'UELLA');
    rec('a-sam', 'Sam (Alpha)', 'USAMA');
    rec('b-sam', 'Sam (Beta)', 'USAMB');
    expect(await service.linkAgentMentions('@Ella 补一句')).toBe('<@UELLA> 补一句');
    expect(await service.linkAgentMentions('cc @Ella (Crewly Marketing) pls')).toBe('cc <@UELLA> pls');
    expect(await service.linkAgentMentions('@Sam hi, @Sam (Beta) you')).toBe('@Sam hi, <@USAMB> you');

    // Two Sams: the one who is a member of the target channel is meant.
    const asked: string[] = [];
    (slack as unknown as { listChannelMembers: (c: string) => Promise<string[]> }).listChannelMembers = async (c) => {
      asked.push(c);
      return c === 'CBETA' ? ['UOWNER', 'USAMB'] : ['USAMA', 'USAMB'];
    };
    expect(await service.linkAgentMentions('@Sam hi', 'CBETA')).toBe('<@USAMB> hi');
    expect(await service.linkAgentMentions('@Sam again', 'CBETA')).toBe('<@USAMB> again');
    expect(await service.linkAgentMentions('@Sam both here', 'CBOTH')).toBe('@Sam both here');
    expect(await service.linkAgentMentions('@Ella only', 'CNEW')).toBe('<@UELLA> only');
    expect(asked).toEqual(['CBETA', 'CBOTH']);

    // The Crewly room's roster decides first — no Slack call needed.
    await service.ensureTeamChannel(team());
    const room = service.findBySlackChannelId('C1')!;
    chat.setHuddleMembers(room.chatChannelId, ['a-sam']);
    expect(await service.linkAgentMentions('@Sam go', 'C1')).toBe('<@USAMA> go');
    expect(asked).toEqual(['CBETA', 'CBOTH']);
  });

  it('turns @Owner Name (multi-word) into a real mention of the owner, and remembers people who spoke', async () => {
    ownerUserId = 'UOWNER';
    (slack as unknown as { getUserInfo: (id: string) => Promise<{ name: string; realName: string }> }).getUserInfo = async (id) =>
      id === 'UOWNER' ? { name: 'steve', realName: 'Steve Huang' } : { name: id, realName: id };
    service = makeService();
    expect(await service.linkAgentMentions('@Steve Huang 两件事：')).toBe('<@UOWNER> 两件事：');
    expect(await service.linkAgentMentions('cc @steve, thanks')).toBe('cc <@UOWNER>, thanks');
    service.rememberHuman('UANN', ['Ann Lee']);
    expect(await service.linkAgentMentions('@Ann Lee and @Ann Leeway')).toBe('<@UANN> and @Ann Leeway');
    expect(await service.linkAgentMentions('mail a@steve.com')).toBe('mail a@steve.com');
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

  it('posts a message with no thread top level, never into the channel\'s latest Slack thread', async () => {
    // Until 2026-10-03 it went into the latest thread: Dana's nightly
    // report landed inside whatever the owner had last started.
    await service.routeInbound(inbound({ ts: '100.1' }));
    await service.routeInbound(inbound({ ts: '200.1' }));
    slack.sent = [];
    await service.mirrorOutbound(agentMessage({ senderId: 'crewly-alpha-leo' }));
    expect(slack.sent).toHaveLength(1);
    expect(slack.sent[0]).toEqual(expect.objectContaining({ username: 'Leo', iconEmoji: ':mag:' }));
    expect(slack.sent[0].threadTs).toBeUndefined();
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

describe('top-level posts stay top level (scheduled reports)', () => {
  /** A message as reply-channel / a scheduled job writes it into the room. */
  function post(overrides: Partial<ChatMessageDTO> = {}): ChatMessageDTO {
    const id = overrides.id ?? `agent-${Math.random().toString(36).slice(2)}`;
    const dto: ChatMessageDTO = {
      id,
      channelId: 'huddle-1',
      seq: 99,
      senderType: 'agent',
      senderId: 'crewly-alpha-leo',
      content: '*Daily report* visitors 2',
      contentType: 'markdown',
      createdAt: 1,
      attachments: [],
      mentions: [],
      metadata: {},
      ...overrides,
    };
    chat.messages.push(dto);
    return dto;
  }

  beforeEach(async () => {
    typing = {
      begin: jest.fn().mockResolvedValue(null),
      resolve: jest.fn().mockResolvedValue('edited'),
      setPhase: jest.fn(),
      fail: jest.fn(),
    };
    identities = new FakeIdentities();
    service = makeService();
    await service.ensureTeamChannel(team());
    identities!.install('crewly-alpha-leo', 'ULEO', 'xoxb-leo');
  });

  afterEach(() => {
    typing = null;
  });

  it('a scheduled job\'s top-level post goes top level while a placeholder waits in another thread', async () => {
    // The owner asked something; Leo has a "working on it" in that thread.
    await service.routeInbound(inbound({ text: 'how are signups?', ts: '300.1' }));
    const ownerRoot = chat.messages.find((m) => m.metadata?.slackTs === '300.1')!;
    await service.beginWorkingForAgent({ chatChannelId: 'huddle-1', agentSession: 'crewly-alpha-leo', threadId: ownerRoot.id });
    typing!.resolve.mockClear();
    slack.sent = [];

    // 22:00: the nightly report, no thread.
    const report = post();
    expect(await service.mirrorOutbound(report)).toBe(true);

    // Not through the placeholder service at all — so it cannot edit the
    // placeholder in the owner's thread or land beside it.
    expect(typing!.resolve).not.toHaveBeenCalled();
    expect(slack.sent).toHaveLength(1);
    expect(slack.sent[0]).toEqual(expect.objectContaining({ channelId: 'C1', botToken: 'xoxb-leo', text: '*Daily report* visitors 2' }));
    expect(slack.sent[0].threadTs).toBeUndefined();
  });

  it('a real thread reply still replaces its own placeholder', async () => {
    await service.routeInbound(inbound({ text: 'how are signups?', ts: '310.1' }));
    const ownerRoot = chat.messages.find((m) => m.metadata?.slackTs === '310.1')!;
    await service.beginWorkingForAgent({ chatChannelId: 'huddle-1', agentSession: 'crewly-alpha-leo', threadId: ownerRoot.id });

    await service.mirrorOutbound(post({ content: '12 signups this week', threadId: ownerRoot.id }));

    expect(typing!.resolve).toHaveBeenCalledWith(
      { agentSession: 'crewly-alpha-leo', slackChannelId: 'C1', threadTs: '310.1' },
      '12 signups this week',
      { botToken: 'xoxb-leo', displayName: 'Leo' },
    );
  });

  it('records the Slack ts on the posted row, so its detail reply goes under it', async () => {
    await service.routeInbound(inbound({ ts: '320.1' }));
    slack.sent = [];
    const summary = post({ content: 'summary' });
    await service.mirrorOutbound(summary);
    const rootTs = chat.messages.find((m) => m.id === summary.id)!.metadata?.slackThreadTs;
    expect(rootTs).toEqual(expect.any(String));

    await service.mirrorOutbound(post({ content: 'detail', threadId: summary.id }));

    expect(typing!.resolve).toHaveBeenCalledWith(
      { agentSession: 'crewly-alpha-leo', slackChannelId: 'C1', threadTs: rootTs },
      'detail',
      expect.anything(),
    );
  });

  it('a detail reply sent while its summary is still being posted waits for the summary\'s ts', async () => {
    // run.sh posts the summary and the detail 0.5 s apart; the detail must
    // not overtake the summary and guess a thread.
    let release: (ts: string) => void = () => undefined;
    const original = slack.sendMessage.bind(slack);
    slack.sendMessage = async (m: SlackOutgoingMessage) => {
      if (m.text === 'summary') {
        slack.sent.push(m);
        return new Promise<string>((r) => (release = r));
      }
      return original(m);
    };
    const summary = post({ content: 'summary' });
    const first = service.mirrorOutbound(summary);
    await new Promise((r) => setImmediate(r));
    const second = service.mirrorOutbound(post({ content: 'detail', threadId: summary.id }));
    await new Promise((r) => setImmediate(r));
    expect(typing!.resolve).not.toHaveBeenCalled();

    release('900.5');
    await Promise.all([first, second]);

    expect(typing!.resolve).toHaveBeenCalledWith(
      { agentSession: 'crewly-alpha-leo', slackChannelId: 'C1', threadTs: '900.5' },
      'detail',
      expect.anything(),
    );
  });

  it('a reply under a root that never reached Slack goes top level, not into the latest thread', async () => {
    await service.routeInbound(inbound({ ts: '330.1' }));
    slack.sent = [];
    const localRoot = { ...post({ content: 'local note' }), senderType: 'user' as const };
    chat.messages[chat.messages.length - 1] = localRoot;

    await service.mirrorOutbound(post({ content: 'answer', threadId: localRoot.id }));

    expect(typing!.resolve).not.toHaveBeenCalled();
    expect(slack.sent).toHaveLength(1);
    expect(slack.sent[0].threadTs).toBeUndefined();
  });

  it('a "working on it" with no thread named is refused, not posted top level', async () => {
    const result = await service.beginWorkingForAgent({ chatChannelId: 'huddle-1', agentSession: 'crewly-alpha-leo' });

    expect(result).toEqual({ ok: false, reason: 'no_thread' });
    expect(typing!.begin).not.toHaveBeenCalled();
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
      expect.any(String), // the person's message ts (✅ when the agent settles without replying)
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
      // The other machine's id sorts after this one's, so this machine owns
      // the un-@'d message (see "one machine owns an un-@'d message").
      inbound({ ts: '800.1', room: room([['crewly-alpha-sam', 'mac', true], ['crewly-alpha-leo', 'mac', false], ['pa-ella', 'zz-air', true]]) }),
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

  describe('one machine owns an un-@\'d message (2026-10-03: two "Ella"s answered one owner message)', () => {
    // The Mac's Marketing Ella and the Air's Personal Assistant Ella are both
    // awake in the room. Every machine applies the same rule to the same
    // presence, so exactly one takes it.
    function serviceOn(instanceId: string, local: string) {
      isLocal = (s) => s === local;
      awake = (s) => s === local;
      return new SlackTeamChannelService({
        slack,
        chat: chat as unknown as TeamChannelChatApi,
        storage,
        getDispatcher: () => dispatcher,
        isAgentAwake: (s) => awake(s),
        isLocalAgent: (s) => isLocal(s),
        resolveInstanceId: async () => instanceId,
        getOwnerUserId: () => 'UOWNER',
        storePath: path.join(tmpDir, `slack-team-channels-${instanceId}.json`),
      });
    }
    const shared = (home?: string) => ({
      ...room([['crewly-marketing-ella', 'mac', true], ['pa-ella', 'air', true]]),
      ...(home ? { home: { instanceId: home } } : {}),
    });

    async function joinAdhoc(svc: SlackTeamChannelService, local: string): Promise<void> {
      await svc.routeInbound(inbound({ channelId: 'C-mkt', ts: '900.0', receivedVia: local }));
      dispatcher!.dispatchMessage.mockClear();
    }

    it('without room.home the lowest instance id with an awake member takes it; the other defers', async () => {
      const air = serviceOn('air', 'pa-ella');
      await joinAdhoc(air, 'pa-ella');
      await air.routeInbound(inbound({ channelId: 'C-mkt', ts: '900.1', room: shared() }));
      expect(optionsOf().room.awakeHere).toEqual(['pa-ella']);

      dispatcher!.dispatchMessage.mockClear();
      const mac = serviceOn('mac', 'crewly-marketing-ella');
      await joinAdhoc(mac, 'crewly-marketing-ella');
      await mac.routeInbound(inbound({ channelId: 'C-mkt', ts: '900.2', room: shared() }));
      expect(optionsOf().room).toEqual({ awakeHere: [], awakeElsewhere: true, wakeWhenAllAsleep: null });
    });

    it('room.home decides when Cloud sends it', async () => {
      const air = serviceOn('air', 'pa-ella');
      await joinAdhoc(air, 'pa-ella');
      await air.routeInbound(inbound({ channelId: 'C-mkt', ts: '900.3', room: shared('mac') }));
      expect(optionsOf().room.awakeHere).toEqual([]);
    });

    it('only the owner machine watches for an answer: a deferring machine never runs the fallback', async () => {
      const silent = {
        dispatchMessage: jest.fn(async () => ({ strategy: 'huddle-broadcast', dispatched: false, huddleOutcomes: [] })),
      } as unknown as typeof dispatcher;
      dispatcher = silent;
      const mac = serviceOn('mac', 'crewly-marketing-ella');
      await joinAdhoc(mac, 'crewly-marketing-ella');
      await mac.routeInbound(inbound({ channelId: 'C-mkt', ts: '900.4', userId: 'UOWNER', room: shared() }));
      expect((mac as unknown as { unanswered: Map<string, unknown> }).unanswered.size).toBe(0);
      mac.stop();
    });

    it('the owner machine watches even when its agents got the message optionally', async () => {
      dispatcher = {
        dispatchMessage: jest.fn(async () => ({
          strategy: 'huddle-broadcast',
          dispatched: true,
          huddleOutcomes: [{ sessionName: 'pa-ella', responseMode: 'optional', dispatched: true }],
        })),
      } as unknown as typeof dispatcher;
      const air = serviceOn('air', 'pa-ella');
      await joinAdhoc(air, 'pa-ella');
      await air.routeInbound(inbound({ channelId: 'C-mkt', ts: '900.5', userId: 'UOWNER', room: shared() }));
      expect((air as unknown as { unanswered: Map<string, unknown> }).unanswered.size).toBe(1);
      air.stop();
    });

    it('when Cloud names the wake-up machine, no other machine arms its own 90 s watch', async () => {
      dispatcher = {
        dispatchMessage: jest.fn(async () => ({ strategy: 'huddle-broadcast', dispatched: false, huddleOutcomes: [] })),
      } as unknown as typeof dispatcher;
      const mac = serviceOn('mac', 'crewly-marketing-ella');
      awake = () => false;
      await joinAdhoc(mac, 'crewly-marketing-ella');
      const asleep = {
        ...room([['crewly-marketing-ella', 'mac', false], ['pa-ella', 'air', false]]),
        fallback: { instanceId: 'air', agentSession: 'pa-ella', kind: 'team-leader' as const },
      };
      await mac.routeInbound(inbound({ channelId: 'C-mkt', ts: '902.1', userId: 'UOWNER', room: asleep }));
      expect((mac as unknown as { unanswered: Map<string, unknown> }).unanswered.size).toBe(0);
      mac.stop();
    });

    it('the fallback does not hand the message over again to a lead that already holds it', async () => {
      jest.useFakeTimers();
      try {
        const dispatchMessage = jest.fn(async () => ({
          strategy: 'huddle-broadcast',
          dispatched: true,
          huddleOutcomes: [{ sessionName: 'pa-ella', responseMode: 'optional', dispatched: true }],
        }));
        dispatcher = { dispatchMessage } as unknown as typeof dispatcher;
        const air = serviceOn('air', 'pa-ella');
        await joinAdhoc(air, 'pa-ella');
        dispatchMessage.mockClear();
        await air.routeInbound(inbound({ channelId: 'C-mkt', ts: '902.2', userId: 'UOWNER', room: shared() }));
        expect(dispatchMessage).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(91_000);
        // pa-ella is this room's lead here and already holds it: no second delivery.
        expect(dispatchMessage).toHaveBeenCalledTimes(1);
        air.stop();
      } finally {
        jest.useRealTimers();
      }
    });

    it('presence is judged from the snapshot for every machine, this one included', async () => {
      // Locally the Air's Ella is awake, but Cloud's snapshot says asleep:
      // the Mac (awake in the snapshot) owns it, on both machines alike.
      const air = serviceOn('air', 'pa-ella');
      await joinAdhoc(air, 'pa-ella');
      await air.routeInbound(inbound({ channelId: 'C-mkt', ts: '900.6', room: room([['crewly-marketing-ella', 'mac', true], ['pa-ella', 'air', false]]) }));
      expect(optionsOf().room.awakeHere).toEqual([]);
    });

    it('the orchestrator does not pick up a room message another machine owns', async () => {
      const mac = serviceOn('mac', 'crewly-marketing-ella');
      expect(await mac.sharedRoomOwnedElsewhere(inbound({ channelId: 'C-mkt', ts: '900.7', room: shared() }))).toBe(true);
      expect(await mac.sharedRoomOwnedElsewhere(inbound({ channelId: 'C-mkt', ts: '900.8', room: shared(), handoffTo: 'crewly-marketing-ella' }))).toBe(false);
      const air = serviceOn('air', 'pa-ella');
      expect(await air.sharedRoomOwnedElsewhere(inbound({ channelId: 'C-mkt', ts: '900.9', room: shared() }))).toBe(false);
      expect(
        await mac.sharedRoomOwnedElsewhere(inbound({ channelId: 'C-mkt', ts: '901.0', room: room([['crewly-marketing-ella', 'mac', false]]) })),
      ).toBe(false);
    });
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

describe('an owner message in a room never ends in silence', () => {
  // 2026-09-30, the Think Tank room: every member on the Mac was asleep, Cloud
  // said an agent on the Air was awake, so the Mac woke nobody — and the
  // Air's agent, only told optionally, stayed quiet. The owner got nothing.
  const ELLA = 'crewly-marketing-ella';
  const ATLAS = 'think-tank-atlas';
  const teams = (): Team[] => [
    team({ id: 'team-mkt', name: 'Marketing', members: [member('Ella', 'team-leader', { sessionName: ELLA })] }),
    team({
      id: 'team-think',
      name: 'Think Tank',
      members: [
        member('Atlas', 'team-leader', { sessionName: ATLAS }),
        member('Sage', 'researcher' as TeamMember['role'], { sessionName: 'think-tank-sage' }),
      ],
    }),
  ];
  // Cloud's snapshot still shows Ella awake on the Mac (she has just
  // stopped), so the Mac — lowest instance id with an awake member — owns
  // the message, while locally nobody is awake. (Since #1014 the owner
  // machine alone runs the fallback; see "one machine owns an un-@'d message".)
  const airAwake = {
    members: [
      { agentSession: ELLA, displayName: 'Ella', instanceId: 'mac', deviceName: 'mac', awake: true },
      { agentSession: ATLAS, displayName: 'Atlas', instanceId: 'mac', deviceName: 'mac', awake: false },
      { agentSession: 'pa-ella', displayName: 'Ella', instanceId: 'zz-air', deviceName: 'iriss-air', awake: true },
    ],
  };
  const FALLBACK_MS = 90 * 1000;
  const warnOf = () => (service as unknown as { logger: { warn: jest.Mock } }).logger.warn;

  /** Delivers to whoever was @'d (or handed it); an un-@'d message goes to nobody here. */
  function mentionOnlyDispatcher(ok = true) {
    return {
      dispatchMessage: jest.fn(async (_ch: ChatChannelDTO, msg: ChatMessageDTO) => {
        const to = msg.mentions ?? [];
        if (to.length === 0) return { strategy: 'huddle-broadcast', dispatched: false, huddleOutcomes: [] };
        return {
          strategy: 'huddle-broadcast',
          dispatched: ok,
          huddleOutcomes: to.map((sessionName) => ({ sessionName, responseMode: 'required', dispatched: ok })),
        };
      }),
    };
  }

  async function seedRoom() {
    storage.teams = teams();
    isLocal = (s) => s === ELLA || s === ATLAS || s === 'think-tank-sage';
    awake = () => false;
    identities = new FakeIdentities();
    service = new SlackTeamChannelService({
      slack,
      chat: chat as unknown as TeamChannelChatApi,
      storage,
      getDispatcher: () => dispatcher,
      identities,
      isAgentAwake: (s) => awake(s),
      isLocalAgent: (s) => isLocal(s),
      getOwnerUserId: () => 'UOWNER',
      resolveInstanceId: async () => 'mac',
      storePath: path.join(tmpDir, 'slack-team-channels.json'),
    });
    // The room: Ella's and Atlas's bots are in it; Atlas spoke there last.
    await service.routeInbound(inbound({ channelId: 'C-room', ts: '1.1', userId: 'U1', receivedVia: ELLA }));
    await service.routeInbound(inbound({ channelId: 'C-room', ts: '1.2', userId: 'U1', receivedVia: ATLAS }));
    const mapping = service.findBySlackChannelId('C-room')!;
    chat.recordTurn({ channelId: mapping.chatChannelId, senderType: 'agent', senderId: ATLAS, content: '清单好了', metadata: {} });
    dispatcher!.dispatchMessage.mockClear();
    warnOf().mockClear();
    return mapping;
  }

  const ownerAsks = (extra: Partial<SlackIncomingMessage> = {}) =>
    inbound({ channelId: 'C-room', ts: '2.1', userId: 'UOWNER', text: '我们之前那个对话算结束了吗？', room: airAwake, receivedVia: ATLAS, ...extra });

  beforeEach(() => {
    jest.useFakeTimers();
    dispatcher = mentionOnlyDispatcher();
  });

  afterEach(() => {
    jest.useRealTimers();
    awake = () => true;
    isLocal = () => false;
  });

  it('reproduces the drop: all asleep here, someone awake elsewhere → nobody here gets it, and it says so', async () => {
    await seedRoom();
    const routed = await service.routeInbound(ownerAsks());

    expect(routed!.dispatch).toMatchObject({ dispatched: false });
    expect(warnOf()).toHaveBeenCalledWith(
      'Slack room message reached nobody on this machine',
      expect.objectContaining({ awakeElsewhere: true, recipients: [] }),
    );
  });

  it('wakes the room lead here and delivers the message when nobody took it in time', async () => {
    await seedRoom();
    const routed = await service.routeInbound(ownerAsks());
    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(FALLBACK_MS);

    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(2);
    const [, delivered] = dispatcher!.dispatchMessage.mock.calls[1];
    // The same message, not a new row, addressed to Atlas — the member who
    // spoke there last — not to Ella, the first team lead in the list.
    expect(delivered.id).toBe(routed!.message.id);
    expect(delivered.mentions).toEqual([ATLAS]);
    expect(slack.sent).toEqual([]);
  });

  it('falls back to the team lead rule when no local member ever spoke there', async () => {
    const mapping = await seedRoom();
    chat.messages = chat.messages.filter((m) => !(m.channelId === mapping.chatChannelId && m.senderType === 'agent'));
    await service.routeInbound(ownerAsks());

    await jest.advanceTimersByTimeAsync(FALLBACK_MS);

    expect(dispatcher!.dispatchMessage.mock.calls[1][1].mentions).toEqual([ELLA]);
  });

  it('does nothing more when an agent on another machine answers in the thread', async () => {
    await seedRoom();
    await service.routeInbound(ownerAsks());
    await service.routeInbound(
      inbound({ channelId: 'C-room', ts: '2.2', threadTs: '2.1', userId: 'UBOT', text: '我来', authorAgentSession: 'pa-ella', authorDisplayName: 'Ella' }),
    );
    dispatcher!.dispatchMessage.mockClear();

    await jest.advanceTimersByTimeAsync(FALLBACK_MS);

    expect(dispatcher!.dispatchMessage).not.toHaveBeenCalled();
    expect(slack.sent).toEqual([]);
  });

  it('tells the owner in the thread when the lead cannot be woken either', async () => {
    dispatcher = mentionOnlyDispatcher(false);
    await seedRoom();
    identities!.records.set(ATLAS, {
      agentSession: ATLAS, displayName: 'Atlas', appId: 'A1', status: 'installed', botUserId: 'UATLAS', botToken: 'xoxb-atlas',
      announcedIn: [], invitedTo: [], updatedAt: 'now',
    });
    await service.routeInbound(ownerAsks());

    await jest.advanceTimersByTimeAsync(FALLBACK_MS);

    expect(slack.sent).toEqual([
      expect.objectContaining({ channelId: 'C-room', threadTs: '2.1', botToken: 'xoxb-atlas', text: expect.stringContaining('No agent picked up this message') }),
    ]);
  });

  // crewly#1015 §7: "旧模板是什么" (10-02) was recorded and then nothing —
  // an await in routing never settled, and every safeguard sits after it.
  describe('route guard', () => {
    const STALL_MS = 4 * 60 * 1000;
    const STEP_MS = 30 * 1000;
    const errorOf = () => (service as unknown as { logger: { error: jest.Mock } }).logger.error;
    afterEach(() => {
      delete process.env.CREWLY_ROOM_ROUTE_STEP_TIMEOUT_MS;
    });

    it('a step before dispatch that never settles is skipped after its timeout; the message is dispatched once', async () => {
      await seedRoom();
      void service.routeInbound(ownerAsks({ text: '@Atlas 在吗', mentionedAgentSessions: [ATLAS], threadContext: new Promise(() => undefined) } as Partial<SlackIncomingMessage>));
      await jest.advanceTimersByTimeAsync(STEP_MS + 1000);
      expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(STALL_MS * 2);
      expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
      expect(errorOf()).not.toHaveBeenCalledWith(expect.stringContaining('routing'), expect.anything());
    });

    // Review B3: sequential cold starts inside dispatch can exceed 4 min.
    it('a slow dispatch is never timed and never rescued (no double delivery)', async () => {
      await seedRoom();
      dispatcher = { dispatchMessage: jest.fn(() => new Promise<never>(() => undefined)) } as unknown as typeof dispatcher;
      void service.routeInbound(ownerAsks());
      await jest.advanceTimersByTimeAsync(STALL_MS * 3);
      expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
      expect(slack.sent).toEqual([]);
    });

    it('a throw inside dispatch is not rescued: the error surfaces, nothing is delivered twice', async () => {
      await seedRoom();
      dispatcher = { dispatchMessage: jest.fn(async () => { throw new Error('relay down'); }) } as unknown as typeof dispatcher;
      await expect(service.routeInbound(ownerAsks())).rejects.toThrow('relay down');
      await jest.advanceTimersByTimeAsync(STALL_MS * 2);
      expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
    });

    it('routing stuck before dispatch is rescued (the room lead is handed it); the late original does not dispatch again', async () => {
      process.env.CREWLY_ROOM_ROUTE_STEP_TIMEOUT_MS = String(10 * 60 * 1000);
      await seedRoom();
      void service.routeInbound(ownerAsks({ threadContext: new Promise(() => undefined) } as Partial<SlackIncomingMessage>));
      await jest.advanceTimersByTimeAsync(STALL_MS + 1000);
      expect(errorOf()).toHaveBeenCalledWith(expect.stringContaining('routing has not finished'), expect.objectContaining({ ts: '2.1' }));
      // The rescue's hand-off to Atlas (its own routing carries no hanging step).
      expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
      expect(dispatcher!.dispatchMessage.mock.calls[0][1].mentions).toEqual([ATLAS]);
      // The original finally gets past the step: it must not dispatch, nor arm another watch.
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
      await jest.advanceTimersByTimeAsync(2 * 90 * 1000);
      expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
      expect(slack.sent).toEqual([]);
    });

    // Follow-up L2: the original routing's placeholders come down (quietly) on a rescue.
    it('a rescue takes the original routing\'s placeholders down quietly before the hand-off', async () => {
      process.env.CREWLY_ROOM_ROUTE_STEP_TIMEOUT_MS = String(10 * 60 * 1000);
      await seedRoom();
      const calls: string[] = [];
      (service as unknown as { deps: Record<string, unknown> }).deps.typing = {
        begin: async (key: { agentSession: string }) => { calls.push(`begin:${key.agentSession}`); return null; },
        setPhase: async () => undefined,
        fail: async () => undefined,
        resolve: async () => 'replaced',
        withdraw: async (key: { agentSession: string }) => { calls.push(`withdraw:${key.agentSession}`); return 1; },
      };
      void service.routeInbound(ownerAsks({ text: '@Ella 看一下这个', threadContext: new Promise(() => undefined) } as Partial<SlackIncomingMessage>));
      await jest.advanceTimersByTimeAsync(1000);
      const posted = calls.filter((c) => c.startsWith('begin:'));
      expect(posted.length).toBeGreaterThan(0);
      await jest.advanceTimersByTimeAsync(STALL_MS);
      const withdrawn = calls.filter((c) => c.startsWith('withdraw:')).map((c) => c.slice('withdraw:'.length));
      expect(withdrawn).toEqual(posted.map((c) => c.slice('begin:'.length)));
      // Withdrawn before the hand-off posted its own.
      expect(calls.indexOf(`withdraw:${withdrawn[0]}`)).toBeLessThan(calls.lastIndexOf(`begin:${ATLAS}`));
    });

    it('a stuck hand-off (the rescue itself) tells the owner in the thread', async () => {
      process.env.CREWLY_ROOM_ROUTE_STEP_TIMEOUT_MS = String(10 * 60 * 1000);
      await seedRoom();
      identities!.records.set(ATLAS, {
        agentSession: ATLAS, displayName: 'Atlas', appId: 'A1', status: 'installed', botUserId: 'UATLAS', botToken: 'xoxb-atlas',
        announcedIn: [], invitedTo: [], updatedAt: 'now',
      });
      // Every routing of this message (original and hand-off) hangs before dispatch.
      const hanging = { ...mentionOnlyDispatcher(), planHuddleTargets: jest.fn(() => new Promise<never>(() => undefined)) };
      dispatcher = hanging as unknown as typeof dispatcher;
      void service.routeInbound(ownerAsks());
      await jest.advanceTimersByTimeAsync(STALL_MS + 1000);
      await jest.advanceTimersByTimeAsync(STALL_MS + 1000);
      expect(slack.sent).toEqual([
        expect.objectContaining({ channelId: 'C-room', threadTs: '2.1', text: expect.stringContaining("couldn't get this message to an agent") }),
      ]);
      expect(dispatcher!.dispatchMessage).not.toHaveBeenCalled();
    });
  });

  it('only warns for someone other than the owner — no wake', async () => {
    await seedRoom();
    await service.routeInbound(ownerAsks({ userId: 'USOMEONE' }));
    expect(warnOf()).toHaveBeenCalledWith('Slack room message reached nobody on this machine', expect.anything());

    await jest.advanceTimersByTimeAsync(FALLBACK_MS);

    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
    expect(slack.sent).toEqual([]);
  });

  it('does not wait when the message was delivered here and no other machine is in on it', async () => {
    await seedRoom();
    awake = (s) => s === ATLAS;
    dispatcher = {
      dispatchMessage: jest.fn().mockResolvedValue({
        strategy: 'huddle-broadcast', dispatched: true, huddleOutcomes: [{ sessionName: ATLAS, responseMode: 'optional', dispatched: true }],
      }),
    };
    const macOnly = { members: [{ agentSession: ATLAS, displayName: 'Atlas', instanceId: 'mac', deviceName: 'mac', awake: true }] };
    await service.routeInbound(ownerAsks({ room: macOnly }));

    await jest.advanceTimersByTimeAsync(FALLBACK_MS);

    expect(dispatcher.dispatchMessage).toHaveBeenCalledTimes(1);
    expect(warnOf()).not.toHaveBeenCalledWith('Slack room message reached nobody on this machine', expect.anything());
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

  it('an interim reply puts the placeholder back under it; the final reply does not', async () => {
    typing = { begin: jest.fn().mockResolvedValue(null), resolve: jest.fn().mockResolvedValue('edited'), setPhase: jest.fn(), fail: jest.fn() };
    identities = new FakeIdentities();
    service = makeService();
    await service.ensureTeamChannel(team());
    identities!.install('crewly-alpha-leo', 'ULEO', 'xoxb-leo');
    await service.routeInbound(inbound({ text: 'big job', ts: '710.1' }));
    const root = chat.messages.find((m) => m.metadata?.slackTs === '710.1')!;
    const base = { channelId: 'huddle-1', seq: 1, senderType: 'agent', senderId: 'crewly-alpha-leo', contentType: 'markdown', createdAt: 1, attachments: [], mentions: [], threadId: root.id };
    typing.begin.mockClear();
    await service.mirrorOutbound({ ...base, id: 'i-1', content: 'Got it — plan: …', metadata: { source: 'reply-tool', interim: true } } as ChatMessageDTO);
    const key = { agentSession: 'crewly-alpha-leo', slackChannelId: 'C1', threadTs: '710.1' };
    // Re-opened in the same step as the interim note, so a fast final answer
    // cannot slip in between and leave the new placeholder under it (2026-09-28).
    expect(typing.resolve).toHaveBeenLastCalledWith(key, 'Got it — plan: …', { botToken: 'xoxb-leo', displayName: 'Leo' }, { reopen: 'typing' });
    typing.resolve.mockClear();
    await service.mirrorOutbound({ ...base, id: 'f-1', content: 'Done', metadata: { source: 'reply-tool' } } as ChatMessageDTO);
    expect(typing.resolve).toHaveBeenLastCalledWith(key, 'Done', { botToken: 'xoxb-leo', displayName: 'Leo' });
    expect(typing.begin).not.toHaveBeenCalled();
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

  it('lands in the thread its reply goes to (the work destination), like `reply`', async () => {
    // Otherwise the file appears at the bottom of the channel while the
    // conversation about it is somewhere above.
    await service.routeInbound(inbound({ ts: '200.1', text: '@sam send the pdf' }));
    await service.routeInbound(inbound({ ts: '300.1', text: '@sam unrelated, newer' }));

    await service.attachFileForAgent({
      chatChannelId: 'huddle-1',
      agentSession: 'crewly-alpha-sam',
      filePath: '/tmp/proposal.pdf',
      destination: { slackChannelId: 'C1', threadTs: '200.1' },
    });

    expect(slack.uploads[0].threadTs).toBe('200.1');
  });

  it('with no destination it is a new top-level post — never the latest thread (2026-10-01)', async () => {
    // Atlas's answer to a #morning-brief question landed in the owner's
    // newer, unrelated Blender-video thread.
    await service.routeInbound(inbound({ ts: '300.1', text: '@sam unrelated, newer' }));

    await service.attachFileForAgent({ chatChannelId: 'huddle-1', agentSession: 'crewly-alpha-sam', filePath: '/tmp/a.md', destination: null });
    expect(slack.uploads[0].threadTs).toBeUndefined();

    // A top-level destination in this channel opens with its topic line.
    await service.attachFileForAgent({
      chatChannelId: 'huddle-1',
      agentSession: 'crewly-alpha-sam',
      filePath: '/tmp/b.md',
      comment: 'notes',
      destination: { slackChannelId: 'C1', topic: 'Starship launches' },
    });
    expect(slack.uploads[1].threadTs).toBeUndefined();
    expect(slack.uploads[1].initialComment).toBe('*Starship launches*\nnotes');

    // A destination in another channel does not pick a thread here.
    await service.attachFileForAgent({ chatChannelId: 'huddle-1', agentSession: 'crewly-alpha-sam', filePath: '/tmp/c.md', destination: { slackChannelId: 'C9OTHER', threadTs: '1.2' } });
    expect(slack.uploads[2].threadTs).toBeUndefined();
  });

  it('takes a Slack thread key for this channel as --thread; refuses one for another channel instead of uploading top level (2026-10-02)', async () => {
    await service.routeInbound(inbound({ ts: '200.1', text: '@sam first' }));
    await service.routeInbound(inbound({ ts: '300.1', text: '@sam second' }));
    await service.attachFileForAgent({ chatChannelId: 'huddle-1', agentSession: 'crewly-alpha-sam', filePath: '/tmp/a.pdf', threadId: 'C1:1790000200.000100' });
    expect(slack.uploads[0].threadTs).toBe('1790000200.000100');
    const other = await service.attachFileForAgent({ chatChannelId: 'huddle-1', agentSession: 'crewly-alpha-sam', filePath: '/tmp/b.pdf', threadId: 'C9OTHER:1790000200.000100' });
    expect(other).toEqual({ ok: false, reason: 'thread_not_in_this_channel' });
    expect(slack.uploads).toHaveLength(1);
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
    const announce = slack.sent.find((m) => m.text.includes('Created Slack identities'));
    expect(announce?.channelId).toBe('C1');
    expect(announce?.text).toContain('Install Sam');
    expect(announce?.text).toContain('state=crewly-alpha-leo');
    expect(identities!.get('crewly-alpha-sam')?.announcedIn).toEqual(['C1']);

    // A second roster sync must not re-announce.
    slack.sent = [];
    await service.syncTeamMembers(team());
    expect(slack.sent.find((m) => m.text.includes('Created Slack identities'))).toBeUndefined();
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
      expect.any(String), // the person's message ts (✅ when the agent settles without replying)
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
    slack.getBotUserId = async () => 'UMASTER';
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
      expect.any(String), // the person's message ts (✅ when the agent settles without replying)
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
      expect.any(String), // the person's message ts (✅ when the agent settles without replying)
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
    expect(slack.sent.find((m) => m.text.includes('Created Slack identities'))).toBeUndefined();
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

// ---------------------------------------------------------------------------
// Extra channels for a set of agents (solution bundles)
// ---------------------------------------------------------------------------

describe('ensureAgentChannel', () => {
  it('creates the channel, a huddle with the agents, invites the owner and stores an ad-hoc mapping', async () => {
    const mapping = await service.ensureAgentChannel({
      name: '小周咖啡 待审批',
      purpose: '等老板点头',
      memberSessions: ['crewly-alpha-sam', 'crewly-alpha-leo', 'crewly-alpha-sam'],
    });
    expect(slack.created).toEqual(['小周咖啡-待审批']);
    expect(slack.invites).toEqual([{ channelId: 'C1', userIds: ['UOWNER'] }]);
    expect(slack.purposes).toEqual([{ id: 'C1', purpose: '等老板点头' }]);
    expect(mapping).toMatchObject({
      teamId: 'adhoc:C1',
      slackChannelId: 'C1',
      autoCreated: true,
      derivedName: '小周咖啡-待审批',
      members: ['crewly-alpha-sam', 'crewly-alpha-leo'],
      ownerInvited: true,
    });
    expect([...chat.members.get(mapping.chatChannelId)!]).toEqual(['crewly-alpha-sam', 'crewly-alpha-leo']);
    expect(await service.listMappings()).toEqual(expect.arrayContaining([expect.objectContaining({ teamId: 'adhoc:C1' })]));
  });

  it('is idempotent by name or known channel id, and adds new agents to the roster', async () => {
    const first = await service.ensureAgentChannel({ name: 'approvals', purpose: '', memberSessions: ['crewly-alpha-sam'] });
    const again = await service.ensureAgentChannel({ name: 'approvals', purpose: '', memberSessions: ['crewly-alpha-leo'] });
    const byId = await service.ensureAgentChannel({ name: 'renamed', purpose: '', memberSessions: [], existingChannelId: first.slackChannelId });
    expect(slack.created).toEqual(['approvals']);
    expect(again.slackChannelId).toBe(first.slackChannelId);
    expect(byId.slackChannelId).toBe(first.slackChannelId);
    expect(again.members).toEqual(['crewly-alpha-sam', 'crewly-alpha-leo']);
    expect([...chat.members.get(first.chatChannelId)!]).toEqual(['crewly-alpha-sam', 'crewly-alpha-leo']);
  });

  it('invites agents whose bot is installed, now or when it gets installed later', async () => {
    identities = new FakeIdentities();
    service = makeService();
    await service.start();
    await identities.provision('crewly-alpha-sam', 'Sam');
    await identities.provision('crewly-alpha-leo', 'Leo');
    identities.install('crewly-alpha-sam', 'USAM', 'xoxb-sam');
    slack.invites = [];
    const mapping = await service.ensureAgentChannel({ name: 'intel', purpose: '', memberSessions: ['crewly-alpha-sam', 'crewly-alpha-leo'] });
    expect(slack.invites).toContainEqual({ channelId: mapping.slackChannelId, userIds: ['USAM'] });
    identities.install('crewly-alpha-leo', 'ULEO', 'xoxb-leo');
    await new Promise((resolve) => setImmediate(resolve));
    expect(slack.invites).toContainEqual({ channelId: mapping.slackChannelId, userIds: ['ULEO'] });
  });

  it('throws when Slack is not connected', async () => {
    slack.connected = false;
    await expect(service.ensureAgentChannel({ name: 'x', purpose: '', memberSessions: [] })).rejects.toThrow('Slack is not connected');
  });
});

// ---------------------------------------------------------------------------
// Harness-posted "working on it" (2026-09-30, #pro-ce)
// ---------------------------------------------------------------------------

describe('harness "working on it" watch', () => {
  let handle: { delivered: jest.Mock; cancel: jest.Mock };

  beforeEach(() => {
    handle = { delivered: jest.fn(), cancel: jest.fn() };
    autoWorking = { watch: jest.fn().mockReturnValue(handle) };
    typing = { begin: jest.fn().mockResolvedValue(null), resolve: jest.fn(), setPhase: jest.fn(), fail: jest.fn() };
    dispatcher = {
      dispatchMessage: jest.fn().mockResolvedValue({
        strategy: 'huddle-broadcast',
        dispatched: true,
        huddleOutcomes: [
          { sessionName: 'crewly-alpha-sam', responseMode: 'optional', dispatched: true },
          { sessionName: 'crewly-alpha-leo', responseMode: 'optional', dispatched: false },
        ],
      }),
    };
  });

  afterEach(() => {
    autoWorking = null;
    typing = null;
  });

  it('an owner\'s un-@ channel message is watched in its thread and reports who it reached', async () => {
    service = makeService();
    await service.ensureTeamChannel(team());

    await service.routeInbound(inbound({ text: '把律所邮件改成 $299/月', userId: 'UOWNER', ts: '700.1' }));

    expect(autoWorking!.watch).toHaveBeenCalledTimes(1);
    const [delivery] = autoWorking!.watch.mock.calls[0];
    expect(delivery).toMatchObject({ slackChannelId: 'C1', threadTs: '700.1', sourceTs: '700.1' });
    expect(delivery.candidates).toEqual(expect.arrayContaining(['crewly-alpha-sam', 'crewly-alpha-leo']));
    // Same principal /api/slack/working would use: cosmetic identity without an installed bot.
    expect(delivery.identityFor('crewly-alpha-sam')).toMatchObject({ displayName: 'Sam' });
    // Only the recipients the message actually reached.
    expect(handle.delivered).toHaveBeenCalledWith(['crewly-alpha-sam']);
  });

  it('a threaded owner reply is watched in that thread', async () => {
    service = makeService();
    await service.ensureTeamChannel(team());
    await service.routeInbound(inbound({ text: 'follow-up', userId: 'UOWNER', ts: '701.2', threadTs: '700.1' }));
    expect(autoWorking!.watch.mock.calls[0][0]).toMatchObject({ threadTs: '700.1', sourceTs: '701.2' });
  });

  it('a message from someone other than the owner is not watched', async () => {
    service = makeService();
    await service.ensureTeamChannel(team());
    await service.routeInbound(inbound({ text: 'hi', userId: 'U-SOMEONE-ELSE', ts: '702.1' }));
    expect(autoWorking!.watch).not.toHaveBeenCalled();
  });

  it('an agent\'s message (agent-to-agent, any machine) is not watched', async () => {
    service = makeService();
    await service.ensureTeamChannel(team());
    await service.routeInbound(
      inbound({ text: '@sam can you check', userId: 'UOWNER', ts: '703.1', authorAgentSession: 'mk-atlas', authorDisplayName: 'Atlas' }),
    );
    expect(autoWorking!.watch).not.toHaveBeenCalled();
  });

  it('without placeholders wired, nothing is watched', async () => {
    typing = null;
    service = makeService();
    await service.ensureTeamChannel(team());
    await service.routeInbound(inbound({ text: 'hi', userId: 'UOWNER', ts: '704.1' }));
    expect(autoWorking!.watch).not.toHaveBeenCalled();
  });
});

describe('a message that @\'s people, not agents', () => {
  // 2026-10-01, #course-standardization-team: in a thread Jordan had been
  // answering, the owner asked a colleague "@Info 这些课堂视频是现在每节课上传的那些吗?".
  // `<@U…>` of a person resolved to nothing, the message counted as un-@'d,
  // and the "last speaker must answer" rule handed it to Jordan, who replied.
  let intake: { intakeWithOutcome: jest.Mock };
  let watched: { delivered: jest.Mock };
  const infoOf = () => (service as unknown as { logger: { info: jest.Mock } }).logger.info;

  beforeEach(async () => {
    intake = { intakeWithOutcome: jest.fn(async () => ({ action: 'none' })) };
    setTicketIntakeService(intake as unknown as TicketIntakeService);
    identities = new FakeIdentities();
    typing = { begin: jest.fn().mockResolvedValue(null), resolve: jest.fn(), setPhase: jest.fn().mockResolvedValue(undefined), fail: jest.fn().mockResolvedValue(undefined) };
    watched = { delivered: jest.fn() };
    autoWorking = { watch: jest.fn(() => watched) };
    // Sam spoke last in the thread: the plan the dispatcher would make for a bare follow-up.
    dispatcher = {
      dispatchMessage: jest.fn().mockResolvedValue({ strategy: 'huddle-broadcast', dispatched: true, huddleOutcomes: [] }),
      planHuddleTargets: jest.fn().mockResolvedValue(new Map([['crewly-alpha-sam', 'required']])),
    };
    service = makeService();
    await service.ensureTeamChannel(team());
    identities.install('crewly-alpha-sam', 'USAM', 'xoxb-sam');
    identities.install('crewly-alpha-leo', 'ULEO', 'xoxb-leo');
    // The thread Sam has been answering.
    await service.routeInbound(inbound({ text: '<@USAM> 课堂视频整理好了吗', userId: 'UOWNER', ts: '900.1' }));
    for (const m of [dispatcher.dispatchMessage, dispatcher.planHuddleTargets!, intake.intakeWithOutcome, autoWorking.watch, typing.begin]) m.mockClear();
    infoOf().mockClear();
    slack.reactions = [];
    slack.sent = [];
  });

  afterEach(() => {
    setTicketIntakeService(null);
    typing = null;
    autoWorking = null;
    setSlackDirectoryService(null);
  });

  it('the incident: a thread follow-up that @\'s a person reaches no agent — recorded as context only', async () => {
    const result = await service.routeInbound(
      inbound({ text: '<@UINFO> 这些课堂视频是现在每节课上传的那些吗？', userId: 'UOWNER', ts: '900.2', threadTs: '900.1' }),
    );

    expect(result).not.toBeNull();
    expect(result!.dispatch).toBeNull();
    expect(result!.mentions).toEqual([]);
    // Recorded in the thread, so the agents have it as context next time.
    expect(result!.message.threadId).toBeDefined();
    expect(result!.message.metadata).toMatchObject({ slackMentionedPeople: ['UINFO'] });
    expect(chat.messages).toContainEqual(expect.objectContaining({ id: result!.message.id }));
    // Nobody told, nobody owes a reply.
    expect(dispatcher!.planHuddleTargets).not.toHaveBeenCalled();
    expect(dispatcher!.dispatchMessage).not.toHaveBeenCalled();
    expect(slack.reactions.filter((r) => r.ts === '900.2')).toEqual([]);
    expect(typing!.begin).not.toHaveBeenCalled();
    expect(autoWorking!.watch).not.toHaveBeenCalled();
    expect(intake.intakeWithOutcome).not.toHaveBeenCalled();
    expect((service as unknown as { unanswered: Map<string, unknown> }).unanswered.size).toBe(0);
    expect(slack.sent).toEqual([]); // no "did you mean"
    expect(infoOf()).toHaveBeenCalledWith(
      'Slack team message addressed to people, not agents — recorded, not dispatched',
      expect.objectContaining({ mentionedUsers: ['UINFO'], threaded: true }),
    );
  });

  it('a person and an agent @\'d together: only that agent gets it, and it knows a person was named', async () => {
    dispatcher!.planHuddleTargets!.mockResolvedValue(new Map([['crewly-alpha-leo', 'required']]));

    const result = await service.routeInbound(
      inbound({ text: '<@UINFO> <@ULEO> 你们核对一下', userId: 'UOWNER', ts: '900.3', threadTs: '900.1' }),
    );

    expect(result!.mentions).toEqual(['crewly-alpha-leo']);
    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
    const sent = dispatcher!.dispatchMessage.mock.calls[0][1] as ChatMessageDTO;
    expect(sent.mentions).toEqual(['crewly-alpha-leo']);
    expect(sent.metadata).toMatchObject({ slackMentionedPeople: ['UINFO'] });
  });

  it('no mentions at all: unchanged — the thread\'s last speaker is planned and dispatched', async () => {
    const result = await service.routeInbound(inbound({ text: '那就这样吧', userId: 'UOWNER', ts: '900.4', threadTs: '900.1' }));

    expect(dispatcher!.planHuddleTargets).toHaveBeenCalledTimes(1);
    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
    expect(result!.message.metadata).not.toHaveProperty('slackMentionedPeople');
    expect(typing!.begin).toHaveBeenCalledWith(expect.objectContaining({ agentSession: 'crewly-alpha-sam' }), expect.anything(), 'typing', '900.4');
  });

  it('@here / @channel: unchanged — a room message nobody in particular was asked', async () => {
    const result = await service.routeInbound(inbound({ text: '<!here> 有人看到这个吗', userId: 'UOWNER', ts: '900.5' }));

    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
    expect(result!.message.metadata).not.toHaveProperty('slackMentionedPeople');
  });

  it('a typed @Name of a person who has spoken here is a person: no suggestion hint, no dispatch', async () => {
    await service.routeInbound(inbound({ text: '收到', userId: 'UINFO', user: { id: 'UINFO', name: 'info', realName: 'Info' } as SlackIncomingMessage['user'], ts: '900.6', threadTs: '900.1' }));
    dispatcher!.dispatchMessage.mockClear();
    slack.sent = [];

    const result = await service.routeInbound(inbound({ text: '@Info 这些是每节课上传的吗', userId: 'UOWNER', ts: '900.7', threadTs: '900.1' }));

    expect(result!.dispatch).toBeNull();
    expect(dispatcher!.dispatchMessage).not.toHaveBeenCalled();
    expect(slack.sent).toEqual([]);
  });

  it('a typed @name that is nobody known still gets the suggestion hint and is dispatched', async () => {
    await service.routeInbound(inbound({ text: '@lee 帮忙', userId: 'UOWNER', ts: '900.8' }));
    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
    expect(slack.sent.find((m) => m.threadTs === '900.8')?.text).toContain('@Leo');
  });

  it('the Crewly master bot is not a person', async () => {
    slack.getBotUserId = async () => 'UCREWLY';
    await service.routeInbound(inbound({ text: '<@UCREWLY> 谁在？', userId: 'UOWNER', ts: '900.9' }));
    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('an agent on another machine the account directory lists is not a person', async () => {
    setSlackDirectoryService({
      list: async () => [
        { name: 'Atlas', mention: '<@UATLAS>', botUserId: 'UATLAS', agentSession: 'think-tank-atlas', team: 'Think Tank', machine: 'mac', source: 'this-account', inChannel: true, kind: 'agent' },
      ],
      rosterLine: async () => '',
    } as unknown as SlackDirectoryService);

    await service.routeInbound(inbound({ text: '<@UATLAS> 你看下', userId: 'UOWNER', ts: '901.1', threadTs: '900.1' }));

    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
    const sent = dispatcher!.dispatchMessage.mock.calls[0][1] as ChatMessageDTO;
    expect(sent.metadata).not.toHaveProperty('slackMentionedPeople');
  });

  it('a bot the directory knows (another account\'s agent, another vendor) is not a person', async () => {
    setSlackDirectoryService({
      list: async () => [
        { name: 'Other Bot', mention: '<@UBOT>', botUserId: 'UBOT', agentSession: null, team: null, machine: null, source: 'channel', inChannel: true, kind: 'bot' },
        { name: 'Info', mention: '<@UINFO>', botUserId: null, agentSession: null, team: null, machine: null, source: 'channel', inChannel: true, kind: 'human' },
      ],
      rosterLine: async () => '',
    } as unknown as SlackDirectoryService);

    await service.routeInbound(inbound({ text: '<@UBOT> status?', userId: 'UOWNER', ts: '901.3', threadTs: '900.1' }));
    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);

    const result = await service.routeInbound(inbound({ text: '<@UINFO> 你看下', userId: 'UOWNER', ts: '901.4', threadTs: '900.1' }));
    expect(result!.dispatch).toBeNull();
    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('an agent\'s own post that @\'s a person is handled as before', async () => {
    await service.routeInbound(
      inbound({ text: '<@UINFO> 请确认', userId: 'UMIA', ts: '901.2', threadTs: '900.1', authorAgentSession: 'remote-team-mia', authorDisplayName: 'Mia' }),
    );
    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
  });
});

describe('follow-ups of a person-to-person exchange', () => {
  // 2026-10-02, #personal-assistant-team (steamfun-ops, 1.20.191). Info (a
  // person) asked Steve top-level; Steve answered in the thread with two
  // messages 35 s apart. The first carried the @ and was recorded only; the
  // second had no @ at all, counted as un-addressed, nobody was awake, and
  // the team leader Aria was woken (optional) and answered it.
  const STEVE = 'U0ALXV0ARC6';
  const INFO = 'U0AMU9APG9E';
  const ROOT_TS = '1759438024.000100'; // 16:47:04Z
  const STEVE_1_TS = '1759438604.000200'; // 20:56:44Z
  const STEVE_2_TS = '1759438639.000300'; // 20:57:19Z, 35 s later
  const STEVE_3_TS = '1759438702.000400'; // 20:58:22Z
  const later = (ts: string, seconds: number) => (Number.parseFloat(ts) + seconds).toFixed(6);
  const ROOT = `<@${STEVE}> \n为什么每次都要我授权呢？能不能一次性的设置呢`;
  const STEVE_1 = `<@${INFO}> 没有 目前没有连接你的calendar和gmail`;
  const STEVE_2 = '因为这里主要是用来做steamfun的 所以我只联通了Google drive';
  const STEVE_3 = 'Gmail和Calendar都要分开授权 你可以看看授权哪个账号（可以是steamfun的 也可以是你自己的）';
  // Cloud's view: nobody in the room awake, this machine wakes the team leader.
  const asleepRoom = {
    members: [
      { agentSession: 'crewly-alpha-sam', displayName: 'Sam', instanceId: 'i-1', deviceName: 'ops', awake: false },
      { agentSession: 'crewly-alpha-leo', displayName: 'Leo', instanceId: 'i-1', deviceName: 'ops', awake: false },
    ],
    fallback: { instanceId: 'i-1', agentSession: 'crewly-alpha-sam', kind: 'team-leader' as const },
  };
  let intake: { intakeWithOutcome: jest.Mock };
  const infoOf = () => (service as unknown as { logger: { info: jest.Mock } }).logger.info;
  const unanswered = () => (service as unknown as { unanswered: Map<string, unknown> }).unanswered;
  const savedWindow = process.env.CREWLY_SLACK_PEOPLE_FOLLOWUP_WINDOW_MS;
  const savedExchange = process.env.CREWLY_SLACK_PERSON_EXCHANGE_WINDOW_MS;

  /** Nothing about the message reached an agent: context only. */
  const expectContextOnly = (result: Awaited<ReturnType<SlackTeamChannelService['routeInbound']>>, ts: string) => {
    expect(result).not.toBeNull();
    expect(result!.dispatch).toBeNull();
    expect(result!.mentions).toEqual([]);
    expect(chat.messages).toContainEqual(expect.objectContaining({ id: result!.message.id }));
    expect(dispatcher!.planHuddleTargets).not.toHaveBeenCalled();
    expect(dispatcher!.dispatchMessage).not.toHaveBeenCalled();
    expect(slack.reactions.filter((r) => r.ts === ts)).toEqual([]);
    expect(typing!.begin).not.toHaveBeenCalled();
    expect(autoWorking!.watch).not.toHaveBeenCalled();
    expect(intake.intakeWithOutcome).not.toHaveBeenCalled();
    expect(unanswered().size).toBe(0);
    expect(slack.sent).toEqual([]);
  };
  const clearMocks = () => {
    for (const m of [dispatcher!.dispatchMessage, dispatcher!.planHuddleTargets!, intake.intakeWithOutcome, autoWorking!.watch, typing!.begin]) m.mockClear();
    infoOf().mockClear();
    slack.reactions = [];
    slack.sent = [];
  };

  beforeEach(async () => {
    delete process.env.CREWLY_SLACK_PEOPLE_FOLLOWUP_WINDOW_MS;
    delete process.env.CREWLY_SLACK_PERSON_EXCHANGE_WINDOW_MS;
    intake = { intakeWithOutcome: jest.fn(async () => ({ action: 'none' })) };
    setTicketIntakeService(intake as unknown as TicketIntakeService);
    identities = new FakeIdentities();
    typing = { begin: jest.fn().mockResolvedValue(null), resolve: jest.fn(), setPhase: jest.fn().mockResolvedValue(undefined), fail: jest.fn().mockResolvedValue(undefined) };
    autoWorking = { watch: jest.fn(() => ({ delivered: jest.fn() })) };
    awake = () => false;
    // The plan the dispatcher makes for an un-addressed message in an asleep room: wake the lead.
    dispatcher = {
      dispatchMessage: jest.fn().mockResolvedValue({ strategy: 'huddle-broadcast', dispatched: true, huddleOutcomes: [] }),
      planHuddleTargets: jest.fn().mockResolvedValue(new Map([['crewly-alpha-sam', 'optional']])),
    };
    service = makeService();
    await service.ensureTeamChannel(team());
    identities.install('crewly-alpha-sam', 'USAM', 'xoxb-sam');
    identities.install('crewly-alpha-leo', 'ULEO', 'xoxb-leo');
  });

  afterEach(() => {
    if (savedWindow === undefined) delete process.env.CREWLY_SLACK_PEOPLE_FOLLOWUP_WINDOW_MS;
    else process.env.CREWLY_SLACK_PEOPLE_FOLLOWUP_WINDOW_MS = savedWindow;
    if (savedExchange === undefined) delete process.env.CREWLY_SLACK_PERSON_EXCHANGE_WINDOW_MS;
    else process.env.CREWLY_SLACK_PERSON_EXCHANGE_WINDOW_MS = savedExchange;
    setTicketIntakeService(null);
    typing = null;
    autoWorking = null;
    awake = () => true;
    ownerUserId = 'UOWNER';
    setSlackDirectoryService(null);
  });

  /** Info's root and Steve's first (@Info) reply, both recorded only. */
  const replayThreadStart = async () => {
    await service.routeInbound(inbound({ text: ROOT, userId: INFO, ts: ROOT_TS, room: asleepRoom, source: 'cloud' }));
    await service.routeInbound(inbound({ text: STEVE_1, userId: STEVE, ts: STEVE_1_TS, threadTs: ROOT_TS, room: asleepRoom, source: 'cloud' }));
    clearMocks();
  };

  it('the incident: Steve\'s un-@\'d second message (35 s after "@Info …") reaches no agent', async () => {
    ownerUserId = STEVE; // the owner of steamfun-ops' Crewly is not the person in the thread
    await replayThreadStart();

    const result = await service.routeInbound(
      inbound({ text: STEVE_2, userId: STEVE, ts: STEVE_2_TS, threadTs: ROOT_TS, room: asleepRoom, source: 'cloud' }),
    );

    expectContextOnly(result, STEVE_2_TS);
    expect(result!.message.threadId).toBeDefined();
    expect(result!.message.metadata).toMatchObject({
      slackMentionedPeople: [INFO],
      slackAddresseeInherited: 'same-sender-followup',
    });
    expect(infoOf()).toHaveBeenCalledWith(
      'Slack team message continues a person-to-person exchange — recorded, not dispatched',
      expect.objectContaining({ addressedTo: [INFO], reason: 'same-sender-followup', threaded: true }),
    );
  });

  it('the incident\'s third message (a minute later, still no @) is context too', async () => {
    await replayThreadStart();
    await service.routeInbound(inbound({ text: STEVE_2, userId: STEVE, ts: STEVE_2_TS, threadTs: ROOT_TS, room: asleepRoom }));
    clearMocks();

    const result = await service.routeInbound(inbound({ text: STEVE_3, userId: STEVE, ts: STEVE_3_TS, threadTs: ROOT_TS, room: asleepRoom }));

    expectContextOnly(result, STEVE_3_TS);
    expect(result!.message.metadata).toMatchObject({ slackMentionedPeople: [INFO] });
  });

  it('a person-to-person thread: the other person\'s un-@\'d answer 20 min later is context only', async () => {
    await replayThreadStart();

    const result = await service.routeInbound(
      inbound({ text: '好的 那我晚点自己授权一下', userId: INFO, ts: later(STEVE_1_TS, 20 * 60), threadTs: ROOT_TS, room: asleepRoom }),
    );

    expectContextOnly(result, later(STEVE_1_TS, 20 * 60));
    expect(result!.message.metadata).toMatchObject({ slackMentionedPeople: [INFO], slackAddresseeInherited: 'person-exchange' });
  });

  it('30 min after the last human-to-human @ the exchange is over: an un-@\'d message is routed normally', async () => {
    await replayThreadStart();
    // An inherited follow-up in between does not extend it: the clock runs from the explicit @.
    await service.routeInbound(inbound({ text: STEVE_2, userId: STEVE, ts: STEVE_2_TS, threadTs: ROOT_TS, room: asleepRoom }));
    clearMocks();

    const result = await service.routeInbound(
      inbound({ text: '团队现在能帮我整理一下授权步骤吗', userId: INFO, ts: later(STEVE_1_TS, 31 * 60), threadTs: ROOT_TS, room: asleepRoom }),
    );

    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
    expect(result!.message.metadata).not.toHaveProperty('slackAddresseeInherited');
    // The exchange is over, so the prompt says nothing about it either.
    const options = dispatcher!.dispatchMessage.mock.calls[0][2] as { peopleAddressing?: { kind: string } };
    expect(options.peopleAddressing).toBeUndefined();
  });

  it('the person-exchange window comes from CREWLY_SLACK_PERSON_EXCHANGE_WINDOW_MS when set', async () => {
    process.env.CREWLY_SLACK_PERSON_EXCHANGE_WINDOW_MS = String(10 * 60 * 1000);
    await replayThreadStart();

    await service.routeInbound(inbound({ text: '好的', userId: INFO, ts: later(STEVE_1_TS, 15 * 60), threadTs: ROOT_TS }));

    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
  });

  describe('an agent named at the start of the message, without an @', () => {
    it.each([
      ['Sam，帮我看看怎么一次性授权'],
      ['Sam, can you set it up once?'],
      ['sam: 一次性授权怎么弄'],
      ['@Sam 帮我看看'],
      ['  Sam帮我看看'],
      ['Sam 帮我看看'],
      ['@Sam can you set it up once?'],
    ])('"%s" in a person-to-person thread reaches Sam (required)', async (text) => {
      await replayThreadStart();
      dispatcher!.planHuddleTargets!.mockResolvedValue(new Map([['crewly-alpha-sam', 'required']]));

      const result = await service.routeInbound(inbound({ text, userId: STEVE, ts: STEVE_2_TS, threadTs: ROOT_TS, room: asleepRoom }));

      expect(result!.mentions).toEqual(['crewly-alpha-sam']);
      expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
      expect(result!.message.metadata).not.toHaveProperty('slackAddresseeInherited');
    });

    it('a top-level message that opens with an agent\'s name addresses it', async () => {
      const result = await service.routeInbound(inbound({ text: 'Leo, 回归测试跑完了吗', userId: 'UOWNER', ts: '700.1' }));
      expect(result!.mentions).toEqual(['crewly-alpha-leo']);
    });

    it.each([
      ['a name mid-sentence', '我昨天问过Sam这个问题'],
      ['a longer word that starts with the name', 'Samuel 说他会授权'],
      ['a possessive', "Sam's 那条消息我看了"],
      ['the name, a space and a Latin word ("Tidy up the docs")', 'Sam up the docs first'],
      ['"Aria can you" style, without punctuation', 'Sam can you set it up'],
    ])('%s does not count — the incident thread stays person-to-person', async (_label, text) => {
      await replayThreadStart();

      const result = await service.routeInbound(inbound({ text, userId: STEVE, ts: STEVE_2_TS, threadTs: ROOT_TS, room: asleepRoom }));

      expectContextOnly(result, STEVE_2_TS);
    });

    it('an agent of the room on another machine, named first, is that machine\'s to answer', async () => {
      const room = {
        members: [
          ...asleepRoom.members,
          { agentSession: 'think-tank-atlas', displayName: 'Atlas', instanceId: 'i-2', deviceName: 'mac', awake: true },
        ],
      };
      await replayThreadStart();

      const result = await service.routeInbound(inbound({ text: 'Atlas，你来看看', userId: STEVE, ts: STEVE_2_TS, threadTs: ROOT_TS, room }));

      expect(result!.dispatch).toBeNull();
      expect(dispatcher!.dispatchMessage).not.toHaveBeenCalled();
      expect(result!.message.metadata).toMatchObject({ slackMentionedAgents: ['think-tank-atlas'] });
      expect(infoOf()).toHaveBeenCalledWith(
        'Slack team message addressed to an agent on another machine — recorded, not dispatched',
        expect.objectContaining({ mentionedElsewhere: ['think-tank-atlas'] }),
      );
    });
  });

  it('an agent that already spoke in the thread does not make a person-to-person follow-up its own', async () => {
    // Info @'d Sam, Sam answered; then Steve and Info talk to each other.
    await service.routeInbound(inbound({ text: '<@USAM> 帮我查一下日历授权', userId: INFO, ts: ROOT_TS }));
    const root = chat.messages[chat.messages.length - 1];
    chat.recordTurn({ channelId: root.channelId, senderType: 'agent', senderId: 'crewly-alpha-sam', content: '需要你授权一下', threadId: root.id, metadata: {} });
    await service.routeInbound(inbound({ text: STEVE_1, userId: STEVE, ts: STEVE_1_TS, threadTs: ROOT_TS }));
    clearMocks();
    // What the dispatcher would do for a bare follow-up: Sam spoke last.
    dispatcher!.planHuddleTargets!.mockResolvedValue(new Map([['crewly-alpha-sam', 'required']]));

    const result = await service.routeInbound(inbound({ text: STEVE_2, userId: STEVE, ts: STEVE_2_TS, threadTs: ROOT_TS }));

    expectContextOnly(result, STEVE_2_TS);
  });

  describe.each([
    ['the instance owner', 'UOWNER', INFO],
    ['another person in the workspace', STEVE, INFO],
    ['a person from another Crewly account', 'UOTHERACCT', STEVE],
  ])('sender: %s', (_label, sender, person) => {
    it.each([
      ['a colleague', () => person],
      ['the instance owner', () => 'UOWNER'],
    ])('@ of %s, then an un-@\'d follow-up: neither reaches an agent', async (_m, mentioned) => {
      const target = mentioned() === sender ? person : mentioned();
      await service.routeInbound(inbound({ text: '<@USAM> 看下这个', userId: 'UOWNER', ts: ROOT_TS }));
      clearMocks();

      const first = await service.routeInbound(
        inbound({ text: `<@${target}> 你那边能处理吗`, userId: sender, ts: STEVE_1_TS, threadTs: ROOT_TS, room: asleepRoom, source: 'cloud' }),
      );
      expectContextOnly(first, STEVE_1_TS);
      expect(first!.message.metadata).toMatchObject({ slackMentionedPeople: [target] });

      const second = await service.routeInbound(
        inbound({ text: '我只联通了Google drive', userId: sender, ts: STEVE_2_TS, threadTs: ROOT_TS, room: asleepRoom, source: 'cloud' }),
      );
      expectContextOnly(second, STEVE_2_TS);
      expect(second!.message.metadata).toMatchObject({ slackMentionedPeople: [target], slackAddresseeInherited: 'same-sender-followup' });
    });
  });

  it('with agents awake in the room (every awake agent decides): still nobody hears the follow-up', async () => {
    awake = () => true;
    const awakeRoom = { members: asleepRoom.members.map((m) => ({ ...m, awake: true })) };
    await replayThreadStart();

    const result = await service.routeInbound(inbound({ text: STEVE_2, userId: STEVE, ts: STEVE_2_TS, threadTs: ROOT_TS, room: awakeRoom, source: 'cloud' }));

    expectContextOnly(result, STEVE_2_TS);
  });

  it('once an agent is @\'d in the thread, a bare follow-up is routed normally — and the prompt names the earlier exchange', async () => {
    await replayThreadStart();
    await service.routeInbound(inbound({ text: '<@USAM> 你帮我看看怎么一次性授权', userId: STEVE, ts: STEVE_2_TS, threadTs: ROOT_TS }));
    clearMocks();

    const result = await service.routeInbound(inbound({ text: '先查gmail', userId: STEVE, ts: STEVE_3_TS, threadTs: ROOT_TS }));

    expect(result!.dispatch).not.toBeNull();
    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
    expect(result!.message.metadata).not.toHaveProperty('slackMentionedPeople');
    const options = dispatcher!.dispatchMessage.mock.calls[0][2] as { peopleAddressing?: { kind: string; people: string[] } };
    expect(options.peopleAddressing).toEqual({ kind: 'recent-exchange', people: [`<@${INFO}>`] });
  });

  it('an agent on another machine @\'d in the thread also ends the person-to-person exchange', async () => {
    await replayThreadStart();
    await service.routeInbound(
      inbound({ text: '<@UATLAS> 你来看看', userId: STEVE, ts: STEVE_2_TS, threadTs: ROOT_TS, mentionedAgentSessions: ['think-tank-atlas'] }),
    );
    clearMocks();

    await service.routeInbound(inbound({ text: '先查gmail', userId: STEVE, ts: STEVE_3_TS, threadTs: ROOT_TS }));

    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('@here in a person-to-person thread is a message to the room, routed normally', async () => {
    await replayThreadStart();
    const result = await service.routeInbound(inbound({ text: '<!here> 谁能帮忙授权', userId: STEVE, ts: STEVE_2_TS, threadTs: ROOT_TS }));
    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
    expect(result!.message.metadata).not.toHaveProperty('slackAddresseeInherited');
  });

  it('a typed @name that matches nobody is its own addressee: suggestion hint, routed normally', async () => {
    await replayThreadStart();
    await service.routeInbound(inbound({ text: '@lee 帮忙看下', userId: STEVE, ts: STEVE_2_TS, threadTs: ROOT_TS }));
    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
  });

  describe('top level (no thread)', () => {
    it('the same person\'s un-@\'d follow-up within the window inherits the addressee', async () => {
      await service.routeInbound(inbound({ text: ROOT, userId: INFO, ts: ROOT_TS }));
      clearMocks();

      const result = await service.routeInbound(inbound({ text: '每次都要点好几次', userId: INFO, ts: later(ROOT_TS, 30) }));

      expectContextOnly(result, later(ROOT_TS, 30));
      expect(result!.message.metadata).toMatchObject({ slackMentionedPeople: [STEVE], slackAddresseeInherited: 'same-sender-followup' });
    });

    it('after the window it is a new message to the room', async () => {
      await service.routeInbound(inbound({ text: ROOT, userId: INFO, ts: ROOT_TS }));
      clearMocks();

      await service.routeInbound(inbound({ text: '团队今天在做什么', userId: INFO, ts: later(ROOT_TS, 6 * 60) }));

      expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
    });

    it('the window comes from CREWLY_SLACK_PEOPLE_FOLLOWUP_WINDOW_MS when set', async () => {
      process.env.CREWLY_SLACK_PEOPLE_FOLLOWUP_WINDOW_MS = String(10 * 1000);
      await service.routeInbound(inbound({ text: ROOT, userId: INFO, ts: ROOT_TS }));
      clearMocks();

      await service.routeInbound(inbound({ text: '每次都要点好几次', userId: INFO, ts: later(ROOT_TS, 30) }));

      expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
    });

    it('a different person\'s un-@\'d post within the window is routed, with the exchange named in the prompt options', async () => {
      setSlackDirectoryService({
        list: async () => [
          { name: 'Steve Huang', mention: `<@${STEVE}>`, botUserId: null, agentSession: null, team: null, machine: null, source: 'channel', inChannel: true, kind: 'human' },
        ],
        rosterLine: async () => '',
      } as unknown as SlackDirectoryService);
      await service.routeInbound(inbound({ text: ROOT, userId: INFO, ts: ROOT_TS }));
      clearMocks();

      await service.routeInbound(inbound({ text: '可以的', userId: STEVE, ts: later(ROOT_TS, 60) }));

      expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
      const options = dispatcher!.dispatchMessage.mock.calls[0][2] as { peopleAddressing?: unknown };
      expect(options.peopleAddressing).toEqual({ kind: 'recent-exchange', people: [`Steve Huang (<@${STEVE}>)`] });
    });
  });

  describe('a request after (or inside) a person-to-person exchange (2026-10-02 02:36Z, #personal-assistant-team)', () => {
    // Info @'d Steve top-level at 01:19Z; Steve answered in the thread at
    // 01:46Z with no @; at 02:36Z Info asked for a call to be set up, no @.
    // Aria was woken and given a placeholder, and her prompt told her to stay
    // silent, so the owner saw "still working" and nothing else.
    const AT_0119 = '1790903940.000100';
    const AT_0146 = '1790905560.000200';
    const AT_0148 = '1790905680.000300';
    const AT_0236 = '1790908560.000400';
    const INFO_ROOT = `<@${STEVE}> 为什么我没有做任何的操作，也没有授权，现在calendar上已经显示了对应的任务呢。`;
    const STEVE_REPLY = '哪个账号的？';
    const REQUEST = '帮我设置一下下周12点到12点半，和安娜的爸爸在线讨论周五小组大赛的题目';
    type Options = { peopleAddressing?: { kind: string; people: string[] } };

    const replayIncident = async () => {
      await service.routeInbound(inbound({ text: INFO_ROOT, userId: INFO, ts: AT_0119, room: asleepRoom, source: 'cloud' }));
      const reply = await service.routeInbound(
        inbound({ text: STEVE_REPLY, userId: STEVE, ts: AT_0146, threadTs: AT_0119, room: asleepRoom, source: 'cloud' }),
      );
      // Steve's answer, 27 min after the @, is still part of the exchange.
      expect(reply!.dispatch).toBeNull();
      expect(reply!.message.metadata).toMatchObject({ slackMentionedPeople: [STEVE], slackAddresseeInherited: 'person-exchange' });
      clearMocks();
    };

    it('the 02:36Z request, 77 min after the last human-to-human @, gets no silence line and is expected to be answered', async () => {
      ownerUserId = INFO;
      await replayIncident();

      const result = await service.routeInbound(
        inbound({ text: REQUEST, userId: INFO, ts: AT_0236, threadTs: AT_0119, room: asleepRoom, source: 'cloud' }),
      );

      expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
      expect(result!.message.metadata).not.toHaveProperty('slackAddresseeInherited');
      const options = dispatcher!.dispatchMessage.mock.calls[0][2] as Options;
      expect(options.peopleAddressing).toBeUndefined();
      // The woken lead holds a placeholder and the harness watches for an answer.
      expect(typing!.begin).toHaveBeenCalledWith(expect.objectContaining({ agentSession: 'crewly-alpha-sam' }), expect.anything(), 'waking', AT_0236);
      expect(autoWorking!.watch).toHaveBeenCalledTimes(1);
    });

    it('the same request posted at the top level is routed normally too', async () => {
      await replayIncident();

      await service.routeInbound(inbound({ text: REQUEST, userId: INFO, ts: AT_0236, room: asleepRoom, source: 'cloud' }));

      expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
      expect((dispatcher!.dispatchMessage.mock.calls[0][2] as Options).peopleAddressing).toBeUndefined();
      expect(typing!.begin).toHaveBeenCalledTimes(1);
    });

    it('inside the window, a request worded to an assistant is not a continuation: routed, with a neutral note', async () => {
      await replayIncident();

      const result = await service.routeInbound(
        inbound({ text: REQUEST, userId: INFO, ts: AT_0148, threadTs: AT_0119, room: asleepRoom, source: 'cloud' }),
      );

      expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
      expect(result!.message.metadata).not.toHaveProperty('slackAddresseeInherited');
      const options = dispatcher!.dispatchMessage.mock.calls[0][2] as Options;
      expect(options.peopleAddressing).toEqual({ kind: 'recent-exchange-request', people: [`<@${STEVE}>`] });
      expect(typing!.begin).toHaveBeenCalledTimes(1);
    });

    it('inside the window, in an assistant room, a request carries no addressing line at all', async () => {
      storage.teams[0] = { ...storage.teams[0], name: 'Personal Assistant Team' };
      await replayIncident();

      await service.routeInbound(inbound({ text: REQUEST, userId: INFO, ts: AT_0148, threadTs: AT_0119, room: asleepRoom, source: 'cloud' }));

      expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
      expect((dispatcher!.dispatchMessage.mock.calls[0][2] as Options).peopleAddressing).toBeUndefined();
    });

    it('inside the window, a request from the person the exchange addressed is still a continuation', async () => {
      await replayIncident();

      const result = await service.routeInbound(
        inbound({ text: '请把账号发我一下', userId: STEVE, ts: AT_0148, threadTs: AT_0119, room: asleepRoom, source: 'cloud' }),
      );

      expectContextOnly(result, AT_0148);
    });

    it('a real continuation inside the window keeps the backstop, and gets no placeholder or auto-working watch', async () => {
      ownerUserId = STEVE;
      await service.routeInbound(inbound({ text: INFO_ROOT, userId: INFO, ts: AT_0119, room: asleepRoom, source: 'cloud' }));
      clearMocks();

      // A different person's top-level post a minute later: routed, but it
      // may well continue the exchange.
      await service.routeInbound(inbound({ text: STEVE_REPLY, userId: STEVE, ts: later(AT_0119, 60), room: asleepRoom, source: 'cloud' }));

      expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(1);
      expect((dispatcher!.dispatchMessage.mock.calls[0][2] as Options).peopleAddressing).toEqual({ kind: 'recent-exchange', people: [`<@${STEVE}>`] });
      // The woken lead is told to stay silent by default: nothing promises a reply.
      expect(typing!.begin).not.toHaveBeenCalled();
      expect(autoWorking!.watch).not.toHaveBeenCalled();
    });

    it('a continuation the lead must answer (required) keeps its placeholder', async () => {
      dispatcher!.planHuddleTargets!.mockResolvedValue(new Map([['crewly-alpha-sam', 'required']]));
      await service.routeInbound(inbound({ text: INFO_ROOT, userId: INFO, ts: AT_0119, room: asleepRoom, source: 'cloud' }));
      clearMocks();

      await service.routeInbound(inbound({ text: STEVE_REPLY, userId: STEVE, ts: later(AT_0119, 60), room: asleepRoom, source: 'cloud' }));

      expect(typing!.begin).toHaveBeenCalledTimes(1);
    });
  });

  describe('isDirectRequest', () => {
    it.each([
      ['帮我设置一下下周12点到12点半，和安娜的爸爸在线讨论周五小组大赛的题目'],
      ['请把下周的会议发给我'],
      ['麻烦整理一下授权步骤'],
      ['下周能帮我约一下吗？我想帮我妈订票'],
      ['Can you set up a call with Anna\'s dad next week?'],
      ['please book 12:00-12:30 next Tuesday'],
      ['Schedule a call with Anna\'s dad'],
      ['  , remind me tomorrow'],
    ])('"%s" is a request', (text) => {
      expect(isDirectRequest(text)).toBe(true);
    });

    it.each([
      ['哪个账号的？'],
      ['因为这里主要是用来做steamfun的 所以我只联通了Google drive'],
      ['好的 那我晚点自己授权一下'],
      ['Tidy up the docs'],
      ['Sam up the docs first'],
      ['ok thanks'],
      [''],
    ])('"%s" is not', (text) => {
      expect(isDirectRequest(text)).toBe(false);
    });
  });

  it('isAssistantRoom reads the team name, template or Slack channel', () => {
    expect(isAssistantRoom({ name: 'Personal Assistant Team' }, undefined)).toBe(true);
    expect(isAssistantRoom(null, 'personal-assistant-team')).toBe(true);
    expect(isAssistantRoom({ name: '客服组' }, undefined)).toBe(true);
    expect(isAssistantRoom({ name: 'Alpha Team' }, 'alpha-team')).toBe(false);
  });

  it('a person and an agent @\'d together: the agent\'s prompt options name the person', async () => {
    await service.routeInbound(inbound({ text: `<@${INFO}> <@ULEO> 你们核对一下`, userId: STEVE, ts: ROOT_TS }));
    const options = dispatcher!.dispatchMessage.mock.calls[0][2] as { peopleAddressing?: unknown };
    expect(options.peopleAddressing).toEqual({ kind: 'named-in-message', people: [`<@${INFO}>`] });
  });
});

describe('one responder per owner message (specs/2026-10-03-one-responder-per-message.md)', () => {
  // 2026-10-03, #content-team: Atlas posted a reminder about D-92 in a
  // thread; the owner answered there without an @. The reply resolved D-92
  // (delivered to Atlas) AND went to the room as huddle-broadcast; Atlas
  // answered at 16:41:28, Ella said the same ~6 minutes later.
  const ATLAS = 'crewly-alpha-atlas';
  const ELLA = 'crewly-alpha-ella';
  let prompts: Array<{ session: string; text: string }>;
  let decisionPath: Array<{ session: string; text: string }>;
  let real: ChatV2DispatcherService;

  let sinkResult: { success: boolean; queued?: boolean } = { success: true };
  function buildService(
    decisionReplyFor?: (m: SlackIncomingMessage) => Promise<{ asker: string; consumed: boolean } | null>,
    extra: Partial<ConstructorParameters<typeof SlackTeamChannelService>[0]> = {},
  ) {
    real = new ChatV2DispatcherService({
      agentSink: {
        sendMessageToAgent: async (session, text) => {
          prompts.push({ session, text });
          return sinkResult;
        },
      },
      huddleMembersFor: (id) => [...(chat.members.get(id) ?? [])],
      threadParticipantsFor: (id, root) => [
        ...new Set(chat.messages.filter((m) => m.channelId === id && (m.id === root || m.threadId === root) && m.senderType === 'agent').map((m) => m.senderId)),
      ],
      lastThreadSpeakerFor: (id, root) =>
        [...chat.messages].reverse().find((m) => m.channelId === id && (m.id === root || m.threadId === root) && m.senderType === 'agent')?.senderId ?? null,
      huddleLeaderFor: async () => ATLAS,
    });
    dispatcher = real as unknown as typeof dispatcher;
    return new SlackTeamChannelService({
      slack,
      chat: chat as unknown as TeamChannelChatApi,
      storage,
      getDispatcher: () => real,
      isAgentAwake: () => true,
      isLocalAgent: (s) => s.startsWith('crewly-alpha-'),
      getOwnerUserId: () => 'UOWNER',
      storePath: path.join(tmpDir, 'slack-team-channels-one.json'),
      ...(decisionReplyFor ? { decisionReplyFor } : {}),
      ...extra,
    });
  }

  /** The thread: the owner asked Ella, Ella answered, Atlas's card + reminder went up (Slack only). */
  async function setUpThread(svc: SlackTeamChannelService): Promise<string> {
    storage.teams = [team({ members: [member('Atlas', 'team-leader'), member('Ella', 'developer')], leaderIds: ['m-atlas'] })];
    await svc.ensureTeamChannel(storage.teams[0]);
    const root = await svc.routeInbound(inbound({ text: '@Ella 写两个版本的文案', userId: 'UOWNER', ts: '1001.0' }));
    chat.recordTurn({ channelId: root!.message.channelId, senderType: 'agent', senderId: ELLA, content: 'Draft A and draft B are up', threadId: root!.message.id, metadata: {} });
    prompts = [];
    return root!.message.channelId;
  }

  const slackThread = (): Promise<SlackThreadContext> =>
    Promise.resolve({
      kind: 'thread',
      channelId: 'C1',
      threadTs: '1001.0',
      totalBefore: 4,
      messages: [
        { ts: '1001.0', text: '@Ella 写两个版本的文案', isBot: false, authorName: 'Steve', userId: 'UOWNER' },
        { ts: '1002.0', text: 'Draft A and draft B are up', isBot: true, authorName: 'Ella', usernameOverride: true, userId: 'UMASTER' },
        { ts: '1003.0', text: 'Decision D-92: Keep both versions? (Yes / No)', isBot: true, authorName: 'Atlas', usernameOverride: true, userId: 'UMASTER' },
        { ts: '1004.0', text: '@Steve Still waiting on you: Keep both versions? — tap an answer on the card above, or reply here.', isBot: true, authorName: 'Atlas', usernameOverride: true, userId: 'UMASTER' },
      ],
    });

  const ownerReply = (extra: Partial<SlackIncomingMessage> = {}) =>
    inbound({ text: '我之前不是说了吗 两者应该都要有', userId: 'UOWNER', ts: '1005.0', threadTs: '1001.0', threadContext: slackThread(), ...extra });

  beforeEach(() => {
    prompts = [];
    decisionPath = [];
    sinkResult = { success: true };
  });
  const unansweredOf = (svc: SlackTeamChannelService) => (svc as unknown as { unanswered: Map<string, unknown> }).unanswered;
  /** Cloud's room: this team's two agents on the Mac (the room's home), Aria on the Air. */
  const sharedRoom = (o: { atlas?: boolean; ella?: boolean; aria?: boolean } = {}) => ({
    home: { instanceId: 'mac' },
    members: [
      { agentSession: ATLAS, displayName: 'Atlas', instanceId: 'mac', deviceName: 'macbookpro', awake: o.atlas ?? true },
      { agentSession: ELLA, displayName: 'Ella', instanceId: 'mac', deviceName: 'macbookpro', awake: o.ella ?? true },
      { agentSession: 'pa-aria', displayName: 'Aria', instanceId: 'air', deviceName: 'iriss-air', awake: o.aria ?? true },
    ],
  });
  /** Aria (on the Air) spoke last in the thread. */
  const ariaThread = (): Promise<SlackThreadContext> =>
    Promise.resolve({
      kind: 'thread',
      channelId: 'C1',
      threadTs: '1001.0',
      totalBefore: 2,
      messages: [
        { ts: '1001.0', text: '@Ella 写两个版本的文案', isBot: false, authorName: 'Steve', userId: 'UOWNER' },
        { ts: '1004.0', text: 'I pulled the calendar for it', isBot: true, authorName: 'Aria', userId: 'UARIA' },
      ],
    });

  it('the incident: a thread reply that resolves D-92 reaches exactly one responder (Atlas, via the decision path); Ella gets it as context only', async () => {
    // The decision listener and the router share one run (memo): it delivers to the asker once.
    let run: Promise<{ asker: string; consumed: boolean }> | null = null;
    const decisionReplyFor = (m: SlackIncomingMessage) => {
      run ??= (async () => {
        decisionPath.push({ session: ATLAS, text: `[DECISION D-92] The owner answered in words: "${m.text}"` });
        return { asker: ATLAS, consumed: true };
      })();
      return run;
    };
    service = buildService(decisionReplyFor);
    const roomId = await setUpThread(service);

    const result = await service.routeInbound(ownerReply());

    // Exactly one agent receives the owner's message: Atlas, from the decision path.
    const received = [...decisionPath.map((d) => d.session), ...prompts.map((p) => p.session)];
    expect(received).toEqual([ATLAS]);
    // Before this change Ella — the thread's last local speaker — was told it as `required`.
    expect(prompts).toEqual([]);
    expect(result!.dispatch?.contextOnly).toEqual([ELLA]);
    // The asker already has it; it is not also queued for it as context.
    expect(real.contextBacklog.peek(ATLAS, roomId).map((e) => e.messageId)).not.toContain(result!.message.id);
    expect(real.contextBacklog.peek(ELLA, roomId)).toEqual([
      expect.objectContaining({ messageId: result!.message.id, content: '我之前不是说了吗 两者应该都要有', responderName: 'Atlas' }),
    ]);
    // Nothing is armed for it: the decision path owns the answer.
    expect((service as unknown as { unanswered: Map<string, unknown> }).unanswered.size).toBe(0);
    // No eyes from Ella, no placeholder promising her reply.
    expect(slack.reactions.filter((r) => r.ts === '1005.0')).toHaveLength(1);

    // Ella hears it on her next turn in the room — as context, not a task.
    await service.routeInbound(inbound({ text: '@Ella 下周的排期呢', userId: 'UOWNER', ts: '1010.0' }));
    expect(prompts.map((p) => p.session)).toEqual([ELLA]);
    expect(prompts[0].text).toContain('[Context only — not for you to answer]');
    expect(prompts[0].text).toContain('Atlas is answering this; do not reply unless you are asked.');
    service.stop();
  });

  it('a card reply the decision path did not settle goes to the asker alone, as required', async () => {
    service = buildService(async () => ({ asker: ATLAS, consumed: false }));
    const roomId = await setUpThread(service);
    const result = await service.routeInbound(ownerReply());
    expect(prompts.map((p) => p.session)).toEqual([ATLAS]);
    expect(result!.dispatch?.huddleOutcomes).toEqual([{ sessionName: ATLAS, responseMode: 'required', dispatched: true }]);
    expect(real.contextBacklog.peek(ELLA, roomId)).toHaveLength(1);
    service.stop();
  });

  it('on a machine without the card, the Slack thread names the same owner (the card poster)', async () => {
    // No decision here (the card lives on the asker's machine): rule (c).
    service = buildService(async () => null);
    await setUpThread(service);
    await service.routeInbound(ownerReply());
    expect(prompts.map((p) => p.session)).toEqual([ATLAS]);
    service.stop();
  });

  it('after a restart (no decision memo, card already settled, Slack thread unreadable) the message still gets exactly one responder', async () => {
    // The memo and the context queue are in memory: a restart loses both.
    // The decision path now says "no open card", and Slack cannot be read.
    service = buildService(async () => null);
    await setUpThread(service);
    const result = await service.routeInbound(ownerReply({ threadContext: Promise.resolve(null) }));
    // The local thread's last speaker answers: one responder, never nobody.
    expect(prompts.map((p) => p.session)).toEqual([ELLA]);
    expect(result!.dispatch?.huddleOutcomes).toEqual([{ sessionName: ELLA, responseMode: 'required', dispatched: true }]);
    expect(result!.dispatch?.contextOnly).toEqual([ATLAS]);
    service.stop();
  });

  it('a decision lookup that throws still yields one responder (the Slack thread owner), not the old fan-out', async () => {
    service = buildService(async () => {
      throw new Error('decision store unreadable');
    });
    await setUpThread(service);
    const result = await service.routeInbound(ownerReply());
    expect(prompts.map((p) => p.session)).toEqual([ATLAS]);
    expect(result!.dispatch?.contextOnly).toEqual([ELLA]);
    service.stop();
  });

  it('a thread owned by an agent on another machine: nobody here is told, and no 90 s watch on a machine that is not the room owner', async () => {
    service = buildService(async () => null, { resolveInstanceId: async () => 'mac' });
    const roomId = await setUpThread(service);
    const ctx: SlackThreadContext = {
      kind: 'thread',
      channelId: 'C1',
      threadTs: '1001.0',
      totalBefore: 1,
      messages: [{ ts: '1001.0', text: 'Your calendar for today', isBot: true, authorName: 'Aria', userId: 'UARIA' }],
    };
    const room = { members: [{ agentSession: 'pa-aria', displayName: 'Aria', instanceId: 'air', deviceName: 'iriss-air', awake: true }] };
    const result = await service.routeInbound(ownerReply({ threadContext: Promise.resolve(ctx), room }));
    expect(prompts).toEqual([]);
    expect(result!.dispatch?.contextOnly).toEqual([ATLAS, ELLA]);
    expect(real.contextBacklog.peek(ELLA, roomId)[0].responderName).toBe('Aria');
    expect((service as unknown as { unanswered: Map<string, unknown> }).unanswered.size).toBe(0);
    service.stop();
  });

  it('an explicit @ in the card thread wins; the asker still has the decision', async () => {
    service = buildService(async () => ({ asker: ATLAS, consumed: true }));
    const roomId = await setUpThread(service);
    const result = await service.routeInbound(ownerReply({ text: '@Ella 两者应该都要有，你来改' }));
    expect(prompts.map((p) => p.session)).toEqual([ELLA]);
    expect(real.contextBacklog.peek(ATLAS, roomId).map((e) => e.messageId)).not.toContain(result!.message.id);
    service.stop();
  });

  it('top level, nobody @\'d: one awake agent answers (the leader), the other listens; the 90 s fallback is armed', async () => {
    service = buildService();
    const roomId = await setUpThread(service);
    const result = await service.routeInbound(inbound({ text: '今天谁有空？', userId: 'UOWNER', ts: '1020.0' }));
    expect(prompts.map((p) => p.session)).toEqual([ATLAS]);
    expect(result!.dispatch?.huddleOutcomes?.[0].responseMode).toBe('optional');
    expect(real.contextBacklog.peek(ELLA, roomId)).toHaveLength(1);
    expect((service as unknown as { unanswered: Map<string, unknown> }).unanswered.size).toBe(1);
    service.stop();
  });

  describe('never an owner message without a responder or a watcher (review blockers 1 and 3)', () => {
    it('a remote thread owner Cloud does not show awake is not pinned: the room owner machine answers by its own rules', async () => {
      service = buildService(async () => null, { resolveInstanceId: async () => 'mac' });
      await setUpThread(service);
      await service.routeInbound(ownerReply({ threadContext: ariaThread(), room: sharedRoom({ aria: false }) }));
      // Ella spoke last here: she answers, as required.
      expect(prompts.map((p) => p.session)).toEqual([ELLA]);
      service.stop();
    });

    it('…and a machine that is not the room owner defers to it (nobody here, no watch here)', async () => {
      service = buildService(async () => null, { resolveInstanceId: async () => 'air' });
      await setUpThread(service);
      const result = await service.routeInbound(ownerReply({ threadContext: ariaThread(), room: sharedRoom({ aria: false }) }));
      expect(prompts).toEqual([]);
      expect(result!.dispatch?.contextOnly).toEqual([ATLAS, ELLA]);
      expect(unansweredOf(service).size).toBe(0);
      service.stop();
    });

    it('a live remote thread owner answers; the room owner machine still watches for it', async () => {
      service = buildService(async () => null, { resolveInstanceId: async () => 'mac' });
      await setUpThread(service);
      const result = await service.routeInbound(ownerReply({ threadContext: ariaThread(), room: sharedRoom() }));
      expect(prompts).toEqual([]);
      expect(real.contextBacklog.peek(ELLA, result!.message.channelId).at(-1)?.responderName).toBe('Aria');
      expect(unansweredOf(service).size).toBe(1);
      // Recorded for the reply gate: Aria answers this one.
      expect(chat.messages.find((m) => m.id === result!.message.id)?.metadata?.roomResponders).toEqual(['pa-aria']);
      service.stop();
    });

    it('a decision asker that is not in this room, with the card still open, does not leave the message with nobody', async () => {
      service = buildService(async () => ({ asker: 'crewly-alpha-zed', consumed: false }));
      await setUpThread(service);
      await service.routeInbound(ownerReply());
      // Falls through to the Slack thread: the card's poster, Atlas.
      expect(prompts.map((p) => p.session)).toEqual([ATLAS]);
      service.stop();
    });

    // The local log's rows are stamped with FakeChat's sequence numbers; "now" sits just after them.
    const fresh = { now: () => new Date(50) };

    it('a thread the room owner cannot read: it answers from its log only when the log is fresh and its last speaker local', async () => {
      service = buildService(async () => null, { resolveInstanceId: async () => 'mac', ...fresh });
      await setUpThread(service);
      await service.routeInbound(ownerReply({ threadContext: Promise.resolve(null), room: sharedRoom() }));
      expect(prompts.map((p) => p.session)).toEqual([ELLA]);
      service.stop();
    });

    it('review blocker 2: the room owner cannot read the thread and its log is stale → nobody answers here, the 90 s watch does', async () => {
      service = buildService(async () => null, { resolveInstanceId: async () => 'mac', now: () => new Date(60 * 60 * 1000) });
      await setUpThread(service);
      const result = await service.routeInbound(ownerReply({ threadContext: Promise.resolve(null), room: sharedRoom() }));
      expect(prompts).toEqual([]);
      expect(result!.dispatch?.contextOnly).toEqual([ATLAS, ELLA]);
      expect(unansweredOf(service).size).toBe(1);
      service.stop();
    });

    it('review blocker 2: the room owner cannot read the thread and its log\'s latest agent speaker is remote → watch only', async () => {
      service = buildService(async () => null, { resolveInstanceId: async () => 'mac', ...fresh });
      const roomId = await setUpThread(service);
      const root = chat.messages.find((m) => m.channelId === roomId && !m.threadId)!;
      chat.recordTurn({ channelId: roomId, senderType: 'user', senderId: 'Aria (agent)', content: 'I took a look', threadId: root.id, metadata: { remoteAgentSession: 'pa-aria' } });
      await service.routeInbound(ownerReply({ threadContext: Promise.resolve(null), room: sharedRoom() }));
      expect(prompts).toEqual([]);
      expect(unansweredOf(service).size).toBe(1);
      service.stop();
    });

    it('review blocker 2: one retry of the read — when it works, the real last speaker answers (on any machine)', async () => {
      const readThreadContext = jest.fn(async () => (await ariaThread()) as SlackThreadContext | null);
      service = buildService(async () => null, { resolveInstanceId: async () => 'air', readThreadContext, storePath: path.join(tmpDir, 'slack-team-channels-retry.json') });
      await setUpThread(service);
      const result = await service.routeInbound(ownerReply({ threadContext: Promise.resolve(null), room: sharedRoom() }));
      expect(readThreadContext).toHaveBeenCalledTimes(1);
      // Aria (awake, on the Air) spoke last: nobody on this machine answers it.
      expect(prompts).toEqual([]);
      expect(result!.dispatch?.contextOnly).toEqual([ATLAS, ELLA]);
      service.stop();
    });

    it('a room whose members all run here trusts its own log when Slack cannot be read', async () => {
      service = buildService(async () => null, { resolveInstanceId: async () => 'mac', now: () => new Date(60 * 60 * 1000) });
      await setUpThread(service);
      const onlyHere = { home: { instanceId: 'mac' }, members: sharedRoom().members.filter((m) => m.instanceId === 'mac') };
      await service.routeInbound(ownerReply({ threadContext: Promise.resolve(null), room: onlyHere }));
      expect(prompts.map((p) => p.session)).toEqual([ELLA]);
      service.stop();
    });

    it('a thread this machine cannot read: a machine that is not the room owner defers (no guess from its own log)', async () => {
      service = buildService(async () => null, { resolveInstanceId: async () => 'air' });
      await setUpThread(service);
      const result = await service.routeInbound(ownerReply({ threadContext: Promise.resolve(null), room: sharedRoom() }));
      expect(prompts).toEqual([]);
      expect(result!.dispatch?.contextOnly).toEqual([ATLAS, ELLA]);
      expect(unansweredOf(service).size).toBe(0);
      service.stop();
    });

    /** Aria (on the Air) asked D-93; its card is the latest post in the thread. */
    const ariaCard = (): Promise<SlackThreadContext> =>
      Promise.resolve({
        kind: 'thread',
        channelId: 'C1',
        threadTs: '1001.0',
        totalBefore: 2,
        messages: [
          { ts: '1001.0', text: '@Ella 写两个版本的文案', isBot: false, authorName: 'Steve', userId: 'UOWNER' },
          { ts: '1004.0', text: 'Decision D-93: Book the venue? (Yes / No)', isBot: true, authorName: 'Aria', userId: 'UARIA' },
        ],
      });

    it('review blocker 1: a card whose asker is awake on another machine — no watch here (its decision path answers; no double answer at 90 s)', async () => {
      service = buildService(async () => null, { resolveInstanceId: async () => 'mac' });
      await setUpThread(service);
      const result = await service.routeInbound(ownerReply({ threadContext: ariaCard(), room: sharedRoom() }));
      expect(prompts).toEqual([]);
      expect(result!.dispatch?.contextOnly).toEqual([ATLAS, ELLA]);
      expect(unansweredOf(service).size).toBe(0);
      service.stop();
    });

    it('review blocker 1: …but when that asker is not awake, the room owner machine watches', async () => {
      service = buildService(async () => null, { resolveInstanceId: async () => 'mac' });
      await setUpThread(service);
      await service.routeInbound(ownerReply({ threadContext: ariaCard(), room: sharedRoom({ aria: false }) }));
      expect(prompts).toEqual([]);
      expect(unansweredOf(service).size).toBe(1);
      service.stop();
    });

    describe('nobody awake anywhere and no fallback machine named: one machine still watches a card for an offline asker', () => {
      const allAsleep = () => ({ members: sharedRoom({ atlas: false, ella: false, aria: false }).members });

      it('the lowest instance id watches', async () => {
        service = buildService(async () => null, { resolveInstanceId: async () => 'air' });
        await setUpThread(service);
        await service.routeInbound(ownerReply({ threadContext: ariaCard(), room: allAsleep() }));
        expect(prompts).toEqual([]);
        expect(unansweredOf(service).size).toBe(1);
        service.stop();
      });

      it('any other machine that received it keeps a note-only watch (the last-resort watcher may be gone)', async () => {
        service = buildService(async () => null, { resolveInstanceId: async () => 'mac' });
        await setUpThread(service);
        await service.routeInbound(ownerReply({ threadContext: ariaCard(), room: allAsleep() }));
        expect([...unansweredOf(service).values()]).toEqual([expect.objectContaining({ noteOnly: true })]);
        service.stop();
      });

      it('a machine that cannot resolve its own instance id watches — note-only', async () => {
        service = buildService(async () => null, { resolveInstanceId: async () => null });
        await setUpThread(service);
        await service.routeInbound(ownerReply({ threadContext: ariaCard(), room: allAsleep() }));
        expect([...unansweredOf(service).values()]).toEqual([expect.objectContaining({ noteOnly: true })]);
        service.stop();
      });
    });

    describe('a note-only watch never hands off (follow-up 1)', () => {
      const allAsleep = () => ({ members: sharedRoom({ atlas: false, ella: false, aria: false }).members });
      async function noteOnlyRun(after: Array<{ ts: string; text: string; isBot: boolean; authorName: string }>): Promise<{ notes: number; prompts: string[] }> {
        jest.useFakeTimers();
        try {
          service = buildService(async () => null, { resolveInstanceId: async () => null, slackRepliesAfter: async () => after });
          await setUpThread(service);
          slack.sent = [];
          await service.routeInbound(ownerReply({ threadContext: ariaCard(), room: allAsleep() }));
          await jest.advanceTimersByTimeAsync(91_000);
          // Not yet: a note-only watch waits ~120 s, and never hands over.
          expect(slack.sent).toEqual([]);
          await jest.advanceTimersByTimeAsync(30_000);
          return { notes: slack.sent.filter((m) => m.notAnAnswer).length, prompts: prompts.map((p) => p.session) };
        } finally {
          service.stop();
          jest.useRealTimers();
        }
      }

      it('nobody posted by ~120 s → it tells the owner, and hands nothing over', async () => {
        expect(await noteOnlyRun([])).toEqual({ notes: 1, prompts: [] });
      });

      it('a bot post appeared → it stays quiet', async () => {
        expect(await noteOnlyRun([{ ts: '1006.0', text: 'On it', isBot: true, authorName: 'Aria' }])).toEqual({ notes: 0, prompts: [] });
      });
    });

    it('roomWatcherInstance: the last resort picks among machines Cloud reports live, never one it marks not live', () => {
      const m = (instanceId: string, live?: boolean) => ({ agentSession: `a-${instanceId}`, displayName: 'A', instanceId, deviceName: instanceId, awake: false, ...(live === undefined ? {} : { live }) });
      expect(roomWatcherInstance({ members: [m('aa', false), m('bb', true), m('cc', true)] })).toBe('bb');
      expect(roomWatcherInstance({ members: [m('aa', false), m('bb'), m('cc')] })).toBe('bb');
      expect(roomWatcherInstance({ members: [m('aa'), m('bb')] })).toBe('aa');
      expect(roomWatcherInstance({ members: [m('aa'), m('bb')], fallback: { instanceId: 'bb', agentSession: 'x', kind: 'orchestrator' } })).toBe('bb');
    });

    it('required: the owner @\'d an agent on another machine after the last local answer → the log is not trusted (watch only, no stale answer here)', async () => {
      // Local Ella answered; the owner then asked remote Aria (recorded here,
      // not dispatched); Aria answered from her machine (never seen here);
      // the owner says "ok go ahead" and this machine cannot read Slack.
      service = buildService(async () => null, { resolveInstanceId: async () => 'mac', ...fresh });
      await setUpThread(service);
      await service.routeInbound(
        inbound({ text: '@Aria 你看看日历', userId: 'UOWNER', ts: '1004.0', threadTs: '1001.0', mentionedAgentSessions: ['pa-aria'], room: sharedRoom() }),
      );
      expect(prompts).toEqual([]);
      await service.routeInbound(ownerReply({ text: 'ok go ahead', ts: '1006.0', threadContext: Promise.resolve(null), room: sharedRoom() }));
      expect(prompts).toEqual([]);
      expect(unansweredOf(service).size).toBe(1);
      service.stop();
    });

    it('probe: Atlas starts, owner "looks off", Ella "I can dig into it", owner "yes please do" → Ella answers', async () => {
      service = buildService(async () => null);
      await setUpThread(service);
      const ctx: SlackThreadContext = {
        kind: 'thread',
        channelId: 'C1',
        threadTs: '1001.0',
        totalBefore: 3,
        messages: [
          { ts: '1001.0', text: 'Weekly numbers are up', isBot: true, authorName: 'Atlas', usernameOverride: true, userId: 'UMASTER' },
          { ts: '1002.0', text: 'looks off', isBot: false, authorName: 'Steve', userId: 'UOWNER' },
          { ts: '1003.0', text: 'I can dig into it', isBot: true, authorName: 'Ella', usernameOverride: true, userId: 'UMASTER' },
        ],
      };
      await service.routeInbound(ownerReply({ text: 'yes please do', threadContext: Promise.resolve(ctx) }));
      expect(prompts.map((p) => p.session)).toEqual([ELLA]);
      service.stop();
    });
  });

  describe('the 90 s hand-off waits for a slow responder (review item 6)', () => {
    async function topLevelThenWait(extra: Partial<ConstructorParameters<typeof SlackTeamChannelService>[0]>): Promise<string[]> {
      jest.useFakeTimers();
      try {
        service = buildService(undefined, extra);
        await setUpThread(service);
        // Top level, nobody @'d: Atlas (the leader) answers, optionally; Ella spoke last here, so she is the hand-off lead.
        await service.routeInbound(inbound({ text: '今天谁有空？', userId: 'UOWNER', ts: '1020.0' }));
        expect(prompts.map((p) => p.session)).toEqual([ATLAS]);
        await jest.advanceTimersByTimeAsync(91_000);
        return prompts.map((p) => p.session);
      } finally {
        service.stop();
        jest.useRealTimers();
      }
    }

    it('follow-up 3: the fallback cannot re-read Slack → it tells the owner instead of handing off blind', async () => {
      slack.sent = [];
      expect(await topLevelThenWait({ slackRepliesAfter: async () => null })).toEqual([ATLAS]);
      expect(slack.sent.filter((m) => m.notAnAnswer)).toHaveLength(1);
    });

    it('baseline: nobody answered in Slack → the lead gets it', async () => {
      expect(await topLevelThenWait({ slackRepliesAfter: async () => [] })).toEqual([ATLAS, ELLA]);
    });

    it('the responder holds it on its queue ([AGENT_BUSY]) → no hand-off', async () => {
      sinkResult = { success: true, queued: true };
      expect(await topLevelThenWait({ slackRepliesAfter: async () => [] })).toEqual([ATLAS]);
    });

    it('Slack shows a reply or "working on it" after the message (any machine) → no hand-off', async () => {
      const working = [{ ts: '1020.5', text: 'Atlas is working on it…', isBot: true, authorName: 'Atlas', userId: 'UATLAS' }];
      expect(await topLevelThenWait({ slackRepliesAfter: async () => working })).toEqual([ATLAS]);
    });
  });

  describe('reply gate', () => {
    it('holds a post in a thread a colleague already answered after the owner; the answerer may post again', async () => {
      service = buildService(async () => null);
      const roomId = await setUpThread(service);
      const reply = await service.routeInbound(ownerReply());
      const root = reply!.message.threadId!;
      expect(await service.heldReplyFor({ conversationId: roomId, thread: root, agentSession: ELLA })).toBeNull();
      chat.recordTurn({ channelId: roomId, senderType: 'agent', senderId: ATLAS, content: 'Got it — keeping both versions.', threadId: root, metadata: {} });
      const held = await service.heldReplyFor({ conversationId: roomId, thread: root, agentSession: ELLA });
      expect(held).toMatchObject({ by: 'Atlas', excerpt: 'Got it — keeping both versions.' });
      expect(await service.heldReplyFor({ conversationId: roomId, thread: root, agentSession: ATLAS })).toBeNull();
      expect(await service.heldReplyFor({ conversationId: 'not-a-room', thread: root, agentSession: ELLA })).toBeNull();
      service.stop();
    });
  });
});
