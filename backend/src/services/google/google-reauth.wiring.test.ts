/**
 * Tests for the reconnect-card wiring — where the card goes (the agent's
 * thread, else the owner's DM with that agent) and how it is posted (an
 * ordinary message in a DM so it reaches the phone, ephemeral in a channel).
 *
 * @module services/google/google-reauth.wiring.test
 */

import { createReauthNotifierDeps, isDirectMessage, type ReauthSlackApi } from './google-reauth.wiring.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
    }),
  },
}));

describe('google-reauth wiring', () => {
  let slack: { [K in keyof ReauthSlackApi]-?: jest.Mock };
  let workDestination: jest.Mock;
  let agentDm: jest.Mock;
  let agentBotToken: jest.Mock;

  beforeEach(() => {
    slack = {
      getOwnerUserId: jest.fn().mockReturnValue('UOWNER'),
      openDirectMessage: jest.fn().mockResolvedValue('D-OWNER'),
      sendMessage: jest.fn().mockResolvedValue('171.1'),
      sendEphemeral: jest.fn().mockResolvedValue(true),
    };
    workDestination = jest.fn().mockResolvedValue(null);
    agentDm = jest.fn().mockReturnValue(null);
    agentBotToken = jest.fn().mockReturnValue('xoxb-ella');
  });

  const build = () =>
    createReauthNotifierDeps({
      sendToAgent: jest.fn(),
      slack: () => slack as unknown as ReauthSlackApi,
      workDestination,
      agentDm,
      agentBotToken,
    });

  it('knows a DM from a channel', () => {
    expect(isDirectMessage('D0AMUJ4KNBS')).toBe(true);
    expect(isDirectMessage('C0123')).toBe(false);
  });

  describe('placeFor', () => {
    it('uses the thread the agent is working in', async () => {
      workDestination.mockResolvedValue({ slackChannelId: 'C-TEAM', threadTs: '100.1' });
      expect(await build().placeFor('ella', 'UOWNER')).toEqual({ slackChannelId: 'C-TEAM', threadTs: '100.1', botToken: 'xoxb-ella' });
    });

    it('skips a bare team channel and uses the owner DM with the agent', async () => {
      workDestination.mockResolvedValue({ slackChannelId: 'C-TEAM' });
      agentDm.mockReturnValue({ slackChannelId: 'D-ELLA' });
      expect(await build().placeFor('ella', 'UOWNER')).toEqual({ slackChannelId: 'D-ELLA', botToken: 'xoxb-ella' });
    });

    it("opens the owner's DM with the agent's bot when there is no conversation yet", async () => {
      expect(await build().placeFor('ella', 'UOWNER')).toEqual({ slackChannelId: 'D-OWNER', botToken: 'xoxb-ella' });
      expect(slack.openDirectMessage).toHaveBeenCalledWith('UOWNER', 'xoxb-ella');
    });

    it('returns null when Slack cannot open a DM either', async () => {
      slack.openDirectMessage.mockRejectedValue(new Error('not_allowed'));
      expect(await build().placeFor(undefined, 'UOWNER')).toBeNull();
    });
  });

  describe('postCard', () => {
    it('posts an ordinary message in a DM, so the phone gets a notification', async () => {
      expect(await build().postCard({ slackChannelId: 'D-ELLA', botToken: 'xoxb-ella' }, 'UOWNER', 'Gmail…', [{ type: 'section' }])).toBe(true);
      expect(slack.sendMessage).toHaveBeenCalledWith({
        channelId: 'D-ELLA',
        text: 'Gmail…',
        blocks: [{ type: 'section' }],
        botToken: 'xoxb-ella',
        skipChatV2Mirror: true,
      });
      expect(slack.sendEphemeral).not.toHaveBeenCalled();
    });

    it('keeps a channel card ephemeral, in the thread', async () => {
      await build().postCard({ slackChannelId: 'C-TEAM', threadTs: '100.1', botToken: 'xoxb-ella' }, 'UOWNER', 't', []);
      expect(slack.sendEphemeral).toHaveBeenCalledWith('C-TEAM', 'UOWNER', 't', [], 'xoxb-ella', '100.1');
      expect(slack.sendMessage).not.toHaveBeenCalled();
    });

    it("retries with the shared bot, then falls back to the owner's DM", async () => {
      slack.sendEphemeral.mockResolvedValue(false);
      expect(await build().postCard({ slackChannelId: 'C-TEAM', threadTs: '100.1', botToken: 'xoxb-ella' }, 'UOWNER', 't', [])).toBe(true);
      expect(slack.sendEphemeral).toHaveBeenCalledTimes(2);
      expect(slack.sendEphemeral.mock.calls[1][4]).toBeUndefined();
      expect(slack.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'D-OWNER' }));
    });

    it('reports failure when nothing took it', async () => {
      slack.sendMessage.mockRejectedValue(new Error('channel_not_found'));
      expect(await build().postCard({ slackChannelId: 'D-ELLA' }, 'UOWNER', 't', [])).toBe(false);
    });
  });

  it('reads the owner from Slack and hands retries to the agent hook', async () => {
    const sendToAgent = jest.fn().mockResolvedValue(true);
    const deps = createReauthNotifierDeps({ sendToAgent, slack: () => slack as unknown as ReauthSlackApi, workDestination, agentDm, agentBotToken });
    expect(deps.ownerUserId()).toBe('UOWNER');
    await deps.tellAgent('ella', 'hi');
    expect(sendToAgent).toHaveBeenCalledWith('ella', 'hi');
  });
});
