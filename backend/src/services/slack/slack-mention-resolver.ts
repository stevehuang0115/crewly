/**
 * Slack mention resolver for team channels.
 *
 * Agents are not Slack users, so a message like `@sam 看一下这个` arrives as
 * plain text. This module finds every `@name` token in a Slack message and
 * maps it to a Crewly agent session, and for names that match nothing it
 * offers "did you mean" suggestions (bounded Levenshtein distance) so the
 * bridge can answer a typo instead of silently ignoring it.
 *
 * Pure functions, no I/O — the bridge supplies the candidate list from the
 * team's members.
 *
 * @module services/slack/slack-mention-resolver
 */

import { SLACK_TEAM_CHANNEL_CONSTANTS } from '../../constants.js';

/** One agent the resolver may match against. */
export interface MentionCandidate {
  /** Display name as configured on the team member (e.g. `Sam`). */
  name: string;
  /** Agent session name (e.g. `crewly-alpha-sam`). */
  sessionName: string;
  /**
   * The agent's own Slack bot user id when it has a real identity. A native
   * Slack mention arrives as `<@U…>` and is matched here first.
   */
  botUserId?: string;
}

/** An `@name` that matched no candidate, with close alternatives. */
export interface UnknownMention {
  /** The token as typed, without the `@`. */
  token: string;
  /** Candidate display names within the edit-distance cutoff, best first. */
  suggestions: string[];
}

/** Result of {@link resolveSlackMentions}. */
export interface ResolvedSlackMentions {
  /** Session names of matched agents, in first-mention order, deduped. */
  mentions: string[];
  /** Tokens that matched nobody. */
  unknown: UnknownMention[];
}

/** Options for {@link resolveSlackMentions}. */
export interface ResolveSlackMentionsOptions {
  /** Max edit distance for a suggestion (default from constants). */
  maxDistance?: number;
  /** Max suggestions per unknown token (default from constants). */
  maxSuggestions?: number;
}

/**
 * Tokens Slack itself owns; never treated as agent names.
 * Slack usually delivers these as `<!here>` etc., but users on some clients
 * type them literally.
 */
const RESERVED_TOKENS = new Set(['here', 'channel', 'everyone', 'group']);

/**
 * `@name` where the `@` is not part of an email, a Slack native mention
 * (`<@U123>`), or a doubled `@@`. Names may contain letters (any script),
 * digits, `_`, `.` and `-`; a trailing `.`/`-` is punctuation, not name.
 */
const MENTION_TOKEN_RE = /(?<![\w<@])@([\p{L}\p{N}_.-]+)/gu;

/** Native Slack user mention: `<@U0123ABC>` or `<@U0123ABC|name>`. */
const NATIVE_MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

/**
 * Extract the user ids of native `<@U…>` mentions, in order, deduped.
 *
 * @param text - Slack message text
 * @returns Slack user ids
 */
export function extractNativeMentionIds(text: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const m of (text ?? '').matchAll(NATIVE_MENTION_RE)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    ids.push(m[1]);
  }
  return ids;
}

/**
 * Levenshtein edit distance between two strings, compared case-insensitively.
 *
 * @param a - First string
 * @param b - Second string
 * @returns The minimum number of single-character edits to turn `a` into `b`
 */
export function levenshtein(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  if (s === t) return 0;
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[t.length];
}

/**
 * The aliases a candidate answers to: its display name, the name with
 * whitespace removed, its full session name, and the short session
 * segment (`crewly-alpha-sam` → `sam`, matching the orchestrator bridge's
 * existing `@name` rule). All lower-cased.
 *
 * @param candidate - The agent
 * @returns Distinct lower-case aliases
 */
export function candidateAliases(candidate: MentionCandidate): string[] {
  const out = new Set<string>();
  const name = (candidate.name ?? '').trim().toLowerCase();
  if (name) {
    out.add(name);
    out.add(name.replace(/\s+/g, ''));
    out.add(name.replace(/\s+/g, '-'));
  }
  const session = (candidate.sessionName ?? '').trim().toLowerCase();
  if (session) {
    out.add(session);
    const parts = session.split('-');
    if (parts.length >= 3) out.add(parts.slice(2).join('-'));
  }
  out.delete('');
  return [...out];
}

/**
 * Extract the raw `@name` tokens from a message, in order, deduped
 * case-insensitively, with Slack's reserved words removed.
 *
 * @param text - Slack message text
 * @returns Tokens without the leading `@`
 */
export function extractMentionTokens(text: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const m of (text ?? '').matchAll(MENTION_TOKEN_RE)) {
    const raw = m[1].replace(/[.-]+$/u, '');
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (RESERVED_TOKENS.has(key) || seen.has(key)) continue;
    seen.add(key);
    tokens.push(raw);
  }
  return tokens;
}

