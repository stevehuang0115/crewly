/**
 * Chat Loading State Tests
 *
 * @module components/Chat/ChatLoadingState.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ChatLoadingState } from './ChatLoadingState';

describe('ChatLoadingState', () => {
  it('renders with data-testid="chat-loading"', () => {
    render(<ChatLoadingState />);
    expect(screen.getByTestId('chat-loading')).toBeInTheDocument();
  });

  it('renders default message "Loading..."', () => {
    render(<ChatLoadingState />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders custom message when provided', () => {
    render(<ChatLoadingState message="Loading conversation..." />);
    expect(screen.getByText('Loading conversation...')).toBeInTheDocument();
  });

  it('renders a spinner element', () => {
    render(<ChatLoadingState />);
    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });

  it('has accessible role="status"', () => {
    render(<ChatLoadingState />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
