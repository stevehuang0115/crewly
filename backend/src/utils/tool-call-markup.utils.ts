/**
 * Strip tool-call markup an LLM emitted as prose.
 *
 * Models occasionally write their function-call envelope into the *text*
 * part of a turn instead of (or as well as) making a real tool call. For a
 * PTY runtime nobody sees it, but the in-process Crewly Agent forwards its
 * text straight to Slack and chat, so the user gets a wall of
 * `<invoke name="Bash">…` instead of an answer (2026-09-19, #crewly-support).
 *
 * This removes those envelopes — `function_calls` wrappers, `invoke`
 * blocks and stray `parameter` tags, with or without a namespace prefix —
 * while leaving fenced code blocks untouched, so an agent that is
 * deliberately *explaining* the syntax keeps its example.
 *
 * @module utils/tool-call-markup
 */

/** Tag names that only ever appear in a tool-call envelope. */
const ENVELOPE_TAGS = ['function_calls', 'invoke', 'parameter'] as const;

/**
 * A tag like `<invoke …>`, `</invoke>`, `<｜｜antml｜｜invoke>` —
 * any junk/namespace before the name, anything but `<`/`>` after it.
 *
 * @param name - Tag name
 * @param closing - Match the closing form
 * @returns The pattern source
 */
function tagSource(name: string, closing: boolean): string {
  return `<${closing ? '\\s*/' : ''}[^<>]{0,40}?\\b${name}\\b[^<>]*>`;
}

/** Well-formed `<x>…</x>` blocks for the wrapper tags. */
const BLOCK_PATTERNS = ['function_calls', 'invoke'].map(
  (name) => new RegExp(`${tagSource(name, false)}[\\s\\S]*?${tagSource(name, true)}`, 'gi'),
);

/** An opening wrapper tag with no close — the output was cut off mid-call. */
const UNCLOSED_PATTERN = new RegExp(`(?:${tagSource('function_calls', false)}|${tagSource('invoke', false)})[\\s\\S]*$`, 'i');

/** Any leftover lone tag. */
const LONE_TAG_PATTERN = new RegExp(
  ENVELOPE_TAGS.map((name) => `${tagSource(name, false)}|${tagSource(name, true)}`).join('|'),
  'gi',
);

/** Result of {@link stripToolCallMarkup}. */
export interface StrippedText {
  /** The text with tool-call envelopes removed and whitespace tidied. */
  text: string;
  /** True when something was removed. */
  stripped: boolean;
}

/**
 * Whether a string contains something that looks like a tool-call envelope.
 *
 * @param raw - Candidate text
 * @returns True when an `invoke` / `function_calls` tag is present
 */
export function hasToolCallMarkup(raw: string): boolean {
  return new RegExp(`${tagSource('function_calls', false)}|${tagSource('invoke', false)}`, 'i').test(raw ?? '');
}

/**
 * Remove tool-call markup from an agent's text response.
 *
 * Fenced code blocks (``` … ```) are passed through untouched: markup
 * inside them is an example the agent meant to show.
 *
 * @param raw - The agent's text
 * @returns The cleaned text and whether anything was removed
 *
 * @example
 * stripToolCallMarkup('Working on it.\n<invoke name="Bash">…</invoke>')
 * // → { text: 'Working on it.', stripped: true }
 */
export function stripToolCallMarkup(raw: string): StrippedText {
  const input = raw ?? '';
  if (!input) return { text: '', stripped: false };

  // Split on fences so the segments at odd indexes are fenced code.
  const segments = input.split(/(```[\s\S]*?```)/g);
  const cleaned = segments
    .map((segment, i) => {
      if (i % 2 === 1) return segment; // fenced code — leave alone
      let out = segment;
      for (const pattern of BLOCK_PATTERNS) out = out.replace(pattern, '');
      out = out.replace(UNCLOSED_PATTERN, '');
      return out.replace(LONE_TAG_PATTERN, '');
    })
    .join('');

  const text = cleaned
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text, stripped: text !== input.trim() };
}
