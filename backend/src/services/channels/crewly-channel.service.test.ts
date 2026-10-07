/**
 * Tests for CrewlyChannelService — the registry, Slack auto-discovery,
 * create/rename/members/archive in both modes (Slack connected or not).
 *
 * The Slack side is the real SlackTeamChannelService over in-memory fakes,
 * so "a Slack channel agents were invited to shows up as a Crewly channel"
 * is exercised end to end (inbound message → ad-hoc room → channel).
 *
 * @module services/channels/crewly-channel.service.test
 */

import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { CrewlyChannelService, CrewlyChannelError, agentsFromTeams, mentionsName, type CrewlyChannelChatApi } from './crewly-channel.service.js';
import { SlackTeamChannelService, type TeamChannelChatApi, type TeamChannelSlackApi } from '../slack/slack-team-channel.service.js';
import type { Team, TeamMember } from '../../types/index.js';
import type { ChatChannelDTO, ChatMessageDTO } from '../chat-v2/types.js';
import type { SlackAgentIdentityRecord, SlackIncomingMessage } from '../../types/slack.types.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
    }),
  },
}));

function member(name: string, team: string): TeamMember {
  return {
    id: `m-${name.toLowerCase()}`,
    name,
    sessionName: `${team}-${name.toLowerCase()}`,
    role: 'developer',
    systemPrompt: '',
    agentStatus: 'active',
    workingStatus: 'idle',
    runtimeType: 'claude-code',
    createdAt: '',
    updatedAt: '',
  } as TeamMember;
}

const TEAMS: Team[] = [
  { id: 't-research', name: 'Research', members: [member('Ella', 'research'), member('Iris', 'research')], projectIds: [], createdAt: '', updatedAt: '' } as Team,
  { id: 't-eng', name: 'Engineering', members: [member('Atlas', 'eng')], projectIds: [], createdAt: '', updatedAt: '' } as Team,
];

/** chat-v2 double with the huddle methods both services use. */
class FakeChat extends EventEmitter {
  channels = new Map<string, ChatChannelDTO>();
  members = new Map<string, string[]>();
  shared: ((id: string) => boolean) | null = null;
  private seq = 0;
  createHuddle(args: { name: string; purpose?: string; memberSessions: string[] }): ChatChannelDTO {
    const id = `huddle-${++this.seq}`;
    const dto = { id, agentSession: '', name: args.name, purpose: args.purpose, createdAt: this.seq, archivedAt: null, lastMessageAt: null, agentPresence: { status: 'online', lastSeenAt: null }, type: 'huddle' } as ChatChannelDTO;
    this.channels.set(id, dto);
    this.members.set(id, [...args.memberSessions]);
    return dto;
  }
  setHuddleMembers(id: string, sessions: string[]) {
    const cur = this.members.get(id) ?? [];
    this.members.set(id, [...sessions]);
    return { added: sessions.filter((s) => !cur.includes(s)), removed: cur.filter((s) => !sessions.includes(s)) };
  }
  queryHuddleMembersForDispatch(id: string) {
    return [...(this.members.get(id) ?? [])];
  }
  getChannelForBridge(id: string) {
    return this.channels.get(id) ?? null;
  }
  archiveChannelForBridge(id: string) {
    const ch = this.channels.get(id);
    if (!ch || ch.archivedAt) return false;
    ch.archivedAt = 1;
    return true;
  }
  renameChannelForBridge(id: string, name: string) {
    const ch = this.channels.get(id);
    if (!ch) return false;
    ch.name = name;
    return true;
  }
  setSharedChannelResolver(fn: ((id: string) => boolean) | null) {
    this.shared = fn;
  }
  recordTurn(input: { channelId: string; senderType: string; senderId: string; content: string; metadata: Record<string, unknown> }) {
    return { message: { id: `msg-${++this.seq}`, channelId: input.channelId, seq: this.seq, senderType: input.senderType, senderId: input.senderId, content: input.content, contentType: 'markdown', createdAt: this.seq, attachments: [], metadata: input.metadata, mentions: [] }, deduped: false };
  }
  findSlackThreadRoot() {
    return null;
  }
  findLatestSlackRoot() {
    return null;
  }
  getMessageForBridge() {
    return null;
  }
}

