import { onAgentSlackPost, onChatRow, onSlackInboundPost, onSlackOutboundPost, ownerLanguageOf, postReportFallback, resolveReportPlace, type OwnerLanguageChatReads } from './owner-completion-report.wiring.js';
import type { ReportPlace } from './owner-completion-report.service.js';

const comment = { appId: 'upb7se5pfj', commentId: 'QMSjXIhFanDw' };

describe('resolveReportPlace', () => {
  it('an app comment resolves to the comment and its mirrored Slack thread', async () => {
    const place = await resolveReportPlace({ kind: 'owner', appComment: comment }, async () => ({ slackChannelId: 'C0C2WMFB9EF', threadTs: '1791380650.784969' }));
    expect(place).toMatchObject({ kind: 'app-comment', ...comment, slackChannelId: 'C0C2WMFB9EF', threadTs: '1791380650.784969' });
    expect(place?.label).toContain('[SLACK-THREAD:C0C2WMFB9EF:1791380650.784969]');
  });

  it('an app comment without a mirror is still a place (the comment itself)', async () => {
    expect(await resolveReportPlace({ kind: 'owner', appComment: comment }, async () => null)).toMatchObject({ kind: 'app-comment', ...comment });
  });

  it('Slack thread, Slack DM, chat, nothing', async () => {
    const none = async () => null;
    expect(await resolveReportPlace({ kind: 'owner', slackChannelId: 'C1', threadTs: '1.2' }, none)).toMatchObject({ kind: 'slack', slackChannelId: 'C1', threadTs: '1.2' });
    expect(await resolveReportPlace({ kind: 'owner', slackChannelId: 'D1' }, none)).toMatchObject({ kind: 'slack', slackChannelId: 'D1' });
    expect(await resolveReportPlace({ kind: 'owner', conversationId: 'conv' }, none)).toMatchObject({ kind: 'chat', conversationId: 'conv' });
    expect(await resolveReportPlace({ kind: 'owner' }, none)).toBeNull();
  });
});

describe('postReportFallback', () => {
  const appPlace: ReportPlace = { kind: 'app-comment', ...comment, slackChannelId: 'C1', threadTs: '1.2', label: 'x' };

  it('replies on the app comment as the agent first', async () => {
    const replyComment = jest.fn(async () => undefined);
    const slackAsAgent = jest.fn(async () => undefined);
    expect(await postReportFallback(appPlace, 'lyra', 'summary', { replyComment, slackAsAgent })).toBe(true);
    expect(replyComment).toHaveBeenCalledWith('upb7se5pfj', 'QMSjXIhFanDw', 'lyra', 'summary');
    expect(slackAsAgent).not.toHaveBeenCalled();
  });

  it('falls back to the Slack thread as the agent, then as Crewly', async () => {
    const replyComment = jest.fn(async () => {
      throw new Error('cloud down');
    });
    const slackAsAgent = jest.fn(async () => {
      throw new Error('no bot');
    });
    const slackAsCrewly = jest.fn(async () => undefined);
    expect(await postReportFallback(appPlace, 'lyra', 's', { replyComment, slackAsAgent, slackAsCrewly })).toBe(true);
    expect(slackAsCrewly).toHaveBeenCalledWith('C1', 's', '1.2');
  });

  it('chat places post as the agent; nothing works → false', async () => {
    const chatAsAgent = jest.fn(async () => undefined);
    expect(await postReportFallback({ kind: 'chat', conversationId: 'conv', label: 'c' }, 'ella', 's', { chatAsAgent })).toBe(true);
    expect(chatAsAgent).toHaveBeenCalledWith('conv', 'ella', 's');
    expect(await postReportFallback({ kind: 'slack', slackChannelId: 'C1', label: 's' }, 'ella', 's', {})).toBe(false);
  });
});

