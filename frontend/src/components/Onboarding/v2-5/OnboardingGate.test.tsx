/**
 * Tests for OnboardingGate — the conditional-mount wrapper.
 *
 * @module components/Onboarding/v2-5/OnboardingGate.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OnboardingGate } from './OnboardingGate';
import { setOnboardingStatusForTests } from './useOnboardingStatus';

describe('OnboardingGate', () => {
  beforeEach(() => {
    setOnboardingStatusForTests(null);
  });

  afterEach(() => {
    setOnboardingStatusForTests(null);
  });

  it('renders the chat surface directly when mode=normal', () => {
    setOnboardingStatusForTests({ mode: 'normal', loading: false });
    render(
      <OnboardingGate>
        <div data-testid="chat">CHAT</div>
      </OnboardingGate>
    );
    expect(screen.getByTestId('chat')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-shell')).not.toBeInTheDocument();
  });

  it('renders the chat surface directly when mode=escape-hatch', () => {
    setOnboardingStatusForTests({ mode: 'escape-hatch', loading: false });
    render(
      <OnboardingGate>
        <div data-testid="chat">CHAT</div>
      </OnboardingGate>
    );
    expect(screen.getByTestId('chat')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-shell')).not.toBeInTheDocument();
  });

  it('mounts OnboardingShell with the chat slot when mode=onboarding', () => {
    setOnboardingStatusForTests({ mode: 'onboarding', loading: false });
    render(
      <OnboardingGate>
        <div data-testid="chat">CHAT</div>
      </OnboardingGate>
    );
    expect(screen.getByTestId('onboarding-shell')).toBeInTheDocument();
    // The chat surface is now hosted inside the shell's chat pane.
    const chatPane = screen.getByTestId('onboarding-shell-chat');
    expect(chatPane).toContainElement(screen.getByTestId('chat'));
    expect(screen.getByTestId('blueprint-sidebar')).toBeInTheDocument();
  });

  it('forceOnboarding overrides mode=normal', () => {
    setOnboardingStatusForTests({ mode: 'normal', loading: false });
    render(
      <OnboardingGate forceOnboarding>
        <div data-testid="chat">CHAT</div>
      </OnboardingGate>
    );
    expect(screen.getByTestId('onboarding-shell')).toBeInTheDocument();
  });
});
