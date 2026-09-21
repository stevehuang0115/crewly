/**
 * Unhandled-rejection classification for the backend's process-level handler.
 *
 * The backend installs a `process.on('unhandledRejection')` handler that
 * gracefully shuts the server down for any rejection it does not recognise.
 * Third-party integration libraries (the Slack SDK in particular) can reject
 * on promise chains that no Crewly frame ever awaits, and such a rejection
 * must degrade that integration, not kill the process. This module holds the
 * one predicate that decides which is which, so it can be tested without
 * booting the server.
 *
 * @module utils/unhandled-rejection
 */

import { NON_FATAL_UNHANDLED_REJECTION_PATTERNS } from '../constants.js';

/**
 * Render an unhandled-rejection reason as a message string.
 *
 * @param reason - The rejection reason (usually an Error, but anything can be thrown)
 * @returns The Error's message, or the reason coerced to a string
 */
export function unhandledRejectionMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Whether an unhandled rejection is one the backend logs and survives
 * rather than shutting down for.
 *
 * Matches the reason's message against {@link NON_FATAL_UNHANDLED_REJECTION_PATTERNS}
 * with a plain substring test, so a Slack platform error such as
 * "An API error occurred: invalid_auth" is non-fatal regardless of which
 * Slack error code follows the prefix.
 *
 * @param reason - The rejection reason handed to `process.on('unhandledRejection')`
 * @returns True when the rejection must be logged and suppressed; false when
 *   it is unknown and the graceful shutdown should proceed
 *
 * @example
 * ```typescript
 * isNonFatalUnhandledRejection(new Error('An API error occurred: invalid_auth')); // true
 * isNonFatalUnhandledRejection(new Error('Cannot read properties of undefined')); // false
 * ```
 */
export function isNonFatalUnhandledRejection(reason: unknown): boolean {
  const message = unhandledRejectionMessage(reason);
  return NON_FATAL_UNHANDLED_REJECTION_PATTERNS.some((pattern) => message.includes(pattern));
}
