/**
 * Tests for recovering tool calls a model wrote as text.
 *
 * The bug these lock down: deepseek-chat writes its call envelope into the
 * text channel with its own separators (`<｜｜DSML｜｜ invoke name="Bash">`),
 * so no tool ever ran and the user was shown the markup instead of an answer
 * (2026-09-19). Matching is by shape — a new prefix must not defeat it.
 */

import { describe, it, expect } from 'vitest';
import { parseTextToolCalls, hasTextToolCalls, coerceArgs, type SchemaLike } from './text-tool-calls.js';

/** The exact bytes deepseek-chat emitted, taken from ~/.crewly/chat.db. */
const DSML = [
  'Let me check the repo.',
  '<｜｜DSML｜｜ calls>',
  '<｜｜DSML｜｜ invoke name="bash_exec">',
  '<｜｜DSML｜｜ parameter name="command" string="true">git status --short</｜｜DSML｜｜ parameter>',
  '<｜｜DSML｜｜ parameter name="timeout" string="true">5000</｜｜DSML｜｜ parameter>',
  '</｜｜DSML｜｜ invoke>',
  '</｜｜DSML｜｜ calls>',
].join('\n');

/** A minimal Zod-style schema. */
function schema(check: (v: Record<string, unknown>) => boolean): SchemaLike {
  return { safeParse: (v: unknown) => (check(v as Record<string, unknown>) ? { success: true, data: v } : { success: false, error: { message: 'bad args' } }) };
}

describe('parseTextToolCalls', () => {
  it('recovers the deepseek envelope, prefix and all, and leaves the prose', () => {
    const { calls, text } = parseTextToolCalls(DSML);
    expect(calls).toEqual([
      { toolName: 'bash_exec', args: { command: 'git status --short', timeout: '5000' } },
    ]);
    expect(text).toBe('Let me check the repo.');
  });

  it('recovers the plain Claude-style envelope too', () => {
    const { calls } = parseTextToolCalls('<function_calls><invoke name="read_file"><parameter name="path">a.ts</parameter></invoke></function_calls>');
    expect(calls).toEqual([{ toolName: 'read_file', args: { path: 'a.ts' } }]);
  });

  it('recovers every call in a batch, in order', () => {
    const { calls } = parseTextToolCalls(
      '<invoke name="a"><parameter name="x">1</parameter></invoke><invoke name="b"><parameter name="y">2</parameter></invoke>',
    );
    expect(calls.map((c) => c.toolName)).toEqual(['a', 'b']);
    expect(calls[1].args).toEqual({ y: '2' });
  });

  it('keeps a multi-line value intact, including its own angle brackets', () => {
    const { calls } = parseTextToolCalls(
      '<invoke name="write_file"><parameter name="content">line 1\nif (a < b) { go(); }\nline 3</parameter></invoke>',
    );
    expect(calls[0].args.content).toBe('line 1\nif (a < b) { go(); }\nline 3');
  });

  it('salvages a call the model never closed', () => {
    const { calls, text } = parseTextToolCalls('Working.\n<invoke name="bash_exec"><parameter name="command">npm test');
    expect(calls).toEqual([{ toolName: 'bash_exec', args: { command: 'npm test' } }]);
    expect(text).toBe('Working.');
  });

  it('leaves a fenced example alone — it is documentation, not a call', () => {
    const raw = 'Here is the syntax:\n\n```\n<invoke name="bash_exec"><parameter name="command">ls</parameter></invoke>\n```';
    const { calls, text } = parseTextToolCalls(raw);
    expect(calls).toEqual([]);
    expect(text).toBe(raw);
  });

  it('finds nothing in ordinary prose, and does not touch it', () => {
    for (const prose of ['', 'The build recalls the cached layer.', 'Use <Parameter> in the docs? no.']) {
      expect(parseTextToolCalls(prose).calls).toEqual([]);
    }
    expect(parseTextToolCalls('The build recalls the cached layer.').text).toBe('The build recalls the cached layer.');
  });

  it('ignores an invoke tag with no name rather than inventing one', () => {
    expect(parseTextToolCalls('<invoke><parameter name="x">1</parameter></invoke>').calls).toEqual([]);
  });
});

describe('hasTextToolCalls', () => {
  it('is true for any prefix and false for prose', () => {
    expect(hasTextToolCalls(DSML)).toBe(true);
    expect(hasTextToolCalls('<invoke name="x">')).toBe(true);
    expect(hasTextToolCalls('nothing to see')).toBe(false);
  });
});

describe('coerceArgs', () => {
  it('passes strings through when the schema accepts them', () => {
    const out = coerceArgs({ command: '5' }, schema((v) => typeof v.command === 'string'));
    expect(out).toEqual({ args: { command: '5' } });
  });

  it('parses JSON-looking values only when the schema refuses the strings', () => {
    const out = coerceArgs({ timeout: '5000', on: 'true', tags: '["a"]' }, schema((v) => typeof v.timeout === 'number'));
    expect(out.args).toEqual({ timeout: 5000, on: true, tags: ['a'] });
    expect(out.error).toBeUndefined();
  });

  it('coerces with no schema to give the tool its best shot', () => {
    expect(coerceArgs({ n: '3', s: 'hello' }).args).toEqual({ n: 3, s: 'hello' });
  });

  it('reports the schema complaint instead of calling a tool with bad arguments', () => {
    const out = coerceArgs({ command: 'ls' }, schema((v) => typeof v.path === 'string'));
    expect(out.error).toBe('bad args');
  });

  it('keeps a value that only looks like JSON', () => {
    expect(coerceArgs({ command: '{ not json' }).args).toEqual({ command: '{ not json' });
  });
});
