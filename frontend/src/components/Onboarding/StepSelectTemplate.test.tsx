/**
 * Tests for StepSelectTemplate component.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StepSelectTemplate } from './StepSelectTemplate';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockTemplates = [
  {
    id: 'dev-fullstack',
    name: 'Fullstack Development Team',
    description: 'Team Leader + developers + QA',
    category: 'development',
    icon: 'laptop',
    roles: [
      { role: 'team-leader', label: 'Tech Lead', defaultName: 'Tech Lead' },
      { role: 'developer', label: 'Developer', defaultName: 'Dev' },
    ],
  },
  {
    id: 'marketing-team',
    name: 'AI Marketing Team',
    description: '3-agent marketing team for SMBs',
    category: 'content',
    icon: 'megaphone',
    roles: [
      { role: 'strategist', label: 'Strategist', defaultName: 'Strategist' },
    ],
  },
];

describe('StepSelectTemplate', () => {
  const defaultProps = {
    selected: null,
    onSelect: vi.fn(),
    onNext: vi.fn(),
    onBack: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: mockTemplates }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows loading state initially', () => {
    render(<StepSelectTemplate {...defaultProps} />);
    expect(screen.getByText('Loading templates...')).toBeInTheDocument();
  });

  it('renders template cards after loading', async () => {
    render(<StepSelectTemplate {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Fullstack Development Team')).toBeInTheDocument();
      expect(screen.getByText('AI Marketing Team')).toBeInTheDocument();
    });
  });

  it('calls onSelect when a template card is clicked', async () => {
    render(<StepSelectTemplate {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('template-card-dev-fullstack')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('template-card-dev-fullstack'));
    expect(defaultProps.onSelect).toHaveBeenCalledWith(mockTemplates[0]);
  });

  it('disables Continue when no template selected', async () => {
    render(<StepSelectTemplate {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('template-next-btn')).toBeDisabled();
    });
  });

  it('enables Continue when template is selected', async () => {
    render(<StepSelectTemplate {...defaultProps} selected={mockTemplates[0]} />);
    await waitFor(() => {
      expect(screen.getByTestId('template-next-btn')).not.toBeDisabled();
    });
  });

  it('calls onBack when Back is clicked', async () => {
    render(<StepSelectTemplate {...defaultProps} />);
    await waitFor(() => {
      fireEvent.click(screen.getByTestId('template-back-btn'));
    });
    expect(defaultProps.onBack).toHaveBeenCalledTimes(1);
  });

  it('shows error state on fetch failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({}),
    });
    render(<StepSelectTemplate {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Failed to load templates')).toBeInTheDocument();
    });
  });

  it('shows role count and category badges', async () => {
    render(<StepSelectTemplate {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('2 roles')).toBeInTheDocument();
      expect(screen.getByText('development')).toBeInTheDocument();
    });
  });
});
