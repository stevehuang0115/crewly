/**
 * Recover tool calls a model wrote as text.
 *
 * A weak model sometimes *writes* its function-call envelope into the text
 * channel instead of emitting a real tool call. The provider sees ordinary
 * prose, the AI SDK sees no tool call, the step ends — so nothing runs, and
 * the user is shown a wall of markup where an answer should be. deepseek-chat
 * does this with its own separators:
 *
 *   `<｜｜DSML｜｜ invoke name="Bash">` … `<｜｜DSML｜｜ parameter name="command" …>`
 *
 * which is Claude's `invoke`/`parameter` grammar with `｜｜DSML｜｜ ` (U+FF5C
 * pipes) where the namespace prefix goes. Nothing in Crewly teaches that
 * format — the model emits it on its own (2026-09-19, #crewly-support).
 *
 * Stripping the markup hides the symptom and still loses the work. This
 * module instead *parses* the envelope so the runtime can execute what the
 * model meant to call and hand the results back, turning a dead turn into a
 * working one. Matching is by **shape**, never by a list of known names: the
 * prefix is whatever the model felt like emitting.
 *
 * @module runtime/text-tool-calls
 */

/** One tool call recovered from text. Values are raw, as written. */
export interface TextToolCall {
  /** Tool name from the `name="…"` attribute. */
  toolName: string;
  /** Parameter name → raw text value. */
  args: Record<string, string>;
}

/** Result of {@link parseTextToolCalls}. */
export interface ParsedTextToolCalls {
  /** The calls found, in the order they were written. */
  calls: TextToolCall[];
  /** The same text with every envelope removed and whitespace tidied. */
  text: string;
}

/** Anything with a Zod-style `safeParse` — kept duck-typed so this module stays dependency-free. */
export interface SchemaLike {
  safeParse(value: unknown): { success: boolean; data?: unknown; error?: { message?: string } };
}

/** Result of {@link coerceArgs}. */
export interface CoercedArgs {
  /** Arguments to pass to the tool. */
  args: Record<string, unknown>;
  /** Why the schema rejected them, when it did. */
  error?: string;
}

/**
 * A tag like `<invoke …>`, `</invoke>`, `<｜｜DSML｜｜ parameter …>` — any
 * junk or namespace before the name, anything but `<`/`>` after it.
 *
 * @param name - Tag-name pattern
 * @param closing - Match the closing form
 * @returns The pattern source
 */
function tagSource(name: string, closing: boolean): string {
  return `<${closing ? '\\s*/' : ''}[^<>]{0,40}?${name}\\b[^<>]*>`;
}

/** Wrapper the model puts around a batch of calls: `function_calls`, `tool_calls`, or a bare `calls`. */
const WRAPPER_NAME = '(?:function_calls|tool_calls|(?<![A-Za-z_])calls)';

const INVOKE_OPEN = new RegExp(tagSource('invoke', false), 'gi');
const INVOKE_CLOSE = new RegExp(tagSource('invoke', true), 'i');
const PARAM_OPEN = new RegExp(tagSource('parameter', false), 'gi');
const PARAM_CLOSE = new RegExp(tagSource('parameter', true), 'i');

/** `name="x"` / `name='x'` / `name=x` inside a tag. */
const NAME_ATTR = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/i;

/** Well-formed `<x>…</x>` blocks, for removal. */
const BLOCK_PATTERNS = [WRAPPER_NAME, 'invoke'].map(
  (name) => new RegExp(`${tagSource(name, false)}[\\s\\S]*?${tagSource(name, true)}`, 'gi'),
);

/** An opening tag with no close — the output was cut off mid-call. */
const UNCLOSED_PATTERN = new RegExp(`(?:${tagSource(WRAPPER_NAME, false)}|${tagSource('invoke', false)})[\\s\\S]*$`, 'i');

/** Any leftover lone tag. */
const LONE_TAG_PATTERN = new RegExp(
  [WRAPPER_NAME, 'invoke', 'parameter'].map((name) => `${tagSource(name, false)}|${tagSource(name, true)}`).join('|'),
  'gi',
);

/** A value that is plainly JSON rather than prose. */
const JSONISH = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\{[\s\S]*\}|\[[\s\S]*\])$/;

/**
 * Read the `name="…"` attribute out of an opening tag.
 *
 * @param tag - The whole tag, angle brackets included
 * @returns The name, or '' when the tag has none
 */
function nameOf(tag: string): string {
  const m = NAME_ATTR.exec(tag);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim();
}

/**
 * Split text into segments, marking the fenced ones.
 *
 * Markup inside a ``` fence is an example the agent meant to show — it is
 * neither executed nor stripped.
 *
 * @param input - Raw text
 * @returns Segments; odd indexes are fenced code
 */
