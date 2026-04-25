/**
 * ChatErrorToast — small page-local toast for surfacing chat send failures.
 *
 * Phase C wires this to the BE validation errors emitted by Sam's
 * service layer (`backend/src/services/chat-v2/chat-v2.service.ts`):
 *  - `validation_error` (400) — bad threadId, malformed mentions array,
 *    cross-channel thread root, etc.
 *  - `payload_too_large` (413) — content / mentions JSON over the cap.
 *  - `forbidden` (403), `not_found` (404), and friends.
 *
 * The toast is intentionally minimal — Phase D will pivot to a richer
 * notification primitive shared across the OSS frontend. Right now the
 * goal is correctness of the error surface for the 4/28 EOD target.
 *
 * @module components/Chat-team/ChatErrorToast
 */

import type { ReactNode } from 'react';

export interface ChatErrorToastProps {
  /** Headline rendered in the toast. */
  message: string;
  /**
   * Optional secondary detail (e.g. the thread root id that was
   * rejected). Mounted under the headline at smaller weight.
   */
  detail?: ReactNode;
  /** Click handler for the dismiss `×` affordance. */
  onDismiss?: () => void;
}

/**
 * Render a fixed bottom-right toast describing a chat send failure.
 * Uses `role="alert"` so screen readers announce the error.
 */
export function ChatErrorToast({
  message,
  detail,
  onDismiss,
}: ChatErrorToastProps): JSX.Element {
  return (
    <div
      role="alert"
      data-testid="chat-error-toast"
      className="fixed bottom-4 right-4 z-50 flex max-w-md items-start gap-3 rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800 shadow-lg dark:border-rose-700/40 dark:bg-rose-900/30 dark:text-rose-100"
    >
      <div className="flex-1">
        <div className="font-medium">{message}</div>
        {detail && (
          <div className="mt-0.5 text-xs opacity-80" data-testid="chat-error-toast-detail">
            {detail}
          </div>
        )}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss error"
          data-testid="chat-error-toast-dismiss"
          className="shrink-0 rounded p-0.5 text-rose-700 hover:bg-rose-100 dark:text-rose-200 dark:hover:bg-rose-800/40"
        >
          ×
        </button>
      )}
    </div>
  );
}

export default ChatErrorToast;
