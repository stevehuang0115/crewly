/**
 * Tests for StepLaunchProject component.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { StepLaunchProject } from './StepLaunchProject';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('StepLaunchProject', () => {
  const defaultProps = {
    projectPath: '',
    onProjectPathChange: vi.fn(),
    onLaunch: vi.fn(),
    onBack: vi.fn(),
    isCreating: false,
    error: null,
    teamName: 'My Dev Team',
    templateName: 'Fullstack Development Team',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders project path input', () => {
    render(<StepLaunchProject {...defaultProps} />);
    expect(screen.getByTestId('project-path-input')).toBeInTheDocument();
  });

  it('calls onProjectPathChange when input changes', () => {
    render(<StepLaunchProject {...defaultProps} />);
    const input = screen.getByTestId('project-path-input');
    fireEvent.change(input, { target: { value: '/my/project' } });
    expect(defaultProps.onProjectPathChange).toHaveBeenCalledWith('/my/project');
  });

  it('shows summary card with team and template names', () => {
    render(<StepLaunchProject {...defaultProps} />);
    expect(screen.getByText('My Dev Team')).toBeInTheDocument();
    expect(screen.getByText('Fullstack Development Team')).toBeInTheDocument();
  });

  it('shows project path in summary when provided', () => {
    render(<StepLaunchProject {...defaultProps} projectPath="/path/to/project" />);
    expect(screen.getByText('/path/to/project')).toBeInTheDocument();
  });

  it('shows "Launch Team" button', () => {
    render(<StepLaunchProject {...defaultProps} />);
    expect(screen.getByTestId('launch-btn')).toBeInTheDocument();
    expect(screen.getByText('Launch Team')).toBeInTheDocument();
  });

  it('calls onLaunch when Launch button clicked', () => {
    render(<StepLaunchProject {...defaultProps} />);
    fireEvent.click(screen.getByTestId('launch-btn'));
    expect(defaultProps.onLaunch).toHaveBeenCalledTimes(1);
  });

  it('shows loading state when creating', () => {
    render(<StepLaunchProject {...defaultProps} isCreating={true} />);
    expect(screen.getByText('Creating...')).toBeInTheDocument();
    expect(screen.getByTestId('launch-btn')).toBeDisabled();
  });

  it('disables path input when creating', () => {
    render(<StepLaunchProject {...defaultProps} isCreating={true} />);
    expect(screen.getByTestId('project-path-input')).toBeDisabled();
  });

  it('shows error message when error is present', () => {
    render(<StepLaunchProject {...defaultProps} error="Team creation failed" />);
    expect(screen.getByTestId('launch-error')).toBeInTheDocument();
    expect(screen.getByText('Team creation failed')).toBeInTheDocument();
  });

  it('calls onBack when Back clicked', () => {
    render(<StepLaunchProject {...defaultProps} />);
    fireEvent.click(screen.getByTestId('launch-back-btn'));
    expect(defaultProps.onBack).toHaveBeenCalledTimes(1);
  });

  it('disables Back button when creating', () => {
    render(<StepLaunchProject {...defaultProps} isCreating={true} />);
    expect(screen.getByTestId('launch-back-btn')).toBeDisabled();
  });
});
