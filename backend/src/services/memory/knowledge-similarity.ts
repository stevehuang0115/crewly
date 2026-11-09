/**
 * Near-duplicate detection and evidence merge for role knowledge (#914 P1).
 *
 * `addRoleKnowledge` used to dedupe by exact match or substring containment
 * only, so the same fact written twice with a different id, count or date
 * in it ("Refresh standing answer … (1 newer)" / "… (6 newer)") became two
 * entries, and recall surfaced both. This module replaces that check with
 * a cheap nearest-neighbour over token sets:
 *
 * - `knowledgeTokens` lowercases, splits on non-alphanumerics and drops the
 *   tokens that vary between restatements of one fact (uuids, hex ids,
 *   long digit runs, single letters);
 * - `jaccard` is the set overlap of two token sets;
 * - `numbersCompatible` keeps two texts apart when they disagree on a
 *   number (ticket, count, version): the frame may be identical, the fact
 *   is not;
 * - `findNearestKnowledge` returns the best candidate in the same scope
 *   (same category; overlapping tags when both sides have tags), an exact
 *   or substring match first, else the highest Jaccard at or above the
 *   threshold among number-compatible entries. Superseded and expired
 *   entries are never candidates, so a new write cannot reinforce a dead
 *   fact. Short texts (fewer than `MIN_TOKENS_FOR_NEAR` tokens) match
 *   exactly or not at all.
 * - `mergeKnowledgeEvidence` folds the incoming entry's provenance into the
 *   existing one (exact match): evidence union, importance max,
 *   verification timestamp. The existing content stays.
 * - `restateKnowledge` handles a near match: the newest wording becomes a
 *   new entry with the old provenance and reinforcement, the old entry is
 *   marked superseded by it and kept for audit. The LLM adjudication the
 *   issue describes (keep / modify / supersede by judgment) is a later,
 *   possibly Pro, step; this is the deterministic rule.
 * - `evictionIndex` picks what a full store drops: superseded first.
 *
 * Pure functions only; the threshold was set by replaying the owner's
 * 3.7k real entries (see spec `2026-10-25-knowledge-evidence-merge.md`).
 *
 * @module services/memory/knowledge-similarity
 */

import { MEMORY_CONSTANTS } from '../../constants.js';
import type { RoleKnowledgeEntry } from '../../types/memory.types.js';
import { isHiddenFromDefaultRecall } from './role-knowledge-eligibility.js';

/** A uuid anywhere in the text (work item, claim and task ids). */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/**
 * Hex runs of four or more characters with at least one digit: partial ids
 * (`WI d3416d29`), commit shas, hashes. Plain words that happen to be hex
 * letters (`face`, `bead`) have no digit and stay.
 */
const HEX_ID = /^(?=.*\d)[0-9a-f]{4,}$/;
/** Digit runs of six or more: epoch values, compact dates, random suffixes. */
const LONG_NUMBER = /^\d{6,}$/;
/** A number that survived: ticket numbers, counts, versions, years. */
const NUMBER = /^\d+$/;
/** Anything that is not a letter or digit splits tokens. */
const NON_ALNUM = /[^\p{L}\p{N}]+/u;

/** The fields the similarity check reads from an existing entry. */
export type KnowledgeLike = Pick<RoleKnowledgeEntry, 'content' | 'category' | 'tags' | 'superseded' | 'supersededBy' | 'ttl'>;

/** The fields the similarity check reads from an incoming entry. */
export type IncomingKnowledge = Pick<RoleKnowledgeEntry, 'content'> & Partial<Pick<RoleKnowledgeEntry, 'category' | 'tags'>>;

/** How an existing entry matched the incoming one. */
export type MatchKind = 'exact' | 'near';

/** The nearest existing entry and how close it is. */
export interface NearestMatch<T> {
  /** The existing entry */
  entry: T;
  /** 1 for an exact or substring match, else the Jaccard overlap */
  score: number;
  /** Exact (legacy rule) or near (token overlap at or above the threshold) */
  kind: MatchKind;
}

