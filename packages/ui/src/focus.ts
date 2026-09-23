/**
 * Initial focus for dialogs (Modal, Popup).
 *
 * @module components/UI/focus
 */

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Move focus into a freshly opened dialog, the way a form expects.
 *
 * Order: leave it alone if focus is already inside (React's `autoFocus`
 * focuses on mount without leaving an attribute); else an element marked
 * `data-autofocus`; else the first control that is not the dialog's own
 * close button; else the close button. Focusing ✕ first used to swallow
 * the autoFocus of the form inside.
 *
 * @param container - The dialog panel
 * @param isCloseButton - Recognizes the dialog's close control
 */
export function focusInitial(container: HTMLElement, isCloseButton: (el: HTMLElement) => boolean): void {
  if (container.contains(document.activeElement)) return;
  const preferred = container.querySelector<HTMLElement>('[autofocus], [data-autofocus]');
  const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
  const target = preferred ?? focusables.find((el) => !isCloseButton(el)) ?? focusables[0];
  target?.focus();
}
