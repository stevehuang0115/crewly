import {
  compareVersions,
  pickDefaultPrimary,
  primaryTakenByAnother,
  renderRequestScope,
  requestScopeOf,
  toAccountInstance,
  type AccountInstance,
} from './slack-request-scope.js';

const inst = (over: Partial<AccountInstance> & { instanceId: string }): AccountInstance => ({
  deviceName: over.instanceId,
  primary: false,
  live: true,
  crewlyVersion: '1.40.0',
  teams: [],
  ...over,
});

describe('toAccountInstance', () => {
  it('keeps team names and drops the orchestrator pseudo-team named after the machine', () => {
    const got = toAccountInstance({
      instanceId: 'a',
      deviceName: 'mac-mini.lan',
      primary: false,
      live: true,
      crewlyVersion: '1.39.2',
      teams: [{ name: 'CE' }, { name: 'mac-mini.lan' }, { teamId: 'x' }],
    });
    expect(got).toEqual({ instanceId: 'a', deviceName: 'mac-mini.lan', primary: false, live: true, crewlyVersion: '1.39.2', teams: ['CE'] });
  });

  it('rejects an entry without an id', () => {
    expect(toAccountInstance({ deviceName: 'x' })).toBeNull();
    expect(toAccountInstance(null)).toBeNull();
  });
});

describe('compareVersions', () => {
  it('compares numerically, not as text', () => {
    expect(compareVersions('1.39.2', '1.40.0')).toBeLessThan(0);
    expect(compareVersions('1.100.0', '1.40.0')).toBeGreaterThan(0);
    expect(compareVersions('1.40.0', '1.40.0')).toBe(0);
  });
});

describe('pickDefaultPrimary', () => {
  it('picks the live machine with the most teams', () => {
    const list = [inst({ instanceId: 'b', teams: ['x'] }), inst({ instanceId: 'a', teams: ['x', 'y'] }), inst({ instanceId: 'c' })];
    expect(pickDefaultPrimary(list, '1.40.0')).toBe('a');
  });

  it('breaks a tie by instance id, the same on every machine', () => {
    const list = [inst({ instanceId: 'b', teams: ['x'] }), inst({ instanceId: 'a', teams: ['y'] })];
    expect(pickDefaultPrimary(list, '1.40.0')).toBe('a');
    expect(pickDefaultPrimary([...list].reverse(), '1.40.0')).toBe('a');
  });

  it('picks nothing while a live primary exists', () => {
    expect(pickDefaultPrimary([inst({ instanceId: 'a', primary: true }), inst({ instanceId: 'b', teams: ['x'] })], '1.40.0')).toBeNull();
  });

  it('replaces a primary that is offline', () => {
    expect(pickDefaultPrimary([inst({ instanceId: 'a', primary: true, live: false }), inst({ instanceId: 'b' })], '1.40.0')).toBe('b');
  });

  it('skips machines too old to claim the flag, and offline ones', () => {
    const list = [
      inst({ instanceId: 'old', crewlyVersion: '1.39.0', teams: ['a', 'b', 'c'] }),
      inst({ instanceId: 'off', live: false, teams: ['a', 'b'] }),
      inst({ instanceId: 'ok', teams: ['a'] }),
    ];
    expect(pickDefaultPrimary(list, '1.40.0')).toBe('ok');
    expect(pickDefaultPrimary([list[0]], '1.40.0')).toBeNull();
  });
});

describe('primaryTakenByAnother', () => {
  it('is true when Cloud lists another live machine as primary and not this one', () => {
    expect(primaryTakenByAnother([inst({ instanceId: 'me' }), inst({ instanceId: 'x', primary: true })], 'me')).toBe(true);
  });

  it('is false when this machine is still the primary, unknown, or the other is offline', () => {
    expect(primaryTakenByAnother([inst({ instanceId: 'me', primary: true })], 'me')).toBe(false);
    expect(primaryTakenByAnother([inst({ instanceId: 'x', primary: true })], 'me')).toBe(false);
    expect(primaryTakenByAnother([inst({ instanceId: 'me' }), inst({ instanceId: 'x', primary: true, live: false })], 'me')).toBe(false);
  });
});

describe('requestScopeOf', () => {
  it('a DM without an agent bot is account-wide; with one it is this machine', () => {
    expect(requestScopeOf({ channelId: 'D123' })).toBe('account');
    expect(requestScopeOf({ channelId: 'D123', agentSession: 'crewly-orc' })).toBe('machine');
  });

  it('a channel message has no scope', () => {
    expect(requestScopeOf({ channelId: 'C123' })).toBeNull();
  });
});

describe('renderRequestScope', () => {
  const self = { deviceName: 'mac-mini.lan', instanceId: 'mini' };
  const list = [
    inst({ instanceId: 'mini', deviceName: 'mac-mini.lan' }),
    inst({ instanceId: 'mbp', deviceName: 'macbookpro.lan', teams: ['Stevesprompt', 'CE'] }),
    inst({ instanceId: 'win', deviceName: 'DESKTOP-RIG1SOO', live: false, teams: [] }),
  ];

  it('an account-wide request lists the other machines with their teams and the hand-off', () => {
    const note = renderRequestScope('account', self, list);
    expect(note).toContain('account-wide');
    expect(note).toContain('- macbookpro.lan: Stevesprompt, CE');
    expect(note).toContain('- DESKTOP-RIG1SOO (offline): no teams yet');
    expect(note).not.toContain('- mac-mini.lan');
    expect(note).toContain('message-colleague');
  });

  it('says so when no other machine is known', () => {
    expect(renderRequestScope('account', self, [])).toContain('No other machine');
  });

  it('a machine request names this machine and lists nothing else', () => {
    const note = renderRequestScope('machine', self, list);
    expect(note).toContain('this machine');
    expect(note).toContain('mac-mini.lan');
    expect(note).not.toContain('macbookpro.lan');
  });
});
