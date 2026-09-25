/**
 * CopyButton
 *
 * Small button that copies a value to the clipboard and briefly shows
 * "已复制". Clipboard failures (insecure origin, denied permission) are
 * swallowed; the value stays visible for manual copying.
 *
 * @module components/Harness/CopyButton
 */

import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@crewly/ui';
import { HARNESS_TIMING } from '../../constants/harness.constants';

export interface CopyButtonProps {
  /** Text to copy */
  value: string;
  /** Accessible label */
  label?: string;
}

/**
 * Copy-to-clipboard button with transient confirmation.
 *
 * @param props - {@link CopyButtonProps}
 * @returns Button element
 */
export const CopyButton: React.FC<CopyButtonProps> = ({ value, label = '复制' }) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  /** Copy the value and show the confirmation. */
  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), HARNESS_TIMING.COPIED_FEEDBACK_MS);
    } catch {
      // Clipboard unavailable: the value is on screen to copy by hand.
    }
  };

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      icon={copied ? Check : Copy}
      onClick={handleCopy}
      aria-label={label}
      data-testid="copy-button"
    >
      {copied ? '已复制' : label}
    </Button>
  );
};
