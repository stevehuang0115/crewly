/**
 * The signal digest contract (#987, specs/2026-10-03-signal-digest.md §2):
 * validate a team lead's proposal and work out which actions the site's
 * history blocks. Pure.
 *
 * Every rejection says what to fix, because the reader is an agent that will
 * retry with whatever the error tells it.
 *
 * @module services/signal-digest/signal-digest-contract
 */

import { SIGNAL_DIGEST_CONSTANTS } from '../../constants.js';
import type { SignalActionInput, SignalDigest, SignalHistoryEntry, SignalSource } from '../../types/signal-digest.types.js';

/** A rejected proposal. */
export class SignalDigestError extends Error {
  /**
   * @param status - HTTP status to answer with
   * @param message - What to fix
   */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SignalDigestError';
  }
}

/** Appended to contract errors. */
export const SIGNAL_DIGEST_EXAMPLE =
  'Example item: {"key":"gsc:low-ctr:h1b visa fee","source":"gsc","signal":"\'h1b visa fee\' ranks #2 with 4% CTR on 900 impressions (7 d)","proposal":"Rewrite the title and description of /h1b-fee to answer the fee question","expectedEffect":"CTR 4% → ~12%: about +70 clicks a week","effort":"S — 1 h","metric":"GSC clicks for \'h1b visa fee\'"}';

/** A validated proposal. */
export interface ValidatedSignalDigest {
  site: string;
  project?: string;
  items: SignalActionInput[];
}

/**
 * Collapse whitespace.
 *
 * @param s - Text
 * @returns One trimmed line
 */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Normalised identity of an action key (case and spacing do not matter).
 *
 * @param key - Key as sent
 * @returns Comparable key
 */
export function normalizeKey(key: string): string {
  return oneLine(key).toLowerCase();
}

/**
 * A required one-line text field.
 *
 * @param item - Raw item
 * @param field - Field name
 * @param max - Max characters
 * @param n - Item number (for the error)
 * @returns The text
 * @throws SignalDigestError(400)
 */
function textField(item: Record<string, unknown>, field: string, max: number, n: number): string {
  const raw = item[field];
  const text = typeof raw === 'string' ? oneLine(raw) : '';
  if (!text) throw new SignalDigestError(400, `item ${n}: "${field}" is required. ${SIGNAL_DIGEST_EXAMPLE}`);
  if (text.length > max) throw new SignalDigestError(400, `item ${n}: "${field}" is too long (max ${max} characters, got ${text.length}). Say it shorter.`);
  return text;
}

/**
 * Validate a proposal: a site, an optional project, and 3–5 distinct actions,
 * each with key, source, signal, proposal, expected effect and effort.
 *
 * @param input - Request body
 * @returns The proposal
 * @throws SignalDigestError(400) naming what to fix
 */
export function validateSignalDigest(input: { site?: unknown; project?: unknown; items?: unknown }): ValidatedSignalDigest {
  const site = typeof input.site === 'string' ? oneLine(input.site) : '';
  if (!site) throw new SignalDigestError(400, '"site" is required (e.g. "visa.careerengine.us").');
  if (site.length > SIGNAL_DIGEST_CONSTANTS.SITE_MAX_CHARS) throw new SignalDigestError(400, `"site" is too long (max ${SIGNAL_DIGEST_CONSTANTS.SITE_MAX_CHARS} characters).`);
  const project = typeof input.project === 'string' && oneLine(input.project) ? oneLine(input.project) : undefined;
  const raw = input.items;
  const { MIN_ITEMS, MAX_ITEMS } = SIGNAL_DIGEST_CONSTANTS;
  if (!Array.isArray(raw) || raw.length < MIN_ITEMS || raw.length > MAX_ITEMS) {
    const got = Array.isArray(raw) ? raw.length : 0;
    throw new SignalDigestError(400, `give ${MIN_ITEMS}–${MAX_ITEMS} actions (got ${got}): pick the ones worth the owner's tap, ranked best first. ${SIGNAL_DIGEST_EXAMPLE}`);
  }
  const seen = new Set<string>();
  const items = raw.map((value, i): SignalActionInput => {
    const n = i + 1;
    if (!value || typeof value !== 'object') throw new SignalDigestError(400, `item ${n} must be an object. ${SIGNAL_DIGEST_EXAMPLE}`);
    const item = value as Record<string, unknown>;
    const key = textField(item, 'key', SIGNAL_DIGEST_CONSTANTS.KEY_MAX_CHARS, n);
    const source = typeof item.source === 'string' ? item.source.trim().toLowerCase() : '';
    if (!SIGNAL_DIGEST_CONSTANTS.SOURCES.includes(source)) {
      throw new SignalDigestError(400, `item ${n}: "source" must be one of ${SIGNAL_DIGEST_CONSTANTS.SOURCES.join(', ')}.`);
    }
    const norm = normalizeKey(key);
    if (seen.has(norm)) throw new SignalDigestError(400, `item ${n}: key "${key}" is used twice; each action needs its own key.`);
    seen.add(norm);
    const metricRaw = typeof item.metric === 'string' ? oneLine(item.metric) : '';
    if (metricRaw.length > SIGNAL_DIGEST_CONSTANTS.METRIC_MAX_CHARS) {
      throw new SignalDigestError(400, `item ${n}: "metric" is too long (max ${SIGNAL_DIGEST_CONSTANTS.METRIC_MAX_CHARS} characters).`);
    }
    return {
      key,
      source: source as SignalSource,
      signal: textField(item, 'signal', SIGNAL_DIGEST_CONSTANTS.SIGNAL_MAX_CHARS, n),
      proposal: textField(item, 'proposal', SIGNAL_DIGEST_CONSTANTS.PROPOSAL_MAX_CHARS, n),
      expectedEffect: textField(item, 'expectedEffect', SIGNAL_DIGEST_CONSTANTS.EXPECTED_MAX_CHARS, n),
      effort: textField(item, 'effort', SIGNAL_DIGEST_CONSTANTS.EFFORT_MAX_CHARS, n),
      ...(metricRaw ? { metric: metricRaw } : {}),
    };
  });
  return { site, ...(project ? { project } : {}), items };
}

