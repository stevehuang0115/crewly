/**
 * ConfirmDialog Component Tests
 *
 * @module components/UI/ConfirmDialog.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  const defaultProps = {
    isOpen: true,
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    message: 'Are you sure?',
  };

  it('renders the message when open', () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByTestId('confirm-dialog-message').textContent).toBe('Are you sure?');
  });

  it('does not render when closed', () => {
    render(<ConfirmDialog {...defaultProps} isOpen={false} />);
    expect(screen.queryByTestId('confirm-dialog-message')).toBeNull();
  });

  it('calls onConfirm when confirm button clicked', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} />);
    await userEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when cancel button clicked', async () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog {...defaultProps} onCancel={onCancel} />);
    await userEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('uses custom confirm and cancel labels', () => {
    render(
      <ConfirmDialog
        {...defaultProps}
        confirmLabel="Delete"
        cancelLabel="Keep"
      />,
    );
    expect(screen.getByTestId('confirm-dialog-confirm').textContent).toContain('Delete');
    expect(screen.getByTestId('confirm-dialog-cancel').textContent).toContain('Keep');
  });

  it('disables confirm button when loading', () => {
    render(<ConfirmDialog {...defaultProps} loading />);
    expect(screen.getByTestId('confirm-dialog-confirm')).toBeDisabled();
  });

  it('renders custom title', () => {
    render(<ConfirmDialog {...defaultProps} title="Delete Item" />);
    expect(screen.getByText('Delete Item')).toBeDefined();
  });
});
