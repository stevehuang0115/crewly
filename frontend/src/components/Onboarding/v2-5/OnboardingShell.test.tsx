/**
 * Tests for OnboardingShell.
 *
 * @module components/Onboarding/v2-5/OnboardingShell.test
 */

import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { OnboardingShell } from './OnboardingShell';

describe('OnboardingShell', () => {
  it('renders the chat slot in the left pane', () => {
    render(
      <OnboardingShell
        chatSlot={<div data-testid="chat-stub">CHAT</div>}
      />
    );
    const shell = screen.getByTestId('onboarding-shell');
    const chatPane = screen.getByTestId('onboarding-shell-chat');
    expect(shell).toContainElement(chatPane);
    expect(screen.getByTestId('chat-stub')).toHaveTextContent('CHAT');
  });

  it('mounts the BlueprintSidebar in the right pane by default', () => {
    render(<OnboardingShell chatSlot={<div>chat</div>} />);
    expect(screen.getByTestId('blueprint-sidebar')).toBeInTheDocument();
  });

  it('honours a custom sidebarSlot override', () => {
    render(
      <OnboardingShell
        chatSlot={<div>chat</div>}
        sidebarSlot={<div data-testid="custom-sidebar">CUSTOM</div>}
      />
    );
    expect(screen.getByTestId('custom-sidebar')).toHaveTextContent('CUSTOM');
    expect(screen.queryByTestId('blueprint-sidebar')).not.toBeInTheDocument();
  });

  it('passes an initial Blueprint through to the sidebar context', () => {
    render(
      <OnboardingShell
        chatSlot={<div>chat</div>}
        blueprint={{
          stage: 'S3',
          businessProfile: { industry: 'SaaS' },
        }}
      />
    );
    expect(
      screen.getByTestId('blueprint-block-business-profile')
    ).toHaveAttribute('data-state', 'populated');
  });

  it('starts with sidebar closed by default', () => {
    render(<OnboardingShell chatSlot={<div>chat</div>} />);
    expect(screen.getByTestId('onboarding-shell')).toHaveAttribute(
      'data-sidebar-open',
      'false'
    );
  });

  it('honours defaultSidebarOpen=true', () => {
    render(
      <OnboardingShell chatSlot={<div>chat</div>} defaultSidebarOpen={true} />
    );
    expect(screen.getByTestId('onboarding-shell')).toHaveAttribute(
      'data-sidebar-open',
      'true'
    );
  });

  it('toggles the sidebar drawer when the trigger is clicked', () => {
    render(<OnboardingShell chatSlot={<div>chat</div>} />);
    const trigger = screen.getByTestId('onboarding-shell-sidebar-toggle');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    expect(screen.getByTestId('onboarding-shell')).toHaveAttribute(
      'data-sidebar-open',
      'true'
    );
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(trigger);
    expect(screen.getByTestId('onboarding-shell')).toHaveAttribute(
      'data-sidebar-open',
      'false'
    );
  });
});