/** Slack double: records creates, invites, kicks, renames. */
function fakeSlack(): TeamChannelSlackApi & { connected: boolean; invites: string[][]; kicks: string[][]; renamed: string[][]; created: string[]; archived: string[]; names: Map<string, string> } {
  let n = 0;
  const names = new Map<string, string>();
  const self = {
    connected: true,
    invites: [] as string[][],
    kicks: [] as string[][],
    renamed: [] as string[][],
    created: [] as string[],
    archived: [] as string[],
    names,
    isConnected: () => self.connected,
    createChannel: async (name: string) => {
      self.created.push(name);
      const id = `CNEW${++n}`;
      names.set(id, name);
      return { id, name, isArchived: false, isPrivate: false };
    },
    renameChannel: async (id: string, name: string) => {
      self.renamed.push([id, name]);
      names.set(id, name);
      return name;
    },
    getChannelInfo: async (id: string) => (names.has(id) ? { id, name: names.get(id)!, isArchived: false, isPrivate: true } : null),
    joinChannel: async () => undefined,
    archiveChannel: async (id: string) => {
      self.archived.push(id);
    },
    setChannelPurpose: async () => undefined,
    sendMessage: async () => '1.0',
    addReaction: async () => undefined,
    inviteToChannel: async (id: string, users: string[]) => {
      self.invites.push([id, ...users]);
    },
    kickFromChannel: async (id: string, user: string) => {
      self.kicks.push([id, user]);
    },
    uploadFile: async () => ({}),
  };
  return self;
}

/** Identity double: Ella and Atlas have installed bots, Iris does not. */
function fakeIdentities() {
  const rec = (s: string, bot: string) =>
    ({ agentSession: s, displayName: s, appId: `A-${s}`, status: 'installed', botUserId: bot, botToken: `xoxb-${s}`, announcedIn: [], invitedTo: [], updatedAt: '' }) as SlackAgentIdentityRecord;
  const records = new Map<string, SlackAgentIdentityRecord>([
    ['research-ella', rec('research-ella', 'UELLA')],
    ['eng-atlas', rec('eng-atlas', 'UATLAS')],
  ]);
  return {
    isAvailable: () => true,
    load: async () => ({ version: 1 as const, identities: [...records.values()] }),
    provision: async () => {
      throw new Error('not used');
    },
    get: (s: string) => records.get(s) ?? null,
    getInstalled: (s: string) => {
      const r = records.get(s);
      return r?.botUserId && r.botToken ? { botUserId: r.botUserId, botToken: r.botToken } : null;
    },
    markChannel: async () => undefined,
    onInstalled: () => () => undefined,
  };
}

let tmp: string;
let chat: FakeChat;
let slack: ReturnType<typeof fakeSlack>;
let rooms: SlackTeamChannelService | null;
let service: CrewlyChannelService;

function makeRooms(): SlackTeamChannelService {
  return new SlackTeamChannelService({
    slack,
    chat: chat as unknown as TeamChannelChatApi,
    storage: { getTeams: async () => TEAMS, onStorageEvent: () => () => undefined },
    getDispatcher: () => ({ dispatchMessage: jest.fn().mockResolvedValue({ strategy: 'huddle-broadcast', dispatched: true }) }),
    identities: fakeIdentities(),
    isLocalAgent: () => true,
    getOwnerUserId: () => 'UOWNER',
    storePath: path.join(tmp, 'slack-team-channels.json'),
  });
}

let dispatcher: { dispatchMessage: jest.Mock } | null = null;

function makeService(): CrewlyChannelService {
  return new CrewlyChannelService({
    chat: chat as unknown as CrewlyChannelChatApi,
    getRooms: () => rooms,
    listAgents: async () => agentsFromTeams(TEAMS),
    getDispatcher: () => dispatcher,
    storePath: path.join(tmp, 'crewly-channels.json'),
    now: () => new Date('2026-10-07T00:00:00.000Z'),
  });
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-channels-'));
  chat = new FakeChat();
  slack = fakeSlack();
  rooms = makeRooms();
  service = makeService();
  await service.start();
});

