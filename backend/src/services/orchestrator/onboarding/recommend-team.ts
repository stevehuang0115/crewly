/**
 * Recommend-Team Logic (Onboarding v3, v0)
 *
 * Pure function: turns a business-context payload (collected during the
 * onboarding conversation) into a concrete team recommendation
 * (template + agents + responsibilities).
 *
 * v0 strategy: 5 hardcoded heuristic mappings that cover the ~80% case
 * Steve and Sam expect to see during the Mon 5/4 EOD demo, plus a
 * generic 2-agent fallback for everything else. Real RAG over Mia's
 * spec v3 + doc 69 + the live template registry lands Wed–Fri.
 *
 * Importantly, the function is **pure** (no FS, no API, no clock) —
 * tests exercise the mapping logic directly without mocks.
 *
 * @module services/orchestrator/onboarding/recommend-team
 */

// =============================================================================
// Types — kept inline so this module has no cross-package dependencies.
// =============================================================================

/**
 * Feasibility tier for a single user-named task. Mirrors the four tiers
 * the system prompt requires orc to use literally.
 */
export type FeasibilityTier =
  | 'yes-today'       // ✅ Crewly does this autonomously today.
  | 'collaborative'   // 🤝 Crewly does this with user input/approval.
  | 'roadmap'         // ⏳ Planned, not shipped.
  | 'out-of-scope';   // ❌ Won't do.

/**
 * Scale buckets — the conversation captures one of these in phase 2.
 */
export type BusinessScale = 'solo' | 'small-team' | 'company';

/**
 * One task the user named, with the feasibility verdict orc reached
 * during phase 3.
 */
export interface NamedTask {
  /** Free-text task name as the user said it. */
  readonly name: string;
  /** Feasibility verdict orc decided on. */
  readonly tier: FeasibilityTier;
}

/**
 * Business context collected by phases 1–3 of the onboarding flow.
 * Passed to {@link recommendTeam} to produce the proposal.
 */
export interface BusinessContext {
  /** Free-text industry / domain (e.g. "e-commerce skincare on Shopify"). */
  readonly industry: string;
  /** Coarse team-size bucket. */
  readonly scale: BusinessScale;
  /** Tasks the user named, with orc's feasibility verdict per task. */
  readonly tasks: readonly NamedTask[];
}

/**
 * One agent the recommendation proposes.
 */
export interface RecommendedAgent {
  /** Logical role (e.g. "content-drafter", "support-triage"). */
  readonly role: string;
  /** One-sentence responsibility blurb shown to the user during phase 4. */
  readonly responsibilities: string;
  /** Skills the agent will be given. */
  readonly skillIds: readonly string[];
}

/**
 * The recommendation returned to orc and shown to the user before
 * confirmation.
 */
export interface TeamRecommendation {
  /** Template ID from `config/templates/*.json`. */
  readonly templateId: string;
  /** 2–4 agents, each with role + responsibilities + skills. */
  readonly agents: readonly RecommendedAgent[];
  /** Short rationale string ("why this team for you"). */
  readonly reasoning: string;
  /** Which mapping fired (`"hardcoded:<key>"` or `"fallback"`). */
  readonly source: string;
}

// =============================================================================
// Hardcoded mappings — v0 (Mon 5/4 EOD)
// =============================================================================

/**
 * Match strategy for one hardcoded mapping. We score each mapping
 * against the input by counting keyword hits in the industry string +
 * task names; the highest score wins. Ties break by mapping order
 * (first declared wins) — keep the most specific mappings at the top.
 */
interface HardcodedMapping {
  /** Stable identifier — also used in `recommendation.source`. */
  readonly key: string;
  /** Lowercase keywords that, when matched, increase the score. */
  readonly keywords: readonly string[];
  /** Built recommendation when this mapping wins. */
  readonly build: (ctx: BusinessContext) => TeamRecommendation;
}

/**
 * Build a recommendation given a key + template + agents + rationale.
 * Internal helper to avoid repeating the source/reasoning shape.
 */
function build(
  key: string,
  templateId: string,
  agents: readonly RecommendedAgent[],
  reasoning: string,
): TeamRecommendation {
  return {
    templateId,
    agents,
    reasoning,
    source: `hardcoded:${key}`,
  };
}

/**
 * The 5 hardcoded mappings — ordered most-specific first.
 *
 * Each mapping is keyed off a small lowercase keyword set; the
 * highest-scoring mapping wins. If no mapping scores ≥1, the generic
 * fallback fires.
 */
