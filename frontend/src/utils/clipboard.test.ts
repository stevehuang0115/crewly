/**
 * Tests for clipboard helpers — both the secure-context Clipboard API path
 * and the plain-HTTP textarea + execCommand fallback.
 *
 * @module utils/clipboard.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { copyText, selectElementText } from './clipboard';

/**
 * Set `window.isSecureContext` for a test.
 *
 * @param value - Whether the page is a secure context
 */
function setSecure(value: boolean): void {
  Object.defineProperty(window, 'isSecureContext', { value, configurable: true, writable: true });
}

describe('copyText', () => {
  const writeText = vi.fn();
  const execCommand = vi.fn();

  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    execCommand.mockReset().mockReturnValue(true);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true, writable: true });
  });
  afterEach(() => setSecure(true));

  it('uses navigator.clipboard in a secure context', async () => {
    setSecure(true);
    await expect(copyText('ABCD-1234')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('ABCD-1234');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('falls back to a hidden textarea + execCommand on a plain-HTTP origin', async () => {
    setSecure(false);
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    let copiedValue = '';
    execCommand.mockImplementation(() => {
      copiedValue = (document.activeElement as HTMLTextAreaElement).value;
      return true;
    });
    await expect(copyText('WXYZ-9876')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(copiedValue).toBe('WXYZ-9876');
    // The helper cleans up after itself.
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('does not touch navigator.clipboard when the context is insecure', async () => {
    setSecure(false);
    await copyText('x');
    expect(writeText).not.toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('falls back when the Clipboard API rejects', async () => {
    setSecure(true);
    writeText.mockRejectedValue(new Error('denied'));
    await expect(copyText('x')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('reports failure when the browser refuses to copy', async () => {
    setSecure(false);
    execCommand.mockReturnValue(false);
    await expect(copyText('x')).resolves.toBe(false);
    execCommand.mockImplementation(() => {
      throw new Error('nope');
    });
    await expect(copyText('x')).resolves.toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('reports failure for empty text', async () => {
    await expect(copyText('')).resolves.toBe(false);
  });

  it('restores focus to the previously focused element', async () => {
    setSecure(false);
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    await copyText('x');
    expect(document.activeElement).toBe(button);
    button.remove();
  });
});

describe('selectElementText', () => {
  it('selects the element text', () => {
    const code = document.createElement('code');
    code.textContent = 'ABCD-1234';
    document.body.appendChild(code);
    selectElementText(code);
    expect(window.getSelection()?.toString()).toBe('ABCD-1234');
    code.remove();
  });

  it('ignores a null element', () => {
    expect(() => selectElementText(null)).not.toThrow();
  });
});
