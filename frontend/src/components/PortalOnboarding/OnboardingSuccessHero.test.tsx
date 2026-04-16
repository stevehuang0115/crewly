/**
 * OnboardingSuccessHero Tests
 *
 * @module components/PortalOnboarding/OnboardingSuccessHero.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { OnboardingSuccessHero } from './OnboardingSuccessHero';

describe('OnboardingSuccessHero', () => {
  it('renders success title', () => {
    render(<OnboardingSuccessHero teamName="Growth Team" />);
    expect(screen.getByTestId('success-title')).toHaveTextContent('Your workspace is ready');
  });

  it('renders auto-generated subtitle with workflow', () => {
    render(<OnboardingSuccessHero teamName="Growth Team" workflow="Inbound follow-up" />);
    expect(screen.getByTestId('success-subtitle')).toHaveTextContent(
      'Growth Team is set up for Inbound follow-up.'
    );
  });

  it('renders custom summary when provided', () => {
    render(<OnboardingSuccessHero teamName="Test" summary="Custom summary text" />);
    expect(screen.getByTestId('success-subtitle')).toHaveTextContent('Custom summary text');
  });

  it('renders fallback subtitle without workflow', () => {
    render(<OnboardingSuccessHero teamName="Marketing Team" />);
    expect(screen.getByTestId('success-subtitle')).toHaveTextContent('Marketing Team is ready to go.');
  });

  it('shows integration badge when recommended', () => {
    render(<OnboardingSuccessHero teamName="Team" status="integration-recommended" />);
    expect(screen.getByTestId('success-integration-badge')).toBeInTheDocument();
  });

  it('does not show integration badge by default', () => {
    render(<OnboardingSuccessHero teamName="Team" />);
    expect(screen.queryByTestId('success-integration-badge')).not.toBeInTheDocument();
  });
});
