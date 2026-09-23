/**
 * Shared bookkeeping for open dialogs (Modal, Popup, Drawer).
 *
 * Each dialog used to listen for Escape on `document` and reset
 * `body.style.overflow` on unmount, so with two stacked dialogs one Escape
 * closed both, and closing the inner one let the page scroll under the
 * outer one. Now only the topmost dialog answers Escape, and scrolling is
 * restored when the last one closes.
 *
 * @module components/UI/dialogStack
 */

import { useEffect, useRef } from 'react';

const stack: object[] = [];
let savedOverflow: string | null = null;

/**
 * Register an open dialog: topmost-only Escape handling and body scroll lock.
 *
 * @param isOpen - Whether the dialog is showing
 * @param onEscape - Called when Escape is pressed and this dialog is on top (omit to ignore Escape)
 */
export function useDialogLayer(isOpen: boolean, onEscape?: () => void): void {
  const token = useRef({});
  const handler = useRef(onEscape);
  handler.current = onEscape;

  useEffect(() => {
    if (!isOpen) return;
    const me = token.current;
    if (stack.length === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    stack.push(me);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stack[stack.length - 1] === me && handler.current) handler.current();
    };
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('keydown', onKey);
      const i = stack.lastIndexOf(me);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0) {
        document.body.style.overflow = savedOverflow ?? '';
        savedOverflow = null;
      }
    };
  }, [isOpen]);
}

/** Test affordance: how many dialogs are registered. */
export function _openDialogCount(): number {
  return stack.length;
}
