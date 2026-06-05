/**
 * Tests for the Boot Announce Service.
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  composeBootAnnouncement,
  sendBootAnnouncement,
  type BootAnnounceDeps,
} from './boot-announce.service.js';

describe('composeBootAnnouncement', () => {
  it('always reports startup + version', () => {
    const { title, message } = composeBootAnnouncement({ version: '1.11.3' });
    expect(title).toContain('上线');
    expect(message).toBe('• 版本: 1.11.3');
  });

  it('adds offline duration when present (minutes)', () => {
    const { message } = composeBootAnnouncement({ version: '1.11.3', offlineDurationMs: 12 * 60_000 });
    expect(message).toContain('• 版本: 1.11.3');
    expect(message).toContain('• 离线: 12 分钟');
  });

  it('formats hours+minutes and sub-minute durations', () => {
    expect(composeBootAnnouncement({ version: 'x', offlineDurationMs: 125 * 60_000 }).message).toContain('2 小时 5 分钟');
    expect(composeBootAnnouncement({ version: 'x', offlineDurationMs: 30_000 }).message).toContain('<1 分钟');
  });

  it('adds replayed count when > 0, omits it when 0', () => {
    expect(composeBootAnnouncement({ version: 'x', replayedCount: 3 }).message).toContain('已补处理: 3 条');
    expect(composeBootAnnouncement({ version: 'x', replayedCount: 0 }).message).not.toContain('已补处理');
  });

  it('omits optional lines when absent', () => {
    const { message } = composeBootAnnouncement({ version: '1.0.0' });
    expect(message).not.toContain('离线');
    expect(message).not.toContain('已补处理');
  });
});

describe('sendBootAnnouncement', () => {
  function makeDeps(connected: boolean): { deps: BootAnnounceDeps; sent: BootAnnounceDeps['sendSlack'] } {
    const sent = jest.fn(async () => {});
    const deps: BootAnnounceDeps = {
      isSlackConnected: () => connected,
      sendSlack: sent as unknown as BootAnnounceDeps['sendSlack'],
      logger: { info: jest.fn(), warn: jest.fn() },
    };
    return { deps, sent };
  }

  it('sends when Slack is connected', async () => {
    const { deps, sent } = makeDeps(true);
    await sendBootAnnouncement({ version: '1.11.3' }, deps);
    expect(sent).toHaveBeenCalledTimes(1);
    const arg = (sent as jest.Mock).mock.calls[0][0] as { title: string; message: string };
    expect(arg.message).toContain('1.11.3');
  });

  it('skips silently when Slack is not connected', async () => {
    const { deps, sent } = makeDeps(false);
    await sendBootAnnouncement({ version: '1.11.3' }, deps);
    expect(sent).not.toHaveBeenCalled();
  });

  it('swallows a send error (never throws) and warns', async () => {
    const warn = jest.fn();
    const deps: BootAnnounceDeps = {
      isSlackConnected: () => true,
      sendSlack: (async () => {
        throw new Error('slack down');
      }) as unknown as BootAnnounceDeps['sendSlack'],
      logger: { info: jest.fn(), warn },
    };
    await expect(sendBootAnnouncement({ version: '1.11.3' }, deps)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
