/**
 * Tests for role-knowledge recall-eligibility helpers.
 *
 * Coverage:
 * - lazyMigrateEntry: legacy → v3 defaults; learnedFrom → evidence
 *   coercion; idempotence on already-migrated entries.
 * - isExpired: present/absent/invalid TTL.
 * - isAutoInjectEligible: every branch of the spec §183-187 rule table,
 *   including the confidence-floor override.
 * - isHiddenFromDefaultRecall: superseded + expired + happy path.
 *
 * @module services/memory/role-knowledge-eligibility.test
 */

import {
  AUTO_INJECT_CONFIDENCE_MIN,
  AUTO_INJECT_IMPORTANCE_MIN,
  DEFAULT_CONFIDENCE,
  DEFAULT_IMPORTANCE,
  NEVER_AUTO_INJECT_CONFIDENCE,
  isAutoInjectEligible,
  isExpired,
  isHiddenFromDefaultRecall,
  lazyMigrateEntry,
} from './role-knowledge-eligibility.js';
import type { RoleKnowledgeEntry } from '../../types/memory.types.js';

const NOW = new Date('2026-05-04T12:00:00Z');
const PAST = '2026-04-01T00:00:00Z';
const FUTURE = '2026-06-01T00:00:00Z';

/**
 * Construct a baseline v3 entry for tests.
 */