/** Options for {@link findNearestKnowledge}. */
export interface NearestOptions {
  /** Jaccard at or above which a candidate is a near-duplicate; defaults to the constant */
  threshold?: number;
  /** Reference instant for the expiry check; defaults to now */
  now?: Date;
}

/**
 * Tokens of a knowledge text that survive a restatement: lowercase words
 * and numbers up to five digits, without uuids, hex ids, long digit runs or
 * single letters. Single digits stay: "entry 0" and "entry 1" are two
 * facts.
 *
 * @param text - Entry content
 * @returns Distinct tokens
 *
 * @example
 * ```typescript
 * knowledgeTokens('Claimed WorkItem X (id: 51851ddb-3e5f-48b4-b73a-fccbc6a79abb) at 2026-10-25, 3 newer')
 * // Set { 'claimed', 'workitem', 'id', 'at', '2026', '10', '25', '3', 'newer' }
 * ```
 */
export function knowledgeTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().replace(UUID, ' ').split(NON_ALNUM)) {
    if (raw.length === 0) continue;
    if (NUMBER.test(raw)) {
      if (!LONG_NUMBER.test(raw)) out.add(raw);
      continue;
    }
    if (raw.length === 1 || HEX_ID.test(raw)) continue;
    out.add(raw);
  }
  return out;
}

/**
 * Whether two token sets agree on their numbers: one side's numbers must
 * all appear on the other. "verify CE-140" and "verify CE-196" share every
 * word and differ in one number — two facts, however alike the frame.
 * "snapshot 10/13 03:40Z" and "snapshot 10/13" are one fact, the second
 * just shorter. Disagreeing counts ("1 newer" / "6 newer") are kept apart
 * on purpose: a false merge loses knowledge, a missed one only leaves a
 * duplicate.
 *
 * @param a - First token set
 * @param b - Second token set
 * @returns true when the numbers of one set are a subset of the other's
 */
export function numbersCompatible(a: Set<string>, b: Set<string>): boolean {
  const na = [...a].filter((t) => NUMBER.test(t));
  const nb = [...b].filter((t) => NUMBER.test(t));
  return na.every((t) => b.has(t)) || nb.every((t) => a.has(t));
}

/**
 * Jaccard overlap of two token sets: |A ∩ B| / |A ∪ B|.
 *
 * @param a - First set
 * @param b - Second set
 * @returns 0 when either set is empty, else the overlap in [0, 1]
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Whether an existing entry is in the incoming entry's scope: the same
 * category when the incoming one names a category, and at least one shared
 * tag when both carry tags.
 *
 * @param existing - Existing entry
 * @param incoming - Incoming entry
 * @returns true when the two may be compared
 */
export function sameScope(
  existing: Partial<Pick<KnowledgeLike, 'category' | 'tags'>>,
  incoming: Partial<Pick<IncomingKnowledge, 'category' | 'tags'>>,
): boolean {
  if (incoming.category && existing.category && incoming.category !== existing.category) return false;
  const a = incoming.tags ?? [];
  const b = existing.tags ?? [];
  if (a.length > 0 && b.length > 0 && !a.some((t) => b.includes(t))) return false;
  return true;
}

/**
 * Equal after trim and lowercase.
 *
 * @param existing - Existing content
 * @param incoming - Incoming content
 * @returns true when the two texts are the same
 */
export function isSameText(existing: string, incoming: string): boolean {
  return existing.toLowerCase().trim() === incoming.toLowerCase().trim();
}

/**
 * One text contains the other, when the incoming text is longer than the
 * substring floor (the legacy containment rule).
 *
 * @param existing - Existing content
 * @param incoming - Incoming content
 * @returns true for a containment match
 */
export function containsText(existing: string, incoming: string): boolean {
  const a = existing.toLowerCase().trim();
  const b = incoming.toLowerCase().trim();
  return b.length > MEMORY_CONSTANTS.DEDUP.SUBSTRING_MIN_CHARS && (a.includes(b) || b.includes(a));
}

