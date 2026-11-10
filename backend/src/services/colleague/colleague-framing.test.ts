import { formatColleagueMessage, colleagueNotFoundHint, colleagueLabel, describeCandidates, COLLEAGUE_HEADER_PREFIX } from './colleague-framing.js';
import type { DirectoryEntry } from '../slack/slack-directory.service.js';

function entry(over: Partial<DirectoryEntry>): DirectoryEntry {
  return {
    name: 'X', mention: null, botUserId: null, agentSession: 'x', team: 'T', machine: 'this machine',
    source: 'this-machine', inChannel: false, kind: 'agent', ...over,
  };
}

describe('formatColleagueMessage', () => {
  const text = formatColleagueMessage(
    { instanceId: 'dev-air', deviceName: 'iriss-air.lan', session: 'steamfun-fern', name: 'Fern', team: 'SteamFun' },
    'msg-1',
    'Can you send me the Flopost deck?',
  );

  it('names the sender, team and machine and how to reply', () => {
    expect(text.startsWith(`${COLLEAGUE_HEADER_PREFIX}Fern (team SteamFun, machine iriss-air.lan)`)).toBe(true);
    expect(text).toContain('message-colleague --to Fern --reply-to msg-1');
  });

  it('says it is information, not the owner', () => {
    expect(text).toContain('not the owner');
    expect(text).toContain("not the owner's approval");
  });

  it('puts the message text after the header, unchanged', () => {
    expect(text.split('\n').slice(1).join('\n')).toBe('Can you send me the Flopost deck?');
  });

  it('leaves out the team when the sender has none', () => {
    const t = formatColleagueMessage({ instanceId: 'd', deviceName: 'mac', session: 's', name: 'Orc' }, 'm', 'hi');
    expect(t).toContain('Orc (machine mac)');
  });
});

describe('colleagueNotFoundHint', () => {
  const pia = entry({ name: 'Pia', agentSession: 'flopost-pia', team: 'Flopost', machine: 'mac-mini', source: 'this-account' });

  it('tells where the colleague is and how to reach them', () => {
    expect(colleagueNotFoundHint('Pia', [pia], 'steamfun-fern')).toBe(
      'Pia is on the machine "mac-mini", team Flopost — use message-colleague --to Pia',
    );
  });

  it('lists the candidates when the name is not unique', () => {
    const other = entry({ name: 'Pia', agentSession: 'x-pia', team: 'Other', machine: 'air', source: 'this-account' });
    const hint = colleagueNotFoundHint('Pia', [pia, other]);
    expect(hint).toContain('More than one colleague matches "Pia"');
    expect(hint).toContain('[flopost-pia]');
    expect(hint).toContain('[x-pia]');
  });

  it('is null when nobody of the account has that name', () => {
    expect(colleagueNotFoundHint('Nobody', [pia])).toBeNull();
  });
});

describe('labels', () => {
  it('builds a compact label', () => {
    expect(colleagueLabel('Fern', 'SteamFun', 'iriss-air.lan')).toBe('Fern (SteamFun, iriss-air.lan)');
    expect(colleagueLabel('Fern', null, null)).toBe('Fern');
    expect(describeCandidates([{ name: 'Fern', team: 'S', machine: 'm', session: null }])).toBe('Fern (S, m)');
  });
});
