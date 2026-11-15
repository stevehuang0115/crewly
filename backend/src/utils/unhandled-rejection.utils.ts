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

import { ABORT_ERROR_CODE, ABORT_ERROR_NAME, NON_FATAL_UNHANDLED_REJECTION_PATTERNS } from '../constants.js';

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
 * Whether a rejection reason is an abort: the error an `AbortController`
 * raises on every promise tied to its signal when a request is cancelled
 * (for example, the HTTP client hung up). Node reports it either as a
 * `DOMException` named `AbortError` or as an error with code `ABORT_ERR`.
 *
 * A cancelled request is not a fault in the process, so the backend logs it
 * and stays up (incident 2026-11-13: an agent closed a remote MCP request
 * mid-flight and the abort shut the whole server down).
 *
 * @param reason - The rejection reason (anything can be thrown)
 * @returns True when the reason is an abort error
 *
 * @example
 * ```typescript
 * const controller = new AbortController();
 * controller.abort();
 * isAbortError(controller.signal.reason); // true
 * isAbortError(new Error('boom')); // false
 * ```
 */
export function isAbortError(reason: unknown): boolean {
  if (typeof reason !== 'object' || reason === null) return false;
  const { name, code } = reason as { name?: unknown; code?: unknown };
  return name === ABORT_ERROR_NAME || code === ABORT_ERROR_CODE;
}

/**
 * Whether an unhandled rejection is one the backend logs and survives
 * rather than shutting down for.
 *
 * Matches the reason's message against {@link NON_FATAL_UNHANDLED_REJECTION_PATTERNS}
 * with a plain substring test, so a Slack platform error such as
 * "An API error occurred: invalid_auth" is non-fatal regardless of which
 * Slack error code follows the prefix. An abort error ({@link isAbortError})
 * is non-fatal whatever its message says.
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
  if (isAbortError(reason)) return true;
  const message = unhandledRejectionMessage(reason);
  return NON_FATAL_UNHANDLED_REJECTION_PATTERNS.some((pattern) => message.includes(pattern));
}
