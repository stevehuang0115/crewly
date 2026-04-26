/**
 * ChatErrorToast tests — verify the small Phase C toast renders the
 * expected text + dismiss semantics.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatErrorToast } from './ChatErrorToast';

describe('ChatErrorToast', () => {
  it('renders the headline message and the alert role', () => {
    render(<ChatErrorToast message="Could not send message" />);
    const toast = screen.getByTestId('chat-error-toast');
    expect(toast).toHaveAttribute('role', 'alert');
    expect(screen.getByText('Could not send message')).toBeInTheDocument();
  });

  it('renders an optional detail block when provided', () => {
    render(
      <ChatErrorToast
        message="Thread root not found"
        detail="threadId msg-99 is missing"
      />,
    );
    const detail = screen.getByTestId('chat-error-toast-detail');
    expect(detail).toHaveTextContent('threadId msg-99 is missing');
  });

  it('omits the detail block when no detail is supplied', () => {
    render(<ChatErrorToast message="Send failed" />);
    expect(screen.queryByTestId('chat-error-toast-detail')).not.toBeInTheDocument();
  });

  it('renders the dismiss button only when onDismiss is provided', () => {
    const { rerender } = render(<ChatErrorToast message="Send failed" />);
    expect(screen.queryByTestId('chat-error-toast-dismiss')).not.toBeInTheDocument();

    const onDismiss = vi.fn();
    rerender(<ChatErrorToast message="Send failed" onDismiss={onDismiss} />);
    expect(screen.getByTestId('chat-error-toast-dismiss')).toBeInTheDocument();
  });

  it('invokes onDismiss when the dismiss button is clicked', async () => {
    const onDismiss = vi.fn();
    render(<ChatErrorToast message="Send failed" onDismiss={onDismiss} />);
    await userEvent.click(screen.getByTestId('chat-error-toast-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
