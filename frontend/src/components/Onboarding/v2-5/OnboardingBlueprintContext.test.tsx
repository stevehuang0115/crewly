/**
 * Tests for OnboardingBlueprintContext / useOnboardingBlueprint.
 *
 * @module components/Onboarding/v2-5/OnboardingBlueprintContext.test
 */

import { describe, it, expect } from 'vitest';
import { render, renderHook, screen } from '@testing-library/react';
import {
  OnboardingBlueprintProvider,
  useOnboardingBlueprint,
} from './OnboardingBlueprintContext';
import type { OnboardingBlueprint } from '../../../types/onboarding-blueprint.types';

describe('OnboardingBlueprintProvider', () => {
  it('seeds an empty (S2) Blueprint when no value is passed', () => {
    const { result } = renderHook(() => useOnboardingBlueprint(), {
      wrapper: ({ children }) => (
        <OnboardingBlueprintProvider>{children}</OnboardingBlueprintProvider>
      ),
    });
    expect(result.current.blueprint.stage).toBe('S2');
    expect(result.current.blueprint.businessProfile).toBeUndefined();
    expect(result.current.isStreaming).toBe(false);
  });

  it('exposes the supplied fixture verbatim', () => {
    const fixture: OnboardingBlueprint = {
      stage: 'S3',
      businessProfile: {
        industry: 'SaaS',
        customer: 'SMB',
        workflow: 'newsletter',
        pain: 'no time',
      },
    };
    const { result } = renderHook(() => useOnboardingBlueprint(), {
      wrapper: ({ children }) => (
        <OnboardingBlueprintProvider value={fixture}>
          {children}
        </OnboardingBlueprintProvider>
      ),
    });
    expect(result.current.blueprint).toBe(fixture);
  });

  it('supports an explicit isStreaming=true override', () => {
    const { result } = renderHook(() => useOnboardingBlueprint(), {
      wrapper: ({ children }) => (
        <OnboardingBlueprintProvider isStreaming>
          {children}
        </OnboardingBlueprintProvider>
      ),
    });
    expect(result.current.isStreaming).toBe(true);
  });

  it('renders descendants', () => {
    render(
      <OnboardingBlueprintProvider>
        <span data-testid="child">hello</span>
      </OnboardingBlueprintProvider>
    );
    expect(screen.getByTestId('child')).toHaveTextContent('hello');
  });
});

describe('useOnboardingBlueprint', () => {
  it('throws a helpful error when called without a provider', () => {
    // Suppress the React error boundary log for this expected throw.
    const consoleError = console.error;
    console.error = () => {};
    try {
      expect(() => renderHook(() => useOnboardingBlueprint())).toThrow(
        /must be used inside <OnboardingBlueprintProvider>/
      );
    } finally {
      console.error = consoleError;
    }
  });
});
