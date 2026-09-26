/**
 * Tests for reply tool detection and the empty-text summary fallback rule.
 */

import { describe, it, expect } from 'vitest';
import { SUMMARY_FALLBACK_PROMPT, isReplyToolCall, shouldRequestSummaryFallback } from './reply-tool-calls.js';

const REPLY_CHAT = {
  toolName: 'bash_exec',
  args: { command: `bash config/skills/orchestrator/reply-chat/execute.sh '{"conversationId":"a721f48d","content":"链接在下面"}'` },
};

describe('isReplyToolCall', () => {
  it('recognises reply tools and reply skills run through the shell', () => {
    expect(isReplyToolCall({ toolName: 'reply_slack' })).toBe(true);
    expect(isReplyToolCall({ toolName: 'reply-slack' })).toBe(true);
    expect(isReplyToolCall(REPLY_CHAT)).toBe(true);
    expect(isReplyToolCall({ toolName: 'bash_exec', args: { command: 'bash config/skills/agent/core/reply-channel/execute.sh --text hi' } })).toBe(true);
    expect(isReplyToolCall({ toolName: 'Bash', args: { command: 'bash config/skills/orchestrator/reply-slack/execute.sh x' } })).toBe(true);
  });

  it('ignores other tools and other shell commands', () => {
    expect(isReplyToolCall({ toolName: 'get_team_status' })).toBe(false);
    expect(isReplyToolCall({ toolName: 'bash_exec', args: { command: 'claude auth status' } })).toBe(false);
    expect(isReplyToolCall({ toolName: 'bash_exec', args: {} })).toBe(false);
    expect(isReplyToolCall({ toolName: 'read_file', args: { command: 'reply-chat' } })).toBe(false);
  });
});

describe('shouldRequestSummaryFallback', () => {
  it('asks for a closing reply when tools ran and nothing was said', () => {
    expect(shouldRequestSummaryFallback('', [{ toolName: 'bash_exec', args: { command: 'claude --version' } }])).toBe(true);
  });

  it('stays silent when the reply already went out with a reply tool (2026-09-26 noise)', () => {
    expect(shouldRequestSummaryFallback('', [{ toolName: 'bash_exec', args: { command: 'claude --version' } }, REPLY_CHAT])).toBe(false);
  });

  it('never runs when there is text or no tool call', () => {
    expect(shouldRequestSummaryFallback('Done.', [REPLY_CHAT])).toBe(false);
    expect(shouldRequestSummaryFallback('', [])).toBe(false);
  });
});

describe('SUMMARY_FALLBACK_PROMPT', () => {
  it('asks for a short user-facing reply in their language, not a status report', () => {
    expect(SUMMARY_FALLBACK_PROMPT).toMatch(/in their language/);
    expect(SUMMARY_FALLBACK_PROMPT).toMatch(/No status report/);
    expect(SUMMARY_FALLBACK_PROMPT).toMatch(/do not say you sent anything unless a tool actually sent it/);
    expect(SUMMARY_FALLBACK_PROMPT).not.toMatch(/summarize what you just did/i);
    expect(SUMMARY_FALLBACK_PROMPT).not.toMatch(/report-status/);
  });
});
