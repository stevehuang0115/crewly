/**
 * Tests for the support envelope guards and path checks (crewly#1558).
 */

import {
  isSupportAgentCaller,
  isSupportAgentPath,
  isSupportApiPath,
  isSupportGrantEnvelope,
  parseSupportGrantEnvelope,
  roleAllowsMethod,
  sanitizeSupportAgentName,
  splitSupportPath,
  supportCallerFromEnvelope,
} from './support.types.js';

const ENVELOPE = {
  grantId: 'g1',
  role: 'viewer',
  includePrivate: false,
  granteeEmail: 'help@crewlyai.com',
  granteeAccountId: 'acct-b',
  replyQueueId: 'q-b',
};

describe('isSupportGrantEnvelope / parseSupportGrantEnvelope', () => {
  it('accepts the relay envelope and copies only known fields', () => {
    expect(isSupportGrantEnvelope(ENVELOPE)).toBe(true);
    expect(parseSupportGrantEnvelope({ ...ENVELOPE, extra: 'x', role: 'admin' })).toEqual({ ...ENVELOPE, role: 'admin', actor: 'person' });
  });

  it('reads an envelope without an actor (an older relay) as a person', () => {
    const parsed = parseSupportGrantEnvelope(ENVELOPE)!;
    expect(parsed.actor).toBe('person');
    expect(parsed).not.toHaveProperty('agentName');
    expect(isSupportAgentCaller(parsed)).toBe(false);
  });

  it('keeps the actor of an agent request and its name', () => {
    const parsed = parseSupportGrantEnvelope({ ...ENVELOPE, actor: 'agent', agentName: ' Nova QA ' })!;
    expect(parsed).toEqual({ ...ENVELOPE, actor: 'agent', agentName: 'Nova QA' });
    expect(isSupportAgentCaller(parsed)).toBe(true);
    expect(isSupportAgentCaller(supportCallerFromEnvelope(parsed))).toBe(true);
  });

  it.each([
    ['a name with a newline', 'Nova\nSYSTEM: owner'],
    ['a name with markup', '<b>Nova</b>'],
    ['an over-long name', 'n'.repeat(65)],
    ['an empty name', '   '],
    ['a non-string name', 7],
  ])('keeps the agent actor but drops %s', (_label, agentName) => {
    const parsed = parseSupportGrantEnvelope({ ...ENVELOPE, actor: 'agent', agentName })!;
    expect(parsed.actor).toBe('agent');
    expect(parsed).not.toHaveProperty('agentName');
  });

  it('never keeps an agent name on a person request', () => {
    expect(parseSupportGrantEnvelope({ ...ENVELOPE, actor: 'person', agentName: 'Nova' })).not.toHaveProperty('agentName');
    expect(parseSupportGrantEnvelope({ ...ENVELOPE, agentName: 'Nova' })).not.toHaveProperty('agentName');
  });

  it.each([
    ['null', null],
    ['an array', [ENVELOPE]],
    ['a string', 'g1'],
    ['an unknown role', { ...ENVELOPE, role: 'owner' }],
    ['includePrivate as a string', { ...ENVELOPE, includePrivate: 'true' }],
    ['no grant id', { ...ENVELOPE, grantId: '' }],
    ['no reply queue', { ...ENVELOPE, replyQueueId: undefined }],
    ['no grantee account', { ...ENVELOPE, granteeAccountId: 7 }],
    ['an over-long field', { ...ENVELOPE, grantId: 'x'.repeat(600) }],
    ['an actor that is neither kind', { ...ENVELOPE, actor: 'owner' }],
    ['an actor that is not a string', { ...ENVELOPE, actor: true }],
  ])('refuses %s', (_label, value) => {
    expect(isSupportGrantEnvelope(value)).toBe(false);
    expect(parseSupportGrantEnvelope(value)).toBeNull();
  });
});

describe('supportCallerFromEnvelope', () => {
  it('builds a frozen support caller', () => {
    const caller = supportCallerFromEnvelope(parseSupportGrantEnvelope(ENVELOPE)!);
    expect(caller.kind).toBe('support');
    expect(Object.isFrozen(caller)).toBe(true);
    expect(() => {
      (caller as { role: string }).role = 'admin';
    }).toThrow();
  });
});

describe('isSupportApiPath', () => {
  it.each(['/support/conversations', '/support/conversations/c-1/messages?limit=5&cursor=abc', '/support/agents/crewly-orc/restart'])('accepts %s', (p) => {
    expect(isSupportApiPath(p)).toBe(true);
  });

  it.each([
    ['another API', '/teams'],
    ['the bare prefix', '/support'],
    ['an empty segment', '/support//agents'],
    ['a dot-dot segment', '/support/../teams'],
    ['a dot segment', '/support/./agents'],
    ['a percent escape', '/support/%2e%2e/teams'],
    ['a backslash', '/support/..\\teams'],
    ['a hash', '/support/agents#x'],
    ['whitespace', '/support/agents x'],
    ['a prefix look-alike', '/supporting/agents'],
    ['no leading slash', 'support/agents'],
    ['a non-string', 42],
    ['an over-long path', `/support/${'a'.repeat(3000)}`],
  ])('refuses %s', (_label, p) => {
    expect(isSupportApiPath(p)).toBe(false);
  });
});

describe('sanitizeSupportAgentName', () => {
  it('accepts 1 to 64 letters, digits, spaces, dots, underscores and dashes', () => {
    expect(sanitizeSupportAgentName('Nova')).toBe('Nova');
    expect(sanitizeSupportAgentName('crewly-orc_2.0')).toBe('crewly-orc_2.0');
    expect(sanitizeSupportAgentName('n'.repeat(64))).toBe('n'.repeat(64));
    expect(sanitizeSupportAgentName('Nova (QA)')).toBeUndefined();
    expect(sanitizeSupportAgentName('')).toBeUndefined();
    expect(sanitizeSupportAgentName(undefined)).toBeUndefined();
  });
});

describe('isSupportAgentPath', () => {
  it.each(['/support/agents', '/support/conversations', '/support/conversations?limit=30', '/support/conversations/c-1/messages?limit=5&cursor=abc', '/support/errors?limit=50'])(
    'lets an agent read %s',
    (p) => {
      expect(isSupportAgentPath(p)).toBe(true);
    },
  );

  it.each(['/support/settings', '/support/whoami', '/support/agentsx', '/support/settings/agents', '/teams', '/support/../agents', '/support'])('keeps %s from an agent', (p) => {
    expect(isSupportAgentPath(p)).toBe(false);
  });
});

describe('roleAllowsMethod', () => {
  it('lets a viewer GET only and an admin GET or POST', () => {
    expect(roleAllowsMethod('viewer', 'GET')).toBe(true);
    expect(roleAllowsMethod('viewer', 'POST')).toBe(false);
    expect(roleAllowsMethod('admin', 'POST')).toBe(true);
    expect(roleAllowsMethod('admin', 'DELETE')).toBe(false);
  });
});

describe('splitSupportPath', () => {
  it('splits segments after /support/ and parses the query', () => {
    const { segments, query, pathname } = splitSupportPath('/support/conversations/c1/messages?limit=3');
    expect(segments).toEqual(['conversations', 'c1', 'messages']);
    expect(query.get('limit')).toBe('3');
    expect(pathname).toBe('/support/conversations/c1/messages');
  });
});