function splitOnFences(input: string): string[] {
  return input.split(/(```[\s\S]*?```)/g);
}

/**
 * Parse the `parameter` blocks inside one `invoke` body.
 *
 * A block runs to its closing tag, or — when the model never wrote one — to
 * the next parameter or the end of the body, so a truncated call still yields
 * the arguments it managed to write.
 *
 * @param body - Text between the invoke tags
 * @returns Parameter name → raw value
 */
function parseParams(body: string): Record<string, string> {
  const args: Record<string, string> = {};
  PARAM_OPEN.lastIndex = 0;
  const opens: Array<{ name: string; from: number }> = [];
  for (let m = PARAM_OPEN.exec(body); m; m = PARAM_OPEN.exec(body)) {
    opens.push({ name: nameOf(m[0]), from: m.index + m[0].length });
  }
  opens.forEach((open, i) => {
    const until = i + 1 < opens.length ? body.lastIndexOf('<', opens[i + 1].from) : body.length;
    const slice = body.slice(open.from, Math.max(until, open.from));
    const close = PARAM_CLOSE.exec(slice);
    const value = close ? slice.slice(0, close.index) : slice;
    if (open.name) args[open.name] = value.replace(/^\r?\n/, '').replace(/\s+$/, '');
  });
  return args;
}

/**
 * Find every tool call written as text, and return the text without them.
 *
 * @param raw - The model's text output
 * @returns The recovered calls and the cleaned text
 *
 * @example
 * parseTextToolCalls('<invoke name="bash_exec"><parameter name="command">ls</parameter></invoke>')
 * // → { calls: [{ toolName: 'bash_exec', args: { command: 'ls' } }], text: '' }
 */
export function parseTextToolCalls(raw: string): ParsedTextToolCalls {
  const input = raw ?? '';
  if (!input) return { calls: [], text: '' };

  const calls: TextToolCall[] = [];
  const cleaned = splitOnFences(input)
    .map((segment, i) => {
      if (i % 2 === 1) return segment; // fenced code — an example, not a call

      INVOKE_OPEN.lastIndex = 0;
      const opens: Array<{ name: string; from: number }> = [];
      for (let m = INVOKE_OPEN.exec(segment); m; m = INVOKE_OPEN.exec(segment)) {
        opens.push({ name: nameOf(m[0]), from: m.index + m[0].length });
      }
      opens.forEach((open, idx) => {
        // An unclosed invoke runs to the next one, or to the end of the text.
        const until = idx + 1 < opens.length ? segment.lastIndexOf('<', opens[idx + 1].from) : segment.length;
        const slice = segment.slice(open.from, Math.max(until, open.from));
        const close = INVOKE_CLOSE.exec(slice);
        const body = close ? slice.slice(0, close.index) : slice;
        if (open.name) calls.push({ toolName: open.name, args: parseParams(body) });
      });

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

  return { calls, text };
}

/**
 * Whether text contains something that looks like a tool-call envelope.
 *
 * @param raw - Candidate text
 * @returns True when an `invoke` or wrapper tag is present
 */
export function hasTextToolCalls(raw: string): boolean {
  return new RegExp(`${tagSource(WRAPPER_NAME, false)}|${tagSource('invoke', false)}`, 'i').test(raw ?? '');
}

/**
 * Turn the raw string values of a recovered call into arguments the tool accepts.
 *
 * Everything written in text arrives as a string, but a schema may want a
 * number, a boolean or an object. Strings are tried first, so a tool that
 * genuinely wants the string `"42"` still gets it; only if the schema refuses
 * are JSON-looking values parsed.
 *
 * @param raw - Parameter name → raw text value
 * @param schema - The tool's input schema, when it has one
 * @returns The arguments, and the schema's complaint if it still refuses them
 *
 * @example
 * coerceArgs({ timeout: '5000' }, z.object({ timeout: z.number() }))
 * // → { args: { timeout: 5000 } }
 */
export function coerceArgs(raw: Record<string, string>, schema?: SchemaLike): CoercedArgs {
  const coerced: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const trimmed = value.trim();
    if (JSONISH.test(trimmed)) {
      try {
        coerced[key] = JSON.parse(trimmed);
        continue;
      } catch {
        // Not valid JSON after all — keep the text.
      }
    }
    coerced[key] = value;
  }

  if (!schema || typeof schema.safeParse !== 'function') return { args: coerced };
  if (schema.safeParse(raw).success) return { args: raw };

  const second = schema.safeParse(coerced);
  if (second.success) return { args: coerced };

  return { args: coerced, error: second.error?.message ?? 'arguments did not match the tool schema' };
}
