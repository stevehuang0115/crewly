/**
 * Smoke renders for the BlueprintSidebar visual harness stories.
 * Catches regressions where a story stops rendering and would fail
 * silently in the preview route.
 *
 * @module components/Onboarding/v2-5/stories/BlueprintSidebar.stories.test
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  BLUEPRINT_SIDEBAR_STORIES,
  StoryAllEmpty,
  StoryAllPopulated,
  StoryBusinessProfilePopulated,
  StoryMatchReportPopulated,
} from './BlueprintSidebar.stories';

describe('BlueprintSidebar stories', () => {
  it('exposes all four stories in the registry', () => {
    expect(BLUEPRINT_SIDEBAR_STORIES.map((s) => s.id)).toEqual([
      'all-empty',
      'business-profile-populated',
      'match-report-populated',
      'all-populated',
    ]);
  });

  it('StoryAllEmpty renders with all blocks empty', () => {
    render(<StoryAllEmpty />);
    expect(screen.getByTestId('blueprint-block-business-profile')).toHaveAttribute(
      'data-state',
      'empty'
    );
    expect(screen.getByTestId('blueprint-block-match-report')).toHaveAttribute(
      'data-state',
      'empty'
    );
    expect(screen.getByTestId('blueprint-block-brand')).toHaveAttribute(
      'data-state',
      'empty'
    );
  });

  it('StoryBusinessProfilePopulated renders the profile block populated, others empty', () => {
    render(<StoryBusinessProfilePopulated />);
    expect(screen.getByTestId('blueprint-block-business-profile')).toHaveAttribute(
      'data-state',
      'populated'
    );
    expect(screen.getByTestId('blueprint-block-match-report')).toHaveAttribute(
      'data-state',
      'empty'
    );
  });

  it('StoryMatchReportPopulated renders both profile and match-report populated', () => {
    render(<StoryMatchReportPopulated />);
    expect(screen.getByTestId('blueprint-block-business-profile')).toHaveAttribute(
      'data-state',
      'populated'
    );
    expect(screen.getByTestId('blueprint-block-match-report')).toHaveAttribute(
      'data-state',
      'populated'
    );
    expect(screen.getByTestId('blueprint-block-brand')).toHaveAttribute(
      'data-state',
      'empty'
    );
  });

  it('StoryAllPopulated renders all five blocks populated', () => {
    render(<StoryAllPopulated />);
    ['business-profile', 'match-report', 'staffed-workflows', 'guardrails', 'brand'].forEach(
      (id) => {
        expect(screen.getByTestId(`blueprint-block-${id}`)).toHaveAttribute(
          'data-state',
          'populated'
        );
      }
    );
  });
});
