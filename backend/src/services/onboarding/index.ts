/**
 * Onboarding service exports.
 *
 * @module onboarding
 */

export { BrandOnboardingService } from './brand-onboarding.service.js';
export {
  ONBOARDING_QUESTIONS,
  DEFAULT_CONTENT_MIX,
} from './brand-onboarding.types.js';
export type {
  OnboardingQuestion,
  OnboardingAnswer,
  OnboardingSession,
  OnboardingStatus,
  BrandProfile,
  GenerateGuideOptions,
} from './brand-onboarding.types.js';

export { ContentApprovalService } from './content-approval.service.js';
export {
  CONTENT_APPROVAL_TTL_MS,
  MAX_PENDING_APPROVALS,
} from './content-approval.types.js';
export type {
  ContentApprovalRequest,
  ContentApprovalStatus,
  SubmitForApprovalOptions,
  ApprovalResolution,
} from './content-approval.types.js';
