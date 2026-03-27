/**
 * SaveButton Component Tests
 *
 * @module components/UI/SaveButton.test
 */

import React from 'react';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SaveButton } from './SaveButton';
import type { SaveStatus } from './SaveButton';

describe('SaveButton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // Status rendering
  // =========================================================================

  describe('status display', () => {
    it('shows "Save" label and idle state by default', () => {
      render(<SaveButton onClick={vi.fn()} />);
      const btn = screen.getByTestId('save-button');
      expect(btn).toHaveTextContent('Save');
      expect(btn).toHaveAttribute('data-status', 'idle');
    });

    it('shows "Saving…" and spinner when status=saving', () => {
      render(<SaveButton onClick={vi.fn()} status="saving" />);
      const btn = screen.getByTestId('save-button');
      expect(btn).toHaveTextContent('Saving…');
      expect(btn).toBeDisabled();
    });

    it('shows "Saved" when status=saved', () => {
      render(<SaveButton onClick={vi.fn()} status="saved" />);
      const btn = screen.getByTestId('save-button');
      expect(btn).toHaveTextContent('Saved');
      expect(btn).toHaveAttribute('data-status', 'saved');
    });

    it('shows "Retry" when status=error', () => {
      render(<SaveButton onClick={vi.fn()} status="error" />);
      const btn = screen.getByTestId('save-button');
      expect(btn).toHaveTextContent('Retry');
      expect(btn).toHaveAttribute('data-status', 'error');
    });

    it('allows custom children to override default label', () => {
      render(<SaveButton onClick={vi.fn()} status="idle">Apply Changes</SaveButton>);
      expect(screen.getByTestId('save-button')).toHaveTextContent('Apply Changes');
    });
  });

  // =========================================================================
  // Click handling
  // =========================================================================

  describe('click handling', () => {
    it('calls onClick when clicked in idle state', async () => {
      vi.useRealTimers();
      const onClick = vi.fn();
      render(<SaveButton onClick={onClick} status="idle" />);
      await userEvent.click(screen.getByTestId('save-button'));
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('does not call onClick when saving (disabled)', async () => {
      vi.useRealTimers();
      const onClick = vi.fn();
      render(<SaveButton onClick={onClick} status="saving" />);
      await userEvent.click(screen.getByTestId('save-button'));
      expect(onClick).not.toHaveBeenCalled();
    });

    it('does not call onClick when disabled', async () => {
      vi.useRealTimers();
      const onClick = vi.fn();
      render(<SaveButton onClick={onClick} disabled />);
      await userEvent.click(screen.getByTestId('save-button'));
      expect(onClick).not.toHaveBeenCalled();
    });

    it('calls onClick when in error state (retry)', async () => {
      vi.useRealTimers();
      const onClick = vi.fn();
      render(<SaveButton onClick={onClick} status="error" />);
      await userEvent.click(screen.getByTestId('save-button'));
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Button variant per status
  // =========================================================================

  describe('button variant per status', () => {
    const variantTests: [SaveStatus, string][] = [
      ['idle', 'bg-primary'],
      ['saving', 'bg-primary'],
      ['saved', 'bg-emerald-600'],
      ['error', 'bg-rose-600'],
    ];

    it.each(variantTests)('status="%s" uses variant with class %s', (status, expectedClass) => {
      render(<SaveButton onClick={vi.fn()} status={status} />);
      expect(screen.getByTestId('save-button')).toHaveClass(expectedClass);
    });
  });

  // =========================================================================
  // Disabled state
  // =========================================================================

  describe('disabled state', () => {
    it('is disabled when disabled=true', () => {
      render(<SaveButton onClick={vi.fn()} disabled />);
      expect(screen.getByTestId('save-button')).toBeDisabled();
    });

    it('is disabled while saving', () => {
      render(<SaveButton onClick={vi.fn()} status="saving" />);
      expect(screen.getByTestId('save-button')).toBeDisabled();
    });

    it('is NOT disabled in idle state by default', () => {
      render(<SaveButton onClick={vi.fn()} status="idle" />);
      expect(screen.getByTestId('save-button')).not.toBeDisabled();
    });
  });

  // =========================================================================
  // Custom className
  // =========================================================================

  describe('custom className', () => {
    it('merges custom className', () => {
      render(<SaveButton onClick={vi.fn()} className="w-full" />);
      expect(screen.getByTestId('save-button')).toHaveClass('w-full');
    });
  });

  // =========================================================================
  // data-testid
  // =========================================================================

  describe('testid', () => {
    it('has data-testid="save-button"', () => {
      render(<SaveButton onClick={vi.fn()} />);
      expect(screen.getByTestId('save-button')).toBeInTheDocument();
    });
  });
});
