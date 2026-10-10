/**
 * Tests for the Google reconnect notifier — one card per product + account
 * per window, the owner-facing wording, and the retry notice once the owner
 * has reconnected.
 *
 * @module services/google/google-reauth-notifier.service.test
 */

import {
  GoogleReauthNotifier,
  isReconnected,
  reauthCardMessage,
  reauthRetryNotice,
  type ReauthNotifierDeps,
} from './google-reauth-notifier.service.js';
import type { GoogleWorkspaceStatus } from './google-workspace-token.service.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
    }),
  },
}));

const COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';
const GMAIL = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'];
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

function statusWith(scopes: string[], products: Array<'gmail' | 'calendar' | 'drive'> = ['gmail'], email = 'owner@gmail.com'): GoogleWorkspaceStatus {
  return {
    connected: true,
    cloudConnected: true,
    connections: [{ email, products, scopes, grantedAt: '', isDefault: true } as never],
  };
}

describe('wording', () => {
  it('says what broke and that it is quick — the owner is on a phone', () => {
    expect(reauthCardMessage({ product: 'gmail', kind: 'missing_scope' })).toBe(
      'Gmail needs re-authorization to save drafts (missing permission). Tap to reconnect — takes 30 seconds on your phone.',
    );
    expect(reauthCardMessage({ product: 'gmail', kind: 'expired' })).toBe('Gmail access expired — tap to reconnect.');
    expect(reauthCardMessage({ product: 'gmail', kind: 'not_connected' })).toContain('Gmail needs access');
    expect(reauthCardMessage({ product: 'drive', kind: 'missing_scope' })).toContain('Google Drive needs re-authorization to comment on documents');
  });

  it('tells the agent what to retry', () => {
    expect(reauthRetryNotice({ product: 'gmail', kind: 'missing_scope' })).toBe('[GOOGLE] Gmail reconnected — retry your draft.');
    expect(reauthRetryNotice({ product: 'gmail', kind: 'expired' })).toBe('[GOOGLE] Gmail reconnected — retry what failed.');
  });
});

describe('isReconnected', () => {
  it('needs the missing scope on the same account for a scope failure', () => {
    const trigger = { product: 'gmail' as const, kind: 'missing_scope' as const, account: 'owner@gmail.com' };
    expect(isReconnected(statusWith(GMAIL), trigger)).toBe(false);
    expect(isReconnected(statusWith([...GMAIL, COMPOSE]), trigger)).toBe(true);
    expect(isReconnected(statusWith([...GMAIL, COMPOSE], ['gmail'], 'other@gmail.com'), trigger)).toBe(false);
  });

  it('needs the account back for the product after an expiry', () => {
    const trigger = { product: 'gmail' as const, kind: 'expired' as const, account: 'Owner@gmail.com' };
    expect(isReconnected({ connected: false, cloudConnected: true, connections: [] }, trigger)).toBe(false);
    expect(isReconnected(statusWith(GMAIL, ['calendar']), trigger)).toBe(false);
    expect(isReconnected(statusWith(GMAIL), trigger)).toBe(true);
  });
});

