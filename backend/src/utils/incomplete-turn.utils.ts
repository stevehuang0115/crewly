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
  truncated: 'The reply exceeded the length limit and may have been cut off',
  'abnormal-finish': 'This turn was interrupted partway, so the content above may be incomplete',
  'steps-exhausted': 'This turn ran out of steps and the work is not finished',
  'content-filter': 'The model provider refused to continue this turn',
  // The turn ended normally; the work did not. Worth its own sentence,
  // because "I ran out of steps" and "I thought I was done but the file is
  // not there" call for different things from the reader.
  'desktop-unverified': 'Some actions on the desktop could not be confirmed and may not have actually completed',
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
  const notice = `_⚠️ ${NOTICE[incomplete.reason] ?? 'This turn ended early'}. To have me carry on, just reply "continue"._`;
  return body ? `${body}\n\n${notice}` : notice;
}
