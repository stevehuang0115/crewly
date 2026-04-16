/**
 * Frontend types for the Magic Moment onboarding flow.
 *
 * These types mirror the backend OnboardingPrefill/PrefillField types
 * and add UI-specific state for the 3-step onboarding wizard.
 *
 * @module types/onboarding
 */

// =============================================================================
// Confidence & Extraction
// =============================================================================

/** AI confidence level for an extracted field */
export type PrefillConfidence = 'high' | 'medium' | 'low';

/** How the value was extracted */
export type PrefillExtractionMethod = 'llm_text' | 'llm_vision' | 'rule' | 'manual';

// =============================================================================
// Prefill Field
// =============================================================================

/**
 * A single AI-extracted field with provenance metadata.
 *
 * @template T - The value type (string or string[])
 */
export interface PrefillField<T = string | string[]> {
  /** Extracted or user-edited value */
  value: T;
  /** URLs from which this value was extracted */
  sourceUrls: string[];
  /** AI confidence in the extraction accuracy */
  confidence: PrefillConfidence;
  /** Method used for extraction */
  extractionMethod: PrefillExtractionMethod;
  /** Whether the user should explicitly review/confirm this value */
  needsReview: boolean;
  /** Supporting snippet from the source */
  sourceSnippet?: string;
}

// =============================================================================
// Onboarding Prefill (complete payload)
// =============================================================================

/** Complete set of AI-extracted prefill data */
export interface OnboardingPrefill {
  businessName?: PrefillField<string>;
  industryCategory?: PrefillField<string>;
  oneLineDescription?: PrefillField<string>;
  targetCustomerHypothesis?: PrefillField<string>;
  corePainPoint?: PrefillField<string>;
  valueProposition?: PrefillField<string>;
  tonePersonality?: PrefillField<string[]>;
  socialLinks?: PrefillField<string[]>;
  competitorCandidates?: PrefillField<string[]>;
  exampleContentLinks?: PrefillField<string[]>;
  recommendedTemplate?: PrefillField<string>;
  suggestedTeamName?: PrefillField<string>;
  suggestedFirstWorkflow?: PrefillField<string>;
  suggestedFirstIntegration?: PrefillField<string>;
}

// =============================================================================
// Session
// =============================================================================

/** Status of an onboarding session */
export type OnboardingSessionStatus =
  | 'not_started'
  | 'analyzing'
  | 'draft_ready'
  | 'in_progress'
  | 'completed'
  | 'failed';

/** Summary shown in the brand hero section */
export interface OnboardingSummary {
  companyName: string;
  industry: string;
  oneLineDescription: string;
  statusLabel: string;
}

/** Full onboarding session from the API */
export interface OnboardingSessionResponse {
  sessionId: string;
  websiteUrl: string;
  crawlScope?: string;
  status: OnboardingSessionStatus;
  summary?: OnboardingSummary;
  prefill?: OnboardingPrefill;
  missingFields?: string[];
  requiredReviewFields?: string[];
  error?: string;
  createdAt?: string;
  updatedAt?: string;
}

// =============================================================================
// UI State
// =============================================================================

/** Steps in the onboarding flow */
export type OnboardingStep = 'auth' | 'url-input' | 'analyzing' | 'review' | 'confirm' | 'creating' | 'success';

/** Progress rail step identifiers (user-visible labels) */
export type ProgressRailStep = 'connect' | 'analyze' | 'review' | 'create' | 'start';

/** Analysis progress stage labels */
export const ANALYSIS_STAGES = [
  'Reading homepage',
  'Finding about, product, and social pages',
  'Extracting brand summary',
  'Drafting your Crewly setup',
] as const;

/** Analysis stage type */
export type AnalysisStage = typeof ANALYSIS_STAGES[number];

// =============================================================================
// Review Card configuration
// =============================================================================

/** A field displayed in a review card */
export interface ReviewFieldConfig {
  /** Field key in OnboardingPrefill */
  key: keyof OnboardingPrefill;
  /** Display label */
  label: string;
  /** Whether this field is required for confirmation */
  required: boolean;
}

/** A review card with grouped fields */
export interface ReviewCardConfig {
  /** Card title */
  title: string;
  /** Card icon name (lucide) */
  icon: string;
  /** Fields in this card */
  fields: ReviewFieldConfig[];
}

/** Predefined review card layout matching the UI spec */
export const REVIEW_CARDS: ReviewCardConfig[] = [
  {
    title: 'Business Snapshot',
    icon: 'Building2',
    fields: [
      { key: 'businessName', label: 'Business Name', required: true },
      { key: 'industryCategory', label: 'Industry / Category', required: true },
      { key: 'oneLineDescription', label: 'Description', required: true },
    ],
  },
  {
    title: 'Audience & Positioning',
    icon: 'Users',
    fields: [
      { key: 'targetCustomerHypothesis', label: 'Target Customer', required: true },
      { key: 'corePainPoint', label: 'Core Pain Point', required: false },
      { key: 'valueProposition', label: 'Value Proposition', required: false },
      { key: 'tonePersonality', label: 'Tone / Personality', required: false },
      { key: 'competitorCandidates', label: 'Competitors', required: false },
    ],
  },
  {
    title: 'Presence & Signals',
    icon: 'Globe',
    fields: [
      { key: 'socialLinks', label: 'Social Links', required: false },
      { key: 'exampleContentLinks', label: 'Example Content', required: false },
    ],
  },
  {
    title: 'Recommended Crewly Setup',
    icon: 'Sparkles',
    fields: [
      { key: 'recommendedTemplate', label: 'Template', required: false },
      { key: 'suggestedTeamName', label: 'Team Name', required: false },
      { key: 'suggestedFirstWorkflow', label: 'First Workflow', required: false },
      { key: 'suggestedFirstIntegration', label: 'First Integration', required: false },
    ],
  },
];
