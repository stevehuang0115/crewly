/**
 * Local visual harness for BlueprintSidebar.
 *
 * Each named export is a small render-this story. The preview route
 * `/onboarding-preview` mounts these for Mia + Steve to review.
 *
 * @module components/Onboarding/v2-5/stories/BlueprintSidebar.stories
 */

import type { ReactNode } from 'react';
import { BlueprintSidebar } from '../BlueprintSidebar';
import { OnboardingBlueprintProvider } from '../OnboardingBlueprintContext';
import {
  FIXTURE_ALL_EMPTY,
  FIXTURE_ALL_POPULATED,
  FIXTURE_BUSINESS_PROFILE,
  FIXTURE_MATCH_REPORT,
} from './fixtures';

/** All blocks empty — the S2 first-touch render. */
export function StoryAllEmpty(): ReactNode {
  return (
    <OnboardingBlueprintProvider value={FIXTURE_ALL_EMPTY}>
      <div style={{ width: 360, height: 720 }}>
        <BlueprintSidebar />
      </div>
    </OnboardingBlueprintProvider>
  );
}

/** Discovery just captured the business profile — S3. */
export function StoryBusinessProfilePopulated(): ReactNode {
  return (
    <OnboardingBlueprintProvider value={FIXTURE_BUSINESS_PROFILE}>
      <div style={{ width: 360, height: 720 }}>
        <BlueprintSidebar />
      </div>
    </OnboardingBlueprintProvider>
  );
}

/** Match Report rendered — S4 with mock B7 output. */
export function StoryMatchReportPopulated(): ReactNode {
  return (
    <OnboardingBlueprintProvider value={FIXTURE_MATCH_REPORT}>
      <div style={{ width: 360, height: 720 }}>
        <BlueprintSidebar />
      </div>
    </OnboardingBlueprintProvider>
  );
}

/** Fully populated Blueprint — S5 ready-to-hire view. */
export function StoryAllPopulated(): ReactNode {
  return (
    <OnboardingBlueprintProvider value={FIXTURE_ALL_POPULATED}>
      <div style={{ width: 360, height: 720 }}>
        <BlueprintSidebar />
      </div>
    </OnboardingBlueprintProvider>
  );
}

/** Stories registry — drives the preview route picker. */
export const BLUEPRINT_SIDEBAR_STORIES = [
  { id: 'all-empty', label: 'All empty (S2)', render: StoryAllEmpty },
  {
    id: 'business-profile-populated',
    label: 'Business profile populated (S3)',
    render: StoryBusinessProfilePopulated,
  },
  {
    id: 'match-report-populated',
    label: 'Match Report populated (S4)',
    render: StoryMatchReportPopulated,
  },
  {
    id: 'all-populated',
    label: 'All populated (S5)',
    render: StoryAllPopulated,
  },
] as const;
