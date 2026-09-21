/**
 * Regression: a Slack auth failure must never escape SlackService as an
 * unhandled promise rejection (which the backend's process-level handler
 * turns into a graceful shutdown once signal handlers are armed).
 *
 * These tests use the REAL `@slack/bolt` App — not the hand-written App mock
 * in slack.service.test.ts — with only `WebClient.auth.test` faked, because
 * the escaping promise is Bolt's own: `App` → `singleAuthorization` →
 * `runAuthTestForBotToken` calls `auth.test()` eagerly in the constructor and
 * parks the promise without a rejection handler. A stub of Bolt would not
 * reproduce that.
 *
 * How an escaped rejection is detected: Jest's sandbox `process` object never
 * receives Node's `unhandledRejection` event (a listener installed here gets
 * 0 calls — verified), but jest-circus hooks the REAL process and fails the
 * currently running test with the rejection's error. So each test below waits
 * a macrotask after the point where Bolt's parked promise would reject; if it
 * escapes, the test fails with "An API error occurred: invalid_auth" on its
 * own. Against the pre-fix code that is exactly what happens.
 *
 * @module services/slack/slack.service.bolt-preflight.test
 */

import { SlackService, resetSlackService } from './slack.service.js';
import type { SlackConfig } from '../../types/slack.types.js';

const mockAuthTest = jest.fn();

// Keep the real @slack/web-api (Bolt and @slack/socket-mode construct their
// own WebClient instances from it); only `auth.test` is faked, on every
// instance, so the pre-flight probe, Bolt's App client and the receiver's
// client all share the one mock.
jest.mock('@slack/web-api', () => {
  const actual = jest.requireActual('@slack/web-api');
  class FakeWebClient extends actual.WebClient {
    constructor(token?: string, opts?: unknown) {
      super(token, opts as never);
      (this as unknown as { auth: unknown }).auth = { test: mockAuthTest };
    }
  }
  return { ...actual, WebClient: FakeWebClient };
});

// The outbound chat-v2 mirror is dynamically imported by SlackService; keep
// it inert here exactly as slack.service.test.ts does.
jest.mock('../chat-v2/chat-v2.singleton.js', () => ({
  getChatV2Service: () => ({
    ensureChannelForLegacyConversation: jest.fn(() => ({ id: 'chan', agentSession: 'crewly-orc' })),
    recordTurn: jest.fn(() => ({ message: { id: 'm1' } })),
  }),
}));

/** Socket-mode config; the token values never reach the network (auth.test is faked). */
const socketConfig: SlackConfig = {
  botToken: 'xoxb-test-token',
  appToken: 'xapp-test-token',
  signingSecret: 'test-secret',
  socketMode: true,
  defaultChannelId: 'C123456',
  allowedUserIds: ['U123'],
};

/** Build the error `@slack/web-api` raises for a Slack platform error. */
function slackPlatformError(code: string): Error {
  return Object.assign(new Error(`An API error occurred: ${code}`), {
    code: 'slack_webapi_platform_error',
    data: { ok: false, error: code },
  });
}

/** Let Node deliver any parked rejection (it fires after the microtask queue drains). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

describe('SlackService bot-token pre-flight against the real Bolt App', () => {
  let startSpy: jest.SpyInstance;
  let stopSpy: jest.SpyInstance;

  beforeEach(async () => {
    resetSlackService();
    mockAuthTest.mockReset();
    // Never open a real Socket Mode connection; everything up to start() is real.
    const { App } = await import('@slack/bolt');
    startSpy = jest.spyOn(App.prototype, 'start').mockResolvedValue(undefined as never);
    stopSpy = jest.spyOn(App.prototype, 'stop').mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    startSpy.mockRestore();
    stopSpy.mockRestore();
    resetSlackService();
  });

  it('invalid_auth: no rejection escapes, the App is never built, Slack is degraded, logged once', async () => {
    mockAuthTest.mockRejectedValue(slackPlatformError('invalid_auth'));
    const service = new SlackService();
    const warn = jest.spyOn((service as unknown as { logger: { warn: jest.Mock } }).logger, 'warn');
    const onError = jest.fn();
    service.on('error', onError);

    // The failure surfaces as a clean, awaited rejection from initialize()
    // (which connectSlack catches) — not as an unhandled one.
    try {
      await expect(service.initialize(socketConfig)).rejects.toThrow('An API error occurred: invalid_auth');
    } finally {
      // If Bolt's parked auth.test promise existed, it would reject about
      // here and jest-circus would fail THIS test with that error. The
      // finally keeps the wait inside this test even when the assertion
      // above already failed (pre-fix, initialize resolves), so the escaped
      // rejection is never attributed to the next test instead.
      await settle();
    }

    expect(mockAuthTest).toHaveBeenCalledTimes(1);
    expect(startSpy).not.toHaveBeenCalled();
    expect(service.isConnected()).toBe(false);

    const status = service.getStatus();
    expect(status.degraded).toBe(true);
    expect(status.degradedReason).toBe('invalid_auth');
    expect(status.lastError).toBe('An API error occurred: invalid_auth');

    const degradedLogs = warn.mock.calls.filter(([msg]) => String(msg).includes('Slack integration degraded'));
    expect(degradedLogs).toHaveLength(1);
    expect(degradedLogs[0][1]).toMatchObject({ code: 'invalid_auth' });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a network error reaching Slack is treated the same way (any pre-flight failure degrades)', async () => {
    const requestError = Object.assign(new Error('A request error occurred: connect ECONNREFUSED'), {
      code: 'slack_webapi_request_error',
      original: { code: 'ECONNREFUSED' },
    });
    mockAuthTest.mockRejectedValue(requestError);
    const service = new SlackService();

    try {
      await expect(service.initialize(socketConfig)).rejects.toThrow('ECONNREFUSED');
    } finally {
      await settle(); // same attribution guard as above
    }

    expect(startSpy).not.toHaveBeenCalled();
    expect(service.getStatus().degraded).toBe(true);
    expect(service.getStatus().degradedReason).toBe('ECONNREFUSED');
  });

  it('valid token: auth.test runs exactly once (Bolt is handed the ids and skips its own), connected, not degraded', async () => {
    mockAuthTest.mockResolvedValue({ ok: true, user_id: 'UBOT', bot_id: 'BBOT', team: 'T1' });
    const service = new SlackService();
    const connected = jest.fn();
    service.on('connected', connected);

    await service.initialize(socketConfig);
    await settle();

    // One call from the pre-flight and none from Bolt: with botId + botUserId
    // supplied, Bolt's runAuthTestForBotToken resolves without calling
    // auth.test at all. Without the ids this would be 2.
    expect(mockAuthTest).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(connected).toHaveBeenCalledTimes(1);
    expect(service.isConnected()).toBe(true);
    // Not degraded (undefined before any degradation was ever recorded).
    expect(service.getStatus().degraded).toBeFalsy();

    await service.disconnect();
    expect(service.isConnected()).toBe(false);
  });

  it('valid token: the verified identity seeds the bot-user cache (no second auth.test for routing)', async () => {
    mockAuthTest.mockResolvedValue({ ok: true, user_id: 'UBOT', bot_id: 'BBOT', team: 'T1' });
    const service = new SlackService();

    await service.initialize(socketConfig);
    await settle();

    await expect(service.getBotUserId()).resolves.toBe('UBOT');
    // Pre-flight only; getBotUserId answered from the seeded cache.
    expect(mockAuthTest).toHaveBeenCalledTimes(1);

    await service.disconnect();
  });
});
