/**
 * Tests for checkpoint evaluation.
 *
 * A checkpoint is the only thing that can call a desktop subgoal done, so a
 * checkpoint that passes when it should not is worse than having none: it
 * launders the agent's claim into a verified fact.
 */

import { describe, it, expect } from 'vitest';
import { evaluateCheckpoint, describeCheckpoint, type Checkpoint } from './desktop-checkpoint.js';

/** IO over a fake filesystem. */
function fs(files: Record<string, string>) {
  return {
    readFile: async (p: string) => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p]!;
    },
    statFile: async (p: string) => {
      if (!(p in files)) throw new Error('ENOENT');
      return { size: files[p]!.length };
    },
  };
}

describe('file checkpoints', () => {
  it('fails an empty file — the signature of a save that never completed', async () => {
    const out = await evaluateCheckpoint({ kind: 'file-exists', path: '/a' }, fs({ '/a': '' }));
    expect(out.passed).toBe(false);
    expect(out.reason).toMatch(/empty/);
  });

  it('allows an empty file when the task said so', async () => {
    expect((await evaluateCheckpoint({ kind: 'file-exists', path: '/a', allowEmpty: true }, fs({ '/a': '' }))).passed).toBe(true);
  });

  it('says the file is missing rather than just failing', async () => {
    const out = await evaluateCheckpoint({ kind: 'file-exists', path: '/nope' }, fs({}));
    expect(out.reason).toContain('/nope');
  });

  it('shows what the file does say when the content is wrong', async () => {
    const out = await evaluateCheckpoint({ kind: 'file-contains', path: '/a', text: 'hello' }, fs({ '/a': 'goodbye' }));
    expect(out.passed).toBe(false);
    expect(out.observed).toBe('goodbye');
  });

  it('matches a pattern', async () => {
    expect((await evaluateCheckpoint({ kind: 'file-matches', path: '/a', pattern: '^\\d+$' }, fs({ '/a': '42' }))).passed).toBe(true);
    expect((await evaluateCheckpoint({ kind: 'file-matches', path: '/a', pattern: '^\\d+$' }, fs({ '/a': 'x' }))).passed).toBe(false);
  });

  it('checks the other half of a rename', async () => {
    expect((await evaluateCheckpoint({ kind: 'file-absent', path: '/old' }, fs({}))).passed).toBe(true);
    expect((await evaluateCheckpoint({ kind: 'file-absent', path: '/old' }, fs({ '/old': 'x' }))).passed).toBe(false);
  });
});

describe('screen checkpoints', () => {
  const snapshot = async () => [
    { role: 'AXButton', name: 'Save' },
    { role: 'AXStaticText', name: 'Untitled document' },
  ];

  it('finds an element by name, and by role when given one', async () => {
    expect((await evaluateCheckpoint({ kind: 'element-present', name: 'Save' }, { snapshot })).passed).toBe(true);
    expect((await evaluateCheckpoint({ kind: 'element-present', name: 'Save', role: 'AXButton' }, { snapshot })).passed).toBe(true);
    expect((await evaluateCheckpoint({ kind: 'element-present', name: 'Save', role: 'AXMenuItem' }, { snapshot })).passed).toBe(false);
  });

  it('checks a dialog is gone, which is how "closed it" is proved', async () => {
    expect((await evaluateCheckpoint({ kind: 'element-absent', name: 'Save' }, { snapshot })).passed).toBe(false);
    expect((await evaluateCheckpoint({ kind: 'element-absent', name: 'Nothing' }, { snapshot })).passed).toBe(true);
  });

  it('reads text off the screen for apps with no element tree', async () => {
    const screenText = async () => ['CREWLY EVAL 7734'];
    expect((await evaluateCheckpoint({ kind: 'text-on-screen', text: 'eval 7734' }, { screenText })).passed).toBe(true);
    expect((await evaluateCheckpoint({ kind: 'text-on-screen', text: 'absent' }, { screenText })).passed).toBe(false);
  });

  it('compares the frontmost app case-insensitively and reports what is actually there', async () => {
    const frontmostApp = async () => 'TextEdit';
    expect((await evaluateCheckpoint({ kind: 'app-frontmost', app: 'textedit' }, { frontmostApp })).passed).toBe(true);
    const out = await evaluateCheckpoint({ kind: 'app-frontmost', app: 'Numbers' }, { frontmostApp });
    expect(out.observed).toBe('TextEdit');
  });

  it('fails rather than pretends when it cannot see', async () => {
    // No snapshot dependency wired: it must not quietly pass.
    expect((await evaluateCheckpoint({ kind: 'element-present', name: 'Save' }, {})).passed).toBe(false);
    expect((await evaluateCheckpoint({ kind: 'text-on-screen', text: 'x' }, {})).passed).toBe(false);
    expect((await evaluateCheckpoint({ kind: 'app-frontmost', app: 'x' }, {})).passed).toBe(false);
  });
});

describe('shell checkpoints', () => {
  it('passes on exit zero and reports the output on failure', async () => {
    const runShell = async (c: string) =>
      c === 'true' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'boom' };
    expect((await evaluateCheckpoint({ kind: 'shell', command: 'true' }, { runShell })).passed).toBe(true);
    const out = await evaluateCheckpoint({ kind: 'shell', command: 'false' }, { runShell });
    expect(out.passed).toBe(false);
    expect(out.observed).toBe('boom');
  });
});

describe('robustness', () => {
  it('turns a thrown check into a failed one, never an exception', async () => {
    const out = await evaluateCheckpoint({ kind: 'file-exists', path: '/a' }, {
      statFile: async () => { throw new Error('disk on fire'); },
    });
    // A broken check must not read as a broken task, but it must not pass.
    expect(out.passed).toBe(false);
  });
});

describe('describeCheckpoint', () => {
  it('reads as a sentence for every kind', () => {
    const all: Checkpoint[] = [
      { kind: 'file-exists', path: '/a' },
      { kind: 'file-contains', path: '/a', text: 'x' },
      { kind: 'file-matches', path: '/a', pattern: 'x' },
      { kind: 'file-absent', path: '/a' },
      { kind: 'app-frontmost', app: 'Finder' },
      { kind: 'element-present', name: 'Save' },
      { kind: 'element-absent', name: 'Save' },
      { kind: 'text-on-screen', text: 'hi' },
      { kind: 'shell', command: 'true' },
    ];
    for (const cp of all) {
      expect(describeCheckpoint(cp).length).toBeGreaterThan(5);
    }
    expect(describeCheckpoint({ kind: 'shell', command: 'x', description: 'the build passes' })).toBe('the build passes');
  });
});
