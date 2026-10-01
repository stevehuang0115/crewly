/**
 * Tests for the Boot Announce Service.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  composeBootAnnouncement,
  sendBootAnnouncement,
  isFirstBoot,
  markBooted,
  type BootAnnounceDeps,
} from './boot-announce.service.js';

describe('composeBootAnnouncement', () => {
  it('always reports startup + version', () => {
    const { title, message } = composeBootAnnouncement({ version: '1.11.3' });
    expect(title).toContain('back online');
    expect(message).toBe('• Version: 1.11.3');
  });

  it('adds offline duration when present (minutes)', () => {
    const { message } = composeBootAnnouncement({ version: '1.11.3', offlineDurationMs: 12 * 60_000 });
    expect(message).toContain('• Version: 1.11.3');
    expect(message).toContain('• Offline: 12 min');
  });

  it('formats hours+minutes and sub-minute durations', () => {
    expect(composeBootAnnouncement({ version: 'x', offlineDurationMs: 125 * 60_000 }).message).toContain('2 h 5 min');
    expect(composeBootAnnouncement({ version: 'x', offlineDurationMs: 30_000 }).message).toContain('<1 min');
  });

  it('adds replayed count when > 0, omits it when 0', () => {
    expect(composeBootAnnouncement({ version: 'x', replayedCount: 3 }).message).toContain('Caught up: 3 offline messages');
    expect(composeBootAnnouncement({ version: 'x', replayedCount: 0 }).message).not.toContain('Caught up');
  });

  it('omits optional lines when absent', () => {
    const { message } = composeBootAnnouncement({ version: '1.0.0' });
    expect(message).not.toContain('Offline');
    expect(message).not.toContain('Caught up');
  });

  it('shows a WELCOME (not restarted) on first boot, and omits offline/replayed', () => {
    const { title, message } = composeBootAnnouncement({
      version: '1.11.4',
      firstBoot: true,
      offlineDurationMs: 999_999, // should be ignored on first boot
      replayedCount: 5, // should be ignored on first boot
    });
    expect(title).toContain('Welcome');
    expect(title).not.toContain('back online');
    expect(message).toContain('1.11.4');
    expect(message).not.toContain('Offline');
    expect(message).not.toContain('Caught up');
  });

  it('shows the restarted message when firstBoot is false', () => {
    const { title } = composeBootAnnouncement({ version: '1.11.4', firstBoot: false });
    expect(title).toContain('back online');
  });
});

describe('isFirstBoot / markBooted', () => {
  it('is first boot when the marker is absent, not after markBooted', () => {
    // Unique path per run (Date.now/random are unavailable here).
    const marker = join(tmpdir(), `crewly-boot-marker-${process.pid}-${process.hrtime.bigint()}`);
    try {
      expect(isFirstBoot(marker)).toBe(true);
      markBooted(marker);
      expect(existsSync(marker)).toBe(true);
      expect(isFirstBoot(marker)).toBe(false);
    } finally {
      rmSync(marker, { force: true });
    }
  });

  it('markBooted swallows write errors (unwritable path) without throwing', () => {
    const bad = join(tmpdir(), 'crewly-no-such-dir-xyz', 'marker');
    expect(() => markBooted(bad)).not.toThrow();
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

describe('composeBootAnnouncement — machine name', () => {
  // Several instances announce into one Slack workspace, so two restarts on
  // the same version read identically and the owner could not tell which
  // machine had come back (2026-09-21).
  it('names the machine in the title and as the first body line', () => {
    const out = composeBootAnnouncement({ version: '1.20.59', deviceName: 'iriss-air.lan' });
    expect(out.title).toBe('✅ Crewly is back online (iriss-air.lan)');
    expect(out.message.split('\n')[0]).toBe('• Machine: iriss-air.lan');
    expect(out.message).toContain('• Version: 1.20.59');
  });

  it('names it on a first boot too', () => {
    const out = composeBootAnnouncement({ version: '1.20.59', firstBoot: true, deviceName: 'macbookpro.lan' });
    expect(out.title).toContain('macbookpro.lan');
  });

  it('keeps the old wording when the device has no usable name', () => {
    expect(composeBootAnnouncement({ version: '1.20.59' }).title).toBe('✅ Crewly is back online');
    expect(composeBootAnnouncement({ version: '1.20.59', deviceName: '  ' }).title).toBe('✅ Crewly is back online');
  });
});
