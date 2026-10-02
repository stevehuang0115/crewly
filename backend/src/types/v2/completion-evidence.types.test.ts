/**
 * Tests for the completion evidence shape validator (#873).
 *
 * @module types/v2/completion-evidence.types.test
 */

import { COMPLETION_EVIDENCE_CONSTANTS } from '../../constants.js';
import { isCompletionEvidence, validateCompletionEvidence } from './completion-evidence.types.js';

describe('validateCompletionEvidence', () => {
  it('accepts each entry type and copies only known fields', () => {
    const v = validateCompletionEvidence([
      { type: 'artifact', path: ' /tmp/out.txt ', extra: 1 },
      { type: 'command', command: 'npm test', exitCode: 0, outputTail: 'ok' },
      { type: 'command', command: 'tsc', exitCode: 2 },
      { type: 'blocked', step: 'deploy', reason: 'no credentials' },
    ]);
    expect(v).toEqual({
      ok: true,
      evidence: [
        { type: 'artifact', path: '/tmp/out.txt' },
        { type: 'command', command: 'npm test', exitCode: 0, outputTail: 'ok' },
        { type: 'command', command: 'tsc', exitCode: 2 },
        { type: 'blocked', step: 'deploy', reason: 'no credentials' },
      ],
    });
  });

  it('accepts an empty array (the caller decides whether that is enough)', () => {
    expect(validateCompletionEvidence([])).toEqual({ ok: true, evidence: [] });
  });

  it.each([
    ['a string', 'did it', 'must be an array'],
    ['an object', { type: 'artifact', path: '/x' }, 'must be an array'],
    ['undefined', undefined, 'must be an array'],
  ])('rejects %s as the block', (_label, value, msg) => {
    const v = validateCompletionEvidence(value);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain(msg);
  });

  it.each([
    [[null], 'evidence[0]: must be an object'],
    [['x'], 'evidence[0]: must be an object'],
    [[{ path: '/x' }], 'evidence[0]: unknown type null'],
    [[{ type: 'file', path: '/x' }], 'evidence[0]: unknown type "file"'],
    [[{ type: 'artifact' }], 'evidence[0]: artifact needs a non-empty "path"'],
    [[{ type: 'artifact', path: '   ' }], 'evidence[0]: artifact needs a non-empty "path"'],
    [[{ type: 'command', exitCode: 0 }], 'evidence[0]: command needs a non-empty "command"'],
    [[{ type: 'command', command: 'ls' }], 'evidence[0]: command needs an integer "exitCode"'],
    [[{ type: 'command', command: 'ls', exitCode: '0' }], 'evidence[0]: command needs an integer "exitCode"'],
    [[{ type: 'command', command: 'ls', exitCode: 1.5 }], 'evidence[0]: command needs an integer "exitCode"'],
    [[{ type: 'command', command: 'ls', exitCode: 0, outputTail: 5 }], 'evidence[0]: command "outputTail" must be a string'],
    [[{ type: 'blocked', reason: 'x' }], 'evidence[0]: blocked needs a non-empty "step"'],
    [[{ type: 'blocked', step: 'x' }], 'evidence[0]: blocked needs a non-empty "reason"'],
  ])('rejects %j naming the entry', (value, msg) => {
    const v = validateCompletionEvidence(value);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain(msg);
  });

  it('names the index of the first bad entry', () => {
    const v = validateCompletionEvidence([{ type: 'artifact', path: '/ok' }, { type: 'command', command: 'x' }]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/^evidence\[1\]/);
  });

  it('rejects too many entries and over-long fields', () => {
    const many = Array.from({ length: COMPLETION_EVIDENCE_CONSTANTS.MAX_ENTRIES + 1 }, () => ({ type: 'artifact', path: '/x' }));
    expect(validateCompletionEvidence(many).ok).toBe(false);
    const long = 'x'.repeat(COMPLETION_EVIDENCE_CONSTANTS.MAX_FIELD_CHARS + 1);
    expect(validateCompletionEvidence([{ type: 'artifact', path: long }]).ok).toBe(false);
  });
});

describe('isCompletionEvidence', () => {
  it('is true only for a well-formed block', () => {
    expect(isCompletionEvidence([{ type: 'command', command: 'npm test', exitCode: 0 }])).toBe(true);
    expect(isCompletionEvidence([{ type: 'command', command: 'npm test' }])).toBe(false);
    expect(isCompletionEvidence(null)).toBe(false);
  });
});