const HARDCODED_MAPPINGS: readonly HardcodedMapping[] = [
  // --- 1. E-commerce + content + customer support (Steve's anchor demo)
  {
    key: 'ecommerce-content-support',
    keywords: [
      'shopify',
      'e-commerce',
      'ecommerce',
      'dtc',
      'skincare',
      'apparel',
      'retail',
      'storefront',
      'support',
      'content',
    ],
    build: (ctx) =>
      build(
        'ecommerce-content-support',
        'dtc-viral-content-team',
        [
          {
            role: 'content-drafter',
            responsibilities:
              'Drafts weekly blog + social content tuned to your storefront and audience.',
            skillIds: ['content-drafter', 'content-calendar'],
          },
          {
            role: 'support-triage',
            responsibilities:
              'Triages incoming customer messages and prepares first-draft replies for your approval.',
            skillIds: ['support-triage'],
          },
        ],
        `You named e-commerce + content + support. The content drafter handles your weekly publishing cadence; the support triage agent keeps inbound from piling up while leaving the send button to you. ${ctx.scale === 'solo' ? 'Sized 2-agent because solo founders should not babysit a big team.' : ''}`.trim(),
      ),
  },
  // --- 2. Solo content creator / social-first
  {
    key: 'solo-creator',
    keywords: [
      'creator',
      'youtube',
      'tiktok',
      'instagram',
      'newsletter',
      'blog',
      'podcast',
      'video',
      'social',
    ],
    build: () =>
      build(
        'solo-creator',
        'ai-video-social-team',
        [
          {
            role: 'content-drafter',
            responsibilities:
              'Plans + drafts your content schedule across platforms.',
            skillIds: ['content-drafter', 'content-calendar', 'content-repurposer'],
          },
          {
            role: 'trend-monitor',
            responsibilities:
              'Watches the trends and topic signals in your niche so your drafts ride the wave.',
            skillIds: ['trend-monitor'],
          },
        ],
        'Your work centres on content production. Drafting + trend monitoring is the smallest team that meaningfully removes the daily-content treadmill.',
      ),
  },
  // --- 3. Engineering / SaaS dev team
  {
    key: 'engineering',
    keywords: [
      'saas',
      'software',
      'engineering',
      'dev',
      'developer',
      'startup',
      'product',
      'b2b',
      'platform',
      'mvp',
    ],
    build: (ctx) =>
      build(
        'engineering',
        ctx.scale === 'solo' ? 'pragmatic-mvp-dev-team' : 'web-dev-team',
        [
          {
            role: 'code-reviewer',
            responsibilities:
              'Reviews pull requests for style, obvious bugs, and missing tests.',
            skillIds: ['code-reviewer'],
          },
          {
            role: 'data-analyst',
            responsibilities:
              'Pulls product metrics into a daily report so you do not lose signal in the build cycle.',
            skillIds: ['data-summarizer', 'scheduled-reporter'],
          },
        ],
        `For a ${ctx.scale === 'solo' ? 'solo MVP push' : 'small engineering team'}, the highest-leverage agents are code review + a data summariser that surfaces the metrics you forget to check.`,
      ),
  },
  // --- 4. Customer support / ops focus
  {
    key: 'support-ops',
    keywords: [
      'support',
      'helpdesk',
      'tickets',
      'customer service',
      'cs',
      'ops',
      'operations',
      'feedback',
    ],
    build: () =>
      build(
        'support-ops',
        'customer-ops-team',
        [
          {
            role: 'support-triage',
            responsibilities:
              'Triages inbound and drafts replies; you stay in the loop on send.',
            skillIds: ['support-triage'],
          },
          {
            role: 'data-analyst',
            responsibilities:
              'Summarises ticket trends so the same issue does not surprise you twice.',
            skillIds: ['feedback-analyzer', 'data-summarizer'],
          },
        ],
        'Your time-sinks are on the support side. A triage agent removes the inbox sprint; a feedback analyst catches the patterns under the noise.',
      ),
  },
  // --- 5. Growth / marketing-heavy
  {
    key: 'growth-marketing',
    keywords: [
      'marketing',
      'growth',
      'seo',
      'ads',
      'paid',
      'distribution',
      'pipeline',
      'lead gen',
      'leadgen',
      'agency',
    ],
    build: () =>
      build(
        'growth-marketing',
        'growth-marketing-team',
        [
          {
            role: 'content-drafter',
            responsibilities:
              'Drafts the content side of your growth pipeline (blog / social / newsletter).',
            skillIds: ['content-drafter', 'content-calendar'],
          },
          {
            role: 'data-analyst',
            responsibilities:
              'Tracks growth metrics across channels and flags drops before they compound.',
            skillIds: ['data-summarizer', 'scheduled-reporter'],
          },
          {
            role: 'trend-monitor',
            responsibilities:
              'Surfaces topic + competitor signals so your distribution stays current.',
            skillIds: ['trend-monitor', 'competitor-content-tracker'],
          },
        ],
        'You named growth / distribution as the core. Three agents — drafting + analytics + trend-watching — cover the production / measurement / sensing loop.',
      ),
  },
];

