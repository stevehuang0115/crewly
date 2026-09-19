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
  reason: 'truncated' | 'abnormal-finish' | 'steps-exhausted' | 'content-filter';
  detail: string;
  finishReason: string;
  recoveryAttempts: number;
}

/** What each reason means for the reader, in one sentence. */
const NOTICE: Record<IncompleteTurn['reason'], string> = {
  truncated: 'my reply hit the length limit, so it may be cut short',
  'abnormal-finish': 'my turn was interrupted, so the work above may be unfinished',
  'steps-exhausted': 'I ran out of steps for this turn, so the work above may be unfinished',
  'content-filter': 'the model provider refused to continue this turn',
};

/**
 * Append the "this turn stopped early" line to an agent's reply.
 *
 * @param text - The agent's (possibly partial) text
 * @param incomplete - The runtime's report, or undefined for a healthy turn
 * @returns The text to show, unchanged when the turn finished normally
 *
 * @example
 * appendIncompleteNotice('Creating the team…', { reason: 'abnormal-finish', … })
 * // → 'Creating the team…\n\n_⚠️ my turn was interrupted, … Ask me to continue._'
 */
export function appendIncompleteNotice(text: string, incomplete?: IncompleteTurn): string {
  if (!incomplete) return text;
  const body = (text ?? '').trim();
  const notice = `_⚠️ Heads up: ${NOTICE[incomplete.reason] ?? 'my turn ended early'}. Ask me to continue if something is missing._`;
  return body ? `${body}\n\n${notice}` : notice;
}
