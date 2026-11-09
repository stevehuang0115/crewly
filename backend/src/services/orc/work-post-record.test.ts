/**
 * Tests for recording a work-destination Slack post in the chat history (CREW-877).
 */

import { recordWorkPost, type WorkPostRecordDeps } from './work-post-record.js';
import { ChatV2Service } from '../chat-v2/chat-v2.service.js';
import { openChatDatabase } from '../chat-v2/sqlite/chat-db.js';
import { loadChatV2Config } from '../chat-v2/config.js';
import type { ChatPrincipal } from '../chat-v2/types.js';

const owner: ChatPrincipal = { userId: 'owner', source: 'oss' };

describe('recordWorkPost', () => {
  const base = { agentSession: 'leo', slackChannelId: 'C0123456789', messageTs: '1760000200.000100', text: 'the answer' };

  it('files the post in the chat channel its Slack channel maps to, with the Slack ids', () => {
    const record = jest.fn().mockReturnValue('m1');
    const deps: WorkPostRecordDeps = { chatChannelOf: (c) => (c === 'C0123456789' ? 'chan-1' : null), record };
    return recordWorkPost({ ...base, threadTs: 'C0123456789:1760000100.000100' }, deps).then((r) => {
      expect(r).toEqual({ recorded: true, messageId: 'm1' });
      // A thread KEY ("<channel>:<ts>") is reduced to its ts.
      expect(record).toHaveBeenCalledWith({
        channelId: 'chan-1',
        agentSession: 'leo',
        content: 'the answer',
        slackChannelId: 'C0123456789',
        slackTs: '1760000200.000100',
        slackThreadTs: '1760000100.000100',
      });
    });
  });

  it('says why when the Slack channel has no chat channel, and stores nothing', async () => {
    const record = jest.fn();
    const r = await recordWorkPost(base, { chatChannelOf: () => null, record });
    expect(r.recorded).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/no chat channel/);
    expect(record).not.toHaveBeenCalled();
  });

  it('reports an existing row instead of storing a second one', async () => {
    const r = await recordWorkPost(base, { chatChannelOf: () => 'chan-1', record: () => null });
    expect(r).toEqual({ recorded: false, reason: 'a chat row for that Slack message already exists' });
  });

  it('never throws: a failing record must not fail a post that already reached Slack', async () => {
    const r = await recordWorkPost(base, {
      chatChannelOf: () => 'chan-1',
      record: () => {
        throw new Error('db locked');
      },
    });
    expect(r).toEqual({ recorded: false, reason: 'db locked' });
  });

  it('refuses an empty post', async () => {
    const r = await recordWorkPost({ ...base, text: '   ' }, { chatChannelOf: () => 'chan-1', record: jest.fn() });
    expect(r.recorded).toBe(false);
  });
});

describe('a reply --work-item post, end to end through the real chat store', () => {
  let service: ChatV2Service;
  let room: string;

  beforeEach(() => {
    const db = openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true });
    service = new ChatV2Service({ config: loadChatV2Config({}), db });
    room = service.createHuddle({ name: 'crewly-product', memberSessions: ['sam', 'leo'], principal: owner }).id;
  });
  afterEach(() => service.close());

  const deps = (): WorkPostRecordDeps => ({
    chatChannelOf: (c) => (c === 'C-TEAM' ? room : null),
    record: (i) => service.recordSlackOnlyAgentPost(i),
  });

  it('is found by the team lead\'s search-chat by a keyword, in the right channel', async () => {
    await recordWorkPost({ agentSession: 'leo', slackChannelId: 'C-TEAM', messageTs: '1760000300.000100', threadTs: '1760000100.000100', text: 'smart-home answer: use the Hue bridge' }, deps());
    const hits = service.searchMessagesForAgent({ agentSession: 'sam', principal: { ...owner, agentSession: 'sam' }, query: 'smart-home hue' });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ channelId: room, channel: 'crewly-product', sender: 'leo', senderType: 'agent' });
  });

  it('a Slack channel that is not a team room is not recorded (and says so)', async () => {
    const r = await recordWorkPost({ agentSession: 'leo', slackChannelId: 'C-OTHER', messageTs: '1.1', text: 'x' }, deps());
    expect(r.recorded).toBe(false);
  });
});

describe('defaultWorkDestinationDeps().post records the post', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../slack/slack-agent-post.service.js');
    jest.dontMock('../chat-v2/chat-v2.singleton.js');
    jest.dontMock('../slack/slack-team-channel.service.js');
    jest.dontMock('../slack/slack-agent-dm.service.js');
  });

  it('posts to Slack, then files a row; the reply still succeeds when the record fails', async () => {
    const db = openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true });
    const service = new ChatV2Service({ config: loadChatV2Config({}), db });
    const room = service.createHuddle({ name: 'crewly-product', memberSessions: ['sam', 'leo'], principal: owner }).id;
    const post = jest.fn().mockResolvedValue({ channelId: 'C-TEAM', messageTs: '1760000400.000100' });
    jest.resetModules();
    jest.doMock('../slack/slack-agent-post.service.js', () => ({ getSlackAgentPostService: () => ({ post }) }));
    jest.doMock('../chat-v2/chat-v2.singleton.js', () => ({ getChatV2Service: () => service }));
    jest.doMock('../slack/slack-team-channel.service.js', () => ({ getSlackTeamChannelService: () => ({ findBySlackChannelId: (c: string) => (c === 'C-TEAM' ? { chatChannelId: room } : null), listMappings: async () => [] }) }));
    jest.doMock('../slack/slack-agent-dm.service.js', () => ({ getSlackAgentDmService: () => null }));
    const { defaultWorkDestinationDeps } = await import('./work-item-destination.wiring.js');
    const deps = await defaultWorkDestinationDeps();
    const out = await deps.post({ agentSession: 'leo', target: 'C-TEAM', text: 'distinctive-term-xyz done', threadTs: '1760000100.000100' });
    expect(out).toEqual({ channelId: 'C-TEAM', messageTs: '1760000400.000100' });
    expect(service.searchMessagesForAgent({ agentSession: 'sam', principal: { ...owner, agentSession: 'sam' }, query: 'distinctive-term-xyz' })).toHaveLength(1);

    // The chat store failing must not fail the reply.
    service.close();
    const again = await deps.post({ agentSession: 'leo', target: 'C-TEAM', text: 'second post', threadTs: '1760000100.000100' });
    expect(again).toEqual({ channelId: 'C-TEAM', messageTs: '1760000400.000100' });
  });
});
