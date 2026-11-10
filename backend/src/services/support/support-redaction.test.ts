/**
 * Tests for support redaction: secrets always scrubbed, private content
 * withheld unless the grant includes it (crewly#1558).
 */

import { SUPPORT_ACCESS_CONSTANTS } from '../../constants.js';
import { hasPrivateMark, looksPrivate, maskPersonalDetails, redactForSupport, scrubSupportSecrets } from './support-redaction.js';

/** A fake Slack-shaped token, split so secret scanners don't flag the fixture. */
const FAKE_SLACK = ['xox', 'b-1234567890-abcdefghijklmnop'].join('');

const W = SUPPORT_ACCESS_CONSTANTS.WITHHELD_PLACEHOLDER;

describe('scrubSupportSecrets', () => {
  it.each([
    ['an Anthropic key', 'use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123'],
    ['a Slack bot token', `token ${FAKE_SLACK}`, FAKE_SLACK],
    ['a GitHub token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['a JWT', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuv', 'eyJhbGciOiJIUzI1NiJ9'],
    ['a password assignment', 'password=hunter2hunter2', 'hunter2hunter2'],
    ['a token in a link', 'https://x.example.com/cb?token=abcdefgh12345678&a=1', 'abcdefgh12345678'],
    ['a long key-like run', 'key Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LmNbVcXz', 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LmNbVcXz'],
  ])('removes %s', (_label, text, secret) => {
    const out = scrubSupportSecrets(text);
    expect(out).not.toContain(secret);
  });

  it('keeps UUIDs and plain text', () => {
    const text = 'message 123e4567-e89b-12d3-a456-426614174000 was sent';
    expect(scrubSupportSecrets(text)).toBe(text);
  });
});

describe('maskPersonalDetails', () => {
  it('masks emails and phone numbers', () => {
    const out = maskPersonalDetails('mail a.b@example.com or call 415-555-0134');
    expect(out).not.toContain('a.b@example.com');
    expect(out).not.toContain('415-555-0134');
  });
});

describe('hasPrivateMark', () => {
  it('reads the #969 marks', () => {
    expect(hasPrivateMark({ visibleToPeople: ['p1'] })).toBe(true);
    expect(hasPrivateMark({ visible_to_people: ['p1'] })).toBe(true);
    expect(hasPrivateMark({ privateSourcePeople: ['owner'] })).toBe(true);
    expect(hasPrivateMark({ visibleToPeople: [] })).toBe(false);
    expect(hasPrivateMark(undefined)).toBe(false);
    expect(hasPrivateMark({ other: 1 })).toBe(false);
  });
});

describe('looksPrivate', () => {
  it('flags children data, child mentions and connector content', () => {
    expect(looksPrivate('Amy (7 years old) is allergic to nuts, her parent is at 415-555-0134')).toBe(true);
    expect(looksPrivate('The students finished the robot unit')).toBe(true);
    expect(looksPrivate('From your Gmail inbox: the invoice thread')).toBe(true);
    expect(looksPrivate('The agent restarted after a timeout')).toBe(false);
  });
});

describe('redactForSupport', () => {
  it('withholds a marked message unless the grant includes private content', () => {
    expect(redactForSupport('Summary of the Drive doc', { includePrivate: false, metadata: { privateSourcePeople: ['owner'] } })).toEqual({ text: W, withheld: true });
    expect(redactForSupport('Summary', { includePrivate: true, metadata: { privateSourcePeople: ['owner'] } })).toEqual({ text: 'Summary', withheld: false });
  });

  it("withholds children's data by default and shows it with includePrivate", () => {
    const text = 'Leo, 8 years old, birthday on Friday';
    expect(redactForSupport(text, { includePrivate: false })).toEqual({ text: W, withheld: true });
    expect(redactForSupport(text, { includePrivate: true }).text).toContain('Leo');
  });

  it('scrubs secrets even with includePrivate', () => {
    const out = redactForSupport('here: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123', { includePrivate: true });
    expect(out.withheld).toBe(false);
    expect(out.text).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
  });

  it('masks contact details in plain text by default, not with includePrivate', () => {
    expect(redactForSupport('write to ops@acme.io', { includePrivate: false }).text).not.toContain('ops@acme.io');
    expect(redactForSupport('write to ops@acme.io', { includePrivate: true }).text).toContain('ops@acme.io');
  });

  it('cuts long texts', () => {
    const out = redactForSupport('a '.repeat(100), { includePrivate: true, maxChars: 10 });
    expect(out.text).toHaveLength(11);
  });
});