/**
 * Map every `@name` in `text` to an agent session.
 *
 * Exact (case-insensitive) alias matches win. A token that matches no
 * alias is reported under `unknown` with up to `maxSuggestions` candidate
 * display names within `maxDistance` edits, closest first.
 *
 * @param text - Slack message text
 * @param candidates - The agents that can be mentioned (team members)
 * @param options - Distance and suggestion caps
 * @returns Matched sessions and unknown tokens
 *
 * @example
 * ```ts
 * resolveSlackMentions('@sam @lee 看一下', [
 *   { name: 'Sam', sessionName: 'crewly-alpha-sam' },
 *   { name: 'Leo', sessionName: 'crewly-alpha-leo' },
 * ]);
 * // → { mentions: ['crewly-alpha-sam'], unknown: [{ token: 'lee', suggestions: ['Leo'] }] }
 * ```
 */
export function resolveSlackMentions(
  text: string,
  candidates: MentionCandidate[],
  options: ResolveSlackMentionsOptions = {},
): ResolvedSlackMentions {
  const maxDistance = options.maxDistance ?? SLACK_TEAM_CHANNEL_CONSTANTS.MENTION_SUGGEST_MAX_DISTANCE;
  const maxSuggestions = options.maxSuggestions ?? SLACK_TEAM_CHANNEL_CONSTANTS.MENTION_SUGGEST_MAX;

  const aliasIndex = new Map<string, MentionCandidate>();
  for (const c of candidates) {
    for (const alias of candidateAliases(c)) {
      if (!aliasIndex.has(alias)) aliasIndex.set(alias, c);
    }
  }

  const mentions: string[] = [];
  const seenSessions = new Set<string>();
  const unknown: UnknownMention[] = [];

  // Real identities first: a native <@U…> mention of an agent's own bot user.
  const byBotUserId = new Map<string, MentionCandidate>();
  for (const c of candidates) {
    if (c.botUserId) byBotUserId.set(c.botUserId, c);
  }
  for (const id of extractNativeMentionIds(text)) {
    const hit = byBotUserId.get(id);
    if (hit && !seenSessions.has(hit.sessionName)) {
      seenSessions.add(hit.sessionName);
      mentions.push(hit.sessionName);
    }
  }

  for (const token of extractMentionTokens(text)) {
    const hit = aliasIndex.get(token.toLowerCase());
    if (hit) {
      if (!seenSessions.has(hit.sessionName)) {
        seenSessions.add(hit.sessionName);
        mentions.push(hit.sessionName);
      }
      continue;
    }
    const scored = candidates
      .map((c) => ({
        name: c.name,
        distance: Math.min(...candidateAliases(c).map((a) => levenshtein(token, a))),
      }))
      .filter((s) => s.distance <= maxDistance && s.name)
      .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
    const suggestions: string[] = [];
    for (const s of scored) {
      if (!suggestions.includes(s.name)) suggestions.push(s.name);
      if (suggestions.length >= maxSuggestions) break;
    }
    unknown.push({ token, suggestions });
  }

  return { mentions, unknown };
}

/**
 * The agent a message is plainly addressed to by opening with its name:
 * `Aria，帮我…`, `Aria, can you…`, `aria: …`, or a typed `@Aria` that Slack
 * left as plain text. Owner's rule, 2026-10-02: naming an agent at the start
 * of a message counts as addressing it, even with no `@`.
 *
 * Only the start of the message counts, so a name in the middle of a
 * sentence ("I asked Aria yesterday") addresses nobody. Matching ignores
 * case. Longer names are tried first, so "Steve Huang" wins over "Steve".
 * The name must end at a word boundary: "Ariana" and "Aria's" do not match
 * Aria, but a Latin name followed straight by Chinese (`Aria帮我`) does.
 *
 * @param text - Slack message text
 * @param candidates - Agents that can be addressed here (anything with a display name)
 * @returns The matching candidate, or null
 */
export function leadingNameMention<T extends { name: string }>(text: string, candidates: readonly T[]): T | null {
  const body = (text ?? '').replace(/^\s+/u, '').replace(/^@/u, '');
  if (!body) return null;
  const lower = body.toLowerCase();
  const sorted = [...candidates]
    .filter((c) => (c.name ?? '').trim().length > 0)
    .sort((a, b) => b.name.trim().length - a.name.trim().length);
  for (const c of sorted) {
    const name = c.name.trim().toLowerCase();
    if (!lower.startsWith(name)) continue;
    const next = body.slice(name.length);
    if (next.length === 0) return c;
    const ch = [...next][0];
    const endsLatin = /[A-Za-z0-9]$/.test(name);
    const boundary =
      !/[\p{L}\p{N}_'’]/u.test(ch) || (endsLatin && /\p{Script=Han}/u.test(ch));
    if (!boundary) continue;
    return c;
  }
  return null;
}
