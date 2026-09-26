/**
 * Filter for an in-process agent's final turn text before it is posted to a
 * person (chat, Slack DM).
 *
 * Incident 2026-09-26 (owner's Slack DM with the orchestrator): after each
 * turn the owner got an English meta report — "I've sent the reply. Here's
 * my status: *What the user asked* … *What I did* … *Next step* … *Note on
 * the ticket instruction*". Several turns in a row had made no tool call at
 * all and still said "I generated a fresh link and sent it via reply-chat":
 * nothing had been sent. Both kinds of text are noise at best and false at
 * worst, so they are not posted:
 *
 * - {@link isMetaStatusReport}: the text reports on the turn instead of
 *   answering ("Here's my status", or self-referential section headers such
 *   as "What I did" plus another report header).
 * - {@link claimsSentReply} with no reply tool call in the turn: the text
 *   says a reply / link was sent to the person, but nothing sent one. Text
 *   that carries a URL itself is kept — posting it delivers what it claims.
 *
 * A genuine answer — even one mentioning "next steps" or "I sent the task
 * to Joe" — passes.
 *
 * @module utils/agent-reply-filter
 */

/** The slice of a tool call record the filter reads. */
export interface TurnToolCall {
	toolName: string;
	args?: Record<string, unknown>;
}

/** Why a turn's text was not posted. */
export type SuppressedReplyReason = 'meta_status_report' | 'unsent_reply_claim';

/** Result of {@link filterAgentTurnReply}. */
export interface FilteredTurnReply {
	/** Text to post ('' when suppressed) */
	text: string;
	/** Why it was suppressed, or null when it passes */
	suppressed: SuppressedReplyReason | null;
}

/** Tools that post a reply by themselves. */
const REPLY_TOOL_NAMES: ReadonlySet<string> = new Set(['reply_slack', 'reply-slack', 'reply_chat', 'reply-chat', 'send_chat_response']);

/** Shell tools whose command can run a reply skill. */
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(['bash_exec', 'bash', 'Bash', 'shell']);

/** Reply skills run through the shell. */
const REPLY_SKILL_PATTERN = /\b(?:reply-chat|reply-slack|reply-gchat|reply-remote|reply-channel|send-chat-response)\b/;

/**
 * Opening line of a turn report: "I've sent the reply. Here's my status:",
 * "I've replied to the Slack DM. Here's what I found and did:",
 * "The link has been sent. Here's my status:".
 */