/**
 * The legacy rule: {@link isSameText} or {@link containsText}.
 *
 * @param existing - Existing content
 * @param incoming - Incoming content
 * @returns true for an exact or containment match
 */
export function isExactMatch(existing: string, incoming: string): boolean {
  return isSameText(existing, incoming) || containsText(existing, incoming);
}

/**
 * The existing entry the incoming one duplicates, if any: an exact match
 * first, else the highest token overlap at or above the threshold, among
 * entries in scope that recall still shows.
 *
 * @param knowledge - Existing entries
 * @param incoming - Entry about to be written
 * @param options - Threshold and reference time
 * @returns The nearest match, or null when nothing is close enough
 *
 * @example
 * ```typescript
 * const hit = findNearestKnowledge(memory.roleKnowledge, { content, category });
 * if (hit) merge(hit.entry); else append(content);
 * ```
 */
export function findNearestKnowledge<T extends KnowledgeLike>(
  knowledge: T[],
  incoming: IncomingKnowledge,
  options: NearestOptions = {},
): NearestMatch<T> | null {
  const threshold = options.threshold ?? MEMORY_CONSTANTS.DEDUP.NEAR_DUPLICATE_JACCARD;
  const now = options.now ?? new Date();
  const incomingTokens = knowledgeTokens(incoming.content);
  const nearAllowed = incomingTokens.size >= MEMORY_CONSTANTS.DEDUP.MIN_TOKENS_FOR_NEAR;

  // Same text wins outright; a containment match beats any near match; among
  // near matches the highest overlap wins.
  let contained: NearestMatch<T> | null = null;
  let near: NearestMatch<T> | null = null;
  for (const entry of knowledge) {
    if (isHiddenFromDefaultRecall(entry, now)) continue;
    if (!sameScope(entry, incoming)) continue;
    if (isSameText(entry.content, incoming.content)) return { entry, score: 1, kind: 'exact' };
    if (contained === null && containsText(entry.content, incoming.content)) {
      contained = { entry, score: 1, kind: 'exact' };
      continue;
    }
    if (!nearAllowed) continue;
    const entryTokens = knowledgeTokens(entry.content);
    if (!numbersCompatible(entryTokens, incomingTokens)) continue;
    const score = jaccard(entryTokens, incomingTokens);
    if (score >= threshold && (near === null || score > near.score)) near = { entry, score, kind: 'near' };
  }
  return contained ?? near;
}

/** What {@link mergeKnowledgeEvidence} changed on the existing entry. */
export interface MergeResult {
  /** Evidence refs added (not already present) */
  addedEvidence: string[];
  /** Whether importance was raised to the incoming value */
  importanceRaised: boolean;
}

/**
 * Folds an incoming duplicate's provenance into the existing entry, in
 * place: evidence becomes the union (legacy `learnedFrom` and
 * `sourceTaskId` count as evidence), importance the max, and the entry is
 * marked verified and used now. Content, confidence and ids are left to the
 * caller.
 *
 * @param existing - Entry that stays (mutated)
 * @param incoming - Duplicate that is not written
 * @param now - Timestamp for `lastVerifiedAt` / `lastUsed`
 * @returns What changed
 */
export function mergeKnowledgeEvidence(
  existing: RoleKnowledgeEntry,
  incoming: Partial<Pick<RoleKnowledgeEntry, 'evidence' | 'learnedFrom' | 'sourceTaskId' | 'importance'>>,
  now: Date = new Date(),
): MergeResult {
  const evidence = [...(existing.evidence ?? (existing.learnedFrom ? [existing.learnedFrom] : []))];
  const addedEvidence: string[] = [];
  for (const ref of [...(incoming.evidence ?? []), incoming.learnedFrom, incoming.sourceTaskId]) {
    if (!ref || evidence.includes(ref)) continue;
    evidence.push(ref);
    addedEvidence.push(ref);
  }
  if (evidence.length > 0) existing.evidence = evidence;

  let importanceRaised = false;
  if (incoming.importance !== undefined && incoming.importance > (existing.importance ?? 0)) {
    existing.importance = incoming.importance;
    importanceRaised = true;
  }

  const iso = now.toISOString();
  existing.lastVerifiedAt = iso;
  existing.lastUsed = iso;
  return { addedEvidence, importanceRaised };
}

