/**
 * Tests for the owner-notification channel fallback.
 *
 * @module services/slack/slack-notification-fallback.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveFallbackNotificationChannel, resolveFallbackNotificationChannels } from './slack-notification-fallback.js';

describe('resolveFallbackNotificationChannel', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-threads-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function channel(id: string, ageMs: number): void {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    const f = path.join(dir, id, '1.md');
    fs.writeFileSync(f, '#');
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(f, t, t);
  }

  it('returns null when the store is missing or empty', () => {
    expect(resolveFallbackNotificationChannel(path.join(dir, 'nope'))).toBeNull();
    expect(resolveFallbackNotificationChannel(dir)).toBeNull();
  });

  it('prefers a direct-message channel over a more recent public channel', () => {
    channel('C0PUBLIC', 1_000);
    channel('D0OWNER', 60_000);
    expect(resolveFallbackNotificationChannel(dir)).toBe('D0OWNER');
  });

  it('picks the most recently active channel within the same kind', () => {
    channel('D0OLD', 120_000);
    channel('D0NEW', 5_000);
    expect(resolveFallbackNotificationChannel(dir)).toBe('D0NEW');
  });

  it('falls back to a public channel when no DM exists and ignores empty dirs', () => {
    channel('C0TEAM', 10_000);
    fs.mkdirSync(path.join(dir, 'D0EMPTY'));
    expect(resolveFallbackNotificationChannel(dir)).toBe('C0TEAM');
  });
});

describe('resolveFallbackNotificationChannels', () => {
  it('lists DMs first, newest first, and skips excluded (agent-owned) conversations', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-threads-'));
    const mk = (id: string, ageMs: number) => {
      fs.mkdirSync(path.join(dir, id), { recursive: true });
      const f = path.join(dir, id, 't.json');
      fs.writeFileSync(f, '{}');
      const t = new Date(Date.now() - ageMs);
      fs.utimesSync(f, t, t);
    };
    mk('C-team', 1000);
    mk('D-agent', 0);
    mk('D-owner', 5000);
    expect(resolveFallbackNotificationChannels(dir, (id) => id === 'D-agent')).toEqual(['D-owner', 'C-team']);
    expect(resolveFallbackNotificationChannels(path.join(dir, 'nope'))).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
