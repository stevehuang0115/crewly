/**
 * Telling the user when an agent turn did not finish.
 *
 * The in-process runtime reports a turn that was cut off, refused, or ran
 * out of steps (`AgentRunResult.incomplete`). The text from such a turn is
 * a fragment: the agent may well have written "I'll create the team" and
 * then been stopped before creating anything. Shipping that fragment as
 * the reply is the worst outcome — the user reads a promise as a result.
 *
 * So the fragment is kept (it is often useful) and a short, plain line is
 * appended saying the turn stopped early and the work may be unfinished.
 *
 * @module utils/incomplete-turn
 */

/** The runtime's report of a turn that ended early. */
export interface IncompleteTurn {
  reason: 'truncated' | 'abnormal-finish' | 'steps-exhausted' | 'content-filter' | 'desktop-unverified';
  detail: string;
  finishReason: string;
  recoveryAttempts: number;
}

/** What each reason means for the reader, in one sentence. */
const NOTICE: Record<IncompleteTurn['reason'], string> = {
  truncated: '回复超出了长度上限，可能被截断了',
  'abnormal-finish': '这一轮做到一半被打断了，上面的内容可能不完整',
  'steps-exhausted': '这一轮的步数用完了，事情还没做完',
  'content-filter': '模型服务商拒绝继续这一轮',
  // The turn ended normally; the work did not. Worth its own sentence,
  // because "I ran out of steps" and "I thought I was done but the file is
  // not there" call for different things from the reader.
  'desktop-unverified': '桌面上的部分操作没能确认，可能并没有真正完成',
};

/**
 * Paragraphs that are the model thinking aloud between tool calls ("I'll
 * start by…", "Let me check…"). A finished turn ends with an answer; an
 * interrupted one only has these, and posting them verbatim showed the owner
 * an English monologue (2026-09-26, Orc after a 60-step turn).
 */
const NARRATION = /^(?:I['’]ll|I will|I need to|I have (?:the|now)|I['’]m going to|I am going to|Let me|Let['’]s|Now (?:I|let)|Next,? (?:I|let)|First,? (?:I|let)|OK,? (?:I|let)|Okay,? (?:I|let)|Checking|Looking at)\b/i;

/**
 * Drop thinking-aloud paragraphs from an interrupted turn's text.
 *
 * @param text - Accumulated turn text
 * @returns The text without narration paragraphs (may be empty)
 */
export function stripNarration(text: string): string {
  return (text ?? '')
    .split(/\n{2,}/)
    .filter((para) => !NARRATION.test(para.trim()))
    .join('\n\n')
    .trim();
}

export function appendIncompleteNotice(text: string, incomplete?: IncompleteTurn): string {
  if (!incomplete) return text;
  const body = stripNarration(text ?? '');
  const notice = `_⚠️ ${NOTICE[incomplete.reason] ?? '这一轮提前结束了'}。要我接着做，回一句「继续」就行。_`;
  return body ? `${body}\n\n${notice}` : notice;
}
