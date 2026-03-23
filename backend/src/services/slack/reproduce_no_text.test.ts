
import { SlackService, resetSlackService } from './slack.service.js';
import type { SlackConfig } from '../../types/slack.types.js';
import { EventEmitter } from 'events';

const mockPostMessage = jest.fn();

jest.mock('@slack/bolt', () => ({
  App: jest.fn().mockImplementation(() => ({
    client: {
      chat: { postMessage: mockPostMessage, update: jest.fn() },
      reactions: { add: jest.fn() },
      users: { info: jest.fn() },
      files: { uploadV2: jest.fn(), info: jest.fn() },
    },
    receiver: { client: new EventEmitter() },
    message: jest.fn(),
    event: jest.fn(),
    error: jest.fn(),
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
  })),
  LogLevel: { INFO: 'info' },
}));

describe('SlackService no_text reproduction', () => {
  const mockConfig: SlackConfig = {
    botToken: 'xoxb-test-token',
    appToken: 'xapp-test-token',
    signingSecret: 'test-secret',
    socketMode: true,
    defaultChannelId: 'C123456',
    allowedUserIds: ['U123'],
  };

  let service: SlackService;

  beforeEach(async () => {
    resetSlackService();
    jest.clearAllMocks();
    service = new SlackService();
    await service.initialize(mockConfig);
    mockPostMessage.mockResolvedValue({ ok: true, ts: '123.456' });
  });

  it('should send a default text if message.text is empty', async () => {
    // Current behavior: passes empty string to Slack API
    // We want to verify it sends SOMETHING non-empty
    await service.sendMessage({ channelId: 'C123', text: '', blocks: [{ type: 'divider' }] });

    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.any(String)
    }));
    
    const callArgs = mockPostMessage.mock.calls[0][0];
    expect(callArgs.text.length).toBeGreaterThan(0);
  });
});
