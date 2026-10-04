/**
 * Keep the harness ticket line out of what the owner sees.
 *
 * The ticket loop adds a line (`[TICKET:TKT-123 <id>] (…internal note…)`) to
 * the copy of an owner's message that is delivered to an agent. It must never
 * be part of the stored message: chat history, the Cloud portal and the local
 * dashboard all show the stored content. Until 2026-10 the legacy Slack bridge
 * persisted the delivered copy, so some stored owner rows still end with the
 * line; {@link ownerVisibleContent} strips it when those rows are read.
 *
 * @module services/chat-v2/ticket-line.utils
 */

/**
 * The ticket line as it is appended to a message (`appendTicketLine`): a
 * blank line, then `[TICKET:` — everything from there on is harness text
 * (the legacy bridge also put the `[Thread context file: …]` hint after it).
 */
const TICKET_LINE_SUFFIX = /\n\n\[TICKET:[\s\S]*$/;

/**
 * Remove an appended ticket line from a message's text.
 *
 * @param content - Message text
 * @returns The text without the ticket line (unchanged when there is none)
 */
export function stripTicketDeliveryLine(content: string): string {
  if (typeof content !== 'string' || !content.includes('[TICKET:')) return content;
  return content.replace(TICKET_LINE_SUFFIX, '');
}

/**
 * The content to show for a stored message: a person's message (`user`
 * sender) without any ticket line; anything else unchanged.
 *
 * @param senderType - The message's sender type
 * @param content - Stored content
 * @returns Content safe to return in history, broadcasts and sync
 */
export function ownerVisibleContent(senderType: string, content: string): string {
  return senderType === 'user' ? stripTicketDeliveryLine(content) : content;
}
