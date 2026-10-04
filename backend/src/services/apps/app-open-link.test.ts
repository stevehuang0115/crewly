/**
 * Tests for the open-link helpers — token redaction in every text shape
 * (Markdown, Slack mrkdwn, JSON, plain), minted-link checks, link lists
 * stripped to the documented fields.
 */

import { hasOpenLinkToken, redactOpenLinkTokens, toOpenLinkInfos, usableMintedLink } from './app-open-link.js';

const ID = '28au74d9cj';
const TOKEN = 'tok_SECRET-abc.123~x';
const URL_SIGNED = `https://apps.crewlyai.com/${ID}?k=${TOKEN}`;

describe('redactOpenLinkTokens', () => {
  it.each([
    [`📱 G · [Open app](${URL_SIGNED})`, `📱 G · [Open app](https://apps.crewlyai.com/${ID}?k=[redacted])`],
    [`<${URL_SIGNED}|Open app>`, `<https://apps.crewlyai.com/${ID}?k=[redacted]|Open app>`],
    [JSON.stringify({ url: URL_SIGNED }), JSON.stringify({ url: `https://apps.crewlyai.com/${ID}?k=[redacted]` })],
    [`see ${URL_SIGNED} now`, `see https://apps.crewlyai.com/${ID}?k=[redacted] now`],
    [`https://APPS.crewlyai.com/${ID}?x=1&k=${TOKEN}&y=2`, `https://APPS.crewlyai.com/${ID}?x=1&k=[redacted]&y=2`],
  ])('redacts %s', (input, want) => {
    expect(redactOpenLinkTokens(input)).toBe(want);
    expect(hasOpenLinkToken(input)).toBe(true);
    expect(redactOpenLinkTokens(input)).not.toContain(TOKEN);
  });

  it('leaves other text alone', () => {
    for (const t of [`https://apps.crewlyai.com/${ID}`, 'https://example.com/?k=abc', 'k=abc', '', 'plain apps.crewlyai.com mention']) {
      expect(redactOpenLinkTokens(t)).toBe(t);
      expect(hasOpenLinkToken(t)).toBe(false);
    }
  });

  it('redacts every link in a text', () => {
    const out = redactOpenLinkTokens(`${URL_SIGNED} and https://apps.crewlyai.com/xyzabcdefg?k=other`);
    expect(out).not.toMatch(/k=(?!\[redacted\])/);
  });
});

describe('usableMintedLink', () => {
  it('accepts a link to this app on the apps origin with a token', () => {
    expect(usableMintedLink(ID, { linkId: 'lnk_1', url: URL_SIGNED, expiresAt: 'e' })).toEqual({ linkId: 'lnk_1', url: URL_SIGNED, expiresAt: 'e' });
    expect(usableMintedLink(ID, { linkId: 'lnk_1', url: URL_SIGNED })).toEqual({ linkId: 'lnk_1', url: URL_SIGNED, expiresAt: '' });
  });

  it.each([
    [undefined],
    ['string'],
    [{ linkId: 'l', url: 'not a url' }],
    [{ linkId: 'l', url: `http://apps.crewlyai.com/${ID}?k=x` }],
    [{ linkId: 'l', url: `https://apps.crewlyai.com/${ID}/x?k=x` }],
    [{ linkId: 'l', url: `https://apps.crewlyai.com/${ID}?k=` }],
    [{ linkId: 'l', url: `https://apps.crewlyai.com/${ID}?k=a)b` }],
    [{ url: URL_SIGNED }],
  ])('refuses %p', (minted) => {
    expect(usableMintedLink(ID, minted)).toBeNull();
  });
});

describe('toOpenLinkInfos', () => {
  it('keeps the documented fields only', () => {
    const out = toOpenLinkInfos([
      { linkId: 'a', createdAt: 'c', expiresAt: 'e', revokedAt: null, lastUsedAt: 'u', uses: 1, active: true, createdBy: 'dev-ella', url: URL_SIGNED, token: TOKEN },
      { linkId: 'b', createdBy: { kind: 'owner' } },
      { nope: true },
      null,
    ]);
    expect(out).toEqual([
      { linkId: 'a', createdAt: 'c', expiresAt: 'e', revokedAt: null, lastUsedAt: 'u', uses: 1, active: true, createdBy: 'dev-ella' },
      { linkId: 'b', createdAt: null, expiresAt: null, revokedAt: null, lastUsedAt: null, uses: 0, active: false, createdBy: 'owner' },
    ]);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(toOpenLinkInfos({})).toEqual([]);
  });
});
