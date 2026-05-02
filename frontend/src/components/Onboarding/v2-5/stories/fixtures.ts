/**
 * Mock Blueprint fixtures used by the local visual harness + tests.
 *
 * @module components/Onboarding/v2-5/stories/fixtures
 */

import type { OnboardingBlueprint } from '../../../../types/onboarding-blueprint.types';

/** All blocks empty — what the user sees at S2. */
export const FIXTURE_ALL_EMPTY: OnboardingBlueprint = {
  stage: 'S2',
};

/** Discovery in progress — D1/D2/D3 captured. */
export const FIXTURE_BUSINESS_PROFILE: OnboardingBlueprint = {
  stage: 'S3',
  businessProfile: {
    industry: 'Boutique design studio',
    customer: 'Direct-to-consumer apparel brands',
    workflow: 'Weekly Instagram + email campaign drafting',
    pain: 'No time to keep up with content cadence',
  },
};

/** Match Report rendered — used for the W3 preview. */
export const FIXTURE_MATCH_REPORT: OnboardingBlueprint = {
  ...FIXTURE_BUSINESS_PROFILE,
  stage: 'S4',
  candidateTasks: [
    {
      raw: 'Help me draft 2 Instagram posts a week',
      extractedIntent: 'social-content-drafting',
      topMatches: [
        { workflowId: 'wf-social-drafter', score: 0.91 },
        { workflowId: 'wf-newsletter', score: 0.62 },
      ],
      chosenTier: 'autonomous',
    },
    {
      raw: 'Reply to customer DMs',
      extractedIntent: 'inbox-triage',
      topMatches: [
        { workflowId: 'wf-inbox-triage', score: 0.83 },
      ],
      chosenTier: 'collaborative',
    },
  ],
  matchReport: {
    autonomous: [
      {
        workflowId: 'wf-social-drafter',
        name: 'Instagram Drafter',
        description: 'Drafts 2 IG posts a week from your brand voice and recent activity.',
        estimatedValue: '~3 hrs/wk',
        domain: 'marketing',
      },
      {
        workflowId: 'wf-newsletter',
        name: 'Weekly Newsletter Writer',
        description: 'Drafts your weekly customer newsletter from CRM activity.',
        estimatedValue: '~2 hrs/wk',
        domain: 'marketing',
      },
    ],
    collaborative: [
      {
        workflowId: 'wf-inbox-triage',
        name: 'Inbox Triage Assistant',
        description: 'Triages inbound customer DMs; you approve replies before they ship.',
        domain: 'support',
      },
    ],
    roadmap: [
      { workflow: 'TikTok auto-poster', eta: 'Q3 2026' },
    ],
    outOfScope: [
      { task: 'Run pop-up retail events', workaround: 'Use a dedicated events agency' },
    ],
  },
};

/** Fully populated Blueprint — every block lit up. */
export const FIXTURE_ALL_POPULATED: OnboardingBlueprint = {
  ...FIXTURE_MATCH_REPORT,
  stage: 'S5',
  staffedWorkflows: [
    {
      workflowId: 'wf-social-drafter',
      name: 'Instagram Drafter',
      description: 'Drafts 2 IG posts a week from your brand voice.',
      estimatedValue: '3 hrs/wk',
    },
    {
      workflowId: 'wf-newsletter',
      name: 'Weekly Newsletter Writer',
      description: 'Drafts your weekly newsletter.',
      estimatedValue: '2 hrs/wk',
    },
  ],
  guardrails: [
    'No political topics',
    'No medical advice',
    'Always disclose AI authorship',
  ],
  brand: {
    voiceChips: ['Playful', 'Crisp', 'Warm'],
    tone: 'Friendly',
    approvalChannel: 'Slack #content-approvals',
  },
};
