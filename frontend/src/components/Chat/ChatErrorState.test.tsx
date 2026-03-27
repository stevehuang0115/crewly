/**
 * Chat Error State Tests
 *
 * @module components/Chat/ChatErrorState.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { ChatErrorState } from './ChatErrorState';

describe('ChatErrorState', () => {
  it('renders with data-testid="chat-error"', () => {
    render(<ChatErrorState error="Something broke" />);
    expect(screen.getByTestId('chat-error')).toBeInTheDocument();
  });

  it('displays the error message', () => {
    render(<ChatErrorState error="Connection failed" />);
    expect(screen.getByText(/Connection failed/)).toBeInTheDocument();
  });

  it('prefixes error with "Error:"', () => {
    render(<ChatErrorState error="timeout" />);
    expect(screen.getByText(/Error: timeout/)).toBeInTheDocument();
  });

  it('renders a Retry button', () => {
    render(<ChatErrorState error="fail" />);
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('reloads page when Retry is clicked', () => {
    const reloadMock = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadMock },
      writable: true,
    });

    render(<ChatErrorState error="fail" />);
    fireEvent.click(screen.getByText('Retry'));
    expect(reloadMock).toHaveBeenCalled();
  });

  it('renders an alert role element', () => {
    render(<ChatErrorState error="bad" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
