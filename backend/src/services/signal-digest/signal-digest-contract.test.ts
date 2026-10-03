/**
 * Tests for the signal digest contract: proposal validation and the site's
 * history (what Do / Skip block, and for how long).
 *
 * @module services/signal-digest/signal-digest-contract.test
 */

import { SIGNAL_DIGEST_CONSTANTS } from '../../constants.js';
import type { SignalDigest, SignalDigestItem } from '../../types/signal-digest.types.js';
import { SignalDigestError, blockedLines, normalizeKey, parseSourceStatuses, siteHistory, validateSignalDigest, validateSite } from './signal-digest-contract.js';

const action = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  source: 'gsc',
  signal: `signal for ${key}`,
  proposal: `do ${key}`,
  expectedEffect: '+10 clicks a week',
  effort: 'S — 1 h',
  ...extra,
});

const DAY = 24 * 60 * 60 * 1000;

const item = (n: number, key: string, status: SignalDigestItem['status'], answeredAt?: string, extra: Partial<SignalDigestItem> = {}): SignalDigestItem => ({
  ...(action(key) as unknown as SignalDigestItem),
  source: 'gsc',
  n,
  status,
  ...(answeredAt ? { answeredAt } : {}),
  ...extra,
});

const digest = (id: string, site: string, createdAt: string, items: SignalDigestItem[]): SignalDigest => ({
  id,
  site,
  asker: 'tl-owen',
  items,
  createdAt,
  updatedAt: createdAt,
});

describe('validateSignalDigest', () => {
  it('accepts 3–5 actions, trims text, keeps an optional metric and project', () => {
    const out = validateSignalDigest({
      site: ' visa.careerengine.us ',
      project: ' CE site ',
      items: [action('a', { metric: ' GSC clicks ', signal: '  two\n lines ' }), action('b', { source: 'GA4' }), action('c')],
    });
    expect(out.site).toBe('visa.careerengine.us');
    expect(out.project).toBe('CE site');
    expect(out.items).toHaveLength(3);
    expect(out.items[0]).toMatchObject({ key: 'a', signal: 'two lines', metric: 'GSC clicks' });
    expect(out.items[1].source).toBe('ga4');
    expect(out.items[2]).not.toHaveProperty('metric');
  });

  it('rejects a missing site, too few / too many actions, and a bad source', () => {
    expect(() => validateSignalDigest({ items: [action('a'), action('b'), action('c')] })).toThrow(/"site" is required/);
    expect(() => validateSignalDigest({ site: 's', items: [action('a'), action('b')] })).toThrow(/give 3–5 actions \(got 2\)/);
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => action(k));
    expect(() => validateSignalDigest({ site: 's', items: six })).toThrow(/got 6/);
    expect(() => validateSignalDigest({ site: 's', items: [action('a', { source: 'twitter' }), action('b'), action('c')] })).toThrow(/"source" must be one of/);
  });

  it('names the item and field that is missing or too long', () => {
    expect(() => validateSignalDigest({ site: 's', items: [action('a'), action('b', { effort: '' }), action('c')] })).toThrow(/item 2: "effort" is required/);
    const long = 'x'.repeat(SIGNAL_DIGEST_CONSTANTS.PROPOSAL_MAX_CHARS + 1);
    expect(() => validateSignalDigest({ site: 's', items: [action('a', { proposal: long }), action('b'), action('c')] })).toThrow(/item 1: "proposal" is too long/);
    expect(() => validateSignalDigest({ site: 's', items: ['nope', action('b'), action('c')] })).toThrow(/item 1 must be an object/);
  });

  it('rejects the same key twice, ignoring case and spacing', () => {
    expect(() => validateSignalDigest({ site: 's', items: [action('GSC:Low  CTR:x'), action('gsc:low ctr:x'), action('c')] })).toThrow(/used twice/);
  });

  it('keeps an experiment spec (strings only) and an absolute seo-ops config', () => {
    const out = validateSignalDigest({
      site: 's',
      config: '/abs/ce.json',
      items: [action('a', { experiment: { source: 'gsc', measure: 'ctr', query: ' h1b fee ', page: 'https://x/h', extra: 1, event: 7 } }), action('b'), action('c')],
    });
    expect(out.config).toBe('/abs/ce.json');
    expect(out.items[0].experiment).toEqual({ source: 'gsc', measure: 'ctr', query: 'h1b fee', page: 'https://x/h' });
    expect(out.items[1]).not.toHaveProperty('experiment');
    expect(() => validateSignalDigest({ site: 's', config: 'rel/ce.json', items: [action('a'), action('b'), action('c')] })).toThrow(/absolute path/);
    expect(() => validateSignalDigest({ site: 's', items: [action('a', { experiment: { source: 'bing', measure: 'clicks' } }), action('b'), action('c')] })).toThrow(/item 1: experiment.source/);
    expect(() => validateSignalDigest({ site: 's', items: [action('a'), action('b', { experiment: { source: 'ga4' } }), action('c')] })).toThrow(/item 2: experiment.measure is required/);
    expect(() => validateSignalDigest({ site: 's', items: [action('a', { experiment: 'clicks' }), action('b'), action('c')] })).toThrow(/must be an object/);
  });

  it('errors carry HTTP 400', () => {
    try {
      validateSignalDigest({});
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SignalDigestError);
      expect((err as SignalDigestError).status).toBe(400);
    }
  });
});

