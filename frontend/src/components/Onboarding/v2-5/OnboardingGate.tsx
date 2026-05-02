/**
 * OnboardingGate — decides whether to mount the OnboardingShell or
 * fall back to the standard chat surface, based on orc mode.
 *
 * Spec acceptance: "Component is mounted only when orc
 * `mode === 'onboarding'`. Outside `onboarding` mode, fall back to
 * the existing chat-only view."
 *
 * Composition contract: caller passes the chat surface (already
 * mounted) as `children`. If the orc is in `onboarding` mode the
 * gate hands `children` to OnboardingShell as `chatSlot`; otherwise
 * it renders `children` directly.
 *
 * This keeps the chat component tree stable across mode transitions
 * — re-parenting only happens at the gate boundary, not inside the
 * chat itself, so message state survives the swap.
 *
 * Spec ref: §3.2 Trigger Mechanism, §12.2 row F1.
 *
 * @module components/Onboarding/v2-5/OnboardingGate
 */

import type { ReactNode } from 'react';
import { useOnboardingStatus } from './useOnboardingStatus';
import { OnboardingShell } from './OnboardingShell';

export interface OnboardingGateProps {
  /**
   * The chat surface (LiveTeamChatPage / ChatPanel / etc).
   *
   * In `normal` mode it renders directly. In `onboarding` mode it
   * is hosted inside OnboardingShell as the left-pane chatSlot.
   */
  children: ReactNode;
  /**
   * Optional override that bypasses the mode check and always
   * renders the OnboardingShell. Useful for stories / preview routes.
   */
  forceOnboarding?: boolean;
}

/**
 * Mount OnboardingShell when the orc is in onboarding mode,
 * otherwise pass the chat surface through unchanged.
 *
 * @param children - The chat surface.
 * @param forceOnboarding - Story / preview override.
 *
 * @example
 * ```tsx
 * <OnboardingGate>
 *   <LiveTeamChatPage backendURL={backend} />
 * </OnboardingGate>
 * ```
 */
export function OnboardingGate({
  children,
  forceOnboarding,
}: OnboardingGateProps): ReactNode {
  const status = useOnboardingStatus();
  const shouldMount =
    Boolean(forceOnboarding) || status.mode === 'onboarding';

  if (!shouldMount) {
    return <>{children}</>;
  }
  return <OnboardingShell chatSlot={children} />;
}

export default OnboardingGate;
