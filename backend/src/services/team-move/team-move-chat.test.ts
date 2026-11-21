import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { openChatDatabase } from '../chat-v2/sqlite/chat-db.js';
import { applyTeamChat, readTeamChat, remapChatChannels, setChannelsArchived } from './team-move-chat.js';
import { identityOf } from './team-move-select.js';

describe('team-move-chat', () => {
  let a: string;
  let b: string;
  const id = identityOf({ id: 't1', name: 'CE', members: [{ id: 'm1', sessionName: 's1' }, { id: 'm2', sessionName: 's2' }] } as never);

  beforeEach(async () => {
    a = await fs.mkdtemp(path.join(os.tmpdir(), 'move-chat-a-'));
    b = await fs.mkdtemp(path.join(os.tmpdir(), 'move-chat-b-'));
    const db = openChatDatabase({ dbPath: path.join(a, 'chat.db'), skipIntegrityCheck: true });
    const ins = db.prepare('INSERT INTO chat_channels (id, agent_session, owner_user_id, name, created_at, type, team_id, archived_at) VALUES (?,?,?,?,?,?,?,?)');
    ins.run('c-team', '', 'o', 'team', 1, 'channel', 't1', null);
    ins.run('c-huddle', '', 'o', 'room', 1, 'huddle', null, null);
    ins.run('c-mixed', '', 'o', 'mixed', 1, 'huddle', null, null);
    ins.run('c-dm', 's1', 'o', 'dm', 1, 'dm', null, null);
    ins.run('c-dm-other', 'zz', 'o', 'dm2', 1, 'dm', null, null);
    ins.run('c-old', '', 'o', 'old', 1, 'channel', 't1', 5);
    const mem = db.prepare('INSERT INTO chat_channel_members (channel_id, member_session, joined_at) VALUES (?,?,?)');
    mem.run('c-huddle', 's1', 1);
    mem.run('c-huddle', 's2', 1);
    mem.run('c-mixed', 's1', 1);
    mem.run('c-mixed', 'outsider', 1);
    const msg = db.prepare('INSERT INTO chat_messages (id, channel_id, seq, sender_type, sender_id, content, created_at, thread_id) VALUES (?,?,?,?,?,?,?,?)');
    for (let i = 1; i <= 5; i++) msg.run(`m-${i}`, 'c-mixed', i, i % 2 ? 'user' : 'agent', i % 2 ? 'owner' : 's1', `room message ${i}`, i, i > 1 ? 'm-1' : null);
    msg.run('m-team', 'c-team', 1, 'user', 'owner', 'team message', 1, null);
    db.close();
  });
  afterEach(async () => {
    await fs.rm(a, { recursive: true, force: true });
    await fs.rm(b, { recursive: true, force: true });
  });

  it('selects the team channel, rooms of only team members and the members DMs, not archived or foreign ones', () => {
    const r = readTeamChat(a, id);
    expect(r.channels.map((c) => c['id']).sort()).toEqual(['c-dm', 'c-huddle', 'c-team']);
    expect(r.members.map((m) => `${m.channel_id}:${m.member_session}`).sort()).toEqual(['c-huddle:s1', 'c-huddle:s2']);
  });

  it('returns nothing for a machine without a chat store', () => {
    expect(readTeamChat(b, id)).toEqual({ channels: [], members: [] });
  });

  it('applies records once and reports what already existed', () => {
    const records = readTeamChat(a, id);
    expect(applyTeamChat(b, records)).toEqual({ channelsAdded: 3, channelsExisting: 0, membersAdded: 2 });
    expect(applyTeamChat(b, records)).toEqual({ channelsAdded: 0, channelsExisting: 3, membersAdded: 0 });
    expect(applyTeamChat(b, { channels: [], members: [] })).toEqual({ channelsAdded: 0, channelsExisting: 0, membersAdded: 0 });
  });

  // crewly#1344 (#air-steamfun): the Slack mapping pointed at a room the
  // orchestrator was in, so the roster rule left it out and the target had
  // no channel behind the mapping — 404 on its messages, no thread history.
  it('always carries the room behind the Slack mapping, with its newest messages, and writes them once on the target', () => {
    const r = readTeamChat(a, id, { includeChannelIds: ['c-mixed'], messages: { channelIds: ['c-mixed', 'c-team', 'c-nope'], perChannel: 3, totalBytes: 1_000_000 } });
    expect(r.channels.map((c) => c['id']).sort()).toEqual(['c-dm', 'c-huddle', 'c-mixed', 'c-team']);
    expect(r.members.map((m) => `${m.channel_id}:${m.member_session}`).sort()).toEqual(['c-huddle:s1', 'c-huddle:s2', 'c-mixed:outsider', 'c-mixed:s1']);
    // The newest three of the room, oldest first; the team channel's too; unknown channels ignored.
    expect(r.messages!.map((m) => m['id'])).toEqual(['m-3', 'm-4', 'm-5', 'm-team']);

    expect(applyTeamChat(b, r)).toEqual({ channelsAdded: 4, channelsExisting: 0, membersAdded: 4, messagesAdded: 4 });
    expect(applyTeamChat(b, r)).toEqual({ channelsAdded: 0, channelsExisting: 4, membersAdded: 0, messagesAdded: 0 });
    const db = openChatDatabase({ dbPath: path.join(b, 'chat.db'), skipIntegrityCheck: true });
    try {
      const rows = db.prepare('SELECT id, thread_id FROM chat_messages WHERE channel_id = ? ORDER BY seq').all('c-mixed') as Array<{ id: string; thread_id: string | null }>;
      expect(rows).toEqual([{ id: 'm-3', thread_id: 'm-1' }, { id: 'm-4', thread_id: 'm-1' }, { id: 'm-5', thread_id: 'm-1' }]);
    } finally {
      db.close();
    }
    // The byte cap keeps the newest.
    const small = readTeamChat(a, id, { includeChannelIds: ['c-mixed'], messages: { channelIds: ['c-mixed'], perChannel: 5, totalBytes: 600 } });
    expect(small.messages!.length).toBeGreaterThan(0);
    expect(small.messages!.length).toBeLessThan(5);
    expect(small.messages![small.messages!.length - 1]!['id']).toBe('m-5');
  });

  it('archives and unarchives channels', () => {
    expect(setChannelsArchived(a, ['c-team', 'c-dm'], true, 99)).toBe(2);
    expect(setChannelsArchived(a, ['c-team'], true, 99)).toBe(0);
    expect(readTeamChat(a, id).channels.map((c) => c['id'])).toEqual(['c-huddle']);
    expect(setChannelsArchived(a, ['c-team', 'c-dm'], false)).toBe(2);
    expect(readTeamChat(a, id).channels).toHaveLength(3);
    expect(setChannelsArchived(b, ['x'], true)).toBe(0);
    expect(setChannelsArchived(a, [], true)).toBe(0);
  });

  it('a channel listed in rosterOnlyChannelIds travels with only this team\'s agents as members', () => {
    const r = readTeamChat(a, id, { includeChannelIds: ['c-mixed'], rosterOnlyChannelIds: ['c-mixed'] });
    expect(r.channels.map((c) => c['id'])).toContain('c-mixed');
    expect(r.members.filter((m) => m.channel_id === 'c-mixed').map((m) => m.member_session)).toEqual(['s1']);
    // Without it the whole roster travels, as before (the team's own Slack room keeps its guests).
    const all = readTeamChat(a, id, { includeChannelIds: ['c-mixed'] });
    expect(all.members.filter((m) => m.channel_id === 'c-mixed').map((m) => m.member_session).sort()).toEqual(['outsider', 's1']);
  });

  it('remapChatChannels moves members and messages to the id the target uses and apply numbers them after its own', () => {
    const records = readTeamChat(a, id, { includeChannelIds: ['c-mixed'], rosterOnlyChannelIds: ['c-mixed'], messages: { channelIds: ['c-mixed'], perChannel: 50, totalBytes: 1_000_000 } });
    const remapped = remapChatChannels(records, new Map([['c-mixed', 'target-room']]));
    expect(remapped.channels.map((c) => c['id'])).not.toContain('c-mixed');
    expect(remapped.members.filter((m) => m.channel_id === 'target-room').map((m) => m.member_session)).toEqual(['s1']);
    expect(remapped.messages!.every((m) => m['channel_id'] === 'target-room' && m['seq'] === null)).toBe(true);

    const db = openChatDatabase({ dbPath: path.join(b, 'chat.db'), skipIntegrityCheck: true });
    db.prepare('INSERT INTO chat_channels (id, agent_session, owner_user_id, name, created_at, type, team_id) VALUES (?,?,?,?,?,?,?)').run('target-room', '', 'o', 'room', 1, 'huddle', null);
    db.prepare('INSERT INTO chat_messages (id, channel_id, seq, sender_type, sender_id, content, created_at) VALUES (?,?,?,?,?,?,?)').run('t-1', 'target-room', 1, 'user', 'owner', 'local', 1);
    db.close();
    const result = applyTeamChat(b, remapped);
    expect(result.messagesAdded).toBe(5);
    const check = openChatDatabase({ dbPath: path.join(b, 'chat.db'), skipIntegrityCheck: true });
    try {
      expect((check.prepare('SELECT seq FROM chat_messages WHERE channel_id = ? ORDER BY seq').all('target-room') as Array<{ seq: number }>).map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(check.prepare('SELECT 1 FROM chat_channels WHERE id = ?').get('c-mixed')).toBeUndefined();
    } finally {
      check.close();
    }
  });
});
