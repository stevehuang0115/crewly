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

  beforeEach(() => {
    vi.useFakeTimers();
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });
  afterEach(() => vi.useRealTimers());

  it('copies and shows a transient confirmation', async () => {
    render(<CopyButton value="ABCD-1234" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('copy-button'));
    });
    expect(writeText).toHaveBeenCalledWith('ABCD-1234');
    expect(screen.getByText('已复制')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText('复制')).toBeInTheDocument();
  });

  it('ignores clipboard failures', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    render(<CopyButton value="x" label="复制验证码" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('copy-button'));
    });
    expect(screen.getByText('复制验证码')).toBeInTheDocument();
  });
});