/** Prefix of the evidence ref a superseded entry gets when a restatement replaced it. */
export const RESTATEMENT_REASON_PREFIX = 'supersession-reason:restated';

/**
 * A near-duplicate is the same fact said again, often with a correction
 * ("I asserted X is a working symlink" → "X is a DANGLING symlink"), so the
 * newest wording wins: the incoming entry becomes a new entry carrying the
 * old one's provenance and reinforcement, and the old entry is marked
 * superseded by it — hidden from recall, kept for audit, the same way
 * `MemorySupersessionService.supersede` records an explicit supersession.
 *
 * @param old - Existing near-duplicate (mutated: superseded, evidence reason appended)
 * @param incoming - Entry being written
 * @param ids - The new entry's id and timestamp, and the match score for the audit ref
 * @returns The new entry to store
 *
 * @example
 * ```typescript
 * const fresh = restateKnowledge(match.entry, entry, { id: uuidv4(), now: new Date(), score: match.score });
 * memory.roleKnowledge.push(fresh);
 * ```
 */
export function restateKnowledge(
  old: RoleKnowledgeEntry,
  incoming: Omit<RoleKnowledgeEntry, 'id' | 'createdAt'>,
  ids: { id: string; now: Date; score: number },
): RoleKnowledgeEntry {
  const iso = ids.now.toISOString();
  const fresh: RoleKnowledgeEntry = {
    ...incoming,
    id: ids.id,
    createdAt: iso,
    confidence: Math.min(
      Math.max(old.confidence, incoming.confidence ?? MEMORY_CONSTANTS.DEFAULTS.INITIAL_CONFIDENCE) + MEMORY_CONSTANTS.DEFAULTS.CONFIDENCE_REINFORCEMENT,
      MEMORY_CONSTANTS.DEFAULTS.MAX_CONFIDENCE,
    ),
    lastVerifiedAt: iso,
  };
  // The new entry inherits the old provenance, then its own.
  const inherited: RoleKnowledgeEntry = { ...fresh, evidence: [...(old.evidence ?? (old.learnedFrom ? [old.learnedFrom] : []))], importance: old.importance };
  mergeKnowledgeEvidence(inherited, incoming, ids.now);
  if (inherited.evidence && inherited.evidence.length > 0) fresh.evidence = inherited.evidence;
  if (inherited.importance !== undefined) fresh.importance = inherited.importance;

  old.superseded = true;
  old.supersededBy = fresh.id;
  old.evidence = [...(old.evidence ?? (old.learnedFrom ? [old.learnedFrom] : [])), `${RESTATEMENT_REASON_PREFIX} (jaccard ${ids.score.toFixed(2)})`];
  return fresh;
}

/**
 * Which entry to evict when a store is full: the oldest superseded entry
 * first (recall no longer shows it), else the lowest-confidence live one.
 *
 * @param knowledge - Entries
 * @returns Index to remove, or -1 for an empty list
 */
export function evictionIndex(knowledge: RoleKnowledgeEntry[]): number {
  if (knowledge.length === 0) return -1;
  let pick = -1;
  for (let i = 0; i < knowledge.length; i++) {
    const e = knowledge[i];
    if (!(e.superseded === true || e.supersededBy)) continue;
    if (pick === -1 || e.createdAt < knowledge[pick].createdAt) pick = i;
  }
  if (pick !== -1) return pick;
  for (let i = 0; i < knowledge.length; i++) {
    if (pick === -1 || knowledge[i].confidence < knowledge[pick].confidence) pick = i;
  }
  return pick;
}
