/**
 * RecommendedSetupCard Tests
 *
 * @module components/PortalOnboarding/RecommendedSetupCard.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { RecommendedSetupCard } from './RecommendedSetupCard';

describe('RecommendedSetupCard', () => {
  it('renders with all fields', () => {
    render(
      <RecommendedSetupCard
        template="Client Acquisition"
        teamName="Growth Team"
        workflow="Inbound follow-up"
        integration="Slack"
      />
    );
    expect(screen.getByTestId('recommended-setup-card')).toBeInTheDocument();
    expect(screen.getByText('Client Acquisition')).toBeInTheDocument();
    expect(screen.getByText('Growth Team')).toBeInTheDocument();
    expect(screen.getByText('Inbound follow-up')).toBeInTheDocument();
    expect(screen.getByText('Slack')).toBeInTheDocument();
  });

  it('renders nothing when no values', () => {
    const { container } = render(<RecommendedSetupCard />);
    expect(container.innerHTML).toBe('');
  });

  it('renders partial fields', () => {
    render(<RecommendedSetupCard template="Content Marketing" teamName="Marketing Team" />);
    expect(screen.getByText('Content Marketing')).toBeInTheDocument();
    expect(screen.getByText('Marketing Team')).toBeInTheDocument();
    expect(screen.queryByText('First workflow')).not.toBeInTheDocument();
  });

  it('renders card title', () => {
    render(<RecommendedSetupCard template="Test" />);
    expect(screen.getByText('Recommended Crewly Setup')).toBeInTheDocument();
  });
});
