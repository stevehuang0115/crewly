/**
 * OnboardingBlueprintContext — the React context that hydrates the
 * sidebar with the user's emerging Blueprint.
 *
 * **W1 stub**: the provider seeds the context with an empty
 * Blueprint via `createEmptyBlueprint()` so visual tests and the
 * preview route can exercise every block in its empty state. A
 * `value` prop lets stories / tests inject populated fixtures.
 *
 * **W2+**: the provider gains a server-sent stream subscription
 * (B8) and updates the Blueprint in-place as the orc emits
 * extraction events. Consumers don't change.
 *
 * Usage:
 *
 * ```tsx
 * <OnboardingBlueprintProvider>
 *   <BlueprintSidebar />
 * </OnboardingBlueprintProvider>
 * ```
 *
 * Inside any descendant:
 *
 * ```tsx
 * const { blueprint } = useOnboardingBlueprint();
 * ```
 *
 * @module components/Onboarding/v2-5/OnboardingBlueprintContext
 */

import {
  createContext,
  useContext,
  useMemo,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import {
  createEmptyBlueprint,
  type OnboardingBlueprint,
} from '../../../types/onboarding-blueprint.types';

// =============================================================================
// Context shape
// =============================================================================

/**
 * Value exposed by `useOnboardingBlueprint()`.
 */
export interface OnboardingBlueprintContextValue {
  /** The current Blueprint (always defined, possibly empty). */
  blueprint: OnboardingBlueprint;
  /**
   * True while the W2+ stream is hydrating. Always `false` in W1.
   * Carrying it now means W2 swap is a one-line change.
   */
  isStreaming: boolean;
}

const OnboardingBlueprintContext =
  createContext<OnboardingBlueprintContextValue | null>(null);

// =============================================================================
// Provider
// =============================================================================

export interface OnboardingBlueprintProviderProps extends PropsWithChildren {
  /**
   * Override the default empty Blueprint. Stories / tests pass
   * populated fixtures through this prop; production callers omit
   * it (W1) or omit it (W2+ — provider fetches its own data).
   */
  value?: OnboardingBlueprint;
  /** Optional `isStreaming` override, defaults to `false`. */
  isStreaming?: boolean;
}

/**
 * Provider for the Blueprint context.
 *
 * @param children - Subtree that will read via `useOnboardingBlueprint`.
 * @param value - Optional Blueprint override (test / story fixture).
 * @param isStreaming - Optional streaming-state override.
 *
 * @example
 * ```tsx
 * // W1: empty blueprint (default)
 * <OnboardingBlueprintProvider>
 *   <BlueprintSidebar />
 * </OnboardingBlueprintProvider>
 *
 * // W1 story: populated fixture
 * <OnboardingBlueprintProvider value={fixtureBp}>
 *   <BlueprintSidebar />
 * </OnboardingBlueprintProvider>
 * ```
 */
export function OnboardingBlueprintProvider({
  children,
  value,
  isStreaming = false,
}: OnboardingBlueprintProviderProps): ReactNode {
  const ctxValue = useMemo<OnboardingBlueprintContextValue>(
    () => ({
      blueprint: value ?? createEmptyBlueprint(),
      isStreaming,
    }),
    [value, isStreaming]
  );
  return (
    <OnboardingBlueprintContext.Provider value={ctxValue}>
      {children}
    </OnboardingBlueprintContext.Provider>
  );
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Read the current Blueprint from context.
 *
 * Throws when called outside an `<OnboardingBlueprintProvider>` so
 * misconfigurations fail loudly in dev rather than silently
 * rendering empty UI.
 *
 * @returns `{ blueprint, isStreaming }`.
 * @throws Error when no provider is mounted in the ancestor tree.
 *
 * @example
 * ```tsx
 * function BusinessProfileBlock() {
 *   const { blueprint } = useOnboardingBlueprint();
 *   const profile = blueprint.businessProfile;
 *   if (!profile) return <EmptyState />;
 *   return <Filled profile={profile} />;
 * }
 * ```
 */
export function useOnboardingBlueprint(): OnboardingBlueprintContextValue {
  const ctx = useContext(OnboardingBlueprintContext);
  if (ctx == null) {
    throw new Error(
      'useOnboardingBlueprint must be used inside <OnboardingBlueprintProvider>'
    );
  }
  return ctx;
}

export default OnboardingBlueprintContext;
