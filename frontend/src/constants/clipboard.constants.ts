/**
 * Clipboard Constants
 *
 * Feedback timing and wording shared by every copy-to-clipboard control
 * (see `utils/clipboard.ts` and `hooks/useCopyToClipboard.ts`).
 *
 * @module constants/clipboard.constants
 */

export const CLIPBOARD_CONSTANTS = {
  /** How long "Copied" / the manual-copy hint stays before reverting */
  FEEDBACK_MS: 2_000,
  /** Shown after a successful copy */
  COPIED_LABEL: 'Copied',
  /** Shown when the browser refused to copy (the text stays selectable) */
  FAILED_LABEL: 'Select and copy manually',
  /** Default copy button label */
  COPY_LABEL: 'Copy',
} as const;
