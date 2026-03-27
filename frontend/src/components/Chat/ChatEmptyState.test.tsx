/**
 * Chat Empty State Tests
 *
 * @module components/Chat/ChatEmptyState.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ChatEmptyState } from './ChatEmptyState';

describe('ChatEmptyState', () => {
  it('renders with data-testid="empty-chat"', () => {
    render(<ChatEmptyState />);
    expect(screen.getByTestId('empty-chat')).toBeInTheDocument();
  });

  it('shows "Welcome to Crewly" heading', () => {
    render(<ChatEmptyState />);
    expect(screen.getByText('Welcome to Crewly')).toBeInTheDocument();
  });

  it('shows intro text', () => {
    render(<ChatEmptyState />);
    expect(
      screen.getByText('Start a conversation with the Orchestrator.')
    ).toBeInTheDocument();
  });

  it('renders 4 suggestion bullets', () => {
    render(<ChatEmptyState />);
    expect(screen.getByText('Create a new project')).toBeInTheDocument();
    expect(screen.getByText('Assign a task to an agent')).toBeInTheDocument();
    expect(screen.getByText('Check project status')).toBeInTheDocument();
    expect(screen.getByText('Configure a team')).toBeInTheDocument();
  });

  it('renders a list element', () => {
    render(<ChatEmptyState />);
    expect(screen.getByRole('list')).toBeInTheDocument();
  });
});
