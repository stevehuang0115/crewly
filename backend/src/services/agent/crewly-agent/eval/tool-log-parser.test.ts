/**
 * Tests for the Eval Tool Log Parser.
 *
 * Verifies parsing of .tool-log.jsonl files written by eval skill shims,
 * conversion to ToolCallRecord format, and analysis helpers.
 *
 * @module eval/tool-log-parser.test
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  parseToolLog,
  parseToolLogContent,
  skillWasUsed,
  getSkillCalls,
  getDelegationTargets,
  getMessageRecipients,
  countSkillCalls,
  mergeToolCallRecords,
  TOOL_LOG_RELATIVE_PATH,
} from './tool-log-parser.js';
import type { ToolCallRecord } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-toollog-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Write a tool log JSONL file to the temp workspace.
 */
function writeToolLog(lines: string[]): void {
  const logDir = path.join(tmpDir, '.crewly');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, '.tool-log.jsonl'), lines.join('\n'));
}

// ---------------------------------------------------------------------------
// parseToolLog
// ---------------------------------------------------------------------------

describe('parseToolLog', () => {
  it('should return empty array when log file does not exist', () => {
    const result = parseToolLog(tmpDir);
    expect(result).toEqual([]);
  });

  it('should parse single log entry', () => {
    writeToolLog([
      '{"tool":"delegate-task","args":{"to":"eval-dev-leo","task":"fix bug"},"timestamp":"2026-04-01T10:00:00Z"}',
    ]);
    const result = parseToolLog(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].toolName).toBe('skill:delegate-task');
    expect(result[0].args).toEqual({ to: 'eval-dev-leo', task: 'fix bug' });
  });

  it('should parse multiple log entries', () => {
    writeToolLog([
      '{"tool":"delegate-task","args":{"to":"eval-dev-leo","task":"task A"},"timestamp":"2026-04-01T10:00:00Z"}',
      '{"tool":"send-message","args":{"to":"eval-dev-leo","message":"hello"},"timestamp":"2026-04-01T10:01:00Z"}',
      '{"tool":"report-status","args":{"status":"complete","summary":"done"},"timestamp":"2026-04-01T10:02:00Z"}',
    ]);
    const result = parseToolLog(tmpDir);
    expect(result).toHaveLength(3);
    expect(result[0].toolName).toBe('skill:delegate-task');
    expect(result[1].toolName).toBe('skill:send-message');
    expect(result[2].toolName).toBe('skill:report-status');
  });

  it('should skip malformed lines gracefully', () => {
    writeToolLog([
      '{"tool":"delegate-task","args":{"to":"leo"},"timestamp":"2026-04-01T10:00:00Z"}',
      'this is not json',
      '',
      '{"tool":"report-status","args":{"status":"done"},"timestamp":"2026-04-01T10:01:00Z"}',
    ]);
    const result = parseToolLog(tmpDir);
    expect(result).toHaveLength(2);
  });

  it('should handle empty log file', () => {
    writeToolLog(['']);
    const result = parseToolLog(tmpDir);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseToolLogContent
// ---------------------------------------------------------------------------

describe('parseToolLogContent', () => {
  it('should parse content string directly', () => {
    const content = '{"tool":"get-team-status","args":{},"timestamp":"2026-04-01T10:00:00Z"}';
    const result = parseToolLogContent(content);
    expect(result).toHaveLength(1);
    expect(result[0].toolName).toBe('skill:get-team-status');
  });

  it('should handle empty string', () => {
    expect(parseToolLogContent('')).toEqual([]);
  });

  it('should preserve args structure', () => {
    const content = '{"tool":"verify-output","args":{"checks":[{"name":"build","command":"npm run build"}]},"timestamp":"2026-04-01T10:00:00Z"}';
    const result = parseToolLogContent(content);
    expect(result[0].args).toEqual({
      checks: [{ name: 'build', command: 'npm run build' }],
    });
  });

  it('should include timestamp in result', () => {
    const content = '{"tool":"delegate-task","args":{},"timestamp":"2026-04-01T12:34:56Z"}';
    const result = parseToolLogContent(content);
    const resultObj = result[0].result as Record<string, unknown>;
    expect(resultObj.timestamp).toBe('2026-04-01T12:34:56Z');
    expect(resultObj.logged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// skillWasUsed
// ---------------------------------------------------------------------------

describe('skillWasUsed', () => {
  it('should detect used skill', () => {
    const records: ToolCallRecord[] = [
      { toolName: 'skill:delegate-task', args: { to: 'leo' }, result: null },
    ];
    expect(skillWasUsed(records, 'delegate-task')).toBe(true);
  });

  it('should return false for unused skill', () => {
    const records: ToolCallRecord[] = [
      { toolName: 'skill:delegate-task', args: { to: 'leo' }, result: null },
    ];
    expect(skillWasUsed(records, 'send-message')).toBe(false);
  });

  it('should return false for empty records', () => {
    expect(skillWasUsed([], 'delegate-task')).toBe(false);
  });

  it('should not match native tool calls', () => {
    const records: ToolCallRecord[] = [
      { toolName: 'read_file', args: { path: 'test.ts' }, result: null },
    ];
    expect(skillWasUsed(records, 'read_file')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getSkillCalls
// ---------------------------------------------------------------------------

describe('getSkillCalls', () => {
  it('should filter calls for a specific skill', () => {
    const records: ToolCallRecord[] = [
      { toolName: 'skill:delegate-task', args: { to: 'leo' }, result: null },
      { toolName: 'skill:send-message', args: { to: 'leo' }, result: null },
      { toolName: 'skill:delegate-task', args: { to: 'max' }, result: null },
    ];
    const calls = getSkillCalls(records, 'delegate-task');
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual({ to: 'leo' });
    expect(calls[1].args).toEqual({ to: 'max' });
  });

  it('should return empty for unmatched skill', () => {
    const records: ToolCallRecord[] = [
      { toolName: 'skill:delegate-task', args: {}, result: null },
    ];
    expect(getSkillCalls(records, 'report-status')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getDelegationTargets
// ---------------------------------------------------------------------------

describe('getDelegationTargets', () => {
  it('should extract delegation targets', () => {
    const records: ToolCallRecord[] = [
      { toolName: 'skill:delegate-task', args: { to: 'eval-dev-leo', task: 'A' }, result: null },
      { toolName: 'skill:delegate-task', args: { to: 'eval-dev-max', task: 'B' }, result: null },
    ];
    expect(getDelegationTargets(records)).toEqual(['eval-dev-leo', 'eval-dev-max']);
  });

  it('should skip entries without "to" field', () => {
    const records: ToolCallRecord[] = [
      { toolName: 'skill:delegate-task', args: { task: 'A' }, result: null },
    ];
    expect(getDelegationTargets(records)).toEqual([]);
  });

  it('should ignore non-delegation skills', () => {
    const records: ToolCallRecord[] = [
      { toolName: 'skill:send-message', args: { to: 'eval-dev-leo' }, result: null },
    ];
    expect(getDelegationTargets(records)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getMessageRecipients
// ---------------------------------------------------------------------------

describe('getMessageRecipients', () => {
  it('should extract message recipients', () => {
    const records: ToolCallRecord[] = [
      { toolName: 'skill:send-message', args: { to: 'eval-dev-leo', message: 'hi' }, result: null },
    ];
    expect(getMessageRecipients(records)).toEqual(['eval-dev-leo']);
  });

  it('should ignore non-message skills', () => {
    const records: ToolCallRecord[] = [
      { toolName: 'skill:delegate-task', args: { to: 'eval-dev-leo' }, result: null },
    ];
    expect(getMessageRecipients(records)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// countSkillCalls
// ---------------------------------------------------------------------------

describe('countSkillCalls', () => {
  it('should count only skill calls', () => {
    const records: ToolCallRecord[] = [
      { toolName: 'skill:delegate-task', args: {}, result: null },
      { toolName: 'read_file', args: {}, result: null },
      { toolName: 'skill:send-message', args: {}, result: null },
      { toolName: 'write_file', args: {}, result: null },
    ];
    expect(countSkillCalls(records)).toBe(2);
  });

  it('should return 0 for no skill calls', () => {
    const records: ToolCallRecord[] = [
      { toolName: 'read_file', args: {}, result: null },
    ];
    expect(countSkillCalls(records)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// mergeToolCallRecords
// ---------------------------------------------------------------------------

describe('mergeToolCallRecords', () => {
  it('should concatenate native and skill records', () => {
    const native: ToolCallRecord[] = [
      { toolName: 'read_file', args: { path: 'test.ts' }, result: 'content' },
    ];
    const skill: ToolCallRecord[] = [
      { toolName: 'skill:delegate-task', args: { to: 'leo' }, result: null },
    ];
    const merged = mergeToolCallRecords(native, skill);
    expect(merged).toHaveLength(2);
    expect(merged[0].toolName).toBe('read_file');
    expect(merged[1].toolName).toBe('skill:delegate-task');
  });

  it('should handle empty arrays', () => {
    expect(mergeToolCallRecords([], [])).toEqual([]);
    expect(mergeToolCallRecords([{ toolName: 'a', args: {}, result: null }], [])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// TOOL_LOG_RELATIVE_PATH
// ---------------------------------------------------------------------------

describe('TOOL_LOG_RELATIVE_PATH', () => {
  it('should be the expected path', () => {
    expect(TOOL_LOG_RELATIVE_PATH).toBe('.crewly/.tool-log.jsonl');
  });
});
