import { onChatRow, onSlackInboundPost, onSlackOutboundPost, postReportFallback, resolveReportPlace } from './owner-completion-report.wiring.js';
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
    expect(s.noteChatAnswer).toHaveBeenCalledWith('conv', 'root');
    expect(s.noteSlackAnswer).toHaveBeenCalledWith('C0MKT123', '1791380650.784969');
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
      ['C1', '1.5'],
    ]);
  });
});