describe('GoogleReauthNotifier', () => {
  let now: number;
  let timers: Array<{ fn: () => void; cancelled: boolean }>;
  let deps: { [K in keyof ReauthNotifierDeps]-?: jest.Mock };
  let notifier: GoogleReauthNotifier;

  /** Run every pending timer once (each poll schedules the next). */
  async function tick(): Promise<void> {
    const due = timers.filter((t) => !t.cancelled);
    timers = [];
    for (const t of due) t.fn();
    // Let the poll's awaits settle.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }

  beforeEach(() => {
    now = Date.parse('2026-10-08T14:00:00.000Z');
    timers = [];
    deps = {
      ownerUserId: jest.fn().mockReturnValue('UOWNER'),
      placeFor: jest.fn().mockResolvedValue({ slackChannelId: 'D-ELLA', botToken: 'xoxb-ella' }),
      postCard: jest.fn().mockResolvedValue(true),
      status: jest.fn().mockResolvedValue(statusWith(GMAIL)),
      clearTokenCache: jest.fn(),
      tellAgent: jest.fn().mockResolvedValue(true),
      now: jest.fn(() => now),
      setTimer: jest.fn((fn: () => void) => {
        const t = { fn, cancelled: false };
        timers.push(t);
        return { cancel: () => { t.cancelled = true; } };
      }),
    };
    notifier = new GoogleReauthNotifier(deps);
  });

  afterEach(() => notifier.stop());

  const draftFailure = { product: 'gmail' as const, kind: 'missing_scope' as const, account: 'owner@gmail.com', agentSession: 'ella' };

  it('posts the card where the agent works, for that account, with the reason', async () => {
    const result = await notifier.notify(draftFailure);

    expect(result).toEqual({ status: 'posted' });
    expect(deps.placeFor).toHaveBeenCalledWith('ella', 'UOWNER');
    const [place, owner, text, blocks] = deps.postCard.mock.calls[0];
    expect(place).toEqual({ slackChannelId: 'D-ELLA', botToken: 'xoxb-ella' });
    expect(owner).toBe('UOWNER');
    expect(text).toBe('Gmail needs re-authorization to save drafts (missing permission). Tap to reconnect — takes 30 seconds on your phone.');
    // The portal deep link: no token, no expiry wording.
    const json = JSON.stringify(blocks);
    expect(json).toContain('https://crewlyai.com/portal/integrations/google?products=gmail&account=owner%40gmail.com&auto=1');
    expect(json).not.toMatch(/token=|expire|works once/i);
    expect(json).toContain('owner@gmail.com');
  });

  it('shares one card inside the resend window and remembers who else is waiting', async () => {
    await notifier.notify(draftFailure);
    now += 5 * MIN;
    const again = await notifier.notify({ ...draftFailure, agentSession: 'nova' });
    expect(again).toEqual({
      status: 'already_sent',
      sentAt: '2026-10-08T14:00:00.000Z',
      nextCardAfter: '2026-10-08T14:10:00.000Z',
    });
    expect(deps.postCard).toHaveBeenCalledTimes(1);

    // Another account, or another product, is its own card.
    await notifier.notify({ ...draftFailure, account: 'work@company.com' });
    await notifier.notify({ ...draftFailure, product: 'drive' });
    expect(deps.postCard).toHaveBeenCalledTimes(3);
  });

  // 2026-10-10: the owner said the card failed and the agent could not get
  // another for six hours.
  it('posts a fresh card once the last one is older than ten minutes and nobody reconnected', async () => {
    await notifier.notify(draftFailure);
    now += 11 * MIN;
    expect((await notifier.notify({ ...draftFailure, agentSession: 'nova' })).status).toBe('posted');
    expect(deps.postCard).toHaveBeenCalledTimes(2);

    // Both agents still hear about the reconnect.
    deps.status.mockResolvedValue(statusWith([...GMAIL, COMPOSE]));
    await tick();
    expect(deps.tellAgent).toHaveBeenCalledWith('ella', expect.any(String));
    expect(deps.tellAgent).toHaveBeenCalledWith('nova', expect.any(String));
  });

  it('posts a fresh card at once when the agent resends because the owner asked', async () => {
    await notifier.notify(draftFailure);
    now += 1 * MIN;
    expect((await notifier.notify({ ...draftFailure, resend: true })).status).toBe('posted');
    expect(deps.postCard).toHaveBeenCalledTimes(2);
  });

  it('posts one card when two calls fail at once', async () => {
    const [a, b] = await Promise.all([notifier.notify(draftFailure), notifier.notify({ ...draftFailure, agentSession: 'nova' })]);
    expect(a.status).toBe('posted');
    expect(b.status).toBe('posted');
    expect(deps.postCard).toHaveBeenCalledTimes(1);
  });

  it('posts the expiry card for an expired or revoked grant', async () => {
    await notifier.notify({ ...draftFailure, kind: 'expired' });
    expect(deps.postCard.mock.calls[0][2]).toBe('Gmail access expired — tap to reconnect.');
  });

  it('tells every waiting agent to retry once the owner has reconnected, then lifts the throttle', async () => {
    await notifier.notify(draftFailure);
    await notifier.notify({ ...draftFailure, agentSession: 'nova' });

    await tick();
    expect(deps.tellAgent).not.toHaveBeenCalled();

    deps.status.mockResolvedValue(statusWith([...GMAIL, COMPOSE]));
    await tick();
    expect(deps.clearTokenCache).toHaveBeenCalledWith('owner@gmail.com');
    expect(deps.tellAgent).toHaveBeenCalledWith('ella', '[GOOGLE] Gmail reconnected — retry your draft.');
    expect(deps.tellAgent).toHaveBeenCalledWith('nova', '[GOOGLE] Gmail reconnected — retry your draft.');

    // A new failure after the fix gets its own card straight away.
    expect((await notifier.notify(draftFailure)).status).toBe('posted');
  });

  it('keeps watching for a day with a growing wait, then stops', async () => {
    await notifier.notify(draftFailure);
    const waits = (deps.setTimer.mock.calls as Array<[unknown, number]>).map((c) => c[1]);
    await tick();
    await tick();
    const all = (deps.setTimer.mock.calls as Array<[unknown, number]>).map((c) => c[1]);
    expect(waits).toEqual([30_000]);
    expect(all.slice(0, 3)).toEqual([30_000, 45_000, 67_500]);

    // The link never expires, so the card is still live well past 15 minutes.
    now += 3 * HOUR;
    deps.status.mockResolvedValue(statusWith([...GMAIL, COMPOSE]));
    await tick();
    expect(deps.tellAgent).toHaveBeenCalledWith('ella', expect.any(String));
  });

  it('gives up after the watch window', async () => {
    await notifier.notify(draftFailure);
    now += 25 * HOUR;
    await tick();
    expect(timers).toHaveLength(0);
    expect(deps.tellAgent).not.toHaveBeenCalled();
  });

  it('reports why it could not post, without throttling the next try', async () => {
    deps.ownerUserId.mockReturnValueOnce(null);
    expect(await notifier.notify(draftFailure)).toMatchObject({ status: 'unavailable' });
    deps.placeFor.mockResolvedValueOnce(null);
    expect(await notifier.notify(draftFailure)).toMatchObject({ status: 'unavailable' });
    deps.postCard.mockResolvedValueOnce(false);
    expect(await notifier.notify(draftFailure)).toMatchObject({ status: 'unavailable', why: 'Slack refused the card' });

    expect((await notifier.notify(draftFailure)).status).toBe('posted');
  });
});
