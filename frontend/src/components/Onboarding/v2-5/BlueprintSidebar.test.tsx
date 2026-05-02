/**
 * Tests for BlueprintSidebar.
 *
 * @module components/Onboarding/v2-5/BlueprintSidebar.test
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { BlueprintSidebar } from './BlueprintSidebar';
import { OnboardingBlueprintProvider } from './OnboardingBlueprintContext';
import { BLUEPRINT_BLOCK_IDS } from '../../../types/onboarding-blueprint.types';

describe('BlueprintSidebar', () => {
  it('throws when rendered without a provider', () => {
    const consoleError = console.error;
    console.error = () => {};
    try {
      expect(() => render(<BlueprintSidebar />)).toThrow(
        /must be used inside <OnboardingBlueprintProvider>/
      );
    } finally {
      console.error = consoleError;
    }
  });

  it('renders all five blocks in spec order with the empty Blueprint', () => {
    render(
      <OnboardingBlueprintProvider>
        <BlueprintSidebar />
      </OnboardingBlueprintProvider>
    );
    const sidebar = screen.getByTestId('blueprint-sidebar');
    const blocks = within(sidebar).getAllByTestId(/^blueprint-block-/);
    // 5 blocks (each `getAllByTestId` match is the section element only,
    // not the title/empty/body inside, because regex anchors at start
    // of the data-testid string).
    const sectionBlocks = blocks.filter((el) => el.tagName === 'SECTION');
    expect(sectionBlocks).toHaveLength(5);

    const order = sectionBlocks.map((el) => el.getAttribute('data-block-id'));
    expect(order).toEqual([...BLUEPRINT_BLOCK_IDS]);
  });

  it('uses the default aria-label "Your AI Team Blueprint"', () => {
    render(
      <OnboardingBlueprintProvider>
        <BlueprintSidebar />
      </OnboardingBlueprintProvider>
    );
    expect(screen.getByLabelText('Your AI Team Blueprint')).toBeInTheDocument();
  });

  it('honours a custom ariaLabel', () => {
    render(
      <OnboardingBlueprintProvider>
        <BlueprintSidebar ariaLabel="Onboarding sidebar" />
      </OnboardingBlueprintProvider>
    );
    expect(screen.getByLabelText('Onboarding sidebar')).toBeInTheDocument();
  });

  it('renders all blocks empty by default', () => {
    render(
      <OnboardingBlueprintProvider>
        <BlueprintSidebar />
      </OnboardingBlueprintProvider>
    );
    BLUEPRINT_BLOCK_IDS.forEach((id) => {
      expect(screen.getByTestId(`blueprint-block-${id}`)).toHaveAttribute(
        'data-state',
        'empty'
      );
    });
  });

  it('flips a block to populated when the Blueprint hydrates that field', () => {
    render(
      <OnboardingBlueprintProvider
        value={{
          stage: 'S3',
          businessProfile: { industry: 'SaaS', customer: 'SMB' },
        }}
      >
        <BlueprintSidebar />
      </OnboardingBlueprintProvider>
    );
    expect(screen.getByTestId('blueprint-block-business-profile')).toHaveAttribute(
      'data-state',
      'populated'
    );
    // Other blocks remain empty.
    expect(screen.getByTestId('blueprint-block-match-report')).toHaveAttribute(
      'data-state',
      'empty'
    );
    expect(screen.getByTestId('blueprint-block-staffed-workflows')).toHaveAttribute(
      'data-state',
      'empty'
    );
    expect(screen.getByTestId('blueprint-block-guardrails')).toHaveAttribute(
      'data-state',
      'empty'
    );
    expect(screen.getByTestId('blueprint-block-brand')).toHaveAttribute(
      'data-state',
      'empty'
    );
  });

  it('renders all blocks populated when the Blueprint is fully hydrated', () => {
    render(
      <OnboardingBlueprintProvider
        value={{
          stage: 'S5',
          businessProfile: { industry: 'SaaS', customer: 'SMB', workflow: 'wf', pain: 'pn' },
          matchReport: {
            autonomous: [{ workflowId: 'w1', name: 'Newsletter', description: '' }],
            collaborative: [],
            roadmap: [],
            outOfScope: [],
          },
          staffedWorkflows: [
            { workflowId: 'w1', name: 'Newsletter', description: '' },
          ],
          guardrails: ['no political topics'],
          brand: {
            voiceChips: ['crisp'],
            tone: 'Friendly',
            approvalChannel: 'Slack',
          },
        }}
      >
        <BlueprintSidebar />
      </OnboardingBlueprintProvider>
    );
    BLUEPRINT_BLOCK_IDS.forEach((id) => {
      expect(screen.getByTestId(`blueprint-block-${id}`)).toHaveAttribute(
        'data-state',
        'populated'
      );
    });
  });
});