const REPORT_OPENER = /^[^\n]{0,160}?\bhere(?:'s| is)\s+(?:my\s+status|what\s+i\s+(?:found|did|have\s+done))\b/i;

/** A markdown-ish section header line; group 1 is the label. */
const HEADER_LINE = /^\s*(?:#{1,6}\s*)?(?:[-*>]\s+)?\*{0,2}_?([^\n:：*]{2,80}?)\s*(?:\([^)\n]{0,80}\))?\s*_?\*{0,2}\s*[:：]/gm;

/** Headers in which the agent reports on itself or on "the user" (strong signal). */
const SELF_REPORT_LABEL =
	/^(?:what\s+(?:the\s+)?(?:user|owner)\b|what\s+i\b|why\s+i\b|note\s+on\s+(?:the\s+)?ticket|correction\s+first|my\s+status\b|用户(?:问|要|说|想|的问题)|我(?:做了|完成了|检查了|验证了|发现)|我的状态)/i;

/** Other headers a turn report uses (weak alone). */
const REPORT_LABEL =
	/^(?:next\s+steps?|result|root\s+cause|investigation|caveats?(?:\s+i\s+flagged.*)?|status|summary|findings|verified|下一步|结果|原因|结论|总结)\b/i;

/** Claims that a reply / link / message went to the person. */
const SENT_REPLY_CLAIMS: readonly RegExp[] = [
	/\bi(?:'ve|\s+have)?\s+(?:just\s+|now\s+|also\s+)?(?:re-?)?(?:sent|posted|shared|dm'?e?d|delivered)\s+(?:you\b|it\s+(?:to\s+you|to\s+the\s+(?:user|owner)|via\b|in\s+(?:the\s+)?(?:dm|thread|chat))|the\s+(?:(?:new|fresh|real|login|authorization|auth|interim)\s+)*(?:link|reply|url|message|code|answer)\b|a\s+(?:(?:new|fresh|short)\s+)?(?:link|reply|message)\b)/i,
	/\bi(?:'ve|\s+have)\s+(?:just\s+)?replied\b/i,
	/\b(?:link|reply|url|message|answer)\s+(?:has|have|was)\s+(?:just\s+)?(?:been\s+)?(?:sent|posted|delivered)\b/i,
	/\b(?:sent|delivered|posted)\s+(?:it\s+|the\s+\w+\s+)?via\s+`?reply-(?:chat|slack)/i,
	/(?:链接|回复|消息|验证码|登录链接|授权链接)(?:已经?|刚刚?|都)?(?:发|发送|发出)(?:给你|过去|出去|到)?了/,
	/(?:已经?|刚刚?)(?:把[^。\n]{0,30})?(?:发给你|发送给你|私信给你|回复你|回复了你)/,
	/发给你了/,
];

/** A URL in the text: posting it delivers the link it talks about. */
const URL_PATTERN = /https?:\/\/\S+/i;

/**
 * Whether a tool call sent a reply to a person.
 *
 * @param call - Tool call record
 * @returns True for a reply tool, or a shell call that runs a reply skill
 */
export function isReplyToolCall(call: TurnToolCall): boolean {
	if (REPLY_TOOL_NAMES.has(call.toolName)) return true;
	if (!SHELL_TOOL_NAMES.has(call.toolName)) return false;
	const command = call.args?.command;
	return typeof command === 'string' && REPLY_SKILL_PATTERN.test(command);
}

/**
 * Whether a text is a report on the turn rather than an answer.
 *
 * @param text - Final turn text
 * @returns True for "Here's my status" openers, or a self-report header plus
 *   at least one more report header
 *
 * @example
 * ```ts
 * isMetaStatusReport("I've sent the reply. Here's my status:\n**What I did:** …"); // true
 * isMetaStatusReport('部署好了：https://ce.example.com'); // false
 * ```
 */
export function isMetaStatusReport(text: string): boolean {
	if (typeof text !== 'string' || !text.trim()) return false;
	if (REPORT_OPENER.test(text.trim())) return true;
	let self = 0;
	let other = 0;
	for (const match of text.matchAll(HEADER_LINE)) {
		const label = match[1].trim();
		if (SELF_REPORT_LABEL.test(label)) self += 1;
		else if (REPORT_LABEL.test(label)) other += 1;
	}
	return self >= 1 && self + other >= 2;
}

/**
 * Whether a text claims a reply, link or message was sent to the person.
 *
 * @param text - Final turn text
 * @returns True for "I've sent the link", "The link has been sent", 「链接已经发给你了」 …
 */
export function claimsSentReply(text: string): boolean {
	if (typeof text !== 'string' || !text.trim()) return false;
	return SENT_REPLY_CLAIMS.some((re) => re.test(text));
}

/**
 * Decide whether an in-process agent's final text may be posted.
 *
 * @param text - Final turn text (already stripped of tool-call markup)
 * @param toolCalls - The turn's tool calls
 * @returns The text to post, or '' with the reason it was suppressed
 */
export function filterAgentTurnReply(text: string, toolCalls: readonly TurnToolCall[] | undefined): FilteredTurnReply {
	if (!text) return { text: '', suppressed: null };
	if (isMetaStatusReport(text)) return { text: '', suppressed: 'meta_status_report' };
	const replied = (toolCalls ?? []).some(isReplyToolCall);
	if (!replied && claimsSentReply(text) && !URL_PATTERN.test(text)) {
		return { text: '', suppressed: 'unsent_reply_claim' };
	}
	return { text, suppressed: null };
}
