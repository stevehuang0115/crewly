/**
 * Unit tests for {@link toFts5Phrase} — pure, no SQLite dependency.
 *
 * The integration-side tests (which exercise the sanitizer through
 * {@link Fts5IndexService.search} against a real FTS5 index) live in
 * `fts5-index.service.test.ts`. They skip locally when the better-sqlite3
 * native binary is missing for the host architecture, but run in CI.
 *
 * These tests are sqlite-free so they ALWAYS run — including locally — and
 * pin the F-FTS5 hotfix contract: F-FTS5 was Kai's WI-E triage finding
 * (44 daily occurrences: 22 comma + 22 hyphen `team-leader` failures in
 * agent recall MATCH queries).
 *
 * @module services/knowledge/fts5-query-sanitizer.test
 */

import { toFts5Phrase } from './fts5-query-sanitizer.js';

describe('toFts5Phrase', () => {
  describe('empty / whitespace inputs return empty string', () => {
    it('returns empty string for empty input', () => {
      expect(toFts5Phrase('')).toBe('');
    });

    it('returns empty string for whitespace-only input', () => {
      expect(toFts5Phrase('   ')).toBe('');
      expect(toFts5Phrase('\t\n  ')).toBe('');
    });

    it('returns empty string for delimiter-only input', () => {
      expect(toFts5Phrase(',,,')).toBe('');
      expect(toFts5Phrase('  ,  ')).toBe('');
      expect(toFts5Phrase(' , , ')).toBe('');
    });
  });

  describe('happy-path tokenization', () => {
    it('wraps a single token in double quotes', () => {
      expect(toFts5Phrase('foo')).toBe('"foo"');
    });

    it('whitespace-separated tokens become implicit-AND quoted phrases', () => {
      // Kai's spec test #1
      expect(toFts5Phrase('developer session startup')).toBe(
        '"developer" "session" "startup"',
      );
    });

    it('collapses runs of whitespace', () => {
      expect(toFts5Phrase('  multiple   spaces\there  ')).toBe(
        '"multiple" "spaces" "here"',
      );
    });
  });

  describe('F-FTS5 BUG-FIX: comma-delimited input no longer breaks the parser', () => {
    it('comma-separated phrases tokenize cleanly (Kai spec test #2)', () => {
      // The exact failure mode in 22/44 daily occurrences: agent recall
      // contexts that say "developer session startup, recent tasks,
      // unfinished work" used to raise `fts5: syntax error near ","`.
      const input =
        'developer session startup, recent tasks, unfinished work';
      const expected =
        '"developer" "session" "startup" "recent" "tasks" "unfinished" "work"';
      expect(toFts5Phrase(input)).toBe(expected);
    });

    it('comma-only delimiter (no whitespace) tokenizes', () => {
      expect(toFts5Phrase('a,b,c')).toBe('"a" "b" "c"');
    });

    it('mixed comma + whitespace runs collapse', () => {
      expect(toFts5Phrase('a, b , c   ,   d')).toBe('"a" "b" "c" "d"');
    });

    it('Kai spec test #7 — realistic recall-context smoke', () => {
      const input = 'P1 Bug A, intent classifier ZH parity';
      const expected =
        '"P1" "Bug" "A" "intent" "classifier" "ZH" "parity"';
      expect(toFts5Phrase(input)).toBe(expected);
    });
  });

  describe('F-FTS5 BUG-FIX: hyphenated tokens preserved as phrases', () => {
    it('hyphenated role names stay inside one phrase (Kai spec test #3)', () => {
      // The exact failure mode in 22/44 daily occurrences: agent role
      // strings like `team-leader` used to raise `no such column: leader`
      // because FTS5 parsed `-leader` as column-filter exclusion.
      //
      // The phrase `"team-leader"` is safe because FTS5's MATCH parser
      // does not interpret operators INSIDE phrase quotes. The unicode61
      // tokenizer then splits the phrase content into adjacent tokens
      // `team`+`leader` for matching against the index — preserving
      // recall against documents indexed with `team-leader` exactly.
      expect(toFts5Phrase('team-leader session startup')).toBe(
        '"team-leader" "session" "startup"',
      );
    });

    it('multi-segment hyphenated identifiers preserved', () => {
      expect(toFts5Phrase('crewly-product-max-358c7cb7')).toBe(
        '"crewly-product-max-358c7cb7"',
      );
    });

    it('leading and trailing hyphens preserved (no column-filter ambiguity)', () => {
      // A bare leading `-` would have been parsed as exclusion; phrase-
      // wrapping makes it a literal token that FTS5 will tokenize and
      // search for inside the index.
      expect(toFts5Phrase('-flag')).toBe('"-flag"');
      expect(toFts5Phrase('flag-')).toBe('"flag-"');
    });
  });

  describe('colon-bearing tokens (column-filter trap) neutralized', () => {
    it('colon-prefixed and colon-mid tokens preserved as phrases (Kai spec test #4)', () => {
      expect(toFts5Phrase('task: review prompt:builder')).toBe(
        '"task:" "review" "prompt:builder"',
      );
    });

    it('column-filter-style input becomes literal phrases', () => {
      // Without the sanitizer, `category:onboarding` would parse as a
      // column filter against a `category` column; now it's just a
      // phrase that the index won't match (FTS5 strips the colon at
      // tokenization).
      expect(toFts5Phrase('category:onboarding')).toBe('"category:onboarding"');
    });
  });

  describe('quote escaping (defensive — `"` → `""` per FTS5 phrase syntax)', () => {
    it('single embedded quote is doubled (Kai spec test #5)', () => {
      // `say "hello" world` has a token `"hello"` after splitting on
      // whitespace — the literal quote chars survive (split is on
      // [\s,]+, NOT on quote). Each quote inside the token is doubled
      // per FTS5 phrase syntax, then the whole token is wrapped.
      expect(toFts5Phrase('say "hello" world')).toBe(
        '"say" """hello""" "world"',
      );
    });

    it('repeated quotes are each doubled', () => {
      expect(toFts5Phrase('a"b"c')).toBe('"a""b""c"');
    });
  });

  describe('FTS5 operator neutralization (intentional trade-off)', () => {
    it('AND / OR / NOT keywords become literal phrases', () => {
      // Documented trade-off: this sanitizer drops FTS5 operator
      // support. All callers on this path are auto-generated context
      // strings; if a future caller needs operators, expose a separate
      // searchRaw() API.
      expect(toFts5Phrase('foo AND bar')).toBe('"foo" "AND" "bar"');
      expect(toFts5Phrase('foo OR bar')).toBe('"foo" "OR" "bar"');
    });

    it('parentheses and other punctuation survive inside phrases (no parser trap)', () => {
      // Without phrase-wrapping, these would have hit the FTS5 parser
      // and broken. Inside a phrase, they are literal — the unicode61
      // tokenizer strips them at index/query time.
      expect(toFts5Phrase('(grouped)')).toBe('"(grouped)"');
      expect(toFts5Phrase('star*term')).toBe('"star*term"');
    });
  });

  describe('unicode safety', () => {
    it('non-ASCII tokens are preserved verbatim inside phrases', () => {
      expect(toFts5Phrase('日本語 测试 한국어')).toBe(
        '"日本語" "测试" "한국어"',
      );
    });

    it('emoji-bearing tokens are preserved (FTS5 strips them at tokenization)', () => {
      expect(toFts5Phrase('hello 🌟 world')).toBe('"hello" "🌟" "world"');
    });
  });
});
