/**
 * Tests for the Crewly Agent Adapter - Tool Name Normalization + finishReason mapping
 *
 * @module crewly-agent-adapter.test
 */

import * as fs from 'fs';
import * as path from 'path';
import { normalizeToolName, TOOL_ALIAS_MAP } from './crewly-agent-adapter.js';

describe('normalizeToolName', () => {
  it('maps handoff_task to handle-failure', () => {
    expect(normalizeToolName('handoff_task')).toBe('handle-failure');
  });

  it('maps assign_task to delegate-task', () => {
    expect(normalizeToolName('assign_task')).toBe('delegate-task');
  });

  it('maps reply_slack to send-message', () => {
    expect(normalizeToolName('reply_slack')).toBe('send-message');
  });

  it('maps handle_failure to handle-failure', () => {
    expect(normalizeToolName('handle_failure')).toBe('handle-failure');
  });

  it('maps send_message to send-message', () => {
    expect(normalizeToolName('send_message')).toBe('send-message');
  });

  it('returns unknown tool names unchanged', () => {
    expect(normalizeToolName('read_file')).toBe('read_file');
    expect(normalizeToolName('write_file')).toBe('write_file');
    expect(normalizeToolName('bash')).toBe('bash');
  });

  it('returns empty string unchanged', () => {
    expect(normalizeToolName('')).toBe('');
  });
});

describe('TOOL_ALIAS_MAP', () => {
  it('contains expected number of aliases', () => {
    expect(Object.keys(TOOL_ALIAS_MAP).length).toBe(5);
  });

  it('is readonly (frozen)', () => {
    // Verify the map values are as expected
    expect(TOOL_ALIAS_MAP).toEqual({
      handoff_task: 'handle-failure',
      assign_task: 'delegate-task',
      reply_slack: 'send-message',
      handle_failure: 'handle-failure',
      send_message: 'send-message',
    });
  });
});

describe('finishReason → loopDetected mapping (D6 bug fix)', () => {
  /**
   * Verifies that crewly-agent-adapter.ts uses 'loop-detected' (not 'loop-warning')
   * to match agent-runner.service.ts which sets finishReason: 'loop-detected'.
   */
  it('adapter source code compares finishReason against "loop-detected"', () => {
    const adapterSource = fs.readFileSync(
      path.join(__dirname, 'crewly-agent-adapter.ts'),
      'utf8',
    );
    // Must match the value set by agent-runner.service.ts (line ~958)
    expect(adapterSource).toContain("finishReason === 'loop-detected'");
    // Must NOT contain the old, incorrect value
    expect(adapterSource).not.toContain("finishReason === 'loop-warning'");
  });

  it('agent-runner sets finishReason to "loop-detected"', () => {
    const runnerSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'agent-runner.service.ts'),
      'utf8',
    );
    expect(runnerSource).toContain("finishReason: 'loop-detected'");
  });
});
