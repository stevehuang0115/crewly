/**
 * Tests for the owner's "skip all old cards" / 「清掉旧卡片」 orc-DM command
 * (specs/2026-10-01-decision-skip.md §3).
 */
import type { SlackIncomingMessage } from '../../types/slack.types.js';
import type { SkipAllInput, SkipAllResult } from './decision.service.js';
import { createSkipAllCommandInterceptor, isSkipAllCommand, skipAllReply, startOfToday } from './decision-skip-command.js';

const NOW = new Date(2026, 9, 1, 15, 30, 0);

const msg = (text: string, extra: Partial<SlackIncomingMessage> = {}): SlackIncomingMessage =>
  ({ channelId: 'D-ORC', ts: '1.1', text, userId: 'U-OWNER', ...extra }) as SlackIncomingMessage;

const result = (over: Partial<SkipAllResult> = {}): SkipAllResult => ({ dryRun: false, matched: 0, settled: [], rows: [], ...over });

describe('isSkipAllCommand', () => {
  it('takes the English and Chinese phrasings, whole-message only', () => {
    for (const t of ['skip all old cards', 'Skip all old cards!', '<@U1> clear old cards.', 'please skip all old cards', '清掉旧卡片', '帮我清掉旧卡片。', '清除旧卡片']) {
      expect(isSkipAllCommand(t)).toBe(true);
    }
    for (const t of ['', undefined, 'skip', 'how do I skip all old cards in the dashboard?x', 'skip all old cards except D-4', '清掉旧卡片里的 D-4']) {
      expect(isSkipAllCommand(t)).toBe(false);
    }
  });
});

describe('startOfToday / skipAllReply', () => {
  it('is local midnight', () => {
    expect(startOfToday(NOW)).toEqual(new Date(2026, 9, 1, 0, 0, 0, 0));
  });

  it('says what happened in English', () => {
    expect(skipAllReply(result())).toBe('No open cards from before today — nothing to clear.');
    expect(skipAllReply(result({ matched: 1, settled: ['D-1'] }))).toBe('Skipped 1 card from before today. Their agents were told to drop them and not ask again.');
    expect(
      skipAllReply(
        result({
          matched: 3,
          settled: ['D-1', 'D-2', 'D-3'],
          rows: [
            { id: 'D-1', question: 'q', asker: 'a', createdAt: '', source: 'live', outcome: 'skipped' },
            { id: 'D-2', question: 'q', asker: 'a', createdAt: '', source: 'live', outcome: 'skipped' },
            { id: 'D-3', question: 'q', asker: 'a', createdAt: '', source: 'live', outcome: 'declined' },
          ],
        }),
      ),
    ).toBe('Skipped 3 cards from before today (1 that needed your OK was answered "No"). Their agents were told to drop them and not ask again.');
  });
});

describe('createSkipAllCommandInterceptor', () => {
  function setup(scope: 'orc' | 'agent' | null = 'orc', fail = false) {
    const calls: SkipAllInput[] = [];
    const replies: Array<{ text: string; target: unknown }> = [];
    const service = {
      skipAll: jest.fn(async (input: SkipAllInput) => {
        calls.push(input);
        if (fail) throw new Error('disk full');
        return result({ matched: 2, settled: ['D-1', 'D-2'] });
      }),
    };
    const intercept = createSkipAllCommandInterceptor({
      ownerDmScope: () => scope,
      replyTargetOf: (m) => ({ channelId: m.channelId, threadTs: m.ts }),
      reply: async (text, target) => void replies.push({ text, target }),
      service: () => service,
      now: () => NOW,
    });
    return { intercept, calls, replies, service };
  }
  const flush = () => new Promise((r) => setImmediate(r));

  it('consumes the command in the owner orc DM, skips everything before today, answers in the same place', async () => {
    const s = setup();
    expect(s.intercept(msg('清掉旧卡片'))).toBe(true);
    await flush();
    expect(s.calls).toEqual([{ olderThan: new Date(2026, 9, 1, 0, 0, 0, 0), source: 'all' }]);
    expect(s.replies).toEqual([{ text: 'Skipped 2 cards from before today. Their agents were told to drop them and not ask again.', target: { channelId: 'D-ORC', threadTs: '1.1' } }]);
  });

  it('leaves everything else to the orc: other words, other DMs, channels, files', async () => {
    const s = setup();
    expect(s.intercept(msg('what is on my plate?'))).toBe(false);
    expect(s.intercept(msg('skip all old cards', { hasFiles: true }))).toBe(false);
    expect(setup('agent').intercept(msg('skip all old cards'))).toBe(false);
    expect(setup(null).intercept(msg('skip all old cards'))).toBe(false);
    await flush();
    expect(s.service.skipAll).not.toHaveBeenCalled();
  });

  it('says so when it fails', async () => {
    const s = setup('orc', true);
    expect(s.intercept(msg('skip all old cards'))).toBe(true);
    await flush();
    await flush();
    expect(s.replies[0].text).toBe("Couldn't clear the old cards — try again from the dashboard's Waiting on you section.");
  });
});