// =============================================================================
// Public API
// =============================================================================

/**
 * Map a {@link BusinessContext} to a {@link TeamRecommendation}.
 *
 * Strategy (v0):
 *   1. Score every hardcoded mapping by counting keyword hits across
 *      `industry` + each task name.
 *   2. Highest-scoring mapping wins (ties broken by declaration order).
 *   3. If no mapping scores ≥1, fire the generic 2-agent fallback.
 *
 * The function never throws — invalid input degrades to the fallback so
 * the conversation can keep moving even if discovery captured nothing
 * useful.
 *
 * @param ctx - Business context collected during phases 1–3.
 * @returns A team recommendation ready for phase 4.
 *
 * @example
 * ```ts
 * recommendTeam({
 *   industry: 'small Shopify skincare shop',
 *   scale: 'solo',
 *   tasks: [
 *     { name: 'weekly blog content', tier: 'yes-today' },
 *     { name: 'customer support replies', tier: 'yes-today' },
 *   ],
 * });
 * // → templateId: 'dtc-viral-content-team', 2 agents, …
 * ```
 */
export function recommendTeam(ctx: BusinessContext): TeamRecommendation {
  const haystack = buildHaystack(ctx);

  let bestScore = 0;
  let best: HardcodedMapping | null = null;

  for (const mapping of HARDCODED_MAPPINGS) {
    const score = scoreMapping(mapping, haystack);
    if (score > bestScore) {
      bestScore = score;
      best = mapping;
    }
  }

  if (best && bestScore > 0) {
    return best.build(ctx);
  }

  return genericFallback(ctx);
}

/**
 * Generic 2-agent fallback when no hardcoded mapping fires. Picks
 * `startup-team` (the most general template) and a content + analyst
 * pair, which has been the highest-utility default in our discovery
 * data.
 *
 * @param ctx - Original business context (used only for rationale).
 * @returns A safe, neutral recommendation.
 */
function genericFallback(ctx: BusinessContext): TeamRecommendation {
  const tasksLine = ctx.tasks.length
    ? `you mentioned ${ctx.tasks.map((t) => t.name).join(' / ')}`
    : 'we did not nail the time-sinks down yet';
  return {
    templateId: 'startup-team',
    agents: [
      {
        role: 'content-drafter',
        responsibilities:
          'Drafts written content (blog / social / internal updates) on a schedule.',
        skillIds: ['content-drafter'],
      },
      {
        role: 'data-analyst',
        responsibilities:
          'Summarises whatever data feed you connect (sheets / API / CSV) into a daily report.',
        skillIds: ['data-summarizer', 'scheduled-reporter'],
      },
    ],
    reasoning: `I did not match a precise mapping for your shape — ${tasksLine} — so I am proposing a safe 2-agent default. We can adjust before I create anything.`,
    source: 'fallback',
  };
}

// =============================================================================
// Internals
// =============================================================================

/**
 * Build a single lowercase haystack string from the context's industry
 * + task names. Keyword matches are checked against this string.
 */
function buildHaystack(ctx: BusinessContext): string {
  const parts: string[] = [];
  parts.push(ctx.industry ?? '');
  for (const t of ctx.tasks) {
    parts.push(t.name);
  }
  return parts.join(' ').toLowerCase();
}

/**
 * Count how many of a mapping's keywords appear in the haystack.
 */
function scoreMapping(mapping: HardcodedMapping, haystack: string): number {
  let score = 0;
  for (const kw of mapping.keywords) {
    if (haystack.includes(kw)) score += 1;
  }
  return score;
}

// =============================================================================
// Exports for tests / wiring
// =============================================================================

/**
 * Exposed for test introspection — the count is asserted against the
 * spec ("5 hardcoded mappings cover 80% of users").
 */
export const HARDCODED_MAPPING_COUNT = HARDCODED_MAPPINGS.length;

/**
 * Exposed for test introspection — list of mapping keys, useful for
 * asserting coverage without opening the array.
 */
export const HARDCODED_MAPPING_KEYS: readonly string[] = HARDCODED_MAPPINGS.map(
  (m) => m.key,
);
