/**
 * CopyButton
 *
 * Small button that copies a value to the clipboard and briefly shows
 * "Copied". Works on plain-HTTP origins too (see `utils/clipboard`); when
 * the browser still refuses, it says "Select and copy manually" instead of
 * silently doing nothing — the value stays on screen, selectable.
 *
 * @module components/Harness/CopyButton
 */

import React from 'react';
import { AlertCircle, Check, Copy } from 'lucide-react';
import { Button } from '@crewly/ui';
import { HARNESS_TIMING } from '../../constants/harness.constants';
import { CLIPBOARD_CONSTANTS } from '../../constants/clipboard.constants';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';

export interface CopyButtonProps {
  /** Text to copy */
  value: string;
  /** Button label (also the accessible label) */
  label?: string;
}

/**
 * Copy-to-clipboard button with transient success / failure feedback.
 *
 * @param props - {@link CopyButtonProps}
 * @returns Button element
 */
export const CopyButton: React.FC<CopyButtonProps> = ({ value, label = CLIPBOARD_CONSTANTS.COPY_LABEL }) => {
  const { status, copy } = useCopyToClipboard(HARNESS_TIMING.COPIED_FEEDBACK_MS);

  const text =
    status === 'copied' ? CLIPBOARD_CONSTANTS.COPIED_LABEL : status === 'failed' ? CLIPBOARD_CONSTANTS.FAILED_LABEL : label;
  const icon = status === 'copied' ? Check : status === 'failed' ? AlertCircle : Copy;

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      icon={icon}
      onClick={() => void copy(value)}
      aria-label={label}
      aria-live="polite"
      data-testid="copy-button"
      data-copy-status={status}
    >
      {text}
    </Button>
  );
};