afterEach(async () => {
  service.stop();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('agentsFromTeams', () => {
  it('lists every member once with its team and skips archived teams', () => {
    const agents = agentsFromTeams([...TEAMS, { ...TEAMS[1], id: 't-old', archived: true } as Team]);
    expect(agents.map((a) => `${a.sessionName}@${a.teamName}`)).toEqual(['research-ella@Research', 'research-iris@Research', 'eng-atlas@Engineering']);
  });
});

describe('CrewlyChannelService — Slack connected', () => {
  it('creates the Slack channel with the normalised name, invites the owner and each member bot, and persists the registry', async () => {
    const ch = await service.create({ name: 'Daily Tech Brief', purpose: "Ella's morning brief", memberSessions: ['research-ella', 'eng-atlas'] });
    expect(slack.created).toEqual(['daily-tech-brief']);
    expect(ch).toMatchObject({ name: 'daily-tech-brief', origin: 'crewly', slack: { channelId: 'CNEW1', channelName: 'daily-tech-brief' } });
    expect(ch.members.map((m) => `${m.name}/${m.teamName}`)).toEqual(['Ella/Research', 'Atlas/Engineering']);
    expect(slack.invites).toEqual([['CNEW1', 'UOWNER'], ['CNEW1', 'UELLA'], ['CNEW1', 'UATLAS']]);
    // The id is the huddle id — what step 2 (app ownership) references.
    expect(chat.channels.has(ch.id)).toBe(true);
    // The owner may open it in Crewly.
    expect(chat.shared?.(ch.id)).toBe(true);
    // Survives a restart.
    const again = makeService();
    await again.start();
    expect((await again.list()).map((c) => c.id)).toEqual([ch.id]);
  });

  it('refuses an empty name, no members, unknown agents and a duplicate name', async () => {
    await expect(service.create({ name: '  #  ', memberSessions: ['research-ella'] })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(service.create({ name: 'x', memberSessions: [] })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(service.create({ name: 'x', memberSessions: ['ghost'] })).rejects.toThrow(/Unknown agent: ghost/);
    await service.create({ name: 'brief', memberSessions: ['research-ella'] });
    await expect(service.create({ name: 'Brief', memberSessions: ['eng-atlas'] })).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('adding an agent invites its bot; removing one kicks it; an agent without a bot is reported, not invited', async () => {
    const ch = await service.create({ name: 'brief', memberSessions: ['research-ella'] });
    slack.invites = [];
    const add = await service.addMember(ch.id, 'eng-atlas');
    expect(slack.invites).toEqual([['CNEW1', 'UATLAS']]);
    expect(add.change).toMatchObject({ added: ['eng-atlas'], invited: ['eng-atlas'] });
    const addIris = await service.addMember('#brief', 'research-iris');
    expect(addIris.change.notInvited).toEqual(['research-iris']);
    const removed = await service.removeMember(ch.id, 'eng-atlas');
    expect(slack.kicks).toEqual([['CNEW1', 'UATLAS']]);
    expect(removed.change).toMatchObject({ removed: ['eng-atlas'], removedFromSlack: ['eng-atlas'] });
    expect(removed.channel.members.map((m) => m.sessionName)).toEqual(['research-ella', 'research-iris']);
    await expect(service.removeMember(ch.id, 'eng-atlas')).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('renaming renames the Slack channel and shows the name Slack applied (Crewly → Slack)', async () => {
    const ch = await service.create({ name: 'brief', memberSessions: ['research-ella'] });
    const renamed = await service.rename(ch.id, 'Morning Brief!');
    expect(slack.renamed).toEqual([['CNEW1', 'morning-brief']]);
    expect(renamed.name).toBe('morning-brief');
    expect(chat.channels.get(ch.id)?.name).toBe('#morning-brief');
  });

  it('a rename in Slack shows up in Crewly on the next refresh (Slack → Crewly)', async () => {
    const ch = await service.create({ name: 'brief', memberSessions: ['research-ella'] });
    slack.names.set('CNEW1', 'renamed-in-slack');
    const after = await service.refresh();
    expect(after.find((c) => c.id === ch.id)?.name).toBe('renamed-in-slack');
    expect(chat.channels.get(ch.id)?.name).toBe('#renamed-in-slack');
  });

  it('archiving a channel Crewly created archives the Slack channel and hides it from the list', async () => {
    const ch = await service.create({ name: 'brief', memberSessions: ['research-ella'] });
    const archived = await service.archive(ch.id);
    expect(archived.archivedAt).toBeDefined();
    expect(slack.archived).toEqual(['CNEW1']);
    expect(await service.list()).toEqual([]);
    expect((await service.list({ includeArchived: true })).map((c) => c.id)).toEqual([ch.id]);
    expect(chat.shared?.(ch.id)).toBe(false);
  });

  it('a Slack channel agent bots were invited into appears as a channel automatically (members = agents from any team)', async () => {
    const msg = (ts: string, via: string): SlackIncomingMessage =>
      ({ id: ts, type: 'message', text: 'morning', userId: 'UOWNER', channelId: 'CPRIV', ts, teamId: 'T1', eventTs: ts, receivedVia: via }) as SlackIncomingMessage;
    slack.names.set('CPRIV', 'tech-brief');
    await rooms!.routeInbound(msg('1.1', 'research-ella'));
    await rooms!.routeInbound(msg('1.2', 'eng-atlas'));
    const [found] = await service.list();
    expect(found).toMatchObject({ name: 'tech-brief', origin: 'slack', slack: { channelId: 'CPRIV' } });
    expect(found.members.map((m) => m.teamName)).toEqual(['Research', 'Engineering']);
    expect(chat.shared?.(found.id)).toBe(true);
    // Only that agent's channels with ?member=.
    expect(await service.list({ member: 'research-iris' })).toEqual([]);
    expect((await service.list({ member: 'eng-atlas' })).map((c) => c.id)).toEqual([found.id]);
    // Archiving one found in Slack leaves the humans' channel alone; the bots leave.
    await service.archive(found.id);
    expect(slack.archived).toEqual([]);
    expect(slack.kicks.map((k) => k[1]).sort()).toEqual(['UATLAS', 'UELLA']);
  });

  it('resolves by id, #name, name and Slack channel id', async () => {
    const ch = await service.create({ name: 'brief', memberSessions: ['research-ella'] });
    for (const ref of [ch.id, '#brief', 'BRIEF', 'CNEW1']) expect((await service.get(ref)).id).toBe(ch.id);
    await expect(service.get('#nope')).rejects.toBeInstanceOf(CrewlyChannelError);
  });

  it('reports Slack refusing to create the channel as 502', async () => {
    slack.createChannel = async () => {
      throw new Error('restricted_action');
    };
    await expect(service.create({ name: 'brief', memberSessions: ['research-ella'] })).rejects.toMatchObject({ httpStatus: 502 });
  });
});

describe('CrewlyChannelService — no Slack', () => {
  beforeEach(async () => {
    rooms = null;
    service = makeService();
    await service.start();
  });

  it('creates a Crewly-only channel; rename, members and archive act on the huddle', async () => {
    const ch = await service.create({ name: 'Brief', memberSessions: ['research-ella', 'eng-atlas'] });
    expect(ch).toMatchObject({ name: 'brief', slack: null, origin: 'crewly' });
    expect(chat.channels.get(ch.id)?.name).toBe('#brief');
    await service.rename(ch.id, 'tech brief');
    expect(chat.channels.get(ch.id)?.name).toBe('#tech-brief');
    const { change } = await service.removeMember(ch.id, 'eng-atlas');
    expect(change.removed).toEqual(['eng-atlas']);
    expect(chat.members.get(ch.id)).toEqual(['research-ella']);
    await service.archive(ch.id);
    expect(chat.channels.get(ch.id)?.archivedAt).toBeTruthy();
  });

  it('ignores a corrupt registry row', async () => {
    await fs.writeFile(path.join(tmp, 'crewly-channels.json'), JSON.stringify({ version: 1, channels: [{ id: 'x' }, { id: 'h', name: 'ok', origin: 'crewly', createdAt: 'now' }] }));
    const fresh = makeService();
    await fresh.start();
    expect((await fresh.list()).map((c) => c.name)).toEqual(['ok']);
  });
});

describe('CrewlyChannelService — Slack comes later', () => {
  it('links a channel made while Slack was off on the next sync, keeping its id and history', async () => {
    const saved = rooms;
    rooms = null;
    const ch = await service.create({ name: 'Later Room', memberSessions: ['research-ella', 'eng-atlas'] });
    expect(ch.slack).toBeNull();
    rooms = saved;
    slack.invites = [];
    const after = await service.refresh();
    const linked = after.find((c) => c.id === ch.id)!;
    expect(linked.slack).toEqual({ channelId: 'CNEW1', channelName: 'later-room' });
    expect(slack.created).toEqual(['later-room']);
    expect(slack.invites).toEqual([['CNEW1', 'UOWNER'], ['CNEW1', 'UELLA'], ['CNEW1', 'UATLAS']]);
    // Nothing more on the next sync.
    await service.refresh();
    expect(slack.created).toEqual(['later-room']);
  });

  it('does not link while Slack is disconnected', async () => {
    const saved = rooms;
    rooms = null;
    await service.create({ name: 'x', memberSessions: ['research-ella'] });
    rooms = saved;
    slack.connected = false;
    expect(await service.linkUnlinked()).toEqual([]);
    expect(slack.created).toEqual([]);
  });
});

describe('CrewlyChannelService — agent @-mentions in a channel without Slack', () => {
  const agentPost = (channelId: string, content: string, extra: Partial<ChatMessageDTO> = {}): ChatMessageDTO =>
    ({ id: `m-${Math.random()}`, channelId, seq: 1, senderType: 'agent', senderId: 'research-ella', content, contentType: 'markdown', createdAt: 1, attachments: [], mentions: [], ...extra }) as ChatMessageDTO;

  beforeEach(async () => {
    rooms = null;
    dispatcher = { dispatchMessage: jest.fn().mockResolvedValue({ dispatched: true }) };
    service = makeService();
    await service.start();
  });

  afterEach(() => {
    dispatcher = null;
  });

  it('wakes only the member the agent @-named, as a user turn written by that agent', async () => {
    const ch = await service.create({ name: 'room', memberSessions: ['research-ella', 'research-iris', 'eng-atlas'] });
    expect(await service.handleChatMessage(agentPost(ch.id, '@Atlas can you check the numbers?'))).toEqual(['eng-atlas']);
    const [channel, turn, opts] = dispatcher!.dispatchMessage.mock.calls[0];
    expect(channel.id).toBe(ch.id);
    expect(turn).toMatchObject({ senderType: 'user', senderId: 'research-ella', mentions: ['eng-atlas'], metadata: { authorAgentSession: 'research-ella' } });
    expect(opts.excludeSessions.sort()).toEqual(['research-ella', 'research-iris']);
  });

  it('wakes nobody for a post without an @, an @ of itself, or an @ of a non-member', async () => {
    const ch = await service.create({ name: 'room', memberSessions: ['research-ella', 'eng-atlas'] });
    await service.handleChatMessage(agentPost(ch.id, 'done for today'));
    await service.handleChatMessage(agentPost(ch.id, '@Ella note to self'));
    await service.handleChatMessage(agentPost(ch.id, '@Iris hi'));
    expect(dispatcher!.dispatchMessage).not.toHaveBeenCalled();
  });

  it('stops after 8 hand-offs in a row until the owner speaks again', async () => {
    const ch = await service.create({ name: 'room', memberSessions: ['research-ella', 'eng-atlas'] });
    for (let i = 0; i < 10; i++) await service.handleChatMessage(agentPost(ch.id, `@Atlas round ${i}`));
    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(8);
    await service.handleChatMessage({ ...agentPost(ch.id, 'keep going'), senderType: 'user', senderId: 'owner' });
    await service.handleChatMessage(agentPost(ch.id, '@Atlas again'));
    expect(dispatcher!.dispatchMessage).toHaveBeenCalledTimes(9);
  });

  it('leaves channels linked to Slack to the Slack path', async () => {
    rooms = makeRooms();
    const ch = await service.create({ name: 'linked', memberSessions: ['research-ella', 'eng-atlas'] });
    expect(await service.handleChatMessage(agentPost(ch.id, '@Atlas hi'))).toEqual([]);
    expect(dispatcher!.dispatchMessage).not.toHaveBeenCalled();
  });

  it('mentionsName matches whole names only', () => {
    expect(mentionsName('hey @atlas!', 'Atlas')).toBe(true);
    expect(mentionsName('hey @Atlassian', 'Atlas')).toBe(false);
    expect(mentionsName('mail a@Atlas', 'Atlas')).toBe(false);
  });
});
