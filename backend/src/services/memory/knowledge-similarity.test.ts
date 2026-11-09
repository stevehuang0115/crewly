/**
 * Unit tests for knowledge-similarity (#914 P1 evidence merge).
 *
 * @module services/memory/knowledge-similarity.test
 */
import { MEMORY_CONSTANTS } from '../../constants.js';
import type { RoleKnowledgeEntry } from '../../types/memory.types.js';
import {
  evictionIndex,
  findNearestKnowledge,
  isExactMatch,
  jaccard,
  knowledgeTokens,
  mergeKnowledgeEvidence,
  numbersCompatible,
  RESTATEMENT_REASON_PREFIX,
  restateKnowledge,
  sameScope,
} from './knowledge-similarity.js';

/**
 * A knowledge entry with defaults.
 *
 * @param content - Content
 * @param extra - Overrides
 * @returns Entry
 */
function entry(content: string, extra: Partial<RoleKnowledgeEntry> = {}): RoleKnowledgeEntry {
  return { id: extra.id ?? `rk-${content.length}-${content.slice(0, 8)}`, category: 'best-practice', content, confidence: 0.5, createdAt: '2026-10-01T00:00:00.000Z', ...extra };
}

// Real shapes from the owner's memory stores (ids shortened).
const CLAIM_A = "Claimed WorkItem 'Refresh standing answer \"Which gotchas are still open?\" — ce-core (1 newer)' (id: 51851ddb-3e5f-48b4-b73a-fccbc6a79abb, claim: 8384fa1e-22c1-4e1a-9a0c-0a1b2c3d4e5f) from Task Pool";
const CLAIM_B = "Claimed WorkItem 'Refresh standing answer \"Which gotchas are still open?\" — ce-core (1 newer)' (id: 2341e221-7715-4003-a991-cab69f9499b9, claim: bb476d30-c48f-4b1e-8c2d-9e8f7a6b5c4d) from Task Pool";
const CLAIM_COUNT = "Claimed WorkItem 'Refresh standing answer \"Which gotchas are still open?\" — ce-core (6 newer)' (id: 2341e221-7715-4003-a991-cab69f9499b9, claim: bb476d30-c48f-4b1e-8c2d-9e8f7a6b5c4d) from Task Pool";
const CLAIM_OTHER = "Claimed WorkItem 'Vera idle — verify CE-367 deploy' (id: d13a87fa-664b-4f13-9063-19f6e9b4d48e, claim: 2a8900f8-a8e9-4bfd-84de-58c5cc6d7ce7) from Task Pool";

describe('knowledgeTokens', () => {
  it('lowercases, splits on punctuation and drops uuids, hex ids, long numbers and single letters', () => {
    const t = knowledgeTokens('Claimed WorkItem X (id: 51851ddb-3e5f-48b4-b73a-fccbc6a79abb, WI d3416d29) at 1761369000000, count=7, sha 8ae0b1c');
    expect(t.has('claimed')).toBe(true);
    expect(t.has('workitem')).toBe(true);
    expect(t.has('51851ddb')).toBe(false);
    expect(t.has('3e5f')).toBe(false);
    expect(t.has('fccbc6a79abb')).toBe(false);
    expect(t.has('d3416d29')).toBe(false);
    expect(t.has('8ae0b1c')).toBe(false);
    expect(t.has('1761369000000')).toBe(false);
    expect(t.has('x')).toBe(false);
    expect(t.has('7')).toBe(true);
  });

  it('keeps single digits and years: "entry 0" and "entry 1" are two facts', () => {
    const t = knowledgeTokens('Unique entry 0 about feature 0 in 2026');
    expect(t.has('0')).toBe(true);
    expect(t.has('2026')).toBe(true);
  });

  it('keeps short ticket numbers so CE-367 and CE-368 stay distinct, and hex-letter words', () => {
    expect(knowledgeTokens('verify CE-367 deploy').has('367')).toBe(true);
    expect(knowledgeTokens('a bead on its face').has('face')).toBe(true);
  });
});

