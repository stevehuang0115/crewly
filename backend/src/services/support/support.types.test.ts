/**
 * Tests for the support envelope guards and path checks (crewly#1558).
 */

import {
  isSupportApiPath,
  isSupportGrantEnvelope,
  parseSupportGrantEnvelope,
  roleAllowsMethod,
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
    expect(parseSupportGrantEnvelope({ ...ENVELOPE, extra: 'x', role: 'admin' })).toEqual({ ...ENVELOPE, role: 'admin' });
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
