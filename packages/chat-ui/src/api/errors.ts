/**
 * ChatApiError — thrown by `HttpChatApiClient` on any non-2xx response.
 *
 * The backend (Sam's chat-v2 controller) always returns a stable
 * `{ success: false, error: { code, message, details } }` envelope on
 * errors, with `code` being one of the canonical strings listed in the
 * tech spec §21. UI branches switch on `code`, not on `message`.
 *
 * Exposing this class from the package lets consumers write:
 *
 *     try { await send(...) } catch (e) {
 *       if (e instanceof ChatApiError && e.code === 'agent_already_bound') {
 *         // show "You already have a channel with this agent." banner
 *       }
 *     }
 *
 * We deliberately re-declare the code strings here instead of importing
 * from the backend: the package must stay backend-agnostic (see Decisions
 * doc §1) and is bundled independently of the OSS backend.
 *
 * @module api/errors
 */

/**
 * Canonical Chat API error codes. Kept in sync with the backend's
 * `CHAT_ERROR_CODES` constant; new codes land here alongside backend
 * changes.
 */
export const CHAT_API_ERROR_CODES = [
  'validation_error',
  'not_found',
  'channel_not_found',
  'agent_not_found',
  'forbidden',
  'agent_already_bound',
  'payload_too_large',
  'rate_limited',
  'invalid_cursor',
  'channel_archived',
  'attachment_not_found',
  'internal_error',
  // Generic / client-synthesized codes (used when the server returns a
  // non-standard shape, e.g. a plain 502 from a CDN).
  'network_error',
  'unknown_error',
] as const;

export type ChatApiErrorCode = (typeof CHAT_API_ERROR_CODES)[number];

/**
 * Error thrown for any non-successful chat API response.
 */
export class ChatApiError extends Error {
  public readonly code: ChatApiErrorCode;
  public readonly httpStatus: number;
  public readonly details?: Record<string, unknown>;

  constructor(params: {
    code: ChatApiErrorCode;
    httpStatus: number;
    message: string;
    details?: Record<string, unknown>;
  }) {
    super(params.message);
    this.name = 'ChatApiError';
    this.code = params.code;
    this.httpStatus = params.httpStatus;
    this.details = params.details;
  }

  /**
   * Parse the backend's standard envelope into a structured error.
   *
   * Falls back to `unknown_error` when the body isn't recognizable —
   * better to surface a generic error than to crash on a malformed
   * response from an intermediate proxy.
   */
  static async fromResponse(res: Response): Promise<ChatApiError> {
    let body: unknown = undefined;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }

    if (
      body &&
      typeof body === 'object' &&
      'error' in body &&
      (body as Record<string, unknown>).error &&
      typeof (body as Record<string, unknown>).error === 'object'
    ) {
      const envelope = (body as { error: Record<string, unknown> }).error;
      const code = normalizeCode(envelope.code);
      const message =
        typeof envelope.message === 'string'
          ? envelope.message
          : `Chat API error ${res.status}`;
      const details =
        envelope.details && typeof envelope.details === 'object'
          ? (envelope.details as Record<string, unknown>)
          : undefined;
      return new ChatApiError({
        code,
        httpStatus: res.status,
        message,
        details,
      });
    }

    return new ChatApiError({
      code: 'unknown_error',
      httpStatus: res.status,
      message: `Chat API error ${res.status}`,
    });
  }
}

/**
 * Coerce an arbitrary `code` value into a known `ChatApiErrorCode`. Unknown
 * strings collapse to `unknown_error` so the type invariant holds.
 */
function normalizeCode(raw: unknown): ChatApiErrorCode {
  if (typeof raw !== 'string') return 'unknown_error';
  return (CHAT_API_ERROR_CODES as readonly string[]).includes(raw)
    ? (raw as ChatApiErrorCode)
    : 'unknown_error';
}
