/**
 * Type definitions for the Brand Onboarding flow.
 *
 * The onboarding flow collects brand information from SMB owners
 * and generates a Brand Voice Guide used by marketing team agents.
 *
 * @module brand-onboarding-types
 */

// =============================================================================
// Questionnaire Types
// =============================================================================

/** A single onboarding question with metadata. */
export interface OnboardingQuestion {
  /** Unique question identifier */
  id: string;
  /** Question text displayed to the user */
  text: string;
  /** Input type determines UI rendering and validation */
  type: 'text' | 'select' | 'multi-select';
  /** Available options for select/multi-select types */
  options?: string[];
  /** Whether a response is required */
  required: boolean;
  /** Placeholder/hint text */
  placeholder?: string;
  /** Default value if not answered */
  defaultValue?: string;
  /** Order in the questionnaire (1-based) */
  order: number;
}

/** User's answer to a single question. */
export interface OnboardingAnswer {
  /** Matches OnboardingQuestion.id */
  questionId: string;
  /** User's response value */
  value: string;
  /** Timestamp of when the answer was provided */
  answeredAt: string;
}

/** Status of the onboarding session. */
export type OnboardingStatus =
  | 'not_started'
  | 'in_progress'
  | 'completed'
  | 'generating'
  | 'done'
  | 'failed';

/** A complete onboarding session tracking state. */
export interface OnboardingSession {
  /** Unique session identifier */
  id: string;
  /** Team ID this onboarding belongs to */
  teamId: string;
  /** Template ID that triggered onboarding */
  templateId: string;
  /** Current status */
  status: OnboardingStatus;
  /** Collected answers so far */
  answers: OnboardingAnswer[];
  /** Index of the current question (0-based) */
  currentQuestionIndex: number;
  /** Total number of questions */
  totalQuestions: number;
  /** Generated Brand Voice Guide content (populated after completion) */
  brandVoiceGuide?: string;
  /** Path where the guide was saved */
  guidePath?: string;
  /** Session creation time */
  createdAt: string;
  /** Last update time */
  updatedAt: string;
  /** Error message if status is 'failed' */
  error?: string;
}

// =============================================================================
// Brand Voice Guide Types
// =============================================================================

/** Structured brand profile extracted from onboarding answers. */
export interface BrandProfile {
  /** Business name */
  businessName: string;
  /** Industry/vertical */
  industry: string;
  /** One-sentence business description */
  description: string;
  /** Target customer description */
  targetCustomer: string;
  /** Top competitors */
  competitors: string[];
  /** Brand personality words (e.g., Professional, Friendly, Bold) */
  personality: string[];
  /** Content tone */
  tone: 'formal' | 'casual' | 'playful' | 'authoritative';
  /** Marketing goals */
  goals: string[];
  /** Active social platforms */
  platforms: string[];
  /** Example content URLs or descriptions */
  contentExamples: string[];
}

/** Options for generating the Brand Voice Guide. */
export interface GenerateGuideOptions {
  /** Brand profile from questionnaire answers */
  profile: BrandProfile;
  /** Output directory path for the guide file */
  outputDir: string;
  /** Whether to use LLM to enhance the guide with Do's/Don'ts */
  useLLM?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/** The 10 onboarding questions defined by the marketing template spec. */
export const ONBOARDING_QUESTIONS: OnboardingQuestion[] = [
  {
    id: 'business_name',
    text: 'What is your business name?',
    type: 'text',
    required: true,
    placeholder: 'e.g., Sunrise Bakery',
    order: 1,
  },
  {
    id: 'industry',
    text: 'What industry are you in?',
    type: 'text',
    required: true,
    placeholder: 'e.g., Fashion, Food, Fitness, Tech, Education',
    order: 2,
  },
  {
    id: 'description',
    text: 'Describe your business in one sentence.',
    type: 'text',
    required: true,
    placeholder: 'e.g., We make artisan sourdough bread for health-conscious families.',
    order: 3,
  },
  {
    id: 'target_customer',
    text: 'Who is your target customer? (Age, interests, problems they have)',
    type: 'text',
    required: true,
    placeholder: 'e.g., Health-conscious millennials, 25-40, interested in organic food',
    order: 4,
  },
  {
    id: 'competitors',
    text: 'What are your top 3 competitors?',
    type: 'text',
    required: false,
    placeholder: 'e.g., Blue Apron, HelloFresh, Local Bakery XYZ',
    defaultValue: 'Not specified',
    order: 5,
  },
  {
    id: 'personality',
    text: 'Describe your brand personality in 3 words.',
    type: 'text',
    required: true,
    placeholder: 'e.g., Professional, Friendly, Bold',
    order: 6,
  },
  {
    id: 'tone',
    text: 'What tone should your content have?',
    type: 'select',
    options: ['Formal', 'Casual', 'Playful', 'Authoritative'],
    required: true,
    order: 7,
  },
  {
    id: 'goals',
    text: 'What are your marketing goals?',
    type: 'multi-select',
    options: ['Brand awareness', 'Lead generation', 'Sales', 'Community building'],
    required: true,
    order: 8,
  },
  {
    id: 'platforms',
    text: 'Which platforms do you use?',
    type: 'multi-select',
    options: ['X (Twitter)', 'LinkedIn', 'Instagram', 'Facebook'],
    required: true,
    order: 9,
  },
  {
    id: 'content_examples',
    text: 'Share 2-3 examples of content you like (URLs or descriptions).',
    type: 'text',
    required: false,
    placeholder: 'e.g., https://twitter.com/brand/status/123, "Wendy\'s snarky tone on Twitter"',
    defaultValue: 'Not specified',
    order: 10,
  },
];

/** Default content mix ratios for the Brand Voice Guide. */
export const DEFAULT_CONTENT_MIX = {
  educational: 60,
  behindTheScenes: 20,
  promotional: 15,
  interactive: 5,
} as const;