function makeEntry(overrides: Partial<RoleKnowledgeEntry> = {}): RoleKnowledgeEntry {
  return {
    id: 'rk-test',
    category: 'best-practice',
    content: 'test content',
    confidence: 0.7,
    importance: 0.5,
    evidence: [],
    createdAt: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constants — guard against accidental drift from the spec values
// ---------------------------------------------------------------------------

describe('eligibility constants', () => {
  it('exports the spec-defined defaults', () => {
    expect(DEFAULT_IMPORTANCE).toBe(0.5);
    expect(DEFAULT_CONFIDENCE).toBe(0.7);
  });

  it('exports the spec-defined gates', () => {
    expect(AUTO_INJECT_IMPORTANCE_MIN).toBe(0.85);
    expect(AUTO_INJECT_CONFIDENCE_MIN).toBe(0.7);
    expect(NEVER_AUTO_INJECT_CONFIDENCE).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// isExpired
// ---------------------------------------------------------------------------

describe('isExpired', () => {
  it('returns false when ttl is undefined', () => {
    expect(isExpired({ ttl: undefined }, NOW)).toBe(false);
  });

  it('returns true when ttl is in the past', () => {
    expect(isExpired({ ttl: PAST }, NOW)).toBe(true);
  });

  it('returns false when ttl is in the future', () => {
    expect(isExpired({ ttl: FUTURE }, NOW)).toBe(false);
  });

  it('returns false (fail-soft) when ttl is malformed', () => {
    // Malformed TTL must not silently disappear an entry.
    expect(isExpired({ ttl: 'not-a-date' }, NOW)).toBe(false);
  });

  it('uses Date.now() as the default reference', () => {
    // Use a far-past TTL so the assertion is robust regardless of when the
    // test runs.
    expect(isExpired({ ttl: '1970-01-01T00:00:00Z' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// lazyMigrateEntry
// ---------------------------------------------------------------------------

describe('lazyMigrateEntry', () => {
  it('fills importance + confidence defaults on a legacy entry', () => {
    const legacy = {
      id: 'rk-legacy',
      category: 'best-practice',
      content: 'Always run tests before committing',
      learnedFrom: 'TICKET-123',
      // pre-M3 entries always carried `confidence` per the existing
      // schema, but exercise the explicit-undefined path too.
    } as RoleKnowledgeEntry;

    const v = lazyMigrateEntry(legacy);
    expect(v.importance).toBe(DEFAULT_IMPORTANCE);
    expect(v.confidence).toBe(DEFAULT_CONFIDENCE);
  });

  it('coerces learnedFrom into evidence when evidence is missing', () => {
    const legacy = makeEntry({
      evidence: undefined,
      learnedFrom: 'TICKET-123',
    });
    const v = lazyMigrateEntry(legacy);
    expect(v.evidence).toEqual(['TICKET-123']);
  });

  it('returns evidence=[] when neither evidence nor learnedFrom is set', () => {
    const legacy = makeEntry({ evidence: undefined, learnedFrom: undefined });
    const v = lazyMigrateEntry(legacy);
    expect(v.evidence).toEqual([]);
  });

  it('preserves an explicit evidence array even when learnedFrom is also set', () => {
    const e = makeEntry({
      evidence: ['req-1', 'wi-2'],
      learnedFrom: 'TICKET-OLD',
    });
    expect(lazyMigrateEntry(e).evidence).toEqual(['req-1', 'wi-2']);
  });

  it('is idempotent on an already-migrated entry', () => {
    const e = makeEntry({
      importance: 0.9,
      confidence: 0.8,
      evidence: ['req-1'],
    });
    const v1 = lazyMigrateEntry(e);
    const v2 = lazyMigrateEntry(v1);
    expect(v2).toEqual(v1);
  });

  it('does not mutate the input', () => {
    const e = makeEntry({ evidence: undefined, learnedFrom: 'TICKET' });
    const before = JSON.parse(JSON.stringify(e));
    lazyMigrateEntry(e);
    expect(e).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// isAutoInjectEligible
// ---------------------------------------------------------------------------

describe('isAutoInjectEligible', () => {
  it('hides superseded entries (superseded boolean flag)', () => {
    const e = makeEntry({
      superseded: true,
      importance: 1,
      confidence: 1,
    });
    expect(isAutoInjectEligible(e, NOW)).toBe(false);
  });

  it('hides entries with supersededBy set even when superseded flag is absent', () => {
    const e = makeEntry({
      supersededBy: 'rk-newer',
      importance: 1,
      confidence: 1,
    });
    expect(isAutoInjectEligible(e, NOW)).toBe(false);
  });

  it('hides expired entries', () => {
    const e = makeEntry({ ttl: PAST, importance: 1, confidence: 1 });
    expect(isAutoInjectEligible(e, NOW)).toBe(false);
  });

  it('shows an entry that meets both score gates', () => {
    const e = makeEntry({ importance: 0.9, confidence: 0.8 });
    expect(isAutoInjectEligible(e, NOW)).toBe(true);
  });

  it('hides an entry below the importance gate even with high confidence', () => {
    const e = makeEntry({ importance: 0.6, confidence: 1 });
    expect(isAutoInjectEligible(e, NOW)).toBe(false);
  });

  it('hides an entry below the confidence gate even with high importance', () => {
    const e = makeEntry({ importance: 1, confidence: 0.6 });
    expect(isAutoInjectEligible(e, NOW)).toBe(false);
  });

  it('honors shouldInjectByDefault=false even when scores would qualify', () => {
    const e = makeEntry({
      importance: 1,
      confidence: 1,
      shouldInjectByDefault: false,
    });
    expect(isAutoInjectEligible(e, NOW)).toBe(false);
  });

  it('honors shouldInjectByDefault=true even when scores fall below derived gates', () => {
    const e = makeEntry({
      importance: 0.6,
      confidence: 0.6,
      shouldInjectByDefault: true,
    });
    expect(isAutoInjectEligible(e, NOW)).toBe(true);
  });

  it('rejects shouldInjectByDefault=true when confidence is below the hard floor', () => {
    // §185: confidence < 0.5 → NEVER auto-inject regardless.
    const e = makeEntry({
      importance: 1,
      confidence: 0.4,
      shouldInjectByDefault: true,
    });
    expect(isAutoInjectEligible(e, NOW)).toBe(false);
  });

  it('uses defaults when importance is missing on a legacy entry', () => {
    // confidence default = 0.7 (gate met), importance default = 0.5 (gate
    // missed) → not eligible.
    const legacy = makeEntry({ importance: undefined });
    expect(isAutoInjectEligible(legacy, NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isHiddenFromDefaultRecall
// ---------------------------------------------------------------------------

describe('isHiddenFromDefaultRecall', () => {
  it('hides superseded entries', () => {
    const e = makeEntry({ superseded: true });
    expect(isHiddenFromDefaultRecall(e, NOW)).toBe(true);
  });

  it('hides entries with a supersededBy reference', () => {
    const e = makeEntry({ supersededBy: 'rk-newer' });
    expect(isHiddenFromDefaultRecall(e, NOW)).toBe(true);
  });

  it('hides expired entries', () => {
    const e = makeEntry({ ttl: PAST });
    expect(isHiddenFromDefaultRecall(e, NOW)).toBe(true);
  });

  it('does NOT hide an entry merely because it falls below the auto-inject gate', () => {
    // This is the strict-superset rule: low-score entries still surface
    // on default recall, they just are not auto-injected.
    const e = makeEntry({ importance: 0.1, confidence: 0.1 });
    expect(isHiddenFromDefaultRecall(e, NOW)).toBe(false);
  });

  it('shows healthy entries by default', () => {
    const e = makeEntry({ importance: 0.6, confidence: 0.6 });
    expect(isHiddenFromDefaultRecall(e, NOW)).toBe(false);
  });
});
