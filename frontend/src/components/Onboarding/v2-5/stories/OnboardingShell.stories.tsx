/**
 * Local visual harness for OnboardingShell.
 *
 * Wraps each fixture with a fake chat panel so Mia can see the full
 * two-pane shape without needing a live backend.
 *
 * @module components/Onboarding/v2-5/stories/OnboardingShell.stories
 */

import type { CSSProperties, ReactNode } from 'react';
import { OnboardingShell } from '../OnboardingShell';
import {
  FIXTURE_ALL_EMPTY,
  FIXTURE_ALL_POPULATED,
  FIXTURE_BUSINESS_PROFILE,
  FIXTURE_MATCH_REPORT,
} from './fixtures';

/**
 * Stub chat surface used by all OnboardingShell stories. Reproduces
 * the visual silhouette of LiveTeamChatPage (header + scrolling
 * timeline + composer) without any of the backend wiring.
 */
function ChatStub(): ReactNode {
  return (
    <div
      data-testid="story-chat-stub"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: '#ffffff',
      }}
    >
      <header
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid #e5e7eb',
          fontWeight: 600,
        }}
      >
        Onboarding · Orc
      </header>
      <div
        style={{
          flex: 1,
          padding: '16px',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <div style={msgBubbleAgent}>
          Welcome! I'm the orc. Let's figure out what your AI team
          should do for you. What kind of business are you running?
        </div>
        <div style={msgBubbleUser}>
          A small boutique design studio for direct-to-consumer apparel
          brands.
        </div>
        <div style={msgBubbleAgent}>
          Got it — what's the workflow you wish you could hand off?
        </div>
      </div>
      <footer
        style={{
          padding: '12px 16px',
          borderTop: '1px solid #e5e7eb',
          background: '#f9fafb',
        }}
      >
        <input
          type="text"
          placeholder="Type a reply… (stubbed for preview)"
          style={{
            width: '100%',
            padding: '8px 12px',
            border: '1px solid #d1d5db',
            borderRadius: '6px',
            fontSize: '14px',
          }}
          disabled
        />
      </footer>
    </div>
  );
}

const msgBubbleAgent: CSSProperties = {
  alignSelf: 'flex-start',
  maxWidth: '80%',
  background: '#f3f4f6',
  borderRadius: '12px',
  padding: '8px 12px',
  fontSize: '14px',
};
const msgBubbleUser: CSSProperties = {
  alignSelf: 'flex-end',
  maxWidth: '80%',
  background: '#dbeafe',
  borderRadius: '12px',
  padding: '8px 12px',
  fontSize: '14px',
};

/**
 * Wraps the shell in a fixed-size container so the preview route
 * can show it embedded on a page. Production uses 100% height of
 * the app shell.
 */
function ShellHarness({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  return (
    <div
      style={{
        height: 720,
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      {children}
    </div>
  );
}

/** All blocks empty + chat stub. */
export function StoryShellAllEmpty(): ReactNode {
  return (
    <ShellHarness>
      <OnboardingShell chatSlot={<ChatStub />} blueprint={FIXTURE_ALL_EMPTY} />
    </ShellHarness>
  );
}

/** Discovery captured. */
export function StoryShellBusinessProfile(): ReactNode {
  return (
    <ShellHarness>
      <OnboardingShell
        chatSlot={<ChatStub />}
        blueprint={FIXTURE_BUSINESS_PROFILE}
      />
    </ShellHarness>
  );
}

/** Match Report rendered. */
export function StoryShellMatchReport(): ReactNode {
  return (
    <ShellHarness>
      <OnboardingShell
        chatSlot={<ChatStub />}
        blueprint={FIXTURE_MATCH_REPORT}
      />
    </ShellHarness>
  );
}

/** Fully populated. */
export function StoryShellAllPopulated(): ReactNode {
  return (
    <ShellHarness>
      <OnboardingShell
        chatSlot={<ChatStub />}
        blueprint={FIXTURE_ALL_POPULATED}
      />
    </ShellHarness>
  );
}

/** Stories registry — drives the preview route picker. */
export const ONBOARDING_SHELL_STORIES = [
  { id: 'shell-all-empty', label: 'Shell · all empty (S2)', render: StoryShellAllEmpty },
  {
    id: 'shell-business-profile',
    label: 'Shell · business profile (S3)',
    render: StoryShellBusinessProfile,
  },
  {
    id: 'shell-match-report',
    label: 'Shell · match report (S4)',
    render: StoryShellMatchReport,
  },
  {
    id: 'shell-all-populated',
    label: 'Shell · all populated (S5)',
    render: StoryShellAllPopulated,
  },
] as const;
