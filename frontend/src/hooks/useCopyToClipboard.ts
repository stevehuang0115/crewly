/**
 * useCopyToClipboard
 *
 * Copy state for a copy control: calls {@link copyText} (which works on
 * plain-HTTP origins too) and exposes `'copied'` or `'failed'` for a short
 * while, so the control can say "Copied" or "Select and copy manually"
 * instead of doing nothing.
 *
 * @module hooks/useCopyToClipboard
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { copyText } from '../utils/clipboard';
import { CLIPBOARD_CONSTANTS } from '../constants/clipboard.constants';

/** Result of the last copy attempt; `idle` once the feedback has expired */
export type CopyStatus = 'idle' | 'copied' | 'failed';

export interface UseCopyToClipboardResult {
  /** Result of the last copy, reverting to `idle` after the feedback window */
  status: CopyStatus;
  /** Key of the value last copied (for controls with several copy targets) */
  copiedKey: string | null;
  /**
   * Copy a value.
   *
   * @param text - Text to copy
   * @param key - Optional key naming which value was copied
   * @returns True when it reached the clipboard
   */
  copy: (text: string, key?: string) => Promise<boolean>;
}

/**
 * Hook managing copy + transient success/failure feedback.
 *
 * @param feedbackMs - How long the feedback stays (default {@link CLIPBOARD_CONSTANTS.FEEDBACK_MS})
 * @returns {@link UseCopyToClipboardResult}
 */
export function useCopyToClipboard(feedbackMs: number = CLIPBOARD_CONSTANTS.FEEDBACK_MS): UseCopyToClipboardResult {
  const [status, setStatus] = useState<CopyStatus>('idle');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = useCallback(
    async (text: string, key?: string): Promise<boolean> => {
      const ok = await copyText(text);
      setStatus(ok ? 'copied' : 'failed');
      setCopiedKey(key ?? null);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setStatus('idle');
        setCopiedKey(null);
      }, feedbackMs);
      return ok;
    },
    [feedbackMs],
  );

  return { status, copiedKey, copy };
}
