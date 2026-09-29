/**
 * Tests for owner receipt boot wiring (#828).
 */

import type { Team } from '../../../types/index.js';
import { agentNameIndexOf, createSlackOwnerSender, startOwnerReceiptSchedule, teamIndexOf, teamLeadIndexOf, type ReceiptSlackApi } from './owner-receipt.boot.js';

/**
 * A fake Slack.
 *
 * @param opts - Owner id, connected, DM failure
 * @returns Fake and its calls
 */
function slack(opts: { ownerId?: string | null; connected?: boolean; dmFails?: boolean } = {}) {
  const calls: { dm: Array<{ channelId: string; text: string; unfurlLinks?: boolean }>; notifications: string[] } = { dm: [], notifications: [] };
  const api: ReceiptSlackApi = {
    isConnected: () => opts.connected ?? true,
    getOwnerUserId: () => (opts.ownerId === undefined ? 'U-OWNER' : opts.ownerId),
    openDirectMessage: async (id) => {
      if (opts.dmFails) throw new Error('no im:write');
      return `D-${id}`;
    },
    sendMessage: async (m) => {
      calls.dm.push({ channelId: m.channelId, text: m.text, unfurlLinks: m.unfurlLinks });
      return 'ts';
    },
    sendNotification: async (n) => {
      calls.notifications.push(n.message);
    },
  };
  return { api, calls };
}

describe('createSlackOwnerSender', () => {
  it('DMs the owner the mrkdwn as is — links survive, previews off', async () => {
    const { api, calls } = slack();
    const ok = await createSlackOwnerSender(() => api)('✅ PR → <https://github.com/o/r/pull/1|#1>');
    expect(ok).toBe(true);
    expect(calls.dm).toEqual([{ channelId: 'D-U-OWNER', text: '✅ PR → <https://github.com/o/r/pull/1|#1>', unfurlLinks: false }]);
  });

  it('falls back to the owner-notification path when the owner id is unknown or the DM fails', async () => {
    for (const opts of [{ ownerId: null }, { dmFails: true }]) {
      const { api, calls } = slack(opts);
      expect(await createSlackOwnerSender(() => api)('hi')).toBe(true);
      expect(calls.notifications).toEqual(['hi']);
    }
  });

  it('reports false when Slack is not connected or not wired', async () => {
    expect(await createSlackOwnerSender(() => slack({ connected: false }).api)('x')).toBe(false);
    expect(await createSlackOwnerSender(() => null)('x')).toBe(false);
  });
});

describe('teamIndexOf', () => {
  it('maps each member session to its team', () => {
    const teams = [
      { name: 'Think Tank', members: [{ sessionName: 'atlas' }, { sessionName: 'kai' }] },
      { name: 'CE', members: [{ sessionName: 'nova' }, { sessionName: '' }] },
    ] as unknown as Team[];
    expect([...teamIndexOf(teams).entries()]).toEqual([
      ['atlas', 'Think Tank'],
      ['kai', 'Think Tank'],
      ['nova', 'CE'],
    ]);
  });
});

describe('teamLeadIndexOf (Ava\'s reference: CE（Owen）)', () => {
  it('maps a team name to its leader\'s display name, preferring leaderIds[0] over the deprecated leaderId', () => {
    const teams = [
      { name: 'Think Tank', leaderIds: ['m-atlas'], members: [{ id: 'm-atlas', name: 'Atlas' }, { id: 'm-kai', name: 'Kai' }] },
      { name: 'CE', leaderId: 'm-owen', members: [{ id: 'm-owen', name: 'Owen' }, { id: 'm-nova', name: 'Nova' }] },
      { name: 'CE-legacy', leaderIds: ['m-owen'], leaderId: 'm-nova', members: [{ id: 'm-owen', name: 'Owen' }, { id: 'm-nova', name: 'Nova' }] },
    ] as unknown as Team[];
    expect([...teamLeadIndexOf(teams).entries()]).toEqual([
      ['Think Tank', 'Atlas'],
      ['CE', 'Owen'],
      ['CE-legacy', 'Owen'], // leaderIds[0] wins over the deprecated leaderId
    ]);
  });

  it('a team with no leader assigned is absent from the index, not mapped to null', () => {
    const teams = [{ name: 'Flat Team', members: [{ id: 'm-1', name: 'Solo' }] }] as unknown as Team[];
    const index = teamLeadIndexOf(teams);
    expect(index.has('Flat Team')).toBe(false);
    expect(index.get('Flat Team')).toBeUndefined();
  });

  it('a leaderId that names nobody on the team is absent from the index (no orphan name)', () => {
    const teams = [{ name: 'Broken', leaderId: 'no-such-member', members: [{ id: 'm-1', name: 'Solo' }] }] as unknown as Team[];
    expect(teamLeadIndexOf(teams).has('Broken')).toBe(false);
  });
});

describe('agentNameIndexOf', () => {
  it('maps each member session to its display name', () => {
    const teams = [
      { name: 'Think Tank', members: [{ sessionName: 'think-tank-atlas', name: 'Atlas' }, { sessionName: '', name: 'Nobody' }] },
      { name: 'CE', members: [{ sessionName: 'ce-owen', name: 'Owen' }] },
    ] as unknown as Team[];
    expect([...agentNameIndexOf(teams)]).toEqual([
      ['think-tank-atlas', 'Atlas'],
      ['ce-owen', 'Owen'],
    ]);
  });
});

describe('startOwnerReceiptSchedule', () => {
  it('ticks on the interval, swallows failures, and stops', async () => {
    let fire: () => void = () => undefined;
    let cleared = false;
    let ticks = 0;
    const stop = startOwnerReceiptSchedule(
      { tick: async () => { ticks += 1; if (ticks === 2) throw new Error('boom'); return null; } },
      { intervalMs: 5, setIntervalFn: (fn) => { fire = fn; return 'h'; }, clearIntervalFn: () => { cleared = true; } },
    );
    fire();
    fire();
    await new Promise((r) => setImmediate(r));
    expect(ticks).toBe(2);
    stop();
    expect(cleared).toBe(true);
  });
});