describe('jaccard', () => {
  it('is 1 for equal sets, 0 for disjoint or empty sets', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(1);
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
    expect(jaccard(new Set(), new Set(['b']))).toBe(0);
  });

  it('is shared over union otherwise', () => {
    expect(jaccard(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBeCloseTo(0.5);
  });
});

describe('numbersCompatible', () => {
  it('is true when one side has no numbers the other lacks', () => {
    expect(numbersCompatible(knowledgeTokens('snapshot 10/13 03:40Z feed'), knowledgeTokens('snapshot 10/13 feed'))).toBe(true);
    expect(numbersCompatible(knowledgeTokens('run tests first'), knowledgeTokens('run tests first, 3 times'))).toBe(true);
  });

  it('is false when the two sides disagree on a number', () => {
    expect(numbersCompatible(knowledgeTokens('Vera idle — verify CE-140'), knowledgeTokens('Vera idle — verify CE-196 release'))).toBe(false);
    expect(numbersCompatible(knowledgeTokens('entry 0 feature 0'), knowledgeTokens('entry 1 feature 100'))).toBe(false);
  });
});

describe('sameScope', () => {
  it('requires the same category when the incoming entry names one', () => {
    expect(sameScope({ category: 'anti-pattern' }, { category: 'best-practice' })).toBe(false);
    expect(sameScope({ category: 'best-practice' }, { category: 'best-practice' })).toBe(true);
    expect(sameScope({ category: 'anti-pattern' }, {})).toBe(true);
  });

  it('requires a shared tag only when both sides carry tags', () => {
    expect(sameScope({ tags: ['billing'] }, { tags: ['deploy'] })).toBe(false);
    expect(sameScope({ tags: ['billing', 'deploy'] }, { tags: ['deploy'] })).toBe(true);
    expect(sameScope({ tags: [] }, { tags: ['deploy'] })).toBe(true);
    expect(sameScope({}, { tags: ['deploy'] })).toBe(true);
  });
});

describe('isExactMatch', () => {
  it('matches case- and whitespace-insensitively and by containment above the floor', () => {
    expect(isExactMatch('Always run tests', '  always RUN tests ')).toBe(true);
    expect(isExactMatch('Always run tests before committing anything', 'run tests before committing')).toBe(true);
  });

  it('does not use containment for short texts', () => {
    expect(isExactMatch('Always run tests before committing', 'tests')).toBe(false);
  });
});

describe('findNearestKnowledge', () => {
  it('treats an id-only restatement of one fact as a near-duplicate', () => {
    const hit = findNearestKnowledge([entry(CLAIM_A)], { content: CLAIM_B, category: 'best-practice' });
    expect(hit).not.toBeNull();
    expect(hit?.kind).toBe('near');
    expect(hit?.score).toBeGreaterThanOrEqual(MEMORY_CONSTANTS.DEDUP.NEAR_DUPLICATE_JACCARD);
  });

  it('keeps distinct facts apart even when they share boilerplate, and a changed count apart on purpose', () => {
    expect(findNearestKnowledge([entry(CLAIM_A)], { content: CLAIM_OTHER, category: 'best-practice' })).toBeNull();
    expect(findNearestKnowledge([entry(CLAIM_A)], { content: CLAIM_COUNT, category: 'best-practice' })).toBeNull();
    const a = entry('Unique entry 0 with specific details about feature 0');
    expect(findNearestKnowledge([a], { content: 'Unique entry 1 with specific details about feature 100' })).toBeNull();
  });

  it('merges a shorter restatement that drops a timestamp', () => {
    const a = entry('Unfinished work snapshot 10/13 03:40Z (feed): feed_view 40, feed_return 5 = 12.5% returning against the 25% target');
    const hit = findNearestKnowledge([a], { content: 'Unfinished work snapshot 10/13 (feed): feed_view 40, feed_return 5 = 12.5% returning against the 25% target' });
    expect(hit?.kind).toBe('near');
  });

  it('prefers a containment match over a near match', () => {
    const near = entry('Always run the unit tests before you commit, and lint as well');
    const longer = entry('Note to self: always run the unit tests before committing, and lint too');
    const hit = findNearestKnowledge([near, longer], { content: 'always run the unit tests before committing, and lint too' });
    expect(hit?.entry.id).toBe(longer.id);
    expect(hit?.kind).toBe('exact');
  });

  it('prefers an exact match over a closer-looking near match and returns the best near match otherwise', () => {
    const exact = entry('Always run the unit tests before committing');
    const near = entry('Always run the unit tests before committing, and lint too');
    const hit = findNearestKnowledge([near, exact], { content: 'always run the unit tests before committing' });
    expect(hit?.entry.id).toBe(exact.id);
    expect(hit?.kind).toBe('exact');

    const a = entry('Deploy the web portal with safe-deploy.sh after a dry run on node one');
    const b = entry('Deploy the web portal with safe-deploy.sh after a dry run on node one and node two, then check health');
    const near2 = findNearestKnowledge([b, a], { content: 'Deploy the web portal using safe-deploy.sh after a dry run on node one' });
    expect(near2?.entry.id).toBe(a.id);
    expect(near2?.kind).toBe('near');
  });

  it('never matches a superseded or expired entry', () => {
    const dead = entry(CLAIM_A, { supersededBy: 'rk-newer' });
    const expired = entry(CLAIM_A, { ttl: '2026-01-01T00:00:00.000Z' });
    expect(findNearestKnowledge([dead], { content: CLAIM_A })).toBeNull();
    expect(findNearestKnowledge([expired], { content: CLAIM_A }, { now: new Date('2026-10-25T00:00:00.000Z') })).toBeNull();
  });

  it('stays inside the scope: category and tags', () => {
    const other = entry(CLAIM_A, { category: 'anti-pattern' });
    expect(findNearestKnowledge([other], { content: CLAIM_B, category: 'best-practice' })).toBeNull();
    const tagged = entry(CLAIM_A, { tags: ['billing'] });
    expect(findNearestKnowledge([tagged], { content: CLAIM_B, tags: ['deploy'] })).toBeNull();
    expect(findNearestKnowledge([tagged], { content: CLAIM_B, tags: ['billing'] })?.kind).toBe('near');
  });

  it('matches short texts exactly or not at all', () => {
    const short = entry('Use pnpm here');
    expect(findNearestKnowledge([short], { content: 'Use npm here' })).toBeNull();
    expect(findNearestKnowledge([short], { content: 'use pnpm here' })?.kind).toBe('exact');
  });

  it('honours an explicit threshold', () => {
    const a = entry('alpha beta gamma delta epsilon zeta');
    expect(findNearestKnowledge([a], { content: 'alpha beta gamma delta omega sigma' }, { threshold: 0.9 })).toBeNull();
    expect(findNearestKnowledge([a], { content: 'alpha beta gamma delta omega sigma' }, { threshold: 0.4 })?.kind).toBe('near');
  });
});

describe('mergeKnowledgeEvidence', () => {
  it('unions evidence, counting legacy learnedFrom and sourceTaskId, and stamps verification', () => {
    const existing = entry('x', { learnedFrom: 'TICKET-1' });
    const now = new Date('2026-10-25T05:00:00.000Z');
    const result = mergeKnowledgeEvidence(existing, { evidence: ['wi-2', 'TICKET-1'], learnedFrom: 'TICKET-3', sourceTaskId: 'task-4' }, now);
    expect(existing.evidence).toEqual(['TICKET-1', 'wi-2', 'TICKET-3', 'task-4']);
    expect(result.addedEvidence).toEqual(['wi-2', 'TICKET-3', 'task-4']);
    expect(existing.lastVerifiedAt).toBe(now.toISOString());
    expect(existing.lastUsed).toBe(now.toISOString());
  });

  it('raises importance to the incoming value and never lowers it', () => {
    const existing = entry('x', { importance: 0.6 });
    expect(mergeKnowledgeEvidence(existing, { importance: 0.9 }).importanceRaised).toBe(true);
    expect(existing.importance).toBe(0.9);
    expect(mergeKnowledgeEvidence(existing, { importance: 0.3 }).importanceRaised).toBe(false);
    expect(existing.importance).toBe(0.9);
  });

  it('leaves evidence undefined when neither side has any', () => {
    const existing = entry('x');
    expect(mergeKnowledgeEvidence(existing, {}).addedEvidence).toEqual([]);
    expect(existing.evidence).toBeUndefined();
  });
});

describe('restateKnowledge', () => {
  const now = new Date('2026-10-25T05:00:00.000Z');

  it('makes the new wording a new entry with the old provenance, and supersedes the old one', () => {
    const old = entry('I asserted delegate-task/execute.sh is a working symlink to the team-leader file', { id: 'rk-old', learnedFrom: 'TICKET-1', confidence: 0.7, importance: 0.9 });
    const fresh = restateKnowledge(old, { category: 'anti-pattern', content: 'delegate-task/execute.sh is a DANGLING symlink, not a working one', confidence: 0.5, evidence: ['wi-2'], importance: 0.6 }, { id: 'rk-new', now, score: 0.83 });
    expect(fresh.id).toBe('rk-new');
    expect(fresh.content).toContain('DANGLING');
    expect(fresh.category).toBe('anti-pattern');
    expect(fresh.evidence).toEqual(['TICKET-1', 'wi-2']);
    expect(fresh.importance).toBe(0.9);
    expect(fresh.confidence).toBeCloseTo(0.8);
    expect(fresh.createdAt).toBe(now.toISOString());
    expect(fresh.lastVerifiedAt).toBe(now.toISOString());

    expect(old.superseded).toBe(true);
    expect(old.supersededBy).toBe('rk-new');
    expect(old.evidence).toEqual(['TICKET-1', `${RESTATEMENT_REASON_PREFIX} (jaccard 0.83)`]);
  });

  it('caps confidence and leaves evidence undefined when neither side has any', () => {
    const old = entry('x', { confidence: 0.95 });
    const fresh = restateKnowledge(old, { category: 'best-practice', content: 'x restated', confidence: 0.5 }, { id: 'rk-new', now, score: 0.9 });
    expect(fresh.confidence).toBe(MEMORY_CONSTANTS.DEFAULTS.MAX_CONFIDENCE);
    expect(fresh.evidence).toBeUndefined();
    expect(fresh.importance).toBeUndefined();
  });
});

describe('evictionIndex', () => {
  it('picks the oldest superseded entry first, else the lowest confidence', () => {
    const live = entry('a', { id: 'a', confidence: 0.2, createdAt: '2026-10-01T00:00:00.000Z' });
    const deadNew = entry('b', { id: 'b', confidence: 0.9, createdAt: '2026-10-03T00:00:00.000Z', supersededBy: 'x' });
    const deadOld = entry('c', { id: 'c', confidence: 0.9, createdAt: '2026-10-02T00:00:00.000Z', superseded: true });
    expect(evictionIndex([live, deadNew, deadOld])).toBe(2);
    expect(evictionIndex([live, entry('d', { id: 'd', confidence: 0.5 })])).toBe(0);
    expect(evictionIndex([])).toBe(-1);
  });
});
