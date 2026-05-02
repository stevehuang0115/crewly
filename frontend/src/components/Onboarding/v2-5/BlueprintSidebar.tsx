/**
 * BlueprintSidebar — the right pane of OnboardingShell.
 *
 * Composes the five `BlueprintBlock`s in spec order, hydrating each
 * from the `OnboardingBlueprintContext`. Block rendering decides
 * empty vs populated; this component just wires the data + ordering.
 *
 * Spec ref: §3 Live Blueprint, §12.2 row F2.
 *
 * @module components/Onboarding/v2-5/BlueprintSidebar
 */

import type { ReactNode } from 'react';
import { useOnboardingBlueprint } from './OnboardingBlueprintContext';
import { BusinessProfileBlock } from './blocks/BusinessProfileBlock';
import { MatchReportBlock } from './blocks/MatchReportBlock';
import { StaffedWorkflowsBlock } from './blocks/StaffedWorkflowsBlock';
import { GuardrailsBlock } from './blocks/GuardrailsBlock';
import { BrandBlock } from './blocks/BrandBlock';

export interface BlueprintSidebarProps {
  /** Optional accessible label for the aside; defaults to "Your AI Team Blueprint". */
  ariaLabel?: string;
}

/**
 * Render the "Your AI Team Blueprint" sidebar.
 *
 * Must be wrapped in an `<OnboardingBlueprintProvider>` ancestor —
 * otherwise the context hook throws.
 *
 * @param ariaLabel - Optional override for the `aria-label` (used by
 *   screen readers and the local visual harness).
 *
 * @example
 * ```tsx
 * <OnboardingBlueprintProvider value={mockBp}>
 *   <BlueprintSidebar />
 * </OnboardingBlueprintProvider>
 * ```
 */
export function BlueprintSidebar({
  ariaLabel = 'Your AI Team Blueprint',
}: BlueprintSidebarProps = {}): ReactNode {
  const { blueprint } = useOnboardingBlueprint();

  return (
    <aside
      data-testid="blueprint-sidebar"
      aria-label={ariaLabel}
      className="blueprint-sidebar flex h-full w-full flex-col gap-3 overflow-y-auto bg-gray-50 p-4"
    >
      <header className="mb-1">
        <h2 className="text-base font-semibold text-gray-900">{ariaLabel}</h2>
        <p className="text-xs text-gray-500">
          Live updates as you chat. Each block fills in when the orc
          captures the answer.
        </p>
      </header>
      <BusinessProfileBlock profile={blueprint.businessProfile} />
      <MatchReportBlock report={blueprint.matchReport} />
      <StaffedWorkflowsBlock workflows={blueprint.staffedWorkflows} />
      <GuardrailsBlock guardrails={blueprint.guardrails} />
      <BrandBlock brand={blueprint.brand} />
    </aside>
  );
}

export default BlueprintSidebar;
