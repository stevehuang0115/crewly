/**
 * Clipboard helpers
 *
 * One place for every copy-to-clipboard in the UI. The async Clipboard API
 * (`navigator.clipboard`) only exists in a secure context — the owner opens
 * the web UI of a remote server over plain `http://<ip>:8787`, where it is
 * `undefined` and every copy button silently did nothing. {@link copyText}
 * uses the Clipboard API when it can and falls back to a hidden textarea +
 * `document.execCommand('copy')`, which still works on insecure origins.
 * It reports whether the copy happened so callers can say "Copied" or ask
 * the user to copy by hand.
 *
 * @module utils/clipboard
 */

/**
 * Copy text with a hidden, off-screen textarea and `execCommand('copy')`.
 * Restores the previously focused element afterwards.
 *
 * @param text - Text to copy
 * @returns True when the browser reported a successful copy
 */
function copyWithTextarea(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', '');
  textArea.setAttribute('aria-hidden', 'true');
  // Off-screen but still selectable (display:none cannot be selected).
  textArea.style.position = 'fixed';
  textArea.style.top = '0';
  textArea.style.left = '-9999px';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);
  let ok = false;
  try {
    textArea.focus();
    textArea.select();
    textArea.setSelectionRange(0, text.length);
    ok = typeof document.execCommand === 'function' && document.execCommand('copy') === true;
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(textArea);
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      try {
        previouslyFocused.focus();
      } catch {
        // Focus restore is best-effort.
      }
    }
  }
  return ok;
}

/**
 * Copy text to the clipboard.
 *
 * Tries `navigator.clipboard.writeText` when the page is a secure context
 * and the API exists; otherwise (or when it rejects) falls back to the
 * textarea + `execCommand('copy')` path.
 *
 * @param text - Text to copy
 * @returns True when the text reached the clipboard, false when the user
 *   has to copy it by hand
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  const secure = typeof window !== 'undefined' && window.isSecureContext === true;
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (secure && clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied / not focused: try the legacy path below.
    }
  }
  return copyWithTextarea(text);
}

/**
 * Select all text inside an element, so a tap on a code makes it ready for
 * the system copy menu (mobile) or Cmd/Ctrl+C.
 *
 * @param element - Element whose text to select
 */
export function selectElementText(element: HTMLElement | null): void {
  if (!element || typeof window === 'undefined' || typeof window.getSelection !== 'function') return;
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}
