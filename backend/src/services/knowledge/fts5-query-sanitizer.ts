/**
 * FTS5 Query Sanitizer
 *
 * Pure helper that converts an arbitrary input string into a safe SQLite FTS5
 * MATCH query via phrase-quote tokenization. Used by
 * {@link Fts5IndexService.search} so that programmatically constructed
 * agent-context strings never accidentally parse as FTS5 operators.
 *
 * **Why this helper exists.** SQLite FTS5 has a rich query grammar with
 * column filters (`column:term`), set-column lists (`{c1, c2}: term`),
 * phrase syntax (`"phrase"`), boolean operators (`AND`, `OR`, `NOT`),
 * proximity (`NEAR(...)`), prefix (`term*`), and grouping (`(...)`). When
 * arbitrary user / agent-context text is concatenated into a MATCH query,
 * these operators trigger:
 *
 * - **commas** are parsed as column-list separators →
 *   `fts5: syntax error near ","` (e.g. `"foo, bar"` blows up)
 * - **hyphens inside identifiers** like `team-leader` parse as `team`
 *   followed by column filter `-leader` → `no such column: leader`
 * - **colons** parse as column filter operator → `no such column: ...`
 * - **bare AND / OR / NOT** in mixed-case input parse as keywords
 *
 * The previous regex-strip sanitizer at `Fts5IndexService.search` only
 * removed `' " * ( ) { } [ ] ^ ~ \\` — it left commas, hyphens, colons, and
 * all FTS5 keywords intact. Result: 44 silent search failures per day
 * (22 comma + 22 hyphen) for agent recall on 2026-05-07 alone.
 *
 * **Approach (Kai's WI-E F-FTS5 triage recommendation).** Split tokens on
 * **whitespace + comma only** — NOT on word boundaries — then wrap each
 * non-empty token in double quotes for FTS5 phrase syntax. Phrases are
 * **literal** — no operator parsing happens inside the quotes — so any
 * residual operator-like content (hyphens, colons, asterisks, AND/OR/NOT
 * keywords) is neutralized. Tokens are joined with whitespace, which FTS5
 * treats as implicit AND.
 *
 * **Why split on whitespace+comma instead of word boundaries.** A token like
 * `team-leader` wrapped as the phrase `"team-leader"` is parsed by FTS5's
 * MATCH parser as a single phrase node, then internally the
 * `unicode61` tokenizer (used at index time) splits the phrase into
 * adjacent tokens `team` + `leader`. The MATCH operation thus requires
 * those tokens to appear adjacent in the document — which matches docs
 * that were indexed with `team-leader` exactly. Splitting on word
 * boundaries at query-time would produce `"team" "leader"` (loose AND),
 * matching docs with `team` and `leader` anywhere — looser than the
 * caller intended. **Kai's approach preserves precision for hyphenated
 * identifiers without losing the comma/colon-safety win.**
 *
 * **Trade-off (intentional).** This sanitizer DROPS FTS5 operator support:
 * `AND`, `OR`, `NOT`, `NEAR(...)`, column-filter prefixes, and prefix
 * wildcards (`term*`) all become literal phrases. All callers on this
 * path are auto-generated agent-context strings, not user-typed search
 * queries — they don't need operator support. If a future caller needs
 * the full FTS5 grammar, expose a separate `searchRaw()` API rather than
 * loosening this sanitizer.
 *
 * @module services/knowledge/fts5-query-sanitizer
 */

/**
 * Convert an arbitrary input string into a safe FTS5 MATCH query via
 * phrase-quote tokenization.
 *
 * The result is one of:
 * - `''` — when the input is empty / whitespace-only / only contains
 *   delimiter characters. Callers MUST check for empty and skip the
 *   MATCH query (return empty results).
 * - `'"tok1" "tok2" ..."'` — a sequence of double-quoted phrases joined
 *   by whitespace (implicit AND in FTS5).
 *
 * Pre-existing double quotes inside a token are escaped per FTS5 phrase
 * syntax (`"` → `""`). This is defensive — auto-generated context
 * strings rarely contain quotes — but it makes the helper safely
 * reusable beyond the current call site.
 *
 * @param input - Raw query string from user input or agent-context concat.
 * @returns Safe FTS5 MATCH expression, or `''` if no tokens remain.
 *
 * @example
 * ```typescript
 * toFts5Phrase('developer session startup');
 * // → '"developer" "session" "startup"'
 *
 * toFts5Phrase('developer session startup, recent tasks, unfinished work');
 * // → '"developer" "session" "startup" "recent" "tasks" "unfinished" "work"'
 * // (comma fix — was: "syntax error near ',''")
 *
 * toFts5Phrase('team-leader session startup');
 * // → '"team-leader" "session" "startup"'
 * // (hyphen fix — was: "no such column: leader". The phrase `"team-leader"`
 * //  matches docs indexed with `team-leader` exactly, since the unicode61
 * //  tokenizer splits the phrase content the same way at both index and
 * //  query time.)
 *
 * toFts5Phrase('say "hello" world');
 * // → '"say" """hello""" "world"'    (quotes escaped as "")
 *
 * toFts5Phrase('   ,  ');             // → ''
 * toFts5Phrase('***');                // → '"***"'  (literal phrase, FTS5 strips
 *                                     //   non-word chars at tokenization → no match)
 * ```
 */
export function toFts5Phrase(input: string): string {
  if (!input) {
    return '';
  }

  return input
    // Split on whitespace + comma only. NOT on word boundaries — see module
    // doc above for why preserving hyphens/colons inside tokens is correct.
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    // Escape pre-existing double quotes per FTS5 phrase syntax (`"` → `""`),
    // then wrap the whole token in double quotes. The result is always a
    // valid FTS5 phrase even if the token contained operator-like
    // punctuation (hyphens, colons, asterisks, parens, etc.).
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' ');
}
