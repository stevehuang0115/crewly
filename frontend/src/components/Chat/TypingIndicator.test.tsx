/**
 * Typing Indicator Tests
 *
 * Tests for the TypingIndicator component.
 *
 * @module components/Chat/TypingIndicator.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TypingIndicator } from './TypingIndicator';

describe('TypingIndicator', () => {
  it('renders the typing indicator', () => {
    render(<TypingIndicator />);
    expect(screen.getByTestId('typing-indicator')).toBeInTheDocument();
  });

  it('shows orchestrator sender icon (Lucide Bot)', () => {
    render(<TypingIndicator />);
    // Bot icon renders as SVG inside the sender-icon span
    const senderIcon = screen.getByTestId('typing-indicator').querySelector('.sender-icon svg');
    expect(senderIcon).toBeInTheDocument();
  });

  it('shows orchestrator name', () => {
    render(<TypingIndicator />);
    expect(screen.getByText('Orchestrator')).toBeInTheDocument();
  });

  it('renders three animated dots', () => {
    render(<TypingIndicator />);
    const dots = screen.getByLabelText('Orchestrator is typing');
    expect(dots).toBeInTheDocument();
    expect(dots.querySelectorAll('.dot')).toHaveLength(3);
  });

  it('has correct CSS classes for animation', () => {
    render(<TypingIndicator />);
    const indicator = screen.getByTestId('typing-indicator');
    expect(indicator).toHaveClass('typing-indicator');
  });
});
