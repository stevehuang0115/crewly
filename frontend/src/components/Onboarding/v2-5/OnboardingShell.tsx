/**
 * OnboardingShell — the two-pane container that hosts the entire
 * onboarding experience.
 *
 * Layout:
 *  - Left pane (`chatSlot`): the existing chat thread, injected by
 *    composition. We deliberately do **not** import the chat
 *    component here — the parent decides which chat surface to mount
 *    (LiveTeamChatPage in production, a stub in stories) so this
 *    shell stays orthogonal to chat-v2 evolution.
 *  - Right pane (`sidebarSlot` defaults to `<BlueprintSidebar />`):
 *    the live "Your AI Team Blueprint" sidebar.
 *
 * On viewports <1024px the sidebar collapses to an off-canvas drawer
 * triggered by an explicit button in the chat header. The shell
 * exposes `data-sidebar-open` so CSS handles the transform.
 *
 * Spec ref: §12.2 row F1, doc 70 v2 §3.
 *
 * @module components/Onboarding/v2-5/OnboardingShell
 */

import {
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { OnboardingBlueprintProvider } from './OnboardingBlueprintContext';
import { BlueprintSidebar } from './BlueprintSidebar';
import type { OnboardingBlueprint } from '../../../types/onboarding-blueprint.types';
import './OnboardingShell.css';

export interface OnboardingShellProps {
  /**
   * Left-pane content. Production callsites pass the existing
   * chat-v2 component (LiveTeamChatPage / ChatPanel) here; stories
   * and tests pass a stub. **Required** — the shell has no implicit
   * chat fallback so we don't accidentally fork chat-v2.
   */
  chatSlot: ReactNode;
  /**
   * Right-pane content. Defaults to the standard
   * `<BlueprintSidebar />`. Override only for stories / debug.
   */
  sidebarSlot?: ReactNode;
  /**
   * Optional initial Blueprint. Stories and tests pass populated
   * fixtures; production omits and lets the W2+ stream hydrate.
   */
  blueprint?: OnboardingBlueprint;
  /** Optional override for the sidebar's open/closed state on narrow viewports. */
  defaultSidebarOpen?: boolean;
}

/**
 * Render the onboarding two-pane shell.
 *
 * @param chatSlot - The chat thread (compose, don't fork).
 * @param sidebarSlot - The right-pane sidebar (defaults to BlueprintSidebar).
 * @param blueprint - Optional initial Blueprint fixture.
 * @param defaultSidebarOpen - Initial drawer state on narrow viewports.
 *
 * @example
 * ```tsx
 * <OnboardingShell chatSlot={<LiveTeamChatPage backendURL={url} />} />
 * ```
 */
export function OnboardingShell({
  chatSlot,
  sidebarSlot,
  blueprint,
  defaultSidebarOpen = false,
}: OnboardingShellProps): ReactNode {
  const [sidebarOpen, setSidebarOpen] = useState(defaultSidebarOpen);

  const resolvedSidebar = useMemo<ReactNode>(
    () => sidebarSlot ?? <BlueprintSidebar />,
    [sidebarSlot]
  );

  return (
    <OnboardingBlueprintProvider value={blueprint}>
      <div
        className="onboarding-shell"
        data-testid="onboarding-shell"
        data-sidebar-open={sidebarOpen ? 'true' : 'false'}
      >
        <div
          className="onboarding-shell__chat"
          data-testid="onboarding-shell-chat"
        >
          {/* Drawer trigger — only visible on narrow viewports via CSS. */}
          <button
            type="button"
            data-testid="onboarding-shell-sidebar-toggle"
            aria-label={
              sidebarOpen ? 'Hide AI Team Blueprint' : 'Show AI Team Blueprint'
            }
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen((prev) => !prev)}
            className="onboarding-shell__drawer-trigger md:hidden"
          >
            {sidebarOpen ? 'Hide Blueprint' : 'Show Blueprint'}
          </button>
          {chatSlot}
        </div>
        <div
          className="onboarding-shell__sidebar"
          data-testid="onboarding-shell-sidebar"
        >
          {resolvedSidebar}
        </div>
      </div>
    </OnboardingBlueprintProvider>
  );
}

export default OnboardingShell;
