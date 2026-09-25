/**
 * Onboarding barrel exports: the step indicator and the first-run checklist
 * steps used by `/setup` and the dashboard "开始使用" card.
 *
 * The old modal wizard (OnboardingWizard: template → review → cloud →
 * launch) was removed in Phase 3; `/setup` replaced it.
 *
 * @module components/Onboarding
 */

export { StepIndicator } from './StepIndicator';
export { StarterTeamStep } from './StarterTeamStep';
export type { StarterTeamDone, StarterTeamStepProps } from './StarterTeamStep';
export { FirstTaskStep } from './FirstTaskStep';
export { CloudConnectStep } from './CloudConnectStep';
export { SlackConnectStep } from './SlackConnectStep';
export { GettingStartedCard } from './GettingStartedCard';