describe('answer feeds', () => {
  const svc = () => ({ noteChatAnswer: jest.fn(), noteSlackAnswer: jest.fn() });

  it('an agent chat row answers its conversation and its Slack thread; interim and owner rows do not', () => {
    const s = svc();
    onChatRow(s, { channelId: 'conv', senderType: 'agent', threadId: 'root', metadata: { slackThreadKey: 'C0MKT123:1791380650.784969' } });
    expect(s.noteChatAnswer).toHaveBeenCalledWith('conv', 'root', undefined);
    expect(s.noteSlackAnswer).toHaveBeenCalledWith('C0MKT123', '1791380650.784969', undefined);
    const a = svc();
    onChatRow(a, { channelId: 'conv', senderType: 'agent', senderId: 'sage', threadId: 'root', metadata: {} });
    expect(a.noteChatAnswer).toHaveBeenCalledWith('conv', 'root', 'sage');
    const t = svc();
    onChatRow(t, { channelId: 'conv', senderType: 'agent', metadata: { interim: true } });
    onChatRow(t, { channelId: 'conv', senderType: 'user', metadata: {} });
    expect(t.noteChatAnswer).not.toHaveBeenCalled();
  });

  it('Slack posts: outbound unless flagged not-an-answer; inbound only from agents', () => {
    const s = svc();
    onSlackOutboundPost(s, { channelId: 'C1', threadTs: '1.2' });
    onSlackOutboundPost(s, { channelId: 'C1', threadTs: '1.3', notAnAnswer: true });
    onSlackInboundPost(s, { channelId: 'C1', threadTs: '1.4' });
    onSlackInboundPost(s, { channelId: 'C1', threadTs: '1.5', authorAgentSession: 'lyra' });
    expect(s.noteSlackAnswer.mock.calls).toEqual([
      ['C1', '1.2'],
      ['C1', '1.5', 'lyra'],
    ]);
  });

  it('agent posts made on this machine carry their author; interim lines do not count (crewly#1376)', () => {
    const s = svc();
    onAgentSlackPost(s, { agent: 'sage', slackChannelId: 'C1', threadTs: '1.6' });
    onAgentSlackPost(s, { agent: 'sage', slackChannelId: 'C1', threadTs: '1.7', interim: true });
    onAgentSlackPost(s, { agent: '', slackChannelId: 'C1' });
    expect(s.noteSlackAnswer.mock.calls).toEqual([['C1', '1.6', 'sage']]);
  });
});

describe('ownerLanguageOf (crewly#1357)', () => {
  const NOW = Date.parse('2026-10-17T15:47:00Z');
  const chat = (over: Partial<OwnerLanguageChatReads> = {}): OwnerLanguageChatReads => ({
    findSlackThreadRoot: (conv, ts) => (conv === 'room-video' && ts === '1792000000.000100' ? { id: 'root-1' } : null),
    listThreadForBridge: (conv, root) =>
      conv === 'room-video' && root === 'root-1'
        ? [
            { senderType: 'user', content: '什么是投资？帮我做个视频', createdAt: NOW - 60_000 },
            { senderType: 'agent', content: 'On it — recording the English demo now.', createdAt: NOW - 30_000 },
          ]
        : [],
    getRecentOwnerMessageContents: () => ['please ship it today', 'thanks'],
    ...over,
  });
  const mapping = (ch: string) => (ch === 'C0VIDEO' ? 'room-video' : null);

  it('reads the owner\'s own messages in the Slack thread (agents\' English does not count)', () => {
    const origin = { kind: 'owner' as const, slackChannelId: 'C0VIDEO', threadTs: '1792000000.000100', receivedBy: 'ella' };
    expect(ownerLanguageOf(origin, { kind: 'slack', slackChannelId: 'C0VIDEO', threadTs: '1792000000.000100', label: 't' }, chat(), mapping, NOW)).toBe('zh');
    // The conversation id on the origin spares the channel mapping.
    expect(ownerLanguageOf({ ...origin, conversationId: 'room-video' }, null, chat(), () => null, NOW)).toBe('zh');
  });

  it('a chat thread root is read directly; a place with no owner text falls back to the owner\'s recent messages; nothing → null', () => {
    const c = chat({ listThreadForBridge: (conv, root) => (root === 'root-9' ? [{ senderType: 'user', content: 'Record the two accounts flow', createdAt: NOW }] : []) });
    expect(ownerLanguageOf({ kind: 'owner', conversationId: 'conv-1', chatThreadId: 'root-9' }, null, c, () => null, NOW)).toBe('en');
    expect(ownerLanguageOf({ kind: 'owner', slackChannelId: 'D0DM' }, null, chat({ getRecentOwnerMessageContents: () => ['今天把排期卡文案写完'] }), () => null, NOW)).toBe('zh');
    expect(ownerLanguageOf({ kind: 'owner', slackChannelId: 'D0DM' }, null, chat({ getRecentOwnerMessageContents: () => [] }), () => null, NOW)).toBeNull();
  });

  it('never throws', () => {
    const broken = chat({ findSlackThreadRoot: () => { throw new Error('db closed'); } });
    expect(ownerLanguageOf({ kind: 'owner', conversationId: 'room-video', threadTs: '1792000000.000100' }, null, broken, () => null, NOW)).toBeNull();
  });
});
