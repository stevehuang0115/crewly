/**
 * CreationSummaryPanel Tests
 *
 * @module components/PortalOnboarding/CreationSummaryPanel.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CreationSummaryPanel } from './CreationSummaryPanel';

describe('CreationSummaryPanel', () => {
  const baseProps = {
    teamName: 'Growth Team',
    template: 'Client Acquisition',
    workflow: 'Lead follow-up',
    integration: 'Slack',
    onConfirm: vi.fn(),
    onBack: vi.fn(),
  };

  it('renders team name and optional fields', () => {
    render(<CreationSummaryPanel {...baseProps} />);
    expect(screen.getByText('Growth Team')).toBeInTheDocument();
    expect(screen.getByText('Client Acquisition')).toBeInTheDocument();
    expect(screen.getByText('Lead follow-up')).toBeInTheDocument();
    expect(screen.getByText('Slack')).toBeInTheDocument();
  });

  it('renders confirmation checkbox', () => {
    render(<CreationSummaryPanel {...baseProps} />);
    expect(screen.getByTestId('creation-confirm-checkbox')).toBeInTheDocument();
  });

  it('disables create button when not confirmed', () => {
    render(<CreationSummaryPanel {...baseProps} isConfirmed={false} />);
    expect(screen.getByTestId('create-workspace-btn')).toBeDisabled();
  });

  it('enables create button when confirmed', () => {
    render(<CreationSummaryPanel {...baseProps} isConfirmed={true} />);
    expect(screen.getByTestId('create-workspace-btn')).not.toBeDisabled();
  });

  it('calls onConfirm when create clicked', () => {
    const onConfirm = vi.fn();
    render(<CreationSummaryPanel {...baseProps} onConfirm={onConfirm} isConfirmed={true} />);
    fireEvent.click(screen.getByTestId('create-workspace-btn'));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('calls onBack when back clicked', () => {
    const onBack = vi.fn();
    render(<CreationSummaryPanel {...baseProps} onBack={onBack} />);
    fireEvent.click(screen.getByTestId('back-to-review-btn'));
    expect(onBack).toHaveBeenCalled();
  });

  it('disables create button when submitting', () => {
    render(<CreationSummaryPanel {...baseProps} isConfirmed={true} isSubmitting={true} />);
    expect(screen.getByTestId('create-workspace-btn')).toBeDisabled();
  });

  it('disables create button when blocking fields exist', () => {
    render(<CreationSummaryPanel {...baseProps} isConfirmed={true} hasBlockingFields={true} />);
    expect(screen.getByTestId('create-workspace-btn')).toBeDisabled();
  });

  it('toggles checkbox', () => {
    const onChange = vi.fn();
    render(<CreationSummaryPanel {...baseProps} isConfirmed={false} onConfirmedChange={onChange} />);
    fireEvent.click(screen.getByTestId('creation-confirm-checkbox'));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
