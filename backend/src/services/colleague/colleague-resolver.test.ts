import { resolveColleague, agentEntries } from './colleague-resolver.js';
import type { DirectoryEntry } from '../slack/slack-directory.service.js';

function entry(over: Partial<DirectoryEntry>): DirectoryEntry {
  return {
    name: 'X', mention: null, botUserId: null, agentSession: 'x-session', team: 'T', machine: 'this machine',
    source: 'this-machine', inChannel: false, kind: 'agent', ...over,
  };
}

const pia = entry({ name: 'Pia', agentSession: 'flopost-pia', team: 'Flopost', machine: 'this machine', instanceId: 'dev-mac' });
const fern = entry({ name: 'Fern', agentSession: 'steamfun-fern', team: 'SteamFun', machine: 'iriss-air.lan', source: 'this-account', instanceId: 'dev-air' });
const human = entry({ name: 'Steve', agentSession: null, kind: 'human', team: null, machine: null, source: 'channel' });
const bot = entry({ name: 'OtherBot', agentSession: null, kind: 'bot', team: null, machine: null, source: 'channel' });
const dir = [pia, fern, human, bot];

describe('resolveColleague', () => {
  it('finds a colleague by display name, case-insensitively and ignoring a leading @', () => {
    expect(resolveColleague(dir, 'pia', { fromSession: 'steamfun-fern' })).toEqual({ kind: 'found', entry: pia });
    expect(resolveColleague(dir, '@Pia', { fromSession: 'steamfun-fern' })).toEqual({ kind: 'found', entry: pia });
  });

  it('finds a colleague by agent session', () => {
    expect(resolveColleague(dir, 'flopost-pia')).toEqual({ kind: 'found', entry: pia });
  });

  it('never resolves people or bots of other systems', () => {
    expect(resolveColleague(dir, 'Steve').kind).toBe('none');
    expect(resolveColleague(dir, 'OtherBot').kind).toBe('none');
    expect(agentEntries(dir)).toEqual([pia, fern]);
  });

  it('reports the asker itself instead of messaging itself', () => {
    expect(resolveColleague(dir, 'Fern', { fromSession: 'steamfun-fern' })).toEqual({ kind: 'self' });
  });

  it('does not guess between two colleagues with the same name, and team narrows it', () => {
    const pia2 = entry({ name: 'Pia', agentSession: 'other-pia', team: 'Other', machine: 'iriss-air.lan', source: 'this-account' });
    const both = [pia, pia2, fern];
    const r = resolveColleague(both, 'Pia', { fromSession: 'steamfun-fern' });
    expect(r.kind).toBe('ambiguous');
    expect(r.kind === 'ambiguous' && r.candidates.map((c) => c.session)).toEqual(['flopost-pia', 'other-pia']);
    expect(resolveColleague(both, 'Pia', { fromSession: 'steamfun-fern', team: 'other' })).toEqual({ kind: 'found', entry: pia2 });
  });

  it('treats the same colleague listed twice as one', () => {
    expect(resolveColleague([pia, { ...pia }], 'Pia')).toEqual({ kind: 'found', entry: pia });
  });

  it('suggests close names when nothing matches', () => {
    const r = resolveColleague(dir, 'Pi', { fromSession: 'steamfun-fern' });
    expect(r).toEqual({ kind: 'none', candidates: [{ name: 'Pia', team: 'Flopost', machine: 'this machine', session: 'flopost-pia' }] });
  });

  it('lists who exists for an empty query', () => {
    const r = resolveColleague(dir, '  ', { fromSession: 'steamfun-fern' });
    expect(r.kind === 'none' && r.candidates.map((c) => c.name)).toEqual(['Pia']);
  });
});