describe('siteHistory / blockedLines', () => {
  const now = new Date('2026-10-03T12:00:00Z');
  const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();

  it('Do blocks for 90 days, Skip for 30; expired blocks nothing; other sites are ignored', () => {
    const digests = [
      digest('SD-1', 'visa.careerengine.us', ago(100), [item(1, 'old-do', 'do', ago(95)), item(2, 'old-skip', 'skip', ago(95))]),
      digest('SD-2', 'visa.careerengine.us', ago(40), [item(1, 'do-40', 'do', ago(40), { ticketId: 'CE-9' }), item(2, 'skip-40', 'skip', ago(40)), item(3, 'gone', 'expired', ago(39))]),
      digest('SD-3', 'Visa.CareerEngine.us', ago(1), [item(1, 'skip-1', 'skip', ago(1)), item(2, 'waiting', 'open')]),
      digest('SD-4', 'other.site', ago(1), [item(1, 'elsewhere', 'do', ago(1))]),
    ];
    const history = siteHistory(digests, 'visa.careerengine.us', now);
    const byKey = Object.fromEntries(history.map((h) => [h.key, h]));
    expect(Object.keys(byKey).sort()).toEqual(['do-40', 'skip-1', 'waiting']);
    expect(byKey['do-40']).toMatchObject({ status: 'do', digestId: 'SD-2', ticketId: 'CE-9', blockedUntil: new Date(Date.parse(ago(40)) + 90 * DAY).toISOString() });
    expect(byKey['skip-1']).toMatchObject({ status: 'skip', blockedUntil: new Date(Date.parse(ago(1)) + 30 * DAY).toISOString() });
    expect(byKey.waiting).toMatchObject({ status: 'open', digestId: 'SD-3' });
    expect(byKey.waiting).not.toHaveProperty('blockedUntil');
  });

  it('the newest answer for a key wins (a Do after an expired skip window)', () => {
    const digests = [
      digest('SD-1', 's', ago(60), [item(1, 'k', 'skip', ago(60))]),
      digest('SD-2', 's', ago(2), [item(1, 'K', 'do', ago(2))]),
    ];
    expect(siteHistory(digests, 's', now)).toEqual([expect.objectContaining({ key: 'K', status: 'do', digestId: 'SD-2' })]);
  });

  it('blockedLines explains each blocked action and ignores the rest', () => {
    const history = siteHistory(
      [digest('SD-2', 's', ago(3), [item(1, 'tried', 'do', ago(3), { ticketId: 'CE-1' }), item(2, 'nah', 'skip', ago(3)), item(3, 'pending', 'open')])],
      's',
      now,
    );
    const lines = blockedLines(
      [action('Tried'), action('nah'), action('pending'), action('fresh')].map((a) => ({ ...a, source: 'gsc' as const })),
      history,
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/"Tried": the owner chose Do on .* \(SD-2, CE-1\)/);
    expect(lines[1]).toMatch(/"nah": the owner skipped it on .*; not before /);
    expect(lines[2]).toMatch(/"pending": still waiting on the owner in SD-2/);
  });

  it('normalizeKey ignores case and spacing', () => {
    expect(normalizeKey('  GSC:Low   CTR ')).toBe('gsc:low ctr');
  });
});

describe('parseSourceStatuses / validateSite', () => {
  it('reads collect\'s wording and the list form, sorted by name', () => {
    expect(parseSourceStatuses({ gsc: 'error: HTTP 403 forbidden', ga4: 'ok', inbox: 'not configured' })).toEqual([
      { name: 'ga4', state: 'ok' },
      { name: 'gsc', state: 'error', detail: 'HTTP 403 forbidden' },
      { name: 'inbox', state: 'not_configured' },
    ]);
    expect(parseSourceStatuses([{ name: 'Errors', state: 'error' }, { name: 'ga4', state: 'not configured' }])).toEqual([
      { name: 'errors', state: 'error', detail: 'failed' },
      { name: 'ga4', state: 'not_configured' },
    ]);
    expect(parseSourceStatuses(undefined)).toBeUndefined();
  });

  it('refuses what it cannot read', () => {
    expect(() => parseSourceStatuses('ok')).toThrow(SignalDigestError);
    expect(() => parseSourceStatuses({ gsc: 'maybe' })).toThrow('status must be');
    expect(() => parseSourceStatuses({ gsc: 3 })).toThrow('status must be');
    expect(() => parseSourceStatuses([{ state: 'ok' }])).toThrow('needs a name');
    expect(() => parseSourceStatuses([{ name: 'gsc', state: 'down' }])).toThrow('ok, not_configured or error');
    const many = Object.fromEntries(Array.from({ length: SIGNAL_DIGEST_CONSTANTS.MAX_SOURCES + 1 }, (_, i) => [`s${i}`, 'ok']));
    expect(() => parseSourceStatuses(many)).toThrow('too many');
  });

  it('validateSignalDigest carries sources; validateSite checks the site', () => {
    const item = (key: string) => ({ key, source: 'gsc', signal: 's', proposal: 'p', expectedEffect: 'e', effort: 'S' });
    expect(validateSignalDigest({ site: 's', items: [item('a'), item('b'), item('c')], sources: { gsc: 'ok' } }).sources).toEqual([{ name: 'gsc', state: 'ok' }]);
    expect(validateSite('  a  b ')).toBe('a b');
    expect(() => validateSite('')).toThrow('"site" is required');
    expect(() => validateSite('x'.repeat(SIGNAL_DIGEST_CONSTANTS.SITE_MAX_CHARS + 1))).toThrow('too long');
  });
});
