/**
 * Tests for CopyButton.
 *
 * @module components/Harness/CopyButton.test
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CopyButton } from './CopyButton';

describe('CopyButton', () => {
  const writeText = vi.fn();
  const execCommand = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    writeText.mockReset().mockResolvedValue(undefined);
    execCommand.mockReset().mockReturnValue(false);
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true, writable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true, writable: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true, writable: true });
  });

  it('copies and shows a transient confirmation', async () => {
    render(<CopyButton value="ABCD-1234" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('copy-button'));
    });
    expect(writeText).toHaveBeenCalledWith('ABCD-1234');
    expect(screen.getByText('Copied')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText('Copy')).toBeInTheDocument();
  });

  it('copies over plain HTTP via the execCommand fallback', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true, writable: true });
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    execCommand.mockReturnValue(true);
    render(<CopyButton value="WXYZ-9876" label="Copy code" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('copy-button'));
    });
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(screen.getByText('Copied')).toBeInTheDocument();
  });

  it('asks for a manual copy when every path fails', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    render(<CopyButton value="x" label="Copy code" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('copy-button'));
    });
    expect(screen.getByText('Select and copy manually')).toBeInTheDocument();
    expect(screen.getByTestId('copy-button')).toHaveAttribute('data-copy-status', 'failed');
  });
});
