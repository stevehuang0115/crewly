/**
 * Delivery record for agent replies mirrored to Slack.
 *
 * The mirrors (team channel, agent DM) run off the chat-v2 `chat_message`
 * event, so the reply call that created the message used to return before
 * Slack had answered: a failed post was logged and the agent was told
 * "delivered". Each mirror registers its attempt here under the message id;
 * the reply endpoint awaits it and answers the agent honestly, and the Slack
 * channel + ts are stored on the message so what reached Slack can be
 * proven from our own records (CREW-89).
 */

/** What became of one mirrored message. */
export interface SlackOutboundDelivery {
  /** True once the Slack post (or edit of the placeholder) succeeded. */
  delivered: boolean;
  /** Slack channel posted to. */
  slackChannelId?: string;
  /** Slack ts of the message that carries the reply. */
  ts?: string;
  /** Thread the reply was posted in. */
  threadTs?: string;
  /** Slack's error when the post failed. */
  error?: string;
}

/** Metadata key under which the delivery is stored on the chat message. */
export const SLACK_DELIVERY_METADATA_KEY = 'slackDelivery';

/** How long a reply call waits for the mirror before answering without it. */
export const SLACK_DELIVERY_WAIT_MS = 15_000;

/** Max entries kept (attempts are short-lived; this only bounds a leak). */
const MAX_TRACKED = 500;

/** Every mirror that registered for a message — the team-channel and DM mirrors both hear every agent message. */
const attempts = new Map<string, Array<Promise<SlackOutboundDelivery | null>>>();

/**
 * Register a mirror attempt for a message; several mirrors may register under
 * one id and are combined by {@link awaitSlackDelivery}. `null` from the promise means the
 * message was not meant for Slack (not mapped, skipped) — nothing to report.
 *
 * @param messageId - chat-v2 message id
 * @param attempt - The mirror's outcome
 */
export function trackSlackDelivery(messageId: string, attempt: Promise<SlackOutboundDelivery | null>): void {
  const list = attempts.get(messageId);
  if (list) list.push(attempt);
  else attempts.set(messageId, [attempt]);
  if (attempts.size > MAX_TRACKED) {
    const oldest = attempts.keys().next().value;
    if (oldest !== undefined) attempts.delete(oldest);
  }
}

/**
 * Wait for a message's Slack mirror.
 *
 * @param messageId - chat-v2 message id
 * @param timeoutMs - Longest wait; on timeout the result is null (unknown, not failed)
 * @returns The delivery, or null when the message has no Slack mirror (or it is still running)
 */
export async function awaitSlackDelivery(
  messageId: string,
  timeoutMs: number = SLACK_DELIVERY_WAIT_MS,
): Promise<SlackOutboundDelivery | null> {
  const list = attempts.get(messageId);
  if (!list) return null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    // Several mirrors may have registered (the one that does not apply
    // resolves null): any failure → failed; else any delivered → delivered.
    const results = await Promise.race([Promise.all(list.map((a) => a.catch(() => null))), timeout]);
    if (!results) return null;
    return results.find((r) => r && !r.delivered) ?? results.find((r) => r && r.delivered) ?? null;
  } finally {
    if (timer) clearTimeout(timer);
    attempts.delete(messageId);
  }
}

/** Test helper: forget every tracked attempt. */
export function resetSlackDeliveryTracker(): void {
  attempts.clear();
}
