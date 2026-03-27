/**
 * Tests for StepReviewTeam component.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { StepReviewTeam } from './StepReviewTeam';
import type { TemplateInfo } from './onboarding.types';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockTemplate: TemplateInfo = {
  id: 'dev-fullstack',
  name: 'Fullstack Development Team',
  description: 'Team Leader + developers + QA',
  category: 'development',
  icon: 'laptop',
  roles: [
    { role: 'team-leader', label: 'Tech Lead', defaultName: 'Tech Lead', runtime: 'claude-code' },
    { role: 'developer', label: 'Developer', defaultName: 'Dev', runtime: 'claude-code', description: 'Writes code and tests' },
    { role: 'qa', label: 'QA Engineer', defaultName: 'QA', runtime: 'claude-code' },
  ],
};

describe('StepReviewTeam', () => {
  const defaultProps = {
    template: mockTemplate,
    teamName: 'My Dev Team',
    onTeamNameChange: vi.fn(),
    onNext: vi.fn(),
    onBack: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders template name in description', () => {
    render(<StepReviewTeam {...defaultProps} />);
    expect(screen.getByText('Fullstack Development Team')).toBeInTheDocument();
  });

  it('renders team name input with current value', () => {
    render(<StepReviewTeam {...defaultProps} />);
    const input = screen.getByTestId('team-name-input') as HTMLInputElement;
    expect(input.value).toBe('My Dev Team');
  });

  it('calls onTeamNameChange when input changes', () => {
    render(<StepReviewTeam {...defaultProps} />);
    const input = screen.getByTestId('team-name-input');
    fireEvent.change(input, { target: { value: 'New Name' } });
    expect(defaultProps.onTeamNameChange).toHaveBeenCalledWith('New Name');
  });

  it('renders all roles from template', () => {
    render(<StepReviewTeam {...defaultProps} />);
    expect(screen.getByText('Tech Lead')).toBeInTheDocument();
    expect(screen.getByText('Developer')).toBeInTheDocument();
    expect(screen.getByText('QA Engineer')).toBeInTheDocument();
  });

  it('shows member count', () => {
    render(<StepReviewTeam {...defaultProps} />);
    expect(screen.getByText('Team Members (3)')).toBeInTheDocument();
  });

  it('shows role runtime badge', () => {
    render(<StepReviewTeam {...defaultProps} />);
    const badges = screen.getAllByText('claude-code');
    expect(badges.length).toBe(3);
  });

  it('shows role description when available', () => {
    render(<StepReviewTeam {...defaultProps} />);
    expect(screen.getByText('Writes code and tests')).toBeInTheDocument();
  });

  it('disables Continue when team name is empty', () => {
    render(<StepReviewTeam {...defaultProps} teamName="" />);
    expect(screen.getByTestId('review-next-btn')).toBeDisabled();
  });

  it('enables Continue when team name is provided', () => {
    render(<StepReviewTeam {...defaultProps} />);
    expect(screen.getByTestId('review-next-btn')).not.toBeDisabled();
  });

  it('calls onNext when Continue clicked', () => {
    render(<StepReviewTeam {...defaultProps} />);
    fireEvent.click(screen.getByTestId('review-next-btn'));
    expect(defaultProps.onNext).toHaveBeenCalledTimes(1);
  });

  it('calls onBack when Back clicked', () => {
    render(<StepReviewTeam {...defaultProps} />);
    fireEvent.click(screen.getByTestId('review-back-btn'));
    expect(defaultProps.onBack).toHaveBeenCalledTimes(1);
  });

  it('shows fallback when template is null', () => {
    render(<StepReviewTeam {...defaultProps} template={null} />);
    expect(screen.getByText(/No template selected/)).toBeInTheDocument();
  });

  it('shows fallback when template has no roles', () => {
    const emptyTemplate = { ...mockTemplate, roles: [] };
    render(<StepReviewTeam {...defaultProps} template={emptyTemplate} />);
    expect(screen.getByText(/default roles/)).toBeInTheDocument();
  });
});
