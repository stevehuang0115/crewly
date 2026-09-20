/**
 * Turning a Slack API failure into something the owner can act on.
 *
 * The Slack SDK raises `slack_webapi_platform_error` with Slack's own body
 * attached. For a scope failure that body says exactly which scope was
 * needed and which the token has — and the controller used to read only
 * `error`, so the owner saw a bare "Slack API error: missing_scope" with no
 * way to know what to add (2026-09-19, a second install whose Slack app
 * predated team channels and so lacked `groups:read`).
 *
 * @module controllers/slack/slack-error.utils
 */

/** What the caller should be told about a Slack platform failure. */
export interface SlackErrorPayload {
  success: false;
  /** Human summary, naming the missing scope when Slack named one. */
  error: string;
  /** Slack's machine-readable code, e.g. `missing_scope`. */
  slackError: string;
  /** The scope Slack wanted, when it said so. */
  needed?: string;
  /** The scopes the token actually carries, when Slack said so. */
  provided?: string;
  /** What to do about it. */
  hint?: string;
}

/** The SDK's platform-error marker. */
const PLATFORM_ERROR_CODE = 'slack_webapi_platform_error';

/**
 * Whether this is a Slack platform error (as opposed to a network or
 * programming failure, which belong to the generic handler).
 *
 * @param error - The caught value
 * @returns True when it carries Slack's platform-error code
 */
export function isSlackPlatformError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === PLATFORM_ERROR_CODE
  );
}

/**
 * Describe a Slack platform error for the client.
 *
 * @param error - The caught value (only its `data` is read)
 * @returns The response body to send with 422
 *
 * @example
 * describeSlackError(err) // err.data = { error: 'missing_scope', needed: 'groups:read' }
 * // → { error: 'Slack API error: missing_scope (needs groups:read)', needed: 'groups:read', hint: '…' }
 */
export function describeSlackError(error: unknown): SlackErrorPayload {
  const data = (error as { data?: Record<string, unknown> } | undefined)?.data ?? {};
  const slackError = typeof data.error === 'string' && data.error ? data.error : 'unknown_slack_error';
  const needed = typeof data.needed === 'string' && data.needed ? data.needed : undefined;
  const provided = typeof data.provided === 'string' && data.provided ? data.provided : undefined;
  const hint =
    slackError === 'missing_scope' && needed
      ? `Your Slack app is missing the ${needed} scope. Add it under OAuth & Permissions → Bot Token Scopes, then reinstall the app to your workspace.`
      : undefined;

  return {
    success: false,
    error: needed ? `Slack API error: ${slackError} (needs ${needed})` : `Slack API error: ${slackError}`,
    slackError,
    ...(needed ? { needed } : {}),
    ...(provided ? { provided } : {}),
    ...(hint ? { hint } : {}),
  };
}
