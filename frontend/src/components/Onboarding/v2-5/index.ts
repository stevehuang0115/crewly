/**
 * Onboarding V2.5 — chat-first onboarding surface.
 *
 * Public exports for the W1 shell + sidebar. Consumers should
 * import the gate / shell / sidebar from here, not from individual
 * files, so we can rearrange the internal module layout without
 * breaking call-sites.
 *
 * Spec ref: `docs/crewly-pro/68-onboarding-solution-spec-v2.md` §12.2.
 *
 * @module components/Onboarding/v2-5
 */

export { OnboardingGate } from './OnboardingGate';
export type { OnboardingGateProps } from './OnboardingGate';

export { OnboardingShell } from './OnboardingShell';
export type { OnboardingShellProps } from './OnboardingShell';

export { BlueprintSidebar } from './BlueprintSidebar';
export type { BlueprintSidebarProps } from './BlueprintSidebar';

export {
  OnboardingBlueprintProvider,
  useOnboardingBlueprint,
} from './OnboardingBlueprintContext';
export type {
  OnboardingBlueprintProviderProps,
  OnboardingBlueprintContextValue,
} from './OnboardingBlueprintContext';

export {
  useOnboardingStatus,
  setOnboardingStatusForTests,
} from './useOnboardingStatus';

export { BusinessProfileBlock } from './blocks/BusinessProfileBlock';
export type { BusinessProfileBlockProps } from './blocks/BusinessProfileBlock';

export { MatchReportBlock } from './blocks/MatchReportBlock';
export type { MatchReportBlockProps } from './blocks/MatchReportBlock';

export { StaffedWorkflowsBlock } from './blocks/StaffedWorkflowsBlock';
export type { StaffedWorkflowsBlockProps } from './blocks/StaffedWorkflowsBlock';

export { GuardrailsBlock } from './blocks/GuardrailsBlock';
export type { GuardrailsBlockProps } from './blocks/GuardrailsBlock';

export { BrandBlock } from './blocks/BrandBlock';
export type { BrandBlockProps } from './blocks/BrandBlock';

export { BlueprintBlock } from './blocks/BlueprintBlock';
export type { BlueprintBlockProps } from './blocks/BlueprintBlock';
