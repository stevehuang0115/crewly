/**
 * Reply tool calls and the empty-text summary fallback.
 *
 * When a turn ends with tool calls but no text, the runner used to ask the
 * model to "summarize what you just did, what you found, and any issues".
 * For an agent answering a person, that summary is what reaches them: the
 * owner's Slack DM got several English meta reports in a row — "I've sent the
 * reply. Here's my status: *What the user asked* … *What I did* … *Next step*
 * … *Note on the ticket instruction*" (2026-09-26). The status-report shape
 * then stayed in the conversation history and the model kept repeating it.
 *
 * Two changes live here:
 * - {@link shouldRequestSummaryFallback}: no fallback when the turn already
 *   sent its reply with a reply tool — the answer is out; anything more is
 *   noise.
 * - {@link SUMMARY_FALLBACK_PROMPT}: the fallback asks for a short reply to
 *   the person, in their language, not a status report.
 *
 * @module runtime/reply-tool-calls
 */

/** The slice of a tool call record these helpers read. */
export interface ToolCallLike {
  toolName: string;
  args?: Record<string, unknown>;
}

/** Tools that post a reply to a person by themselves. */
const REPLY_TOOL_NAMES: ReadonlySet<string> = new Set(['reply_slack', 'reply-slack', 'reply_chat', 'reply-chat', 'send_chat_response']);

/** Shell tools whose command can run a reply skill. */
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(['bash_exec', 'bash', 'Bash', 'shell']);

/** Reply skills run through the shell (`bash config/skills/…/reply-chat/execute.sh …`). */
const REPLY_SKILL_PATTERN = /\b(?:reply-chat|reply-slack|reply-gchat|reply-remote|reply-channel|send-chat-response)\b/;

/**
 * Whether a tool call sent a reply to a person.
 *
 * @param call - Tool call record
 * @returns True for a reply tool, or a shell call that runs a reply skill
 */
export function isReplyToolCall(call: ToolCallLike): boolean {
  if (REPLY_TOOL_NAMES.has(call.toolName)) return true;
  if (!SHELL_TOOL_NAMES.has(call.toolName)) return false;
  const command = call.args?.command;
  return typeof command === 'string' && REPLY_SKILL_PATTERN.test(command);
}

/**
 * Whether the runner should ask the model for a closing text.
 *
 * Only when the turn produced no text, made tool calls, and none of them
 * sent the reply already.
 *
 * @param text - The turn's final text
 * @param toolCalls - The turn's tool calls
 * @returns True when the fallback should run
 */
export function shouldRequestSummaryFallback(text: string, toolCalls: readonly ToolCallLike[]): boolean {
  if (text || toolCalls.length === 0) return false;
  return !toolCalls.some(isReplyToolCall);
}

/**
 * Follow-up prompt when a turn ended with tool calls and no text: a short
 * answer to whoever wrote, in their language — never a status report, never
 * a claim of having sent something.
 */
export const SUMMARY_FALLBACK_PROMPT =
  'Reply directly to the person who wrote to you: in their language, short (1-3 sentences), only the answer or result itself. ' +
  'No status report (no "What the user asked / What I did / Next step" sections), do not describe your tool calls, ' +
  'and do not say you sent anything unless a tool actually sent it in this turn.';