/**
 * The keys a site's history blocks right now, newest first per key:
 * - a Do blocks its key for {@link SIGNAL_DIGEST_CONSTANTS.DO_BLOCK_MS} (it was tried);
 * - a Skip blocks it for {@link SIGNAL_DIGEST_CONSTANTS.SKIP_BLOCK_MS};
 * - an open item blocks it while it is open.
 * Expired items (replaced unanswered) block nothing.
 *
 * @param digests - All stored digests
 * @param site - Site
 * @param now - Clock
 * @returns Blocked entries, one per key
 */
export function siteHistory(digests: readonly SignalDigest[], site: string, now: Date): SignalHistoryEntry[] {
  const want = site.trim().toLowerCase();
  const byKey = new Map<string, SignalHistoryEntry>();
  const ordered = [...digests].filter((d) => d.site.trim().toLowerCase() === want).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  for (const d of ordered) {
    for (const item of d.items) {
      const norm = normalizeKey(item.key);
      if (byKey.has(norm)) continue;
      if (item.status === 'open') {
        byKey.set(norm, { key: item.key, status: 'open', at: d.createdAt, proposal: item.proposal, digestId: d.id });
        continue;
      }
      if (item.status !== 'do' && item.status !== 'skip') continue;
      const at = item.answeredAt ?? d.updatedAt;
      const span = item.status === 'do' ? SIGNAL_DIGEST_CONSTANTS.DO_BLOCK_MS : SIGNAL_DIGEST_CONSTANTS.SKIP_BLOCK_MS;
      const until = Date.parse(at) + span;
      if (until <= now.getTime()) continue;
      byKey.set(norm, {
        key: item.key,
        status: item.status,
        at,
        proposal: item.proposal,
        digestId: d.id,
        ...(item.ticketId ? { ticketId: item.ticketId } : {}),
        blockedUntil: new Date(until).toISOString(),
      });
    }
  }
  return [...byKey.values()];
}

/**
 * Explain which proposed actions the history blocks.
 *
 * @param items - Proposed actions
 * @param history - {@link siteHistory} of the site
 * @returns One line per blocked action (empty when none)
 */
export function blockedLines(items: readonly SignalActionInput[], history: readonly SignalHistoryEntry[]): string[] {
  const byKey = new Map(history.map((h) => [normalizeKey(h.key), h]));
  const lines: string[] = [];
  for (const item of items) {
    const h = byKey.get(normalizeKey(item.key));
    if (!h) continue;
    const when = h.at.slice(0, 10);
    if (h.status === 'do') lines.push(`"${item.key}": the owner chose Do on ${when} (${h.digestId}${h.ticketId ? `, ${h.ticketId}` : ''}) — it is being tried`);
    else if (h.status === 'skip') lines.push(`"${item.key}": the owner skipped it on ${when} (${h.digestId}); not before ${h.blockedUntil?.slice(0, 10)}`);
    else lines.push(`"${item.key}": still waiting on the owner in ${h.digestId}`);
  }
  return lines;
}
