/**
 * Smoke renders for the OnboardingShell visual harness stories.
 *
 * @module components/Onboarding/v2-5/stories/OnboardingShell.stories.test
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  ONBOARDING_SHELL_STORIES,
  StoryShellAllEmpty,
  StoryShellAllPopulated,
  StoryShellBusinessProfile,
  StoryShellMatchReport,
} from './OnboardingShell.stories';

describe('OnboardingShell stories', () => {
  it('exposes all four stories in the registry', () => {
    expect(ONBOARDING_SHELL_STORIES.map((s) => s.id)).toEqual([
      'shell-all-empty',
      'shell-business-profile',
      'shell-match-report',
      'shell-all-populated',
    ]);
  });

  it('StoryShellAllEmpty renders shell + chat stub + empty sidebar blocks', () => {
    render(<StoryShellAllEmpty />);
    expect(screen.getByTestId('onboarding-shell')).toBeInTheDocument();
    expect(screen.getByTestId('story-chat-stub')).toBeInTheDocument();
    expect(screen.getByTestId('blueprint-block-business-profile')).toHaveAttribute(
      'data-state',
      'empty'
    );
  });

  it('StoryShellBusinessProfile renders the profile block populated', () => {
    render(<StoryShellBusinessProfile />);
    expect(screen.getByTestId('blueprint-block-business-profile')).toHaveAttribute(
      'data-state',
      'populated'
    );
  });

  it('StoryShellMatchReport renders the match-report block populated', () => {
    render(<StoryShellMatchReport />);
    expect(screen.getByTestId('blueprint-block-match-report')).toHaveAttribute(
      'data-state',
      'populated'
    );
  });

  it('StoryShellAllPopulated lights up every block', () => {
    render(<StoryShellAllPopulated />);
    [
      'business-profile',
      'match-report',
      'staffed-workflows',
      'guardrails',
      'brand',
    ].forEach((id) => {
      expect(screen.getByTestId(`blueprint-block-${id}`)).toHaveAttribute(
        'data-state',
        'populated'
      );
    });
  });
});
